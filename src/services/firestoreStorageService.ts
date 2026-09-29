import {
  collection,
  doc,
  getDocs,
  getDocsFromServer,
  setDoc,
  deleteDoc,
  query,
  orderBy,
  onSnapshot,
  Unsubscribe,
} from 'firebase/firestore';
import { db, auth } from '../firebase';
import { Plant, HealthScanRecord } from '../types/plant';
import { UserSubmittedPlantRecord } from '../types/admin';
import { INITIAL_PLANTS } from '../data/seedPlants';
import { VERIFIED_PLANT_IMAGES } from '../data/plantImages';
import { storageService } from './storageService';
import { isUserAdmin } from '../config/adminConfig';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export interface UserPlantStateDoc {
  id: string;
  userId: string;
  inMyGarden: boolean;
  isFavorite?: boolean;
  lastFertilizedDate?: string;
  customPhotoUrl?: string;
  scanHistory?: HealthScanRecord[];
  updatedAt: string;
}

/**
 * Recursively strips all `undefined` values from objects and arrays so Firestore never throws
 * "Unsupported field value: undefined" errors.
 * - Keys with undefined values are omitted entirely.
 * - Undefined elements in arrays are filtered out.
 * - Nested objects, maps, and arrays are recursively processed.
 * - Native Date objects, nulls, and primitives are preserved as-is.
 */
export function sanitizeForFirestore<T>(data: T): T {
  if (data === undefined) {
    return null as unknown as T;
  }
  if (data === null || typeof data !== 'object') {
    return data;
  }

  // Filter and map arrays
  if (Array.isArray(data)) {
    return data
      .filter((item) => item !== undefined)
      .map((item) => sanitizeForFirestore(item)) as unknown as T;
  }

  // Preserve native Date instances
  if (data instanceof Date) {
    return data;
  }

  // Handle plain objects: omit keys where value is undefined
  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(data as Record<string, any>)) {
    if (value === undefined) {
      continue;
    }
    sanitized[key] = sanitizeForFirestore(value);
  }
  return sanitized as T;
}

/**
 * Normalizes plant name for strict case-insensitive and whitespace-insensitive duplicate detection.
 * e.g. "  Holy   Basil  " -> "holy basil"
 */
