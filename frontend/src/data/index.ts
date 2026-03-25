import type { AppState, Batch } from '../contracts';
import { assertValid } from './validation';
import { getSettingsOrDefault } from './repos/settingsRepository';
import { mergeTaskForImport } from './repos/taskRepository';
import goldenDatasetFixture from '../../../fixtures/golden/trier-v1.json';

export {
  getBedFromAppState,
  listBedsFromAppState,
  removeBedFromAppState,
  upsertBedInAppState,
} from './repos/bedRepository';
export {
  getCropFromAppState,
  listCropsFromAppState,
  removeCropFromAppState,
  upsertCropInAppState,
} from './repos/cropRepository';
export {
  getCropPlanFromAppState,
  listCropPlansFromAppState,
  removeCropPlanFromAppState,
  upsertCropPlanInAppState,
} from './repos/cropPlanRepository';
export {
  assignBatchToBed,
  getActiveBedAssignment,
  getBatchFromAppState,
  listBatchesFromAppState,
  moveBatch,
  normalizeBatchCandidate,
  removeBatchFromBed,
  removeBatchFromAppState,
  upsertBatchInAppState,
} from './repos/batchRepository';

export {
  getSeedInventoryItemFromAppState,
  listSeedInventoryItemsFromAppState,
  removeSeedInventoryItemFromAppState,
  upsertSeedInventoryItemInAppState,
} from './repos/seedInventoryRepository';
export {
  getSettingsFromAppState,
  getSettingsOrDefault,
  saveSettingsInAppState,
} from './repos/settingsRepository';
export {
  generateCalendarTasksWithDiagnostics,
  generateOperationalTasks,
  generatePlannedTasks,
  getTaskFromAppState,
  listTasksFromAppState,
  removeTaskFromAppState,
  upsertGeneratedTasksInAppState,
  upsertTaskInAppState,
} from './repos/taskRepository';

const APP_STATE_DB_NAME = 'survival-garden';
const APP_STATE_DB_VERSION = 6;
const APP_STATE_STORE = 'appState';
const APP_STATE_RECORD_KEY = 'current';
const META_STORE = 'meta';
const BED_INDEX_STORE = 'bedsById';
const CROP_INDEX_STORE = 'cropsById';
const CROP_PLAN_INDEX_STORE = 'cropPlansById';
const BATCH_INDEX_STORE = 'batchesById';
const PHOTO_BLOB_STORE = 'photoBlobsById';
const SCHEMA_VERSION_KEY = 'schemaVersion';
const DEFAULT_SEGMENT_ID = 'segment_default_main';
const DEFAULT_SEGMENT_NAME = 'Main Segment';
const DEFAULT_SEGMENT_ORIGIN = 'default_bootstrap';
type AppSegment = NonNullable<AppState['segments']>[number];

const LEGACY_BED_TYPE = 'vegetable_bed';

type LayoutMigrationWarningCode =
  | 'legacy_layout_segment_created'
  | 'legacy_layout_paths_dropped'
  | 'legacy_layout_crop_plan_segment_missing'
  | 'legacy_layout_crop_plan_segment_ambiguous'
  | 'legacy_layout_crop_plan_placement_shifted'
  | 'legacy_layout_crop_plan_placement_unmigrated';

type LayoutMigrationWarning = {
  code: LayoutMigrationWarningCode;
  message: string;
  entityType?: 'segment' | 'bed' | 'path' | 'cropPlan';
  entityId?: string;
};

type LayoutMigrationReport = {
  migrated: boolean;
  warnings: LayoutMigrationWarning[];
};

const addTypeToLegacyBed = <T extends Record<string, unknown>>(bed: T): T => ({
  ...bed,
  type: typeof bed.type === 'string' ? bed.type : LEGACY_BED_TYPE,
});

const migrateLegacyBedTypes = (payload: unknown): unknown => {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const state = payload as Record<string, unknown>;
  const beds = Array.isArray(state.beds)
    ? state.beds.map((bed) => (bed && typeof bed === 'object' ? addTypeToLegacyBed(bed as Record<string, unknown>) : bed))
    : state.beds;

  const segments = Array.isArray(state.segments)
    ? state.segments.map((segment) => {
        if (!segment || typeof segment !== 'object') {
          return segment;
        }

        const typedSegment = segment as Record<string, unknown>;
        const segmentBeds = Array.isArray(typedSegment.beds)
          ? typedSegment.beds.map((bed) =>
              bed && typeof bed === 'object' ? addTypeToLegacyBed(bed as Record<string, unknown>) : bed,
            )
          : typedSegment.beds;

        return {
          ...typedSegment,
          beds: segmentBeds,
          paths: Array.isArray(typedSegment.paths) ? typedSegment.paths : [],
        };
      })
    : state.segments;

  return {
    ...state,
    beds,
    segments,
  };
};

const toFiniteNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const getWidthMeters = (value: Record<string, unknown>): number | null => toFiniteNumber(value.widthM) ?? toFiniteNumber(value.width);

const getLengthMeters = (value: Record<string, unknown>): number | null => toFiniteNumber(value.lengthM) ?? toFiniteNumber(value.height);

const createDefaultSegment = (
  dimensions: { widthM?: number; lengthM?: number } = {},
): AppSegment => {
  const width = Math.max(dimensions.widthM ?? 1, 1);
  const length = Math.max(dimensions.lengthM ?? 1, 1);

  return {
    segmentId: DEFAULT_SEGMENT_ID,
    name: DEFAULT_SEGMENT_NAME,
    originReference: DEFAULT_SEGMENT_ORIGIN,
    widthM: width,
    lengthM: length,
    width,
    height: length,
    beds: [],
    paths: [],
  };
};

