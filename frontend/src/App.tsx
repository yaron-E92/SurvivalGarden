import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { AppState, Batch, BatchConfidence, Bed, Crop, CropPlan, SeedInventoryItem, Segment, Species, Task } from './contracts';

import {
  generateCalendarTasksWithDiagnostics,
  SchemaValidationError,
  createEmptyAppState,
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
import { normalizeBatchCandidate } from './data/repos/batchRepository';
import { applyStageEvent, canTransition, inferBatchStartMethod } from './domain';

type CultivarRecord = {
  cultivarId: string;
  cropTypeId: string;
  name: string;
  supplier?: string;
  source?: string;
  year?: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

type AppStateWithCultivars = AppState & { cultivars?: CultivarRecord[] };

type BatchPhoto = {
  id: string;
  storageRef: string;
  capturedAt?: string;
  contentType?: string;
  filename?: string;
  caption?: string;
};

type BatchWithPhotos = Batch & { photos?: BatchPhoto[] };

type BatchDraftState = {
  editingBatchId: string | null;
  formValues: {
    cropInput: string;
    startedAt: string;
    seedCountPlanned: string;
    seedCountGerminated: string;
    seedCountGerminatedConfidence: string;
    plantCountAlive: string;
    plantCountAliveConfidence: string;
    initialMethod: string;
  };
};

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
  const [activeFormKey, setActiveFormKey] = useState<string | null>(null);
  const [formSegmentId, setFormSegmentId] = useState('');
  const [formName, setFormName] = useState('');
  const [formType, setFormType] = useState('vegetable_bed');
  const [formX, setFormX] = useState('0');
  const [formY, setFormY] = useState('0');
  const [formWidth, setFormWidth] = useState('1');
  const [formHeight, setFormHeight] = useState('1');
  const [formSurface, setFormSurface] = useState('');
  const [formKind, setFormKind] = useState('');
  const [savingEntityKey, setSavingEntityKey] = useState<string | null>(null);
  const [deletingEntityKey, setDeletingEntityKey] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const syncLocalLayoutState = useCallback((appState: AppState | null) => {
    if (!appState) {
      setBeds([]);
      setBatches([]);
      setSegments([]);
      return;
    }

    setBeds([...listBedsFromAppState(appState)].sort((left, right) => left.bedId.localeCompare(right.bedId)));
    setBatches(listBatchesFromAppState(appState));
    setSegments(appState.segments ?? []);
  }, []);

  const reloadPersistedLayoutState = useCallback(async () => {
    const persistedState = await loadAppStateFromIndexedDb();
    syncLocalLayoutState(persistedState);
    return persistedState;
  }, [syncLocalLayoutState]);

  const persistLayoutState = useCallback(async (nextState: AppState, successMessage: string) => {
    await saveAppStateToIndexedDb(nextState);
    const persistedState = await reloadPersistedLayoutState();

    if (!persistedState) {
      throw new Error('Layout changes could not be reloaded after saving.');
    }

    setActionMessage(successMessage);
    return persistedState;
  }, [reloadPersistedLayoutState]);

  useEffect(() => {
    const load = async () => {
      try {
        await reloadPersistedLayoutState();
      } catch (error) {
        setActionMessage(error instanceof Error ? error.message : 'Failed to load saved layout data.');
      } finally {
        setIsLoading(false);
      }
    };

    void load();
  }, [reloadPersistedLayoutState]);

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

  const toNumberField = (value: string): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const getDefaultGardenId = useCallback(
    (appState: AppState) => (appState.segments ?? []).flatMap((segment) => segment.beds)[0]?.gardenId ?? beds[0]?.gardenId ?? 'garden_001',
    [beds],
  );

  const openSegmentForm = useCallback((segment?: Segment) => {
    setActionMessage(null);
    setActiveFormKey(segment ? `segment:${segment.segmentId}` : 'segment:new');
    setFormSegmentId(segment?.segmentId ?? '');
    setFormName(segment?.name ?? '');
    setFormKind(segment?.kind ?? '');
    setFormWidth(String(segment?.width ?? segment?.widthM ?? 1));
    setFormHeight(String(segment?.height ?? segment?.lengthM ?? 1));
    setFormX('0');
    setFormY('0');
    setFormSurface('');
    setFormType('vegetable_bed');
  }, []);

  const openBedForm = useCallback((segmentId?: string, bed?: Segment['beds'][number]) => {
    const nextSegmentId = segmentId ?? bed?.segmentId ?? segments[0]?.segmentId ?? '';
    setActionMessage(null);
    setActiveFormKey(bed ? `bed:${nextSegmentId}:${bed.bedId}` : 'bed:new');
    setFormSegmentId(nextSegmentId);
    setFormName(bed?.name ?? '');
    setFormType(bed?.type ?? 'vegetable_bed');
    setFormX(String(bed?.x ?? 0));
    setFormY(String(bed?.y ?? 0));
    setFormWidth(String(bed?.width ?? bed?.widthM ?? 1));
    setFormHeight(String(bed?.height ?? bed?.lengthM ?? 1));
    setFormSurface('');
    setFormKind('');
  }, [segments]);

  const openPathForm = useCallback((segmentId?: string, path?: Segment['paths'][number]) => {
    const nextSegmentId = segmentId ?? path?.segmentId ?? segments[0]?.segmentId ?? '';
    setActionMessage(null);
    setActiveFormKey(path ? `path:${nextSegmentId}:${path.pathId}` : 'path:new');
    setFormSegmentId(nextSegmentId);
    setFormName(path?.name ?? '');
    setFormX(String(path?.x ?? 0));
    setFormY(String(path?.y ?? 0));
    setFormWidth(String(path?.width ?? path?.widthM ?? 1));
    setFormHeight(String(path?.height ?? path?.lengthM ?? 1));
    setFormSurface(path?.surface ?? '');
    setFormType('vegetable_bed');
    setFormKind('');
  }, [segments]);

  const closeForm = useCallback(() => {
    setActiveFormKey(null);
    setSavingEntityKey(null);
  }, []);

  const handleSaveEntity = useCallback(async () => {
    if (!activeFormKey || savingEntityKey) {
      return;
    }

    const currentState = (await loadAppStateFromIndexedDb()) ?? createEmptyAppState(null);
    const now = new Date().toISOString();
    const [kind, entityIdOrMode, existingEntityId] = activeFormKey.split(':');
    const isCreate = entityIdOrMode === 'new';

    if (!entityIdOrMode || ((kind === 'bed' || kind === 'path') && !isCreate && !existingEntityId)) {
      setActionMessage('Unable to determine which layout record to save.');
      return;
    }
    const x = toNumberField(formX);
    const y = toNumberField(formY);
    const width = toNumberField(formWidth);
    const height = toNumberField(formHeight);

    if (!formName.trim()) {
      setActionMessage('Name is required.');
      return;
    }

    if (kind !== 'segment' && !formSegmentId) {
      setActionMessage(`Select a parent segment before saving this ${kind}.`);
      return;
    }

    if (kind === 'segment') {
      if (width === null || height === null || width <= 0 || height <= 0) {
        setActionMessage('Segment width and height must be positive numbers.');
        return;
      }
    } else if (x === null || y === null || width === null || height === null || x < 0 || y < 0 || width <= 0 || height <= 0) {
      setActionMessage('X, Y, width, and height must be valid numbers. Width and height must be greater than zero.');
      return;
    }

    setActionMessage(null);
    setSavingEntityKey(activeFormKey);

    try {
      let nextSegments = currentState.segments ?? [];

      if (kind === 'segment') {
        if (isCreate) {
          nextSegments = [
            ...nextSegments,
            {
              segmentId: `segment-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
              name: formName.trim(),
              ...(formKind.trim() ? { kind: formKind.trim() } : {}),
              width,
              widthM: width,
              height,
              lengthM: height,
              beds: [],
              paths: [],
            },
          ];
        } else {
          nextSegments = nextSegments.map((segment) =>
            segment.segmentId === entityIdOrMode
              ? (() => {
                  const segmentWithoutKind = { ...segment };
                  delete segmentWithoutKind.kind;

                  return {
                    ...segmentWithoutKind,
                    name: formName.trim(),
                    ...(formKind.trim() ? { kind: formKind.trim() } : {}),
                    width,
                    widthM: width,
                    height,
                    lengthM: height,
                  };
                })()
              : segment,
          );
        }
      }

      if (kind === 'bed') {
        const bedId = isCreate ? `bed-${globalThis.crypto?.randomUUID?.() ?? Date.now()}` : existingEntityId!;
        nextSegments = nextSegments.map((segment) => {
          if (segment.segmentId !== formSegmentId) {
            if (!isCreate && segment.segmentId === entityIdOrMode) {
              return {
                ...segment,
                beds: segment.beds.filter((bed) => bed.bedId !== existingEntityId),
              };
            }

            return segment;
          }

          const nextBed: Segment['beds'][number] = {
            ...(isCreate ? {} : segment.beds.find((bed) => bed.bedId === existingEntityId)),
            bedId,
            segmentId: formSegmentId,
            gardenId: getDefaultGardenId(currentState),
            name: formName.trim(),
            type: formType as Segment['beds'][number]['type'],
            x: x ?? 0,
            y: y ?? 0,
            width,
            widthM: width,
            height,
            lengthM: height,
            createdAt: isCreate ? now : segment.beds.find((bed) => bed.bedId === existingEntityId)?.createdAt ?? now,
            updatedAt: now,
          };

          const nextBeds = isCreate
            ? [...segment.beds, nextBed]
            : segment.beds.some((bed) => bed.bedId === existingEntityId)
              ? segment.beds.map((bed) => (bed.bedId === existingEntityId ? nextBed : bed))
              : [...segment.beds, nextBed];

          return {
            ...segment,
            beds: nextBeds,
          };
        });
      }

      if (kind === 'path') {
        const pathId = isCreate ? `path-${globalThis.crypto?.randomUUID?.() ?? Date.now()}` : existingEntityId!;
        nextSegments = nextSegments.map((segment) => {
          if (segment.segmentId !== formSegmentId) {
            if (!isCreate && segment.segmentId === entityIdOrMode) {
              return {
                ...segment,
                paths: segment.paths.filter((path) => path.pathId !== existingEntityId),
              };
            }

            return segment;
          }

          const nextPath: Segment['paths'][number] = {
            ...(() => {
              const existingPath = isCreate ? null : segment.paths.find((path) => path.pathId === existingEntityId);
              if (!existingPath) {
                return {};
              }

              const pathWithoutSurface = { ...existingPath };
              delete pathWithoutSurface.surface;
              return pathWithoutSurface;
            })(),
            pathId,
            segmentId: formSegmentId,
            name: formName.trim(),
            x: x ?? 0,
            y: y ?? 0,
            width,
            widthM: width,
            height,
            lengthM: height,
            ...(formSurface.trim() ? { surface: formSurface.trim() } : {}),
          };

          const nextPaths = isCreate
            ? [...segment.paths, nextPath]
            : segment.paths.some((path) => path.pathId === existingEntityId)
              ? segment.paths.map((path) => (path.pathId === existingEntityId ? nextPath : path))
              : [...segment.paths, nextPath];

          return {
            ...segment,
            paths: nextPaths,
          };
        });
      }

      const nextState = assertValid('appState', {
        ...currentState,
        segments: nextSegments,
      });

      await persistLayoutState(nextState, `${kind === 'segment' ? 'Segment' : kind === 'bed' ? 'Bed' : 'Path'} saved.`);
      closeForm();
    } catch (error) {
      if (error instanceof SchemaValidationError) {
        const firstIssue = error.issues[0];
        setActionMessage(firstIssue ? `Validation failed: ${firstIssue.message}` : 'Validation failed.');
      } else {
        setActionMessage(error instanceof Error ? error.message : 'Failed to save changes.');
      }
    } finally {
      setSavingEntityKey(null);
    }
  }, [activeFormKey, closeForm, formHeight, formKind, formName, formSegmentId, formSurface, formType, formWidth, formX, formY, getDefaultGardenId, persistLayoutState, savingEntityKey]);

  const getReferenceCounts = useCallback((appState: AppState, bedId: string) => {
    const relatedPlanCount = appState.cropPlans.filter((plan) => plan.bedId === bedId).length;
    const relatedTaskCount = appState.tasks.filter((task) => task.bedId === bedId).length;
    const relatedBatchCount = appState.batches.filter((batch) => {
      const primaryAssignments = batch.assignments ?? [];
      const legacyAssignments = batch.bedAssignments ?? [];
      return [...primaryAssignments, ...legacyAssignments].some((assignment) => assignment.bedId === bedId);
    }).length;

    return { relatedPlanCount, relatedTaskCount, relatedBatchCount };
  }, []);

  const handleDeleteEntity = useCallback(async (entityKey: string) => {
    if (deletingEntityKey) {
      return;
    }

    setActionMessage(null);

    try {
      const appState = await loadAppStateFromIndexedDb();
      if (!appState) {
        setActionMessage('Unable to delete because local app state is unavailable.');
        return;
      }

      const [kind, segmentId, entityId] = entityKey.split(':');
      if (!segmentId || ((kind === 'bed' || kind === 'path') && !entityId)) {
        setActionMessage('Unable to determine which layout record to delete.');
        return;
      }

      let nextSegments = appState.segments ?? [];
      let confirmMessage = '';

      if (kind === 'segment') {
        const targetSegment = nextSegments.find((segment) => segment.segmentId === segmentId);
        if (!targetSegment) {
          setActionMessage(`Segment ${segmentId} was not found.`);
          return;
        }

        const blockingReasons = targetSegment.beds.flatMap((bed) => {
          const counts = getReferenceCounts(appState, bed.bedId);
          return counts.relatedPlanCount > 0 || counts.relatedTaskCount > 0 || counts.relatedBatchCount > 0
            ? [
                `${bed.bedId} (${[
                  counts.relatedPlanCount > 0 ? `${counts.relatedPlanCount} crop plan${counts.relatedPlanCount === 1 ? '' : 's'}` : null,
                  counts.relatedBatchCount > 0 ? `${counts.relatedBatchCount} batch assignment${counts.relatedBatchCount === 1 ? '' : 's'}` : null,
                  counts.relatedTaskCount > 0 ? `${counts.relatedTaskCount} task${counts.relatedTaskCount === 1 ? '' : 's'}` : null,
                ].filter(Boolean).join(', ')})`,
              ]
            : [];
        });

        if (blockingReasons.length > 0) {
          setActionMessage(`Cannot delete segment ${segmentId} because child beds are still referenced: ${blockingReasons.join('; ')}.`);
          return;
        }

        confirmMessage = `Delete segment ${segmentId} and its ${targetSegment.beds.length} bed(s) plus ${targetSegment.paths.length} path(s)? This action cannot be undone.`;
        nextSegments = nextSegments.filter((segment) => segment.segmentId !== segmentId);
      }

      if (kind === 'bed') {
        const counts = getReferenceCounts(appState, entityId!);
        const blockingReasons = [
          counts.relatedPlanCount > 0 ? `${counts.relatedPlanCount} crop plan${counts.relatedPlanCount === 1 ? '' : 's'}` : null,
          counts.relatedBatchCount > 0 ? `${counts.relatedBatchCount} batch assignment${counts.relatedBatchCount === 1 ? '' : 's'}` : null,
          counts.relatedTaskCount > 0 ? `${counts.relatedTaskCount} task${counts.relatedTaskCount === 1 ? '' : 's'}` : null,
        ].filter(Boolean);

        if (blockingReasons.length > 0) {
          setActionMessage(`Cannot delete bed ${entityId} because it is referenced by ${blockingReasons.join(', ')}.`);
          return;
        }

        confirmMessage = `Delete bed ${entityId} from segment ${segmentId}? This action cannot be undone.`;
        nextSegments = nextSegments.map((segment) =>
          segment.segmentId === segmentId ? { ...segment, beds: segment.beds.filter((bed) => bed.bedId !== entityId) } : segment,
        );
      }

      if (kind === 'path') {
        const counts = getReferenceCounts(appState, entityId!);
        const blockingReasons = [
          counts.relatedPlanCount > 0 ? `${counts.relatedPlanCount} crop plan${counts.relatedPlanCount === 1 ? '' : 's'}` : null,
          counts.relatedBatchCount > 0 ? `${counts.relatedBatchCount} batch assignment${counts.relatedBatchCount === 1 ? '' : 's'}` : null,
          counts.relatedTaskCount > 0 ? `${counts.relatedTaskCount} task${counts.relatedTaskCount === 1 ? '' : 's'}` : null,
        ].filter(Boolean);

        if (blockingReasons.length > 0) {
          setActionMessage(`Cannot delete path ${entityId} because it is referenced by ${blockingReasons.join(', ')}.`);
          return;
        }

        confirmMessage = `Delete path ${entityId} from segment ${segmentId}? This action cannot be undone.`;
        nextSegments = nextSegments.map((segment) =>
          segment.segmentId === segmentId ? { ...segment, paths: segment.paths.filter((path) => path.pathId !== entityId) } : segment,
        );
      }

      if (!window.confirm(confirmMessage)) {
        return;
      }

      setDeletingEntityKey(entityKey);

      const nextState = assertValid('appState', {
        ...appState,
        segments: nextSegments,
      });

      await persistLayoutState(
        nextState,
        kind === 'path'
          ? `Deleted path ${entityId}.`
          : kind === 'bed'
            ? 'Bed deleted.'
            : 'Segment deleted.',
      );
      if (activeFormKey === entityKey || activeFormKey?.startsWith(`${kind}:${segmentId}:${entityId}`) || activeFormKey === `segment:${segmentId}`) {
        closeForm();
      }
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : 'Failed to delete entity.');
    } finally {
      setDeletingEntityKey(null);
    }
  }, [activeFormKey, closeForm, deletingEntityKey, getReferenceCounts, persistLayoutState]);

  const hasAnyLayoutRecords = segments.length > 0 || totalSegmentBedCount > 0 || totalPathCount > 0;

  return (
    <section className="beds-page">
      <h2>Beds</h2>
      {!isLoading ? (
        <p className="beds-page-summary">
          Segments: {segments.length} · Beds: {totalSegmentBedCount} · Paths: {totalPathCount}
        </p>
      ) : null}
      {!isLoading ? (
        <div>
          <button type="button" onClick={() => openSegmentForm()} disabled={Boolean(savingEntityKey) || Boolean(deletingEntityKey)}>
            Add segment
          </button>{' '}
          <button
            type="button"
            onClick={() => openBedForm(segments[0]?.segmentId)}
            disabled={segments.length === 0 || Boolean(savingEntityKey) || Boolean(deletingEntityKey)}
          >
            Add bed
          </button>{' '}
          <button
            type="button"
            onClick={() => openPathForm(segments[0]?.segmentId)}
            disabled={segments.length === 0 || Boolean(savingEntityKey) || Boolean(deletingEntityKey)}
          >
            Add path
          </button>
        </div>
      ) : null}
      {!isLoading && segments.length === 0 ? <p className="beds-empty-state">Add a segment to start planning beds and paths.</p> : null}
      {!isLoading && actionMessage ? <p className="beds-empty-state">{actionMessage}</p> : null}
      {!isLoading && activeFormKey ? (
        <section>
          <h3>
            {activeFormKey.startsWith('segment:') ? (activeFormKey === 'segment:new' ? 'Add segment' : 'Edit segment') : null}
            {activeFormKey.startsWith('bed:') ? (activeFormKey === 'bed:new' ? 'Add bed' : 'Edit bed') : null}
            {activeFormKey.startsWith('path:') ? (activeFormKey === 'path:new' ? 'Add path' : 'Edit path') : null}
          </h3>
          {(activeFormKey.startsWith('bed:') || activeFormKey.startsWith('path:')) && segments.length > 0 ? (
            <label>
              Segment
              <select value={formSegmentId} onChange={(event) => setFormSegmentId(event.target.value)} disabled={Boolean(savingEntityKey)}>
                {segments.map((segment) => (
                  <option key={segment.segmentId} value={segment.segmentId}>
                    {segment.name} ({segment.segmentId})
                  </option>
                ))}
              </select>
            </label>
          ) : null}{' '}
          <label>
            Name
            <input value={formName} onChange={(event) => setFormName(event.target.value)} disabled={Boolean(savingEntityKey)} />
          </label>{' '}
          {activeFormKey.startsWith('segment:') ? (
            <>
              <label>
                Kind
                <input value={formKind} onChange={(event) => setFormKind(event.target.value)} disabled={Boolean(savingEntityKey)} />
              </label>{' '}
            </>
          ) : null}
          {activeFormKey.startsWith('bed:') ? (
            <>
              <label>
                Type
                <select value={formType} onChange={(event) => setFormType(event.target.value)} disabled={Boolean(savingEntityKey)}>
                  <option value="vegetable_bed">vegetable_bed</option>
                  <option value="perennial_bed">perennial_bed</option>
                  <option value="ecology_strip">ecology_strip</option>
                </select>
              </label>{' '}
            </>
          ) : null}
          {!activeFormKey.startsWith('segment:') ? (
            <>
              <label>
                X
                <input value={formX} onChange={(event) => setFormX(event.target.value)} disabled={Boolean(savingEntityKey)} />
              </label>{' '}
              <label>
                Y
                <input value={formY} onChange={(event) => setFormY(event.target.value)} disabled={Boolean(savingEntityKey)} />
              </label>{' '}
            </>
          ) : null}
          <label>
            Width
            <input value={formWidth} onChange={(event) => setFormWidth(event.target.value)} disabled={Boolean(savingEntityKey)} />
          </label>{' '}
          <label>
            Height
            <input value={formHeight} onChange={(event) => setFormHeight(event.target.value)} disabled={Boolean(savingEntityKey)} />
          </label>{' '}
          {activeFormKey.startsWith('path:') ? (
            <>
              <label>
                Surface
                <input value={formSurface} onChange={(event) => setFormSurface(event.target.value)} disabled={Boolean(savingEntityKey)} />
              </label>{' '}
            </>
          ) : null}
          <button type="button" onClick={() => void handleSaveEntity()} disabled={Boolean(savingEntityKey)}>
            {savingEntityKey ? 'Saving…' : 'Save'}
          </button>{' '}
          <button type="button" onClick={() => closeForm()} disabled={Boolean(savingEntityKey)}>Cancel</button>
        </section>
      ) : null}
      {!isLoading && segments.length > 0 ? (
        <section>
          <h3>Segment child entities</h3>
          {segments.map((segment) => (
            <article key={segment.segmentId}>
              <p>{segment.name} ({segment.segmentId})</p>
              <p>{(segment.width ?? segment.widthM)}×{(segment.height ?? segment.lengthM)}{segment.kind ? ` · ${segment.kind}` : ''}</p>
              <button type="button" onClick={() => openSegmentForm(segment)} disabled={Boolean(savingEntityKey) || Boolean(deletingEntityKey)}>
                Edit segment
              </button>{' '}
              <button
                type="button"
                onClick={() => void handleDeleteEntity(`segment:${segment.segmentId}`)}
                disabled={Boolean(savingEntityKey) || Boolean(deletingEntityKey)}
              >
                {deletingEntityKey === `segment:${segment.segmentId}` ? 'Deleting…' : 'Delete segment'}
              </button>{' '}
              <button type="button" onClick={() => openBedForm(segment.segmentId)} disabled={Boolean(savingEntityKey) || Boolean(deletingEntityKey)}>
                Add bed
              </button>{' '}
              <button type="button" onClick={() => openPathForm(segment.segmentId)} disabled={Boolean(savingEntityKey) || Boolean(deletingEntityKey)}>
                Add path
              </button>
              <p>Beds</p>
              {segment.beds.length === 0 ? <p>No beds.</p> : (
                <ul>
                  {segment.beds.map((bed) => (
                    <li key={bed.bedId}>
                      <span>{bed.name} ({bed.bedId}) · {bed.type} · {bed.width}×{bed.height} @ {bed.x},{bed.y}</span>{' '}
                      <button type="button" onClick={() => openBedForm(segment.segmentId, bed)} disabled={Boolean(savingEntityKey) || Boolean(deletingEntityKey)}>
                        Edit bed
                      </button>{' '}
                      <button
                        type="button"
                        onClick={() => void handleDeleteEntity(`bed:${segment.segmentId}:${bed.bedId}`)}
                        disabled={Boolean(savingEntityKey) || Boolean(deletingEntityKey)}
                      >
                        {deletingEntityKey === `bed:${segment.segmentId}:${bed.bedId}` ? 'Deleting…' : 'Delete bed'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p>Paths</p>
              {segment.paths.length === 0 ? <p>No paths.</p> : (
                <ul>
                  {segment.paths.map((path) => (
                    <li key={path.pathId}>
                      <span>{path.name} ({path.pathId}) · {path.width}×{path.height} @ {path.x},{path.y}</span>{' '}
                      <button type="button" onClick={() => openPathForm(segment.segmentId, path)} disabled={Boolean(savingEntityKey) || Boolean(deletingEntityKey)}>
                        Edit path
                      </button>{' '}
                      <button
                        type="button"
                        onClick={() => void handleDeleteEntity(`path:${segment.segmentId}:${path.pathId}`)}
                        disabled={Boolean(savingEntityKey) || Boolean(deletingEntityKey)}
                      >
                        {deletingEntityKey === `path:${segment.segmentId}:${path.pathId}` ? 'Deleting…' : 'Delete path'}
                      </button>
                    </li>
                  ))}
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
      {!isLoading && !hasAnyLayoutRecords ? <p className="beds-empty-state">No beds found.</p> : null}
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
  const [cultivarsById, setCultivarsById] = useState<Record<string, CultivarRecord>>({});
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
        setCultivarsById({});
        setIsLoading(false);
        return;
      }

      setCropNames(Object.fromEntries(appState.crops.map((crop) => [crop.cropId, crop.name])));
      setCropScientificNames(
        Object.fromEntries(
          appState.crops.map((crop) => [crop.cropId, getCropSpeciesScientificName(crop, buildSpeciesLookup(appState.species))]),
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
      setCultivarsById(Object.fromEntries(getCultivarsFromAppState(appState).map((cultivar) => [cultivar.cultivarId, cultivar])));

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
    selectedAssignBatch &&
    cropHasTaskRules[getBatchCultivarDisplay({ batch: selectedAssignBatch, cultivarsById, cropNames, cropScientificNames }).capabilityCropId] === false
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

      const nextSegments = (appState.segments ?? []).map((segment) => {
        const nextBeds = segment.beds.filter((segmentBed) => segmentBed.bedId !== bedId);
        return nextBeds.length === segment.beds.length ? segment : { ...segment, beds: nextBeds };
      });

      const nextState = {
        ...appState,
        segments: nextSegments,
        beds: [],
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
            {batches.map((batch) => {
              const batchDisplay = getBatchCultivarDisplay({
                batch,
                cultivarsById,
                cropNames,
                cropScientificNames,
              });

              return (
                <li key={batch.batchId}>
                <div className="bed-detail-batch-head">
                  <Link to={`/batches/${batch.batchId}`}>
                    <CropIdentityLabel cropId={batchDisplay.identityId} name={batchDisplay.name} scientificName={batchDisplay.scientificName} />
                  </Link>
                  <span className="crop-capability-badges" aria-label="Crop capabilities">
                    {getCropCapabilityLabels({
                      isUserDefined: userDefinedCropIds[batchDisplay.capabilityCropId],
                      hasTaskRules: cropHasTaskRules[batchDisplay.capabilityCropId],
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
              );
            })}
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
              {candidateBatches.map((batch) => {
                const batchDisplay = getBatchCultivarDisplay({
                  batch,
                  cultivarsById,
                  cropNames,
                  cropScientificNames,
                });

                return (
                  <option key={batch.batchId} value={batch.batchId}>
                    {formatCropOptionLabel({
                      cropId: batchDisplay.identityId,
                      name: batchDisplay.name,
                      scientificName: batchDisplay.scientificName,
                    }) || batch.batchId}
                  </option>
                );
              })}
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
      setBedNames(Object.fromEntries(listBedsFromAppState(appState).map((bed) => [bed.bedId, bed.name])));
      setCropNames(Object.fromEntries(appState.crops.map((crop) => [crop.cropId, crop.name])));
      setCropScientificNames(
        Object.fromEntries(
          appState.crops.map((crop) => [crop.cropId, getCropSpeciesScientificName(crop, buildSpeciesLookup(appState.species))]),
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

function CultivarAdminPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [cultivars, setCultivars] = useState<CultivarRecord[]>([]);
  const [cropTypeOptions, setCropTypeOptions] = useState<Array<{ cropTypeId: string; label: string }>>([]);
  const [usageByCultivarId, setUsageByCultivarId] = useState<Record<string, { batchCount: number }>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [editingCultivarId, setEditingCultivarId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [filterCropTypeId, setFilterCropTypeId] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<Partial<Record<'name' | 'cropTypeId' | 'year', string>>>({});
  const [formValues, setFormValues] = useState({
    name: '',
    cropTypeId: '',
    supplier: '',
    source: '',
    year: '',
    notes: '',
  });
  const returnTo = searchParams.get('returnTo') ?? '';
  const sourceFlow = searchParams.get('from') ?? '';
  const prefilledCropTypeId = searchParams.get('cropTypeId') ?? '';
  const isBatchQuickCreate = sourceFlow === 'batch' && Boolean(returnTo);

  const loadCultivars = useCallback(async () => {
    const appState = await loadAppStateFromIndexedDb();

    if (!appState) {
      setCultivars([]);
      setCropTypeOptions([]);
      setUsageByCultivarId({});
      setIsLoading(false);
      return;
    }

    const speciesById = Object.fromEntries((appState.species ?? []).map((species) => [species.id, species]));
    const nextCropTypeOptions = [...appState.crops]
      .sort((left, right) => (left.name ?? left.cropId).localeCompare(right.name ?? right.cropId))
      .map((crop) => {
        const species = crop.speciesId ? speciesById[crop.speciesId] : undefined;
        const labelParts = [crop.name ?? crop.cropId];

        if (species?.commonName) {
          labelParts.push(species.commonName);
        }

        if (species?.scientificName) {
          labelParts.push(species.scientificName);
        }

        return {
          cropTypeId: crop.cropId,
          label: labelParts.join(' · '),
        };
      });

    const nextUsageByCultivarId = appState.batches.reduce<Record<string, { batchCount: number }>>((counts, batch) => {
      const cultivarId = batch.cultivarId;
      if (!cultivarId) {
        return counts;
      }

      counts[cultivarId] = {
        batchCount: (counts[cultivarId]?.batchCount ?? 0) + 1,
      };
      return counts;
    }, {});

    setCultivars(
      [...getCultivarsFromAppState(appState)].sort((left, right) => {
        const cropTypeCompare = left.cropTypeId.localeCompare(right.cropTypeId);
        if (cropTypeCompare !== 0) {
          return cropTypeCompare;
        }

        return left.name.localeCompare(right.name);
      }),
    );
    setCropTypeOptions(nextCropTypeOptions);
    setUsageByCultivarId(nextUsageByCultivarId);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void loadCultivars();
  }, [loadCultivars]);

  const resetForm = () => {
    setEditingCultivarId(null);
    setFormValues({
      name: '',
      cropTypeId: filterCropTypeId,
      supplier: '',
      source: '',
      year: '',
      notes: '',
    });
    setFormErrors({});
    setSaveMessage(null);
  };

  useEffect(() => {
    if (!editingCultivarId && filterCropTypeId) {
      setFormValues((current) => ({ ...current, cropTypeId: current.cropTypeId || filterCropTypeId }));
    }
  }, [editingCultivarId, filterCropTypeId]);

  useEffect(() => {
    if (!prefilledCropTypeId) {
      return;
    }

    setFilterCropTypeId(prefilledCropTypeId);
    setFormValues((current) => ({
      ...current,
      cropTypeId: editingCultivarId ? current.cropTypeId : current.cropTypeId || prefilledCropTypeId,
    }));
  }, [editingCultivarId, prefilledCropTypeId]);

  const filteredCultivars = useMemo(() => {
    const normalizedSearchTerm = searchTerm.trim().toLowerCase();

    return cultivars.filter((cultivar) => {
      const archived = isCultivarArchived(cultivar);
      if (!showArchived && archived) {
        return false;
      }

      if (filterCropTypeId && cultivar.cropTypeId !== filterCropTypeId) {
        return false;
      }

      if (!normalizedSearchTerm) {
        return true;
      }

      const searchHaystack = [
        cultivar.name,
        cultivar.cultivarId,
        cropTypeOptions.find((option) => option.cropTypeId === cultivar.cropTypeId)?.label ?? cultivar.cropTypeId,
        cultivar.supplier ?? '',
        cultivar.source ?? '',
        stripCultivarArchiveMarker(cultivar.notes),
      ].join(' ').toLowerCase();

      return searchHaystack.includes(normalizedSearchTerm);
    });
  }, [cultivars, cropTypeOptions, filterCropTypeId, searchTerm, showArchived]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const nextErrors: Partial<Record<'name' | 'cropTypeId' | 'year', string>> = {};
    const trimmedName = formValues.name.trim();
    const trimmedCropTypeId = formValues.cropTypeId.trim();
    const trimmedSupplier = formValues.supplier.trim();
    const trimmedSource = formValues.source.trim();
    const trimmedNotes = formValues.notes.trim();
    const parsedYear = formValues.year.trim() ? Number(formValues.year) : undefined;

    if (!trimmedName) {
      nextErrors.name = 'Cultivar name is required.';
    } else if (trimmedName.length > 120) {
      nextErrors.name = 'Cultivar name must be 120 characters or fewer.';
    }

    if (!trimmedCropTypeId) {
      nextErrors.cropTypeId = 'Crop type is required.';
    }

    if (parsedYear !== undefined && (!Number.isInteger(parsedYear) || parsedYear < 1900 || parsedYear > 2100)) {
      nextErrors.year = 'Year must be a whole number between 1900 and 2100.';
    }

    const duplicateCultivar = cultivars.find((cultivar) => cultivar.cultivarId !== editingCultivarId && cultivar.cropTypeId === trimmedCropTypeId && cultivar.name.trim().toLowerCase() === trimmedName.toLowerCase());
    if (duplicateCultivar) {
      nextErrors.name = 'A cultivar with this crop type and name already exists.';
    }

    setFormErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    setSavingId(editingCultivarId ?? 'new');

    try {
      const appState = await loadAppStateFromIndexedDb();
      if (!appState) {
        return;
      }

      const nowIso = new Date().toISOString();
      const existingCultivars = getCultivarsFromAppState(appState);
      const existingCultivar = editingCultivarId ? existingCultivars.find((cultivar) => cultivar.cultivarId === editingCultivarId) : undefined;
      const nextCultivar: CultivarRecord = {
        cultivarId: existingCultivar?.cultivarId ?? createUniqueCultivarId(trimmedName, trimmedCropTypeId, existingCultivars.map((cultivar) => cultivar.cultivarId)),
        cropTypeId: trimmedCropTypeId,
        name: trimmedName,
        ...(trimmedSupplier ? { supplier: trimmedSupplier } : {}),
        ...(trimmedSource ? { source: trimmedSource } : {}),
        ...(parsedYear !== undefined ? { year: parsedYear } : {}),
        ...(trimmedNotes ? { notes: trimmedNotes } : {}),
        createdAt: existingCultivar?.createdAt ?? nowIso,
        updatedAt: nowIso,
      };

      const nextCultivars = existingCultivars.some((cultivar) => cultivar.cultivarId === nextCultivar.cultivarId)
        ? existingCultivars.map((cultivar) => (cultivar.cultivarId === nextCultivar.cultivarId ? nextCultivar : cultivar))
        : [...existingCultivars, nextCultivar];

      await saveAppStateToIndexedDb(assertValid('appState', withCultivarsInAppState(appState, nextCultivars)));
      await loadCultivars();

      if (!existingCultivar && isBatchQuickCreate) {
        navigate(buildReturnHrefWithCultivarId(returnTo, nextCultivar.cultivarId));
        return;
      }

      resetForm();
      setSaveMessage(existingCultivar ? 'Cultivar updated.' : 'Cultivar created.');
    } finally {
      setSavingId(null);
    }
  };

  const handleArchiveToggle = async (cultivarId: string, archived: boolean) => {
    setSavingId(cultivarId);
    setSaveMessage(null);

    try {
      const appState = await loadAppStateFromIndexedDb();
      if (!appState) {
        return;
      }

      const nowIso = new Date().toISOString();
      const nextCultivars = getCultivarsFromAppState(appState).map((cultivar) => (
        cultivar.cultivarId === cultivarId ? withCultivarArchiveState(cultivar, archived, nowIso) : cultivar
      ));

      await saveAppStateToIndexedDb(assertValid('appState', withCultivarsInAppState(appState, nextCultivars)));
      await loadCultivars();
      if (editingCultivarId === cultivarId && archived) {
        resetForm();
      }
      setSaveMessage(archived ? 'Cultivar archived.' : 'Cultivar restored.');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <section className="batches-page">
      <h2>Cultivar Admin</h2>
      <p className="batch-form-note">Manage reusable cultivar records independently from batches. Each cultivar must belong to a crop type so batch and inventory workflows can link back to the same named variety.</p>
      <nav className="batch-form-actions" aria-label="Cultivar admin entry points">
        <Link to="/taxonomy">Hierarchy overview</Link>
        <Link to="/taxonomy/crop-types">Crop types</Link>
        <Link to="/batches#create-batch">Batch form</Link>
        <Link to="/seed-inventory">Seed inventory</Link>
        {isBatchQuickCreate ? <Link to={returnTo}>Back to batch draft</Link> : null}
      </nav>

      <form id="create-cultivar" className="batch-form" onSubmit={(event) => void handleSubmit(event)}>
        <h3>{editingCultivarId ? 'Edit cultivar' : 'Create cultivar'}</h3>
        <div className="batch-form-grid">
          <label>
            Crop type
            <select
              value={formValues.cropTypeId}
              onChange={(event) => setFormValues((current) => ({ ...current, cropTypeId: event.target.value }))}
            >
              <option value="">Select crop type</option>
              {cropTypeOptions.map((option) => (
                <option key={option.cropTypeId} value={option.cropTypeId}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="batch-form-note">Required parent record. Cultivars stay scoped to one crop type.</span>
            {formErrors.cropTypeId ? <span className="form-error">{formErrors.cropTypeId}</span> : null}
          </label>

          <label>
            Cultivar name
            <input
              type="text"
              value={formValues.name}
              onChange={(event) => setFormValues((current) => ({ ...current, name: event.target.value }))}
              placeholder="Detroit Dark Red"
            />
            {formErrors.name ? <span className="form-error">{formErrors.name}</span> : null}
          </label>

          <label>
            Supplier (optional)
            <input
              type="text"
              value={formValues.supplier}
              onChange={(event) => setFormValues((current) => ({ ...current, supplier: event.target.value }))}
              placeholder="Optional"
            />
          </label>

          <label>
            Source (optional)
            <input
              type="text"
              value={formValues.source}
              onChange={(event) => setFormValues((current) => ({ ...current, source: event.target.value }))}
              placeholder="Seed library, saved seed, vendor, or import note"
            />
          </label>

          <label>
            Year (optional)
            <input
              type="number"
              min="1900"
              max="2100"
              step="1"
              value={formValues.year}
              onChange={(event) => setFormValues((current) => ({ ...current, year: event.target.value }))}
              placeholder="2026"
            />
            {formErrors.year ? <span className="form-error">{formErrors.year}</span> : null}
          </label>

          <label>
            Notes (optional)
            <textarea
              value={formValues.notes}
              onChange={(event) => setFormValues((current) => ({ ...current, notes: event.target.value }))}
              rows={3}
            />
          </label>
        </div>
        <p className="batch-form-note">Archive uses a lightweight note marker for now so the UI can hide retired cultivars without changing the persisted schema.</p>
        <div className="batch-form-actions">
          <button type="submit" disabled={savingId !== null}>{editingCultivarId ? 'Save cultivar' : 'Create cultivar'}</button>
          {editingCultivarId ? (
            <button type="button" onClick={resetForm} disabled={savingId !== null}>
              Cancel edit
            </button>
          ) : null}
          {saveMessage ? <p className="batch-form-message">{saveMessage}</p> : null}
        </div>
      </form>

      <section className="batch-form">
        <h3>Browse cultivars</h3>
        <div className="batch-form-grid">
          <label>
            Search
            <input type="search" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Name, crop type, source, or ID" />
          </label>

          <label>
            Crop type filter
            <select value={filterCropTypeId} onChange={(event) => setFilterCropTypeId(event.target.value)}>
              <option value="">All crop types</option>
              {cropTypeOptions.map((option) => (
                <option key={option.cropTypeId} value={option.cropTypeId}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            Archived cultivars
            <select value={showArchived ? 'all' : 'active'} onChange={(event) => setShowArchived(event.target.value === 'all')}>
              <option value="active">Active only</option>
              <option value="all">Include archived</option>
            </select>
          </label>
        </div>

        {isLoading ? <p className="batch-empty-state">Loading cultivars…</p> : null}
        {!isLoading && filteredCultivars.length === 0 ? <p className="batch-empty-state">No cultivars match the current filters. Create a cultivar or widen the crop type / archive filters.</p> : null}
        {!isLoading && filteredCultivars.length > 0 ? (
          <ul className="seed-inventory-list">
            {filteredCultivars.map((cultivar) => {
              const archived = isCultivarArchived(cultivar);
              const usage = usageByCultivarId[cultivar.cultivarId] ?? { batchCount: 0 };
              const cropTypeLabel = cropTypeOptions.find((option) => option.cropTypeId === cultivar.cropTypeId)?.label ?? cultivar.cropTypeId;
              const notes = stripCultivarArchiveMarker(cultivar.notes);

              return (
                <li key={cultivar.cultivarId} className="seed-inventory-row">
                  <div>
                    <p className="seed-inventory-primary">{cultivar.name}{archived ? ' · Archived' : ''}</p>
                    <p className="seed-inventory-meta">Crop type: {cropTypeLabel}</p>
                    <p className="seed-inventory-meta">Cultivar ID: {cultivar.cultivarId}</p>
                    <p className="seed-inventory-meta">Batch links: {usage.batchCount}</p>
                    {cultivar.supplier ? <p className="seed-inventory-meta">Supplier: {cultivar.supplier}</p> : null}
                    {cultivar.source ? <p className="seed-inventory-meta">Source: {cultivar.source}</p> : null}
                    {cultivar.year ? <p className="seed-inventory-meta">Year: {cultivar.year}</p> : null}
                    {notes ? <p className="seed-inventory-meta">{notes}</p> : null}
                  </div>
                  <div className="seed-inventory-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingCultivarId(cultivar.cultivarId);
                        setFormValues({
                          name: cultivar.name,
                          cropTypeId: cultivar.cropTypeId,
                          supplier: cultivar.supplier ?? '',
                          source: cultivar.source ?? '',
                          year: cultivar.year ? String(cultivar.year) : '',
                          notes,
                        });
                        setFormErrors({});
                        setSaveMessage(null);
                      }}
                      disabled={savingId !== null}
                    >
                      Edit
                    </button>
                    <button type="button" onClick={() => void handleArchiveToggle(cultivar.cultivarId, !archived)} disabled={savingId !== null}>
                      {archived ? 'Restore' : 'Archive'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
    </section>
  );
}

function SeedInventoryPage() {
  const [items, setItems] = useState<SeedInventoryItem[]>([]);
  const [cultivarsById, setCultivarsById] = useState<Record<string, CultivarRecord>>({});
  const [cropNames, setCropNames] = useState<Record<string, string>>({});
  const [speciesNames, setSpeciesNames] = useState<Record<string, string>>({});
  const [cultivarIds, setCultivarIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formValues, setFormValues] = useState({
    cultivarId: '',
    quantity: '0',
    unit: 'seeds' as SeedInventoryItem['unit'],
    notes: '',
  });

  const loadInventory = useCallback(async () => {
    const appState = await loadAppStateFromIndexedDb();

    if (!appState) {
      setItems([]);
      setCultivarsById({});
      setCropNames({});
      setSpeciesNames({});
      setCultivarIds([]);
      setIsLoading(false);
      return;
    }

    const cultivars = getCultivarsFromAppState(appState);
    const nextCultivarsById = Object.fromEntries(cultivars.map((cultivar) => [cultivar.cultivarId, cultivar]));
    const speciesById = Object.fromEntries((appState.species ?? []).map((species) => [species.id, species]));
    const getInventoryLabel = (item: SeedInventoryItem): string =>
      nextCultivarsById[item.cultivarId]?.name ?? item.variety ?? item.cultivarId;

    setItems(listSeedInventoryItemsFromAppState(appState).sort((left, right) => getInventoryLabel(left).localeCompare(getInventoryLabel(right))));
    setCultivarsById(nextCultivarsById);
    setCropNames(Object.fromEntries(appState.crops.map((crop) => [crop.cropId, crop.name])));
    setSpeciesNames(
      Object.fromEntries(
        appState.crops.map((crop) => [crop.cropId, crop.speciesId ? (speciesById[crop.speciesId]?.commonName ?? speciesById[crop.speciesId]?.scientificName ?? '') : '']),
      ),
    );
    setCultivarIds(cultivars.map((cultivar) => cultivar.cultivarId).sort((left, right) => left.localeCompare(right)));
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void loadInventory();
  }, [loadInventory]);

  const resetForm = () => {
    setEditingId(null);
    setFormValues({
      cultivarId: '',
      quantity: '0',
      unit: 'seeds',
      notes: '',
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedCultivarId = formValues.cultivarId.trim();
    if (!trimmedCultivarId) {
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
        cultivarId: trimmedCultivarId,
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
      <p className="batch-form-note">Track physical seed stock here. Use Cultivar Admin for reusable cultivar records, then record packets or saved seed lots separately in inventory.</p>
      <nav className="batch-form-actions" aria-label="Seed inventory entry points">
        <Link to="/taxonomy/cultivars#create-cultivar">Open cultivar admin</Link>
        <Link to="/taxonomy/crop-types">Crop types</Link>
      </nav>
      <form className="seed-inventory-form" onSubmit={(event) => void handleSubmit(event)}>
        <select
          value={formValues.cultivarId}
          onChange={(event) => setFormValues((current) => ({ ...current, cultivarId: event.target.value }))}
          required
        >
          <option value="">Select cultivar</option>
          {cultivarIds.map((cultivarId) => {
            const cultivar = cultivarsById[cultivarId];
            const cropTypeName = cultivar ? (cropNames[cultivar.cropTypeId] ?? cultivar.cropTypeId) : '';
            return (
              <option key={cultivarId} value={cultivarId}>
                {cultivar ? `${cultivar.name} · ${cropTypeName}` : cultivarId}
              </option>
            );
          })}
        </select>
        <input
          type="text"
          value={formValues.notes}
          onChange={(event) => setFormValues((current) => ({ ...current, notes: event.target.value }))}
          placeholder="Notes"
        />
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
          {items.map((item) => {
            const cultivar = cultivarsById[item.cultivarId];
            const cropTypeId = cultivar?.cropTypeId ?? item.cropId ?? '';
            const cropTypeName = cropTypeId ? (cropNames[cropTypeId] ?? cropTypeId) : 'Unknown crop type';
            const speciesName = cropTypeId ? speciesNames[cropTypeId] : '';
            const displayName = cultivar?.name ?? item.variety ?? item.cultivarId;

            return (
              <li key={item.seedInventoryItemId} className="seed-inventory-row">
                <div>
                  <p className="seed-inventory-primary">{displayName}</p>
                  <p className="seed-inventory-meta">
                    Crop type: {cropTypeName}
                  </p>
                  {speciesName ? (
                    <p className="seed-inventory-meta">Species: {speciesName}</p>
                  ) : null}
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
                        cultivarId: item.cultivarId,
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
            );
          })}
        </ul>
      ) : null}
      {!isLoading && items.length === 0 ? <p>No seed inventory items yet. Create cultivar records in Admin first, then track packets or saved seed here.</p> : null}
    </section>
  );
}

const getDerivedBedId = (batch: Batch): string | null => getActiveBedAssignment(batch, new Date().toISOString())?.bedId ?? null;

const BATCH_DRAFT_STORAGE_KEY = 'survival-garden.batch-draft';
const INITIAL_BATCH_METHODS = {
  sowing: { label: 'Sow', stage: 'sowing', startMethod: undefined },
  pre_sow_paper_towel: { label: 'Pre-sow (wet paper)', stage: 'sowing', startMethod: 'pre_sow_paper_towel' },
  pre_sow_indoor: { label: 'Pre-sow tray / indoor', stage: 'sowing', startMethod: 'pre_sow_indoor' },
  direct_sow: { label: 'Direct sow', stage: 'sowing', startMethod: 'direct_sow' },
  sow_indoor: { label: 'Sow indoor', stage: 'sowing', startMethod: 'sow_indoor' },
} as const;
type InitialBatchMethodKey = keyof typeof INITIAL_BATCH_METHODS;
const LEGACY_INITIAL_BATCH_METHOD_ALIASES: Record<string, InitialBatchMethodKey> = {
  'pre-sow': 'pre_sow_paper_towel',
  'sow-in-pot': 'sow_indoor',
  'sow-in-ground': 'direct_sow',
};
const SELECTABLE_INITIAL_BATCH_METHODS = (Object.entries(INITIAL_BATCH_METHODS) as Array<[
  InitialBatchMethodKey,
  (typeof INITIAL_BATCH_METHODS)[InitialBatchMethodKey],
]>).filter(([, config]) => canTransition(config.stage, 'transplant') || canTransition(config.stage, 'harvest'));
const INITIAL_BATCH_METHOD_ERROR = `This batch can only be created from lifecycle-supported start methods: ${SELECTABLE_INITIAL_BATCH_METHODS.map(([, config]) => config.label).join(', ')}.`;
const INITIAL_BATCH_LIFECYCLE_ERROR = 'The cultivar link is valid. Choose a start method/state that matches the allowed lifecycle transition for this batch.';

const getInitialBatchLifecycleError = (reason?: string): string | null => {
  if (reason === 'invalid_stage_transition' || reason === 'stage_event_stage_mismatch') {
    return INITIAL_BATCH_LIFECYCLE_ERROR;
  }

  return null;
};

const mapBatchValidationIssuesToFormErrors = (issues: Array<{ path: string; message: string }>): Record<string, string> => {
  const issueErrors: Record<string, string> = {};

  for (const issue of issues) {
    if (issue.path.includes('/cultivarId') || issue.path.includes('/cropId')) {
      issueErrors.cropInput = 'Choose a valid cultivar record.';
    }

    if (issue.path.includes('/startedAt')) {
      issueErrors.startedAt = 'Enter a valid date and time.';
    }

    if (
      issue.path.includes('/stage')
      || issue.path.includes('/startMethod')
      || issue.path.includes('/stageEvents')
      || issue.path.includes('/method')
    ) {
      issueErrors.initialMethod = INITIAL_BATCH_LIFECYCLE_ERROR;
    }
  }

  return issueErrors;
};

const buildBatchValidationIssueSummary = (issues: Array<{ path: string; message: string }>): string => {
  const details = issues.map((issue) => {
    const field = issue.path.split('/').filter(Boolean).pop() ?? 'unknown';
    return `${field}: ${issue.message}`;
  });

  return `Please fix the highlighted fields. ${details.join(' | ')}`;
};

const resolveInitialBatchMethod = (value: string): InitialBatchMethodKey | null => {
  if (value in INITIAL_BATCH_METHODS) {
    return value as InitialBatchMethodKey;
  }

  return LEGACY_INITIAL_BATCH_METHOD_ALIASES[value] ?? null;
};

const isSelectableInitialBatchMethod = (value: InitialBatchMethodKey | null): value is InitialBatchMethodKey =>
  value !== null && SELECTABLE_INITIAL_BATCH_METHODS.some(([method]) => method === value);

const normalizeInitialBatchMethod = (value: string): InitialBatchMethodKey => {
  const method = resolveInitialBatchMethod(value);
  return isSelectableInitialBatchMethod(method) ? method : 'sowing';
};

const getInitialBatchMethodForBatch = (batch: Batch): InitialBatchMethodKey => {
  const firstStageEvent = batch.stageEvents[0];
  const normalizedStartMethod = inferBatchStartMethod(
    typeof (firstStageEvent?.meta as Record<string, unknown> | undefined)?.legacyStage === 'string'
      ? (firstStageEvent?.meta as Record<string, unknown>).legacyStage as string
      : batch.stage,
    typeof batch.startMethod === 'string' && batch.startMethod.length > 0
      ? batch.startMethod
      : typeof firstStageEvent?.method === 'string'
        ? firstStageEvent.method
        : undefined,
  );

  if (normalizedStartMethod) {
    return resolveInitialBatchMethod(normalizedStartMethod) ?? 'sowing';
  }

  return 'sowing';
};

const saveBatchDraftState = (draft: BatchDraftState) => {
  try {
    globalThis.sessionStorage?.setItem(BATCH_DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Ignore draft persistence failures in unsupported environments.
  }
};

const loadBatchDraftState = (): BatchDraftState | null => {
  try {
    const raw = globalThis.sessionStorage?.getItem(BATCH_DRAFT_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<BatchDraftState>;
    if (!parsed || typeof parsed !== 'object' || !parsed.formValues || typeof parsed.formValues !== 'object') {
      return null;
    }

    return {
      editingBatchId: typeof parsed.editingBatchId === 'string' ? parsed.editingBatchId : null,
      formValues: {
        cropInput: typeof parsed.formValues.cropInput === 'string' ? parsed.formValues.cropInput : '',
        startedAt: typeof parsed.formValues.startedAt === 'string' ? parsed.formValues.startedAt : getLocalDateTimeDefault(),
        seedCountPlanned: typeof parsed.formValues.seedCountPlanned === 'string' ? parsed.formValues.seedCountPlanned : '',
        seedCountGerminated: typeof parsed.formValues.seedCountGerminated === 'string' ? parsed.formValues.seedCountGerminated : '',
        seedCountGerminatedConfidence: typeof parsed.formValues.seedCountGerminatedConfidence === 'string' ? parsed.formValues.seedCountGerminatedConfidence : '',
        plantCountAlive: typeof parsed.formValues.plantCountAlive === 'string' ? parsed.formValues.plantCountAlive : '',
        plantCountAliveConfidence: typeof parsed.formValues.plantCountAliveConfidence === 'string' ? parsed.formValues.plantCountAliveConfidence : '',
        initialMethod:
          typeof parsed.formValues.initialMethod === 'string'
            ? normalizeInitialBatchMethod(parsed.formValues.initialMethod)
            : 'sowing',
      },
    };
  } catch {
    return null;
  }
};

const clearBatchDraftState = () => {
  try {
    globalThis.sessionStorage?.removeItem(BATCH_DRAFT_STORAGE_KEY);
  } catch {
    // Ignore draft cleanup failures in unsupported environments.
  }
};

const buildReturnHrefWithCultivarId = (returnTo: string, cultivarId: string): string => {
  const url = new URL(returnTo, 'https://survival-garden.local');
  url.searchParams.set('quickCreateCultivarId', cultivarId);
  return `${url.pathname}${url.search}${url.hash}`;
};

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

const buildSpeciesLookup = (species: Species[] | undefined): Record<string, Species> =>
  Object.fromEntries((species ?? []).map((entry) => [entry.id, entry]));

const getCropSpeciesScientificName = (crop: Crop, speciesById: Record<string, Species> = {}): string => {
  const speciesId = (crop as Crop & { speciesId?: string }).speciesId;
  const speciesScientificName = speciesId ? speciesById[speciesId]?.scientificName : undefined;
  const embeddedSpeciesScientificName = (crop as Crop & { species?: { scientificName?: string } }).species?.scientificName;
  return speciesScientificName ?? embeddedSpeciesScientificName ?? (crop as { scientificName?: string }).scientificName ?? '';
};

const getCropSpeciesCommonName = (crop: Crop, speciesById: Record<string, Species> = {}): string => {
  const speciesId = (crop as Crop & { speciesId?: string }).speciesId;
  const speciesCommonName = speciesId ? speciesById[speciesId]?.commonName : undefined;
  const embeddedSpeciesCommonName = (crop as Crop & { species?: { commonName?: string } }).species?.commonName;
  return speciesCommonName ?? embeddedSpeciesCommonName ?? '';
};

const formatCropOptionLabel = (crop: { cropId: string; name: string | undefined; scientificName: string | undefined }) => {
  if (crop.name && crop.scientificName) {
    return `${crop.name} (${crop.scientificName})`;
  }

  return crop.name ?? crop.scientificName ?? crop.cropId;
};

const normalizeCropSearchValue = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[·•]/g, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();

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

const normalizeSpeciesIdInput = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 120);

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

const createUniqueSpeciesId = (name: string, existingSpeciesIds: string[]): string => {
  const base = normalizeCropIdPart(name) || `species-${Date.now()}`;
  const existing = new Set(existingSpeciesIds);
  let candidate = `species_${base}`;
  let suffix = 2;

  while (existing.has(candidate)) {
    candidate = `species_${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
};

const CULTIVAR_ARCHIVE_PREFIX = '[Archived ';

const getCultivarsFromAppState = (appState: AppState): CultivarRecord[] => {
  const cultivars = (appState as AppStateWithCultivars).cultivars;
  return Array.isArray(cultivars) ? cultivars : [];
};

const withCultivarsInAppState = (appState: AppState, cultivars: CultivarRecord[]): AppState =>
  ({
    ...(appState as AppStateWithCultivars),
    cultivars,
  }) as AppState;

const createUniqueCultivarId = (name: string, cropTypeId: string, existingCultivarIds: string[]): string => {
  const base = normalizeCropIdPart(`${cropTypeId}-${name}`) || `cultivar-${Date.now()}`;
  const existing = new Set(existingCultivarIds);
  let candidate = `cultivar_${base}`;
  let suffix = 2;

  while (existing.has(candidate)) {
    candidate = `cultivar_${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
};

const isCultivarArchived = (cultivar: CultivarRecord): boolean => typeof cultivar.notes === 'string' && cultivar.notes.startsWith(CULTIVAR_ARCHIVE_PREFIX);

const stripCultivarArchiveMarker = (notes: string | undefined): string => {
  if (!notes?.startsWith(CULTIVAR_ARCHIVE_PREFIX)) {
    return notes ?? '';
  }

  const [, ...remainingLines] = notes.split('\n');
  return remainingLines.join('\n').trim();
};

const withCultivarArchiveState = (cultivar: CultivarRecord, archived: boolean, nowIso: string): CultivarRecord => {
  const notes = stripCultivarArchiveMarker(cultivar.notes);

  if (!archived) {
    const nextCultivar: CultivarRecord = {
      ...cultivar,
      updatedAt: nowIso,
    };

    if (notes) {
      nextCultivar.notes = notes;
    } else {
      delete nextCultivar.notes;
    }

    return nextCultivar;
  }

  return {
    ...cultivar,
    notes: `${CULTIVAR_ARCHIVE_PREFIX}${nowIso}]${notes ? `\n${notes}` : ''}`,
    updatedAt: nowIso,
  };
};

const getBatchCultivarLookupId = (batch: Batch): string | null => batch.cultivarId ?? batch.cropId ?? null;

const getBatchCultivarDisplay = ({
  batch,
  cultivarsById,
  cropNames,
  cropScientificNames,
}: {
  batch: Batch;
  cultivarsById: Record<string, CultivarRecord>;
  cropNames: Record<string, string>;
  cropScientificNames: Record<string, string>;
}): {
  identityId: string;
  capabilityCropId: string;
  name?: string | undefined;
  scientificName?: string | undefined;
  cropTypeId?: string | undefined;
  cropTypeName?: string | undefined;
} => {
  const lookupId = getBatchCultivarLookupId(batch) ?? batch.batchId;
  const cultivar = cultivarsById[lookupId];
  const cropTypeId = batch.cropTypeId ?? cultivar?.cropTypeId;
  const capabilityCropId = cropTypeId ?? lookupId;

  return {
    identityId: cultivar?.cultivarId ?? lookupId,
    capabilityCropId,
    name: cultivar?.name ?? cropNames[lookupId] ?? cropNames[cropTypeId ?? ''],
    scientificName: cropScientificNames[cropTypeId ?? ''] ?? cropScientificNames[lookupId],
    cropTypeId,
    cropTypeName: cropNames[cropTypeId ?? ''],
  };
};

function BatchesPage({
  taxonomyOnly = false,
  showAdminDataSurgery = false,
  taxonomySection = 'overview',
}: {
  taxonomyOnly?: boolean;
  showAdminDataSurgery?: boolean;
  taxonomySection?: 'overview' | 'species' | 'crop-types';
}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [batches, setBatches] = useState<Batch[]>([]);
  const [cropIds, setCropIds] = useState<string[]>([]);
  const [cropNames, setCropNames] = useState<Record<string, string>>({});
  const [cropScientificNames, setCropScientificNames] = useState<Record<string, string>>({});
  const [cropAliases, setCropAliases] = useState<Record<string, string[]>>({});
  const [cropHasTaskRules, setCropHasTaskRules] = useState<Record<string, boolean>>({});
  const [userDefinedCropIds, setUserDefinedCropIds] = useState<Record<string, boolean>>({});
  const [cultivars, setCultivars] = useState<CultivarRecord[]>([]);
  const [speciesById, setSpeciesById] = useState<Record<string, Species>>({});
  const [editingSpeciesId, setEditingSpeciesId] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [editingBatchId, setEditingBatchId] = useState<string | null>(null);
  const [formValues, setFormValues] = useState({
    cropInput: '',
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
  const [cropCreateValues, setCropCreateValues] = useState({
    speciesId: '',
    cultivar: '',
    cultivarGroup: '',
    aliases: '',
    notes: '',
  });
  const [cropCreateErrors, setCropCreateErrors] = useState<Record<string, string>>({});
  const [cropCreateMessage, setCropCreateMessage] = useState<string | null>(null);
  const [editingCropId, setEditingCropId] = useState<string>('');
  const [cropEditValues, setCropEditValues] = useState({
    cultivar: '',
    cultivarGroup: '',
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
  const [speciesEditValues, setSpeciesEditValues] = useState({
    commonName: '',
    scientificName: '',
    aliases: '',
    notes: '',
  });
  const [speciesCreateValues, setSpeciesCreateValues] = useState({
    id: '',
    commonName: '',
    scientificName: '',
    aliases: '',
    notes: '',
  });
  const [speciesCreateErrors, setSpeciesCreateErrors] = useState<Record<string, string>>({});
  const [speciesCreateMessage, setSpeciesCreateMessage] = useState<string | null>(null);
  const [speciesEditErrors, setSpeciesEditErrors] = useState<Record<string, string>>({});
  const [speciesEditMessage, setSpeciesEditMessage] = useState<string | null>(null);
  const [repairSpeciesId, setRepairSpeciesId] = useState<string>('');
  const restoredBatchDraftRef = useRef(false);
  const handledQuickCreateReturnRef = useRef(false);
  const [cropRepairPreview, setCropRepairPreview] = useState<{
    currentSpeciesLabel: string;
    replacementSpeciesLabel: string;
    cropPlanCount: number;
    batchCount: number;
    auditNote: string;
    importPayload: string;
  } | null>(null);

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
        setCultivars([]);
        setSpeciesById({});
        setIsLoading(false);
        return;
      }

      const nextSpeciesById = buildSpeciesLookup(appState.species);

      setBatches(listBatchesFromAppState(appState));
      setCropIds(appState.crops.map((crop) => crop.cropId));
      setCropNames(Object.fromEntries(appState.crops.map((crop) => [crop.cropId, crop.name])));
      setCropScientificNames(
        Object.fromEntries(
          appState.crops.map((crop) => [crop.cropId, getCropSpeciesScientificName(crop, nextSpeciesById)]),
        ),
      );
      setSpeciesById(nextSpeciesById);
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
      setCultivars(getCultivarsFromAppState(appState));
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

  const cultivarsById = useMemo(
    () => Object.fromEntries(cultivars.map((cultivar) => [cultivar.cultivarId, cultivar])),
    [cultivars],
  );

  const cropOptions = useMemo(
    () =>
      Array.from(
        new Set(
          batches
            .map((batch) => batch.cropTypeId ?? cultivarsById[getBatchCultivarLookupId(batch) ?? '']?.cropTypeId)
            .filter((cropTypeId): cropTypeId is string => Boolean(cropTypeId)),
        ),
      )
        .sort((left, right) => (cropNames[left] ?? left).localeCompare(cropNames[right] ?? right))
        .map((cropId) => ({
          value: cropId,
          label: formatCropOptionLabel({
            cropId,
            name: cropNames[cropId],
            scientificName: cropScientificNames[cropId],
          }),
        })),
    [batches, cultivarsById, cropNames, cropScientificNames],
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

  const cultivarInputOptions = useMemo(
    () =>
      cultivars
        .filter((cultivar) => !isCultivarArchived(cultivar))
        .map((cultivar) => {
          const label = [
            cultivar.name,
            cropNames[cultivar.cropTypeId] ?? cultivar.cropTypeId,
            cropScientificNames[cultivar.cropTypeId],
          ]
            .filter(Boolean)
            .join(' · ');
          const suffix = cropHasTaskRules[cultivar.cropTypeId] === false
            ? ' · No rules yet'
            : userDefinedCropIds[cultivar.cropTypeId]
              ? ' · Custom crop type'
              : '';

          return {
            cultivarId: cultivar.cultivarId,
            cropTypeId: cultivar.cropTypeId,
            label,
            inputValue: `${label}${suffix ? `${suffix}` : ''} · ${cultivar.cultivarId}`,
            name: cultivar.name,
            cropTypeName: cropNames[cultivar.cropTypeId] ?? '',
            scientificName: cropScientificNames[cultivar.cropTypeId] ?? '',
            aliases: cropAliases[cultivar.cropTypeId] ?? [],
          };
        })
        .sort((left, right) => left.label.localeCompare(right.label)),
    [cultivars, cropAliases, cropHasTaskRules, cropNames, cropScientificNames, userDefinedCropIds],
  );

  const filteredBatches = useMemo(
    () =>
      batches.filter((batch) => {
        const derivedBedId = getDerivedBedId(batch);
        const batchDate = batch.startedAt.slice(0, 10);

        const batchCropTypeId = batch.cropTypeId ?? cultivarsById[getBatchCultivarLookupId(batch) ?? '']?.cropTypeId;
        if (filters.crop && batchCropTypeId !== filters.crop) {
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
    [batches, cultivarsById, filters],
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

  const resolveCultivarIdFromInput = useCallback((cropInput: string): string | null => {
    const normalizedInput = normalizeCropSearchValue(cropInput);
    if (!normalizedInput) {
      return null;
    }

    const exactMatch = cultivarInputOptions.find((option) =>
      normalizeCropSearchValue(option.cultivarId) === normalizedInput
      || normalizeCropSearchValue(option.inputValue) === normalizedInput,
    );

    if (exactMatch) {
      return exactMatch.cultivarId;
    }

    const byName = cultivarInputOptions.filter((option) => normalizeCropSearchValue(option.name) === normalizedInput);
    if (byName.length === 1) {
      const match = byName[0];
      if (match) {
        return match.cultivarId;
      }
    }

    const byLabel = cultivarInputOptions.filter((option) => normalizeCropSearchValue(option.label) === normalizedInput);
    if (byLabel.length === 1) {
      const match = byLabel[0];
      if (match) {
        return match.cultivarId;
      }
    }

    const byAlias = cultivarInputOptions.filter((option) =>
      option.aliases.some((alias) => normalizeCropSearchValue(alias) === normalizedInput),
    );
    if (byAlias.length === 1) {
      const match = byAlias[0];
      if (match) {
        return match.cultivarId;
      }
    }

    return null;
  }, [cultivarInputOptions]);

  const selectedCultivarId = useMemo(
    () => resolveCultivarIdFromInput(formValues.cropInput),
    [formValues.cropInput, resolveCultivarIdFromInput],
  );
  const selectedCultivar = useMemo(
    () => cultivars.find((cultivar) => cultivar.cultivarId === selectedCultivarId) ?? null,
    [cultivars, selectedCultivarId],
  );
  const selectedCropRuleWarning =
    selectedCultivar && cropHasTaskRules[selectedCultivar.cropTypeId] === false
      ? 'Warning: this crop has no task rules. You can still create and edit batches.'
      : null;
  const quickCreateCultivarHref = useMemo(() => {
    const next = new URLSearchParams();
    next.set('from', 'batch');
    next.set('returnTo', '/batches#create-batch');

    if (selectedCultivar?.cropTypeId) {
      next.set('cropTypeId', selectedCultivar.cropTypeId);
    }

    return `/taxonomy/cultivars?${next.toString()}#create-cultivar`;
  }, [selectedCultivar?.cropTypeId]);

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

  const selectableSpecies = useMemo(
    () =>
      Object.values(speciesById)
        .map((species) => ({
          speciesId: species.id,
          label: formatCropOptionLabel({
            cropId: species.id,
            name: species.commonName,
            scientificName: species.scientificName,
          }),
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [speciesById],
  );

  useEffect(() => {
    const firstSelectableCrop = selectableCrops[0];
    if (!editingCropId && firstSelectableCrop) {
      setEditingCropId(firstSelectableCrop.cropId);
    }
  }, [editingCropId, selectableCrops]);

  useEffect(() => {
    const firstSelectableSpecies = selectableSpecies[0];
    if (!editingSpeciesId && firstSelectableSpecies) {
      setEditingSpeciesId(firstSelectableSpecies.speciesId);
    }
  }, [editingSpeciesId, selectableSpecies]);

  useEffect(() => {
    const firstSelectableSpecies = selectableSpecies[0];
    if (!cropCreateValues.speciesId && firstSelectableSpecies) {
      setCropCreateValues((current) => ({ ...current, speciesId: firstSelectableSpecies.speciesId }));
    }
  }, [cropCreateValues.speciesId, selectableSpecies]);

  useEffect(() => {
    if (!selectableSpecies.length) {
      setRepairSpeciesId('');
      return;
    }

    const currentSpeciesId = cropEditValues.speciesId.trim();
    const firstReplacementSpecies =
      selectableSpecies.find((species) => species.speciesId !== currentSpeciesId) ?? selectableSpecies[0];

    if (!repairSpeciesId || !selectableSpecies.some((species) => species.speciesId === repairSpeciesId)) {
      setRepairSpeciesId(firstReplacementSpecies?.speciesId ?? '');
    }
  }, [cropEditValues.speciesId, repairSpeciesId, selectableSpecies]);

  useEffect(() => {
    const loadCropForEdit = async () => {
      if (!editingCropId) {
        setCropEditValues({
          cultivar: '',
          cultivarGroup: '',
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
      const nextSpeciesById = buildSpeciesLookup(appState?.species);

      const cropSpecies = ((crop as { species?: Record<string, unknown> } | null)?.species ?? {}) as Record<string, unknown>;
      const speciesId = (crop as (Crop & { speciesId?: string }) | null)?.speciesId ?? (typeof cropSpecies.id === 'string' ? cropSpecies.id : '');
      const speciesRecord = speciesId ? nextSpeciesById[speciesId] : undefined;
      setCropEditValues({
        cultivar: (crop as (Crop & { cultivar?: string }) | null)?.cultivar ?? crop?.name ?? '',
        cultivarGroup: (crop as (Crop & { cultivarGroup?: string }) | null)?.cultivarGroup ?? '',
        speciesId,
        speciesCommonName:
          speciesRecord?.commonName
          || (typeof cropSpecies.commonName === 'string' ? cropSpecies.commonName : '')
          || crop?.name
          || '',
        speciesScientificName:
          speciesRecord?.scientificName
          || (typeof cropSpecies.scientificName === 'string' ? cropSpecies.scientificName : '')
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


  useEffect(() => {
    const loadSpeciesForEdit = async () => {
      if (!editingSpeciesId) {
        setSpeciesEditValues({
          commonName: '',
          scientificName: '',
          aliases: '',
          notes: '',
        });
        return;
      }

      const appState = await loadAppStateFromIndexedDb();
      const species = appState?.species?.find((entry) => entry.id === editingSpeciesId) ?? null;
      setSpeciesEditValues({
        commonName: species?.commonName ?? '',
        scientificName: species?.scientificName ?? '',
        aliases: (species?.aliases ?? []).join(', '),
        notes: species?.notes ?? '',
      });
      setSpeciesEditErrors({});
      setSpeciesEditMessage(null);
    };

    void loadSpeciesForEdit();
  }, [editingSpeciesId]);

  useEffect(() => {
    setSpeciesCreateValues((current) => {
      if (current.id.trim()) {
        return current;
      }

      return {
        ...current,
        id: createUniqueSpeciesId(current.commonName || current.scientificName, Object.keys(speciesById)),
      };
    });
  }, [speciesById]);

  useEffect(() => {
    const loadCropRepairPreview = async () => {
      if (!editingCropId || !repairSpeciesId) {
        setCropRepairPreview(null);
        return;
      }

      const appState = await loadAppStateFromIndexedDb();
      const crop = appState?.crops.find((entry) => entry.cropId === editingCropId) ?? null;
      const replacementSpecies = appState?.species?.find((entry) => entry.id === repairSpeciesId) ?? null;

      if (!appState || !crop || !replacementSpecies) {
        setCropRepairPreview(null);
        return;
      }

      const nextSpeciesById = buildSpeciesLookup(appState.species);
      const currentSpeciesLabel = formatCropOptionLabel({
        cropId: cropEditValues.speciesId || crop.cropId,
        name: getCropSpeciesCommonName(crop, nextSpeciesById) || cropEditValues.speciesCommonName || crop.name,
        scientificName: getCropSpeciesScientificName(crop, nextSpeciesById) || cropEditValues.speciesScientificName,
      });
      const replacementSpeciesLabel = formatCropOptionLabel({
        cropId: replacementSpecies.id,
        name: replacementSpecies.commonName,
        scientificName: replacementSpecies.scientificName,
      });
      const cropPlanCount = appState.cropPlans.filter((plan) => plan.cropId === crop.cropId).length;
      const batchCount = appState.batches.filter((batch) => batch.cropTypeId === crop.cropId || (batch.cultivarId ?? batch.cropId) === crop.cropId).length;
      const importPayload = JSON.stringify(
        {
          crops: [
            {
              ...crop,
              speciesId: replacementSpecies.id,
              ...(replacementSpecies.commonName && replacementSpecies.scientificName
                ? {
                    species: {
                      id: replacementSpecies.id,
                      commonName: replacementSpecies.commonName,
                      scientificName: replacementSpecies.scientificName,
                    },
                  }
                : {}),
              updatedAt: new Date().toISOString(),
            },
          ],
        },
        null,
        2,
      );

      setCropRepairPreview({
        currentSpeciesLabel,
        replacementSpeciesLabel,
        cropPlanCount,
        batchCount,
        auditNote: `crop=${crop.cropId}; oldSpeciesId=${cropEditValues.speciesId || '(unset)'}; newSpeciesId=${replacementSpecies.id}`,
        importPayload,
      });
    };

    void loadCropRepairPreview();
  }, [
    cropEditValues.speciesCommonName,
    cropEditValues.speciesId,
    cropEditValues.speciesScientificName,
    editingCropId,
    repairSpeciesId,
  ]);

  const handleCropEditSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setCropEditMessage(null);
    const errors: Record<string, string> = {};

    if (!editingCropId) {
      errors.cropId = 'Select a crop to edit.';
    }

    const cultivar = cropEditValues.cultivar.trim();
    const cultivarGroup = cropEditValues.cultivarGroup.trim();
    if (!cultivar) {
      errors.cultivar = 'Cultivar is required.';
    }
    if (cultivarGroup.length > 120) {
      errors.cultivarGroup = 'Cultivar group must be 120 characters or fewer.';
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
        ...(cultivarGroup ? { cultivarGroup } : {}),
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
      if (!cultivarGroup) {
        delete nextCrop.cultivarGroup;
      }

      const nextState = upsertCropInAppState(appState, nextCrop);
      await saveAppStateToIndexedDb(nextState);
      setCropIds(nextState.crops.map((crop) => crop.cropId));
      setCropNames(Object.fromEntries(nextState.crops.map((crop) => [crop.cropId, crop.name])));
      setCropScientificNames(
        Object.fromEntries(
          nextState.crops.map((crop) => [crop.cropId, getCropSpeciesScientificName(crop, buildSpeciesLookup(nextState.species))]),
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
        selectedCultivar?.cropTypeId === existingCrop.cropId
          ? {
              ...current,
              cropInput:
                cultivars.find((entry) => entry.cultivarId === selectedCultivar.cultivarId)?.name ??
                current.cropInput,
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

  const handleSpeciesEditSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSpeciesEditMessage(null);
    const errors: Record<string, string> = {};

    if (!editingSpeciesId) {
      errors.id = 'Select a species to edit.';
    }

    const commonName = speciesEditValues.commonName.trim();
    const scientificName = speciesEditValues.scientificName.trim();
    const aliases = parseCsvUnique(speciesEditValues.aliases);
    const notes = speciesEditValues.notes.trim();

    if (scientificName.length > 160) {
      errors.scientificName = 'Scientific name must be 160 characters or fewer.';
    }

    if (notes.length > 2000) {
      errors.notes = 'Notes must be 2000 characters or fewer.';
    }

    if (Object.keys(errors).length > 0) {
      setSpeciesEditErrors(errors);
      return;
    }

    try {
      const appState = await loadAppStateFromIndexedDb();

      if (!appState) {
        setSpeciesEditMessage('Unable to save because local app state is unavailable.');
        return;
      }

      const existingSpecies = appState.species?.find((entry) => entry.id === editingSpeciesId) ?? null;
      if (!existingSpecies) {
        setSpeciesEditMessage('Species no longer exists.');
        return;
      }

      const nextSpecies: Species = {
        ...existingSpecies,
        id: existingSpecies.id,
        ...(commonName ? { commonName } : {}),
        ...(scientificName ? { scientificName } : {}),
        ...(aliases.length > 0 ? { aliases } : {}),
        ...(notes ? { notes } : {}),
      };
      if (!commonName) {
        delete (nextSpecies as { commonName?: string }).commonName;
      }
      if (!scientificName) {
        delete (nextSpecies as { scientificName?: string }).scientificName;
      }
      if (aliases.length === 0) {
        delete (nextSpecies as { aliases?: string[] }).aliases;
      }
      if (!notes) {
        delete (nextSpecies as { notes?: string }).notes;
      }
      const nextSpeciesCollection = (appState.species ?? []).map((entry) => (entry.id === existingSpecies.id ? nextSpecies : entry));
      const nextState = assertValid('appState', {
        ...appState,
        species: nextSpeciesCollection,
      });
      const nextSpeciesById = buildSpeciesLookup(nextState.species);

      await saveAppStateToIndexedDb(nextState);
      setSpeciesById(nextSpeciesById);
      setCropScientificNames(
        Object.fromEntries(
          nextState.crops.map((crop) => [crop.cropId, getCropSpeciesScientificName(crop, nextSpeciesById)]),
        ),
      );
      setSpeciesEditErrors({});
      setSpeciesEditMessage('Species updated.');
      setCropEditValues((current) =>
        current.speciesId === existingSpecies.id
          ? {
              ...current,
              speciesCommonName: commonName,
              speciesScientificName: scientificName,
            }
          : current,
      );
      setFormValues((current) =>
        selectedCultivar &&
        nextState.crops.some((crop) => crop.cropId === selectedCultivar.cropTypeId && (crop as Crop & { speciesId?: string }).speciesId === existingSpecies.id)
          ? {
              ...current,
              cropInput:
                cultivars.find((entry) => entry.cultivarId === selectedCultivar.cultivarId)?.name ??
                current.cropInput,
            }
          : current,
      );
    } catch (error) {
      if (error instanceof SchemaValidationError && error.issues.length > 0) {
        setSpeciesEditMessage('Please fix invalid species fields before saving.');
        return;
      }

      const message = error instanceof Error ? error.message : 'Failed to save species.';
      setSpeciesEditMessage(message);
    }
  };

  const handleSpeciesCreateSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSpeciesCreateMessage(null);

    const errors: Record<string, string> = {};
    const commonName = speciesCreateValues.commonName.trim();
    const scientificName = speciesCreateValues.scientificName.trim();
    const aliases = parseCsvUnique(speciesCreateValues.aliases);
    const notes = speciesCreateValues.notes.trim();
    const normalizedId = normalizeSpeciesIdInput(speciesCreateValues.id) || createUniqueSpeciesId(commonName || scientificName, Object.keys(speciesById));
    const speciesId = normalizedId.startsWith('species_') ? normalizedId : `species_${normalizedId}`;

    if (!speciesId) {
      errors.id = 'Species ID is required.';
    } else if (speciesId.length > 120) {
      errors.id = 'Species ID must be 120 characters or fewer.';
    } else if (speciesById[speciesId]) {
      errors.id = 'Species ID already exists.';
    }

    if (scientificName.length > 160) {
      errors.scientificName = 'Scientific name must be 160 characters or fewer.';
    }

    if (notes.length > 2000) {
      errors.notes = 'Notes must be 2000 characters or fewer.';
    }

    if (Object.keys(errors).length > 0) {
      setSpeciesCreateErrors(errors);
      return;
    }

    try {
      const appState = await loadAppStateFromIndexedDb();

      if (!appState) {
        setSpeciesCreateMessage('Unable to create species because local app state is unavailable.');
        return;
      }

      if ((appState.species ?? []).some((entry) => entry.id === speciesId)) {
        setSpeciesCreateErrors({ id: 'Species ID already exists.' });
        return;
      }

      const nextSpecies: Species = {
        id: speciesId,
        ...(commonName ? { commonName } : {}),
        ...(scientificName ? { scientificName } : {}),
        ...(aliases.length > 0 ? { aliases } : {}),
        ...(notes ? { notes } : {}),
      };
      const nextState = assertValid('appState', {
        ...appState,
        species: [...(appState.species ?? []), nextSpecies],
      });
      const nextSpeciesById = buildSpeciesLookup(nextState.species);

      await saveAppStateToIndexedDb(nextState);
      setSpeciesById(nextSpeciesById);
      setEditingSpeciesId(speciesId);
      setCropScientificNames(
        Object.fromEntries(
          nextState.crops.map((crop) => [crop.cropId, getCropSpeciesScientificName(crop, nextSpeciesById)]),
        ),
      );
      setSpeciesCreateValues({
        id: '',
        commonName: '',
        scientificName: '',
        aliases: '',
        notes: '',
      });
      setSpeciesCreateErrors({});
      setSpeciesCreateMessage('Species created.');
    } catch (error) {
      if (error instanceof SchemaValidationError && error.issues.length > 0) {
        setSpeciesCreateMessage('Please fix invalid species fields before saving.');
        return;
      }

      const message = error instanceof Error ? error.message : 'Failed to create species.';
      setSpeciesCreateMessage(message);
    }
  };

  useEffect(() => {
    if (taxonomyOnly || isLoading) {
      return;
    }

    const quickCreateCultivarId = searchParams.get('quickCreateCultivarId');

    if (!restoredBatchDraftRef.current) {
      if (quickCreateCultivarId) {
        const savedDraft = loadBatchDraftState();
        if (savedDraft) {
          setEditingBatchId(savedDraft.editingBatchId);
          setFormValues(savedDraft.formValues);
        }
      } else {
        clearBatchDraftState();
      }

      restoredBatchDraftRef.current = true;
    }

    if (!quickCreateCultivarId || handledQuickCreateReturnRef.current) {
      return;
    }

    const nextCultivar = cultivars.find((cultivar) => cultivar.cultivarId === quickCreateCultivarId);
    if (nextCultivar) {
      const nextInput = [
        nextCultivar.name,
        cropNames[nextCultivar.cropTypeId] ?? nextCultivar.cropTypeId,
        cropScientificNames[nextCultivar.cropTypeId],
      ].filter(Boolean).join(' · ');
      setFormValues((current) => ({ ...current, cropInput: nextInput }));
      setSaveMessage('Cultivar created. Finish your batch draft below.');
    }

    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('quickCreateCultivarId');
    setSearchParams(nextParams, { replace: true });
    clearBatchDraftState();
    handledQuickCreateReturnRef.current = true;
  }, [cropNames, cropScientificNames, cultivars, isLoading, searchParams, setSearchParams, taxonomyOnly]);

  const handleOpenCultivarCreate = () => {
    saveBatchDraftState({
      editingBatchId,
      formValues,
    });
    navigate(quickCreateCultivarHref);
  };

  const startEdit = (batch: Batch) => {
    setEditingBatchId(batch.batchId);
    const startedAt = toLocalDateTimeInput(batch.startedAt) || getLocalDateTimeDefault();
    const meta = (batch.meta ?? {}) as Record<string, unknown>;
    const batchDisplay = getBatchCultivarDisplay({
      batch,
      cultivarsById,
      cropNames,
      cropScientificNames,
    });

    setFormValues({
      cropInput: cultivarInputOptions.find((option) => option.cultivarId === batchDisplay.identityId)?.label ?? batchDisplay.name ?? batchDisplay.identityId,
      startedAt,
      seedCountPlanned: batch.seedCountPlanned?.toString() ?? '',
      seedCountGerminated: batch.seedCountGerminated?.toString() ?? '',
      seedCountGerminatedConfidence:
        typeof meta.seedCountGerminatedConfidence === 'string' ? meta.seedCountGerminatedConfidence : '',
      plantCountAlive: batch.plantCountAlive?.toString() ?? '',
      plantCountAliveConfidence: typeof meta.plantCountAliveConfidence === 'string' ? meta.plantCountAliveConfidence : '',
      initialMethod: getInitialBatchMethodForBatch(batch),
    });
    setFormErrors({});
    setSaveMessage(null);
  };

  const resetForm = () => {
    clearBatchDraftState();
    setEditingBatchId(null);
    setFormValues({
      cropInput: '',
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

  const handleCreateCropSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setCropCreateMessage(null);

    const errors: Record<string, string> = {};
    const speciesId = cropCreateValues.speciesId.trim();
    const cultivar = cropCreateValues.cultivar.trim();
    const cultivarGroup = cropCreateValues.cultivarGroup.trim();
    const aliases = parseCsvUnique(cropCreateValues.aliases);
    const notes = cropCreateValues.notes.trim();

    if (!speciesId) {
      errors.speciesId = 'Select an existing species.';
    }

    if (!cultivar) {
      errors.cultivar = 'Cultivar is required.';
    }
    if (cultivarGroup.length > 120) {
      errors.cultivarGroup = 'Cultivar group must be 120 characters or fewer.';
    }

    if (notes.length > 2000) {
      errors.notes = 'Notes must be 2000 characters or fewer.';
    }

    if (Object.keys(errors).length > 0) {
      setCropCreateErrors(errors);
      return;
    }

    try {
      const appState = await loadAppStateFromIndexedDb();
      if (!appState) {
        setCropCreateMessage('Unable to create crop because local app state is unavailable.');
        return;
      }

      const species = (appState.species ?? []).find((entry) => entry.id === speciesId) ?? null;
      if (!species) {
        setCropCreateErrors({ speciesId: 'Select an existing species.' });
        return;
      }

      const createdAt = new Date().toISOString();
      const cropId = createUniqueUserCropId(cultivar, appState.crops.map((crop) => crop.cropId));
      const nextState = upsertCropInAppState(appState, {
        cropId,
        name: cultivar,
        cultivar,
        ...(cultivarGroup ? { cultivarGroup } : {}),
        speciesId: species.id,
        ...(aliases.length > 0 ? { aliases } : {}),
        ...(species.commonName && species.scientificName
          ? {
              species: {
                id: species.id,
                commonName: species.commonName,
                scientificName: species.scientificName,
              },
            }
          : {}),
        ...(notes ? { meta: { notes } } : {}),
        isUserDefined: true,
        createdAt,
        updatedAt: createdAt,
      });

      await saveAppStateToIndexedDb(nextState);
      const nextSpeciesById = buildSpeciesLookup(nextState.species);
      setCropIds(nextState.crops.map((crop) => crop.cropId));
      setCropNames(Object.fromEntries(nextState.crops.map((crop) => [crop.cropId, crop.name])));
      setCropScientificNames(
        Object.fromEntries(
          nextState.crops.map((crop) => [crop.cropId, getCropSpeciesScientificName(crop, nextSpeciesById)]),
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
      setUserDefinedCropIds(
        Object.fromEntries(
          nextState.crops.map((crop) => {
            const isUserDefined = (crop as { isUserDefined?: unknown }).isUserDefined;
            return [crop.cropId, isUserDefined === true];
          }),
        ),
      );
      setEditingCropId(cropId);
      setCropCreateValues({
        speciesId: species.id,
        cultivar: '',
        cultivarGroup: '',
        aliases: '',
        notes: '',
      });
      setCropCreateErrors({});
      setCropCreateMessage('Crop created. You can now create batches that reference it.');
    } catch (error) {
      if (error instanceof SchemaValidationError && error.issues.length > 0) {
        setCropCreateMessage('Please fix invalid crop fields before saving.');
        return;
      }

      const message = error instanceof Error ? error.message : 'Failed to create crop.';
      setCropCreateMessage(message);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSaveMessage(null);
    const errors: Record<string, string> = {};
    const resolvedCultivarId = resolveCultivarIdFromInput(formValues.cropInput);
    const resolvedCultivar = cultivars.find((cultivar) => cultivar.cultivarId === resolvedCultivarId) ?? null;

    if (!formValues.cropInput.trim()) {
      errors.cropInput = 'Select an existing cultivar record.';
    } else if (!resolvedCultivarId) {
      errors.cropInput = 'Select an existing cultivar record before creating a batch.';
    } else if (!resolvedCultivar) {
      errors.cropInput = 'Selected cultivar could not be resolved.';
    }

    if (!formValues.startedAt) {
      errors.startedAt = 'Enter a valid start date and time.';
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

    const initialMethod = resolveInitialBatchMethod(formValues.initialMethod);
    const initialMethodConfig = isSelectableInitialBatchMethod(initialMethod) ? INITIAL_BATCH_METHODS[initialMethod] : null;

    if (!initialMethodConfig) {
      errors.initialMethod = INITIAL_BATCH_METHOD_ERROR;
    }

    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }

    const validatedInitialMethodConfig = initialMethodConfig as (typeof INITIAL_BATCH_METHODS)[keyof typeof INITIAL_BATCH_METHODS];

    try {
      const appState = await loadAppStateFromIndexedDb();

      if (!appState) {
        setSaveMessage('Unable to save because local app state is unavailable.');
        return;
      }

      if (!resolvedCultivarId || !resolvedCultivar) {
        setSaveMessage('Unable to save because cultivar is not selected.');
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

      const nextBatch = {
        batchId,
        cultivarId: resolvedCultivarId,
        cropTypeId: resolvedCultivar.cropTypeId,
        ...(existingBatch?.variety ? { variety: existingBatch.variety } : {}),
        startedAt,
        stage: existingBatch?.stage ?? validatedInitialMethodConfig.stage,
        stageEvents:
          existingBatch?.stageEvents ?? [
            {
              stage: validatedInitialMethodConfig.stage,
              occurredAt: startedAt,
              ...(validatedInitialMethodConfig.startMethod ? { method: validatedInitialMethodConfig.startMethod } : {}),
            },
          ],
        ...(existingBatch?.startMethod
          ? { startMethod: existingBatch.startMethod }
          : validatedInitialMethodConfig.startMethod
            ? { startMethod: validatedInitialMethodConfig.startMethod }
            : {}),
        assignments: existingBatch?.assignments ?? [],
        ...(seedCountPlanned !== null ? { seedCountPlanned } : {}),
        ...(seedCountGerminated !== null ? { seedCountGerminated } : {}),
        ...(plantCountAlive !== null ? { plantCountAlive } : {}),
        ...(Object.keys(nextMeta).length > 0 ? { meta: nextMeta } : {}),
      } as Batch;

      const nextState = upsertBatchInAppState(appState, nextBatch);
      await saveAppStateToIndexedDb(nextState);
      setBatches(listBatchesFromAppState(nextState));
      setCropIds(nextState.crops.map((crop) => crop.cropId));
      setCropNames(Object.fromEntries(nextState.crops.map((crop) => [crop.cropId, crop.name])));
      setCropScientificNames(
        Object.fromEntries(
          nextState.crops.map((crop) => [crop.cropId, getCropSpeciesScientificName(crop, buildSpeciesLookup(nextState.species))]),
        ),
      );
      setFormErrors({});
      setSaveMessage(editingBatchId ? 'Batch updated.' : 'Batch created.');
      resetForm();
    } catch (error) {
      if (error instanceof SchemaValidationError && error.issues.length > 0) {
        setFormErrors(mapBatchValidationIssuesToFormErrors(error.issues));
        setSaveMessage(buildBatchValidationIssueSummary(error.issues));
        return;
      }

      const lifecycleError = getInitialBatchLifecycleError(error instanceof Error ? error.message : undefined);
      if (lifecycleError) {
        setFormErrors((current) => ({ ...current, initialMethod: lifecycleError }));
        setSaveMessage('Please fix the highlighted fields.');
        return;
      }

      const message = error instanceof Error ? error.message : 'Failed to save batch.';
      setSaveMessage(message);
    }
  };

  return (
    <section className="batches-page">
      <h2>{taxonomyOnly ? (taxonomySection === 'species' ? 'Species Admin' : taxonomySection === 'crop-types' ? 'Crop Type Admin' : 'Taxonomy Admin') : 'Batches'}</h2>

      {taxonomyOnly ? (
        <>
          <p className="batch-form-note">
            Manage reusable taxonomy records here. Species define the biological taxon, crop types define the garden form under that species, and cultivars are maintained in their own admin view before inventory or batches link to them.
          </p>
          <nav className="batch-form-actions" aria-label="Taxonomy admin views">
            <Link to="/taxonomy">Hierarchy overview</Link>
            <Link to="/taxonomy/species">Species</Link>
            <Link to="/taxonomy/crop-types">Crop types</Link>
            <Link to="/taxonomy/cultivars">Cultivars</Link>
          </nav>
          {taxonomySection === 'overview' ? (
            <p className="batch-form-note">
              Start with species, then define crop types, then create cultivar records in Cultivar Admin before creating batches from those cultivar records.
            </p>
          ) : null}
        </>
      ) : (
        <>
          <div className="batch-filters">
            <label>
              Crop Type
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

          <nav className="batch-form-actions" aria-label="Batch and admin flows">
            <Link to="/batches#create-batch">Batch form</Link>
            <Link to="/taxonomy/cultivars#create-cultivar">Cultivar admin</Link>
            <Link to="/batches#edit-crop">Edit crop type metadata</Link>
            <Link to="/taxonomy/species">Species admin</Link>
          </nav>
        </>
      )}

      {!taxonomyOnly ? (
        <form id="create-batch" className="batch-form" onSubmit={(event) => void handleSubmit(event)}>
        <h3>{editingBatchId ? 'Edit batch' : 'Create batch'}</h3>
        <div className="batch-form-grid">
          <label>
            Cultivar
            <input
              list="batch-cultivar-options"
              value={formValues.cropInput}
              onChange={(event) => setFormValues((current) => ({ ...current, cropInput: event.target.value }))}
              placeholder="Cultivar · Crop Type · Species"
            />
            <datalist id="batch-cultivar-options">
              {cultivarInputOptions.map((cultivar) => (
                <option
                  key={cultivar.cultivarId}
                  value={cultivar.inputValue}
                />
              ))}
            </datalist>
            <span className="batch-form-note">Select an existing cultivar record. Crop type and species are derived automatically.</span>
            <span className="batch-form-note">Missing one? <button type="button" className="inline-link-button" onClick={handleOpenCultivarCreate}>Create cultivar</button> and come right back to this draft.</span>
            {formErrors.cropInput ? <span className="form-error">{formErrors.cropInput}</span> : null}
          </label>

          <label>
            Crop Type
            <input type="text" value={selectedCultivar ? cropNames[selectedCultivar.cropTypeId] ?? selectedCultivar.cropTypeId : ''} readOnly />
            <span className="batch-form-note">Derived from the selected cultivar.</span>
          </label>

          <label>
            Species
            <input type="text" value={selectedCultivar ? cropScientificNames[selectedCultivar.cropTypeId] ?? '' : ''} readOnly />
            <span className="batch-form-note">Derived from the selected cultivar&apos;s crop type.</span>
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
              disabled={Boolean(editingBatchId)}
            >
              {SELECTABLE_INITIAL_BATCH_METHODS.map(([method, config]) => (
                <option key={method} value={method}>{config.label}</option>
              ))}
              {(() => {
                const legacyMethod = resolveInitialBatchMethod(formValues.initialMethod);
                const legacyMethodConfig = legacyMethod ? INITIAL_BATCH_METHODS[legacyMethod] : null;

                if (!legacyMethod || !legacyMethodConfig || isSelectableInitialBatchMethod(legacyMethod)) {
                  return null;
                }

                return (
                  <option value={legacyMethod} disabled>
                    {legacyMethodConfig.label} (legacy unsupported)
                  </option>
                );
              })()}
            </select>
            <span className="batch-form-note">Only lifecycle-supported start methods are selectable for new batches. Existing unsupported legacy methods remain read-only after save.</span>
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
        <p className="batch-form-note">
          Batch creation now links directly to an existing cultivar record. If the cultivar you need is missing, create it in Cultivar Admin first, then return here. Supported sowing-stage starts here are Sow, Pre-sow (wet paper), Pre-sow tray / indoor, Direct sow, and Sow indoor.
        </p>
        {selectedCropRuleWarning ? <p className="batch-stage-warning">{selectedCropRuleWarning}</p> : null}
        <div className="batch-form-actions">
          <button type="button" onClick={handleOpenCultivarCreate}>Create cultivar</button>
          <Link to={quickCreateCultivarHref}>Open cultivar admin</Link>
          <Link to="/taxonomy#create-crop">Open crop type taxonomy form</Link>
          <Link to="/taxonomy/species">Open species admin</Link>
          <button type="submit">{editingBatchId ? 'Save changes' : 'Create batch'}</button>
          {editingBatchId ? (
            <button type="button" onClick={resetForm}>
              Cancel edit
            </button>
          ) : null}
          {saveMessage ? <p className="batch-form-message">{saveMessage}</p> : null}
        </div>
      </form>
      ) : null}

      {(!taxonomyOnly || taxonomySection === 'crop-types') ? (
        <form id="edit-crop" className="batch-form" onSubmit={(event) => void handleCropEditSubmit(event)}>
          <h3>Edit crop type metadata</h3>
          <div className="batch-form-grid">
            <label>
              Crop type record
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
              Crop type ID (immutable)
              <input type="text" value={editingCropId} readOnly disabled />
            </label>

            <label>
              Crop type name
              <input
                type="text"
                value={cropEditValues.cultivar}
                onChange={(event) => setCropEditValues((current) => ({ ...current, cultivar: event.target.value }))}
              />
              {cropEditErrors.cultivar ? <span className="form-error">{cropEditErrors.cultivar}</span> : null}
            </label>

            <label>
              Cultivar group (optional)
              <input
                type="text"
                value={cropEditValues.cultivarGroup}
                onChange={(event) => setCropEditValues((current) => ({ ...current, cultivarGroup: event.target.value }))}
                placeholder="Acephala Group, Italica Group, or Gongylodes Group"
              />
              <span className="batch-form-note">Informational taxonomy only; use this for group labels, not cultivar names.</span>
              {cropEditErrors.cultivarGroup ? <span className="form-error">{cropEditErrors.cultivarGroup}</span> : null}
            </label>

            <label>
              Species common name
              <input type="text" value={cropEditValues.speciesCommonName} readOnly disabled />
            </label>

            <label>
              Species scientific name
              <input type="text" value={cropEditValues.speciesScientificName} readOnly disabled />
              {cropEditErrors.speciesScientificName ? <span className="form-error">{cropEditErrors.speciesScientificName}</span> : null}
            </label>

            <label>
              Species ID (immutable)
              <input type="text" value={cropEditValues.speciesId} readOnly disabled />
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
          <p className="batch-form-note">Species identity is locked here. Use Species Admin to update shared species metadata safely.</p>
          <div className="batch-form-actions">
            <button type="submit">Save crop type changes</button>
            {cropEditMessage ? <p className="batch-form-message">{cropEditMessage}</p> : null}
          </div>
        </form>
      ) : null}

      {taxonomyOnly ? (
        <>
      {taxonomySection !== 'species' ? (
      <form id="create-crop" className="batch-form" onSubmit={(event) => void handleCreateCropSubmit(event)}>
        <h3>Create crop type</h3>
        <div className="batch-form-grid">
          <label>
            Species
            <select
              value={cropCreateValues.speciesId}
              onChange={(event) => setCropCreateValues((current) => ({ ...current, speciesId: event.target.value }))}
            >
              <option value="">Select species</option>
              {selectableSpecies.map((species) => (
                <option key={species.speciesId} value={species.speciesId}>
                  {species.label}
                </option>
              ))}
            </select>
            {cropCreateErrors.speciesId ? <span className="form-error">{cropCreateErrors.speciesId}</span> : null}
          </label>

          <label>
            Crop type name
            <input
              type="text"
              value={cropCreateValues.cultivar}
              onChange={(event) => setCropCreateValues((current) => ({ ...current, cultivar: event.target.value }))}
              placeholder="Kohlrabi, Broccoli, Beetroot, or Chard"
            />
            {cropCreateErrors.cultivar ? <span className="form-error">{cropCreateErrors.cultivar}</span> : null}
          </label>

          <label>
            Cultivar group (optional)
            <input
              type="text"
              value={cropCreateValues.cultivarGroup}
              onChange={(event) => setCropCreateValues((current) => ({ ...current, cultivarGroup: event.target.value }))}
              placeholder="Acephala Group, Italica Group, or Gongylodes Group"
            />
            <span className="batch-form-note">Informational taxonomy only; leave blank for everyday workflows.</span>
            {cropCreateErrors.cultivarGroup ? <span className="form-error">{cropCreateErrors.cultivarGroup}</span> : null}
          </label>

          <label>
            Aliases (comma-separated)
            <input
              type="text"
              value={cropCreateValues.aliases}
              onChange={(event) => setCropCreateValues((current) => ({ ...current, aliases: event.target.value }))}
              placeholder="Optional"
            />
          </label>

          <label>
            Notes
            <textarea
              value={cropCreateValues.notes}
              onChange={(event) => setCropCreateValues((current) => ({ ...current, notes: event.target.value }))}
              rows={3}
            />
            {cropCreateErrors.notes ? <span className="form-error">{cropCreateErrors.notes}</span> : null}
          </label>
        </div>
        <p className="batch-form-note">Crop type creation defines the agricultural crop form linked to the selected species, for example Brassica oleracea → Kohlrabi, Broccoli, Kale, or Cabbage before naming a cultivar.</p>
        <div className="batch-form-actions">
          <button type="submit">Save crop type</button>
          {cropCreateMessage ? <p className="batch-form-message">{cropCreateMessage}</p> : null}
        </div>
      </form>
      ) : null}

      {showAdminDataSurgery && taxonomySection !== 'species' ? (
        <section className="batch-form">
          <h3>Repair crop type taxonomy</h3>
          <div className="batch-form-grid">
            <label>
              Crop type to repair
              <input type="text" value={editingCropId} readOnly disabled />
            </label>

            <label>
              Current species
              <input type="text" value={cropRepairPreview?.currentSpeciesLabel ?? cropEditValues.speciesId} readOnly disabled />
            </label>

            <label>
              Replacement species
              <select value={repairSpeciesId} onChange={(event) => setRepairSpeciesId(event.target.value)}>
                {selectableSpecies.map((species) => (
                  <option key={species.speciesId} value={species.speciesId}>
                    {species.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="crop-repair-preview">
            <p className="batch-form-note">
              Admin repair flow preview only. Normal crop type edits still keep <code>speciesId</code> locked.
            </p>
            {cropRepairPreview ? (
              <>
                <ul className="crop-repair-impact-list">
                  <li>Replacement species: {cropRepairPreview.replacementSpeciesLabel}</li>
                  <li>Affected crop plans: {cropRepairPreview.cropPlanCount}</li>
                  <li>Affected batches: {cropRepairPreview.batchCount}</li>
                  <li>Audit metadata: <code>{cropRepairPreview.auditNote}</code></li>
                </ul>
                <label>
                  Import payload for explicit repair
                  <textarea value={cropRepairPreview.importPayload} readOnly rows={12} />
                </label>
              </>
            ) : (
              <p className="batch-form-note">Select a replacement species to preview the repair payload and impact summary.</p>
            )}
          </div>
          <p className="batch-form-note">
            Use the generated payload with <strong>Import Crop JSON</strong> below to run a controlled reassignment while preserving the existing crop type identity.
          </p>
        </section>
      ) : null}

      {taxonomySection !== 'crop-types' ? (
      <form id="create-species" className="batch-form" onSubmit={(event) => void handleSpeciesCreateSubmit(event)}>
        <h3>Create species</h3>
        <div className="batch-form-grid">
          <label>
            Species ID
            <input
              type="text"
              value={speciesCreateValues.id}
              onChange={(event) => setSpeciesCreateValues((current) => ({ ...current, id: event.target.value }))}
              placeholder="species_pea"
            />
            {speciesCreateErrors.id ? <span className="form-error">{speciesCreateErrors.id}</span> : null}
          </label>

          <label>
            Common name (optional)
            <input
              aria-label="Common name"
              type="text"
              value={speciesCreateValues.commonName}
              onChange={(event) =>
                setSpeciesCreateValues((current) => ({
                  ...current,
                  commonName: event.target.value,
                  id: current.id.trim() ? current.id : createUniqueSpeciesId(event.target.value || current.scientificName, Object.keys(speciesById)),
                }))}
            />
            {speciesCreateErrors.commonName ? <span className="form-error">{speciesCreateErrors.commonName}</span> : null}
          </label>

          <label>
            Scientific name
            <input
              type="text"
              value={speciesCreateValues.scientificName}
              onChange={(event) =>
                setSpeciesCreateValues((current) => ({
                  ...current,
                  scientificName: event.target.value,
                  id: current.id.trim() ? current.id : createUniqueSpeciesId(current.commonName || event.target.value, Object.keys(speciesById)),
                }))}
            />
            {speciesCreateErrors.scientificName ? <span className="form-error">{speciesCreateErrors.scientificName}</span> : null}
          </label>

          <label>
            Aliases (comma-separated)
            <input
              type="text"
              value={speciesCreateValues.aliases}
              onChange={(event) => setSpeciesCreateValues((current) => ({ ...current, aliases: event.target.value }))}
            />
          </label>

          <label>
            Notes
            <textarea
              value={speciesCreateValues.notes}
              onChange={(event) => setSpeciesCreateValues((current) => ({ ...current, notes: event.target.value }))}
              rows={3}
            />
            {speciesCreateErrors.notes ? <span className="form-error">{speciesCreateErrors.notes}</span> : null}
          </label>
        </div>
        <div className="batch-form-actions">
          <button type="submit">Create species</button>
          {speciesCreateMessage ? <p className="batch-form-message">{speciesCreateMessage}</p> : null}
        </div>
      </form>
      ) : null}

      {taxonomySection !== 'crop-types' ? (
      <form id="edit-species" className="batch-form" onSubmit={(event) => void handleSpeciesEditSubmit(event)}>
        <h3>Edit species metadata</h3>
        <div className="batch-form-grid">
          <label>
            Species
            <select value={editingSpeciesId} onChange={(event) => setEditingSpeciesId(event.target.value)}>
              {selectableSpecies.map((species) => (
                <option key={species.speciesId} value={species.speciesId}>
                  {species.label}
                </option>
              ))}
            </select>
            {speciesEditErrors.id ? <span className="form-error">{speciesEditErrors.id}</span> : null}
          </label>

          <label>
            Species ID (immutable)
            <input type="text" value={editingSpeciesId} readOnly disabled />
          </label>

          <label>
            Common name (optional)
            <input
              aria-label="Common name"
              type="text"
              value={speciesEditValues.commonName}
              onChange={(event) => setSpeciesEditValues((current) => ({ ...current, commonName: event.target.value }))}
            />
            {speciesEditErrors.commonName ? <span className="form-error">{speciesEditErrors.commonName}</span> : null}
          </label>

          <label>
            Scientific name
            <input
              type="text"
              value={speciesEditValues.scientificName}
              onChange={(event) => setSpeciesEditValues((current) => ({ ...current, scientificName: event.target.value }))}
            />
            {speciesEditErrors.scientificName ? <span className="form-error">{speciesEditErrors.scientificName}</span> : null}
          </label>

          <label>
            Aliases (comma-separated)
            <input
              type="text"
              value={speciesEditValues.aliases}
              onChange={(event) => setSpeciesEditValues((current) => ({ ...current, aliases: event.target.value }))}
            />
          </label>

          <label>
            Notes
            <textarea
              value={speciesEditValues.notes}
              onChange={(event) => setSpeciesEditValues((current) => ({ ...current, notes: event.target.value }))}
              rows={3}
            />
            {speciesEditErrors.notes ? <span className="form-error">{speciesEditErrors.notes}</span> : null}
          </label>
        </div>
        <div className="batch-form-actions">
          <button type="submit">Save species changes</button>
          {speciesEditMessage ? <p className="batch-form-message">{speciesEditMessage}</p> : null}
        </div>
      </form>
      ) : null}
        </>
      ) : null}

      {!taxonomyOnly && isLoading ? <p className="batch-empty-state">Loading batches…</p> : null}

      {!taxonomyOnly && !isLoading ? (
        <ul className="batch-list">
          {filteredBatches.map((batch) => {
            const batchDisplay = getBatchCultivarDisplay({
              batch,
              cultivarsById,
              cropNames,
              cropScientificNames,
            });

            return (
              <li key={batch.batchId}>
                <Link to={`/batches/${batch.batchId}`} className="batch-item-link">
                  <div>
                    <p className="batch-item-title">
                      <CropIdentityLabel
                        cropId={batchDisplay.identityId}
                        name={batchDisplay.name}
                        scientificName={batchDisplay.scientificName}
                      />
                      <span className="crop-capability-badges" aria-label="Crop capabilities">
                        {getCropCapabilityLabels({
                          isUserDefined: userDefinedCropIds[batchDisplay.capabilityCropId],
                          hasTaskRules: cropHasTaskRules[batchDisplay.capabilityCropId],
                        }).map((label) => (
                          <span key={`${batch.batchId}-${label}`} className="crop-capability-badge">
                            {label}
                          </span>
                        ))}
                      </span>
                    </p>
                    <p className="batch-item-meta">
                      Batch {batch.batchId}
                      {batchDisplay.cropTypeName ? ` · Crop Type ${batchDisplay.cropTypeName}` : ''}
                      {' · '}Bed {getDerivedBedId(batch) ?? 'Unassigned'} · Started {new Date(batch.startedAt).toLocaleString()}
                      {batch.variety ? ` · Legacy cultivar label ${batch.variety}` : ''}
                    </p>
                  </div>
                  <span className="batch-stage-badge">{batch.stage}</span>
                </Link>
                <button type="button" className="batch-edit-button" onClick={() => startEdit(batch)}>
                  Edit
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {!taxonomyOnly && !isLoading && filteredBatches.length === 0 ? (
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
  const [cropTypeName, setCropTypeName] = useState<string | null>(null);
  const [cultivarIdLabel, setCultivarIdLabel] = useState<string | null>(null);
  const [cropHasTaskRules, setCropHasTaskRules] = useState<boolean | undefined>(undefined);
  const [cropIsUserDefined, setCropIsUserDefined] = useState<boolean | undefined>(undefined);
  const [beds, setBeds] = useState<Bed[]>([]);
  const [actionDates, setActionDates] = useState<Record<string, string>>({});
  const [stageActionMessage, setStageActionMessage] = useState<string | null>(null);
  const [timelineEdits, setTimelineEdits] = useState<
    Record<string, TimelineEditState>
  >({});
  const [timelineMessage, setTimelineMessage] = useState<string | null>(null);
  const [assignToBedId, setAssignToBedId] = useState('');
  const [assignToBedDate, setAssignToBedDate] = useState(getLocalDateTimeDefault());
  const [assignToBedMessage, setAssignToBedMessage] = useState<string | null>(null);
  const [isSavingAssignToBed, setIsSavingAssignToBed] = useState(false);
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
        setCropTypeName(null);
        setCultivarIdLabel(null);
        setCropHasTaskRules(undefined);
        setCropIsUserDefined(undefined);
        setBeds([]);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      const appState = await loadAppStateFromIndexedDb();

      if (!appState) {
        setBatch(null);
        setCropName(null);
        setCropScientificName(null);
        setCropTypeName(null);
        setCultivarIdLabel(null);
        setCropHasTaskRules(undefined);
        setCropIsUserDefined(undefined);
        setBeds([]);
        setIsLoading(false);
        return;
      }

      const nextBatch = appState.batches.find((candidate) => candidate.batchId === batchId) ?? null;
      setBatch(nextBatch);

      if (!nextBatch) {
        setCropName(null);
        setCropScientificName(null);
        setCropTypeName(null);
        setCultivarIdLabel(null);
        setCropHasTaskRules(undefined);
        setCropIsUserDefined(undefined);
        setBeds([]);
        setIsLoading(false);
        return;
      }

      const availableBeds = listBedsFromAppState(appState).sort((left, right) => left.bedId.localeCompare(right.bedId));

      const cultivarsById = Object.fromEntries(getCultivarsFromAppState(appState).map((cultivar) => [cultivar.cultivarId, cultivar]));
      const batchDisplay = getBatchCultivarDisplay({
        batch: nextBatch,
        cultivarsById,
        cropNames: Object.fromEntries(appState.crops.map((crop) => [crop.cropId, crop.name])),
        cropScientificNames: Object.fromEntries(
          appState.crops.map((crop) => [crop.cropId, getCropSpeciesScientificName(crop, buildSpeciesLookup(appState.species))]),
        ),
      });
      const crop = appState.crops.find((candidate) => candidate.cropId === batchDisplay.capabilityCropId);
      setCropName(batchDisplay.name ?? null);
      setCropScientificName(batchDisplay.scientificName ?? null);
      setCropTypeName(batchDisplay.cropTypeName ?? null);
      setCultivarIdLabel(batchDisplay.identityId);
      const taskRules = (crop as { taskRules?: unknown } | undefined)?.taskRules;
      setCropHasTaskRules(Array.isArray(taskRules) && taskRules.length > 0);
      setCropIsUserDefined((crop as { isUserDefined?: unknown } | undefined)?.isUserDefined === true);
      setBeds(availableBeds);
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
      setAssignToBedId(getDerivedBedId(nextBatch) ?? availableBeds[0]?.bedId ?? '');
      setAssignToBedDate(dateDefault);
      setAssignToBedMessage(null);
      setRemoveFromBedDate(dateDefault);
      setRemoveFromBedMessage(null);
      setPhotoActionMessage(null);
      setExpandedPhotoIds({});
      setIsLoading(false);
    };

    void load();
  }, [batchId]);

  const currentBedId = useMemo(() => (batch ? getDerivedBedId(batch) : null), [batch]);

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

  const handleAssignToBed = async () => {
    if (!batch || !batchId) {
      return;
    }

    if (!assignToBedId) {
      setAssignToBedMessage('Select a bed before assigning this batch.');
      return;
    }

    if (!assignToBedDate) {
      setAssignToBedMessage('Enter a valid date and time before assigning to bed.');
      return;
    }

    const assignedAt = fromLocalDateTimeInput(assignToBedDate);
    if (!assignedAt) {
      setAssignToBedMessage('Enter a valid date and time before assigning to bed.');
      return;
    }

    setIsSavingAssignToBed(true);

    try {
      const appState = await loadAppStateFromIndexedDb();
      if (!appState) {
        setAssignToBedMessage('Unable to save because local app state is unavailable.');
        return;
      }

      const existingBatch = appState.batches.find((candidate) => candidate.batchId === batchId) ?? null;
      if (!existingBatch) {
        setAssignToBedMessage('Batch was not found.');
        return;
      }

      const nextBatch = assignBatchToBed(existingBatch, assignToBedId, assignedAt);
      const nextState = upsertBatchInAppState(appState, nextBatch);
      await saveAppStateToIndexedDb(nextState);
      const refreshedBatch = nextState.batches.find((candidate) => candidate.batchId === batchId) ?? null;
      setBatch(refreshedBatch);
      setAssignToBedMessage(`Batch assigned to ${assignToBedId}.`);
      setRemoveFromBedMessage(null);
    } catch (error) {
      if (error instanceof Error && error.message === 'batch_assignment_overlap') {
        setAssignToBedMessage('Unable to assign batch: it already has an overlapping bed assignment for that date.');
      } else {
        setAssignToBedMessage(error instanceof Error ? error.message : 'Failed to assign batch to bed.');
      }
    } finally {
      setIsSavingAssignToBed(false);
    }
  };

  const handleRemoveFromBed = async () => {
    if (!batch || !batchId) {
      return;
    }

    if (!currentBedId) {
      setRemoveFromBedMessage('This batch is already unassigned.');
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
        <CropIdentityLabel cropId={cultivarIdLabel ?? batch.cultivarId ?? batch.cropId} name={cropName ?? undefined} scientificName={cropScientificName ?? undefined} />
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
              <dt>Cultivar ID</dt>
              <dd>{cultivarIdLabel ?? batch.cultivarId ?? batch.cropId}</dd>
            </div>
            {cropTypeName ? (
              <div>
                <dt>Crop Type</dt>
                <dd>{cropTypeName}</dd>
              </div>
            ) : null}
            {batch.variety ? (
              <div>
                <dt>Legacy cultivar label</dt>
                <dd>{batch.variety}</dd>
              </div>
            ) : null}
            <div>
              <dt>Stage</dt>
              <dd>{batch.stage}</dd>
            </div>
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
        <p className="batch-detail-current-bed">Current: {currentBedId ?? 'Unassigned'}</p>
        <div className="batch-next-action-row">
          <span className="batch-detail-pill">assign</span>
          <select value={assignToBedId} onChange={(event) => setAssignToBedId(event.target.value)}>
            <option value="">Select bed</option>
            {beds.map((bed) => (
              <option key={bed.bedId} value={bed.bedId}>
                {bed.name ? `${bed.name} (${bed.bedId})` : bed.bedId}
              </option>
            ))}
          </select>
          <input
            type="datetime-local"
            value={assignToBedDate}
            onChange={(event) => setAssignToBedDate(event.target.value)}
          />
          <button type="button" onClick={() => void handleAssignToBed()} disabled={isSavingAssignToBed}>
            Assign to bed
          </button>
        </div>
        {assignToBedMessage ? <p className="batch-stage-warning">{assignToBedMessage}</p> : null}
        {currentBedId ? (
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
        ) : (
          <p className="batch-detail-empty">This batch is not currently assigned to a bed.</p>
        )}
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
  showDevResetButton?: boolean;
};

const EMPTY_ALL_DATA_CONFIRMATION = 'DELETE ALL DATA';

export function RecoveryScreen({ error, onRetry, showDevResetButton = false }: RecoveryScreenProps) {
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
      setResetMessage('Golden dataset restored. You can retry loading the app now.');
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
      {showDevResetButton ? (
        <>
          <p>Restore golden dataset is separate from “Empty all data” and repopulates local storage with the bundled starter records.</p>
          <label>
            <input type="checkbox" checked={confirmReset} onChange={(event) => setConfirmReset(event.currentTarget.checked)} disabled={isResetting} />
            I understand this will replace local data with the golden dataset.
          </label>
          <button type="button" onClick={() => void handleReset()} disabled={!confirmReset || isResetting}>
            {isResetting ? 'Restoring golden dataset…' : 'Restore golden dataset'}
          </button>
          {resetMessage ? <p>{resetMessage}</p> : null}
        </>
      ) : null}
    </div>
  );
}

function DataPage({ showDevResetButton, onResetToGoldenDataset }: DataPageProps) {
  const importValidationSettings: AppState['settings'] = {
    settingsId: 'settings-default',
    locale: 'en-US',
    timezone: 'Europe/Berlin',
    units: {
      temperature: 'celsius',
      yield: 'metric',
    },
    createdAt: '1970-01-01T00:00:00Z',
    updatedAt: '1970-01-01T00:00:00Z',
  };

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
  const [pendingSpeciesImportSpecies, setPendingSpeciesImportSpecies] = useState<Species[]>([]);
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
  const [speciesImportStatusSummary, setSpeciesImportStatusSummary] = useState<{
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
  const [emptyAllDataMessage, setEmptyAllDataMessage] = useState<string | null>(null);
  const [isEmptyingAllData, setIsEmptyingAllData] = useState(false);
  const [emptyAllDataConfirmationText, setEmptyAllDataConfirmationText] = useState('');
  const [emptyAllDataConfirmed, setEmptyAllDataConfirmed] = useState(false);
  const [emptyAllDataRecordCounts, setEmptyAllDataRecordCounts] = useState<{
    species: number;
    crops: number;
    segments: number;
    beds: number;
    paths: number;
    cropPlans: number;
    batches: number;
    tasks: number;
    seedInventoryItems: number;
  } | null>(null);

  useEffect(() => {
    if (!showDevResetButton) {
      return;
    }

    void (async () => {
      const appState = await loadAppStateFromIndexedDb();
      setEmptyAllDataRecordCounts({
        species: appState?.species?.length ?? 0,
        crops: appState?.crops.length ?? 0,
        segments: appState?.segments?.length ?? 0,
        beds: appState ? listBedsFromAppState(appState).length : 0,
        paths: (appState?.segments ?? []).reduce((total, segment) => total + segment.paths.length, 0),
        cropPlans: appState?.cropPlans.length ?? 0,
        batches: appState?.batches.length ?? 0,
        tasks: appState?.tasks.length ?? 0,
        seedInventoryItems: appState?.seedInventoryItems.length ?? 0,
      });
    })();
  }, [showDevResetButton]);

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
    setPendingSpeciesImportSpecies([]);
    setPendingCropPlanImportPlans([]);
    setPendingSegmentImportSegments([]);
    setPendingSegmentImportPreview([]);
    setBatchImportStatusSummary(null);
    setCropImportStatusSummary(null);
    setSpeciesImportStatusSummary(null);
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
    setPendingSpeciesImportSpecies([]);
    setPendingCropPlanImportPlans([]);
    setPendingSegmentImportSegments([]);
    setPendingSegmentImportPreview([]);
    setBatchImportStatusSummary(null);
    setCropImportStatusSummary(null);
    setSpeciesImportStatusSummary(null);
    setCropPlanImportStatusSummary(null);
    setSegmentImportStatusSummary(null);

    try {
      const payload = await file.text();
      const rawParsed = JSON.parse(payload) as { batches?: unknown };

      if (!rawParsed || typeof rawParsed !== 'object' || !Array.isArray(rawParsed.batches)) {
        throw new Error('Batch import payload must be an object with a batches array.');
      }

      const validBatches: Batch[] = [];
      const validationErrors: Array<{ path: string; message: string }> = [];

      rawParsed.batches.forEach((candidate, index) => {
        const batchId =
          candidate && typeof candidate === 'object' && 'batchId' in candidate && typeof candidate.batchId === 'string'
            ? candidate.batchId
            : `index-${index}`;

        try {
          const normalizedCandidate = normalizeBatchCandidate(candidate);
          const validatedSingleBatch = parseImportedAppState(JSON.stringify({
            schemaVersion: 1,
            beds: [],
            crops: [],
            cropPlans: [],
            batches: [normalizedCandidate],
            seedInventoryItems: [],
            tasks: [],
            settings: importValidationSettings,
          }));
          const validatedBatch = validatedSingleBatch.batches[0];
          if (validatedBatch) {
            validBatches.push(validatedBatch);
          }
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
        settings: importValidationSettings,
      }));
      const previewItems = validatedBatchImportState.batches.map((batch) => ({
        batchLabel: `${batch.variety ?? batch.cultivarId ?? batch.cropId ?? 'Unknown cultivar'} (${batch.cropTypeId ?? 'Unknown crop type'})`,
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
    setPendingSpeciesImportSpecies([]);
    setPendingCropPlanImportPlans([]);
    setPendingSegmentImportSegments([]);
    setPendingSegmentImportPreview([]);
    setBatchImportStatusSummary(null);
    setCropImportStatusSummary(null);
    setSpeciesImportStatusSummary(null);
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
          validCrops.push(assertValid('crop', candidate));
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
      setImportMessage(`Cultivar taxonomy repair ready: ${validCrops.length} valid crop record(s) from ${rawParsed.crops.length}. Confirm to import.`);
      setImportErrors(validationErrors);
    } catch (error) {
      setImportMessage('Import failed. Fix the errors below and try again.');
      setImportErrors(mapImportError(error));
    } finally {
      setIsImporting(false);
    }
  }, [isImporting, mapImportError]);

  const handleImportSpeciesJson = useCallback(async (event: FormEvent<HTMLInputElement>) => {
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
    setPendingSpeciesImportSpecies([]);
    setPendingCropPlanImportPlans([]);
    setPendingSegmentImportSegments([]);
    setPendingSegmentImportPreview([]);
    setBatchImportStatusSummary(null);
    setCropImportStatusSummary(null);
    setSpeciesImportStatusSummary(null);
    setCropPlanImportStatusSummary(null);
    setSegmentImportStatusSummary(null);

    try {
      const payload = await file.text();
      const rawParsed = JSON.parse(payload) as { species?: unknown[] };

      if (!rawParsed || typeof rawParsed !== 'object' || !Array.isArray(rawParsed.species)) {
        throw new Error('Species import payload must be an object with a species array.');
      }

      const validSpecies: Species[] = [];
      const validationErrors: Array<{ path: string; message: string }> = [];

      rawParsed.species.forEach((candidate, index) => {
        const fallbackPath = `/species/${index}`;

        try {
          validSpecies.push(assertValid('species', candidate));
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

      if (validSpecies.length === 0) {
        setImportMessage('Species import failed. No valid species passed validation.');
        setImportErrors(validationErrors);
        return;
      }

      setPendingSpeciesImportSpecies(validSpecies);
      setImportMessage(`Species import ready: ${validSpecies.length} valid species record(s) from ${rawParsed.species.length}. Confirm to import.`);
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
    setPendingSpeciesImportSpecies([]);
    setPendingCropPlanImportPlans([]);
    setPendingSegmentImportSegments([]);
    setPendingSegmentImportPreview([]);
    setBatchImportStatusSummary(null);
    setCropImportStatusSummary(null);
    setSpeciesImportStatusSummary(null);
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
          validCropPlans.push(assertValid('cropPlan', candidate));
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
    setPendingSpeciesImportSpecies([]);
    setPendingCropPlanImportPlans([]);
    setPendingSegmentImportSegments([]);
    setPendingSegmentImportPreview([]);
    setBatchImportStatusSummary(null);
    setCropImportStatusSummary(null);
    setSpeciesImportStatusSummary(null);
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
        settings: importValidationSettings,
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
            width: segment.width ?? segment.widthM,
            height: segment.height ?? segment.lengthM,
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
            width: segment.width ?? segment.widthM,
            height: segment.height ?? segment.lengthM,
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
            width: segment.width ?? segment.widthM,
            height: segment.height ?? segment.lengthM,
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
          width: segment.width ?? segment.widthM,
          height: segment.height ?? segment.lengthM,
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
        if (incomingCrop.cultivarGroup !== undefined) {
          mergedCrop.cultivarGroup = incomingCrop.cultivarGroup;
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

  const handleConfirmSpeciesImport = useCallback(async () => {
    if (pendingSpeciesImportSpecies.length === 0 || isImporting) {
      return;
    }

    setIsImporting(true);
    setImportMessage(null);
    setImportErrors([]);

    try {
      const existingAppState = await loadAppStateFromIndexedDb();
      if (!existingAppState) {
        setImportMessage('Species import failed: local app state is unavailable.');
        return;
      }

      const speciesById = new Map((existingAppState.species ?? []).map((entry) => [entry.id, entry]));
      const summary = { imported: 0, merged: 0, skipped: 0, rejected: 0 };
      const results: Array<{ path: string; message: string }> = [];

      pendingSpeciesImportSpecies.forEach((incomingSpecies, index) => {
        const currentSpecies = speciesById.get(incomingSpecies.id);

        if (!currentSpecies) {
          speciesById.set(incomingSpecies.id, incomingSpecies);
          summary.imported += 1;
          return;
        }

        const mergedSpecies: Species = {
          ...currentSpecies,
          ...((incomingSpecies.commonName ?? currentSpecies.commonName) !== undefined
            ? { commonName: incomingSpecies.commonName ?? currentSpecies.commonName }
            : {}),
          ...((incomingSpecies.scientificName ?? currentSpecies.scientificName) !== undefined
            ? { scientificName: incomingSpecies.scientificName ?? currentSpecies.scientificName }
            : {}),
          ...((incomingSpecies.aliases ?? currentSpecies.aliases) !== undefined
            ? { aliases: incomingSpecies.aliases ?? currentSpecies.aliases }
            : {}),
          ...((incomingSpecies.notes ?? currentSpecies.notes) !== undefined
            ? { notes: incomingSpecies.notes ?? currentSpecies.notes }
            : {}),
        };

        const unchanged = JSON.stringify(currentSpecies) === JSON.stringify(mergedSpecies);
        speciesById.set(incomingSpecies.id, mergedSpecies);
        if (unchanged) {
          summary.skipped += 1;
        } else {
          summary.merged += 1;
          if (currentSpecies.commonName !== incomingSpecies.commonName || currentSpecies.scientificName !== incomingSpecies.scientificName) {
            results.push({
              path: `/species/${index}`,
              message: `merged (shared_reference_update): crop species references remain linked to ${incomingSpecies.id}`,
            });
          }
        }
      });

      const nextState = { ...existingAppState, species: [...speciesById.values()] };
      await saveAppStateToIndexedDb(nextState, { mode: 'replace' });
      setSpeciesImportStatusSummary(summary);
      setImportErrors(results);
      setImportMessage(`Species import complete. imported: ${summary.imported}, merged: ${summary.merged}, skipped: ${summary.skipped}, rejected: ${summary.rejected}.`);
      setPendingSpeciesImportSpecies([]);
    } catch (error) {
      setImportMessage('Import failed while saving.');
      setImportErrors(mapImportError(error));
    } finally {
      setIsImporting(false);
    }
  }, [isImporting, mapImportError, pendingSpeciesImportSpecies]);

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

  const handleEmptyAllData = useCallback(async () => {
    if (isEmptyingAllData) {
      return;
    }

    if (!emptyAllDataConfirmed || emptyAllDataConfirmationText.trim() !== EMPTY_ALL_DATA_CONFIRMATION) {
      setEmptyAllDataMessage(`Type ${EMPTY_ALL_DATA_CONFIRMATION} and confirm the irreversible wipe before continuing.`);
      return;
    }

    setIsEmptyingAllData(true);
    setEmptyAllDataMessage(null);

    try {
      const currentState = await loadAppStateFromIndexedDb();
      const emptyState = createEmptyAppState(currentState);

      await saveAppStateToIndexedDb(emptyState, { mode: 'replace' });
      const validatedEmptyState = await loadAppStateFromIndexedDb();

      if (
        !validatedEmptyState
        || (validatedEmptyState.species ?? []).length > 0
        || (validatedEmptyState.crops ?? []).length > 0
        || (validatedEmptyState.segments ?? []).length > 0
        || (validatedEmptyState.beds ?? []).length > 0
        || (validatedEmptyState.cropPlans ?? []).length > 0
        || (validatedEmptyState.batches ?? []).length > 0
        || (validatedEmptyState.tasks ?? []).length > 0
        || (validatedEmptyState.seedInventoryItems ?? []).length > 0
      ) {
        throw new Error('Empty-state validation failed. Local data was not fully cleared.');
      }

      setPendingImportState(null);
      setPendingBatchImportState(null);
      setPendingBatchImportPreview([]);
      setPendingCropImportCrops([]);
      setPendingSpeciesImportSpecies([]);
      setPendingCropPlanImportPlans([]);
      setPendingSegmentImportSegments([]);
      setPendingSegmentImportPreview([]);
      setBatchImportStatusSummary(null);
      setCropImportStatusSummary(null);
      setSpeciesImportStatusSummary(null);
      setCropPlanImportStatusSummary(null);
      setSegmentImportStatusSummary(null);
      setImportErrors([]);
      setImportMessage(null);
      setEmptyAllDataRecordCounts({
        species: 0,
        crops: 0,
        segments: 0,
        beds: 0,
        paths: 0,
        cropPlans: 0,
        batches: 0,
        tasks: 0,
        seedInventoryItems: 0,
      });
      setEmptyAllDataConfirmed(false);
      setEmptyAllDataConfirmationText('');
      setEmptyAllDataMessage('All local garden data was deleted. The dataset is now empty and ready to rebuild from scratch.');
      navigate('/beds', { replace: true });
    } catch (error) {
      setEmptyAllDataMessage(error instanceof Error ? error.message : 'Failed to empty local garden data.');
    } finally {
      setIsEmptyingAllData(false);
    }
  }, [
    emptyAllDataConfirmationText,
    emptyAllDataConfirmed,
    isEmptyingAllData,
    navigate,
  ]);

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
    setPendingSpeciesImportSpecies([]);
    setPendingCropPlanImportPlans([]);
    setPendingSegmentImportSegments([]);
    setPendingSegmentImportPreview([]);
    setCropImportStatusSummary(null);
    setSpeciesImportStatusSummary(null);
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

        const validBatches: Batch[] = [];
        const validationErrors: Array<{ path: string; message: string }> = [];

        rawParsed.batches.forEach((candidate, index) => {
          const batchId =
            candidate && typeof candidate === 'object' && 'batchId' in candidate && typeof candidate.batchId === 'string'
              ? candidate.batchId
              : `index-${index}`;

          try {
            const normalizedCandidate = normalizeBatchCandidate(candidate);
            const validatedSingleBatch = parseImportedAppState(JSON.stringify({
              schemaVersion: 1,
              beds: [],
              crops: [],
              cropPlans: [],
              batches: [normalizedCandidate],
              seedInventoryItems: [],
              tasks: [],
              settings: importValidationSettings,
            }));
            const validatedBatch = validatedSingleBatch.batches[0];
            if (validatedBatch) {
              validBatches.push(validatedBatch);
            }
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
            settings: importValidationSettings,
          }));
          const previewBatchIds = validatedBatchImportState.batches
            .map((batch) => ({
              batchLabel: `${batch.variety ?? batch.cultivarId ?? batch.cropId ?? 'Unknown cultivar'} (${batch.cropTypeId ?? 'Unknown crop type'})`,
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
            validCrops.push(assertValid('crop', candidate));
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
          setImportMessage(`Deep link taxonomy repair ready: ${validCrops.length} valid crop record(s) from ${rawParsed.crops.length} payload crop(s). Confirm to import.`);
        }
      } else if (importType === 'species') {
        const rawParsed = JSON.parse(decodedPayload) as { species?: unknown[] };
        if (!rawParsed || typeof rawParsed !== 'object' || !Array.isArray(rawParsed.species)) {
          throw new Error('Deep-link payload must decode to an object with a species array.');
        }
        const validSpecies: Species[] = [];
        const validationErrors: Array<{ path: string; message: string }> = [];
        rawParsed.species.forEach((candidate, index) => {
          const fallbackPath = `/species/${index}`;
          try {
            validSpecies.push(assertValid('species', candidate));
          } catch (validationError) {
            validationErrors.push({
              path: fallbackPath,
              message: `schema_validation_failed - ${validationError instanceof Error ? validationError.message : 'Unknown import error.'}`,
            });
          }
        });
        if (validSpecies.length === 0) {
          setImportMessage('Species import failed. No valid species records passed validation.');
          setImportErrors(validationErrors);
        } else {
          setPendingSpeciesImportSpecies(validSpecies);
          setImportErrors(validationErrors);
          setImportMessage(`Deep link ready: ${validSpecies.length} valid species record(s) from ${rawParsed.species.length} payload record(s). Confirm to import.`);
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
            validCropPlans.push(assertValid('cropPlan', candidate));
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
          settings: importValidationSettings,
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
              width: segment.width ?? segment.widthM,
              height: segment.height ?? segment.lengthM,
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
              width: segment.width ?? segment.widthM,
              height: segment.height ?? segment.lengthM,
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
              width: segment.width ?? segment.widthM,
              height: segment.height ?? segment.lengthM,
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
            width: segment.width ?? segment.widthM,
            height: segment.height ?? segment.lengthM,
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
        Import Species JSON
        <input
          type="file"
          accept="application/json,.json"
          onChange={(event) => void handleImportSpeciesJson(event)}
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
      <p>
        Recommended backup-first taxonomy migration flow: export the current dataset, import species records, import cultivar/crop records, then
        import batches so legacy <code>cropId</code> references can be reviewed in order.
      </p>
      <p>Cultivar import endpoint contract: <code>POST /api/import/crops</code> with <code>{'{ "crops": [ { "cropId": "...", "cultivar": "...", "speciesId": "...", "species": { "id": "...", "commonName": "...", "scientificName": "..." } } ] }'}</code>.</p>
      <p>Legacy species-level or phantom-species crop payloads are treated as taxonomy repairs: the surviving crop should be a cultivar record linked by <code>speciesId</code> to a real top-level species.</p>
      <p>When variety data is missing, the importer keeps the crop active as a placeholder cultivar using the deterministic label <code>Unknown variety</code> instead of leaving a ghost canonical crop behind.</p>
      <p>
        Conservative repair guidance: keep ambiguous legacy crop records as placeholder cultivars until you can prove the correct species/crop-type
        split, and treat exported JSON plus deterministic IDs as the audit trail for old-to-new mapping.
      </p>
      <p>Species import endpoint contract: <code>POST /api/import/species</code> with <code>{'{ "species": [ { "id": "species_lettuce", "commonName": "Lettuce", "scientificName": "Lactuca sativa", "aliases": ["Garden lettuce"], "notes": "Cool-season leafy species." } ] }'}</code>.</p>
      <p>Species edit support is available in-app for <code>commonName</code>, <code>scientificName</code>, <code>aliases</code>, and <code>notes</code>; <code>id</code> stays immutable so crop <code>speciesId</code> references remain intact.</p>
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
      <p>
        Batch relink review: confirm imported batches still point at the intended cultivar/crop placeholder before saving, especially when the crop
        payload used <code>Unknown variety</code> or other migration-era stand-ins.
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
            <h3>Cultivar Taxonomy Repair Preview</h3>
            <p>Previewing the surviving cultivar records that will remain linked to real species after import.</p>
            <ul>
              {pendingCropImportCrops.slice(0, 5).map((crop) => (
                <li key={crop.cropId}>Cultivar {(crop as Crop & { cultivar?: string }).cultivar ?? crop.name} — real species {getCropSpeciesCommonName(crop) || crop.cropId} ({crop.cropId})</li>
              ))}
            </ul>
          </section>
          <button type="button" onClick={() => void handleConfirmCropImport()} disabled={isImporting}>
            {isImporting ? 'Importing cultivar repairs…' : 'Import cultivar repairs'}
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
      {pendingSpeciesImportSpecies.length > 0 ? (
        <>
          <section>
            <h3>Species Import Preview</h3>
            <ul>
              {pendingSpeciesImportSpecies.slice(0, 5).map((species) => (
                <li key={species.id}>
                  {formatCropOptionLabel({ cropId: species.id, name: species.commonName, scientificName: species.scientificName })} — {species.id}
                </li>
              ))}
            </ul>
          </section>
          <button type="button" onClick={() => void handleConfirmSpeciesImport()} disabled={isImporting}>
            {isImporting ? 'Importing species…' : 'Import species'}
          </button>
          <button
            type="button"
            onClick={() => {
              setPendingSpeciesImportSpecies([]);
              setSpeciesImportStatusSummary(null);
              setImportMessage('Species import canceled.');
            }}
            disabled={isImporting}
          >
            Cancel species import
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
          <h3>Cultivar Taxonomy Repair Summary</h3>
          <ul>
            <li>imported: {cropImportStatusSummary.imported}</li>
            <li>merged: {cropImportStatusSummary.merged}</li>
            <li>skipped: {cropImportStatusSummary.skipped}</li>
            <li>rejected: {cropImportStatusSummary.rejected}</li>
          </ul>
          <p>Imported and merged records represent cultivar crops that remain linked to real species metadata; rejected rows need manual cleanup before they can replace phantom canonical crops.</p>
        </section>
      ) : null}
      {speciesImportStatusSummary ? (
        <section>
          <h3>Species Import Summary</h3>
          <ul>
            <li>imported: {speciesImportStatusSummary.imported}</li>
            <li>merged: {speciesImportStatusSummary.merged}</li>
            <li>skipped: {speciesImportStatusSummary.skipped}</li>
            <li>rejected: {speciesImportStatusSummary.rejected}</li>
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
        <section aria-label="Danger zone">
          <h3>Danger zone</h3>
          <p>Admin-only destructive actions for repairing corrupted local state.</p>
          {emptyAllDataRecordCounts ? (
            <ul>
              <li>Species: {emptyAllDataRecordCounts.species}</li>
              <li>Crops: {emptyAllDataRecordCounts.crops}</li>
              <li>Segments: {emptyAllDataRecordCounts.segments}</li>
              <li>Beds: {emptyAllDataRecordCounts.beds}</li>
              <li>Paths: {emptyAllDataRecordCounts.paths}</li>
              <li>Crop plans: {emptyAllDataRecordCounts.cropPlans}</li>
              <li>Batches: {emptyAllDataRecordCounts.batches}</li>
              <li>Tasks: {emptyAllDataRecordCounts.tasks}</li>
              <li>Seed inventory items: {emptyAllDataRecordCounts.seedInventoryItems}</li>
            </ul>
          ) : null}
          <p>Empty all data permanently removes user-managed entities and rebuilds a valid empty baseline shell. This cannot be undone here.</p>
          <label>
            Type <code>{EMPTY_ALL_DATA_CONFIRMATION}</code> to unlock the wipe
            <input
              type="text"
              value={emptyAllDataConfirmationText}
              onChange={(event) => setEmptyAllDataConfirmationText(event.currentTarget.value)}
              disabled={isEmptyingAllData}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={emptyAllDataConfirmed}
              onChange={(event) => setEmptyAllDataConfirmed(event.currentTarget.checked)}
              disabled={isEmptyingAllData}
            />
            I understand this will irreversibly delete all local species, crops, segments, beds, paths, crop plans, batches, tasks, seed inventory, and related metadata.
          </label>
          <button
            type="button"
            onClick={() => void handleEmptyAllData()}
            disabled={
              isEmptyingAllData
              || !emptyAllDataConfirmed
              || emptyAllDataConfirmationText.trim() !== EMPTY_ALL_DATA_CONFIRMATION
            }
          >
            {isEmptyingAllData ? 'Emptying all data…' : 'Empty all data'}
          </button>
          {emptyAllDataMessage ? <p>{emptyAllDataMessage}</p> : null}
          <button type="button" onClick={onResetToGoldenDataset} disabled={isEmptyingAllData}>
            Restore golden dataset
          </button>
        </section>
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

function ImportSpeciesDeepLinkRoute() {
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  search.set('importType', 'species');
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
        <p>
          {isDevResetEnabled
            ? 'Try again, or restore the golden dataset if migration is blocked or corrupted.'
            : 'Try again if migration or local storage initialization was interrupted.'}
        </p>
        <div className="storage-error-actions">
          <button type="button" onClick={() => void initializeStorage()}>
            Retry
          </button>
          {isDevResetEnabled ? (
            <button type="button" onClick={() => void handleReset()}>
              Restore golden dataset
            </button>
          ) : null}
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
          <Route path="/taxonomy" element={<BatchesPage taxonomyOnly showAdminDataSurgery={isDevResetEnabled} />} />
          <Route path="/taxonomy/species" element={<BatchesPage taxonomyOnly taxonomySection="species" showAdminDataSurgery={isDevResetEnabled} />} />
          <Route path="/taxonomy/crop-types" element={<BatchesPage taxonomyOnly taxonomySection="crop-types" showAdminDataSurgery={isDevResetEnabled} />} />
          <Route path="/taxonomy/cultivars" element={<CultivarAdminPage />} />
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
          <Route path="/import-species" element={<ImportSpeciesDeepLinkRoute />} />
          <Route path="/import-crop-plans" element={<ImportCropPlansDeepLinkRoute />} />
          <Route path="/import-segments" element={<ImportSegmentsDeepLinkRoute />} />
          <Route path="*" element={<Navigate to="/beds" replace />} />
        </Routes>
      </main>

      <nav className="tab-nav" aria-label="Primary">
        <NavLink to="/beds">Beds</NavLink>
        <NavLink to="/calendar">Calendar</NavLink>
        <NavLink to="/taxonomy">Admin</NavLink>
        <NavLink to="/batches">Batches</NavLink>
        <NavLink to="/nutrition">Nutrition</NavLink>
        <NavLink to="/seed-inventory">Seeds</NavLink>
        <NavLink to="/data">Data</NavLink>
      </nav>
    </div>
  );
}

export default App;