export function normalizePlantName(name: string): string {
  if (!name) return '';
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function getPlantDeduplicationKey(plant: Partial<Plant>): {
  normalizedName: string;
  botanical: string;
} {
  const normalizedName = normalizePlantName(plant.name || '');
  const botanical = normalizePlantName(plant.botanicalName || '');
  return { normalizedName, botanical };
}

/**
 * Deduplicates plants with strict safety:
 * - Only merges if ID is identical, full normalized name is identical, or valid binomial botanical name matches.
 * - Tracks an alias mapping so that user garden states saved under aliased IDs are never lost.
 */
export function deduplicatePlantsWithAliases(rawList: Plant[]): {
  uniqueList: Plant[];
  idAliasMap: Map<string, string[]>; // Canonical ID -> list of aliased IDs
} {
  const seenExact = new Map<string, Plant>();
  const seenBotanical = new Map<string, Plant>();
  const seenId = new Map<string, Plant>();
  const idAliasMap = new Map<string, string[]>();
  const uniqueList: Plant[] = [];

  for (const plant of rawList) {
    if (!plant || !plant.name) continue;

    // Check existing by ID
    const existingById = seenId.get(plant.id);
    if (existingById) {
      continue;
    }

    const { normalizedName, botanical } = getPlantDeduplicationKey(plant);

    // Exact name match or strict binomial botanical match (must have 2 words to avoid generic genus match)
    const isStrictBotanicalMatch =
      Boolean(botanical && botanical.length > 5 && botanical.includes(' '));

    const existing =
      seenExact.get(normalizedName) ||
      (isStrictBotanicalMatch ? seenBotanical.get(botanical) : undefined);

    if (existing) {
      // Record alias so user private state referencing plant.id can be mapped to existing.id
      const currentAliases = idAliasMap.get(existing.id) || [];
      if (!currentAliases.includes(plant.id)) {
        currentAliases.push(plant.id);
        idAliasMap.set(existing.id, currentAliases);
      }

      // Merge creator attribution if missing
      if (plant.addedByUserId && !existing.addedByUserId) {
        existing.addedByUserId = plant.addedByUserId;
        existing.addedByUserEmail = plant.addedByUserEmail;
        existing.addedByUserName = plant.addedByUserName;
      }
      if (plant.imageUrl && !existing.imageUrl) {
        existing.imageUrl = plant.imageUrl;
      }
      continue;
    }

    seenId.set(plant.id, plant);
    seenExact.set(normalizedName, plant);
    if (isStrictBotanicalMatch) {
      seenBotanical.set(botanical, plant);
    }
    uniqueList.push(plant);
  }

  return { uniqueList, idAliasMap };
}

/**
 * Deduplicates a list of plants (convenience wrapper around deduplicatePlantsWithAliases)
 */
export function deduplicatePlants(rawList: Plant[]): Plant[] {
  return deduplicatePlantsWithAliases(rawList).uniqueList;
}

export const firestoreStorageService = {
  deduplicatePlants,
  deduplicatePlantsWithAliases,
  /**
   * Listens to real-time updates on the shared plants collection.
   * Fires whenever any user adds, edits, or removes a plant from the shared catalog.
   */
  subscribeToSharedPlants(
    onUpdate: (plants: Plant[]) => void,
    onError?: (err: Error) => void
  ): Unsubscribe {
    const sharedRef = collection(db, 'sharedPlants');
    return onSnapshot(
      sharedRef,
      (snapshot) => {
        const shared: Plant[] = [];
        snapshot.forEach((d) => {
          shared.push(d.data() as Plant);
        });

        // Cache locally for offline guest experience
        try {
          localStorage.setItem('terrace_garden_shared_plants_cache', JSON.stringify(shared));
        } catch {
          // quota
        }

        onUpdate(shared);
      },
      (err) => {
        console.warn('Real-time shared plants listener error:', err);
        if (onError) {
          onError(err);
        } else {
          handleFirestoreError(err, OperationType.GET, 'sharedPlants');
        }
      }
    );
  },

  /**
   * Fetches community plants approved or added into the global reference catalog.
   * Browsable by everyone (both authenticated users and guests).
   */
  async getSharedPlants(): Promise<Plant[]> {
    try {
      const sharedRef = collection(db, 'sharedPlants');
      const snap = await getDocs(sharedRef);
      const shared: Plant[] = [];
      snap.forEach((d) => {
        shared.push(d.data() as Plant);
      });

      // Cache locally for offline guest experience
      try {
        localStorage.setItem('terrace_garden_shared_plants_cache', JSON.stringify(shared));
      } catch {
        // quota
      }

      return shared;
    } catch (err) {
      console.warn('Could not fetch shared plants from Firestore (using cache if available):', err);
      try {
        const cached = localStorage.getItem('terrace_garden_shared_plants_cache');
        if (cached) {
          return JSON.parse(cached) as Plant[];
        }
      } catch {
        // ignore
      }
      return [];
    }
  },

  /**
   * Migrates legacy private custom plants and submitted plants to the shared catalog (skipping duplicates).
   */
  async migrateLegacyCustomPlants(
    userId: string,
    user: { uid: string; email?: string | null; displayName?: string | null }
  ): Promise<void> {
    try {
      const currentShared = await this.getSharedPlants();
      const existingNames = new Set(
        [...INITIAL_PLANTS, ...currentShared].map((p) => normalizePlantName(p.name))
      );

      // 1. Migrate from /users/{userId}/customPlants
      try {
        const customPlantsRef = collection(db, 'users', userId, 'customPlants');
        const snap = await getDocs(customPlantsRef);
        for (const d of snap.docs) {
          const cp = d.data() as Plant;
          const normalized = normalizePlantName(cp.name);

          if (!existingNames.has(normalized)) {
            const sharedDoc: Plant = {
              ...cp,
              isSharedCatalog: true,
              addedByUserId: userId,
              addedByUserEmail: user.email || undefined,
              addedByUserName: user.displayName || user.email?.split('@')[0] || 'Community Gardener',
              createdAt: cp.createdAt || new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };

            await setDoc(
              doc(db, 'sharedPlants', cp.id),
              sanitizeForFirestore({
                ...sharedDoc,
                inMyGarden: false,
              })
            );

            // Only keep user's private ownership state if explicitly owned in legacy record
            if (cp.inMyGarden) {
              await setDoc(
                doc(db, 'users', userId, 'userPlants', cp.id),
                sanitizeForFirestore({
                  id: cp.id,
                  userId,
                  inMyGarden: true,
                  isFavorite: Boolean(cp.isFavorite),
                  ...(cp.lastFertilizedDate ? { lastFertilizedDate: cp.lastFertilizedDate } : {}),
                  ...(cp.customPhotoUrl ? { customPhotoUrl: cp.customPhotoUrl } : {}),
                  scanHistory: cp.scanHistory || [],
                  updatedAt: new Date().toISOString(),
                }),
                { merge: true }
              );
            }

            existingNames.add(normalized);
          }

          // Clean up legacy customPlants document
          try {
            await deleteDoc(d.ref);
          } catch {
            // ignore
          }
        }
      } catch (subErr) {
        console.warn('Could not read user customPlants for migration:', subErr);
      }

      // 2. Migrate any legacy custom plants from local storage
      try {
        const localPlants = storageService.getPlants();
        const localCustoms = localPlants.filter(
          (p) => (p.id.startsWith('custom-') || (p as any).isCustomPlant) && !p.id.startsWith('shared-')
        );
        for (const lp of localCustoms) {
          const normalized = normalizePlantName(lp.name);
          if (!existingNames.has(normalized)) {
            const newSharedId = 'shared-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);
            const sharedDoc: Plant = {
              ...lp,
              id: newSharedId,
              isSharedCatalog: true,
              addedByUserId: userId,
              addedByUserEmail: user.email || undefined,
              addedByUserName: user.displayName || user.email?.split('@')[0] || 'Community Gardener',
              createdAt: lp.createdAt || new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              inMyGarden: false,
            };

            await setDoc(
              doc(db, 'sharedPlants', newSharedId),
              sanitizeForFirestore({
                ...sharedDoc,
                inMyGarden: false,
              })
            );

            if (lp.inMyGarden) {
              await setDoc(
                doc(db, 'users', userId, 'userPlants', newSharedId),
                sanitizeForFirestore({
                  id: newSharedId,
                  userId,
                  inMyGarden: true,
                  isFavorite: Boolean(lp.isFavorite),
                  ...(lp.lastFertilizedDate ? { lastFertilizedDate: lp.lastFertilizedDate } : {}),
                  ...(lp.customPhotoUrl ? { customPhotoUrl: lp.customPhotoUrl } : {}),
                  scanHistory: lp.scanHistory || [],
                  updatedAt: new Date().toISOString(),
                }),
                { merge: true }
              );
            }

            existingNames.add(normalized);
          }
        }
        // Clean migrated customs from local storage to prevent duplicate re-migration loops
        if (localCustoms.length > 0) {
          const nonCustoms = localPlants.filter(
            (p) => !((p.id.startsWith('custom-') || (p as any).isCustomPlant) && !p.id.startsWith('shared-'))
          );
          storageService.savePlants(nonCustoms);
        }
      } catch (localErr) {
        console.warn('Could not migrate local storage custom plants:', localErr);
      }
    } catch (err) {
      console.warn('Migration of legacy custom plants encountered an error:', err);
    }
  },

  /**
   * Real-time subscription to authenticated user's private plant states.
   */
  subscribeToUserPlants(
    userId: string,
    onUpdate: (userPlantStates: Map<string, UserPlantStateDoc>) => void,
    onError?: (err: Error) => void
  ): Unsubscribe {
    const userPlantsRef = collection(db, 'users', userId, 'userPlants');
    console.log(`[Firestore MyGarden Load] Subscribing to real-time updates at path: users/${userId}/userPlants`);
    return onSnapshot(
      userPlantsRef,
      (snapshot) => {
        console.log(`[Firestore MyGarden Load: Real-time Snapshot] Path: users/${userId}/userPlants | Raw doc count: ${snapshot.size}`);
        const userPlantStates = new Map<string, UserPlantStateDoc>();
        snapshot.forEach((docSnap) => {
          const docData = docSnap.data() as UserPlantStateDoc;
          console.log(`  -> [Retrieved from Firestore] Doc ID: "${docSnap.id}" | inMyGarden: ${docData.inMyGarden} | isFavorite: ${docData.isFavorite} | updatedAt: ${docData.updatedAt}`);
          userPlantStates.set(docSnap.id, docData);
        });
        console.log(`[Firestore MyGarden Load: Snapshot Complete] Total user plant states loaded: ${userPlantStates.size}`);
        onUpdate(userPlantStates);
      },
      (err) => {
        console.error(`[Firestore MyGarden Load: Snapshot ERROR] Path: users/${userId}/userPlants:`, err);
        if (onError) {
          onError(err);
        } else {
          handleFirestoreError(err, OperationType.GET, `users/${userId}/userPlants`);
        }
      }
    );
  },

  /**
   * Loads the private user plant states map for an authenticated user.
   */
  async loadUserPlantStates(userId: string): Promise<Map<string, UserPlantStateDoc>> {
    const userPlantStates = new Map<string, UserPlantStateDoc>();
    try {
      console.log(`[Firestore MyGarden Load: getDocs] Querying users/${userId}/userPlants...`);
      const userPlantsRef = collection(db, 'users', userId, 'userPlants');
      const snap = await getDocs(userPlantsRef);
      console.log(`[Firestore MyGarden Load: getDocs SUCCESS] Retrieved ${snap.size} documents for user ${userId}`);
      snap.forEach((docSnap) => {
        const docData = docSnap.data() as UserPlantStateDoc;
        console.log(`  -> [getDocs Doc] ID: "${docSnap.id}" | inMyGarden: ${docData.inMyGarden}`);
        userPlantStates.set(docSnap.id, docData);
      });
    } catch (err) {
      console.error(`[Firestore MyGarden Load: getDocs FAILED] Error querying users/${userId}/userPlants:`, err);
    }
    return userPlantStates;
  },

  /**
   * Loads full plant list for authenticated user.
   * Merges base reference plants + shared plants with user's private garden state.
   */
  async loadPlantsForUser(
    userId: string,
    user?: { uid: string; email?: string | null; displayName?: string | null }
  ): Promise<Plant[]> {
    try {
      // Run background migration of any legacy custom plants
      if (user) {
        this.migrateLegacyCustomPlants(userId, user).catch(() => {});
      }

      console.log(`[Firestore MyGarden loadPlantsForUser] Initiating fetch for user: ${userId}`);
      const userPlantsRef = collection(db, 'users', userId, 'userPlants');
      const [userPlantsSnap, sharedPlants] = await Promise.all([
        getDocs(userPlantsRef),
        this.getSharedPlants(),
      ]);

      console.log(`[Firestore MyGarden loadPlantsForUser] Retrieved ${userPlantsSnap.size} userPlant docs and ${sharedPlants.length} shared catalog plants.`);
      const userPlantStates = new Map<string, UserPlantStateDoc>();
      userPlantsSnap.forEach((docSnap) => {
        const docData = docSnap.data() as UserPlantStateDoc;
        console.log(`  -> [loadPlantsForUser Doc] ID: "${docSnap.id}" | inMyGarden: ${docData.inMyGarden}`);
        userPlantStates.set(docSnap.id, docData);
      });

      // Combine base seed plants and all shared plants
      // Prevent duplicates by ID
      const sharedPlantIds = new Set(sharedPlants.map((p) => p.id));
      const filteredSeedPlants = INITIAL_PLANTS.filter((sp) => !sharedPlantIds.has(sp.id));
      const allReferenceCatalog = [...filteredSeedPlants, ...sharedPlants];

      // Assemble reference catalog with user's private data overlay
      const combinedWithUserState: Plant[] = allReferenceCatalog.map((basePlant) => {
        const userState = userPlantStates.get(basePlant.id);
        const verified = VERIFIED_PLANT_IMAGES[basePlant.id];
        return {
          ...basePlant,
          imageUrl: basePlant.imageUrl || verified?.imageUrl,
          inMyGarden: userState ? Boolean(userState.inMyGarden) : false,
          isFavorite: userState ? Boolean(userState.isFavorite) : false,
          lastFertilizedDate: userState?.lastFertilizedDate || undefined,
          customPhotoUrl: userState?.customPhotoUrl || undefined,
          scanHistory: userState?.scanHistory || [],
        };
      });

      // Save user-scoped local cache for instant offline fallback
      try {
        localStorage.setItem(`terrace_garden_plants_user_${userId}`, JSON.stringify(combinedWithUserState));
      } catch {
        // quota ignore
      }

      return combinedWithUserState;
    } catch (err) {
      console.error('Failed to load user plants from Firestore:', err);
      const cached = localStorage.getItem(`terrace_garden_plants_user_${userId}`);
      if (cached) {
        try {
          return JSON.parse(cached) as Plant[];
        } catch {
          // ignore
        }
      }
      return storageService.getPlants();
    }
  },

  /**
   * Syncs plant ownership, favorite status, or last fertilization to user's private Firestore space
   */
  async syncUserPlantState(
    userId: string,
    plant: Plant
  ): Promise<void> {
    const targetPath = `users/${userId}/userPlants/${plant.id}`;
    console.log(
      `[Firestore MyGarden Write ATTEMPT] User: ${userId} | Plant ID: "${plant.id}" | Plant Name: "${plant.name}" | Setting inMyGarden: ${Boolean(plant.inMyGarden)} | Target Path: ${targetPath}`
    );
    try {
      const stateDoc: Record<string, any> = {
        id: plant.id,
        userId,
        inMyGarden: Boolean(plant.inMyGarden),
        isFavorite: Boolean(plant.isFavorite),
        scanHistory: plant.scanHistory || [],
        updatedAt: new Date().toISOString(),
      };
      if (plant.lastFertilizedDate) stateDoc.lastFertilizedDate = plant.lastFertilizedDate;
      if (plant.customPhotoUrl) stateDoc.customPhotoUrl = plant.customPhotoUrl;
      if (plant.fertilizerCustomDays) stateDoc.customFertilizerIntervalDays = plant.fertilizerCustomDays;

      await setDoc(doc(db, 'users', userId, 'userPlants', plant.id), sanitizeForFirestore(stateDoc), { merge: true });
      console.log(
        `[Firestore MyGarden Write SUCCESS] Plant ID: "${plant.id}" | Plant Name: "${plant.name}" | Successfully committed to Firestore at ${targetPath}`
      );
    } catch (err) {
      console.error(
        `[Firestore MyGarden Write FAILED] Plant ID: "${plant.id}" | Plant Name: "${plant.name}" | Path: ${targetPath} | Exact Error:`,
        err
      );
      handleFirestoreError(err, OperationType.WRITE, targetPath);
    }
  },

  /**
   * Checks whether a plant name already exists in the catalog (case-insensitive, ignoring extra spaces).
   */
  checkDuplicateName(name: string, catalog: Plant[], excludePlantId?: string, botanicalName?: string): Plant | undefined {
    const candidateKeys = getPlantDeduplicationKey({ name, botanicalName });
    return catalog.find((p) => {
      if (excludePlantId && p.id === excludePlantId) return false;
      const existingKeys = getPlantDeduplicationKey(p);
      if (candidateKeys.normalizedName && existingKeys.normalizedName === candidateKeys.normalizedName) {
        return true;
      }
      if (
        candidateKeys.botanical &&
        existingKeys.botanical &&
        candidateKeys.botanical.length > 5 &&
        candidateKeys.botanical.includes(' ') &&
        candidateKeys.botanical === existingKeys.botanical
      ) {
        return true;
      }
      return false;
    });
  },

  /**
   * Adds a new plant directly to the shared catalog so it is immediately visible to ALL users and guests.
   * Also adds the plant to the author's private My Garden.
   * Performs duplicate prevention beforehand.
   */
  async addSharedPlant(
    user: { uid: string; email?: string | null; displayName?: string | null },
    plantData: Omit<Plant, 'id' | 'createdAt' | 'updatedAt'>,
    existingCatalog: Plant[]
  ): Promise<{ success: boolean; plant?: Plant; existingPlant?: Plant; error?: string }> {
    // 1. Duplicate prevention
    const duplicate = this.checkDuplicateName(plantData.name, existingCatalog);
    if (duplicate) {
      return {
        success: false,
        existingPlant: duplicate,
        error: 'duplicate',
      };
    }

    const newPlantId = 'shared-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);
    const now = new Date().toISOString();

    // Sanitize incoming plantData to strip any undefined values immediately
    const sanitizedPlantData = sanitizeForFirestore(plantData);

    const sharedPlant: Plant = {
      ...sanitizedPlantData,
      id: newPlantId,
      isSharedCatalog: true,
      addedByUserId: user.uid,
      addedByUserName: user.displayName || user.email?.split('@')[0] || 'Community Gardener',
      createdAt: now,
      updatedAt: now,
      inMyGarden: false, // In shared catalog, inMyGarden is strictly false by default
    };
    if (user.email) {
      sharedPlant.addedByUserEmail = user.email;
    }

    try {
      // 1. Save directly into shared global catalog (with inMyGarden: false)
      await setDoc(
        doc(db, 'sharedPlants', newPlantId),
        sanitizeForFirestore({
          ...sharedPlant,
          inMyGarden: false,
        })
      );

      // CRITICAL REQUIREMENT: Do NOT automatically add newly created catalog plants to the creator's My Garden.
      // Adding a plant to the shared catalog and adding it to personal My Garden are strictly separate.
      // The user must explicitly tap "Add to My Garden" to add it.
      return {
        success: true,
        plant: {
          ...sharedPlant,
          inMyGarden: false,
        },
      };
    } catch (err) {
      console.error('Failed to save shared plant to Firestore:', err);
      return {
        success: false,
        error: (err as Error).message || 'Failed to save to shared catalog',
      };
    }
  },

  /**
   * Backward-compatible alias for addSharedPlant
   */
  async addCustomPlant(
    user: { uid: string; email?: string | null; displayName?: string | null },
    plantData: Omit<Plant, 'id' | 'createdAt' | 'updatedAt'>,
    existingCatalog: Plant[] = []
  ): Promise<Plant> {
    const res = await this.addSharedPlant(user, plantData, existingCatalog);
    if (res.success && res.plant) {
      return res.plant;
    }
    if (res.existingPlant) {
      return res.existingPlant;
    }
    throw new Error(res.error || 'Failed to add plant');
  },

  /**
   * Updates an existing shared plant in the shared catalog (permitted for creator or admin).
   */
  async updateSharedPlant(
    user: { uid: string; email?: string | null },
    updatedPlant: Plant
  ): Promise<void> {
    const now = new Date().toISOString();
    try {
      // Shared catalog document should ONLY contain plant reference guide fields,
      // NOT private user state like inMyGarden, isFavorite, scanHistory, etc.
      const catalogData = { ...updatedPlant, updatedAt: now };
      delete (catalogData as any).inMyGarden;
      delete (catalogData as any).isFavorite;
      delete (catalogData as any).lastFertilizedDate;
      delete (catalogData as any).customPhotoUrl;
      delete (catalogData as any).scanHistory;

      await setDoc(
        doc(db, 'sharedPlants', updatedPlant.id),
        sanitizeForFirestore(catalogData),
        { merge: true }
      );
    } catch (err) {
      console.warn('Failed to update sharedPlant document:', err);
      throw err;
    }

    if (user?.uid) {
      await this.syncUserPlantState(user.uid, updatedPlant);
    }
  },

  /**
   * Safe no-op retained for backwards compatibility.
   * CRITICAL: We NEVER mutate inMyGarden to false on login. If a user adds a plant to My Garden,
   * it must always stay in My Garden.
   */
  async cleanupAutoAddedPlants(_userId: string): Promise<number> {
    return 0;
  },

  /**
   * Directly queries the authenticated user's private `userPlants` subcollection
   * from the Firestore server (bypassing local cache) for diagnostics and verification.
   */
  async fetchRawUserPlantDocuments(userId: string): Promise<{
    docs: UserPlantStateDoc[];
    inGardenCount: number;
    totalDocs: number;
    error?: string;
  }> {
    try {
      console.log(`[Firestore Direct Server Query] Fetching un-cached docs from users/${userId}/userPlants directly from Google Cloud Firestore server...`);
      const userPlantsRef = collection(db, 'users', userId, 'userPlants');
      const snap = await getDocsFromServer(userPlantsRef);
      const docs: UserPlantStateDoc[] = [];
      console.log(`[Firestore Direct Server Query SUCCESS] Server returned ${snap.size} documents for user ${userId}`);
      snap.forEach((d) => {
        const docData = d.data() as UserPlantStateDoc;
        console.log(`  -> [Direct Server Document] ID: "${d.id}" | inMyGarden: ${docData.inMyGarden} | isFavorite: ${docData.isFavorite} | updatedAt: ${docData.updatedAt}`);
        docs.push(docData);
      });
      const inGardenCount = docs.filter((d) => Boolean(d.inMyGarden)).length;
      console.log(`[Firestore Direct Server Query Summary] Total Docs: ${docs.length}, inMyGarden=true: ${inGardenCount}, inMyGarden=false: ${docs.length - inGardenCount}`);
      return {
        docs,
        inGardenCount,
        totalDocs: docs.length,
      };
    } catch (err: unknown) {
      console.error(`[Firestore Direct Server Query FAILED] Error fetching from users/${userId}/userPlants:`, err);
      return {
        docs: [],
        inGardenCount: 0,
        totalDocs: 0,
        error: err instanceof Error ? err.message : 'Failed to query Firestore server',
      };
    }
  },

  /**
   * Restores a plant to the user's My Garden by setting inMyGarden: true in Firestore.
   */
  async restoreUserPlantToGarden(userId: string, plantId: string): Promise<void> {
    const docRef = doc(db, 'users', userId, 'userPlants', plantId);
    await setDoc(
      docRef,
      sanitizeForFirestore({
        id: plantId,
        userId,
        inMyGarden: true,
        updatedAt: new Date().toISOString(),
      }),
      { merge: true }
    );
  },

  /**
   * Clears all plants from the user's private garden (sets inMyGarden: false),
   * while preserving historical data (past fertilizer dates, scan records, custom photos).
   */
  async removeAllFromMyGarden(userId: string): Promise<void> {
    const userPlantsRef = collection(db, 'users', userId, 'userPlants');
    const snap = await getDocs(userPlantsRef);
    for (const d of snap.docs) {
      const data = d.data() as UserPlantStateDoc;
      if (data.inMyGarden) {
        await setDoc(
          d.ref,
          sanitizeForFirestore({
            ...data,
            inMyGarden: false,
            updatedAt: new Date().toISOString(),
          }),
          { merge: true }
        );
      }
    }
  },

  /**
   * Deletes a shared plant from the shared catalog (permitted for creator or admin).
   */
  async deleteSharedPlant(userId: string, plantId: string): Promise<void> {
    try {
      await deleteDoc(doc(db, 'sharedPlants', plantId));
      try {
        await deleteDoc(doc(db, 'users', userId, 'userPlants', plantId));
      } catch {
        // user might not have had it in private userPlants
      }
    } catch (err) {
      console.error('Failed to delete plant from shared catalog:', err);
      throw err;
    }
  },

  /**
   * Deletes a custom/shared plant
   */
  async deleteCustomPlant(userId: string, plantId: string): Promise<void> {
    return this.deleteSharedPlant(userId, plantId);
  },

  /* =======================================================================
   * ADMIN MODERATION METHODS
   * Accessible only to configured app administrators
   * ======================================================================= */

  /**
   * Fetches all user-submitted plants across all accounts for admin review.
   */
  async getSubmittedPlantsForAdmin(): Promise<UserSubmittedPlantRecord[]> {
    try {
      const submissionsRef = collection(db, 'userSubmittedPlants');
      const q = query(submissionsRef, orderBy('submittedAt', 'desc'));
      const snap = await getDocs(q);

      const records: UserSubmittedPlantRecord[] = [];
      snap.forEach((d) => {
        records.push(d.data() as UserSubmittedPlantRecord);
      });
      return records;
    } catch (err) {
      console.warn('Failed to fetch user submissions using ordered query, falling back to plain query:', err);
      try {
        const snap = await getDocs(collection(db, 'userSubmittedPlants'));
        const records: UserSubmittedPlantRecord[] = [];
        snap.forEach((d) => {
          records.push(d.data() as UserSubmittedPlantRecord);
        });
        records.sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''));
        return records;
      } catch (innerErr) {
        console.error('Failed to fetch user submissions for admin:', innerErr);
        return [];
      }
    }
  },

  /**
   * Approves a user-submitted plant into the global shared catalog.
   * Copies the plant into `/sharedPlants/{plantId}` so all users can see it,
   * while keeping the original user's private plant completely intact.
   */
  async approvePlantToSharedCatalog(
    submission: UserSubmittedPlantRecord,
    adminEmail: string
  ): Promise<Plant> {
    const sharedPlant: Plant = {
      ...submission.plantData,
      id: submission.originalPlantId,
      isSharedCatalog: true,
      addedByUserId: submission.userId,
      addedByUserEmail: submission.userEmail,
      addedByUserName: submission.userDisplayName,
      approvedAt: new Date().toISOString(),
      inMyGarden: false, // in global reference catalog, not owned by default until user adds it
    };

    // 1. Write to global shared catalog
    await setDoc(doc(db, 'sharedPlants', submission.originalPlantId), sanitizeForFirestore(sharedPlant));

    // 2. Mark submission as approved
    await setDoc(
      doc(db, 'userSubmittedPlants', submission.id),
      sanitizeForFirestore({
        status: 'approved',
        reviewedAt: new Date().toISOString(),
        reviewedBy: adminEmail,
      }),
      { merge: true }
    );

    return sharedPlant;
  },

  /**
   * Dismisses a plant submission (leaves it as that user's private plant only).
   */
  async dismissSubmittedPlant(submissionId: string, adminEmail: string): Promise<void> {
    await setDoc(
      doc(db, 'userSubmittedPlants', submissionId),
      sanitizeForFirestore({
        status: 'dismissed',
        reviewedAt: new Date().toISOString(),
        reviewedBy: adminEmail,
      }),
      { merge: true }
    );
  },

  /**
   * Removes a plant from the global shared catalog if previously approved.
   */
  async removeFromSharedCatalog(plantId: string, submissionId?: string): Promise<void> {
    await deleteDoc(doc(db, 'sharedPlants', plantId));

    if (submissionId) {
      await setDoc(
        doc(db, 'userSubmittedPlants', submissionId),
        sanitizeForFirestore({
          status: 'dismissed',
          reviewedAt: new Date().toISOString(),
        }),
        { merge: true }
      );
    }
  },

  /**
   * Admin-only operation: Exports a complete snapshot of shared catalog and submission data.
   * Backend check: Rejects if the user's email is not an authorized administrator.
   */
  async adminExportDatabase(user?: { email?: string | null } | null): Promise<string> {
    const currentAuthUser = auth.currentUser;
    const emailToCheck = currentAuthUser?.email || user?.email;
    if (!currentAuthUser || !isUserAdmin(currentAuthUser.email) || !isUserAdmin(emailToCheck)) {
      throw new Error('Unauthorized: Only the verified app administrator can export database backups.');
    }

    const [sharedPlants, submissionsSnap] = await Promise.all([
      this.getSharedPlants(),
      getDocs(collection(db, 'userSubmittedPlants')),
    ]);

    const submissions: any[] = [];
    submissionsSnap.forEach((d) => submissions.push({ id: d.id, ...d.data() }));

    const backupPayload = {
      exportVersion: 2,
      exportTimestamp: new Date().toISOString(),
      exportedBy: emailToCheck,
      databaseId: 'terrace-garden-shared-catalog',
      sharedPlantsCount: sharedPlants.length,
      sharedPlants,
      submissionsCount: submissions.length,
      submissions,
    };

    // Log the backup operation to systemBackups collection (protected by Firestore rules)
    try {
      const backupId = `backup-${Date.now()}`;
      await setDoc(
        doc(db, 'systemBackups', backupId),
        sanitizeForFirestore({
          backupId,
          action: 'export',
          timestamp: new Date().toISOString(),
          adminEmail: emailToCheck,
          itemCount: sharedPlants.length,
        })
      );
    } catch (e) {
      console.warn('Backup audit log skipped:', e);
    }

    return JSON.stringify(backupPayload, null, 2);
  },

  /**
   * Admin-only operation: Restores shared catalog data from an admin JSON backup.
   * Backend check: Rejects if the user's email is not an authorized administrator.
   */
  async adminRestoreDatabase(
    user: { email?: string | null } | null | undefined,
    backupJson: string
  ): Promise<{ success: boolean; count?: number; error?: string }> {
    const currentAuthUser = auth.currentUser;
    const emailToCheck = currentAuthUser?.email || user?.email;
    if (!currentAuthUser || !isUserAdmin(currentAuthUser.email) || !isUserAdmin(emailToCheck)) {
      throw new Error('Unauthorized: Only the verified app administrator can restore the database.');
    }

    try {
      const parsed = JSON.parse(backupJson);
      let plantsToRestore: Plant[] = [];

      if (Array.isArray(parsed)) {
        plantsToRestore = parsed;
      } else if (parsed && Array.isArray(parsed.sharedPlants)) {
        plantsToRestore = parsed.sharedPlants;
      } else {
        return { success: false, error: 'Invalid backup file format: missing plant records.' };
      }

      // Restore each plant into sharedPlants collection
      let restoredCount = 0;
      for (const plant of plantsToRestore) {
        if (!plant || !plant.id || !plant.name) continue;
        await setDoc(
          doc(db, 'sharedPlants', plant.id),
          sanitizeForFirestore({
            ...plant,
            isSharedCatalog: true,
            updatedAt: new Date().toISOString(),
          })
        );
        restoredCount++;
      }

      // Log the restore operation to systemBackups collection (protected by Firestore rules)
      const restoreId = `restore-${Date.now()}`;
      await setDoc(
        doc(db, 'systemBackups', restoreId),
        sanitizeForFirestore({
          restoreId,
          action: 'restore',
          timestamp: new Date().toISOString(),
          adminEmail: emailToCheck,
          restoredCount,
        })
      );

      return { success: true, count: restoredCount };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to parse or restore backup';
      return { success: false, error: msg };
    }
  },

  /**
   * Admin-only operation: Resets the shared catalog in Firestore to default seed plants.
   * Backend check: Rejects if the user's email is not an authorized administrator.
   */
  async adminResetDatabase(user?: { email?: string | null } | null): Promise<void> {
    const currentAuthUser = auth.currentUser;
    const emailToCheck = currentAuthUser?.email || user?.email;
    if (!currentAuthUser || !isUserAdmin(currentAuthUser.email) || !isUserAdmin(emailToCheck)) {
      throw new Error('Unauthorized: Only the verified app administrator can reset the catalog database.');
    }

    // 1. Delete all user-added plants in Firestore sharedPlants collection
    const sharedSnap = await getDocs(collection(db, 'sharedPlants'));
    const deletePromises = sharedSnap.docs.map((d) => deleteDoc(d.ref));
    await Promise.all(deletePromises);

    // 2. Log reset in systemBackups audit log (protected by Firestore rules)
    const resetId = `reset-${Date.now()}`;
    await setDoc(
      doc(db, 'systemBackups', resetId),
      sanitizeForFirestore({
        resetId,
        action: 'reset_to_defaults',
        timestamp: new Date().toISOString(),
        adminEmail: emailToCheck,
        clearedSharedPlantsCount: sharedSnap.size,
      })
    );

    // 3. Reset local storage seed data as well
    storageService.resetToDefaults();
  },
};