const migrateLegacyLayoutModel = (payload: unknown): { payload: unknown; report: LayoutMigrationReport } => {
  const report: LayoutMigrationReport = { migrated: false, warnings: [] };

  if (!payload || typeof payload !== 'object') {
    return { payload, report };
  }

  const state = payload as Record<string, unknown>;

  const cropPlanWarningMeta = (plan: Record<string, unknown>): { entityType: 'cropPlan'; entityId?: string } =>
    typeof plan.planId === 'string' ? { entityType: 'cropPlan', entityId: plan.planId } : { entityType: 'cropPlan' };

  const shiftPlacementsToBedRelative = (
    placements: unknown[],
    bed: { x: number; y: number; width: number; height: number },
  ): { placements: unknown[]; shifted: boolean } => {
    let shifted = false;

    const shiftPoint = (point: unknown): unknown => {
      if (!point || typeof point !== 'object') {
        return point;
      }

      const typedPoint = point as Record<string, unknown>;
      const x = toFiniteNumber(typedPoint.x);
      const y = toFiniteNumber(typedPoint.y);

      if (x === null || y === null) {
        return point;
      }

      if (x <= bed.width && y <= bed.height && x >= 0 && y >= 0) {
        return point;
      }

      const shiftedX = x - bed.x;
      const shiftedY = y - bed.y;

      if (shiftedX < 0 || shiftedY < 0 || shiftedX > bed.width || shiftedY > bed.height) {
        return point;
      }

      shifted = true;
      return { ...typedPoint, x: shiftedX, y: shiftedY };
    };

    const normalized = placements.map((placement) => {
      if (!placement || typeof placement !== 'object') {
        return placement;
      }

      const typedPlacement = placement as Record<string, unknown>;

      if (typedPlacement.type === 'points' && Array.isArray(typedPlacement.points)) {
        return {
          ...typedPlacement,
          points: typedPlacement.points.map((point) => shiftPoint(point)),
        };
      }

      if (typedPlacement.type !== 'formula' || !typedPlacement.formula || typeof typedPlacement.formula !== 'object') {
        return placement;
      }

      const typedFormula = typedPlacement.formula as Record<string, unknown>;

      if (typedFormula.kind === 'line') {
        return {
          ...typedPlacement,
          formula: {
            ...typedFormula,
            start: shiftPoint(typedFormula.start),
            end: shiftPoint(typedFormula.end),
          },
        };
      }

      return {
        ...typedPlacement,
        formula: {
          ...typedFormula,
          origin: shiftPoint(typedFormula.origin),
        },
      };
    });

    return { placements: normalized, shifted };
  };

  const withSegments = (nextState: Record<string, unknown>, assignSegmentIdsToPlans: boolean): Record<string, unknown> => {
    if (!Array.isArray(nextState.segments)) {
      return nextState;
    }

    const bedToSegment = new Map<string, { segmentId: string; bed: { x: number; y: number; width: number; height: number } | null }>();

    nextState.segments.forEach((segment) => {
      if (!segment || typeof segment !== 'object') {
        return;
      }

      const typedSegment = segment as Record<string, unknown>;
      if (typeof typedSegment.segmentId !== 'string' || !Array.isArray(typedSegment.beds)) {
        return;
      }

      const segmentId = typedSegment.segmentId;

      typedSegment.beds.forEach((bed) => {
        if (!bed || typeof bed !== 'object') {
          return;
        }

        const typedBed = bed as Record<string, unknown>;
        if (typeof typedBed.bedId !== 'string') {
          return;
        }

        if (bedToSegment.has(typedBed.bedId)) {
          bedToSegment.set(typedBed.bedId, { segmentId: '__ambiguous__', bed: null });
          return;
        }

        const x = toFiniteNumber(typedBed.x);
        const y = toFiniteNumber(typedBed.y);
        const width = getWidthMeters(typedBed);
        const height = getLengthMeters(typedBed);

        bedToSegment.set(typedBed.bedId, {
          segmentId,
          bed: x !== null && y !== null && width !== null && height !== null ? { x, y, width, height } : null,
        });
      });
    });

    if (!Array.isArray(nextState.cropPlans)) {
      return nextState;
    }

    return {
      ...nextState,
      cropPlans: nextState.cropPlans.map((plan) => {
        if (!plan || typeof plan !== 'object') {
          return plan;
        }

        const typedPlan = plan as Record<string, unknown>;
        const bedId = typeof typedPlan.bedId === 'string' ? typedPlan.bedId : null;

        if (!bedId) {
          return plan;
        }

        const placementOwner = bedToSegment.get(bedId);

        if (!placementOwner) {
          report.warnings.push({
            code: 'legacy_layout_crop_plan_segment_missing',
            message: `Crop plan bed '${bedId}' does not map to a migrated segment.`,
            ...cropPlanWarningMeta(typedPlan),
          });
          return plan;
        }

        if (placementOwner.segmentId === '__ambiguous__') {
          report.warnings.push({
            code: 'legacy_layout_crop_plan_segment_ambiguous',
            message: `Crop plan bed '${bedId}' maps to multiple segments.`,
            ...cropPlanWarningMeta(typedPlan),
          });
          return plan;
        }

        let migratedPlan: Record<string, unknown> = typedPlan;
        if (assignSegmentIdsToPlans && typeof typedPlan.segmentId !== 'string') {
          migratedPlan = { ...migratedPlan, segmentId: placementOwner.segmentId };
          report.migrated = true;
        }

        if (Array.isArray(typedPlan.placements) && placementOwner.bed) {
          const shifted = shiftPlacementsToBedRelative(typedPlan.placements, placementOwner.bed);
          if (shifted.shifted) {
            migratedPlan = { ...migratedPlan, placements: shifted.placements };
            report.migrated = true;
            report.warnings.push({
              code: 'legacy_layout_crop_plan_placement_shifted',
              message: `Shifted crop plan placements for bed '${bedId}' to bed-relative coordinates.`,
              ...cropPlanWarningMeta(typedPlan),
            });
          }
        } else if (Array.isArray(typedPlan.placements)) {
          report.warnings.push({
            code: 'legacy_layout_crop_plan_placement_unmigrated',
            message: `Crop plan placements for bed '${bedId}' could not be converted to bed-relative coordinates.`,
            ...cropPlanWarningMeta(typedPlan),
          });
        }

        return migratedPlan;
      }),
    };
  };

  if (Array.isArray(state.segments) && state.segments.length > 0) {
    const normalizedSegments = state.segments.map((segment) => {
      if (!segment || typeof segment !== 'object') {
        return segment;
      }

      const typedSegment = segment as Record<string, unknown>;
      return {
        ...typedSegment,
        beds: Array.isArray(typedSegment.beds) ? typedSegment.beds : [],
        paths: Array.isArray(typedSegment.paths) ? typedSegment.paths : [],
      };
    });

    return {
      payload: withSegments(
        {
          ...state,
          beds: Array.isArray(state.beds) ? state.beds : [],
          segments: normalizedSegments,
        },
        false,
      ),
      report,
    };
  }

  const legacyBeds = Array.isArray(state.beds)
    ? state.beds.filter((bed): bed is Record<string, unknown> => Boolean(bed && typeof bed === 'object'))
    : [];

  const migratedBeds = legacyBeds.map((bed, index) => {
    const x = toFiniteNumber(bed.x) ?? 0;
    const y = toFiniteNumber(bed.y) ?? index;
    const width = getWidthMeters(bed);
    const height = getLengthMeters(bed);
    const rest = { ...bed };
    delete rest.widthM;
    delete rest.lengthM;
    return {
      ...rest,
      segmentId: DEFAULT_SEGMENT_ID,
      x,
      y,
      ...(width !== null ? { widthM: width, width } : {}),
      ...(height !== null ? { lengthM: height, height } : {}),
    };
  });

  const maxX = legacyBeds.reduce((max, bed) => Math.max(max, (toFiniteNumber(bed.x) ?? 0) + (getWidthMeters(bed) ?? 1)), 0);
  const maxY = legacyBeds.reduce((max, bed, index) => Math.max(max, (toFiniteNumber(bed.y) ?? index) + (getLengthMeters(bed) ?? 1)), 0);

  const legacyPaths = Array.isArray((state as { paths?: unknown[] }).paths)
    ? ((state as { paths?: unknown[] }).paths ?? []).filter((path) => {
        if (!path || typeof path !== 'object') {
          return false;
        }
        const typedPath = path as Record<string, unknown>;
        return (
          typeof typedPath.pathId === 'string' &&
          typeof typedPath.name === 'string' &&
          toFiniteNumber(typedPath.x) !== null &&
          toFiniteNumber(typedPath.y) !== null &&
          getWidthMeters(typedPath) !== null &&
          getLengthMeters(typedPath) !== null
        );
      })
      .map((path) => {
        const typedPath = path as Record<string, unknown>;
        return {
          ...typedPath,
          segmentId: DEFAULT_SEGMENT_ID,
          widthM: getWidthMeters(typedPath),
          lengthM: getLengthMeters(typedPath),
        };
      })
    : [];

  if (Array.isArray((state as { paths?: unknown[] }).paths) && legacyPaths.length !== (state as { paths?: unknown[] }).paths?.length) {
    report.warnings.push({
      code: 'legacy_layout_paths_dropped',
      message: 'Some legacy paths were dropped because required geometry fields were missing.',
      entityType: 'segment',
      entityId: DEFAULT_SEGMENT_ID,
    });
  }

  const defaultSegment = createDefaultSegment({
    widthM: Math.max(maxX, 1),
    lengthM: Math.max(maxY, 1),
  });

  const nextState = {
    ...state,
    beds: Array.isArray(state.beds) ? state.beds : [],
    paths: [],
    segments: [
      {
        ...defaultSegment,
        originReference: 'legacy_migration_auto',
        beds: migratedBeds,
        paths: legacyPaths,
      },
    ],
  };

  report.migrated = true;
  report.warnings.push({
    code: 'legacy_layout_segment_created',
    message: 'Created default segment and migrated legacy layout entities.',
    entityType: 'segment',
    entityId: DEFAULT_SEGMENT_ID,
  });

  return { payload: withSegments(nextState, true), report };
};

