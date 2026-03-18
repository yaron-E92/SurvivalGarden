import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Batch, BatchConfidence, Bed, Crop, CropPlan, SeedInventoryItem, Segment, Task } from './contracts';
import {
  generateCalendarTasksWithDiagnostics,
  SchemaValidationError,
  initializeAppStateStorage,
  listBedsFromAppState,
  listBatchesFromAppState,
  listTasksFromAppState,
  loadAppStateFromIndexedDb,
  loadPhotoBlobFromIndexedDb,
  resetToGoldenDataset,
  parseImportedAppState,
  saveAppStateToIndexedDb,
  savePhotoBlobToIndexedDb,
  serializeAppStateForExport,
  listSeedInventoryItemsFromAppState,
  removeSeedInventoryItemFromAppState,
  upsertSeedInventoryItemInAppState,
  upsertGeneratedTasksInAppState,
  upsertTaskInAppState,
  upsertBatchInAppState,
  upsertCropInAppState,
  upsertBedInAppState,
  getActiveBedAssignment,
  assignBatchToBed,
  moveBatch,
  removeBatchFromBed,
  assertValid,
} from './data';
import { applyStageEvent, canTransition } from './domain';

type BatchPhoto = {
  id: string;
  storageRef: string;
  capturedAt?: string;
  contentType?: string;
  filename?: string;
  caption?: string;
};

type BatchWithPhotos = Batch & { photos?: BatchPhoto[] };

type CropIdentityLabelProps = {
  cropId: string;
  name?: string | undefined;
  scientificName?: string | undefined;
  className?: string | undefined;
};

const getCropCapabilityLabels = ({
  isUserDefined,
  hasTaskRules,
}: {
  isUserDefined: boolean | undefined;
  hasTaskRules: boolean | undefined;
}): string[] => {
  const labels: string[] = [];

  if (isUserDefined) {
    labels.push('Custom crop');
  }

  if (hasTaskRules === false) {
    labels.push('No rules yet');
  }

  return labels;
};

function CropIdentityLabel({ cropId, name, scientificName, className }: CropIdentityLabelProps) {
  const secondary = scientificName?.trim();

  return (
    <span className={className ? `crop-identity ${className}` : 'crop-identity'}>
      <span className="crop-identity-primary">{name ?? cropId}</span>
      {secondary ? <span className="crop-identity-secondary">{secondary}</span> : null}
    </span>
  );
}

