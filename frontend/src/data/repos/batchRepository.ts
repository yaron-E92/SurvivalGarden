import type { AppState, Batch } from '../../contracts';
import { applyStageEvent, inferBatchStartMethod, normalizeBatchStage } from '../../domain';
import { assertValid, validateSchema } from '../validation';
import type { BatchListFilter, ListQuery } from './interfaces';


export type BatchMigrationWarningCode =
  | 'legacy_crop_id_mapped'
  | 'legacy_variety_cultivar'
  | 'legacy_counts_mapped'
  | 'legacy_start_mapped'
  | 'legacy_status_ignored'
  | 'legacy_propagation_heuristic'
  | 'stage_events_synthesized'
  | 'bed_assignments_alias_mapped'
  | 'photos_defaulted'
  | 'assignments_defaulted';

export type BatchMigrationWarning = {
  batchId: string | null;
  code: BatchMigrationWarningCode;
  message: string;
};

export type BatchMigrationInvalidRecord = {
  index: number;
  batchId: string | null;
  issues: string[];
};

export type BatchMigrationReport = {
  migrated: number;
  warnings: BatchMigrationWarning[];
  invalidRecords: BatchMigrationInvalidRecord[];
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const asString = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const asUtcIso = (value: unknown): string | undefined => {
  const text = asString(value);

  if (!text) {
    return undefined;
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return text;
  }

  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
};

const normalizeStageEvent = (
  event: Record<string, unknown>,
  fallbackStage?: string,
): Record<string, unknown> => {
  const rawStage = 'stage' in event
    ? (typeof event.stage === 'string' ? event.stage : undefined)
    : 'type' in event
      ? (typeof event.type === 'string' ? event.type : undefined)
      : fallbackStage;
  const normalizedStage = rawStage ? normalizeBatchStage(rawStage) : undefined;
  const normalizedMethod = inferBatchStartMethod(rawStage, asString(event.method));
  const nextMeta = asRecord(event.meta);

  return {
    ...event,
    ...(normalizedStage ? { stage: normalizedStage } : {}),
    occurredAt: asUtcIso(event.occurredAt) ?? asUtcIso(event.date),
    ...(normalizedMethod ? { method: normalizedMethod } : {}),
    ...(rawStage && normalizedStage && rawStage !== normalizedStage
      ? { meta: { ...nextMeta, legacyStage: rawStage } }
      : Object.keys(nextMeta).length > 0
        ? { meta: nextMeta }
        : {}),
  };
};

const detectPropagationType = (candidate: Record<string, unknown>): Batch['propagationType'] | undefined => {
  const direct = asString(candidate.propagationType);

  if (
    direct === 'seed' ||
    direct === 'transplant' ||
    direct === 'cutting' ||
    direct === 'division' ||
    direct === 'tuber' ||
    direct === 'bulb' ||
    direct === 'runner' ||
    direct === 'graft' ||
    direct === 'other'
  ) {
    return direct;
  }

  const keys = Object.keys(candidate).join(' ').toLowerCase();
  const payload = JSON.stringify(candidate).toLowerCase();

  if (keys.includes('cutting') || payload.includes('cutting')) {
    return 'cutting';
  }

  if (keys.includes('regrow') || keys.includes('runner') || payload.includes('regrow') || payload.includes('runner')) {
    return 'runner';
  }

  if (keys.includes('tuber') || payload.includes('tuber') || keys.includes('bulb') || payload.includes('bulb')) {
    return 'tuber';
  }

  return undefined;
};

export const normalizeBatchCandidate = (value: unknown, options?: { forMigrationReport?: boolean }): unknown => {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const candidate = asRecord(value);
  const forMigrationReport = options?.forMigrationReport === true;
  const start = asRecord(candidate.start);
  const counts = asRecord(candidate.counts);
  const status = asRecord(candidate.status);
  const varietyRecord = asRecord(candidate.variety);
  const batchId = asString(candidate.batchId) ?? asString(candidate.id) ?? null;
  const warnings: BatchMigrationWarning[] = [];

  const startedAt = asUtcIso(candidate.startedAt) ?? asUtcIso(start.startedAt) ?? asUtcIso(start.at);
  if (!asString(candidate.startedAt) && startedAt) {
    warnings.push({ batchId, code: 'legacy_start_mapped', message: 'Mapped legacy start.* fields into startedAt.' });
  }

  const rawStage = asString(candidate.currentStage) ?? asString(candidate.stage) ?? asString(status.state) ?? 'unknown';
  const stage = normalizeBatchStage(rawStage);
  if (status.state || status.isActive !== undefined) {
    warnings.push({ batchId, code: 'legacy_status_ignored', message: 'Legacy status.* fields observed; canonical stage/currentStage applied.' });
  }

  const stageEventsInput = Array.isArray(candidate.stageEvents) ? candidate.stageEvents : [];
  const stageEvents =
    stageEventsInput.length > 0
      ? stageEventsInput.map((event) => normalizeStageEvent(asRecord(event), rawStage))
      : startedAt
        ? [normalizeStageEvent({ stage: rawStage, occurredAt: startedAt }, rawStage)]
        : [];
  if (stageEventsInput.length === 0 && startedAt) {
    warnings.push({ batchId, code: 'stage_events_synthesized', message: 'Synthesized first stage event from start timestamp.' });
  }

  const canonicalStart = startedAt ?? asUtcIso((stageEvents[0] as Record<string, unknown> | undefined)?.occurredAt);
  const assignments = Array.isArray(candidate.assignments)
    ? candidate.assignments
    : Array.isArray(candidate.bedAssignments)
      ? candidate.bedAssignments
      : [];
  if (!Array.isArray(candidate.assignments) && Array.isArray(candidate.bedAssignments)) {
    warnings.push({ batchId, code: 'bed_assignments_alias_mapped', message: 'Mapped bedAssignments alias to assignments.' });
  }

  const normalized: Record<string, unknown> = {
    batchId: candidate.batchId ?? candidate.id,
    startedAt: canonicalStart,
    stage,
    stageEvents,
    assignments,
  };

  if (candidate.cultivarId !== undefined) {
    normalized.cultivarId = candidate.cultivarId;
  }

  if (candidate.cropId !== undefined) {
    normalized.cropId = candidate.cropId;
  }

  if (candidate.cropTypeId !== undefined) {
    normalized.cropTypeId = candidate.cropTypeId;
  }

  if (candidate.currentStage !== undefined || forMigrationReport) {
    normalized.currentStage = normalizeBatchStage(asString(candidate.currentStage) ?? stage);
  }

  if (candidate.bedAssignments !== undefined) {
    normalized.bedAssignments = candidate.bedAssignments;
  }

  if (Array.isArray(candidate.photos) || forMigrationReport) {
    normalized.photos = Array.isArray(candidate.photos) ? candidate.photos : [];
  }

  const normalizedVariety = asString(candidate.variety) ?? asString(varietyRecord.cultivar);
  if (normalizedVariety !== undefined) {
    normalized.variety = normalizedVariety;
  }

  if (candidate.propagationType !== undefined) {
    normalized.propagationType = candidate.propagationType;
  }

  const firstStageEvent = stageEvents[0] as Record<string, unknown> | undefined;
  const normalizedStartMethod = inferBatchStartMethod(
    rawStage,
    asString(candidate.startMethod) ?? asString(firstStageEvent?.method),
  );
  if (normalizedStartMethod !== undefined) {
    normalized.startMethod = normalizedStartMethod;
  }

  if (candidate.startLocation !== undefined) {
    normalized.startLocation = candidate.startLocation;
  }

  if (candidate.startQuantity !== undefined) {
    normalized.startQuantity = candidate.startQuantity;
  }

  if (candidate.notes !== undefined) {
    normalized.notes = candidate.notes;
  }

  if (candidate.lifecycleStatus !== undefined) {
    normalized.lifecycleStatus = candidate.lifecycleStatus;
  }

  if (candidate.meta !== undefined) {
    normalized.meta = candidate.meta;
  }

  if (!asString(candidate.variety) && asString(varietyRecord.cultivar)) {
    warnings.push({ batchId, code: 'legacy_variety_cultivar', message: 'Mapped variety.cultivar to variety.' });
  }

  const seedsPlanned = asNumber(candidate.seedCountPlanned) ?? asNumber(counts.seedsSown);
  const seedsGerminated = asNumber(candidate.seedCountGerminated) ?? asNumber(counts.seedsGerminated);
  const plantsAlive = asNumber(candidate.plantCountAlive) ?? asNumber(counts.plantsAlive);

  if (seedsPlanned !== undefined) normalized.seedCountPlanned = seedsPlanned;
  if (seedsGerminated !== undefined) normalized.seedCountGerminated = seedsGerminated;
  if (plantsAlive !== undefined) normalized.plantCountAlive = plantsAlive;

  if (counts.seedsSown !== undefined || counts.seedsGerminated !== undefined || counts.plantsAlive !== undefined) {
    warnings.push({ batchId, code: 'legacy_counts_mapped', message: 'Mapped legacy counts.* fields to canonical counters.' });
  }

  if (!Array.isArray(candidate.assignments) && !Array.isArray(candidate.bedAssignments)) {
    warnings.push({ batchId, code: 'assignments_defaulted', message: 'Defaulted missing assignments to empty array.' });
  }

  const propagationType = detectPropagationType(candidate);
  if (propagationType && !asString(candidate.propagationType)) {
    normalized.propagationType = propagationType;
    warnings.push({
      batchId,
      code: 'legacy_propagation_heuristic',
      message: `Derived propagationType=${propagationType} from legacy hints with uncertainty.`,
    });
  }

  const meta = asRecord(candidate.meta);
  if (warnings.length > 0) {
    normalized.meta = {
      ...meta,
      migration: {
        normalizedFromLegacy: true,
        warningCodes: warnings.map((warning) => warning.code),
        confidence: warnings.some((warning) => warning.code === 'legacy_propagation_heuristic') ? 'low' : 'medium',
      },
    };
  }

  return normalized;
};

export const normalizeBatchesWithReport = (records: unknown[]): { batches: Batch[]; report: BatchMigrationReport } => {
  const report: BatchMigrationReport = { migrated: 0, warnings: [], invalidRecords: [] };
  const batches: Batch[] = [];

  records.forEach((record, index) => {
    const normalized = normalizeBatchCandidate(record, { forMigrationReport: true });
    const validation = validateSchema('batch', normalized);

    if (!validation.ok) {
      const batchId = asString(asRecord(record).batchId) ?? null;
      report.invalidRecords.push({
        index,
        batchId,
        issues: validation.issues.map((issue) => `${issue.path} ${issue.message}`),
      });
      return;
    }

    const metaWarnings = asRecord(validation.value.meta).migration;
    if (metaWarnings && typeof metaWarnings === 'object' && Array.isArray((metaWarnings as Record<string, unknown>).warningCodes)) {
      const warningCodes = (metaWarnings as Record<string, unknown>).warningCodes as BatchMigrationWarningCode[];
      warningCodes.forEach((code) => {
        report.warnings.push({
          batchId: validation.value.batchId,
          code,
          message: `Normalized ${validation.value.batchId} with ${code}.`,
        });
      });
    }

    report.migrated += 1;
    batches.push(validation.value);
  });

  return { batches, report };
};


type BatchAssignmentWithRange = Batch['assignments'][number] & {
  fromDate?: string;
  toDate?: string | null;
};

type AssignBatchMeta = {
  move?: boolean;
};

const getAssignmentFromDate = (assignment: BatchAssignmentWithRange): string => assignment.fromDate ?? assignment.assignedAt;

const getAssignmentToDate = (assignment: BatchAssignmentWithRange): string | null => assignment.toDate ?? null;

const isDateWithinAssignmentWindow = (assignment: BatchAssignmentWithRange, onDate: string): boolean => {
  const fromDate = getAssignmentFromDate(assignment);
  const toDate = getAssignmentToDate(assignment);

  if (fromDate > onDate) {
    return false;
  }

  if (toDate && toDate < onDate) {
    return false;
  }

  return true;
};

const assignmentsOverlap = (
  left: BatchAssignmentWithRange,
  rightFromDate: string,
  rightToDate: string | null,
): boolean => {
  const leftFromDate = getAssignmentFromDate(left);
  const leftToDate = getAssignmentToDate(left);
  const leftToBoundary = leftToDate ?? '9999-12-31T23:59:59.999Z';
  const rightToBoundary = rightToDate ?? '9999-12-31T23:59:59.999Z';

  return leftFromDate <= rightToBoundary && rightFromDate <= leftToBoundary;
};

export const assignBatchToBed = (
  batch: Batch,
  bedId: string,
  fromDate: string,
  meta?: AssignBatchMeta,
): Batch => {
  const validBatch = batch;
  const assignments = validBatch.assignments as BatchAssignmentWithRange[];
  const incomingToDate: string | null = null;

  const hasSameBedActiveAssignment = assignments.some(
    (assignment) => assignment.bedId === bedId && isDateWithinAssignmentWindow(assignment, fromDate),
  );

  if (hasSameBedActiveAssignment) {
    return validBatch;
  }

  if (!meta?.move) {
    const hasOverlapConflict = assignments.some((assignment) => assignmentsOverlap(assignment, fromDate, incomingToDate));

    if (hasOverlapConflict) {
      throw new Error('batch_assignment_overlap');
    }
  }

  const nextAssignment = {
    bedId,
    assignedAt: fromDate,
    fromDate,
  } as Batch['assignments'][number];

  return {
    ...validBatch,
    assignments: [...validBatch.assignments, nextAssignment],
  };
};

export const getActiveBedAssignment = (
  batch: Batch,
  onDate: string,
): BatchAssignmentWithRange | null => {
  let activeAssignment: BatchAssignmentWithRange | null = null;

  for (const assignment of batch.assignments as BatchAssignmentWithRange[]) {
    if (!isDateWithinAssignmentWindow(assignment, onDate)) {
      continue;
    }

    const fromDate = getAssignmentFromDate(assignment);

    if (!activeAssignment || getAssignmentFromDate(activeAssignment) <= fromDate) {
      activeAssignment = assignment;
    }
  }

  return activeAssignment;
};

export const moveBatch = (
  batch: Batch,
  newBedId: string,
  moveDate: string,
  _meta?: AssignBatchMeta,
): Batch => {
  void _meta;
  const activeAssignment = getActiveBedAssignment(batch, moveDate);

  if (!activeAssignment) {
    throw new Error('batch_assignment_no_active');
  }

  const activeFromDate = getAssignmentFromDate(activeAssignment);

  if (moveDate < activeFromDate) {
    throw new Error('batch_assignment_move_before_start');
  }

  if (activeAssignment.bedId === newBedId) {
    return batch;
  }

  const updatedAssignments = (batch.assignments as BatchAssignmentWithRange[]).map((assignment) => {
    if (assignment !== activeAssignment) {
      return assignment;
    }

    return {
      ...assignment,
      toDate: moveDate,
    };
  });

  const nextAssignment = {
    bedId: newBedId,
    assignedAt: moveDate,
    fromDate: moveDate,
  } as Batch['assignments'][number];

  return {
    ...batch,
    assignments: [...updatedAssignments, nextAssignment],
  };
};

export const removeBatchFromBed = (batch: Batch, endDate: string): Batch => {
  const activeAssignment = getActiveBedAssignment(batch, endDate);

  if (!activeAssignment) {
    return batch;
  }

  return {
    ...batch,
    assignments: (batch.assignments as BatchAssignmentWithRange[]).map((assignment) => {
      if (assignment !== activeAssignment) {
        return assignment;
      }

      return {
        ...assignment,
        toDate: endDate,
      };
    }) as Batch['assignments'],
  };
};

const getDerivedBedId = (batch: Batch, onDate: string): string | null => getActiveBedAssignment(batch, onDate)?.bedId ?? null;

export const getBatchFromAppState = (
  appState: unknown,
  batchId: Batch['batchId'],
): Batch | null => {
  const state = asRecord(appState);
  const records = Array.isArray(state.batches) ? state.batches : [];

  for (const record of records) {
    const normalized = normalizeBatchCandidate(record);
    const validation = validateSchema('batch', normalized);

    if (validation.ok && validation.value.batchId === batchId) {
      return validation.value;
    }
  }

  return null;
};

export const listBatchesFromAppState = (
  appState: unknown,
  query: ListQuery<BatchListFilter> = {},
): Batch[] => {
  const state = asRecord(appState);
  const records = Array.isArray(state.batches) ? state.batches : [];
  const { filter } = query;
  const onDate = new Date().toISOString();

  return records
    .map((record) => validateSchema('batch', normalizeBatchCandidate(record)))
    .filter((result): result is { ok: true; value: Batch } => result.ok)
    .map((result) => result.value)
    .filter((batch) => {
      if (!filter) {
        return true;
      }

      if (filter.stage && batch.stage !== filter.stage) {
        return false;
      }

      if (filter.cropId && batch.cultivarId !== filter.cropId && batch.cropId !== filter.cropId) {
        return false;
      }

      if (filter.bedId && getDerivedBedId(batch, onDate) !== filter.bedId) {
        return false;
      }

      if (filter.startedAtFrom && batch.startedAt < filter.startedAtFrom) {
        return false;
      }

      if (filter.startedAtTo && batch.startedAt > filter.startedAtTo) {
        return false;
      }

      return true;
    });
};

export const upsertBatchInAppState = (appState: unknown, batch: unknown): AppState => {
  const state = assertValid('appState', appState);
  const validBatch = assertValid('batch', normalizeBatchCandidate(batch));
  const existingIndex = state.batches.findIndex((entry) => entry.batchId === validBatch.batchId);

  if (existingIndex >= 0) {
    const existingBatch = state.batches[existingIndex]!;

    if (existingBatch.stage !== validBatch.stage) {
      const latestStageEvent = validBatch.stageEvents[validBatch.stageEvents.length - 1];

      if (!latestStageEvent || latestStageEvent.stage !== validBatch.stage) {
        throw new Error('stage_event_stage_mismatch');
      }

      const transition = applyStageEvent(existingBatch, latestStageEvent);

      if (!transition.ok) {
        throw new Error(transition.reason);
      }
    }
  }

  const batches =
    existingIndex >= 0
      ? state.batches.map((entry, index) => (index === existingIndex ? validBatch : entry))
      : [...state.batches, validBatch];

  return assertValid('appState', { ...state, batches });
};

export const removeBatchFromAppState = (appState: unknown, batchId: Batch['batchId']): AppState => {
  const state = assertValid('appState', appState);
  const batches = state.batches.filter((batch) => batch.batchId !== batchId);
  return assertValid('appState', { ...state, batches });
};