const GOLDEN_DATASET = assertValid('appState', migrateLegacyLayoutModel(migrateLegacyBedTypes(goldenDatasetFixture)).payload);

export type {
  AppStateRepository,
  BatchListFilter,
  BatchRepository,
  BedRepository,
  CropPlanRepository,
  CropRepository,
  CrudRepository,
  ListQuery,
  ListableRepository,
  SeedInventoryRepository,
  SettingsRepository,
  TaskRepository,
  Unsubscribe,
  WatchableRepository,
} from './repos/interfaces';

export {
  SchemaValidationError,
  type SchemaName,
  type SchemaTypeMap,
  type ValidationIssue,
  assertValid,
} from './validation';

const normalizeImportedSpeciesRecords = (payload: unknown): unknown => {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.species)) {
    return payload;
  }

  return {
    ...record,
    species: record.species.map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return entry;
      }

      const species = { ...(entry as Record<string, unknown>) };
      if (typeof species.commonName !== 'string' || species.commonName.trim().length === 0) {
        delete species.commonName;
      }

      return species;
    }),
  };
};

const normalizeSeedInventoryCultivarIdPart = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

const migrateLegacySeedInventoryItems = (payload: unknown): unknown => {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const state = payload as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(state, 'cultivars')) {
    return payload;
  }
  const seedInventoryItems = Array.isArray(state.seedInventoryItems) ? state.seedInventoryItems : [];
  const cropIds = new Set(
    (Array.isArray(state.crops) ? state.crops : [])
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
      .map((entry) => (typeof entry.cropId === 'string' ? entry.cropId : null))
      .filter((entry): entry is string => entry !== null),
  );
  const existingCultivars = Array.isArray(state.cultivars) ? [...state.cultivars] : [];
  const usedCultivarIds = new Set(
    existingCultivars
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
      .map((entry) => (typeof entry.cultivarId === 'string' ? entry.cultivarId : null))
      .filter((entry): entry is string => entry !== null),
  );
  const nowIso = new Date().toISOString();

  const getOrCreateCultivarId = (cropId: string, variety: string): string | null => {
    const exactMatch = existingCultivars.find((entry) => {
      if (!entry || typeof entry !== 'object') {
        return false;
      }

      const cultivar = entry as Record<string, unknown>;
      return cultivar.cropTypeId === cropId
        && typeof cultivar.name === 'string'
        && cultivar.name.trim().toLowerCase() === variety.trim().toLowerCase()
        && typeof cultivar.cultivarId === 'string';
    }) as Record<string, unknown> | undefined;

    if (exactMatch && typeof exactMatch.cultivarId === 'string') {
      return exactMatch.cultivarId;
    }

    if (!cropIds.has(cropId)) {
      return null;
    }

    const base = normalizeSeedInventoryCultivarIdPart(`${cropId}-${variety}`) || `seed-inventory-${Date.now()}`;
    let candidate = `cultivar_${base}`;
    let suffix = 1;
    while (usedCultivarIds.has(candidate)) {
      suffix += 1;
      candidate = `cultivar_${base}-${suffix}`;
    }

    usedCultivarIds.add(candidate);
    existingCultivars.push({
      cultivarId: candidate,
      cropTypeId: cropId,
      name: variety,
      notes: '[Migrated from legacy seed inventory item]',
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    return candidate;
  };

  const migratedSeedInventoryItems = seedInventoryItems.map((item) => {
    if (!item || typeof item !== 'object') {
      return item;
    }

    const typedItem = { ...(item as Record<string, unknown>) };
    if (typeof typedItem.cultivarId === 'string' && typedItem.cultivarId.trim().length > 0) {
      return typedItem;
    }

    if (typeof typedItem.cropId !== 'string' || typeof typedItem.variety !== 'string') {
      return typedItem;
    }

    const cropId = typedItem.cropId.trim();
    const variety = typedItem.variety.trim();
    if (!cropId || !variety) {
      return typedItem;
    }

    const cultivarId = getOrCreateCultivarId(cropId, variety);
    if (!cultivarId) {
      return typedItem;
    }

    return {
      ...typedItem,
      cultivarId,
    };
  });

  if (existingCultivars.length === 0 && !Object.prototype.hasOwnProperty.call(state, 'cultivars')) {
    return {
      ...state,
      seedInventoryItems: migratedSeedInventoryItems,
    };
  }

  return {
    ...state,
    cultivars: existingCultivars,
    seedInventoryItems: migratedSeedInventoryItems,
  };
};

const compareByString = (left: string, right: string): number => left.localeCompare(right);

const getStringValue = (record: unknown, key: string): string | null => {
  if (!record || typeof record !== 'object') {
    return null;
  }

  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
};

const sortCollectionByKey = <T>(collection: T[], keys: string[]): T[] =>
  [...collection].sort((left, right) => {
    for (const key of keys) {
      const leftValue = getStringValue(left, key);
      const rightValue = getStringValue(right, key);

      if (leftValue !== null && rightValue !== null && leftValue !== rightValue) {
        return compareByString(leftValue, rightValue);
      }
    }

    return compareByString(JSON.stringify(left), JSON.stringify(right));
  });


type HierarchyAppState = AppState & { cultivars?: unknown[] };

type HierarchyValidationResult = {
  warnings: string[];
  errors: string[];
};

const asObjectRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeHierarchyLabel = (value: string): string => value.trim().toLowerCase();

const getCultivarsFromState = (appState: AppState): unknown[] => {
  const cultivars = (appState as HierarchyAppState).cultivars;
  return Array.isArray(cultivars) ? cultivars : [];
};

const withCultivars = (appState: AppState, cultivars: unknown[]): AppState => {
  const hasCultivarsProperty = Object.prototype.hasOwnProperty.call(appState, 'cultivars');

  if (!hasCultivarsProperty && cultivars.length === 0) {
    return appState;
  }

  return {
    ...(appState as HierarchyAppState),
    cultivars,
  } as AppState;
};

const collectDuplicateIds = (records: unknown[], idKey: string, label: string): string[] => {
  const recordIndexes = new Map<string, number[]>();

  records.forEach((record, index) => {
    const id = asNonEmptyString(asObjectRecord(record)?.[idKey]);
    if (!id) {
      return;
    }

    const indexes = recordIndexes.get(id) ?? [];
    indexes.push(index);
    recordIndexes.set(id, indexes);
  });

  return [...recordIndexes.entries()]
    .filter(([, indexes]) => indexes.length > 1)
    .map(([id, indexes]) => `${label}:${id} is duplicated at indexes ${indexes.join(', ')}.`);
};

const collectAmbiguousNameWarnings = (
  records: unknown[],
  parentKey: string,
  nameKeys: string[],
  idKey: string,
  label: string,
): string[] => {
  const recordsByParentAndName = new Map<string, string[]>();

  records.forEach((record) => {
    const entry = asObjectRecord(record);
    if (!entry) {
      return;
    }

    const parentId = asNonEmptyString(entry[parentKey]) ?? 'unscoped';
    const name = nameKeys.map((key) => asNonEmptyString(entry[key])).find((value) => value !== null);
    const id = asNonEmptyString(entry[idKey]);

    if (!name || !id) {
      return;
    }

    const bucketKey = `${parentId}::${normalizeHierarchyLabel(name)}`;
    const ids = recordsByParentAndName.get(bucketKey) ?? [];
    ids.push(id);
    recordsByParentAndName.set(bucketKey, ids);
  });

  return [...recordsByParentAndName.entries()]
    .filter(([, ids]) => new Set(ids).size > 1)
    .map(([key, ids]) => {
      const [parentId, name] = key.split('::');
      return `${label}:${parentId}:${name} maps to multiple records (${[...new Set(ids)].join(', ')}).`;
    });
};

const validateHierarchyForImport = (appState: AppState): HierarchyValidationResult => {
  const warnings: string[] = [];
  const errors: string[] = [];
  const species = Array.isArray(appState.species) ? appState.species : [];
  const crops = Array.isArray(appState.crops) ? appState.crops : [];
  const cultivars = getCultivarsFromState(appState);
  const batches = Array.isArray(appState.batches) ? appState.batches : [];

  errors.push(...collectDuplicateIds(species, 'id', 'species'));
  errors.push(...collectDuplicateIds(crops, 'cropId', 'cropType'));
  errors.push(...collectDuplicateIds(cultivars, 'cultivarId', 'cultivar'));
  errors.push(...collectDuplicateIds(batches, 'batchId', 'batch'));

  warnings.push(...collectAmbiguousNameWarnings(crops, 'speciesId', ['name', 'cultivar'], 'cropId', 'cropType'));
  warnings.push(...collectAmbiguousNameWarnings(cultivars, 'cropTypeId', ['name'], 'cultivarId', 'cultivar'));

  const speciesIds = new Set(species.map((entry) => entry.id));
  const cropIds = new Set(crops.map((entry) => entry.cropId));
  const cultivarParentById = new Map<string, string>();

  crops.forEach((crop, index) => {
    if (crop.speciesId && !speciesIds.has(crop.speciesId)) {
      errors.push(`cropType:${crop.cropId} references missing species:${crop.speciesId} at index ${index}.`);
    }

    if (!crop.speciesId) {
      warnings.push(`cropType:${crop.cropId} is missing speciesId; importer cannot guarantee parent-first taxonomy resolution.`);
    }
  });

  cultivars.forEach((record, index) => {
    const cultivar = asObjectRecord(record);
    if (!cultivar) {
      return;
    }

    const cultivarId = asNonEmptyString(cultivar.cultivarId);
    const cropTypeId = asNonEmptyString(cultivar.cropTypeId);

    if (!cultivarId || !cropTypeId) {
      errors.push(`cultivar index ${index} is missing cultivarId or cropTypeId.`);
      return;
    }

    cultivarParentById.set(cultivarId, cropTypeId);
    if (!cropIds.has(cropTypeId)) {
      errors.push(`cultivar:${cultivarId} references missing cropType:${cropTypeId} at index ${index}.`);
    }
  });

  batches.forEach((batch, index) => {
    const cultivarId = asNonEmptyString(batch.cultivarId);
    const legacyCropId = asNonEmptyString(batch.cropId);
    const cropTypeId = asNonEmptyString(batch.cropTypeId);
    const resolvedLegacyParent = legacyCropId && cropIds.has(legacyCropId);
    const resolvedCultivarParent = cultivarId && (cultivarParentById.has(cultivarId) || cropIds.has(cultivarId));

    if (!cultivarId && !legacyCropId) {
      errors.push(`batch:${batch.batchId} is missing cultivarId/cropId and cannot be resolved.`);
      return;
    }

    if (cultivarId && !resolvedCultivarParent) {
      errors.push(`batch:${batch.batchId} references missing cultivar:${cultivarId}.`);
    }

    if (!cultivarId && legacyCropId && !resolvedLegacyParent) {
      errors.push(`batch:${batch.batchId} references missing legacy cropType:${legacyCropId}.`);
    }

    if (cropTypeId && !cropIds.has(cropTypeId)) {
      errors.push(`batch:${batch.batchId} references missing cropType:${cropTypeId} at index ${index}.`);
    }

    if (cultivarId && cropTypeId) {
      const expectedCropTypeId = cultivarParentById.get(cultivarId);
      if (expectedCropTypeId && expectedCropTypeId !== cropTypeId) {
        warnings.push(`batch:${batch.batchId} declares cropType:${cropTypeId} but cultivar:${cultivarId} belongs to ${expectedCropTypeId}.`);
      }
    }
  });

  return { warnings, errors };
};

const sortBatchesForHierarchy = (batches: AppState['batches']): AppState['batches'] =>
  [...batches]
    .map((batch) => ({
      ...batch,
      stageEvents: sortCollectionByKey(batch.stageEvents, ['occurredAt', 'stage', 'type']),
      assignments: sortCollectionByKey(batch.assignments, ['bedId', 'assignedAt', 'fromDate']),
      photos: Array.isArray((batch as Batch & { photos?: unknown[] }).photos)
        ? sortCollectionByKey((batch as Batch & { photos?: unknown[] }).photos ?? [], ['id', 'storageRef', 'capturedAt', 'filename'])
        : (batch as Batch & { photos?: unknown[] }).photos,
    }))
    .sort((left, right) => {
      const comparisons: Array<[string | null, string | null]> = [
        [asNonEmptyString(left.cropTypeId) ?? asNonEmptyString(left.cropId), asNonEmptyString(right.cropTypeId) ?? asNonEmptyString(right.cropId)],
        [asNonEmptyString(left.cultivarId) ?? asNonEmptyString(left.cropId), asNonEmptyString(right.cultivarId) ?? asNonEmptyString(right.cropId)],
        [left.startedAt, right.startedAt],
        [left.batchId, right.batchId],
      ];

      for (const [leftValue, rightValue] of comparisons) {
        if (leftValue && rightValue && leftValue !== rightValue) {
          return compareByString(leftValue, rightValue);
        }
      }

      return compareByString(JSON.stringify(left), JSON.stringify(right));
    });

const canonicalizeForExport = (appState: AppState): AppState => {
  const cultivars = sortCollectionByKey(getCultivarsFromState(appState), ['cropTypeId', 'cultivarId', 'name']);
  const canonicalSegments = sortCollectionByKey(
    (appState.segments && appState.segments.length > 0 ? appState.segments : [createDefaultSegment()]).map((segment) => ({
      ...segment,
      beds: sortCollectionByKey(segment.beds, ['bedId', 'gardenId', 'name']),
      paths: sortCollectionByKey(segment.paths, ['pathId', 'name']),
    })),
    ['segmentId', 'name'],
  );

  return withCultivars({
    ...appState,
    beds: sortCollectionByKey(appState.beds, ['bedId', 'gardenId', 'name']),
    ...(appState.species
      ? { species: sortCollectionByKey(appState.species, ['id', 'commonName', 'scientificName']) }
      : {}),
    crops: sortCollectionByKey(appState.crops, ['speciesId', 'cropId', 'name', 'cultivar']),
    cropPlans: sortCollectionByKey(appState.cropPlans, ['cropId', 'planId']),
    batches: sortBatchesForHierarchy(appState.batches),
    seedInventoryItems: sortCollectionByKey(appState.seedInventoryItems, ['seedInventoryItemId', 'cultivarId']),
    tasks: sortCollectionByKey(appState.tasks, ['id', 'sourceKey']),
    segments: canonicalSegments,
  }, cultivars);
};

export const parseImportedAppState = (rawPayload: string): AppState => {
  const parsed: unknown = migrateLegacySeedInventoryItems(normalizeImportedSpeciesRecords(JSON.parse(rawPayload)));
  const migrationResult = migrateLegacyLayoutModel(migrateLegacyBedTypes(parsed));

  if (migrationResult.report.warnings.length > 0) {
    console.warn('AppState migration warnings', migrationResult.report.warnings);
  }

  const validatedState = canonicalizeForExport(assertValid('appState', migrationResult.payload));
  const hierarchyValidation = validateHierarchyForImport(validatedState);

  if (hierarchyValidation.warnings.length > 0) {
    console.warn('AppState import hierarchy warnings', hierarchyValidation.warnings);
  }

  if (hierarchyValidation.errors.length > 0) {
    throw new AppStateStorageError(`Import hierarchy validation failed: ${hierarchyValidation.errors.join(' ')}`);
  }

  return validatedState;
};

export const serializeAppStateForExport = (appState: unknown): string => {
  const validState = assertValid('appState', appState);
  return JSON.stringify(canonicalizeForExport(validState));
};

export const loadAppStateFromStorage = (
  storage: Pick<Storage, 'getItem'>,
  key: string,
): AppState | null => {
  const value = storage.getItem(key);

  if (value === null) {
    return null;
  }

  return parseImportedAppState(value);
};

export const saveAppStateToStorage = (
  storage: Pick<Storage, 'setItem'>,
  key: string,
  appState: unknown,
): void => {
  storage.setItem(key, serializeAppStateForExport(appState));
};

export class AppStateStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppStateStorageError';
  }
}

