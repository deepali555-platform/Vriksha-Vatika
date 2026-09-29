import React, { useState, useEffect } from 'react';
import {
  Database,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RotateCcw,
  X,
  ShieldCheck,
  Leaf,
  Info,
  ExternalLink,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { Plant } from '../types/plant';
import { firestoreStorageService, UserPlantStateDoc } from '../services/firestoreStorageService';

interface GardenDiagnosticModalProps {
  isOpen: boolean;
  onClose: () => void;
  displayedPlants: Plant[];
  onPlantRestored: () => void;
  onShowToast: (msg: string) => void;
}

export const GardenDiagnosticModal: React.FC<GardenDiagnosticModalProps> = ({
  isOpen,
  onClose,
  displayedPlants,
  onPlantRestored,
  onShowToast,
}) => {
  const { user } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawDocs, setRawDocs] = useState<UserPlantStateDoc[]>([]);
  const [restoringPlantId, setRestoringPlantId] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);

  const fetchDirectFromFirestore = async () => {
    if (!user) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await firestoreStorageService.fetchRawUserPlantDocuments(user.uid);
      if (res.error) {
        setError(res.error);
      } else {
        setRawDocs(res.docs);
        setLastCheckedAt(new Date().toLocaleTimeString());
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to query Firestore server directly');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && user) {
      fetchDirectFromFirestore();
    }
  }, [isOpen, user]);

  if (!isOpen) return null;

  const displayedOwnedPlants = displayedPlants.filter((p) => Boolean(p.inMyGarden));
  const displayedOwnedIds = new Set(displayedOwnedPlants.map((p) => p.id));

  // Find matching plant info from displayed catalog
  const getPlantInfo = (plantId: string) => {
    return displayedPlants.find((p) => p.id === plantId);
  };

  const inGardenDocs = rawDocs.filter((d) => Boolean(d.inMyGarden));
  const removedDocs = rawDocs.filter((d) => !d.inMyGarden);

  const handleRestore = async (plantId: string, plantName: string) => {
    if (!user) return;
    setRestoringPlantId(plantId);
    try {
      await firestoreStorageService.restoreUserPlantToGarden(user.uid, plantId);
      onShowToast(`✓ Restored "${plantName}" to My Garden in cloud Firestore!`);
      await fetchDirectFromFirestore();
      onPlantRestored();
    } catch (err: unknown) {
      onShowToast(`Failed to restore plant: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setRestoringPlantId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-stone-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6 animate-in fade-in duration-150">
      <div className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl border border-stone-200 overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-4 bg-emerald-950 text-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-800/80 flex items-center justify-center border border-emerald-700/60">
              <Database className="w-5 h-5 text-emerald-300" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <span>Firestore Cloud Garden Inspector</span>
                <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded-full bg-emerald-800/90 text-emerald-200 border border-emerald-700/50">
                  Live Server Query
                </span>
              </h2>
              <p className="text-xs text-emerald-200/80">
                Direct, un-cached state of your private garden documents in Google Cloud Firestore
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-emerald-900/70 hover:bg-emerald-800 flex items-center justify-center text-emerald-200 hover:text-white transition-colors cursor-pointer"
            aria-label="Close diagnostic modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto space-y-4">
          {/* Summary Cards */}
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="p-3 bg-stone-50 border border-stone-200/80 rounded-2xl">
              <span className="text-[11px] font-bold text-stone-500 uppercase tracking-wider block">
                Total in Firestore
              </span>
              <span className="text-2xl font-black text-stone-900 mt-0.5 block">
                {isLoading ? '...' : rawDocs.length}
              </span>
              <span className="text-[10px] text-stone-500">cloud documents</span>
            </div>

            <div className="p-3 bg-emerald-50/80 border border-emerald-200/70 rounded-2xl">
              <span className="text-[11px] font-bold text-emerald-800 uppercase tracking-wider block">
                Marked In Garden
              </span>
              <span className="text-2xl font-black text-emerald-950 mt-0.5 block">
                {isLoading ? '...' : inGardenDocs.length}
              </span>
              <span className="text-[10px] text-emerald-700">inMyGarden: true</span>
            </div>

            <div className="p-3 bg-amber-50/80 border border-amber-200/70 rounded-2xl">
              <span className="text-[11px] font-bold text-amber-800 uppercase tracking-wider block">
                Displayed in UI
              </span>
              <span className="text-2xl font-black text-amber-950 mt-0.5 block">
                {displayedOwnedPlants.length}
              </span>
              <span className="text-[10px] text-amber-700">active screen items</span>
            </div>
          </div>

          {/* Sync Analysis Status Banner */}
          {!isLoading && (
            <div>
              {removedDocs.length > 0 ? (
                <div className="p-3.5 bg-amber-50 border border-amber-300/80 rounded-2xl flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                  <div className="text-xs text-amber-950 space-y-1">
                    <p className="font-bold">
                      {removedDocs.length} plant document{removedDocs.length > 1 ? 's have' : ' has'}{' '}
                      <code>inMyGarden: false</code> in Firestore.
                    </p>
                    <p className="text-amber-800 leading-relaxed">
                      This was caused by the legacy auto-cleanup routine that ran on login. The destructive cleanup
                      routine has now been completely removed. You can restore these plants back to your garden
                      with one tap below!
                    </p>
                  </div>
                </div>
              ) : inGardenDocs.length === displayedOwnedPlants.length ? (
                <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-2xl flex items-center gap-3">
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                  <div className="text-xs text-emerald-950">
                    <p className="font-bold">100% In Sync with Google Cloud Firestore</p>
                    <p className="text-emerald-800">
                      All {inGardenDocs.length} plants marked in your Firestore cloud database are actively displayed in My Garden.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="p-3.5 bg-sky-50 border border-sky-200 rounded-2xl flex items-center gap-3">
                  <Info className="w-5 h-5 text-sky-600 shrink-0" />
                  <div className="text-xs text-sky-950">
                    <p className="font-bold">Catalog overlay synchronizing</p>
                    <p className="text-sky-800">
                      Firestore server has {inGardenDocs.length} marked plants. The catalog safety net guarantees all marked plants appear in My Garden.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-2xl flex items-start gap-2.5 text-xs text-rose-800">
              <XCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold">Firestore Server Error</p>
                <p>{error}</p>
              </div>
            </div>
          )}

          {/* List of Documents in Firestore */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-stone-600">
                Firestore Cloud Document Records ({rawDocs.length})
              </span>
              {lastCheckedAt && (
                <span className="text-[11px] text-stone-500 font-mono">
                  Checked at {lastCheckedAt}
                </span>
              )}
            </div>

            {isLoading ? (
              <div className="py-8 flex flex-col items-center justify-center gap-2 text-stone-500">
                <RefreshCw className="w-6 h-6 animate-spin text-emerald-600" />
                <span className="text-xs">Querying Firestore server directly...</span>
              </div>
            ) : rawDocs.length === 0 ? (
              <div className="p-6 text-center bg-stone-50 rounded-2xl border border-stone-200 text-stone-600 text-xs">
                No documents found in your Firestore <code>userPlants</code> collection yet.
              </div>
            ) : (
              <div className="divide-y divide-stone-100 border border-stone-200/90 rounded-2xl overflow-hidden bg-white">
                {rawDocs.map((docRecord) => {
                  const plantInfo = getPlantInfo(docRecord.id);
                  const isMarkedInGarden = Boolean(docRecord.inMyGarden);
                  const isDisplayed = displayedOwnedIds.has(docRecord.id);
                  const plantDisplayName = plantInfo?.name || docRecord.id;

                  return (
                    <div
                      key={docRecord.id}
                      className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-stone-50/80 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-stone-900 text-xs sm:text-sm truncate">
                            {plantDisplayName}
                          </span>
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${
                              isMarkedInGarden
                                ? 'bg-emerald-100 text-emerald-900 border border-emerald-300'
                                : 'bg-stone-100 text-stone-600 border border-stone-300'
                            }`}
                          >
                            {isMarkedInGarden ? (
                              <>
                                <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                                <span>inMyGarden: true</span>
                              </>
                            ) : (
                              <>
                                <XCircle className="w-3 h-3 text-stone-500" />
                                <span>inMyGarden: false</span>
                              </>
                            )}
                          </span>

                          {isDisplayed ? (
                            <span className="text-[10px] text-emerald-800 font-semibold bg-emerald-50 px-1.5 py-0.5 rounded">
                              ✓ Visible on Screen
                            </span>
                          ) : isMarkedInGarden ? (
                            <span className="text-[10px] text-amber-800 font-semibold bg-amber-50 px-1.5 py-0.5 rounded">
                              Aliased in Reference
                            </span>
                          ) : (
                            <span className="text-[10px] text-stone-500 font-medium bg-stone-50 px-1.5 py-0.5 rounded">
                              Not in Garden
                            </span>
                          )}
                        </div>

                        <div className="mt-1 flex items-center gap-3 text-[11px] text-stone-500 font-mono">
                          <span>ID: {docRecord.id}</span>
                          {docRecord.updatedAt && (
                            <span>Updated: {new Date(docRecord.updatedAt).toLocaleTimeString()}</span>
                          )}
                        </div>
                      </div>

                      {/* Action: If inMyGarden is false, offer immediate restore button! */}
                      {!isMarkedInGarden && (
                        <button
                          type="button"
                          onClick={() => handleRestore(docRecord.id, plantDisplayName)}
                          disabled={restoringPlantId === docRecord.id}
                          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-xs active:scale-95 transition-all shrink-0 cursor-pointer disabled:opacity-50"
                        >
                          {restoringPlantId === docRecord.id ? (
                            <>
                              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              <span>Restoring...</span>
                            </>
                          ) : (
                            <>
                              <RotateCcw className="w-3.5 h-3.5" />
                              <span>Restore to My Garden</span>
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-stone-50 border-t border-stone-200/90 flex items-center justify-between shrink-0">
          <button
            type="button"
            onClick={fetchDirectFromFirestore}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white border border-stone-300 hover:bg-stone-100 text-stone-700 text-xs font-semibold shadow-2xs active:scale-95 transition-all cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Re-query Firestore Server</span>
          </button>

          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-emerald-800 hover:bg-emerald-900 text-white text-xs font-bold transition-all shadow-xs active:scale-95 cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