function BedsPage() {
  const [beds, setBeds] = useState<Bed[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [deletingPathKey, setDeletingPathKey] = useState<string | null>(null);
  const [deletingBedKey, setDeletingBedKey] = useState<string | null>(null);
  const [deletePathMessage, setDeletePathMessage] = useState<string | null>(null);
  const [editingEntityKey, setEditingEntityKey] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState('vegetable_bed');
  const [editX, setEditX] = useState('0');
  const [editY, setEditY] = useState('0');
  const [editWidth, setEditWidth] = useState('1');
  const [editHeight, setEditHeight] = useState('1');
  const [editSurface, setEditSurface] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [editMessage, setEditMessage] = useState<string | null>(null);



  useEffect(() => {
    const load = async () => {
      const appState = await loadAppStateFromIndexedDb();

      if (!appState) {
        setBeds([]);
        setBatches([]);
        setSegments([]);
        setIsLoading(false);
        return;
      }

      setBeds([...listBedsFromAppState(appState)].sort((left, right) => left.bedId.localeCompare(right.bedId)));
      setBatches(listBatchesFromAppState(appState));
      setSegments(appState.segments ?? []);
      setIsLoading(false);
    };

    void load();
  }, []);

  const activeBatchCountByBedId = useMemo(() => {
    const counts: Record<string, number> = {};

    for (const batch of batches) {
      const bedId = getDerivedBedId(batch);
      if (!bedId) {
        continue;
      }

      counts[bedId] = (counts[bedId] ?? 0) + 1;
    }

    return counts;
  }, [batches]);

  const totalPathCount = useMemo(
    () => segments.reduce((total, segment) => total + segment.paths.length, 0),
    [segments],
  );

  const totalSegmentBedCount = useMemo(
    () => segments.reduce((total, segment) => total + segment.beds.length, 0),
    [segments],
  );

  const startEditPath = useCallback((segmentId: string, path: Segment['paths'][number]) => {
    setEditingEntityKey(`path:${segmentId}:${path.pathId}`);
    setEditName(path.name);
    setEditX(String(path.x));
    setEditY(String(path.y));
    setEditWidth(String(path.width));
    setEditHeight(String(path.height));
    setEditSurface(path.surface ?? '');
    setEditMessage(null);
  }, []);

  const startEditBed = useCallback((segmentId: string, bed: Segment['beds'][number]) => {
    setEditingEntityKey(`bed:${segmentId}:${bed.bedId}`);
    setEditName(bed.name);
    setEditType(bed.type);
    setEditX(String(bed.x));
    setEditY(String(bed.y));
    setEditWidth(String(bed.width));
    setEditHeight(String(bed.height));
    setEditMessage(null);
  }, []);

  const clearEditState = useCallback(() => {
    setEditingEntityKey(null);
    setIsSavingEdit(false);
  }, []);

  const toNumberField = (value: string): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const handleSaveEdit = useCallback(async () => {
    if (!editingEntityKey || isSavingEdit) {
      return;
    }

    const [kind, segmentId, entityId] = editingEntityKey.split(':');
    const x = toNumberField(editX);
    const y = toNumberField(editY);
    const width = toNumberField(editWidth);
    const height = toNumberField(editHeight);

    if (x === null || y === null || width === null || height === null) {
      setEditMessage('Geometry values must be valid numbers.');
      return;
    }

    setEditMessage(null);
    setIsSavingEdit(true);

    try {
      const appState = await loadAppStateFromIndexedDb();
      if (!appState) {
        setEditMessage('Unable to save edit because local app state is unavailable.');
        return;
      }

      const nextSegments = (appState.segments ?? []).map((segment) => {
        if (segment.segmentId !== segmentId) {
          return segment;
        }

        if (kind === 'path') {
          return {
            ...segment,
            paths: segment.paths.map((path) =>
              path.pathId === entityId
                ? {
                    ...path,
                    name: editName,
                    x,
                    y,
                    width,
                    height,
                    ...(editSurface.trim().length > 0 ? { surface: editSurface.trim() } : {}),
                  }
                : path,
            ),
          };
        }

        return {
          ...segment,
          beds: segment.beds.map((bed) =>
            bed.bedId === entityId
              ? {
                  ...bed,
                  name: editName,
                  type: editType as Segment['beds'][number]['type'],
                  x,
                  y,
                  width,
                  height,
                }
              : bed,
          ),
        };
      });

      const validatedState = assertValid('appState', {
        ...appState,
        segments: nextSegments,
      });

      await saveAppStateToIndexedDb(validatedState);
      setSegments(nextSegments);
      setEditMessage(`${kind === 'path' ? 'Path' : 'Bed'} ${entityId} updated.`);
      clearEditState();
    } catch (error) {
      if (error instanceof SchemaValidationError) {
        const firstIssue = error.issues[0];
        setEditMessage(firstIssue ? `Validation failed: ${firstIssue.message}` : 'Validation failed.');
      } else {
        setEditMessage(error instanceof Error ? error.message : 'Failed to save changes.');
      }
    } finally {
      setIsSavingEdit(false);
    }
  }, [clearEditState, editHeight, editName, editSurface, editType, editWidth, editX, editY, editingEntityKey, isSavingEdit]);

  const handleDeletePath = useCallback(async (segmentId: string, pathId: string) => {
    if (deletingPathKey) {
      return;
    }

    setDeletePathMessage(null);

    try {
      const appState = await loadAppStateFromIndexedDb();
      if (!appState) {
        setDeletePathMessage('Unable to delete path because local app state is unavailable.');
        return;
      }

      const relatedPlanCount = appState.cropPlans.filter((plan) => plan.bedId === pathId).length;
      const relatedTaskCount = appState.tasks.filter((task) => task.bedId === pathId).length;
      const relatedBatchCount = appState.batches.filter((batch) => {
        const primaryAssignments = batch.assignments ?? [];
        const legacyAssignments = batch.bedAssignments ?? [];
        return [...primaryAssignments, ...legacyAssignments].some((assignment) => assignment.bedId === pathId);
      }).length;

      if (relatedPlanCount > 0 || relatedTaskCount > 0 || relatedBatchCount > 0) {
        const blockingReasons: string[] = [];
        if (relatedPlanCount > 0) {
          blockingReasons.push(`${relatedPlanCount} crop plan${relatedPlanCount === 1 ? '' : 's'}`);
        }
        if (relatedBatchCount > 0) {
          blockingReasons.push(`${relatedBatchCount} batch assignment${relatedBatchCount === 1 ? '' : 's'}`);
        }
        if (relatedTaskCount > 0) {
          blockingReasons.push(`${relatedTaskCount} task${relatedTaskCount === 1 ? '' : 's'}`);
        }

        setDeletePathMessage(`Cannot delete path ${pathId} because it is referenced by ${blockingReasons.join(', ')}.`);
        return;
      }

      if (!window.confirm(`Delete path ${pathId} from segment ${segmentId}? This action cannot be undone.`)) {
        return;
      }

      setDeletingPathKey(`${segmentId}:${pathId}`);

      const nextSegments = (appState.segments ?? []).map((segment) => {
        if (segment.segmentId !== segmentId) {
          return segment;
        }

        const nextPaths = segment.paths.filter((segmentPath) => segmentPath.pathId !== pathId);
        return nextPaths.length === segment.paths.length ? segment : { ...segment, paths: nextPaths };
      });

      const nextState = {
        ...appState,
        segments: nextSegments,
      };

      await saveAppStateToIndexedDb(nextState);
      setSegments(nextSegments);
      setDeletePathMessage(`Deleted path ${pathId}.`);
    } catch (error) {
      setDeletePathMessage(error instanceof Error ? error.message : 'Failed to delete path.');
    } finally {
      setDeletingPathKey(null);
    }
  }, [deletingPathKey]);

  const handleDeleteSegmentBed = useCallback(async (segmentId: string, bedId: string) => {
    if (deletingBedKey) {
      return;
    }

    setDeletePathMessage(null);

    try {
      const appState = await loadAppStateFromIndexedDb();
      if (!appState) {
        setDeletePathMessage('Unable to delete bed because local app state is unavailable.');
        return;
      }

      const relatedPlanCount = appState.cropPlans.filter((plan) => plan.bedId === bedId).length;
      const relatedTaskCount = appState.tasks.filter((task) => task.bedId === bedId).length;
      const relatedBatchCount = appState.batches.filter((batch) => {
        const primaryAssignments = batch.assignments ?? [];
        const legacyAssignments = batch.bedAssignments ?? [];
        return [...primaryAssignments, ...legacyAssignments].some((assignment) => assignment.bedId === bedId);
      }).length;

      if (relatedPlanCount > 0 || relatedTaskCount > 0 || relatedBatchCount > 0) {
        const blockingReasons: string[] = [];
        if (relatedPlanCount > 0) {
          blockingReasons.push(`${relatedPlanCount} crop plan${relatedPlanCount === 1 ? '' : 's'}`);
        }
        if (relatedBatchCount > 0) {
          blockingReasons.push(`${relatedBatchCount} batch assignment${relatedBatchCount === 1 ? '' : 's'}`);
        }
        if (relatedTaskCount > 0) {
          blockingReasons.push(`${relatedTaskCount} task${relatedTaskCount === 1 ? '' : 's'}`);
        }

        setDeletePathMessage(`Cannot delete bed ${bedId} because it is referenced by ${blockingReasons.join(', ')}.`);
        return;
      }

      if (!window.confirm(`Delete bed ${bedId} from segment ${segmentId}? This action cannot be undone.`)) {
        return;
      }

      setDeletingBedKey(`${segmentId}:${bedId}`);

      const nextSegments = (appState.segments ?? []).map((segment) => {
        if (segment.segmentId !== segmentId) {
          return segment;
        }

        const nextBeds = segment.beds.filter((segmentBed) => segmentBed.bedId !== bedId);
        return nextBeds.length === segment.beds.length ? segment : { ...segment, beds: nextBeds };
      });

      const nextState = assertValid('appState', {
        ...appState,
        segments: nextSegments,
      });

      await saveAppStateToIndexedDb(nextState);
      setSegments(nextSegments);
      setDeletePathMessage(`Deleted bed ${bedId}.`);
    } catch (error) {
      setDeletePathMessage(error instanceof Error ? error.message : 'Failed to delete bed.');
    } finally {
      setDeletingBedKey(null);
    }
  }, [deletingBedKey]);

  return (
    <section className="beds-page">
      <h2>Beds</h2>
      {!isLoading ? (
        <p className="beds-page-summary">
          Segments: {segments.length} · Beds: {totalSegmentBedCount} · Paths: {totalPathCount}
        </p>
      ) : null}
      {!isLoading && editMessage ? <p className="beds-empty-state">{editMessage}</p> : null}
      {!isLoading && deletePathMessage ? <p className="beds-empty-state">{deletePathMessage}</p> : null}
      {!isLoading && segments.length > 0 ? (
        <section>
          <h3>Segment child entities</h3>
          {segments.map((segment) => (
            <article key={segment.segmentId}>
              <p>{segment.name} ({segment.segmentId})</p>
              <p>Beds</p>
              {segment.beds.length === 0 ? <p>No beds.</p> : (
                <ul>
                  {segment.beds.map((bed) => {
                    const editKey = `bed:${segment.segmentId}:${bed.bedId}`;
                    const deleteKey = `${segment.segmentId}:${bed.bedId}`;
                    const isEditing = editingEntityKey === editKey;
                    const isDeleting = deletingBedKey === deleteKey;

                    return (
                      <li key={bed.bedId}>
                        <span>{bed.name} ({bed.bedId}) · {bed.type} · {bed.width}×{bed.height} @ {bed.x},{bed.y}</span>{' '}
                        <button type="button" onClick={() => startEditBed(segment.segmentId, bed)} disabled={Boolean(deletingBedKey) || isSavingEdit}>
                          Edit bed
                        </button>{' '}
                        <button type="button" onClick={() => void handleDeleteSegmentBed(segment.segmentId, bed.bedId)} disabled={Boolean(deletingBedKey) || isSavingEdit}>
                          {isDeleting ? 'Deleting…' : 'Delete bed'}
                        </button>
                        {isEditing ? (
                          <div>
                            <label>
                              Name
                              <input value={editName} onChange={(event) => setEditName(event.target.value)} />
                            </label>{' '}
                            <label>
                              Type
                              <select value={editType} onChange={(event) => setEditType(event.target.value)}>
                                <option value="vegetable_bed">vegetable_bed</option>
                                <option value="perennial_bed">perennial_bed</option>
                                <option value="ecology_strip">ecology_strip</option>
                              </select>
                            </label>{' '}
                            <label>
                              X
                              <input value={editX} onChange={(event) => setEditX(event.target.value)} />
                            </label>{' '}
                            <label>
                              Y
                              <input value={editY} onChange={(event) => setEditY(event.target.value)} />
                            </label>{' '}
                            <label>
                              Width
                              <input value={editWidth} onChange={(event) => setEditWidth(event.target.value)} />
                            </label>{' '}
                            <label>
                              Height
                              <input value={editHeight} onChange={(event) => setEditHeight(event.target.value)} />
                            </label>{' '}
                            <button type="button" onClick={() => void handleSaveEdit()} disabled={isSavingEdit}>
                              {isSavingEdit ? 'Saving…' : 'Save'}
                            </button>{' '}
                            <button type="button" onClick={() => clearEditState()} disabled={isSavingEdit}>Cancel</button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
              <p>Paths</p>
              {segment.paths.length === 0 ? <p>No paths.</p> : (
                <ul>
                  {segment.paths.map((path) => {
                    const editKey = `path:${segment.segmentId}:${path.pathId}`;
                    const deleteKey = `${segment.segmentId}:${path.pathId}`;
                    const isEditing = editingEntityKey === editKey;
                    const isDeleting = deletingPathKey === deleteKey;

                    return (
                      <li key={path.pathId}>
                        <span>{path.name} ({path.pathId}) · {path.width}×{path.height} @ {path.x},{path.y}</span>{' '}
                        <button type="button" onClick={() => startEditPath(segment.segmentId, path)} disabled={Boolean(deletingPathKey) || isSavingEdit}>
                          Edit path
                        </button>{' '}
                        <button type="button" onClick={() => void handleDeletePath(segment.segmentId, path.pathId)} disabled={Boolean(deletingPathKey) || isSavingEdit}>
                          {isDeleting ? 'Deleting…' : 'Delete path'}
                        </button>
                        {isEditing ? (
                          <div>
                            <label>
                              Name
                              <input value={editName} onChange={(event) => setEditName(event.target.value)} />
                            </label>{' '}
                            <label>
                              Surface
                              <input value={editSurface} onChange={(event) => setEditSurface(event.target.value)} />
                            </label>{' '}
                            <label>
                              X
                              <input value={editX} onChange={(event) => setEditX(event.target.value)} />
                            </label>{' '}
                            <label>
                              Y
                              <input value={editY} onChange={(event) => setEditY(event.target.value)} />
                            </label>{' '}
                            <label>
                              Width
                              <input value={editWidth} onChange={(event) => setEditWidth(event.target.value)} />
                            </label>{' '}
                            <label>
                              Height
                              <input value={editHeight} onChange={(event) => setEditHeight(event.target.value)} />
                            </label>{' '}
                            <button type="button" onClick={() => void handleSaveEdit()} disabled={isSavingEdit}>
                              {isSavingEdit ? 'Saving…' : 'Save'}
                            </button>{' '}
                            <button type="button" onClick={() => clearEditState()} disabled={isSavingEdit}>Cancel</button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </article>
          ))}
        </section>
      ) : null}
      {isLoading ? <p className="beds-empty-state">Loading beds…</p> : null}
      {!isLoading ? (
        <div className="beds-grid">
          {beds.map((bed) => (
            <Link key={bed.bedId} to={`/beds/${bed.bedId}`} className="bed-card-link">
              <article className="bed-card">
                <p className="bed-card-id">{bed.bedId}</p>
                <h3>{bed.name}</h3>
                <p className="bed-card-meta">Garden {bed.gardenId}</p>
                <p className="bed-card-meta">Active batches: {activeBatchCountByBedId[bed.bedId] ?? 0}</p>
              </article>
            </Link>
          ))}
        </div>
      ) : null}
      {!isLoading && beds.length === 0 ? <p className="beds-empty-state">No beds found.</p> : null}
    </section>
  );
}

function BedDetailPage() {
  const { bedId } = useParams();
  const navigate = useNavigate();
  const [bed, setBed] = useState<Bed | null>(null);
  const [allBeds, setAllBeds] = useState<Bed[]>([]);
  const [notes, setNotes] = useState('');
  const [batches, setBatches] = useState<Batch[]>([]);
  const [candidateBatches, setCandidateBatches] = useState<Batch[]>([]);
  const [cropNames, setCropNames] = useState<Record<string, string>>({});
  const [cropScientificNames, setCropScientificNames] = useState<Record<string, string>>({});
  const [cropHasTaskRules, setCropHasTaskRules] = useState<Record<string, boolean>>({});
  const [userDefinedCropIds, setUserDefinedCropIds] = useState<Record<string, boolean>>({});
  const [assignBatchId, setAssignBatchId] = useState('');
  const [assignDate, setAssignDate] = useState(getLocalDateTimeDefault());
  const [assignMeta, setAssignMeta] = useState('');
  const [includeEndedFailed, setIncludeEndedFailed] = useState(false);
  const [isAssigningBatch, setIsAssigningBatch] = useState(false);
  const [assignBatchMessage, setAssignBatchMessage] = useState<string | null>(null);
  const [expandedActionBatchId, setExpandedActionBatchId] = useState<string | null>(null);
  const [moveTargetBedByBatchId, setMoveTargetBedByBatchId] = useState<Record<string, string>>({});
  const [moveDateByBatchId, setMoveDateByBatchId] = useState<Record<string, string>>({});
  const [moveMetaByBatchId, setMoveMetaByBatchId] = useState<Record<string, string>>({});
  const [moveMessageByBatchId, setMoveMessageByBatchId] = useState<Record<string, string>>({});
  const [removeDateByBatchId, setRemoveDateByBatchId] = useState<Record<string, string>>({});
  const [removeConfirmByBatchId, setRemoveConfirmByBatchId] = useState<Record<string, boolean>>({});
  const [removeMessageByBatchId, setRemoveMessageByBatchId] = useState<Record<string, string>>({});
  const [savingActionBatchId, setSavingActionBatchId] = useState<string | null>(null);
  const [isDeletingBed, setIsDeletingBed] = useState(false);
  const [deleteBedMessage, setDeleteBedMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      if (!bedId) {
        setBed(null);
        setAllBeds([]);
        setBatches([]);
        setCandidateBatches([]);
        setIsLoading(false);
        return;
      }

      const appState = await loadAppStateFromIndexedDb();
      if (!appState) {
        setBed(null);
        setAllBeds([]);
        setBatches([]);
        setCandidateBatches([]);
        setCropNames({});
        setCropScientificNames({});
        setCropHasTaskRules({});
        setUserDefinedCropIds({});
        setIsLoading(false);
        return;
      }

      setCropNames(Object.fromEntries(appState.crops.map((crop) => [crop.cropId, crop.name])));
      setCropScientificNames(
        Object.fromEntries(
          appState.crops.map((crop) => [crop.cropId, getCropSpeciesScientificName(crop)]),
        ),
      );
      setCropHasTaskRules(
        Object.fromEntries(
          appState.crops.map((crop) => {
            const taskRules = (crop as { taskRules?: unknown }).taskRules;
            return [crop.cropId, Array.isArray(taskRules) && taskRules.length > 0];
          }),
        ),
      );
      setUserDefinedCropIds(
        Object.fromEntries(
          appState.crops.map((crop) => {
            const isUserDefined = (crop as { isUserDefined?: unknown }).isUserDefined;
            return [crop.cropId, isUserDefined === true];
          }),
        ),
      );

      const todayIso = new Date().toISOString();

      const nextBed = listBedsFromAppState(appState).find((candidate) => candidate.bedId === bedId) ?? null;
      const nextAllBeds = listBedsFromAppState(appState).sort((left, right) => left.bedId.localeCompare(right.bedId));
      const allBatches = listBatchesFromAppState(appState);
      const relatedBatches = allBatches
        .filter((batch) => getActiveBedAssignment(batch, todayIso)?.bedId === bedId)
        .sort((left, right) => left.batchId.localeCompare(right.batchId));
      const eligibleBatches = allBatches
        .filter((batch) => {
          if (!includeEndedFailed && (batch.stage === 'ended' || batch.stage === 'failed')) {
            return false;
          }

          return !getActiveBedAssignment(batch, todayIso);
        })
        .sort((left, right) => left.batchId.localeCompare(right.batchId));

      setBed(nextBed);
      setAllBeds(nextAllBeds);
      setNotes(nextBed?.notes ?? '');
      setBatches(relatedBatches);
      setCandidateBatches(eligibleBatches);
      setAssignBatchId((current) => (current && eligibleBatches.some((batch) => batch.batchId === current) ? current : eligibleBatches[0]?.batchId ?? ''));
      setIsLoading(false);
    };

    void load();
  }, [bedId, includeEndedFailed]);

  const selectedAssignBatch = useMemo(
    () => candidateBatches.find((batch) => batch.batchId === assignBatchId) ?? null,
    [assignBatchId, candidateBatches],
  );
  const assignRuleWarning =
    selectedAssignBatch && cropHasTaskRules[selectedAssignBatch.cropId] === false
      ? 'Warning: selected crop has no task rules. Bed assignment will still be saved.'
      : null;

  const refreshBedBatches = useCallback(
    (nextState: Awaited<ReturnType<typeof loadAppStateFromIndexedDb>>) => {
      if (!nextState || !bedId) {
        return;
      }

      const nowIso = new Date().toISOString();
      const nextAllBatches = listBatchesFromAppState(nextState);
      const nextBatches = nextAllBatches
        .filter((batch) => getActiveBedAssignment(batch, nowIso)?.bedId === bedId)
        .sort((left, right) => left.batchId.localeCompare(right.batchId));
      const nextCandidates = nextAllBatches
        .filter((batch) => {
          if (!includeEndedFailed && (batch.stage === 'ended' || batch.stage === 'failed')) {
            return false;
          }

          return !getActiveBedAssignment(batch, nowIso);
        })
        .sort((left, right) => left.batchId.localeCompare(right.batchId));

      setBatches(nextBatches);
      setCandidateBatches(nextCandidates);
      setAssignBatchId((current) => (current && nextCandidates.some((batch) => batch.batchId === current) ? current : nextCandidates[0]?.batchId ?? ''));
      setAllBeds(listBedsFromAppState(nextState).sort((left, right) => left.bedId.localeCompare(right.bedId)));
    },
    [bedId, includeEndedFailed],
  );

  const handleAssignBatch = async () => {
    if (!bedId || !assignBatchId) {
      setAssignBatchMessage('Select a batch to assign.');
      return;
    }

    if (!assignDate) {
      setAssignBatchMessage('Enter a valid assignment date and time.');
      return;
    }

    setIsAssigningBatch(true);

    try {
      const appState = await loadAppStateFromIndexedDb();
      if (!appState) {
        setAssignBatchMessage('Unable to save because local app state is unavailable.');
        return;
      }

      const existingBatch = appState.batches.find((candidate) => candidate.batchId === assignBatchId);
      if (!existingBatch) {
        setAssignBatchMessage('Selected batch was not found.');
        return;
      }

      const assignedAt = new Date(assignDate).toISOString();
      const updatedBatch = assignBatchToBed(existingBatch, bedId, assignedAt);
      const nextState = upsertBatchInAppState(appState, updatedBatch);
      await saveAppStateToIndexedDb(nextState);

      refreshBedBatches(nextState);
      setAssignDate(getLocalDateTimeDefault());
      setAssignMeta('');
      setAssignBatchMessage(assignMeta ? `Batch assigned to ${bedId}. Meta: ${assignMeta}` : `Batch assigned to ${bedId}.`);
    } catch (error) {
      if (error instanceof Error && error.message === 'batch_assignment_overlap') {
        setAssignBatchMessage('Unable to assign batch: it already has an overlapping bed assignment for that date.');
      } else {
        setAssignBatchMessage(error instanceof Error ? error.message : 'Failed to assign batch to bed.');
      }
    } finally {
      setIsAssigningBatch(false);
    }
  };

  const handleMoveBatchFromBed = async (batch: Batch) => {
    const moveDateInput = moveDateByBatchId[batch.batchId] ?? getLocalDateTimeDefault();
    const targetBedId = moveTargetBedByBatchId[batch.batchId] ?? '';

    if (!targetBedId) {
      setMoveMessageByBatchId((current) => ({ ...current, [batch.batchId]: 'Select a target bed.' }));
      return;
    }

    if (!moveDateInput) {
      setMoveMessageByBatchId((current) => ({ ...current, [batch.batchId]: 'Enter a valid move date and time.' }));
      return;
    }

    setSavingActionBatchId(batch.batchId);

    try {
      const appState = await loadAppStateFromIndexedDb();
      if (!appState) {
        setMoveMessageByBatchId((current) => ({ ...current, [batch.batchId]: 'Unable to save because local app state is unavailable.' }));
        return;
      }

      const existingBatch = appState.batches.find((candidate) => candidate.batchId === batch.batchId);
      if (!existingBatch) {
        setMoveMessageByBatchId((current) => ({ ...current, [batch.batchId]: 'Batch was not found.' }));
        return;
      }

      const moveDate = new Date(moveDateInput).toISOString();
      const movedBatch = moveBatch(existingBatch, targetBedId, moveDate);
      const nextState = upsertBatchInAppState(appState, movedBatch);
      await saveAppStateToIndexedDb(nextState);
      refreshBedBatches(nextState);
      setMoveDateByBatchId((current) => ({ ...current, [batch.batchId]: getLocalDateTimeDefault() }));
      setMoveMetaByBatchId((current) => ({ ...current, [batch.batchId]: '' }));
      setMoveMessageByBatchId((current) => ({
        ...current,
        [batch.batchId]: moveMetaByBatchId[batch.batchId]
          ? `Moved to ${targetBedId}. Meta: ${moveMetaByBatchId[batch.batchId]}`
          : `Moved to ${targetBedId}.`,
      }));
    } catch (error) {
      const nextMessage =
        error instanceof Error && error.message === 'batch_assignment_no_active'
          ? 'Move failed: batch has no active assignment at the selected date.'
          : error instanceof Error && error.message === 'batch_assignment_move_before_start'
            ? 'Move failed: move date is before the current assignment start.'
            : error instanceof Error
              ? error.message
              : 'Failed to move batch.';
      setMoveMessageByBatchId((current) => ({ ...current, [batch.batchId]: nextMessage }));
    } finally {
      setSavingActionBatchId(null);
    }
  };

  const handleRemoveBatchFromBed = async (batch: Batch) => {
    const isConfirmed = removeConfirmByBatchId[batch.batchId] ?? false;
    if (!isConfirmed) {
      setRemoveMessageByBatchId((current) => ({ ...current, [batch.batchId]: 'Check confirm before removing this batch from bed.' }));
      return;
    }

    const removeDateInput = removeDateByBatchId[batch.batchId] ?? getLocalDateTimeDefault();
    if (!removeDateInput) {
      setRemoveMessageByBatchId((current) => ({ ...current, [batch.batchId]: 'Enter a valid removal date and time.' }));
      return;
    }

    setSavingActionBatchId(batch.batchId);

    try {
      const appState = await loadAppStateFromIndexedDb();
      if (!appState) {
        setRemoveMessageByBatchId((current) => ({ ...current, [batch.batchId]: 'Unable to save because local app state is unavailable.' }));
        return;
      }

      const existingBatch = appState.batches.find((candidate) => candidate.batchId === batch.batchId);
      if (!existingBatch) {
        setRemoveMessageByBatchId((current) => ({ ...current, [batch.batchId]: 'Batch was not found.' }));
        return;
      }

      const endDate = new Date(removeDateInput).toISOString();
      const nextBatch = removeBatchFromBed(existingBatch, endDate);
      const nextState = upsertBatchInAppState(appState, nextBatch);
      await saveAppStateToIndexedDb(nextState);
      refreshBedBatches(nextState);
      setRemoveConfirmByBatchId((current) => ({ ...current, [batch.batchId]: false }));
      setRemoveDateByBatchId((current) => ({ ...current, [batch.batchId]: getLocalDateTimeDefault() }));
      setRemoveMessageByBatchId((current) => ({
        ...current,
        [batch.batchId]: nextBatch === existingBatch ? 'Batch is already unassigned for that date.' : 'Batch removed from bed.',
      }));
    } catch (error) {
      setRemoveMessageByBatchId((current) => ({
        ...current,
        [batch.batchId]: error instanceof Error ? error.message : 'Failed to remove batch from bed.',
      }));
    } finally {
      setSavingActionBatchId(null);
    }
  };

  const handleDeleteBed = async () => {
    if (!bedId || isDeletingBed) {
      return;
    }

    setDeleteBedMessage(null);

    try {
      const appState = await loadAppStateFromIndexedDb();
      if (!appState) {
        setDeleteBedMessage('Unable to delete because local app state is unavailable.');
        return;
      }

      const relatedPlanCount = appState.cropPlans.filter((plan) => plan.bedId === bedId).length;
      const relatedTaskCount = appState.tasks.filter((task) => task.bedId === bedId).length;
      const relatedBatchCount = appState.batches.filter((batch) => {
        const primaryAssignments = batch.assignments ?? [];
        const legacyAssignments = batch.bedAssignments ?? [];
        return [...primaryAssignments, ...legacyAssignments].some((assignment) => assignment.bedId === bedId);
      }).length;

      if (relatedPlanCount > 0 || relatedTaskCount > 0 || relatedBatchCount > 0) {
        const blockingReasons: string[] = [];
        if (relatedPlanCount > 0) {
          blockingReasons.push(`${relatedPlanCount} crop plan${relatedPlanCount === 1 ? '' : 's'}`);
        }
        if (relatedBatchCount > 0) {
          blockingReasons.push(`${relatedBatchCount} batch assignment${relatedBatchCount === 1 ? '' : 's'}`);
        }
        if (relatedTaskCount > 0) {
          blockingReasons.push(`${relatedTaskCount} task${relatedTaskCount === 1 ? '' : 's'}`);
        }

        setDeleteBedMessage(`Cannot delete this bed because it is referenced by ${blockingReasons.join(', ')}.`);
        return;
      }

      if (!window.confirm(`Delete bed ${bedId}? This action cannot be undone.`)) {
        return;
      }

      setIsDeletingBed(true);

      let wasRemovedFromSegment = false;
      const nextSegments = (appState.segments ?? []).map((segment) => {
        const nextBeds = segment.beds.filter((segmentBed) => segmentBed.bedId !== bedId);
        if (nextBeds.length !== segment.beds.length) {
          wasRemovedFromSegment = true;
        }

        return nextBeds.length === segment.beds.length ? segment : { ...segment, beds: nextBeds };
      });

      const nextState = {
        ...appState,
        segments: nextSegments,
        beds: wasRemovedFromSegment ? appState.beds : appState.beds.filter((candidateBed) => candidateBed.bedId !== bedId),
      };

      await saveAppStateToIndexedDb(nextState);
      await navigate('/beds');
    } catch (error) {
      setDeleteBedMessage(error instanceof Error ? error.message : 'Failed to delete bed.');
    } finally {
      setIsDeletingBed(false);
    }
  };

  useEffect(() => {
    if (!bed || !bedId) {
      return;
    }

    if ((bed.notes ?? '') === notes) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const persistNotes = async () => {
        const appState = await loadAppStateFromIndexedDb();
        if (!appState) {
          return;
        }

        const latestBed = listBedsFromAppState(appState).find((candidate) => candidate.bedId === bedId);
        if (!latestBed) {
          return;
        }

        const nextState = upsertBedInAppState(appState, {
          ...latestBed,
          notes,
          updatedAt: new Date().toISOString(),
        });

        await saveAppStateToIndexedDb(nextState);
        setBed((current) => (current && current.bedId === bedId ? { ...current, notes } : current));
      };

      void persistNotes();
    }, 600);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [bed, bedId, notes]);

  if (isLoading) {
    return <p className="beds-empty-state">Loading bed…</p>;
  }

  if (!bed) {
    return (
      <section className="bed-detail-page">
        <h2>Bed not found</h2>
        <p className="beds-empty-state">No bed matches ID {bedId ?? 'unknown'}.</p>
        <Link to="/beds" className="bed-detail-back-link">
          ← Back to beds
        </Link>
      </section>
    );
  }

  return (
    <section className="bed-detail-page">
      <Link to="/beds" className="bed-detail-back-link">
        ← Back to beds
      </Link>
      <h2>{bed.name}</h2>
      <p className="bed-detail-meta">{bed.bedId} · Garden {bed.gardenId}</p>

      <article className="bed-detail-card">
        <h3>Details</h3>
        <p className="bed-detail-meta">Area: —</p>

        <label className="bed-detail-notes-label" htmlFor="bed-notes">
          Notes
        </label>
        <textarea
          id="bed-notes"
          className="bed-detail-notes-input"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Add bed notes..."
        />
      </article>

      <article className="bed-detail-card">
        <h3>Composition</h3>
        <p className="bed-detail-meta">Companions and succession notes will appear here.</p>
      </article>

      <article className="bed-detail-card">
        <h3>Danger zone</h3>
        <button type="button" onClick={() => void handleDeleteBed()} disabled={isDeletingBed}>
          {isDeletingBed ? 'Deleting bed…' : 'Delete bed'}
        </button>
        {deleteBedMessage ? <p>{deleteBedMessage}</p> : null}
      </article>

      <article className="bed-detail-card">
        <h3>Active batches</h3>
        {batches.length === 0 ? (
          <p className="beds-empty-state">No active batches assigned to this bed.</p>
        ) : (
          <ul className="bed-detail-batch-list">
            {batches.map((batch) => (
              <li key={batch.batchId}>
                <div className="bed-detail-batch-head">
                  <Link to={`/batches/${batch.batchId}`}>
                    <CropIdentityLabel
                      cropId={batch.cropId || batch.batchId}
                      name={cropNames[batch.cropId]}
                      scientificName={cropScientificNames[batch.cropId]}
                    />
                  </Link>
                  <span className="crop-capability-badges" aria-label="Crop capabilities">
                    {getCropCapabilityLabels({
                      isUserDefined: userDefinedCropIds[batch.cropId],
                      hasTaskRules: cropHasTaskRules[batch.cropId],
                    }).map((label) => (
                      <span key={`${batch.batchId}-${label}`} className="crop-capability-badge">
                        {label}
                      </span>
                    ))}
                  </span>
                  <span className="batch-stage-badge">{batch.stage}</span>
                  <button
                    type="button"
                    className="bed-detail-batch-action-toggle"
                    onClick={() => {
                      const nextExpandedId = expandedActionBatchId === batch.batchId ? null : batch.batchId;
                      setExpandedActionBatchId(nextExpandedId);
                      if (nextExpandedId !== batch.batchId) {
                        return;
                      }

                      const targetBeds = allBeds.filter((candidateBed) => candidateBed.bedId !== bedId);
                      setMoveTargetBedByBatchId((current) => ({ ...current, [batch.batchId]: current[batch.batchId] ?? targetBeds[0]?.bedId ?? '' }));
                      setMoveDateByBatchId((current) => ({ ...current, [batch.batchId]: current[batch.batchId] ?? getLocalDateTimeDefault() }));
                      setMoveMetaByBatchId((current) => ({ ...current, [batch.batchId]: current[batch.batchId] ?? '' }));
                      setRemoveDateByBatchId((current) => ({ ...current, [batch.batchId]: current[batch.batchId] ?? getLocalDateTimeDefault() }));
                    }}
                  >
                    {expandedActionBatchId === batch.batchId ? 'Hide actions' : 'Manage'}
                  </button>
                </div>
                {expandedActionBatchId === batch.batchId ? (
                  <div className="bed-detail-batch-action-panel">
                    <div className="batch-next-action-row">
                      <span className="batch-detail-pill">move</span>
                      <select
                        value={moveTargetBedByBatchId[batch.batchId] ?? ''}
                        aria-label={`Move ${batch.batchId} to bed`}
                        onChange={(event) => setMoveTargetBedByBatchId((current) => ({ ...current, [batch.batchId]: event.target.value }))}
                        disabled={allBeds.filter((candidateBed) => candidateBed.bedId !== bedId).length === 0}
                      >
                        {allBeds.filter((candidateBed) => candidateBed.bedId !== bedId).length === 0 ? <option value="">No other beds</option> : null}
                        {allBeds
                          .filter((candidateBed) => candidateBed.bedId !== bedId)
                          .map((candidateBed) => (
                            <option key={candidateBed.bedId} value={candidateBed.bedId}>
                              {candidateBed.name} ({candidateBed.bedId})
                            </option>
                          ))}
                      </select>
                      <input
                        type="datetime-local"
                        aria-label={`Move ${batch.batchId} date and time`}
                        value={moveDateByBatchId[batch.batchId] ?? ''}
                        onChange={(event) => setMoveDateByBatchId((current) => ({ ...current, [batch.batchId]: event.target.value }))}
                      />
                      <input
                        type="text"
                        aria-label={`Move ${batch.batchId} meta`}
                        value={moveMetaByBatchId[batch.batchId] ?? ''}
                        onChange={(event) => setMoveMetaByBatchId((current) => ({ ...current, [batch.batchId]: event.target.value }))}
                        placeholder="Position / meta (optional)"
                      />
                      <button
                        type="button"
                        onClick={() => void handleMoveBatchFromBed(batch)}
                        disabled={savingActionBatchId === batch.batchId || allBeds.filter((candidateBed) => candidateBed.bedId !== bedId).length === 0}
                      >
                        Move
                      </button>
                    </div>
                    {moveMessageByBatchId[batch.batchId] ? <p className="batch-stage-warning">{moveMessageByBatchId[batch.batchId]}</p> : null}
                    <div className="batch-next-action-row">
                      <span className="batch-detail-pill">remove</span>
                      <label className="bed-detail-meta">
                        <input
                          type="checkbox"
                          checked={removeConfirmByBatchId[batch.batchId] ?? false}
                          onChange={(event) => setRemoveConfirmByBatchId((current) => ({ ...current, [batch.batchId]: event.target.checked }))}
                        />{' '}
                        Confirm
                      </label>
                      <input
                        type="datetime-local"
                        aria-label={`Remove ${batch.batchId} from bed date and time`}
                        value={removeDateByBatchId[batch.batchId] ?? ''}
                        onChange={(event) => setRemoveDateByBatchId((current) => ({ ...current, [batch.batchId]: event.target.value }))}
                      />
                      <button type="button" onClick={() => void handleRemoveBatchFromBed(batch)} disabled={savingActionBatchId === batch.batchId}>
                        Remove
                      </button>
                    </div>
                    {removeMessageByBatchId[batch.batchId] ? <p className="batch-stage-warning">{removeMessageByBatchId[batch.batchId]}</p> : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <div className="batch-next-actions">
          <div className="batch-next-action-row">
            <span className="batch-detail-pill">assign</span>
            <select
              value={assignBatchId}
              aria-label="Select batch to assign"
              onChange={(event) => setAssignBatchId(event.target.value)}
              disabled={candidateBatches.length === 0}
            >
              {candidateBatches.length === 0 ? <option value="">No eligible batches</option> : null}
              {candidateBatches.map((batch) => (
                <option key={batch.batchId} value={batch.batchId}>
                  {formatCropOptionLabel({
                    cropId: batch.cropId,
                    name: cropNames[batch.cropId],
                    scientificName: cropScientificNames[batch.cropId],
                  }) || batch.batchId}
                </option>
              ))}
            </select>
            <input
              type="datetime-local"
              aria-label="Assignment date and time"
              value={assignDate}
              onChange={(event) => setAssignDate(event.target.value)}
            />
            <input
              type="text"
              aria-label="Assignment meta"
              value={assignMeta}
              onChange={(event) => setAssignMeta(event.target.value)}
              placeholder="Position / meta (optional)"
            />
            <button type="button" onClick={() => void handleAssignBatch()} disabled={!assignBatchId || isAssigningBatch || candidateBatches.length === 0}>
              Assign
            </button>
          </div>
          <label className="bed-detail-meta">
            <input
              type="checkbox"
              checked={includeEndedFailed}
              onChange={(event) => setIncludeEndedFailed(event.target.checked)}
            />{' '}
            Include ended/failed
          </label>
          {assignBatchMessage ? <p className="batch-stage-warning">{assignBatchMessage}</p> : null}
          {assignRuleWarning ? <p className="batch-stage-warning">{assignRuleWarning}</p> : null}
        </div>
      </article>
    </section>
  );
}

function CalendarPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [bedNames, setBedNames] = useState<Record<string, string>>({});
  const [cropNames, setCropNames] = useState<Record<string, string>>({});
  const [cropScientificNames, setCropScientificNames] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const [isRegeneratingTasks, setIsRegeneratingTasks] = useState(false);
  const [regenerationSummary, setRegenerationSummary] = useState<{ added: number; updated: number; unchanged: number; warnings: string[] } | null>(null);
  const [regenerationError, setRegenerationError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const appState = await loadAppStateFromIndexedDb();

      if (!appState) {
        setTasks([]);
        setBedNames({});
        setCropNames({});
        setCropScientificNames({});
        setIsLoading(false);
        return;
      }

      setTasks(listTasksFromAppState(appState));
      setBedNames(Object.fromEntries(appState.beds.map((bed) => [bed.bedId, bed.name])));
      setCropNames(Object.fromEntries(appState.crops.map((crop) => [crop.cropId, crop.name])));
      setCropScientificNames(
        Object.fromEntries(
          appState.crops.map((crop) => [crop.cropId, getCropSpeciesScientificName(crop)]),
        ),
      );
      setIsLoading(false);
    };

    void load();
  }, []);

  const filters = {
    days: searchParams.get('days') ?? '30',
    bed: searchParams.get('bed') ?? '',
    crop: searchParams.get('crop') ?? '',
    status: searchParams.get('status') ?? '',
    type: searchParams.get('type') ?? '',
    overdue: searchParams.get('overdue') === '1',
  };

  const updateFilter = (name: string, value: string) => {
    const next = new URLSearchParams(searchParams);

    if (value) {
      next.set(name, value);
    } else {
      next.delete(name);
    }

    setSearchParams(next, { replace: true });
  };

  const localToday = useMemo(() => {
    const today = new Date();
    const localOffsetMs = today.getTimezoneOffset() * 60_000;
    return new Date(today.getTime() - localOffsetMs).toISOString().slice(0, 10);
  }, []);

  const rangeEnd = useMemo(() => {
    const startDate = new Date(`${localToday}T00:00:00`);
    startDate.setDate(startDate.getDate() + Number(filters.days));
    const localOffsetMs = startDate.getTimezoneOffset() * 60_000;
    return new Date(startDate.getTime() - localOffsetMs).toISOString().slice(0, 10);
  }, [filters.days, localToday]);

  const bedOptions = useMemo(
    () =>
      Array.from(new Set(tasks.map((task) => task.bedId).filter(Boolean)))
        .sort((left, right) => (bedNames[left] ?? left).localeCompare(bedNames[right] ?? right))
        .map((bedId) => ({ value: bedId, label: bedNames[bedId] ?? bedId })),
    [bedNames, tasks],
  );

  const cropOptions = useMemo(
    () =>
      Array.from(new Set(tasks.map((task) => task.cropId).filter(Boolean)))
        .sort((left, right) => (cropNames[left] ?? left).localeCompare(cropNames[right] ?? right))
        .map((cropId) => ({
          value: cropId,
          label: formatCropOptionLabel({ cropId, name: cropNames[cropId], scientificName: cropScientificNames[cropId] }),
        })),
    [cropNames, cropScientificNames, tasks],
  );

  const statusOptions = useMemo(
    () => Array.from(new Set(tasks.map((task) => task.status).filter(Boolean))).sort(),
    [tasks],
  );

  const typeOptions = useMemo(
    () => Array.from(new Set(tasks.map((task) => task.type).filter(Boolean))).sort(),
    [tasks],
  );

  const filteredTasks = useMemo(
    () =>
      tasks
        .filter((task) => {
          const inWindow = task.date >= localToday && task.date <= rangeEnd;
          const isOverdue = task.date < localToday;

          if (!inWindow && !(filters.overdue && isOverdue)) {
            return false;
          }

          if (filters.bed && task.bedId !== filters.bed) {
            return false;
          }

          if (filters.crop && task.cropId !== filters.crop) {
            return false;
          }

          if (filters.status && task.status !== filters.status) {
            return false;
          }

          if (filters.type && task.type !== filters.type) {
            return false;
          }

          return true;
        })
        .sort((left, right) => {
          if (left.date !== right.date) {
            return left.date.localeCompare(right.date);
          }

          return left.id.localeCompare(right.id);
        }),
    [filters.bed, filters.crop, filters.overdue, filters.status, filters.type, localToday, rangeEnd, tasks],
  );

  const handleToggleTaskStatus = async (task: Task) => {
    if (savingTaskId) {
      return;
    }

    setSavingTaskId(task.id);

    try {
      const appState = await loadAppStateFromIndexedDb();
      if (!appState) {
        return;
      }

      const doneStatuses = new Set(['done', 'completed']);
      const isDone = doneStatuses.has(task.status.toLowerCase());
      const updatedTask = { ...task, status: isDone ? 'pending' : 'done' };
      const nextState = upsertTaskInAppState(appState, updatedTask);
      await saveAppStateToIndexedDb(nextState);
      setTasks((current) => current.map((entry) => (entry.id === updatedTask.id ? updatedTask : entry)));
    } finally {
      setSavingTaskId(null);
    }
  };

  const handleRegenerateTasks = async () => {
    if (isRegeneratingTasks) {
      return;
    }

    setIsRegeneratingTasks(true);
    setRegenerationSummary(null);
    setRegenerationError(null);

    try {
      const appState = await loadAppStateFromIndexedDb();
      if (!appState) {
        setRegenerationError('Unable to regenerate tasks because local app state is unavailable.');
        return;
      }

      const tasksBeforeBySourceKey = new Map(listTasksFromAppState(appState).map((task) => [task.sourceKey, task]));
      const currentYear = new Date().getUTCFullYear();
      const generationResult = generateCalendarTasksWithDiagnostics(appState, currentYear);
      const generatedTasks = generationResult.tasks;
      const nextState = upsertGeneratedTasksInAppState(appState, generatedTasks);
      const tasksAfter = listTasksFromAppState(nextState);
      const tasksAfterBySourceKey = new Map(tasksAfter.map((task) => [task.sourceKey, task]));

      let added = 0;
      let updated = 0;
      let unchanged = 0;
      const processedSourceKeys = new Set<string>();

      for (const generatedTask of generatedTasks) {
        if (processedSourceKeys.has(generatedTask.sourceKey)) {
          continue;
        }

        processedSourceKeys.add(generatedTask.sourceKey);
        const beforeTask = tasksBeforeBySourceKey.get(generatedTask.sourceKey);
        const afterTask = tasksAfterBySourceKey.get(generatedTask.sourceKey);

        if (!beforeTask && afterTask) {
          added += 1;
          continue;
        }

        if (!beforeTask || !afterTask) {
          continue;
        }

        if (JSON.stringify(beforeTask) === JSON.stringify(afterTask)) {
          unchanged += 1;
        } else {
          updated += 1;
        }
      }

      await saveAppStateToIndexedDb(nextState);
      setTasks(tasksAfter);
      const warnings = generationResult.diagnostics.map((entry) => `${entry.cropId}: ${entry.reason}`);
      setRegenerationSummary({ added, updated, unchanged, warnings });
    } catch (error) {
      if (error instanceof SchemaValidationError && error.issues.length > 0) {
        setRegenerationError(`${error.message}: ${error.issues.map((issue) => issue.path || issue.message).join('; ')}`);
      } else {
        setRegenerationError(error instanceof Error ? error.message : 'Failed to regenerate tasks.');
      }
    } finally {
      setIsRegeneratingTasks(false);
    }
  };

  return (
    <section className="calendar-page">
      <h2>Calendar</h2>
      <div className="calendar-range-toggle" role="group" aria-label="Date window">
        {[7, 30, 90].map((days) => (
          <button
            key={days}
            type="button"
            className={filters.days === String(days) ? 'active' : ''}
            onClick={() => updateFilter('days', String(days))}
          >
            {days} days
          </button>
        ))}
        <label>
          <input
            type="checkbox"
            checked={filters.overdue}
            onChange={(event) => updateFilter('overdue', event.target.checked ? '1' : '')}
          />{' '}
          Show past due
        </label>
        <button type="button" onClick={() => void handleRegenerateTasks()} disabled={isRegeneratingTasks}>
          {isRegeneratingTasks ? 'Regenerating…' : 'Regenerate tasks'}
        </button>
      </div>

      {regenerationSummary ? (
        <p className="batch-stage-warning">
          Regenerated tasks — Added: {regenerationSummary.added}, Updated: {regenerationSummary.updated}, Unchanged:{' '}
          {regenerationSummary.unchanged}
          {regenerationSummary.warnings.length > 0
            ? `, Skipped crops: ${regenerationSummary.warnings.join('; ')}`
            : ''}
        </p>
      ) : null}
      {regenerationError ? <p className="batch-stage-warning">Regeneration failed: {regenerationError}</p> : null}

      <div className="calendar-filters">
        <label>
          Bed
          <select value={filters.bed} onChange={(event) => updateFilter('bed', event.target.value)}>
            <option value="">All beds</option>
            {bedOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Crop
          <select value={filters.crop} onChange={(event) => updateFilter('crop', event.target.value)}>
            <option value="">All crops</option>
            {cropOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select value={filters.status} onChange={(event) => updateFilter('status', event.target.value)}>
            <option value="">All statuses</option>
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <label>
          Task type
          <select value={filters.type} onChange={(event) => updateFilter('type', event.target.value)}>
            <option value="">All types</option>
            {typeOptions.map((taskType) => (
              <option key={taskType} value={taskType}>
                {taskType}
              </option>
            ))}
          </select>
        </label>
      </div>

      {isLoading ? <p className="batch-empty-state">Loading tasks…</p> : null}

      {!isLoading ? (
        <ul className="task-list">
          {filteredTasks.map((task) => {
            const isDone = ['done', 'completed'].includes(task.status.toLowerCase());
            const isOverdue = task.date < localToday && !isDone;

            return (
              <li key={task.id} className={`task-row${isOverdue ? ' is-overdue' : ''}`}>
                <div className="task-row-main">
                  <p className="task-row-date">{task.date}</p>
                  <div className="task-row-badges">
                    <span className="task-type-badge">{task.type.replace(/[-_]/g, ' ')}</span>
                    <span className={`task-status-badge${isDone ? ' is-done' : ''}`}>{task.status}</span>
                  </div>
                  <p className="task-row-meta">
                    Bed: {(bedNames[task.bedId] ?? task.bedId) || '—'} · Crop:{' '}
                    <CropIdentityLabel
                      cropId={task.cropId || '—'}
                      name={task.cropId ? cropNames[task.cropId] : undefined}
                      scientificName={task.cropId ? cropScientificNames[task.cropId] : undefined}
                      className="crop-identity-inline"
                    />
                  </p>
                  {task.batchId ? (
                    <p className="task-row-meta">
                      Batch: <Link to={`/batches/${task.batchId}`}>{task.batchId}</Link>
                    </p>
                  ) : null}
                </div>
                <button type="button" onClick={() => void handleToggleTaskStatus(task)} disabled={savingTaskId === task.id}>
                  {isDone ? 'Mark undone' : 'Mark done'}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {!isLoading && filteredTasks.length === 0 ? <p className="batch-empty-state">No tasks in this range.</p> : null}
    </section>
  );
}

const UNLINKED_CROP_ID = 'unlinked-seed-inventory-crop';

function SeedInventoryPage() {
  const [items, setItems] = useState<SeedInventoryItem[]>([]);
  const [cropNames, setCropNames] = useState<Record<string, string>>({});
  const [cropIds, setCropIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formValues, setFormValues] = useState({
    variety: '',
    cropId: UNLINKED_CROP_ID,
    quantity: '0',
    unit: 'seeds' as SeedInventoryItem['unit'],
    notes: '',
  });

  const loadInventory = useCallback(async () => {
    const appState = await loadAppStateFromIndexedDb();

    if (!appState) {
      setItems([]);
      setCropNames({});
      setCropIds([]);
      setIsLoading(false);
      return;
    }

    setItems(
      listSeedInventoryItemsFromAppState(appState).sort((left, right) => left.variety.localeCompare(right.variety)),
    );
    setCropNames(Object.fromEntries(appState.crops.map((crop) => [crop.cropId, crop.name])));
    setCropIds(appState.crops.map((crop) => crop.cropId).sort((left, right) => left.localeCompare(right)));
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void loadInventory();
  }, [loadInventory]);

  const resetForm = () => {
    setEditingId(null);
    setFormValues({
      variety: '',
      cropId: UNLINKED_CROP_ID,
      quantity: '0',
      unit: 'seeds',
      notes: '',
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedVariety = formValues.variety.trim();
    if (!trimmedVariety) {
      return;
    }

    const parsedQuantity = Number(formValues.quantity);
    if (!Number.isFinite(parsedQuantity) || parsedQuantity < 0) {
      return;
    }

    setSavingId(editingId ?? 'new');

    try {
      const appState = await loadAppStateFromIndexedDb();
      if (!appState) {
        return;
      }

      const nowIso = new Date().toISOString();
      const existing = editingId
        ? appState.seedInventoryItems.find((item) => item.seedInventoryItemId === editingId)
        : null;

      const nextItem: SeedInventoryItem = {
        seedInventoryItemId: existing?.seedInventoryItemId ?? `seed-item-${crypto.randomUUID()}`,
        cropId: formValues.cropId,
        variety: trimmedVariety,
        quantity: parsedQuantity,
        unit: formValues.unit,
        status: parsedQuantity === 0 ? 'depleted' : parsedQuantity <= 10 ? 'low' : 'available',
        ...(formValues.notes.trim() ? { notes: formValues.notes.trim() } : {}),
        createdAt: existing?.createdAt ?? nowIso,
        updatedAt: nowIso,
      };

      const nextState = upsertSeedInventoryItemInAppState(appState, nextItem);
      await saveAppStateToIndexedDb(nextState);
      await loadInventory();
      resetForm();
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (seedInventoryItemId: string) => {
    setSavingId(seedInventoryItemId);

    try {
      const appState = await loadAppStateFromIndexedDb();
      if (!appState) {
        return;
      }

      const nextState = removeSeedInventoryItemFromAppState(appState, seedInventoryItemId);
      await saveAppStateToIndexedDb(nextState);
      await loadInventory();
      if (editingId === seedInventoryItemId) {
        resetForm();
      }
    } finally {
      setSavingId(null);
    }
  };

  return (
    <section className="seed-inventory-page">
      <h2>Seed Inventory</h2>
      <form className="seed-inventory-form" onSubmit={(event) => void handleSubmit(event)}>
        <input
          type="text"
          value={formValues.variety}
          onChange={(event) => setFormValues((current) => ({ ...current, variety: event.target.value }))}
          placeholder="Variety"
          required
        />
        <select
          value={formValues.cropId}
          onChange={(event) => setFormValues((current) => ({ ...current, cropId: event.target.value }))}
        >
          <option value={UNLINKED_CROP_ID}>Unlinked crop</option>
          {cropIds.map((cropId) => (
            <option key={cropId} value={cropId}>
              {cropNames[cropId] ?? cropId}
            </option>
          ))}
        </select>
        <input
          type="number"
          min="0"
          step="0.01"
          value={formValues.quantity}
          onChange={(event) => setFormValues((current) => ({ ...current, quantity: event.target.value }))}
          placeholder="Quantity"
          required
        />
        <select
          value={formValues.unit}
          onChange={(event) => setFormValues((current) => ({ ...current, unit: event.target.value as SeedInventoryItem['unit'] }))}
        >
          <option value="seeds">seeds</option>
          <option value="g">g</option>
          <option value="packets">packets</option>
        </select>
        <input
          type="text"
          value={formValues.notes}
          onChange={(event) => setFormValues((current) => ({ ...current, notes: event.target.value }))}
          placeholder="Notes"
        />
        <button type="submit" disabled={savingId !== null}>
          {editingId ? 'Save item' : 'Add item'}
        </button>
        {editingId ? (
          <button type="button" onClick={resetForm} disabled={savingId !== null}>
            Cancel
          </button>
        ) : null}
      </form>

      {isLoading ? <p>Loading inventory…</p> : null}
      {!isLoading ? (
        <ul className="seed-inventory-list">
          {items.map((item) => (
            <li key={item.seedInventoryItemId} className="seed-inventory-row">
              <div>
                <p className="seed-inventory-primary">{item.variety}</p>
                <p className="seed-inventory-meta">
                  Crop: {item.cropId === UNLINKED_CROP_ID ? 'Unlinked' : cropNames[item.cropId] ?? 'Unknown crop'}
                </p>
                <p className="seed-inventory-meta">
                  {item.quantity} {item.unit} • {item.status}
                </p>
                {item.notes ? <p className="seed-inventory-meta">{item.notes}</p> : null}
              </div>
              <div className="seed-inventory-actions">
                <button
                  type="button"
                  onClick={() => {
                    setEditingId(item.seedInventoryItemId);
                    setFormValues({
                      variety: item.variety,
                      cropId: item.cropId,
                      quantity: String(item.quantity),
                      unit: item.unit,
                      notes: item.notes ?? '',
                    });
                  }}
                  disabled={savingId !== null}
                >
                  Edit
                </button>
                <button type="button" onClick={() => void handleDelete(item.seedInventoryItemId)} disabled={savingId !== null}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {!isLoading && items.length === 0 ? <p>No seed inventory items yet.</p> : null}
    </section>
  );
}

const getDerivedBedId = (batch: Batch): string | null => getActiveBedAssignment(batch, new Date().toISOString())?.bedId ?? null;

const getLocalDateTimeDefault = () => {
  const date = new Date();
  const localOffsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - localOffsetMs).toISOString().slice(0, 16);
};

const CONFIDENCE_OPTIONS: BatchConfidence[] = ['exact', 'estimated', 'unknown'];

const toLocalDateTimeInput = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

const fromLocalDateTimeInput = (value: string): string | null => {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
};

const getCropSpeciesScientificName = (crop: Crop): string => {
  const speciesScientificName = (crop as Crop & { species?: { scientificName?: string } }).species?.scientificName;
  return speciesScientificName ?? (crop as { scientificName?: string }).scientificName ?? '';
};

const getCropSpeciesCommonName = (crop: Crop): string => {
  const speciesCommonName = (crop as Crop & { species?: { commonName?: string } }).species?.commonName;
  return speciesCommonName ?? '';
};

const formatCropOptionLabel = (crop: { cropId: string; name: string | undefined; scientificName: string | undefined }) => {
  if (crop.name && crop.scientificName) {
    return `${crop.name} (${crop.scientificName})`;
  }

  return crop.name ?? crop.cropId;
};

const normalizeCropSearchValue = (value: string): string => value.trim().toLowerCase();

const parseCsvUnique = (value: string): string[] =>
  Array.from(
    new Set(
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  );

const normalizeCropIdPart = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

const createUniqueUserCropId = (name: string, existingCropIds: string[]): string => {
  const base = normalizeCropIdPart(name) || `crop-${Date.now()}`;
  const existing = new Set(existingCropIds);
  let candidate = `crop_user_${base}`;
  let suffix = 2;

  while (existing.has(candidate)) {
    candidate = `crop_user_${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
};

function BatchesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [batches, setBatches] = useState<Batch[]>([]);
  const [cropIds, setCropIds] = useState<string[]>([]);
  const [cropNames, setCropNames] = useState<Record<string, string>>({});
  const [cropScientificNames, setCropScientificNames] = useState<Record<string, string>>({});
  const [cropAliases, setCropAliases] = useState<Record<string, string[]>>({});
  const [cropHasTaskRules, setCropHasTaskRules] = useState<Record<string, boolean>>({});
  const [userDefinedCropIds, setUserDefinedCropIds] = useState<Record<string, boolean>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [editingBatchId, setEditingBatchId] = useState<string | null>(null);
  const [formValues, setFormValues] = useState({
    cropInput: '',
    cropCategory: '',
    cropScientificName: '',
    cropAliases: '',
    variety: '',
    startedAt: getLocalDateTimeDefault(),
    seedCountPlanned: '',
    seedCountGerminated: '',
    seedCountGerminatedConfidence: '',
    plantCountAlive: '',
    plantCountAliveConfidence: '',
    initialMethod: 'sowing',
  });
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [isAddingNewCrop, setIsAddingNewCrop] = useState(false);
  const [editingCropId, setEditingCropId] = useState<string>('');
  const [cropEditValues, setCropEditValues] = useState({
    cultivar: '',
    speciesId: '',
    speciesCommonName: '',
    speciesScientificName: '',
    aliases: '',
    notes: '',
    varieties: '',
    spacing: '',
    sowingTransplant: '',
    lifecycle: '',
    tags: '',
  });
  const [cropEditErrors, setCropEditErrors] = useState<Record<string, string>>({});
  const [cropEditMessage, setCropEditMessage] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const appState = await loadAppStateFromIndexedDb();

      if (!appState) {
        setBatches([]);
        setCropIds([]);
        setCropNames({});
        setCropScientificNames({});
        setCropAliases({});
        setCropHasTaskRules({});
        setUserDefinedCropIds({});
        setIsLoading(false);
        return;
      }

      setBatches(listBatchesFromAppState(appState));
      setCropIds(appState.crops.map((crop) => crop.cropId));
      setCropNames(Object.fromEntries(appState.crops.map((crop) => [crop.cropId, crop.name])));
      setCropScientificNames(
        Object.fromEntries(
          appState.crops.map((crop) => [crop.cropId, getCropSpeciesScientificName(crop)]),
        ),
      );
      setCropAliases(
        Object.fromEntries(
          appState.crops.map((crop) => {
            const aliases = Array.isArray((crop as { aliases?: string[] }).aliases)
              ? (crop as { aliases?: string[] }).aliases ?? []
              : [];
            return [crop.cropId, aliases];
          }),
        ),
      );
      setCropHasTaskRules(
        Object.fromEntries(
          appState.crops.map((crop) => {
            const taskRules = (crop as { taskRules?: unknown }).taskRules;
            return [crop.cropId, Array.isArray(taskRules) && taskRules.length > 0];
          }),
        ),
      );
      setUserDefinedCropIds(
        Object.fromEntries(
          appState.crops.map((crop) => {
            const isUserDefined = (crop as { isUserDefined?: unknown }).isUserDefined;
            return [crop.cropId, isUserDefined === true];
          }),
        ),
      );
      setIsLoading(false);
    };

    void load();
  }, []);

  const filters = useMemo(
    () => ({
      crop: searchParams.get('crop') ?? '',
      stage: searchParams.get('stage') ?? '',
      bed: searchParams.get('bed') ?? '',
      from: searchParams.get('from') ?? '',
      to: searchParams.get('to') ?? '',
    }),
    [searchParams],
  );

  const cropOptions = useMemo(
    () =>
      Array.from(new Set(batches.map((batch) => batch.cropId)))
        .sort((left, right) => (cropNames[left] ?? left).localeCompare(cropNames[right] ?? right))
        .map((cropId) => ({
          value: cropId,
          label: formatCropOptionLabel({
            cropId,
            name: cropNames[cropId],
            scientificName: cropScientificNames[cropId],
          }),
        })),
    [batches, cropNames, cropScientificNames],
  );

  const stageOptions = useMemo(
    () => Array.from(new Set(batches.map((batch) => batch.stage))).sort(),
    [batches],
  );

  const bedOptions = useMemo(
    () =>
      Array.from(
        new Set(
          batches
            .map((batch) => getDerivedBedId(batch))
            .filter((bedId): bedId is string => Boolean(bedId)),
        ),
      ).sort(),
    [batches],
  );

  const cropInputOptions = useMemo(
    () =>
      cropIds
        .map((cropId) => ({
          cropId,
          label: formatCropOptionLabel({
            cropId,
            name: cropNames[cropId],
            scientificName: cropScientificNames[cropId],
          }),
          name: cropNames[cropId] ?? '',
          scientificName: cropScientificNames[cropId] ?? '',
          aliases: cropAliases[cropId] ?? [],
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [cropAliases, cropIds, cropNames, cropScientificNames],
  );

  const filteredBatches = useMemo(
    () =>
      batches.filter((batch) => {
        const derivedBedId = getDerivedBedId(batch);
        const batchDate = batch.startedAt.slice(0, 10);

        if (filters.crop && batch.cropId !== filters.crop) {
          return false;
        }

        if (filters.stage && batch.stage !== filters.stage) {
          return false;
        }

        if (filters.bed && derivedBedId !== filters.bed) {
          return false;
        }

        if (filters.from && batchDate < filters.from) {
          return false;
        }

        if (filters.to && batchDate > filters.to) {
          return false;
        }

        return true;
      }),
    [batches, filters],
  );

  const updateFilter = (name: string, value: string) => {
    const next = new URLSearchParams(searchParams);

    if (value) {
      next.set(name, value);
    } else {
      next.delete(name);
    }

    setSearchParams(next, { replace: true });
  };

  const resolveCropIdFromInput = useCallback((cropInput: string): string | null => {
    const normalizedInput = normalizeCropSearchValue(cropInput);
    if (!normalizedInput) {
      return null;
    }

    const exactMatch = cropInputOptions.find((option) => {
      const aliases = option.aliases.map((alias) => normalizeCropSearchValue(alias));
      return (
        normalizeCropSearchValue(option.cropId) === normalizedInput ||
        normalizeCropSearchValue(option.label) === normalizedInput ||
        normalizeCropSearchValue(option.name) === normalizedInput ||
        normalizeCropSearchValue(option.scientificName) === normalizedInput ||
        aliases.includes(normalizedInput)
      );
    });

    if (exactMatch) {
      return exactMatch.cropId;
    }

    const containsMatch = cropInputOptions.find((option) => {
      const searchFields = [option.cropId, option.name, option.scientificName, ...option.aliases]
        .map((value) => normalizeCropSearchValue(value))
        .filter(Boolean);
      return searchFields.some((field) => field.includes(normalizedInput));
    });

    return containsMatch?.cropId ?? null;
  }, [cropInputOptions]);

  const selectedCropId = useMemo(
    () => resolveCropIdFromInput(formValues.cropInput),
    [formValues.cropInput, resolveCropIdFromInput],
  );
  const selectedCropRuleWarning =
    selectedCropId && cropHasTaskRules[selectedCropId] === false
      ? 'Warning: this crop has no task rules. You can still create and edit batches.'
      : null;


  const selectableCrops = useMemo(
    () =>
      cropIds
        .map((cropId) => ({
          cropId,
          label: formatCropOptionLabel({
            cropId,
            name: cropNames[cropId],
            scientificName: cropScientificNames[cropId],
          }),
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [cropIds, cropNames, cropScientificNames],
  );

  useEffect(() => {
    const firstSelectableCrop = selectableCrops[0];
    if (!editingCropId && firstSelectableCrop) {
      setEditingCropId(firstSelectableCrop.cropId);
    }
  }, [editingCropId, selectableCrops]);

  useEffect(() => {
    const loadCropForEdit = async () => {
      if (!editingCropId) {
        setCropEditValues({
          cultivar: '',
          speciesId: '',
          speciesCommonName: '',
          speciesScientificName: '',
          aliases: '',
          notes: '',
          varieties: '',
          spacing: '',
          sowingTransplant: '',
          lifecycle: '',
          tags: '',
        });
        return;
      }

      const appState = await loadAppStateFromIndexedDb();
      const crop = appState ? appState.crops.find((entry) => entry.cropId === editingCropId) : null;
      const cropMeta = ((crop as { meta?: Record<string, unknown> } | null)?.meta ?? {}) as Record<string, unknown>;

      const cropSpecies = ((crop as { species?: Record<string, unknown> } | null)?.species ?? {}) as Record<string, unknown>;
      setCropEditValues({
        cultivar: (crop as (Crop & { cultivar?: string }) | null)?.cultivar ?? crop?.name ?? '',
        speciesId: (crop as (Crop & { speciesId?: string }) | null)?.speciesId ?? (typeof cropSpecies.id === 'string' ? cropSpecies.id : ''),
        speciesCommonName:
          (typeof cropSpecies.commonName === 'string' ? cropSpecies.commonName : '')
          || crop?.name
          || '',
        speciesScientificName:
          (typeof cropSpecies.scientificName === 'string' ? cropSpecies.scientificName : '')
          || (typeof cropMeta.scientificName === 'string' ? cropMeta.scientificName : ''),
        aliases: (crop?.aliases ?? []).join(', '),
        notes: typeof cropMeta.notes === 'string' ? cropMeta.notes : '',
        varieties: Array.isArray(cropMeta.varieties) ? cropMeta.varieties.join(', ') : '',
        spacing: typeof cropMeta.spacing === 'string' ? cropMeta.spacing : '',
        sowingTransplant: typeof cropMeta.sowingTransplant === 'string' ? cropMeta.sowingTransplant : '',
        lifecycle: typeof cropMeta.lifecycle === 'string' ? cropMeta.lifecycle : '',
        tags: Array.isArray(cropMeta.tags) ? cropMeta.tags.join(', ') : '',
      });
      setCropEditErrors({});
      setCropEditMessage(null);
    };

    void loadCropForEdit();
  }, [editingCropId]);

  const handleCropEditSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setCropEditMessage(null);
    const errors: Record<string, string> = {};

    if (!editingCropId) {
      errors.cropId = 'Select a crop to edit.';
    }

    const cultivar = cropEditValues.cultivar.trim();
    if (!cultivar) {
      errors.cultivar = 'Cultivar is required.';
    }

    if (!cropEditValues.speciesId.trim()) {
      errors.speciesId = 'Species ID is required.';
    }

    if (cropEditValues.speciesScientificName.trim().length > 160) {
      errors.speciesScientificName = 'Species scientific name must be 160 characters or fewer.';
    }

    if (cropEditValues.notes.length > 2000) {
      errors.notes = 'Notes must be 2000 characters or fewer.';
    }

    if (Object.keys(errors).length > 0) {
      setCropEditErrors(errors);
      return;
    }

    try {
      const appState = await loadAppStateFromIndexedDb();

      if (!appState) {
        setCropEditMessage('Unable to save because local app state is unavailable.');
        return;
      }

      const existingCrop = appState.crops.find((crop) => crop.cropId === editingCropId);
      if (!existingCrop) {
        setCropEditMessage('Crop no longer exists.');
        return;
      }

      const existingMeta =
        (((existingCrop as Crop & { meta?: Record<string, unknown> }).meta ?? {}) as Record<string, unknown>) ?? {};
      const updatedAt = new Date().toISOString();
      const aliases = parseCsvUnique(cropEditValues.aliases);
      const tags = parseCsvUnique(cropEditValues.tags);
      const varieties = parseCsvUnique(cropEditValues.varieties);

      const speciesCommonName = cropEditValues.speciesCommonName.trim();
      const speciesScientificName = cropEditValues.speciesScientificName.trim();
      const speciesId = cropEditValues.speciesId.trim();

      const nextCrop = {
        ...existingCrop,
        cropId: existingCrop.cropId,
        name: cultivar,
        cultivar,
        speciesId,
        ...(aliases.length > 0 ? { aliases } : {}),
        species:
          speciesCommonName && speciesScientificName
            ? {
                id: speciesId,
                commonName: speciesCommonName,
                scientificName: speciesScientificName,
              }
            : undefined,
        meta: {
          ...existingMeta,
          ...(cropEditValues.notes.trim() ? { notes: cropEditValues.notes.trim() } : {}),
          ...(varieties.length > 0 ? { varieties } : {}),
          ...(cropEditValues.spacing.trim() ? { spacing: cropEditValues.spacing.trim() } : {}),
          ...(cropEditValues.sowingTransplant.trim() ? { sowingTransplant: cropEditValues.sowingTransplant.trim() } : {}),
          ...(cropEditValues.lifecycle.trim() ? { lifecycle: cropEditValues.lifecycle.trim() } : {}),
          ...(tags.length > 0 ? { tags } : {}),
        },
        updatedAt,
      };

      const nextState = upsertCropInAppState(appState, nextCrop);
      await saveAppStateToIndexedDb(nextState);
      setCropIds(nextState.crops.map((crop) => crop.cropId));
      setCropNames(Object.fromEntries(nextState.crops.map((crop) => [crop.cropId, crop.name])));
      setCropScientificNames(
        Object.fromEntries(
          nextState.crops.map((crop) => [crop.cropId, getCropSpeciesScientificName(crop)]),
        ),
      );
      setCropAliases(
        Object.fromEntries(
          nextState.crops.map((crop) => {
            const aliasesForCrop = Array.isArray((crop as { aliases?: string[] }).aliases)
              ? (crop as { aliases?: string[] }).aliases ?? []
              : [];
            return [crop.cropId, aliasesForCrop];
          }),
        ),
      );
      setCropEditErrors({});
      setCropEditMessage('Crop updated.');
      setFormValues((current) =>
        selectedCropId === existingCrop.cropId
          ? {
              ...current,
              cropInput: formatCropOptionLabel({
                cropId: existingCrop.cropId,
                name: cultivar,
                scientificName: speciesScientificName || undefined,
              }),
            }
          : current,
      );
    } catch (error) {
      if (error instanceof SchemaValidationError && error.issues.length > 0) {
        setCropEditMessage('Please fix invalid crop fields before saving.');
        return;
      }

      const message = error instanceof Error ? error.message : 'Failed to save crop.';
      setCropEditMessage(message);
    }
  };

  const startEdit = (batch: Batch) => {
    setEditingBatchId(batch.batchId);
    const startedAt = toLocalDateTimeInput(batch.startedAt) || getLocalDateTimeDefault();
    const meta = (batch.meta ?? {}) as Record<string, unknown>;

    setFormValues({
      cropInput: formatCropOptionLabel({
        cropId: batch.cropId,
        name: cropNames[batch.cropId],
        scientificName: cropScientificNames[batch.cropId],
      }),
      cropCategory: '',
      cropScientificName: '',
      cropAliases: '',
      variety: batch.variety ?? '',
      startedAt,
      seedCountPlanned: batch.seedCountPlanned?.toString() ?? '',
      seedCountGerminated: batch.seedCountGerminated?.toString() ?? '',
      seedCountGerminatedConfidence:
        typeof meta.seedCountGerminatedConfidence === 'string' ? meta.seedCountGerminatedConfidence : '',
      plantCountAlive: batch.plantCountAlive?.toString() ?? '',
      plantCountAliveConfidence: typeof meta.plantCountAliveConfidence === 'string' ? meta.plantCountAliveConfidence : '',
      initialMethod: batch.stage,
    });
    setFormErrors({});
    setSaveMessage(null);
  };

  const resetForm = () => {
    setEditingBatchId(null);
    setIsAddingNewCrop(false);
    setFormValues({
      cropInput: '',
      cropCategory: '',
      cropScientificName: '',
      cropAliases: '',
      variety: '',
      startedAt: getLocalDateTimeDefault(),
      seedCountPlanned: '',
      seedCountGerminated: '',
      seedCountGerminatedConfidence: '',
      plantCountAlive: '',
      plantCountAliveConfidence: '',
      initialMethod: 'sowing',
    });
    setFormErrors({});
  };

  const handleCreateCropInline = async () => {
    const errors: Record<string, string> = {};
    const cropName = formValues.cropInput.trim();

    if (!cropName) {
      errors.cropInput = 'Enter a crop name.';
    }

    if (!formValues.cropCategory.trim()) {
      errors.cropCategory = 'Category is required for new crops.';
    }

    if (Object.keys(errors).length > 0) {
      setFormErrors((current) => ({ ...current, ...errors }));
      return;
    }

    try {
      const appState = await loadAppStateFromIndexedDb();
      if (!appState) {
        setSaveMessage('Unable to create crop because local app state is unavailable.');
        return;
      }

      const createdAt = new Date().toISOString();
      const cropId = createUniqueUserCropId(cropName, appState.crops.map((crop) => crop.cropId));
      const aliases = formValues.cropAliases
        .split(',')
        .map((alias) => alias.trim())
        .filter((alias) => alias.length > 0);

      const speciesScientificName = formValues.cropScientificName.trim();
      const nextState = upsertCropInAppState(appState, {
        cropId,
        name: cropName,
        cultivar: cropName,
        ...(speciesScientificName ? { scientificName: speciesScientificName } : {}),
        species:
          speciesScientificName.length > 0
            ? { commonName: cropName, scientificName: speciesScientificName }
            : undefined,
        category: formValues.cropCategory.trim(),
        aliases: aliases.length > 0 ? aliases : undefined,
        isUserDefined: true,
        createdAt,
        updatedAt: createdAt,
      });

      await saveAppStateToIndexedDb(nextState);
      setCropIds(nextState.crops.map((crop) => crop.cropId));
      setCropNames(Object.fromEntries(nextState.crops.map((crop) => [crop.cropId, crop.name])));
      setCropScientificNames(
        Object.fromEntries(
          nextState.crops.map((crop) => [crop.cropId, getCropSpeciesScientificName(crop)]),
        ),
      );
      setFormValues((current) => ({
        ...current,
        cropInput: formatCropOptionLabel({ cropId, name: cropName, scientificName: formValues.cropScientificName.trim() || undefined }),
        cropCategory: '',
        cropScientificName: '',
        cropAliases: '',
      }));
      setFormErrors((current) => ({
        ...current,
        cropInput: '',
        cropCategory: '',
      }));
      setIsAddingNewCrop(false);
      setSaveMessage('Crop created and selected. Warning: task rules are missing for this crop, but batch operations are still allowed.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create crop.';
      setSaveMessage(message);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSaveMessage(null);
    const errors: Record<string, string> = {};
    const resolvedCropId = resolveCropIdFromInput(formValues.cropInput);

    if (!formValues.cropInput.trim()) {
      errors.cropInput = 'Choose or type a crop.';
    } else if (!resolvedCropId) {
      errors.cropInput = 'Choose an existing crop or create one inline.';
    }

    if (!formValues.startedAt) {
      errors.startedAt = 'Enter a valid start date and time.';
    }

    const trimmedVariety = formValues.variety.trim();
    if (trimmedVariety.length > 120) {
      errors.variety = 'Variety must be 120 characters or fewer.';
    }

    const parseOptionalCount = (value: string, fieldLabel: string): number | null => {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }

      if (!/^\d+$/.test(trimmed)) {
        errors[fieldLabel] = 'Use a whole number greater than or equal to 0.';
        return null;
      }

      const parsed = Number(trimmed);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        errors[fieldLabel] = 'Use a whole number greater than or equal to 0.';
        return null;
      }

      return parsed;
    };

    const seedCountPlanned = parseOptionalCount(formValues.seedCountPlanned, 'seedCountPlanned');
    const seedCountGerminated = parseOptionalCount(formValues.seedCountGerminated, 'seedCountGerminated');
    const plantCountAlive = parseOptionalCount(formValues.plantCountAlive, 'plantCountAlive');

    const parseOptionalConfidence = (value: string, fieldLabel: string): BatchConfidence | null => {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }

      if (CONFIDENCE_OPTIONS.includes(trimmed as BatchConfidence)) {
        return trimmed as BatchConfidence;
      }

      errors[fieldLabel] = 'Choose exact, estimated, unknown, or leave unset.';
      return null;
    };

    const seedCountGerminatedConfidence = parseOptionalConfidence(
      formValues.seedCountGerminatedConfidence,
      'seedCountGerminatedConfidence',
    );
    const plantCountAliveConfidence = parseOptionalConfidence(
      formValues.plantCountAliveConfidence,
      'plantCountAliveConfidence',
    );

    if (formValues.initialMethod !== 'sowing') {
      errors.initialMethod = 'Only sowing can be saved with current state transitions.';
    }

    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }

    try {
      const appState = await loadAppStateFromIndexedDb();

      if (!appState) {
        setSaveMessage('Unable to save because local app state is unavailable.');
        return;
      }

      if (!resolvedCropId) {
        setSaveMessage('Unable to save because crop is not selected.');
        return;
      }

      const existingBatch = editingBatchId
        ? appState.batches.find((batch) => batch.batchId === editingBatchId) ?? null
        : null;
      const startedAt = fromLocalDateTimeInput(formValues.startedAt);
      if (!startedAt) {
        setFormErrors({ ...errors, startedAt: 'Enter a valid start date and time.' });
        return;
      }
      const batchId = existingBatch?.batchId ?? (globalThis.crypto?.randomUUID?.() ?? `batch-${Date.now()}`);
      const existingMeta = ((existingBatch?.meta ?? {}) as Record<string, unknown>) ?? {};
      const nextMeta: Record<string, unknown> = {
        ...existingMeta,
        ...(seedCountGerminatedConfidence !== null ? { seedCountGerminatedConfidence } : {}),
        ...(plantCountAliveConfidence !== null ? { plantCountAliveConfidence } : {}),
      };

      const nextBatch: Batch = {
        batchId,
        cropId: resolvedCropId,
        ...(trimmedVariety ? { variety: trimmedVariety } : {}),
        startedAt,
        stage: existingBatch?.stage ?? 'sowing',
        stageEvents:
          existingBatch?.stageEvents ?? [
            {
              stage: 'sowing',
              occurredAt: startedAt,
            },
          ],
        assignments: existingBatch?.assignments ?? [],
        ...(seedCountPlanned !== null ? { seedCountPlanned } : {}),
        ...(seedCountGerminated !== null ? { seedCountGerminated } : {}),
        ...(plantCountAlive !== null ? { plantCountAlive } : {}),
        ...(Object.keys(nextMeta).length > 0 ? { meta: nextMeta } : {}),
      };

      const nextState = upsertBatchInAppState(appState, nextBatch);
      await saveAppStateToIndexedDb(nextState);
      setBatches(listBatchesFromAppState(nextState));
      setCropIds(nextState.crops.map((crop) => crop.cropId));
      setCropNames(Object.fromEntries(nextState.crops.map((crop) => [crop.cropId, crop.name])));
      setCropScientificNames(
        Object.fromEntries(
          nextState.crops.map((crop) => [crop.cropId, getCropSpeciesScientificName(crop)]),
        ),
      );
      setFormErrors({});
      setSaveMessage(editingBatchId ? 'Batch updated.' : 'Batch created.');
      resetForm();
    } catch (error) {
      if (error instanceof SchemaValidationError && error.issues.length > 0) {
        const issueErrors: Record<string, string> = {};

        for (const issue of error.issues) {
          if (issue.path.includes('/cropId')) {
            issueErrors.cropInput = 'Choose a valid crop.';
          }
          if (issue.path.includes('/startedAt')) {
            issueErrors.startedAt = 'Enter a valid date and time.';
          }
        }

        setFormErrors(issueErrors);
        setSaveMessage('Please fix the highlighted fields.');
        return;
      }

      const message = error instanceof Error ? error.message : 'Failed to save batch.';
      setSaveMessage(message);
    }
  };

  return (
    <section className="batches-page">
      <h2>Batches</h2>

      <div className="batch-filters">
        <label>
          Crop
          <select value={filters.crop} onChange={(event) => updateFilter('crop', event.target.value)}>
            <option value="">All</option>
            {cropOptions.map((crop) => (
              <option key={crop.value} value={crop.value}>
                {crop.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Stage
          <select value={filters.stage} onChange={(event) => updateFilter('stage', event.target.value)}>
            <option value="">All</option>
            {stageOptions.map((stage) => (
              <option key={stage} value={stage}>
                {stage}
              </option>
            ))}
          </select>
        </label>

        <label>
          Bed
          <select value={filters.bed} onChange={(event) => updateFilter('bed', event.target.value)}>
            <option value="">All</option>
            {bedOptions.map((bedId) => (
              <option key={bedId} value={bedId}>
                {bedId}
              </option>
            ))}
          </select>
        </label>

        <label>
          From
          <input type="date" value={filters.from} onChange={(event) => updateFilter('from', event.target.value)} />
        </label>

        <label>
          To
          <input type="date" value={filters.to} onChange={(event) => updateFilter('to', event.target.value)} />
        </label>
      </div>

      <form className="batch-form" onSubmit={(event) => void handleSubmit(event)}>
        <h3>{editingBatchId ? 'Edit batch' : 'Create batch'}</h3>
        <div className="batch-form-grid">
          <label>
            Crop (search or type)
            <input
              list="batch-crop-options"
              value={formValues.cropInput}
              onChange={(event) => setFormValues((current) => ({ ...current, cropInput: event.target.value }))}
              placeholder="Common (Scientific)"
            />
            <datalist id="batch-crop-options">
              {cropInputOptions.map((crop) => (
                <option
                  key={crop.cropId}
                  value={`${crop.label}${cropHasTaskRules[crop.cropId] === false ? ' · No rules yet' : userDefinedCropIds[crop.cropId] ? ' · Custom crop' : ''}`}
                />
              ))}
            </datalist>
            {formErrors.cropInput ? <span className="form-error">{formErrors.cropInput}</span> : null}
          </label>

          {isAddingNewCrop ? (
            <>
              <label>
                New crop category
                <input
                  type="text"
                  value={formValues.cropCategory}
                  onChange={(event) => setFormValues((current) => ({ ...current, cropCategory: event.target.value }))}
                  placeholder="Required"
                />
                {formErrors.cropCategory ? <span className="form-error">{formErrors.cropCategory}</span> : null}
              </label>

              <label>
                New crop scientific name
                <input
                  type="text"
                  value={formValues.cropScientificName}
                  onChange={(event) => setFormValues((current) => ({ ...current, cropScientificName: event.target.value }))}
                  placeholder="Optional"
                />
              </label>

              <label>
                New crop aliases
                <input
                  type="text"
                  value={formValues.cropAliases}
                  onChange={(event) => setFormValues((current) => ({ ...current, cropAliases: event.target.value }))}
                  placeholder="Optional, comma-separated"
                />
              </label>
            </>
          ) : null}

          <label>
            Variety
            <input
              type="text"
              value={formValues.variety}
              onChange={(event) => setFormValues((current) => ({ ...current, variety: event.target.value }))}
            />
            {formErrors.variety ? <span className="form-error">{formErrors.variety}</span> : null}
          </label>

          <label>
            Started at
            <input
              type="datetime-local"
              value={formValues.startedAt}
              onChange={(event) => setFormValues((current) => ({ ...current, startedAt: event.target.value }))}
            />
            {formErrors.startedAt ? <span className="form-error">{formErrors.startedAt}</span> : null}
          </label>

          <label>
            Start method/state
            <select
              value={formValues.initialMethod}
              onChange={(event) => setFormValues((current) => ({ ...current, initialMethod: event.target.value }))}
            >
              <option value="sowing">Sow (supported)</option>
              <option value="pre-sow">Pre-sow (wet paper)</option>
              <option value="sow-in-pot">Sow in pot</option>
              <option value="sow-in-ground">Sow in ground</option>
              <option value="pre-start-cutting">Pre-start from cutting</option>
              <option value="start-cutting-pot">Start cutting in pot</option>
              <option value="start-cutting-ground">Start cutting in ground</option>
            </select>
            {formErrors.initialMethod ? <span className="form-error">{formErrors.initialMethod}</span> : null}
          </label>

          <label>
            Seed count planned
            <input
              type="number"
              min="0"
              step="1"
              value={formValues.seedCountPlanned}
              onChange={(event) => setFormValues((current) => ({ ...current, seedCountPlanned: event.target.value }))}
            />
            {formErrors.seedCountPlanned ? <span className="form-error">{formErrors.seedCountPlanned}</span> : null}
          </label>

          <label>
            Seed count germinated
            <input
              type="number"
              min="0"
              step="1"
              value={formValues.seedCountGerminated}
              onChange={(event) => setFormValues((current) => ({ ...current, seedCountGerminated: event.target.value }))}
            />
            {formErrors.seedCountGerminated ? <span className="form-error">{formErrors.seedCountGerminated}</span> : null}
          </label>

          <label>
            Seed germinated confidence
            <select
              value={formValues.seedCountGerminatedConfidence}
              onChange={(event) => setFormValues((current) => ({ ...current, seedCountGerminatedConfidence: event.target.value }))}
            >
              <option value="">Unset</option>
              <option value="exact">exact</option>
              <option value="estimated">estimated</option>
              <option value="unknown">unknown</option>
            </select>
            {formErrors.seedCountGerminatedConfidence ? <span className="form-error">{formErrors.seedCountGerminatedConfidence}</span> : null}
          </label>

          <label>
            Plant count alive
            <input
              type="number"
              min="0"
              step="1"
              value={formValues.plantCountAlive}
              onChange={(event) => setFormValues((current) => ({ ...current, plantCountAlive: event.target.value }))}
            />
            {formErrors.plantCountAlive ? <span className="form-error">{formErrors.plantCountAlive}</span> : null}
          </label>

          <label>
            Plant alive confidence
            <select
              value={formValues.plantCountAliveConfidence}
              onChange={(event) => setFormValues((current) => ({ ...current, plantCountAliveConfidence: event.target.value }))}
            >
              <option value="">Unset</option>
              <option value="exact">exact</option>
              <option value="estimated">estimated</option>
              <option value="unknown">unknown</option>
            </select>
            {formErrors.plantCountAliveConfidence ? <span className="form-error">{formErrors.plantCountAliveConfidence}</span> : null}
          </label>
        </div>
        <div className="batch-form-actions">
          {isAddingNewCrop ? (
            <>
              <button type="button" onClick={() => setIsAddingNewCrop(false)}>
                Cancel new crop
              </button>
              <button type="button" onClick={() => void handleCreateCropInline()}>
                Create crop
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setIsAddingNewCrop(true)}>
              Add new crop
            </button>
          )}
        </div>
        <p className="batch-form-note">
          Create new crops inline, then save the batch. Non-sowing start transitions are still planning-only.
        </p>
        {selectedCropRuleWarning ? <p className="batch-stage-warning">{selectedCropRuleWarning}</p> : null}
        <div className="batch-form-actions">
          <button type="submit">{editingBatchId ? 'Save changes' : 'Create batch'}</button>
          {editingBatchId ? (
            <button type="button" onClick={resetForm}>
              Cancel edit
            </button>
          ) : null}
          {saveMessage ? <p className="batch-form-message">{saveMessage}</p> : null}
        </div>
      </form>


      <form className="batch-form" onSubmit={(event) => void handleCropEditSubmit(event)}>
        <h3>Edit crop cultivar metadata</h3>
        <div className="batch-form-grid">
          <label>
            Crop
            <select value={editingCropId} onChange={(event) => setEditingCropId(event.target.value)}>
              {selectableCrops.map((crop) => (
                <option key={crop.cropId} value={crop.cropId}>
                  {crop.label}
                </option>
              ))}
            </select>
            {cropEditErrors.cropId ? <span className="form-error">{cropEditErrors.cropId}</span> : null}
          </label>

          <label>
            Crop ID (immutable)
            <input type="text" value={editingCropId} readOnly disabled />
          </label>

          <label>
            Cultivar / variety
            <input
              type="text"
              value={cropEditValues.cultivar}
              onChange={(event) => setCropEditValues((current) => ({ ...current, cultivar: event.target.value }))}
            />
            {cropEditErrors.cultivar ? <span className="form-error">{cropEditErrors.cultivar}</span> : null}
          </label>

          <label>
            Species common name
            <input
              type="text"
              value={cropEditValues.speciesCommonName}
              onChange={(event) => setCropEditValues((current) => ({ ...current, speciesCommonName: event.target.value }))}
            />
          </label>

          <label>
            Species scientific name
            <input
              type="text"
              value={cropEditValues.speciesScientificName}
              onChange={(event) => setCropEditValues((current) => ({ ...current, speciesScientificName: event.target.value }))}
            />
            {cropEditErrors.speciesScientificName ? <span className="form-error">{cropEditErrors.speciesScientificName}</span> : null}
          </label>

          <label>
            Species ID
            <input
              type="text"
              value={cropEditValues.speciesId}
              onChange={(event) => setCropEditValues((current) => ({ ...current, speciesId: event.target.value }))}
            />
            {cropEditErrors.speciesId ? <span className="form-error">{cropEditErrors.speciesId}</span> : null}
          </label>

          <label>
            Aliases (comma-separated)
            <input
              type="text"
              value={cropEditValues.aliases}
              onChange={(event) => setCropEditValues((current) => ({ ...current, aliases: event.target.value }))}
            />
          </label>

          <label>
            Varieties (comma-separated)
            <input
              type="text"
              value={cropEditValues.varieties}
              onChange={(event) => setCropEditValues((current) => ({ ...current, varieties: event.target.value }))}
            />
          </label>

          <label>
            Spacing metadata
            <input
              type="text"
              value={cropEditValues.spacing}
              onChange={(event) => setCropEditValues((current) => ({ ...current, spacing: event.target.value }))}
            />
          </label>

          <label>
            Sowing / transplant metadata
            <input
              type="text"
              value={cropEditValues.sowingTransplant}
              onChange={(event) => setCropEditValues((current) => ({ ...current, sowingTransplant: event.target.value }))}
            />
          </label>

          <label>
            Lifecycle metadata
            <input
              type="text"
              value={cropEditValues.lifecycle}
              onChange={(event) => setCropEditValues((current) => ({ ...current, lifecycle: event.target.value }))}
            />
          </label>

          <label>
            Tags (comma-separated)
            <input
              type="text"
              value={cropEditValues.tags}
              onChange={(event) => setCropEditValues((current) => ({ ...current, tags: event.target.value }))}
            />
          </label>

          <label>
            Notes
            <textarea
              value={cropEditValues.notes}
              onChange={(event) => setCropEditValues((current) => ({ ...current, notes: event.target.value }))}
              rows={3}
            />
            {cropEditErrors.notes ? <span className="form-error">{cropEditErrors.notes}</span> : null}
          </label>
        </div>
        <div className="batch-form-actions">
          <button type="submit">Save crop changes</button>
          {cropEditMessage ? <p className="batch-form-message">{cropEditMessage}</p> : null}
        </div>
      </form>

      {isLoading ? <p className="batch-empty-state">Loading batches…</p> : null}

      {!isLoading ? (
        <ul className="batch-list">
          {filteredBatches.map((batch) => (
            <li key={batch.batchId}>
              <Link to={`/batches/${batch.batchId}`} className="batch-item-link">
                <div>
                  <p className="batch-item-title">
                    <CropIdentityLabel
                      cropId={batch.cropId}
                      name={cropNames[batch.cropId]}
                      scientificName={cropScientificNames[batch.cropId]}
                    />
                    <span className="crop-capability-badges" aria-label="Crop capabilities">
                      {getCropCapabilityLabels({
                        isUserDefined: userDefinedCropIds[batch.cropId],
                        hasTaskRules: cropHasTaskRules[batch.cropId],
                      }).map((label) => (
                        <span key={`${batch.batchId}-${label}`} className="crop-capability-badge">
                          {label}
                        </span>
                      ))}
                    </span>
                  </p>
                  <p className="batch-item-meta">
                    Batch {batch.batchId} · Bed {getDerivedBedId(batch) ?? 'Unassigned'} · Started{' '}
                    {new Date(batch.startedAt).toLocaleString()}
                    {batch.variety ? ` · Variety ${batch.variety}` : ''}
                  </p>
                </div>
                <span className="batch-stage-badge">{batch.stage}</span>
              </Link>
              <button type="button" className="batch-edit-button" onClick={() => startEdit(batch)}>
                Edit
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {!isLoading && filteredBatches.length === 0 ? (
        <p className="batch-empty-state">No batches match these filters.</p>
      ) : null}
    </section>
  );
}

type TimelineEditState = { occurredAt: string; confidence: string; error?: string | undefined; isSaving?: boolean | undefined };

function BatchDetailPage() {
  const { batchId } = useParams();
  const [isLoading, setIsLoading] = useState(true);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [cropName, setCropName] = useState<string | null>(null);
  const [cropScientificName, setCropScientificName] = useState<string | null>(null);
  const [cropHasTaskRules, setCropHasTaskRules] = useState<boolean | undefined>(undefined);
  const [cropIsUserDefined, setCropIsUserDefined] = useState<boolean | undefined>(undefined);
  const [actionDates, setActionDates] = useState<Record<string, string>>({});
  const [stageActionMessage, setStageActionMessage] = useState<string | null>(null);
  const [timelineEdits, setTimelineEdits] = useState<
    Record<string, TimelineEditState>
  >({});
  const [timelineMessage, setTimelineMessage] = useState<string | null>(null);
  const [removeFromBedDate, setRemoveFromBedDate] = useState(getLocalDateTimeDefault());
  const [removeFromBedMessage, setRemoveFromBedMessage] = useState<string | null>(null);
  const [isSavingRemoveFromBed, setIsSavingRemoveFromBed] = useState(false);
  const [isSavingStageAction, setIsSavingStageAction] = useState(false);
  const [photoActionMessage, setPhotoActionMessage] = useState<string | null>(null);
  const [isSavingPhoto, setIsSavingPhoto] = useState(false);
  const [expandedPhotoIds, setExpandedPhotoIds] = useState<Record<string, boolean>>({});
  const [photoPreviewUrls, setPhotoPreviewUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    const load = async () => {
      if (!batchId) {
        setBatch(null);
        setCropName(null);
        setCropScientificName(null);
        setCropHasTaskRules(undefined);
        setCropIsUserDefined(undefined);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      const appState = await loadAppStateFromIndexedDb();

      if (!appState) {
        setBatch(null);
        setCropName(null);
        setCropScientificName(null);
        setCropHasTaskRules(undefined);
        setCropIsUserDefined(undefined);
        setIsLoading(false);
        return;
      }

      const nextBatch = appState.batches.find((candidate) => candidate.batchId === batchId) ?? null;
      setBatch(nextBatch);

      if (!nextBatch) {
        setCropName(null);
        setCropScientificName(null);
        setCropHasTaskRules(undefined);
        setCropIsUserDefined(undefined);
        setIsLoading(false);
        return;
      }

      const crop = appState.crops.find((candidate) => candidate.cropId === nextBatch.cropId);
      setCropName(crop?.name ?? null);
      setCropScientificName(crop ? getCropSpeciesScientificName(crop) || null : null);
      const taskRules = (crop as { taskRules?: unknown } | undefined)?.taskRules;
      setCropHasTaskRules(Array.isArray(taskRules) && taskRules.length > 0);
      setCropIsUserDefined((crop as { isUserDefined?: unknown } | undefined)?.isUserDefined === true);
      const dateDefault = getLocalDateTimeDefault();
      setActionDates({
        transplant: dateDefault,
        harvest: dateDefault,
        failed: dateDefault,
        ended: dateDefault,
      });
      setStageActionMessage(null);
      setTimelineEdits({});
      setTimelineMessage(null);
      setRemoveFromBedDate(dateDefault);
      setRemoveFromBedMessage(null);
      setPhotoActionMessage(null);
      setExpandedPhotoIds({});
      setIsLoading(false);
    };

    void load();
  }, [batchId]);

  const orderedStageEvents = useMemo(() => {
    if (!batch) {
      return [];
    }

    return batch.stageEvents
      .map((event, originalIndex) => ({ event, originalIndex }))
      .sort((left, right) => {
        const timestampCompare = left.event.occurredAt.localeCompare(right.event.occurredAt);
        if (timestampCompare !== 0) {
          return timestampCompare;
        }

        return left.originalIndex - right.originalIndex;
      });
  }, [batch]);

  const countConfidence = useMemo(() => {
    if (!batch) {
      return {};
    }

    const meta = (batch.meta ?? {}) as Record<string, unknown>;

    return {
      seedCountGerminated: typeof meta.seedCountGerminatedConfidence === 'string' ? meta.seedCountGerminatedConfidence : null,
      plantCountAlive: typeof meta.plantCountAliveConfidence === 'string' ? meta.plantCountAliveConfidence : null,
    };
  }, [batch]);

  const assignmentHistory = useMemo(() => {
    if (!batch) {
      return [];
    }

    return [...batch.assignments].sort((left, right) => left.assignedAt.localeCompare(right.assignedAt));
  }, [batch]);

  const nextStageActions = useMemo(() => {
    if (!batch) {
      return [];
    }

    return ['transplant', 'harvest', 'failed', 'ended'].filter((stage) => canTransition(batch.stage, stage));
  }, [batch]);

  const orderedPhotos = useMemo(() => {
    if (!batch) {
      return [];
    }

    const photos = ((batch as BatchWithPhotos).photos ?? []).map((photo, index) => ({ photo, index }));
    return photos
      .sort((left, right) => {
        const leftTime = left.photo.capturedAt ? Date.parse(left.photo.capturedAt) : NaN;
        const rightTime = right.photo.capturedAt ? Date.parse(right.photo.capturedAt) : NaN;
        const leftValid = Number.isFinite(leftTime);
        const rightValid = Number.isFinite(rightTime);

        if (leftValid && rightValid && leftTime !== rightTime) {
          return leftTime - rightTime;
        }

        if (leftValid !== rightValid) {
          return leftValid ? -1 : 1;
        }

        return left.index - right.index;
      })
      .map(({ photo }) => photo);
  }, [batch]);

  const latestStageEventAt = useMemo(() => {
    if (!batch || batch.stageEvents.length === 0) {
      return null;
    }

    return batch.stageEvents.reduce(
      (latest, event) => (event.occurredAt > latest ? event.occurredAt : latest),
      batch.stageEvents[0]!.occurredAt,
    );
  }, [batch]);

  const handleStageAction = async (nextStage: string) => {
    if (!batch || !batchId) {
      return;
    }

    const inputValue = actionDates[nextStage] ?? getLocalDateTimeDefault();
    if (!inputValue) {
      setStageActionMessage('Enter a valid date and time before applying a stage action.');
      return;
    }

    const occurredAt = fromLocalDateTimeInput(inputValue);
    if (!occurredAt) {
      setStageActionMessage('Enter a valid date and time before applying a stage action.');
      return;
    }
    const transition = applyStageEvent(batch, { stage: nextStage, occurredAt });
    if (!transition.ok) {
      setStageActionMessage(`Unable to apply stage event: ${transition.reason}.`);
      return;
    }

    setIsSavingStageAction(true);

    try {
      const appState = await loadAppStateFromIndexedDb();
      if (!appState) {
        setStageActionMessage('Unable to save because local app state is unavailable.');
        return;
      }

      const nextState = upsertBatchInAppState(appState, transition.batch);
      await saveAppStateToIndexedDb(nextState);
      const refreshedBatch = nextState.batches.find((candidate) => candidate.batchId === batchId) ?? null;
      setBatch(refreshedBatch);
      const dateDefault = getLocalDateTimeDefault();
      setActionDates({
        transplant: dateDefault,
        harvest: dateDefault,
        failed: dateDefault,
        ended: dateDefault,
      });

      if (latestStageEventAt && occurredAt < latestStageEventAt) {
        setStageActionMessage('Warning: this stage event is earlier than newer timeline events and was saved retroactively.');
      } else {
        setStageActionMessage(null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save stage action.';
      setStageActionMessage(message);
    } finally {
      setIsSavingStageAction(false);
    }
  };


  const handleTimelineEditSave = async (originalIndex: number) => {
    if (!batch || !batchId) {
      return;
    }

    const key = String(originalIndex);
    const edit = timelineEdits[key];
    if (!edit) {
      return;
    }

    const occurredAt = fromLocalDateTimeInput(edit.occurredAt);
    const confidence = edit.confidence.trim();
    const validConfidence = confidence === '' || CONFIDENCE_OPTIONS.includes(confidence as BatchConfidence);
    const confidenceValue = confidence === '' ? null : (confidence as BatchConfidence);

    if (!occurredAt) {
      setTimelineEdits((current) => ({
        ...current,
        [key]: { ...(current[key] ?? edit), error: 'Enter a valid date and time.' },
      }));
      return;
    }

    if (!validConfidence) {
      setTimelineEdits((current) => ({
        ...current,
        [key]: { ...(current[key] ?? edit), error: 'Choose exact, estimated, unknown, or leave unset.' },
      }));
      return;
    }

    setTimelineEdits((current) => ({ ...current, [key]: { ...(current[key] ?? edit), error: '', isSaving: true } }));

    try {
      const appState = await loadAppStateFromIndexedDb();
      if (!appState) {
        setTimelineMessage('Unable to save because local app state is unavailable.');
        setTimelineEdits((current) => ({ ...current, [key]: { ...(current[key] ?? edit), isSaving: false } }));
        return;
      }

      const nextStageEvents = batch.stageEvents.map((event, index) => {
        if (index !== originalIndex) {
          return event;
        }

        const nextMeta = {
          ...((event.meta ?? {}) as Record<string, unknown>),
          ...(confidenceValue ? { confidence: confidenceValue } : {}),
        };

        if (!confidence) {
          delete nextMeta.confidence;
        }

        return {
          ...event,
          occurredAt,
          ...(Object.keys(nextMeta).length > 0 ? { meta: nextMeta } : {}),
        };
      });

      const nextBatch: Batch = {
        ...batch,
        stageEvents: nextStageEvents,
      };

      const nextState = upsertBatchInAppState(appState, nextBatch);
      await saveAppStateToIndexedDb(nextState);
      const refreshedBatch = nextState.batches.find((candidate) => candidate.batchId === batchId) ?? null;
      setBatch(refreshedBatch);
      setTimelineMessage(
        latestStageEventAt && occurredAt < latestStageEventAt
          ? 'Warning: this stage event is earlier than newer timeline events and was saved retroactively.'
          : null,
      );
      setTimelineEdits((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save stage timeline event.';
      setTimelineMessage(message);
      setTimelineEdits((current) => ({ ...current, [key]: { ...(current[key] ?? edit), isSaving: false } }));
    }
  };

  const handleRemoveFromBed = async () => {
    if (!batch || !batchId) {
      return;
    }

    if (!removeFromBedDate) {
      setRemoveFromBedMessage('Enter a valid date and time before removing from bed.');
      return;
    }

    const endDate = fromLocalDateTimeInput(removeFromBedDate);
    if (!endDate) {
      setRemoveFromBedMessage('Enter a valid date and time before removing from bed.');
      return;
    }
    const nextBatch = removeBatchFromBed(batch, endDate);

    setIsSavingRemoveFromBed(true);

    try {
      const appState = await loadAppStateFromIndexedDb();
      if (!appState) {
        setRemoveFromBedMessage('Unable to save because local app state is unavailable.');
        return;
      }

      const nextState = upsertBatchInAppState(appState, nextBatch);
      await saveAppStateToIndexedDb(nextState);
      const refreshedBatch = nextState.batches.find((candidate) => candidate.batchId === batchId) ?? null;
      setBatch(refreshedBatch);
      setRemoveFromBedMessage(nextBatch === batch ? 'Batch is already unassigned for that date.' : 'Batch removed from bed.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to remove batch from bed.';
      setRemoveFromBedMessage(message);
    } finally {
      setIsSavingRemoveFromBed(false);
    }
  };

  const saveBatchPhotos = async (nextPhotos: BatchPhoto[]) => {
    if (!batchId || !batch) {
      return;
    }

    const appState = await loadAppStateFromIndexedDb();
    if (!appState) {
      setPhotoActionMessage('Unable to save because local app state is unavailable.');
      return;
    }

    const nextBatch: BatchWithPhotos = { ...(batch as BatchWithPhotos), photos: nextPhotos };
    const nextState = upsertBatchInAppState(appState, nextBatch as Batch);
    await saveAppStateToIndexedDb(nextState);
    const refreshedBatch = nextState.batches.find((candidate) => candidate.batchId === batchId) ?? null;
    setBatch(refreshedBatch);
  };

  const handlePhotoUpload = async (event: FormEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];

    if (!file || !batch) {
      return;
    }

    const fileNameLower = file.name.toLowerCase();
    const mimeLower = file.type.toLowerCase();
    const looksLikeImage = mimeLower.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|heic|heif)$/i.test(file.name);

    if (!looksLikeImage) {
      setPhotoActionMessage('Please choose an image file.');
      input.value = '';
      return;
    }

    const photoId = `photo-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const isLikelyUnsupported = mimeLower.includes('heic') || mimeLower.includes('heif') || /\.(heic|heif)$/i.test(fileNameLower);
    const nextPhoto: BatchPhoto = {
      id: photoId,
      storageRef: photoId,
      ...(file.type ? { contentType: file.type } : {}),
      filename: file.name,
      capturedAt: new Date().toISOString(),
      caption: file.name,
    };

    setIsSavingPhoto(true);
    try {
      await savePhotoBlobToIndexedDb(photoId, file);
      const nextPhotos = [...((batch as BatchWithPhotos).photos ?? []), nextPhoto];
      await saveBatchPhotos(nextPhotos);
      setPhotoActionMessage(
        isLikelyUnsupported
          ? 'Photo saved. HEIC/HEIF preview may be unavailable in this browser.'
          : 'Photo saved.',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save photo.';
      setPhotoActionMessage(message);
    } finally {
      input.value = '';
      setIsSavingPhoto(false);
    }
  };

  const handleCaptionChange = async (photoId: string, caption: string) => {
    if (!batch) {
      return;
    }

    const currentPhotos = (batch as BatchWithPhotos).photos ?? [];
    const nextPhotos = currentPhotos.map((photo) => (photo.id === photoId ? { ...photo, caption } : photo));
    try {
      await saveBatchPhotos(nextPhotos);
      setPhotoActionMessage(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save caption.';
      setPhotoActionMessage(message);
    }
  };

  const togglePhotoExpanded = (photoId: string, expanded: boolean) => {
    setExpandedPhotoIds((current) => ({ ...current, [photoId]: expanded }));
  };

  useEffect(() => {
    let isCancelled = false;

    const loadPreviews = async () => {
      for (const photo of orderedPhotos) {
        if (!expandedPhotoIds[photo.id] || photoPreviewUrls[photo.id]) {
          continue;
        }

        const contentTypeLower = (photo.contentType ?? '').toLowerCase();
        const fileNameLower = (photo.filename ?? '').toLowerCase();
        const unsupported = contentTypeLower.includes('heic') || contentTypeLower.includes('heif') || /\.(heic|heif)$/i.test(fileNameLower);
        if (unsupported) {
          continue;
        }

        const blob = await loadPhotoBlobFromIndexedDb(photo.storageRef);
        if (!blob || isCancelled) {
          continue;
        }

        const url = URL.createObjectURL(blob);
        if (isCancelled) {
          URL.revokeObjectURL(url);
          continue;
        }

        setPhotoPreviewUrls((current) => {
          if (current[photo.id]) {
            URL.revokeObjectURL(url);
            return current;
          }
          return { ...current, [photo.id]: url };
        });
      }
    };

    void loadPreviews();

    return () => {
      isCancelled = true;
    };
  }, [orderedPhotos, expandedPhotoIds, photoPreviewUrls]);

  useEffect(
    () => () => {
      Object.values(photoPreviewUrls).forEach((url) => URL.revokeObjectURL(url));
    },
    [photoPreviewUrls],
  );

  if (isLoading) {
    return <p className="batch-detail-empty">Loading batch…</p>;
  }

  if (!batch) {
    return (
      <section className="batch-detail-page">
        <h2>Batch not found</h2>
        <p className="batch-detail-empty">No batch matches ID {batchId ?? 'unknown'}.</p>
        <Link to="/batches" className="batch-detail-back-link">
          Back to batches
        </Link>
      </section>
    );
  }

  return (
    <section className="batch-detail-page">
      <Link to="/batches" className="batch-detail-back-link">
        ← Back to batches
      </Link>
      <h2>
        <CropIdentityLabel cropId={batch.cropId} name={cropName ?? undefined} scientificName={cropScientificName ?? undefined} />
      </h2>
      <p className="crop-capability-badges" aria-label="Crop capabilities">
        {getCropCapabilityLabels({ isUserDefined: cropIsUserDefined, hasTaskRules: cropHasTaskRules }).map((label) => (
          <span key={`detail-${label}`} className="crop-capability-badge">
            {label}
          </span>
        ))}
      </p>

      <div className="batch-detail-grid">
        <article className="batch-detail-card">
          <h3>Metadata</h3>
          <dl>
            <div>
              <dt>Batch ID</dt>
              <dd>{batch.batchId}</dd>
            </div>
            <div>
              <dt>Crop ID</dt>
              <dd>{batch.cropId}</dd>
            </div>
            <div>
              <dt>Stage</dt>
              <dd>{batch.stage}</dd>
            </div>
            {batch.variety ? (
              <div>
                <dt>Variety</dt>
                <dd>{batch.variety}</dd>
              </div>
            ) : null}
            <div>
              <dt>Started</dt>
              <dd>{new Date(batch.startedAt).toLocaleString()}</dd>
            </div>
          </dl>
        </article>

        <article className="batch-detail-card">
          <h3>Counts</h3>
          <dl>
            <div>
              <dt>Stage events</dt>
              <dd>{batch.stageEvents.length}</dd>
            </div>
            <div>
              <dt>Assignments</dt>
              <dd>{batch.assignments.length}</dd>
            </div>
            <div>
              <dt>Current bed</dt>
              <dd>{getDerivedBedId(batch) ?? 'Unassigned'}</dd>
            </div>
            <div>
              <dt>Seed count planned</dt>
              <dd>{batch.seedCountPlanned ?? '—'}</dd>
            </div>
            <div>
              <dt>Seed count germinated</dt>
              <dd>
                {batch.seedCountGerminated ?? '—'}
                {countConfidence.seedCountGerminated ? ` (${countConfidence.seedCountGerminated})` : ''}
              </dd>
            </div>
            <div>
              <dt>Plant count alive</dt>
              <dd>
                {batch.plantCountAlive ?? '—'}
                {countConfidence.plantCountAlive ? ` (${countConfidence.plantCountAlive})` : ''}
              </dd>
            </div>
          </dl>
        </article>
      </div>

      <article className="batch-detail-card">
        <h3>Next stage actions</h3>
        {nextStageActions.length === 0 ? (
          <p className="batch-detail-empty">No valid next transitions from {batch.stage}.</p>
        ) : (
          <div className="batch-next-actions">
            {nextStageActions.map((stage) => (
              <div key={stage} className="batch-next-action-row">
                <span className="batch-detail-pill">{stage}</span>
                <input
                  type="datetime-local"
                  value={actionDates[stage] ?? ''}
                  onChange={(event) =>
                    setActionDates((current) => ({
                      ...current,
                      [stage]: event.target.value,
                    }))
                  }
                />
                <button type="button" onClick={() => void handleStageAction(stage)} disabled={isSavingStageAction}>
                  Apply
                </button>
              </div>
            ))}
          </div>
        )}
        {stageActionMessage ? <p className="batch-stage-warning">{stageActionMessage}</p> : null}
      </article>

      <article className="batch-detail-card">
        <h3>Stage timeline</h3>
        {orderedStageEvents.length === 0 ? (
          <p className="batch-detail-empty">No stage events yet.</p>
        ) : (
          <ol className="batch-detail-list">
            {orderedStageEvents.map(({ event, originalIndex }) => {
              const eventMeta = (event.meta as { confidence?: string } | undefined) ?? {};
              const key = String(originalIndex);
              const edit = timelineEdits[key];
              const currentConfidence = edit?.confidence ?? (typeof eventMeta.confidence === 'string' ? eventMeta.confidence : '');
              const currentOccurredAt = edit?.occurredAt ?? toLocalDateTimeInput(event.occurredAt);

              return (
                <li key={`${event.occurredAt}-${event.stage}-${originalIndex}`} className="batch-timeline-row">
                  <span className="batch-detail-pill">{event.stage}</span>
                  <span>{new Date(event.occurredAt).toLocaleString()}</span>
                  {eventMeta.confidence ? <span className="batch-detail-muted">confidence: {eventMeta.confidence}</span> : null}
                  <div className="batch-timeline-edit-row">
                    <input
                      type="datetime-local"
                      value={currentOccurredAt}
                      onChange={(inputEvent) =>
                        setTimelineEdits((current) => ({
                          ...current,
                          [key]: {
                            occurredAt: inputEvent.target.value,
                            confidence: currentConfidence,
                            error: '',
                            isSaving: current[key]?.isSaving ?? false,
                          },
                        }))
                      }
                    />
                    <select
                      value={currentConfidence}
                      onChange={(inputEvent) =>
                        setTimelineEdits((current) => ({
                          ...current,
                          [key]: {
                            occurredAt: currentOccurredAt,
                            confidence: inputEvent.target.value,
                            error: '',
                            isSaving: current[key]?.isSaving ?? false,
                          },
                        }))
                      }
                    >
                      <option value="">Unset</option>
                      <option value="exact">exact</option>
                      <option value="estimated">estimated</option>
                      <option value="unknown">unknown</option>
                    </select>
                    <button type="button" onClick={() => void handleTimelineEditSave(originalIndex)} disabled={edit?.isSaving === true}>
                      Save
                    </button>
                  </div>
                  {edit?.error ? <span className="form-error">{edit.error}</span> : null}
                </li>
              );
            })}
          </ol>
        )}
        {timelineMessage ? <p className="batch-stage-warning">{timelineMessage}</p> : null}
      </article>

      <article className="batch-detail-card">
        <h3>Bed assignments</h3>
        <p className="batch-detail-current-bed">Current: {getDerivedBedId(batch) ?? 'Unassigned'}</p>
        <div className="batch-next-action-row">
          <span className="batch-detail-pill">remove</span>
          <input
            type="datetime-local"
            value={removeFromBedDate}
            onChange={(event) => setRemoveFromBedDate(event.target.value)}
          />
          <button type="button" onClick={() => void handleRemoveFromBed()} disabled={isSavingRemoveFromBed}>
            Remove from bed
          </button>
        </div>
        {removeFromBedMessage ? <p className="batch-stage-warning">{removeFromBedMessage}</p> : null}
        {assignmentHistory.length === 0 ? (
          <p className="batch-detail-empty">No bed assignment history.</p>
        ) : (
          <ol className="batch-detail-list">
            {assignmentHistory.map((assignment, index) => (
              <li key={`${assignment.assignedAt}-${assignment.bedId}-${index}`}>
                <span className="batch-detail-pill">{assignment.bedId}</span>
                <span>{new Date(assignment.assignedAt).toLocaleString()}</span>
              </li>
            ))}
          </ol>
        )}
      </article>

      <article className="batch-detail-card">
        <h3>Photos</h3>
        <label className="batch-photo-upload-row">
          <span>Add photo</span>
          <input type="file" accept="image/*,.heic,.heif" onChange={(event) => void handlePhotoUpload(event)} disabled={isSavingPhoto} />
        </label>
        {photoActionMessage ? <p className="batch-photo-message">{photoActionMessage}</p> : null}
        {orderedPhotos.length === 0 ? (
          <p className="batch-detail-empty">No photos yet.</p>
        ) : (
          <ol className="batch-photo-list">
            {orderedPhotos.map((photo, index) => {
              const contentTypeLower = (photo.contentType ?? '').toLowerCase();
              const fileNameLower = (photo.filename ?? '').toLowerCase();
              const unsupported = contentTypeLower.includes('heic') || contentTypeLower.includes('heif') || /\.(heic|heif)$/i.test(fileNameLower);
              const previewUrl = photoPreviewUrls[photo.id];

              return (
                <li key={photo.id} className="batch-photo-item">
                  <details onToggle={(event) => togglePhotoExpanded(photo.id, event.currentTarget.open)}>
                    <summary>
                      <span>{photo.filename ?? `Photo ${index + 1}`}</span>
                      <span>{photo.capturedAt ? new Date(photo.capturedAt).toLocaleString() : 'No date'}</span>
                    </summary>
                    <div className="batch-photo-content">
                      {unsupported ? (
                        <p className="batch-photo-unsupported">Preview unavailable for HEIC/HEIF on this browser.</p>
                      ) : previewUrl ? (
                        <img src={previewUrl} alt={photo.caption || photo.filename || `Batch photo ${index + 1}`} loading="lazy" />
                      ) : (
                        <p className="batch-detail-empty">Expand to load preview…</p>
                      )}
                      <label>
                        Caption
                        <input
                          type="text"
                          value={photo.caption ?? ''}
                          onChange={(event) => {
                            const caption = event.target.value;
                            setBatch((current) => {
                              if (!current) {
                                return current;
                              }
                              const currentPhotos = ((current as BatchWithPhotos).photos ?? []).map((candidate) =>
                                candidate.id === photo.id ? { ...candidate, caption } : candidate,
                              );
                              return { ...(current as BatchWithPhotos), photos: currentPhotos } as Batch;
                            });
                          }}
                          onBlur={(event) => void handleCaptionChange(photo.id, event.target.value)}
                        />
                      </label>
                    </div>
                  </details>
                </li>
              );
            })}
          </ol>
        )}
      </article>
    </section>
  );
}

type NutritionMetric = {
  key: string;
  label: string;
  unit: 'kcal' | 'g' | 'mg' | 'mcg' | 'IU';
};

type NutritionTarget = {
  daily: number;
  label: string;
};

type NutritionSummary = {
  totals: Record<string, number>;
  excludedCrops: string[];
  confidenceNotes: string[];
  flags: NutritionFlag[];
};

type NutritionFlag = {
  severity: 'high' | 'medium' | 'info';
  title: string;
  rationale: string;
  guidanceText: string;
};

const NUTRITION_METRICS: NutritionMetric[] = [
  { key: 'kcal', label: 'Calories', unit: 'kcal' },
  { key: 'protein', label: 'Protein', unit: 'g' },
  { key: 'fat', label: 'Fat', unit: 'g' },
  { key: 'fiber', label: 'Fiber', unit: 'g' },
  { key: 'vitamin_c', label: 'Vitamin C', unit: 'mg' },
  { key: 'vitamin_a', label: 'Vitamin A', unit: 'mcg' },
  { key: 'vitamin_k', label: 'Vitamin K', unit: 'mcg' },
];

const NUTRITION_FLAGS: NutritionFlag[] = [
  {
    severity: 'high',
    title: 'Vitamin B12 coverage gap',
    rationale: 'Plant-based crop plans do not provide a reliable B12 source.',
    guidanceText: 'Informational only: plan for a dependable B12 supplement path for vegan nutrition coverage.',
  },
  {
    severity: 'medium',
    title: 'Iodine planning check',
    rationale: 'Iodine intake can vary if crops are the primary food source.',
    guidanceText: 'Informational only: consider iodized salt or seaweed choices with caution as part of planning.',
  },
  {
    severity: 'info',
    title: 'Omega-3 planning check',
    rationale: 'EPA/DHA are limited in crops, so omega-3 planning usually depends on ALA food patterns.',
    guidanceText: 'Informational only: consider ALA-focused foods such as flax, chia, and walnuts in rotation plans.',
  },
];

const NUTRITION_TARGETS: Record<string, NutritionTarget> = {
  kcal: { daily: 2000, label: 'Generic target 2000 kcal/day' },
  protein: { daily: 50, label: 'Generic target 50 g/day' },
  fat: { daily: 70, label: 'Generic target 70 g/day' },
  vitamin_c: { daily: 90, label: 'Generic target 90 mg/day' },
  vitamin_a: { daily: 900, label: 'Generic target 900 mcg/day' },
  vitamin_k: { daily: 120, label: 'Generic target 120 mcg/day' },
};

const toYieldGrams = (plan: CropPlan): number | null => {
  if (!plan.expectedYield || !Number.isFinite(plan.expectedYield.amount) || plan.expectedYield.amount <= 0) {
    return null;
  }

  if (plan.expectedYield.unit === 'kg') {
    return plan.expectedYield.amount * 1_000;
  }

  if (plan.expectedYield.unit === 'g') {
    return plan.expectedYield.amount;
  }

  return null;
};

const getNutritionPlanLabel = (plan: CropPlan, crop?: Crop): string => {
  const baseName = crop?.name?.trim() ? crop.name : plan.cropId;
  return `${baseName} (${plan.planId})`;
};

const summarizeNutrition = (cropPlans: CropPlan[], crops: Crop[]): NutritionSummary => {
  const cropById = new Map(crops.map((crop) => [crop.cropId, crop]));
  const totals = Object.fromEntries(NUTRITION_METRICS.map((metric) => [metric.key, 0])) as Record<string, number>;
  const excluded = new Set<string>();
  const confidence = new Set<string>();

  for (const plan of cropPlans) {
    const crop = cropById.get(plan.cropId);
    const planLabel = getNutritionPlanLabel(plan, crop);

    if (!crop || !crop.nutritionProfile || crop.nutritionProfile.length === 0) {
      excluded.add(`${planLabel} — missing nutrition profile`);
      continue;
    }

    const hasPerServingNutrition = crop.nutritionProfile.some((item) => item.assumptions.trim().toLowerCase().includes('per serving'));
    if (hasPerServingNutrition) {
      if (!plan.expectedYield || !Number.isFinite(plan.expectedYield.amount) || plan.expectedYield.amount <= 0 || plan.expectedYield.unit !== 'pieces') {
        excluded.add(`${planLabel} — missing piece-based expected yield`);
        continue;
      }
    } else {
      const yieldGrams = toYieldGrams(plan);
      if (yieldGrams === null) {
        excluded.add(`${planLabel} — missing mass expected yield`);
        continue;
      }
    }

    const yieldGrams = toYieldGrams(plan);

    for (const item of crop.nutritionProfile) {
      if (!(item.nutrient in totals)) {
        continue;
      }

      const assumptions = item.assumptions.trim().toLowerCase();
      const perServing = assumptions.includes('per serving');

      if (perServing) {
        totals[item.nutrient] = (totals[item.nutrient] ?? 0) + item.value * plan.expectedYield.amount;
      } else if (yieldGrams !== null) {
        totals[item.nutrient] = (totals[item.nutrient] ?? 0) + (yieldGrams / 100) * item.value;
      }

      confidence.add(`${crop.name}: ${item.source} — ${item.assumptions}`);
    }
  }

  return {
    totals,
    excludedCrops: [...excluded].sort((left, right) => left.localeCompare(right)),
    confidenceNotes: [...confidence].sort((left, right) => left.localeCompare(right)),
    flags: NUTRITION_FLAGS,
  };
};

const roundMetricValue = (value: number, unit: NutritionMetric['unit']): number => {
  if (unit === 'kcal') {
    return Math.round(value);
  }
  return Number(value.toFixed(2));
};

function NutritionPage() {
  const [days, setDays] = useState(365);
  const [cropPlans, setCropPlans] = useState<CropPlan[]>([]);
  const [crops, setCrops] = useState<Crop[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const appState = await loadAppStateFromIndexedDb();
      setCropPlans(appState?.cropPlans ?? []);
      setCrops(appState?.crops ?? []);
      setIsLoading(false);
    };

    void load();
  }, []);

  const summary = useMemo(() => summarizeNutrition(cropPlans, crops), [cropPlans, crops]);
  const safeDays = Number.isFinite(days) && days > 0 ? days : 365;
  const macroMetrics = NUTRITION_METRICS.filter((metric) => ['kcal', 'protein', 'fat'].includes(metric.key));
  const microMetrics = NUTRITION_METRICS.filter((metric) => ['vitamin_c', 'vitamin_a', 'vitamin_k'].includes(metric.key));
  const flagsToShow = summary.flags.filter((flag) => flag.title.includes('B12') || flag.title.includes('Iodine'));
  const missingNutritionWarnings = summary.excludedCrops;

  return (
    <section className="data-page">
      <h2>Nutrition</h2>
      <p className="nutrition-intro">Rough estimate from planned yield and crop nutrition profiles.</p>
      <label>
        Horizon (days)
        <input
          type="number"
          min={1}
          value={days}
          onChange={(event) => setDays(Number(event.target.value) || 365)}
          aria-label="Nutrition horizon in days"
        />
      </label>
      {isLoading ? <p>Loading nutrition data…</p> : null}
      {!isLoading ? (
        <div className="nutrition-layout">
          <article className="nutrition-card">
            <h3>Macro coverage</h3>
            <p className="nutrition-card-note">Totals and per-day estimates from the selected horizon.</p>
            <ul className="nutrition-metric-list">
              {macroMetrics.map((metric) => {
                const total = roundMetricValue(summary.totals[metric.key] ?? 0, metric.unit);
                const perDay = roundMetricValue(total / safeDays, metric.unit);
                const target = NUTRITION_TARGETS[metric.key];
                const coverage = target ? Math.round((perDay / target.daily) * 100) : 0;

                return (
                  <li key={metric.key} className="nutrition-metric-item">
                    <p>
                      <strong>{metric.label}</strong>
                    </p>
                    <p className="nutrition-metric-values">
                      total {total} {metric.unit} · per day {perDay} {metric.unit}
                    </p>
                    <p className="nutrition-target-copy">
                      Coverage vs generic target: {coverage}% ({target?.label})
                    </p>
                  </li>
                );
              })}
            </ul>
          </article>

          <article className="nutrition-card">
            <h3>Key micronutrients</h3>
            <p className="nutrition-card-note">Coverage labels use generic targets only (not personalized advice).</p>
            <ul className="nutrition-metric-list">
              {microMetrics.map((metric) => {
                const total = roundMetricValue(summary.totals[metric.key] ?? 0, metric.unit);
                const perDay = roundMetricValue(total / safeDays, metric.unit);
                const target = NUTRITION_TARGETS[metric.key];
                const coverage = target ? Math.round((perDay / target.daily) * 100) : 0;

                return (
                  <li key={metric.key} className="nutrition-metric-item">
                    <p>
                      <strong>{metric.label}</strong>
                    </p>
                    <p className="nutrition-metric-values">
                      total {total} {metric.unit} · per day {perDay} {metric.unit}
                    </p>
                    <p className="nutrition-target-copy">
                      Coverage vs generic target: {coverage}% ({target?.label})
                    </p>
                  </li>
                );
              })}
            </ul>
          </article>

          <article className="nutrition-card">
            <h3>Nutrition flags (B12, iodine)</h3>
            <p className="nutrition-card-note">Informational only, not medical advice.</p>
            <ul className="nutrition-flag-list">
              {flagsToShow.map((flag) => (
                <li key={flag.title} className={`nutrition-flag-item nutrition-flag-${flag.severity}`}>
                  <strong>{flag.title}</strong> ({flag.severity}): {flag.rationale} {flag.guidanceText}
                </li>
              ))}
            </ul>
          </article>

          <article className="nutrition-card">
            <h3>Assumptions and missing data</h3>
            <p className="nutrition-card-note">Generic targets are for reference labels only and this estimate is rough.</p>
            <ul className="nutrition-assumption-list">
              <li>Generic targets are used for coverage labels (not individualized).</li>
              <li>Uses expectedYield from CropPlan and nutritionProfile values from each crop.</li>
              <li>Per 100g entries are normalized by mass yield (kg/g).</li>
              <li>Per serving entries require piece-based yield; otherwise crop is listed below.</li>
              <li>Rounding: kcal rounded to whole numbers, other nutrients rounded to 2 decimals.</li>
            </ul>
            <h4>Excluded crops (missing nutrition data)</h4>
            {missingNutritionWarnings.length > 0 ? (
              <ul className="nutrition-warning-list">
                {missingNutritionWarnings.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            ) : (
              <p className="nutrition-card-note">Excluded crops warning: none.</p>
            )}
          </article>

          <article className="nutrition-card">
            <h4>Confidence notes</h4>
            {summary.confidenceNotes.length === 0 ? (
              <p className="nutrition-card-note">No confidence notes available.</p>
            ) : (
              <ul className="nutrition-assumption-list">
                {summary.confidenceNotes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </article>
        </div>
      ) : null}
    </section>
  );
}

type DataPageProps = {
  showDevResetButton: boolean;
  onResetToGoldenDataset: () => void;
};

type RecoveryScreenProps = {
  error: unknown;
  onRetry: () => void;
};

export function RecoveryScreen({ error, onRetry }: RecoveryScreenProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const [pendingImportState, setPendingImportState] = useState<unknown | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const handleExportJson = useCallback(async () => {
    if (isExporting) {
      return;
    }

    setIsExporting(true);
    setExportMessage(null);

    try {
      const appState = await loadAppStateFromIndexedDb();
      if (!appState) {
        setExportMessage('Export failed: no readable data was found in local storage.');
        return;
      }

      const payload = serializeAppStateForExport(appState);
      const timestamp = new Date().toISOString().replace(/[.:]/g, '-');
      const fileName = `survival-garden-recovery-${timestamp}.json`;
      const blob = new Blob([payload], { type: 'application/json' });
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(objectUrl);
      setExportMessage(`Export complete: ${fileName}`);
    } catch (exportError) {
      setExportMessage(`Export failed: ${exportError instanceof Error ? exportError.message : 'Unknown error.'}`);
    } finally {
      setIsExporting(false);
    }
  }, [isExporting]);

  const handleImportJson = useCallback(async (event: FormEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';

    if (!file || isImporting) {
      return;
    }

    setIsImporting(true);
    setImportMessage(null);
    setPendingImportState(null);

    try {
      const payload = await file.text();
      const parsedState = parseImportedAppState(payload);
      setPendingImportState(parsedState);
      setImportMessage('Import file is valid. Replace existing data?');
    } catch (importError) {
      setImportMessage(`Import failed: ${importError instanceof Error ? importError.message : 'Unknown error.'}`);
    } finally {
      setIsImporting(false);
    }
  }, [isImporting]);

  const handleConfirmImport = useCallback(async () => {
    if (!pendingImportState || isImporting) {
      return;
    }

    setIsImporting(true);
    setImportMessage(null);

    try {
      await saveAppStateToIndexedDb(pendingImportState, { mode: 'replace' });
      setPendingImportState(null);
      setImportMessage('Import complete. Existing data was replaced.');
    } catch (importError) {
      setImportMessage(`Import failed while saving: ${importError instanceof Error ? importError.message : 'Unknown error.'}`);
    } finally {
      setIsImporting(false);
    }
  }, [isImporting, pendingImportState]);

  const handleReset = useCallback(async () => {
    if (!confirmReset || isResetting) {
      return;
    }

    setIsResetting(true);
    setResetMessage(null);

    try {
      await resetToGoldenDataset();
      setResetMessage('Reset complete. You can retry loading the app now.');
      setConfirmReset(false);
    } catch (resetError) {
      setResetMessage(`Reset failed: ${resetError instanceof Error ? resetError.message : 'Unknown error.'}`);
    } finally {
      setIsResetting(false);
    }
  }, [confirmReset, isResetting]);

  return (
    <div className="storage-error-screen" role="alert">
      <h1>Recovery mode</h1>
      <p>The app hit a runtime/storage error and stopped loading.</p>
      <p>Nothing is deleted automatically. Choose a recovery action below.</p>
      <p>{error instanceof Error ? `Error: ${error.message}` : 'Error: Unknown runtime failure.'}</p>
      <div className="storage-error-actions">
        <button type="button" onClick={onRetry}>Retry</button>
        <button type="button" onClick={() => void handleExportJson()} disabled={isExporting}>
          {isExporting ? 'Exporting…' : 'Export readable data'}
        </button>
      </div>
      {exportMessage ? <p>{exportMessage}</p> : null}
      <label>
        Import backup JSON
        <input type="file" accept="application/json,.json" onChange={(event) => void handleImportJson(event)} disabled={isImporting} />
      </label>
      {pendingImportState ? (
        <button type="button" onClick={() => void handleConfirmImport()} disabled={isImporting}>
          {isImporting ? 'Replacing data…' : 'Replace with imported backup'}
        </button>
      ) : null}
      {importMessage ? <p>{importMessage}</p> : null}
      <label>
        <input type="checkbox" checked={confirmReset} onChange={(event) => setConfirmReset(event.currentTarget.checked)} disabled={isResetting} />
        I understand reset will replace local data with the golden dataset.
      </label>
      <button type="button" onClick={() => void handleReset()} disabled={!confirmReset || isResetting}>
        {isResetting ? 'Resetting…' : 'Reset local database'}
      </button>
      {resetMessage ? <p>{resetMessage}</p> : null}
    </div>
  );
}

function DataPage({ showDevResetButton, onResetToGoldenDataset }: DataPageProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [isExporting, setIsExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<Array<{ path: string; message: string }>>([]);
  const [pendingImportState, setPendingImportState] = useState<unknown | null>(null);
  const [pendingBatchImportState, setPendingBatchImportState] = useState<unknown | null>(null);
  const [pendingBatchImportPreview, setPendingBatchImportPreview] = useState<Array<{ batchLabel: string; seedCount: number; eventCount: number }>>([]);
  const [pendingCropImportCrops, setPendingCropImportCrops] = useState<Crop[]>([]);
  const [pendingCropPlanImportPlans, setPendingCropPlanImportPlans] = useState<CropPlan[]>([]);
  const [pendingSegmentImportSegments, setPendingSegmentImportSegments] = useState<Segment[]>([]);
  const [pendingSegmentImportPreview, setPendingSegmentImportPreview] = useState<Array<{
    segmentId: string;
    name: string;
    width: number;
    height: number;
    bedCount: number;
    pathCount: number;
    bedTypesSummary: string;
    status: 'imported' | 'merged' | 'skipped' | 'rejected';
    reason?: string;
  }>>([]);
  const [autoRenameOnConflict, setAutoRenameOnConflict] = useState(false);
  const [batchImportStatusSummary, setBatchImportStatusSummary] = useState<{
    skipped: number;
    merged: number;
    rejected: number;
    renamed: number;
  } | null>(null);
  const [cropImportStatusSummary, setCropImportStatusSummary] = useState<{
    imported: number;
    merged: number;
    skipped: number;
    rejected: number;
  } | null>(null);
  const [cropPlanImportStatusSummary, setCropPlanImportStatusSummary] = useState<{
    imported: number;
    merged: number;
    skipped: number;
    rejected: number;
  } | null>(null);
  const [segmentImportStatusSummary, setSegmentImportStatusSummary] = useState<{
    imported: number;
    merged: number;
    skipped: number;
    rejected: number;
  } | null>(null);

  const buildBatchValidationMessages = useCallback((error: unknown, batchId: string, batchIndex: number): Array<{ path: string; message: string }> => {
    const fallbackPath = `/batches/${batchIndex}`;

    if (error instanceof SchemaValidationError && error.issues.length > 0) {
      return error.issues.map((issue) => {
        const pathParts = issue.path.split('/').filter(Boolean);
        const field = pathParts[pathParts.length - 1] ?? 'unknown';
        return {
          path: fallbackPath,
          message: `schema_validation_failed (batchId: ${batchId}, field: ${field}) - ${issue.message}`,
        };
      });
    }

    return [{ path: fallbackPath, message: `schema_validation_failed (batchId: ${batchId}) - ${error instanceof Error ? error.message : 'Unknown import error.'}` }];
  }, []);

  const mapImportError = useCallback((error: unknown): Array<{ path: string; message: string }> => {
    if (error instanceof SchemaValidationError && error.issues.length > 0) {
      return error.issues.map((issue) => ({
        path: issue.path || '/',
        message: issue.message,
      }));
    }

    if (error instanceof SyntaxError) {
      return [{ path: '/', message: error.message }];
    }

    return [{ path: '/', message: error instanceof Error ? error.message : 'Unknown import error.' }];
  }, []);

  const handleExportJson = useCallback(async () => {
    if (isExporting) {
      return;
    }

    setIsExporting(true);
    setExportMessage(null);

    try {
      const appState = await loadAppStateFromIndexedDb();
      if (!appState) {
        setExportMessage('Export failed: local app state is unavailable.');
        return;
      }

      const json = serializeAppStateForExport(appState);
      const timestamp = new Date().toISOString().replace(/[.:]/g, '-');
      const fileName = `survival-garden-export-${timestamp}.json`;
      const exportBlob = new Blob([json], { type: 'application/json' });
      const objectUrl = URL.createObjectURL(exportBlob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(objectUrl);
      setExportMessage(`Export complete: ${fileName}`);
    } catch (error) {
      if (error instanceof SchemaValidationError && error.issues.length > 0) {
        const issueSummary = error.issues
          .slice(0, 5)
          .map((issue) => issue.path || issue.message)
          .join('; ');
        setExportMessage(`Export failed: ${error.message}: ${issueSummary}`);
      } else {
        setExportMessage(`Export failed: ${error instanceof Error ? error.message : 'Unknown error.'}`);
      }
    } finally {
      setIsExporting(false);
    }
  }, [isExporting]);

  const handleImportJson = useCallback(async (event: FormEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';

    if (!file || isImporting) {
      return;
    }

    setIsImporting(true);
    setImportMessage(null);
    setImportErrors([]);
    setPendingImportState(null);
    setPendingBatchImportState(null);
    setPendingBatchImportPreview([]);
    setPendingCropImportCrops([]);
    setPendingCropPlanImportPlans([]);
    setPendingSegmentImportSegments([]);
    setPendingSegmentImportPreview([]);
    setBatchImportStatusSummary(null);
    setCropImportStatusSummary(null);
    setCropPlanImportStatusSummary(null);
    setSegmentImportStatusSummary(null);

    try {
      const payload = await file.text();
      const parsedState = parseImportedAppState(payload);
      setPendingImportState(parsedState);
      setImportMessage('Import file is valid. Replace existing data?');
    } catch (error) {
      setImportMessage('Import failed. Fix the errors below and try again.');
      setImportErrors(mapImportError(error));
    } finally {
      setIsImporting(false);
    }
  }, [isImporting, mapImportError]);

  const handleImportBatchJson = useCallback(async (event: FormEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';

    if (!file || isImporting) {
      return;
    }

    setIsImporting(true);
    setImportMessage(null);
    setImportErrors([]);
    setPendingImportState(null);
    setPendingBatchImportState(null);
    setPendingBatchImportPreview([]);
    setPendingCropImportCrops([]);
    setPendingCropPlanImportPlans([]);
    setPendingSegmentImportSegments([]);
    setPendingSegmentImportPreview([]);
    setBatchImportStatusSummary(null);
    setCropImportStatusSummary(null);
    setCropPlanImportStatusSummary(null);
    setSegmentImportStatusSummary(null);

    try {
      const payload = await file.text();
      const rawParsed = JSON.parse(payload) as { batches?: unknown };

      if (!rawParsed || typeof rawParsed !== 'object' || !Array.isArray(rawParsed.batches)) {
        throw new Error('Batch import payload must be an object with a batches array.');
      }

      const validBatches: unknown[] = [];
      const validationErrors: Array<{ path: string; message: string }> = [];

      rawParsed.batches.forEach((candidate, index) => {
        const batchId =
          candidate && typeof candidate === 'object' && 'batchId' in candidate && typeof candidate.batchId === 'string'
            ? candidate.batchId
            : `index-${index}`;

        try {
          const validatedSingleBatch = parseImportedAppState(JSON.stringify({
            schemaVersion: 1,
            beds: [],
            crops: [],
            cropPlans: [],
            batches: [candidate],
            seedInventoryItems: [],
            tasks: [],
          }));
          validBatches.push(validatedSingleBatch.batches[0]);
        } catch (validationError) {
          validationErrors.push(...buildBatchValidationMessages(validationError, batchId, index));
        }
      });

      if (validBatches.length === 0) {
        setImportMessage('Batch import failed. No valid batches passed validation. Validate JSON schema issues and retry.');
        setImportErrors(validationErrors);
        return;
      }

      const validatedBatchImportState = parseImportedAppState(JSON.stringify({
        schemaVersion: 1,
        beds: [],
        crops: [],
        cropPlans: [],
        batches: validBatches,
        seedInventoryItems: [],
        tasks: [],
      }));
      const previewItems = validatedBatchImportState.batches.map((batch) => ({
        batchLabel: `${batch.variety ?? 'Unknown variety'} (${batch.cropId ?? 'Unknown crop'})`,
        seedCount: batch.seedCountPlanned ?? 0,
        eventCount: Array.isArray(batch.stageEvents) ? batch.stageEvents.length : 0,
      }));
      const previewSummary = previewItems
        .slice(0, 3)
        .map((item) => item.batchLabel)
        .join(', ');
      const invalidCount = rawParsed.batches.length - validBatches.length;
      setPendingBatchImportState(validatedBatchImportState);
      setPendingBatchImportPreview(previewItems);
      setImportMessage(
        `Batch import ready: ${validBatches.length} valid batch(es) from ${rawParsed.batches.length} payload batch(es), invalid ${invalidCount}.`
        + (previewSummary.length > 0 ? ` Preview: ${previewSummary}.` : ''),
      );
      setImportErrors(validationErrors);
    } catch (error) {
      setImportMessage('Import failed. Fix the errors below and try again.');
      setImportErrors(mapImportError(error));
    } finally {
      setIsImporting(false);
    }
  }, [buildBatchValidationMessages, isImporting, mapImportError]);

  const handleImportCropJson = useCallback(async (event: FormEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';

    if (!file || isImporting) {
      return;
    }

    setIsImporting(true);
    setImportMessage(null);
    setImportErrors([]);
    setPendingImportState(null);
    setPendingBatchImportState(null);
    setPendingBatchImportPreview([]);
    setPendingCropImportCrops([]);
    setPendingCropPlanImportPlans([]);
    setPendingSegmentImportSegments([]);
    setPendingSegmentImportPreview([]);
    setBatchImportStatusSummary(null);
    setCropImportStatusSummary(null);
    setCropPlanImportStatusSummary(null);
    setSegmentImportStatusSummary(null);

    try {
      const payload = await file.text();
      const rawParsed = JSON.parse(payload) as { crops?: unknown[] };

      if (!rawParsed || typeof rawParsed !== 'object' || !Array.isArray(rawParsed.crops)) {
        throw new Error('Crop import payload must be an object with a crops array.');
      }

      const validCrops: Crop[] = [];
      const validationErrors: Array<{ path: string; message: string }> = [];

      rawParsed.crops.forEach((candidate, index) => {
        const fallbackPath = `/crops/${index}`;

        try {
          const validatedSingleCrop = parseImportedAppState(JSON.stringify({
            schemaVersion: 1,
            beds: [],
            crops: [candidate],
            cropPlans: [],
            batches: [],
            seedInventoryItems: [],
            tasks: [],
          }));
          const validatedCrop = validatedSingleCrop.crops[0];
          if (validatedCrop) {
            validCrops.push(validatedCrop);
          }
        } catch (validationError) {
          if (validationError instanceof SchemaValidationError && validationError.issues.length > 0) {
            validationErrors.push(
              ...validationError.issues.map((issue) => ({
                path: fallbackPath,
                message: `schema_validation_failed (field: ${issue.path.split('/').filter(Boolean).pop() ?? 'unknown'}) - ${issue.message}`,
              })),
            );
          } else {
            validationErrors.push({
              path: fallbackPath,
              message: `schema_validation_failed - ${validationError instanceof Error ? validationError.message : 'Unknown import error.'}`,
            });
          }
        }
      });

      if (validCrops.length === 0) {
        setImportMessage('Crop import failed. No valid crops passed validation.');
        setImportErrors(validationErrors);
        return;
      }

      setPendingCropImportCrops(validCrops);
      setImportMessage(`Crop import ready: ${validCrops.length} valid crop(s) from ${rawParsed.crops.length}. Confirm to import.`);
      setImportErrors(validationErrors);
    } catch (error) {
      setImportMessage('Import failed. Fix the errors below and try again.');
      setImportErrors(mapImportError(error));
    } finally {
      setIsImporting(false);
    }
  }, [isImporting, mapImportError]);

  const handleImportCropPlanJson = useCallback(async (event: FormEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';

    if (!file || isImporting) {
      return;
    }

    setIsImporting(true);
    setImportMessage(null);
    setImportErrors([]);
    setPendingImportState(null);
    setPendingBatchImportState(null);
    setPendingBatchImportPreview([]);
    setPendingCropImportCrops([]);
    setPendingCropPlanImportPlans([]);
    setPendingSegmentImportSegments([]);
    setPendingSegmentImportPreview([]);
    setBatchImportStatusSummary(null);
    setCropImportStatusSummary(null);
    setCropPlanImportStatusSummary(null);
    setSegmentImportStatusSummary(null);

    try {
      const payload = await file.text();
      const rawParsed = JSON.parse(payload) as { cropPlans?: unknown[] };

      if (!rawParsed || typeof rawParsed !== 'object' || !Array.isArray(rawParsed.cropPlans)) {
        throw new Error('Crop plan import payload must be an object with a cropPlans array.');
      }

      const validCropPlans: CropPlan[] = [];
      const validationErrors: Array<{ path: string; message: string }> = [];

      rawParsed.cropPlans.forEach((candidate, index) => {
        const fallbackPath = `/cropPlans/${index}`;

        try {
          const validatedSinglePlan = parseImportedAppState(JSON.stringify({
            schemaVersion: 1,
            beds: [],
            crops: [],
            cropPlans: [candidate],
            batches: [],
            seedInventoryItems: [],
            tasks: [],
          }));
          const validatedPlan = validatedSinglePlan.cropPlans[0];
          if (validatedPlan) {
            validCropPlans.push(validatedPlan);
          }
        } catch (validationError) {
          if (validationError instanceof SchemaValidationError && validationError.issues.length > 0) {
            validationErrors.push(
              ...validationError.issues.map((issue) => ({
                path: fallbackPath,
                message: `schema_validation_failed - ${issue.message}`,
              })),
            );
          } else {
            validationErrors.push({
              path: fallbackPath,
              message: `schema_validation_failed - ${validationError instanceof Error ? validationError.message : 'Unknown import error.'}`,
            });
          }
        }
      });

      if (validCropPlans.length === 0) {
        setImportMessage('Crop plan import failed. No valid crop plans passed validation.');
        setImportErrors(validationErrors);
        return;
      }

      setPendingCropPlanImportPlans(validCropPlans);
      setImportErrors(validationErrors);
      setImportMessage(`Crop plan import ready: ${validCropPlans.length} valid crop plan(s) from ${rawParsed.cropPlans.length}. Confirm to import.`);
    } catch (error) {
      setImportMessage('Import failed. Fix the errors below and try again.');
      setImportErrors(mapImportError(error));
    } finally {
      setIsImporting(false);
    }
  }, [isImporting, mapImportError]);

  const handleImportSegmentJson = useCallback(async (event: FormEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';

    if (!file || isImporting) {
      return;
    }

    setIsImporting(true);
    setImportMessage(null);
    setImportErrors([]);
    setPendingImportState(null);
    setPendingBatchImportState(null);
    setPendingBatchImportPreview([]);
    setPendingCropImportCrops([]);
    setPendingCropPlanImportPlans([]);
    setPendingSegmentImportSegments([]);
    setPendingSegmentImportPreview([]);
    setBatchImportStatusSummary(null);
    setCropImportStatusSummary(null);
    setCropPlanImportStatusSummary(null);
    setSegmentImportStatusSummary(null);

    try {
      const payload = await file.text();
      const rawParsed = JSON.parse(payload) as { segments?: unknown[] };

      if (!rawParsed || typeof rawParsed !== 'object' || !Array.isArray(rawParsed.segments)) {
        throw new Error('Segment import payload must be an object with a segments array.');
      }

      const validatedSingleSegmentState = parseImportedAppState(JSON.stringify({
        schemaVersion: 1,
        segments: rawParsed.segments,
        beds: [],
        crops: [],
        cropPlans: [],
        batches: [],
        seedInventoryItems: [],
        tasks: [],
      }));

      const validatedSegments = validatedSingleSegmentState.segments ?? [];
      const existingState = await loadAppStateFromIndexedDb();
      const existingSegments = existingState?.segments ?? [];
      const existingById = new Map(existingSegments.map((segment) => [segment.segmentId, segment]));

      const preview = validatedSegments.map((segment) => {
        const current = existingById.get(segment.segmentId);

        if (!current) {
          return {
            segmentId: segment.segmentId,
            name: segment.name,
            width: segment.width,
            height: segment.height,
            bedCount: segment.beds.length,
            pathCount: segment.paths.length,
            bedTypesSummary: [...new Set(segment.beds.map((bed) => bed.type))].sort().join(', '),
            status: 'imported' as const,
          };
        }

        if (JSON.stringify(current) === JSON.stringify(segment)) {
          return {
            segmentId: segment.segmentId,
            name: segment.name,
            width: segment.width,
            height: segment.height,
            bedCount: segment.beds.length,
            pathCount: segment.paths.length,
            bedTypesSummary: [...new Set(segment.beds.map((bed) => bed.type))].sort().join(', '),
            status: 'skipped' as const,
            reason: 'identical_segment',
          };
        }

        if (current.name !== segment.name || current.originReference !== segment.originReference) {
          return {
            segmentId: segment.segmentId,
            name: segment.name,
            width: segment.width,
            height: segment.height,
            bedCount: segment.beds.length,
            pathCount: segment.paths.length,
            bedTypesSummary: [...new Set(segment.beds.map((bed) => bed.type))].sort().join(', '),
            status: 'rejected' as const,
            reason: 'segment_identity_conflict',
          };
        }

        return {
          segmentId: segment.segmentId,
          name: segment.name,
          width: segment.width,
          height: segment.height,
          bedCount: segment.beds.length,
          pathCount: segment.paths.length,
          bedTypesSummary: [...new Set(segment.beds.map((bed) => bed.type))].sort().join(', '),
          status: 'merged' as const,
        };
      });

      const summary = preview.reduce(
        (acc, entry) => {
          acc[entry.status] += 1;
          return acc;
        },
        { imported: 0, merged: 0, skipped: 0, rejected: 0 },
      );

      setPendingSegmentImportSegments(validatedSegments);
      setPendingSegmentImportPreview(preview);
      setSegmentImportStatusSummary(summary);
      setImportMessage(
        `Segment import ready: ${validatedSegments.length} segment(s). Statuses: imported ${summary.imported}, merged ${summary.merged}, skipped ${summary.skipped}, rejected ${summary.rejected}. Confirm to import.`,
      );
    } catch (error) {
      setImportMessage('Import failed. Fix the errors below and try again.');
      setImportErrors(mapImportError(error));
    } finally {
      setIsImporting(false);
    }
  }, [isImporting, mapImportError]);


  const handleConfirmReplace = useCallback(async () => {
    if (!pendingImportState || isImporting) {
      return;
    }

    setIsImporting(true);
    setImportMessage(null);
    setImportErrors([]);

    try {
      await saveAppStateToIndexedDb(pendingImportState, { mode: 'replace' });
      setPendingImportState(null);
      setImportMessage('Import complete. Existing data was replaced.');
    } catch (error) {
      setImportMessage('Import failed while saving.');
      setImportErrors(mapImportError(error));
    } finally {
      setIsImporting(false);
    }
  }, [isImporting, mapImportError, pendingImportState]);

  const handleConfirmBatchImport = useCallback(async () => {
    if (!pendingBatchImportState || isImporting) {
      return;
    }

    setIsImporting(true);
    setImportMessage(null);
    setImportErrors([]);

    try {
      const report = await saveAppStateToIndexedDb(pendingBatchImportState, { mode: 'merge' });
      const appStateWithBatches = pendingBatchImportState as { batches?: unknown[] };
      const created = report?.batches.added ?? appStateWithBatches.batches?.length ?? 0;
      const merged = report?.batches.updated ?? 0;
      const skipped = report?.batches.unchanged ?? 0;
      const rejectedConflict = report?.conflicts.length ?? 0;
      const renamed = 0;
      const conflictDetail = rejectedConflict > 0
        ? ` Conflict reasons: ${report?.conflicts.join('; ')}`
        : '';
      const renameCapabilityNote = autoRenameOnConflict
        ? ' Auto-rename requested, but this importer currently reports collisions as deterministic rejects.'
        : '';
      setBatchImportStatusSummary({
        skipped,
        merged,
        rejected: rejectedConflict,
        renamed,
      });
      setImportMessage(
        `Batch import complete. Created: ${created}. Statuses: merged ${merged}, skipped ${skipped}, rejected ${rejectedConflict}, renamed ${renamed}.`
        + conflictDetail
        + renameCapabilityNote,
      );
      setPendingBatchImportState(null);
      setPendingBatchImportPreview([]);
    } catch (error) {
      setImportMessage('Import failed while saving.');
      setImportErrors(mapImportError(error));
    } finally {
      setIsImporting(false);
    }
  }, [autoRenameOnConflict, isImporting, mapImportError, pendingBatchImportState]);

  const handleConfirmCropImport = useCallback(async () => {
    if (pendingCropImportCrops.length === 0 || isImporting) {
      return;
    }

    setIsImporting(true);
    setImportMessage(null);
    setImportErrors([]);

    try {
      const existingAppState = await loadAppStateFromIndexedDb();
      if (!existingAppState) {
        setImportMessage('Crop import failed: local app state is unavailable.');
        return;
      }

      const cropsById = new Map(existingAppState.crops.map((crop) => [crop.cropId, crop]));
      const summary = { imported: 0, merged: 0, skipped: 0, rejected: 0 };
      const results: Array<{ path: string; message: string }> = [];

      pendingCropImportCrops.forEach((incomingCrop, index) => {
        const currentCrop = cropsById.get(incomingCrop.cropId);

        if (!currentCrop) {
          cropsById.set(incomingCrop.cropId, incomingCrop);
          summary.imported += 1;
          return;
        }

        if (incomingCrop.createdAt !== currentCrop.createdAt) {
          summary.rejected += 1;
          results.push({
            path: `/crops/${index}`,
            message: `rejected (crop_identity_conflict): createdAt mismatch for cropId ${incomingCrop.cropId}`,
          });
          return;
        }

        const mergedCrop: Crop = {
          ...currentCrop,
          name: incomingCrop.name,
          rules: incomingCrop.rules,
          nutritionProfile: incomingCrop.nutritionProfile,
          updatedAt: incomingCrop.updatedAt,
        };

        if (incomingCrop.aliases !== undefined) {
          mergedCrop.aliases = incomingCrop.aliases;
        }
        if (incomingCrop.category !== undefined) {
          mergedCrop.category = incomingCrop.category;
        }
        if (incomingCrop.taskRules !== undefined) {
          mergedCrop.taskRules = incomingCrop.taskRules;
        }
        const incomingCultivar = (incomingCrop as Crop & { cultivar?: string }).cultivar;
        if (incomingCultivar !== undefined) {
          (mergedCrop as Crop & { cultivar?: string }).cultivar = incomingCultivar;
        }
        const incomingSpeciesId = (incomingCrop as Crop & { speciesId?: string }).speciesId;
        if (incomingSpeciesId !== undefined) {
          (mergedCrop as Crop & { speciesId?: string }).speciesId = incomingSpeciesId;
        }

        const incomingSpecies = (incomingCrop as Crop & {
          species?: { id?: string; commonName: string; scientificName: string; taxonomy?: { family?: string; genus?: string; species?: string } };
        }).species;
        const incomingTaxonomy = incomingCrop.taxonomy;

        if (incomingSpecies !== undefined || incomingTaxonomy !== undefined) {
          const currentSpecies = (currentCrop as Crop & {
            species?: { id?: string; commonName: string; scientificName: string; taxonomy?: { family?: string; genus?: string; species?: string } };
          }).species;
          const commonName = incomingSpecies?.commonName ?? currentSpecies?.commonName;
          const scientificName = incomingSpecies?.scientificName ?? currentSpecies?.scientificName;

          if (commonName !== undefined && scientificName !== undefined) {
            (mergedCrop as Crop & {
              species?: { id?: string; commonName: string; scientificName: string; taxonomy?: { family?: string; genus?: string; species?: string } };
            }).species = {
              ...(currentSpecies?.id !== undefined ? { id: currentSpecies.id } : {}),
              ...(incomingSpecies?.id !== undefined ? { id: incomingSpecies.id } : {}),
              commonName,
              scientificName,
              ...((incomingTaxonomy !== undefined || incomingSpecies?.taxonomy !== undefined || currentSpecies?.taxonomy !== undefined)
                ? {
                    taxonomy: {
                      ...(currentSpecies?.taxonomy ?? {}),
                      ...(incomingTaxonomy ?? {}),
                      ...(incomingSpecies?.taxonomy ?? {}),
                    },
                  }
                : {}),
            };
          }
        }

        const unchanged = JSON.stringify(currentCrop) === JSON.stringify(mergedCrop);
        cropsById.set(incomingCrop.cropId, mergedCrop);
        if (unchanged) {
          summary.skipped += 1;
        } else {
          summary.merged += 1;
        }
      });

      await saveAppStateToIndexedDb({ ...existingAppState, crops: [...cropsById.values()] }, { mode: 'replace' });
      setCropImportStatusSummary(summary);
      setImportErrors(results);
      setImportMessage(`Crop import complete. imported: ${summary.imported}, merged: ${summary.merged}, skipped: ${summary.skipped}, rejected: ${summary.rejected}.`);
      setPendingCropImportCrops([]);
    } catch (error) {
      setImportMessage('Import failed while saving.');
      setImportErrors(mapImportError(error));
    } finally {
      setIsImporting(false);
    }
  }, [isImporting, mapImportError, pendingCropImportCrops]);

  const handleConfirmCropPlanImport = useCallback(async () => {
    if (isImporting || pendingCropPlanImportPlans.length === 0) {
      return;
    }

    setIsImporting(true);
    setImportMessage(null);

    try {
      const existingAppState = await loadAppStateFromIndexedDb();
      if (!existingAppState) {
        setImportMessage('Crop plan import failed: local app state is unavailable.');
        return;
      }

      const plansById = new Map(existingAppState.cropPlans.map((plan) => [plan.planId, plan]));
      const summary = { imported: 0, merged: 0, skipped: 0, rejected: 0 };

      pendingCropPlanImportPlans.forEach((incomingPlan) => {
        const currentPlan = plansById.get(incomingPlan.planId);
        if (!currentPlan) {
          plansById.set(incomingPlan.planId, incomingPlan);
          summary.imported += 1;
          return;
        }

        const unchanged = JSON.stringify(currentPlan) === JSON.stringify(incomingPlan);
        plansById.set(incomingPlan.planId, incomingPlan);
        if (unchanged) {
          summary.skipped += 1;
        } else {
          summary.merged += 1;
        }
      });

      await saveAppStateToIndexedDb({ ...existingAppState, cropPlans: [...plansById.values()] }, { mode: 'replace' });
      setCropPlanImportStatusSummary(summary);
      setImportMessage(`Crop plan import complete. imported: ${summary.imported}, merged: ${summary.merged}, skipped: ${summary.skipped}, rejected: ${summary.rejected}.`);
      setPendingCropPlanImportPlans([]);
    } catch (error) {
      setImportMessage('Import failed while saving.');
      setImportErrors(mapImportError(error));
    } finally {
      setIsImporting(false);
    }
  }, [isImporting, mapImportError, pendingCropPlanImportPlans]);


  const handleConfirmSegmentImport = useCallback(async () => {
    if (isImporting || pendingSegmentImportSegments.length === 0) {
      return;
    }

    setIsImporting(true);
    setImportMessage(null);
    setImportErrors([]);

    try {
      const existingAppState = await loadAppStateFromIndexedDb();
      if (!existingAppState) {
        setImportMessage('Segment import failed: local app state is unavailable.');
        return;
      }

      const segmentsById = new Map((existingAppState.segments ?? []).map((segment) => [segment.segmentId, segment]));
      const summary = { imported: 0, merged: 0, skipped: 0, rejected: 0 };
      const results: Array<{ path: string; message: string }> = [];

      pendingSegmentImportSegments.forEach((incomingSegment, index) => {
        const currentSegment = segmentsById.get(incomingSegment.segmentId);

        if (!currentSegment) {
          segmentsById.set(incomingSegment.segmentId, incomingSegment);
          summary.imported += 1;
          return;
        }

        if (JSON.stringify(currentSegment) === JSON.stringify(incomingSegment)) {
          summary.skipped += 1;
          return;
        }

        if (currentSegment.name !== incomingSegment.name || currentSegment.originReference !== incomingSegment.originReference) {
          summary.rejected += 1;
          results.push({
            path: `/segments/${index}`,
            message: `rejected (segment_identity_conflict): identity mismatch for segmentId ${incomingSegment.segmentId}`,
          });
          return;
        }

        segmentsById.set(incomingSegment.segmentId, incomingSegment);
        summary.merged += 1;
      });

      await saveAppStateToIndexedDb({ ...existingAppState, segments: [...segmentsById.values()] }, { mode: 'replace' });
      setSegmentImportStatusSummary(summary);
      setImportErrors(results);
      setImportMessage(`Segment import complete. imported: ${summary.imported}, merged: ${summary.merged}, skipped: ${summary.skipped}, rejected: ${summary.rejected}.`);
      setPendingSegmentImportSegments([]);
      setPendingSegmentImportPreview([]);
    } catch (error) {
      setImportMessage('Import failed while saving.');
      setImportErrors(mapImportError(error));
    } finally {
      setIsImporting(false);
    }
  }, [isImporting, mapImportError, pendingSegmentImportSegments]);

  useEffect(() => {
    const search = new URLSearchParams(location.search);
    const importType = search.get('importType');
    const encodedPayload = search.get('data');

    if (!encodedPayload || !importType) {
      return;
    }

    setImportMessage(null);
    setImportErrors([]);
    setPendingImportState(null);
    setPendingBatchImportState(null);
    setPendingBatchImportPreview([]);
    setPendingCropImportCrops([]);
    setPendingCropPlanImportPlans([]);
    setPendingSegmentImportSegments([]);
    setPendingSegmentImportPreview([]);
    setCropImportStatusSummary(null);
    setCropPlanImportStatusSummary(null);
    setSegmentImportStatusSummary(null);

    void (async () => {
      try {
        const normalizedPayload = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
      const padLength = normalizedPayload.length % 4;
      const paddedPayload = padLength === 0 ? normalizedPayload : `${normalizedPayload}${'='.repeat(4 - padLength)}`;
      const decodedPayload = atob(paddedPayload);
      if (importType === 'batches') {
        const rawParsed = JSON.parse(decodedPayload) as { batches?: unknown[] };

        if (!rawParsed || typeof rawParsed !== 'object' || !Array.isArray(rawParsed.batches)) {
          throw new Error('Deep-link payload must decode to an object with a batches array.');
        }

        const validBatches: unknown[] = [];
        const validationErrors: Array<{ path: string; message: string }> = [];

        rawParsed.batches.forEach((candidate, index) => {
          const batchId =
            candidate && typeof candidate === 'object' && 'batchId' in candidate && typeof candidate.batchId === 'string'
              ? candidate.batchId
              : `index-${index}`;

          try {
            const validatedSingleBatch = parseImportedAppState(JSON.stringify({
              schemaVersion: 1,
              beds: [],
              crops: [],
              cropPlans: [],
              batches: [candidate],
              seedInventoryItems: [],
              tasks: [],
            }));
            validBatches.push(validatedSingleBatch.batches[0]);
          } catch (validationError) {
            validationErrors.push(...buildBatchValidationMessages(validationError, batchId, index));
          }
        });

        if (validBatches.length === 0) {
          setImportMessage('Batch import failed. No valid batches passed validation. Validate JSON schema issues and retry.');
          setImportErrors(validationErrors);
        } else {
          const validatedBatchImportState = parseImportedAppState(JSON.stringify({
            schemaVersion: 1,
            beds: [],
            crops: [],
            cropPlans: [],
            batches: validBatches,
            seedInventoryItems: [],
            tasks: [],
          }));
          const previewBatchIds = validatedBatchImportState.batches
            .map((batch) => ({
              batchLabel: `${batch.variety ?? 'Unknown variety'} (${batch.cropId ?? 'Unknown crop'})`,
              seedCount: batch.seedCountPlanned ?? 0,
              eventCount: Array.isArray(batch.stageEvents) ? batch.stageEvents.length : 0,
            }));
          setPendingBatchImportState(validatedBatchImportState);
          setPendingBatchImportPreview(previewBatchIds);
          setImportMessage(`Deep link ready: ${validBatches.length} valid batch(es) from ${rawParsed.batches.length} payload batch(es). Confirm to import.`);
          setImportErrors(validationErrors);
        }
      } else if (importType === 'crops') {
        const rawParsed = JSON.parse(decodedPayload) as { crops?: unknown[] };
        if (!rawParsed || typeof rawParsed !== 'object' || !Array.isArray(rawParsed.crops)) {
          throw new Error('Deep-link payload must decode to an object with a crops array.');
        }
        const validCrops: Crop[] = [];
        const validationErrors: Array<{ path: string; message: string }> = [];
        rawParsed.crops.forEach((candidate, index) => {
          const fallbackPath = `/crops/${index}`;
          try {
            const validatedSingleCrop = parseImportedAppState(JSON.stringify({
              schemaVersion: 1,
              beds: [],
              crops: [candidate],
              cropPlans: [],
              batches: [],
              seedInventoryItems: [],
              tasks: [],
            }));
            const validatedCrop = validatedSingleCrop.crops[0];
            if (validatedCrop) {
              validCrops.push(validatedCrop);
            }
          } catch (validationError) {
            validationErrors.push({
              path: fallbackPath,
              message: `schema_validation_failed - ${validationError instanceof Error ? validationError.message : 'Unknown import error.'}`,
            });
          }
        });
        if (validCrops.length === 0) {
          setImportMessage('Crop import failed. No valid crops passed validation.');
          setImportErrors(validationErrors);
        } else {
          setPendingCropImportCrops(validCrops);
          setImportErrors(validationErrors);
          setImportMessage(`Deep link ready: ${validCrops.length} valid crop(s) from ${rawParsed.crops.length} payload crop(s). Confirm to import.`);
        }
      } else if (importType === 'crop-plans') {
        const rawParsed = JSON.parse(decodedPayload) as { cropPlans?: unknown[] };
        if (!rawParsed || typeof rawParsed !== 'object' || !Array.isArray(rawParsed.cropPlans)) {
          throw new Error('Deep-link payload must decode to an object with a cropPlans array.');
        }
        const validCropPlans: CropPlan[] = [];
        const validationErrors: Array<{ path: string; message: string }> = [];
        rawParsed.cropPlans.forEach((candidate, index) => {
          const fallbackPath = `/cropPlans/${index}`;
          try {
            const validatedSinglePlan = parseImportedAppState(JSON.stringify({
              schemaVersion: 1,
              beds: [],
              crops: [],
              cropPlans: [candidate],
              batches: [],
              seedInventoryItems: [],
              tasks: [],
            }));
            const validatedPlan = validatedSinglePlan.cropPlans[0];
            if (validatedPlan) {
              validCropPlans.push(validatedPlan);
            }
          } catch (validationError) {
            validationErrors.push({
              path: fallbackPath,
              message: `schema_validation_failed - ${validationError instanceof Error ? validationError.message : 'Unknown import error.'}`,
            });
          }
        });
        if (validCropPlans.length === 0) {
          setImportMessage('Crop plan import failed. No valid crop plans passed validation.');
          setImportErrors(validationErrors);
        } else {
          setPendingCropPlanImportPlans(validCropPlans);
          setImportErrors(validationErrors);
          setImportMessage(`Deep link ready: ${validCropPlans.length} valid crop plan(s) from ${rawParsed.cropPlans.length} payload plan(s). Confirm to import.`);
        }
      } else if (importType === 'segments') {
        const rawParsed = JSON.parse(decodedPayload) as { segments?: unknown[] };
        if (!rawParsed || typeof rawParsed !== 'object' || !Array.isArray(rawParsed.segments)) {
          throw new Error('Deep-link payload must decode to an object with a segments array.');
        }

        const validatedSegmentState = parseImportedAppState(JSON.stringify({
          schemaVersion: 1,
          segments: rawParsed.segments,
          beds: [],
          crops: [],
          cropPlans: [],
          batches: [],
          seedInventoryItems: [],
          tasks: [],
        }));
        const validatedSegments = validatedSegmentState.segments ?? [];
        const existingState = await loadAppStateFromIndexedDb();
        const existingById = new Map((existingState?.segments ?? []).map((segment) => [segment.segmentId, segment]));

        const preview = validatedSegments.map((segment) => {
          const current = existingById.get(segment.segmentId);
          const bedTypesSummary = [...new Set(segment.beds.map((bed) => bed.type))].sort().join(', ');

          if (!current) {
            return {
              segmentId: segment.segmentId,
              name: segment.name,
              width: segment.width,
              height: segment.height,
              bedCount: segment.beds.length,
              pathCount: segment.paths.length,
              bedTypesSummary,
              status: 'imported' as const,
            };
          }

          if (JSON.stringify(current) === JSON.stringify(segment)) {
            return {
              segmentId: segment.segmentId,
              name: segment.name,
              width: segment.width,
              height: segment.height,
              bedCount: segment.beds.length,
              pathCount: segment.paths.length,
              bedTypesSummary,
              status: 'skipped' as const,
              reason: 'identical_segment',
            };
          }

          if (current.name !== segment.name || current.originReference !== segment.originReference) {
            return {
              segmentId: segment.segmentId,
              name: segment.name,
              width: segment.width,
              height: segment.height,
              bedCount: segment.beds.length,
              pathCount: segment.paths.length,
              bedTypesSummary,
              status: 'rejected' as const,
              reason: 'segment_identity_conflict',
            };
          }

          return {
            segmentId: segment.segmentId,
            name: segment.name,
            width: segment.width,
            height: segment.height,
            bedCount: segment.beds.length,
            pathCount: segment.paths.length,
            bedTypesSummary,
            status: 'merged' as const,
          };
        });

        const summary = preview.reduce(
          (acc, entry) => {
            acc[entry.status] += 1;
            return acc;
          },
          { imported: 0, merged: 0, skipped: 0, rejected: 0 },
        );

        setPendingSegmentImportSegments(validatedSegments);
        setPendingSegmentImportPreview(preview);
        setSegmentImportStatusSummary(summary);
        setImportMessage(
          `Deep link ready: ${validatedSegments.length} valid segment(s) from ${rawParsed.segments.length} payload segment(s). Confirm to import.`,
        );
      }
    } catch (error) {
        setImportMessage('Deep-link import failed. Payload was invalid or too large.');
        setImportErrors(mapImportError(error));
      } finally {
        navigate('/data', { replace: true });
      }
    })();
  }, [buildBatchValidationMessages, location.search, mapImportError, navigate]);

  return (
    <>
      <h2 data-route-focus="true">Data</h2>
      <button type="button" onClick={() => void handleExportJson()} disabled={isExporting}>
        {isExporting ? 'Exporting JSON…' : 'Export JSON'}
      </button>
      {exportMessage ? <p>{exportMessage}</p> : null}
      <label>
        Import JSON
        <input type="file" accept="application/json,.json" onChange={(event) => void handleImportJson(event)} disabled={isImporting} />
      </label>
      <label>
        Import Batch JSON
        <input
          type="file"
          accept="application/json,.json"
          onChange={(event) => void handleImportBatchJson(event)}
          disabled={isImporting}
        />
      </label>
      <label>
        Import Crop JSON
        <input
          type="file"
          accept="application/json,.json"
          onChange={(event) => void handleImportCropJson(event)}
          disabled={isImporting}
        />
      </label>
      <label>
        Import Crop Plan JSON
        <input
          type="file"
          accept="application/json,.json"
          onChange={(event) => void handleImportCropPlanJson(event)}
          disabled={isImporting}
        />
      </label>
      <label>
        Import Segment JSON
        <input
          type="file"
          accept="application/json,.json"
          onChange={(event) => void handleImportSegmentJson(event)}
          disabled={isImporting}
        />
      </label>
      <p>Expected format: {'{ "batches": [ ... ] }'}</p>
      <p>Crop import endpoint contract: <code>POST /api/import/crops</code> with <code>{'{ "crops": [ { "cropId": "...", "cultivar": "...", "speciesId": "...", "species": { "id": "...", "commonName": "...", "scientificName": "..." } } ] }'}</code>.</p>
      <p>Legacy species-level crop imports are auto-migrated into cultivar records using the deterministic placeholder <code>Unknown variety</code> when no cultivar is provided.</p>
      <p>Crop plan import endpoint contract: <code>POST /api/import/crop-plans</code> with <code>{'{ "cropPlans": [ ... ] }'}</code>.</p>
      <p>Segment import endpoint contract: <code>POST /api/import/segments</code> with <code>{'{ "segments": [ ... ] }'}</code>.</p>
      <p>
        Segment merge statuses: <code>imported</code> (new segment), <code>merged</code> (deterministic child updates), <code>skipped</code>{' '}
        (identical_segment), <code>rejected</code> (segment_identity_conflict).
      </p>
      <p>
        Crop plan payload references: <code>segmentId</code>, <code>bedId</code>, <code>cropId</code>, optional <code>batchId</code>, and
        <code>placements</code>.
      </p>
      <p>
        Supported placement payloads include <code>{'{ "type": "points", "points": [ ... ] }'}</code> and{' '}
        <code>{'{ "type": "formula", "formula": { "kind": "grid", ... } }'}</code>.
      </p>
      <p>
        Validation behavior: each batch is schema-validated before merge; invalid batches are reported with <code>batchId</code> + field details and skipped.
      </p>
      <p>
        Merge behavior: existing batches are matched by <code>batchId</code>; stage events use deterministic dedupe by{' '}
        <code>type + date + location</code>; immutable fields (<code>cropId</code>, <code>startedAt</code>,{' '}
        <code>startMethod</code>, <code>startLocation</code>) cannot change; <code>currentStage</code> follows the latest event.
      </p>
      <label>
        <input
          type="checkbox"
          checked={autoRenameOnConflict}
          onChange={(event) => {
            setAutoRenameOnConflict(event.currentTarget.checked);
          }}
          disabled={isImporting}
        />
        Auto-rename on ID conflict (presentation preview)
      </label>
      <p>
        ID collision statuses: <code>skipped</code> (identical_batch), <code>merged</code> (events added), <code>rejected</code> (batch_identity_conflict), <code>renamed</code> (newId).
      </p>
      {pendingImportState ? (
        <button type="button" onClick={() => void handleConfirmReplace()} disabled={isImporting}>
          {isImporting ? 'Replacing data…' : 'Replace existing data'}
        </button>
      ) : null}
      {pendingBatchImportState ? (
        <>
          {pendingBatchImportPreview.length > 0 ? (
            <section>
              <h3>Import Preview</h3>
              <ul>
                {pendingBatchImportPreview.map((item, index) => (
                  <li key={`${item.batchLabel}-${index}`}>
                    <p>Batch: {item.batchLabel}</p>
                    <p>Seeds: {item.seedCount}</p>
                    <p>Events: {item.eventCount}</p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <button type="button" onClick={() => void handleConfirmBatchImport()} disabled={isImporting}>
            {isImporting ? 'Importing batches…' : 'Import'}
          </button>
          <button
            type="button"
            onClick={() => {
              setPendingBatchImportState(null);
              setPendingBatchImportPreview([]);
              setBatchImportStatusSummary(null);
              setImportMessage('Batch import canceled.');
            }}
            disabled={isImporting}
          >
            Cancel
          </button>
        </>
      ) : null}
      {pendingCropImportCrops.length > 0 ? (
        <>
          <section>
            <h3>Crop Import Preview</h3>
            <ul>
              {pendingCropImportCrops.slice(0, 5).map((crop) => (
                <li key={crop.cropId}>{(crop as Crop & { cultivar?: string }).cultivar ?? crop.name} — {getCropSpeciesCommonName(crop) || crop.cropId} ({crop.cropId})</li>
              ))}
            </ul>
          </section>
          <button type="button" onClick={() => void handleConfirmCropImport()} disabled={isImporting}>
            {isImporting ? 'Importing crops…' : 'Import crops'}
          </button>
          <button
            type="button"
            onClick={() => {
              setPendingCropImportCrops([]);
              setCropImportStatusSummary(null);
              setImportMessage('Crop import canceled.');
            }}
            disabled={isImporting}
          >
            Cancel crop import
          </button>
        </>
      ) : null}
      {pendingCropPlanImportPlans.length > 0 ? (
        <>
          <section>
            <h3>Crop Plan Import Preview</h3>
            <ul>
              {pendingCropPlanImportPlans.slice(0, 5).map((plan) => (
                <li key={plan.planId}>{plan.planId} — bed {plan.bedId}, crop {plan.cropId}</li>
              ))}
            </ul>
          </section>
          <button type="button" onClick={() => void handleConfirmCropPlanImport()} disabled={isImporting}>
            {isImporting ? 'Importing crop plans…' : 'Import crop plans'}
          </button>
          <button
            type="button"
            onClick={() => {
              setPendingCropPlanImportPlans([]);
              setCropPlanImportStatusSummary(null);
              setImportMessage('Crop plan import canceled.');
            }}
            disabled={isImporting}
          >
            Cancel crop plan import
          </button>
        </>
      ) : null}

      {pendingSegmentImportSegments.length > 0 ? (
        <>
          {pendingSegmentImportPreview.length > 0 ? (
            <section>
              <h3>Segment Import Preview</h3>
              <ul>
                {pendingSegmentImportPreview.slice(0, 10).map((segment) => (
                  <li key={segment.segmentId}>
                    <p>Segment: {segment.name} ({segment.segmentId})</p>
                    <p>Size: {segment.width} m × {segment.height} m</p>
                    <p>Beds: {segment.bedCount} · Paths: {segment.pathCount}</p>
                    <p>Types: {segment.bedTypesSummary || 'none'}</p>
                    <p>
                      Status: {segment.status}
                      {segment.reason ? ` (${segment.reason})` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <button type="button" onClick={() => void handleConfirmSegmentImport()} disabled={isImporting}>
            {isImporting ? 'Importing segments…' : 'Import segments'}
          </button>
          <button
            type="button"
            onClick={() => {
              setPendingSegmentImportSegments([]);
              setPendingSegmentImportPreview([]);
              setSegmentImportStatusSummary(null);
              setImportMessage('Segment import canceled.');
            }}
            disabled={isImporting}
          >
            Cancel segment import
          </button>
        </>
      ) : null}
      {batchImportStatusSummary ? (
        <section>
          <h3>Collision Status Summary</h3>
          <ul>
            <li>skipped (identical_batch): {batchImportStatusSummary.skipped}</li>
            <li>merged (eventsAdded): {batchImportStatusSummary.merged}</li>
            <li>rejected (batch_identity_conflict): {batchImportStatusSummary.rejected}</li>
            <li>renamed (newId): {batchImportStatusSummary.renamed}</li>
          </ul>
        </section>
      ) : null}
      {cropImportStatusSummary ? (
        <section>
          <h3>Crop Import Summary</h3>
          <ul>
            <li>imported: {cropImportStatusSummary.imported}</li>
            <li>merged: {cropImportStatusSummary.merged}</li>
            <li>skipped: {cropImportStatusSummary.skipped}</li>
            <li>rejected: {cropImportStatusSummary.rejected}</li>
          </ul>
        </section>
      ) : null}
      {cropPlanImportStatusSummary ? (
        <section>
          <h3>Crop Plan Import Summary</h3>
          <ul>
            <li>imported: {cropPlanImportStatusSummary.imported}</li>
            <li>merged: {cropPlanImportStatusSummary.merged}</li>
            <li>skipped: {cropPlanImportStatusSummary.skipped}</li>
            <li>rejected: {cropPlanImportStatusSummary.rejected}</li>
          </ul>
        </section>
      ) : null}

      {segmentImportStatusSummary ? (
        <section>
          <h3>Segment Import Summary</h3>
          <ul>
            <li>imported: {segmentImportStatusSummary.imported}</li>
            <li>merged: {segmentImportStatusSummary.merged}</li>
            <li>skipped (identical_segment): {segmentImportStatusSummary.skipped}</li>
            <li>rejected (segment_identity_conflict): {segmentImportStatusSummary.rejected}</li>
          </ul>
        </section>
      ) : null}
      {importMessage ? <p>{importMessage}</p> : null}
      {importErrors.length > 0 ? (
        <ul>
          {importErrors.map((error, index) => (
            <li key={`${error.path}-${index}`}>
              <code>{error.path}</code>: {error.message}
            </li>
          ))}
        </ul>
      ) : null}
      {showDevResetButton ? (
        <button type="button" onClick={onResetToGoldenDataset}>
          Reset to golden dataset
        </button>
      ) : null}
    </>
  );
}

function ImportBatchesDeepLinkRoute() {
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  search.set('importType', 'batches');
  return <Navigate to={`/data?${search.toString()}`} replace />;
}

function ImportCropsDeepLinkRoute() {
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  search.set('importType', 'crops');
  return <Navigate to={`/data?${search.toString()}`} replace />;
}

function ImportCropPlansDeepLinkRoute() {
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  search.set('importType', 'crop-plans');
  return <Navigate to={`/data?${search.toString()}`} replace />;
}

function ImportSegmentsDeepLinkRoute() {
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  search.set('importType', 'segments');
  return <Navigate to={`/data?${search.toString()}`} replace />;
}

function App() {
  const [storageError, setStorageError] = useState<string | null>(null);
  const [isInitializingStorage, setIsInitializingStorage] = useState(true);
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const isDevResetEnabled =
    env?.VITE_ENABLE_DEV_RESET === 'true' || processEnv?.VITE_ENABLE_DEV_RESET === 'true';
  const isTestEnvironment = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent);
  const mainContentRef = useRef<HTMLElement | null>(null);
  const location = useLocation();

  const initializeStorage = useCallback(async () => {
    setIsInitializingStorage(true);
    setStorageError(null);

    try {
      await initializeAppStateStorage();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to initialize local data storage.';
      setStorageError(message);
    } finally {
      setIsInitializingStorage(false);
    }
  }, []);

  useEffect(() => {
    void initializeStorage();
  }, [initializeStorage]);

  useEffect(() => {
    const focusTarget = mainContentRef.current?.querySelector<HTMLElement>('[data-route-focus], h2, h1');
    if (!focusTarget) {
      return;
    }

    if (!focusTarget.hasAttribute('tabindex')) {
      focusTarget.setAttribute('tabindex', '-1');
    }

    focusTarget.focus();
  }, [location.pathname]);

  const handleReset = useCallback(async () => {
    setIsInitializingStorage(true);

    try {
      await resetToGoldenDataset();
      await initializeStorage();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to reset local data storage.';
      setStorageError(message);
      setIsInitializingStorage(false);
    }
  }, [initializeStorage]);

  if (isInitializingStorage && !isTestEnvironment) {
    return (
      <div className="storage-error-screen" role="status" aria-live="polite">
        <h1>Starting SurvivalGarden…</h1>
        <p>Preparing local data storage.</p>
      </div>
    );
  }

  if (storageError) {
    return (
      <div className="storage-error-screen" role="alert">
        <h1>Local storage unavailable</h1>
        <p>{storageError}</p>
        <p>Try again, or reset local data if migration is blocked or corrupted.</p>
        <div className="storage-error-actions">
          <button type="button" onClick={() => void initializeStorage()}>
            Retry
          </button>
          <button type="button" onClick={() => void handleReset()}>
            Reset to golden dataset
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>SurvivalGarden</h1>
      </header>

      <main className="app-content" ref={mainContentRef}>
        <Routes>
          <Route path="/" element={<Navigate to="/beds" replace />} />
          <Route path="/beds" element={<BedsPage />} />
          <Route path="/beds/:bedId" element={<BedDetailPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/batches" element={<BatchesPage />} />
          <Route path="/batches/:batchId" element={<BatchDetailPage />} />
          <Route path="/nutrition" element={<NutritionPage />} />
          <Route path="/seed-inventory" element={<SeedInventoryPage />} />
          <Route
            path="/data"
            element={
              <DataPage
                showDevResetButton={isDevResetEnabled}
                onResetToGoldenDataset={() => {
                  void handleReset();
                }}
              />
            }
          />
          <Route path="/import-batches" element={<ImportBatchesDeepLinkRoute />} />
          <Route path="/import-crops" element={<ImportCropsDeepLinkRoute />} />
          <Route path="/import-crop-plans" element={<ImportCropPlansDeepLinkRoute />} />
          <Route path="/import-segments" element={<ImportSegmentsDeepLinkRoute />} />
          <Route path="*" element={<Navigate to="/beds" replace />} />
        </Routes>
      </main>

      <nav className="tab-nav" aria-label="Primary">
        <NavLink to="/beds">Beds</NavLink>
        <NavLink to="/calendar">Calendar</NavLink>
        <NavLink to="/batches">Batches</NavLink>
        <NavLink to="/nutrition">Nutrition</NavLink>
        <NavLink to="/seed-inventory">Seeds</NavLink>
        <NavLink to="/data">Data</NavLink>
      </nav>
    </div>
  );
}

export default App;