type SaveAppStateOptions = {
  mode?: 'merge' | 'replace';
};

type MergeReportSection = {
  added: number;
  updated: number;
  unchanged: number;
};

type MergeReport = {
  beds: MergeReportSection;
  species: MergeReportSection;
  crops: MergeReportSection;
  cropPlans: MergeReportSection;
  batches: MergeReportSection;
  tasks: MergeReportSection;
  seedInventoryItems: MergeReportSection;
  conflicts: string[];
  warnings: string[];
};

type EntityType = 'beds' | 'species' | 'crops' | 'cropPlans' | 'batches' | 'seedInventoryItems';

const createEmptyMergeReportSection = (): MergeReportSection => ({ added: 0, updated: 0, unchanged: 0 });

const createEmptyMergeReport = (): MergeReport => ({
  beds: createEmptyMergeReportSection(),
  species: createEmptyMergeReportSection(),
  crops: createEmptyMergeReportSection(),
  cropPlans: createEmptyMergeReportSection(),
  batches: createEmptyMergeReportSection(),
  tasks: createEmptyMergeReportSection(),
  seedInventoryItems: createEmptyMergeReportSection(),
  conflicts: [],
  warnings: [],
});

const ENTITY_ID_KEY: Record<EntityType, string> = {
  beds: 'bedId',
  species: 'id',
  crops: 'cropId',
  cropPlans: 'planId',
  batches: 'batchId',
  seedInventoryItems: 'seedInventoryItemId',
};

const normalizeTimestamp = (value: unknown): number | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const date = Date.parse(value);
  return Number.isNaN(date) ? null : date;
};

const getObjectValue = (record: object, key: string): unknown =>
  (record as Record<string, unknown>)[key];

const compareWithUpdatedAt = (
  entityLabel: string,
  id: string,
  currentRecord: object,
  incomingRecord: object,
  report: MergeReport,
): number => {
  const currentUpdatedAt = normalizeTimestamp(getObjectValue(currentRecord, 'updatedAt'));
  const incomingUpdatedAt = normalizeTimestamp(getObjectValue(incomingRecord, 'updatedAt'));

  if (currentUpdatedAt === null || incomingUpdatedAt === null) {
    report.warnings.push(`${entityLabel}:${id} missing updatedAt; preferred imported value.`);
    return 1;
  }

  if (currentUpdatedAt === incomingUpdatedAt) {
    report.conflicts.push(`${entityLabel}:${id} has identical updatedAt; preferred imported value.`);
  }

  return incomingUpdatedAt >= currentUpdatedAt ? 1 : -1;
};

const mergeCollectionById = <T extends object>(
  entityType: EntityType,
  currentCollection: T[],
  incomingCollection: T[],
  report: MergeReport,
): T[] => {
  const section = report[entityType];
  const idKey = ENTITY_ID_KEY[entityType];
  const mergedById = new Map(currentCollection.map((record) => [String(getObjectValue(record, idKey)), record]));

  for (const incomingRecord of incomingCollection) {
    const id = String(getObjectValue(incomingRecord, idKey));
    const currentRecord = mergedById.get(id);

    if (!currentRecord) {
      mergedById.set(id, incomingRecord);
      section.added += 1;
      continue;
    }

    const preference = compareWithUpdatedAt(entityType, id, currentRecord, incomingRecord, report);
    const nextRecord = preference >= 0 ? incomingRecord : currentRecord;
    const unchanged = JSON.stringify(currentRecord) === JSON.stringify(nextRecord);
    mergedById.set(id, nextRecord);
    section[unchanged ? 'unchanged' : 'updated'] += 1;
  }

  return [...mergedById.values()];
};

const mergeTasksForImport = (currentTasks: AppState['tasks'], incomingTasks: AppState['tasks'], report: MergeReport): AppState['tasks'] => {
  const mergedBySourceKey = new Map(currentTasks.map((task) => [task.sourceKey, task]));

  for (const incomingTask of incomingTasks) {
    const currentTask = mergedBySourceKey.get(incomingTask.sourceKey) ?? null;
    const merged = mergeTaskForImport(currentTask, incomingTask);
    mergedBySourceKey.set(incomingTask.sourceKey, merged.task);
    report.tasks[merged.outcome] += 1;
  }

  return [...mergedBySourceKey.values()];
};


const mergeUnknownCollectionById = (
  currentCollection: unknown[],
  incomingCollection: unknown[],
  idKey: string,
  report: MergeReport,
  entityLabel: string,
): unknown[] => {
  const mergedById = new Map<string, Record<string, unknown>>();

  currentCollection.forEach((record, index) => {
    const entry = asObjectRecord(record);
    const id = asNonEmptyString(entry?.[idKey]) ?? `${entityLabel}-current-${index}`;
    if (entry) {
      mergedById.set(id, entry);
    }
  });

  incomingCollection.forEach((record, index) => {
    const entry = asObjectRecord(record);
    const id = asNonEmptyString(entry?.[idKey]) ?? `${entityLabel}-incoming-${index}`;

    if (!entry) {
      return;
    }

    const currentRecord = mergedById.get(id);
    if (!currentRecord) {
      mergedById.set(id, entry);
      return;
    }

    const preference = compareWithUpdatedAt(entityLabel, id, currentRecord, entry, report);
    mergedById.set(id, preference >= 0 ? entry : currentRecord);
  });

  return [...mergedById.values()];
};

const mergeAppStates = (currentState: AppState, incomingState: AppState): { state: AppState; report: MergeReport } => {
  const report = createEmptyMergeReport();

  const mergedState: AppState = withCultivars({
    ...currentState,
    schemaVersion: incomingState.schemaVersion,
    settings: incomingState.settings,
    beds: [],
    species: mergeCollectionById('species', currentState.species ?? [], incomingState.species ?? [], report),
    crops: mergeCollectionById('crops', currentState.crops, incomingState.crops, report),
    cropPlans: mergeCollectionById('cropPlans', currentState.cropPlans, incomingState.cropPlans, report),
    batches: mergeCollectionById('batches', currentState.batches, incomingState.batches, report),
    tasks: mergeTasksForImport(currentState.tasks, incomingState.tasks, report),
    seedInventoryItems: mergeCollectionById('seedInventoryItems', currentState.seedInventoryItems, incomingState.seedInventoryItems, report),
    segments: incomingState.segments ?? currentState.segments ?? [createDefaultSegment()],
  }, mergeUnknownCollectionById(getCultivarsFromState(currentState), getCultivarsFromState(incomingState), 'cultivarId', report, 'cultivars'));

  return { state: canonicalizeForExport(mergedState), report };
};

const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });

const migrateV1ToV2 = (database: IDBDatabase, transaction: IDBTransaction): void => {
  if (!database.objectStoreNames.contains(META_STORE)) {
    database.createObjectStore(META_STORE);
  }

  const metaStore = transaction.objectStore(META_STORE);
  metaStore.put(2, SCHEMA_VERSION_KEY);
};

const migrateV2ToV3 = (database: IDBDatabase): void => {
  if (!database.objectStoreNames.contains(BED_INDEX_STORE)) {
    database.createObjectStore(BED_INDEX_STORE, { keyPath: 'bedId' });
  }
};

const migrateV3ToV4 = (database: IDBDatabase): void => {
  if (!database.objectStoreNames.contains(CROP_INDEX_STORE)) {
    database.createObjectStore(CROP_INDEX_STORE, { keyPath: 'cropId' });
  }

  if (!database.objectStoreNames.contains(CROP_PLAN_INDEX_STORE)) {
    database.createObjectStore(CROP_PLAN_INDEX_STORE, { keyPath: 'planId' });
  }
};

const migrateV4ToV5 = (database: IDBDatabase): void => {
  if (!database.objectStoreNames.contains(BATCH_INDEX_STORE)) {
    database.createObjectStore(BATCH_INDEX_STORE, { keyPath: 'batchId' });
  }
};

const migrateV5ToV6 = (database: IDBDatabase): void => {
  if (!database.objectStoreNames.contains(PHOTO_BLOB_STORE)) {
    database.createObjectStore(PHOTO_BLOB_STORE);
  }
};

const isQuotaExceededError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const domExceptionLike = error as { name?: string; message?: string; code?: number };
  return (
    domExceptionLike.name === 'QuotaExceededError' ||
    domExceptionLike.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    domExceptionLike.code === 22 ||
    domExceptionLike.code === 1014 ||
    (typeof domExceptionLike.message === 'string' && domExceptionLike.message.toLowerCase().includes('quota'))
  );
};

const toStorageWriteError = (error: unknown, fallbackMessage: string): AppStateStorageError => {
  if (isQuotaExceededError(error)) {
    return new AppStateStorageError('Local storage quota exceeded while saving data. Free up browser storage and try again.');
  }

  const message = error instanceof Error && error.message ? `${fallbackMessage}: ${error.message}` : fallbackMessage;
  return new AppStateStorageError(message);
};

const openAppStateDatabase = async (): Promise<IDBDatabase> => {
  if (typeof indexedDB === 'undefined') {
    throw new AppStateStorageError('IndexedDB is not available in this environment.');
  }

  return new Promise((resolve, reject) => {
    const openRequest = indexedDB.open(APP_STATE_DB_NAME, APP_STATE_DB_VERSION);

    openRequest.onupgradeneeded = (event) => {
      const database = openRequest.result;
      const { transaction } = openRequest;

      if (!transaction) {
        throw new AppStateStorageError('IndexedDB migration transaction was not created.');
      }

      if (!database.objectStoreNames.contains(APP_STATE_STORE)) {
        database.createObjectStore(APP_STATE_STORE);
      }

      if (event.oldVersion < 2) {
        migrateV1ToV2(database, transaction);
      }

      if (event.oldVersion < 3) {
        migrateV2ToV3(database);
      }

      if (event.oldVersion < 4) {
        migrateV3ToV4(database);
      }

      if (event.oldVersion < 5) {
        migrateV4ToV5(database);
      }

      if (event.oldVersion < 6) {
        migrateV5ToV6(database);
      }
    };

    openRequest.onblocked = () => {
      reject(new AppStateStorageError('Local data storage upgrade is blocked by another browser tab.'));
    };

    openRequest.onerror = () => {
      reject(new AppStateStorageError(`Failed to open local data storage${openRequest.error ? `: ${openRequest.error.message}` : ''}.`));
    };

    openRequest.onsuccess = () => {
      const database = openRequest.result;
      database.onversionchange = () => {
        database.close();
      };
      resolve(database);
    };
  });
};

export const initializeAppStateStorage = async (): Promise<void> => {
  const database = await openAppStateDatabase();

  try {
    const transaction = database.transaction([META_STORE], 'readwrite');
    transaction.objectStore(META_STORE).put(APP_STATE_DB_VERSION, SCHEMA_VERSION_KEY);
    await transactionDone(transaction);
  } finally {
    database.close();
  }

  await seedAppStateIfEmpty();
};

const seedAppStateIfEmpty = async (): Promise<void> => {
  const currentState = await loadAppStateFromIndexedDb();

  if (currentState) {
    return;
  }

  await saveAppStateToIndexedDb(GOLDEN_DATASET);
};

export const createEmptyAppState = (currentState: AppState | null): AppState => ({
  schemaVersion: currentState?.schemaVersion ?? 1,
  segments: [createDefaultSegment()],
  beds: [],
  species: [],
  crops: [],
  cropPlans: [],
  batches: [],
  tasks: [],
  seedInventoryItems: [],
  settings: currentState?.settings ?? getSettingsOrDefault(undefined),
});

export const resetToGoldenDataset = async (): Promise<void> => {
  if (typeof indexedDB === 'undefined') {
    throw new AppStateStorageError('IndexedDB is not available in this environment.');
  }

  await new Promise<void>((resolve, reject) => {
    const deleteRequest = indexedDB.deleteDatabase(APP_STATE_DB_NAME);

    deleteRequest.onsuccess = () => resolve();
    deleteRequest.onerror = () => reject(new AppStateStorageError('Failed to reset local data storage.'));
    deleteRequest.onblocked = () =>
      reject(new AppStateStorageError('Close other SurvivalGarden tabs and try reset again.'));
  });

  await initializeAppStateStorage();
};

export const loadAppStateFromIndexedDb = async (): Promise<AppState | null> => {
  const database = await openAppStateDatabase();

  try {
    const transaction = database.transaction([APP_STATE_STORE], 'readonly');
    const rawValue = await requestToPromise(transaction.objectStore(APP_STATE_STORE).get(APP_STATE_RECORD_KEY));
    await transactionDone(transaction);

    if (rawValue === undefined) {
      return null;
    }

    const migrationResult = migrateLegacyLayoutModel(migrateLegacyBedTypes(rawValue));

    if (migrationResult.report.warnings.length > 0) {
      console.warn('AppState load migration warnings', migrationResult.report.warnings);
    }

    return canonicalizeForExport(assertValid('appState', migrationResult.payload));
  } catch (error) {
    throw new AppStateStorageError(
      `Failed to load app state from local data storage: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    database.close();
  }
};

export const saveAppStateToIndexedDb = async (
  appState: unknown,
  options: SaveAppStateOptions = {},
): Promise<MergeReport | null> => {
  const database = await openAppStateDatabase();

  try {
    const candidateState =
      appState && typeof appState === 'object'
        ? {
            ...(appState as Record<string, unknown>),
            settings: getSettingsOrDefault((appState as { settings?: unknown }).settings),
          }
        : appState;
    const validState = assertValid('appState', candidateState);
    const isReplaceMode = options.mode === 'replace';
    let report: MergeReport | null = null;

    const transaction = database.transaction(
      isReplaceMode
        ? [APP_STATE_STORE, META_STORE, BED_INDEX_STORE, CROP_INDEX_STORE, CROP_PLAN_INDEX_STORE, BATCH_INDEX_STORE, PHOTO_BLOB_STORE]
        : [APP_STATE_STORE, META_STORE, BED_INDEX_STORE, CROP_INDEX_STORE, CROP_PLAN_INDEX_STORE, BATCH_INDEX_STORE],
      'readwrite',
    );

    let stateToPersist = canonicalizeForExport(validState);

    if (!isReplaceMode) {
      const existingRaw = await requestToPromise(transaction.objectStore(APP_STATE_STORE).get(APP_STATE_RECORD_KEY));

      if (existingRaw !== undefined) {
        const existingState = assertValid('appState', existingRaw);
        const merged = mergeAppStates(existingState, stateToPersist);
        stateToPersist = canonicalizeForExport(assertValid('appState', merged.state));
        report = merged.report;
        const hierarchyValidation = validateHierarchyForImport(stateToPersist);
        report.warnings.push(...hierarchyValidation.warnings);
        report.warnings.push(...hierarchyValidation.errors.map((entry) => `hierarchy-error: ${entry}`));
      }
    }

    transaction.objectStore(APP_STATE_STORE).put(stateToPersist, APP_STATE_RECORD_KEY);
    transaction.objectStore(META_STORE).put(stateToPersist.schemaVersion, SCHEMA_VERSION_KEY);

    const bedStore = transaction.objectStore(BED_INDEX_STORE);
    const existingBedKeys = await requestToPromise(bedStore.getAllKeys());

    for (const key of existingBedKeys) {
      bedStore.delete(key);
    }

    for (const segment of stateToPersist.segments ?? []) {
      for (const bed of segment.beds ?? []) {
        const normalizedBed = { ...(bed as unknown as Record<string, unknown>) };
        delete normalizedBed.x;
        delete normalizedBed.y;
        delete normalizedBed.width;
        delete normalizedBed.height;
        bedStore.put(assertValid('bed', normalizedBed));
      }
    }

    const cropStore = transaction.objectStore(CROP_INDEX_STORE);
    const existingCropKeys = await requestToPromise(cropStore.getAllKeys());

    for (const key of existingCropKeys) {
      cropStore.delete(key);
    }

    for (const crop of stateToPersist.crops) {
      cropStore.put(assertValid('crop', crop ?? {}));
    }

    const cropPlanStore = transaction.objectStore(CROP_PLAN_INDEX_STORE);
    const existingCropPlanKeys = await requestToPromise(cropPlanStore.getAllKeys());

    for (const key of existingCropPlanKeys) {
      cropPlanStore.delete(key);
    }

    for (const cropPlan of stateToPersist.cropPlans) {
      cropPlanStore.put(assertValid('cropPlan', cropPlan ?? {}));
    }

    const batchStore = transaction.objectStore(BATCH_INDEX_STORE);
    const existingBatchKeys = await requestToPromise(batchStore.getAllKeys());

    for (const key of existingBatchKeys) {
      batchStore.delete(key);
    }

    for (const batch of stateToPersist.batches) {
      batchStore.put(assertValid('batch', batch ?? {}));
    }

    if (isReplaceMode) {
      transaction.objectStore(PHOTO_BLOB_STORE).clear();
    }

    await transactionDone(transaction);
    return report;
  } catch (error) {
    throw toStorageWriteError(error, 'Failed to save app state to local data storage');
  } finally {
    database.close();
  }
};

export const savePhotoBlobToIndexedDb = async (photoId: string, blob: Blob): Promise<void> => {
  const database = await openAppStateDatabase();

  try {
    const transaction = database.transaction([PHOTO_BLOB_STORE], 'readwrite');
    transaction.objectStore(PHOTO_BLOB_STORE).put(blob, photoId);
    await transactionDone(transaction);
  } catch (error) {
    throw toStorageWriteError(error, `Failed to save photo blob '${photoId}'`);
  } finally {
    database.close();
  }
};

export const loadPhotoBlobFromIndexedDb = async (photoId: string): Promise<Blob | null> => {
  const database = await openAppStateDatabase();

  try {
    const transaction = database.transaction([PHOTO_BLOB_STORE], 'readonly');
    const stored = await requestToPromise(transaction.objectStore(PHOTO_BLOB_STORE).get(photoId));
    await transactionDone(transaction);
    return stored instanceof Blob ? stored : null;
  } finally {
    database.close();
  }
};

export const deletePhotoBlobFromIndexedDb = async (photoId: string): Promise<void> => {
  const database = await openAppStateDatabase();

  try {
    const transaction = database.transaction([PHOTO_BLOB_STORE], 'readwrite');
    transaction.objectStore(PHOTO_BLOB_STORE).delete(photoId);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
};
