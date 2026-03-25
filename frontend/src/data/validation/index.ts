import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject, ValidateFunction } from 'ajv';
import {
  appStateSchema,
  batchSchema,
  bedSchema,
  cropPlanSchema,
  cultivarSchema,
  cropSchema,
  pathSchema,
  seedInventoryItemSchema,
  segmentSchema,
  settingsSchema,
  speciesSchema,
  taskSchema,
} from '../../contracts';
import type {
  AppState,
  Batch,
  Bed,
  Crop,
  CropPlan,
  Path,
  SeedInventoryItem,
  Segment,
  Settings,
  Species,
  Task,
} from '../../contracts';

export type SchemaName =
  | 'appState'
  | 'batch'
  | 'bed'
  | 'crop'
  | 'cropPlan'
  | 'path'
  | 'seedInventoryItem'
  | 'segment'
  | 'settings'
  | 'species'
  | 'task';

export type SchemaTypeMap = {
  appState: AppState;
  batch: Batch;
  bed: Bed;
  crop: Crop;
  cropPlan: CropPlan;
  path: Path;
  seedInventoryItem: SeedInventoryItem;
  segment: Segment;
  settings: Settings;
  species: Species;
  task: Task;
};

export type ValidationIssue = {
  schemaName: SchemaName;
  path: string;
  message: string;
  keyword: string;
};

export type ValidationResult<T extends SchemaName> =
  | { ok: true; value: SchemaTypeMap[T] }
  | { ok: false; issues: ValidationIssue[] };

export class SchemaValidationError extends Error {
  readonly schemaName: SchemaName;
  readonly issues: ValidationIssue[];

  constructor(schemaName: SchemaName, issues: ValidationIssue[]) {
    super(`Validation failed for ${schemaName}`);
    this.name = 'SchemaValidationError';
    this.schemaName = schemaName;
    this.issues = issues;
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true });

ajv.addSchema(appStateSchema);
ajv.addSchema(batchSchema);
ajv.addSchema(bedSchema);
ajv.addSchema(cropSchema);
ajv.addSchema(cultivarSchema);
ajv.addSchema(cropPlanSchema);
ajv.addSchema(pathSchema);
ajv.addSchema(taskSchema);
ajv.addSchema(seedInventoryItemSchema);
ajv.addSchema(segmentSchema);
ajv.addSchema(settingsSchema);
ajv.addSchema(speciesSchema);


const EPSILON = 1e-9;

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const toFiniteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const getWidthMeters = (value: Record<string, unknown>): number | null =>
  toFiniteNumber(value.widthM) ?? toFiniteNumber(value.width);

const getLengthMeters = (value: Record<string, unknown>): number | null =>
  toFiniteNumber(value.lengthM) ?? toFiniteNumber(value.height);

const MAX_EXPANDED_FORMULA_POINTS = 5000;

const UNKNOWN_VARIETY_KEY = 'unknown_variety';

const normalizeKey = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/^crop_/, '')
    .replace(/^species_/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');

const addKeyVariants = (keys: Set<string>, raw: unknown): void => {
  const value = asString(raw);
  if (!value) {
    return;
  }

  const normalized = normalizeKey(value);
  if (!normalized) {
    return;
  }

  const variants = new Set<string>([normalized]);
  normalized.split('_').forEach((part) => {
    if (!part) {
      return;
    }

    variants.add(part);
    if (part.endsWith('s') && part.length > 1) {
      variants.add(part.slice(0, -1));
    } else {
      variants.add(`${part}s`);
    }
  });

  variants.forEach((variant) => {
    if (variant) {
      keys.add(variant);
    }
  });
};

const isUnknownVarietyValue = (value: unknown): boolean => {
  const normalized = normalizeKey(asString(value) ?? '');
  if (!normalized) {
    return false;
  }

  return normalized === 'unknown'
    || normalized === UNKNOWN_VARIETY_KEY
    || normalized.startsWith('unknown_');
};

type CropReferenceCandidate = {
  cropId: string;
  cultivarKeys: Set<string>;
  speciesKeys: Set<string>;
  placeholder: boolean;
};

const buildCropReferenceCandidates = (payload: Record<string, unknown>): CropReferenceCandidate[] => {
  const crops = Array.isArray(payload.crops) ? payload.crops : [];

  return crops.flatMap((crop) => {
    if (!isObjectRecord(crop) || typeof crop.cropId !== 'string' || crop.cropId.length === 0) {
      return [];
    }

    const species = (isObjectRecord(crop.species) ? crop.species : {}) as Record<string, unknown>;
    const speciesKeys = new Set<string>();
    addKeyVariants(speciesKeys, crop.cropId);
    addKeyVariants(speciesKeys, crop.name);
    addKeyVariants(speciesKeys, crop.speciesId);
    addKeyVariants(speciesKeys, crop.scientificName);
    addKeyVariants(speciesKeys, species.id);
    addKeyVariants(speciesKeys, species.commonName);
    addKeyVariants(speciesKeys, species.scientificName);

    const cultivarKeys = new Set<string>();
    addKeyVariants(cultivarKeys, crop.cultivar);
    addKeyVariants(cultivarKeys, crop.name);

    return [{
      cropId: crop.cropId,
      cultivarKeys,
      speciesKeys,
      placeholder:
        isUnknownVarietyValue(crop.cultivar)
        || normalizeKey(crop.cropId).endsWith(UNKNOWN_VARIETY_KEY)
        || normalizeKey(asString(crop.name) ?? '') === UNKNOWN_VARIETY_KEY,
    }];
  });
};

const resolveMigratedCropId = (
  record: Record<string, unknown>,
  cropsById: Map<string, CropReferenceCandidate>,
  cropCandidates: CropReferenceCandidate[],
): string | undefined => {
  const currentCropId = asString(record.cropId);
  const preferredVariety = asString(record.variety);

  const existing = currentCropId ? cropsById.get(currentCropId) : undefined;
  const currentMatchesPreferred =
    existing
      ? (preferredVariety && !isUnknownVarietyValue(preferredVariety)
          ? existing.cultivarKeys.has(normalizeKey(preferredVariety))
          : !preferredVariety || isUnknownVarietyValue(preferredVariety)
            ? existing.placeholder
            : false)
      : false;

  if (existing && (!preferredVariety || currentMatchesPreferred)) {
    return currentCropId;
  }

  const sourceKeys = new Set<string>();
  addKeyVariants(sourceKeys, currentCropId);
  addKeyVariants(sourceKeys, record.speciesId);
  addKeyVariants(sourceKeys, record.scientificName);
  if (isObjectRecord(record.species)) {
    const species = record.species;
    addKeyVariants(sourceKeys, species.id);
    addKeyVariants(sourceKeys, species.commonName);
    addKeyVariants(sourceKeys, species.scientificName);
  }

  const matchingCandidates = cropCandidates.filter((candidate) =>
    [...sourceKeys].some((key) => candidate.speciesKeys.has(key)),
  );

  if (matchingCandidates.length === 0) {
    return currentCropId;
  }

  if (preferredVariety && !isUnknownVarietyValue(preferredVariety)) {
    const preferredKey = normalizeKey(preferredVariety);
    const cultivarMatch = matchingCandidates.find((candidate) => candidate.cultivarKeys.has(preferredKey));
    if (cultivarMatch) {
      return cultivarMatch.cropId;
    }
  }

  const placeholderMatch = matchingCandidates.find((candidate) => candidate.placeholder);
  if (placeholderMatch) {
    return placeholderMatch.cropId;
  }

  return matchingCandidates[0]?.cropId ?? currentCropId;
};

const stripLegacyTaxonomyFields = (record: Record<string, unknown>): Record<string, unknown> => {
  const nextRecord = { ...record };
  delete nextRecord.scientificName;
  delete nextRecord.speciesId;
  delete nextRecord.species;
  return nextRecord;
};

const remapLegacyCropReferences = (payload: unknown): unknown => {
  if (!isObjectRecord(payload)) {
    return payload;
  }

  const cropCandidates = buildCropReferenceCandidates(payload);
  if (cropCandidates.length === 0) {
    return payload;
  }

  const cropsById = new Map(cropCandidates.map((candidate) => [candidate.cropId, candidate]));

  const remapCollection = (items: unknown, options?: { stripTaxonomy?: boolean }): unknown =>
    Array.isArray(items)
      ? items.map((item) => {
          if (!isObjectRecord(item)) {
            return item;
          }

          const remappedCropId = resolveMigratedCropId(item, cropsById, cropCandidates);
          const nextItem = {
            ...(options?.stripTaxonomy ? stripLegacyTaxonomyFields(item) : item),
            ...(remappedCropId ? { cropId: remappedCropId } : {}),
          };

          return nextItem;
        })
      : items;

  return {
    ...payload,
    cropPlans: remapCollection(payload.cropPlans, { stripTaxonomy: true }),
    batches: remapCollection(payload.batches, { stripTaxonomy: true }),
  };
};

type PlacementPoint = { x: number; y: number };

const roundCoordinate = (value: number): number => Number(value.toFixed(9));

const expandPlacementPoints = (placement: Record<string, unknown>): PlacementPoint[] => {
  if (placement.type === 'points' && Array.isArray(placement.points)) {
    return placement.points
      .map((point) => {
        if (!isObjectRecord(point)) {
          return null;
        }

        const x = toFiniteNumber(point.x);
        const y = toFiniteNumber(point.y);

        if (x === null || y === null) {
          return null;
        }

        return { x, y };
      })
      .filter((point): point is PlacementPoint => point !== null);
  }

  if (placement.type !== 'formula' || !isObjectRecord(placement.formula) || typeof placement.formula.kind !== 'string') {
    return [];
  }

  const formula = placement.formula;
  const points: PlacementPoint[] = [];
  const pushPoint = (x: number, y: number) => {
    points.push({ x: roundCoordinate(x), y: roundCoordinate(y) });
  };

  if (formula.kind === 'grid' || formula.kind === 'staggered_grid') {
    if (!isObjectRecord(formula.origin)) {
      return [];
    }

    const originX = toFiniteNumber(formula.origin.x);
    const originY = toFiniteNumber(formula.origin.y);
    const dx = toFiniteNumber(formula.dx);
    const dy = toFiniteNumber(formula.dy);
    const rows = toFiniteNumber(formula.rows);
    const cols = toFiniteNumber(formula.cols);
    const staggerX = formula.kind === 'staggered_grid' ? toFiniteNumber(formula.staggerX) : 0;

    if (originX === null || originY === null || dx === null || dy === null || rows === null || cols === null) {
      return [];
    }

    for (let row = 0; row < rows; row += 1) {
      const rowOffsetX = formula.kind === 'staggered_grid' && staggerX !== null && row % 2 === 1 ? staggerX : 0;
      for (let col = 0; col < cols; col += 1) {
        pushPoint(originX + rowOffsetX + col * dx, originY + row * dy);
      }
    }
  }

  if (formula.kind === 'row') {
    if (!isObjectRecord(formula.origin)) {
      return [];
    }

    const originX = toFiniteNumber(formula.origin.x);
    const originY = toFiniteNumber(formula.origin.y);
    const dx = toFiniteNumber(formula.dx);
    const count = toFiniteNumber(formula.count);

    if (originX === null || originY === null || dx === null || count === null) {
      return [];
    }

    for (let index = 0; index < count; index += 1) {
      pushPoint(originX + index * dx, originY);
    }
  }

  if (formula.kind === 'line') {
    if (!isObjectRecord(formula.start) || !isObjectRecord(formula.end)) {
      return [];
    }

    const startX = toFiniteNumber(formula.start.x);
    const startY = toFiniteNumber(formula.start.y);
    const endX = toFiniteNumber(formula.end.x);
    const endY = toFiniteNumber(formula.end.y);
    const count = toFiniteNumber(formula.count);

    if (startX === null || startY === null || endX === null || endY === null || count === null || count < 2) {
      return [];
    }

    const stepX = (endX - startX) / (count - 1);
    const stepY = (endY - startY) / (count - 1);

    for (let index = 0; index < count; index += 1) {
      pushPoint(startX + index * stepX, startY + index * stepY);
    }
  }

  if (formula.kind === 'repeated_offset') {
    if (!isObjectRecord(formula.origin)) {
      return [];
    }

    const originX = toFiniteNumber(formula.origin.x);
    const originY = toFiniteNumber(formula.origin.y);
    const dx = toFiniteNumber(formula.dx);
    const dy = toFiniteNumber(formula.dy);
    const count = toFiniteNumber(formula.count);

    if (originX === null || originY === null || dx === null || dy === null || count === null) {
      return [];
    }

    for (let index = 0; index < count; index += 1) {
      pushPoint(originX + index * dx, originY + index * dy);
    }
  }

  return points;
};

const collectSegmentGeometryIssues = (schemaName: SchemaName, payload: unknown): ValidationIssue[] => {
  const segments =
    schemaName === 'segment'
      ? [payload]
      : schemaName === 'appState' && isObjectRecord(payload) && Array.isArray(payload.segments)
        ? payload.segments
        : [];

  const issues: ValidationIssue[] = [];

  segments.forEach((segment, segmentIndex) => {
    if (!isObjectRecord(segment)) {
      return;
    }

    const segmentPath = schemaName === 'segment' ? '' : `/segments/${segmentIndex}`;
    const segmentWidth = getWidthMeters(segment);
    const segmentHeight = getLengthMeters(segment);

    const appendBoundsIssue = (
      itemType: 'beds' | 'paths',
      itemIndex: number,
      axis: 'x' | 'y',
      position: number,
      size: number,
      segmentSize: number,
      keyword: 'maximum' | 'minimum',
      message: string,
    ) => {
      issues.push({
        schemaName,
        path: `${segmentPath}/${itemType}/${itemIndex}/${axis}`,
        keyword,
        message: `${message} (got ${position} + ${size} > segment ${axis === 'x' ? 'width' : 'height'} ${segmentSize})`,
      });
    };

    const checkCollection = (collectionKey: 'beds' | 'paths') => {
      if (!Array.isArray(segment[collectionKey])) {
        return;
      }

      segment[collectionKey].forEach((item, itemIndex) => {
        if (!isObjectRecord(item)) {
          return;
        }

        const x = toFiniteNumber(item.x);
        const y = toFiniteNumber(item.y);
        const width = getWidthMeters(item);
        const height = getLengthMeters(item);

        if (x !== null && width !== null && segmentWidth !== null && x + width - segmentWidth > EPSILON) {
          appendBoundsIssue(
            collectionKey,
            itemIndex,
            'x',
            x,
            width,
            segmentWidth,
            'maximum',
            `${collectionKey === 'beds' ? 'bed' : 'path'} extends past segment east boundary`,
          );
        }

        if (y !== null && height !== null && segmentHeight !== null && y + height - segmentHeight > EPSILON) {
          appendBoundsIssue(
            collectionKey,
            itemIndex,
            'y',
            y,
            height,
            segmentHeight,
            'maximum',
            `${collectionKey === 'beds' ? 'bed' : 'path'} extends past segment south boundary`,
          );
        }
      });
    };

    checkCollection('beds');
    checkCollection('paths');
  });

  return issues;
};

const collectLayoutParentIssues = (schemaName: SchemaName, payload: unknown): ValidationIssue[] => {
  const segments =
    schemaName === 'segment'
      ? [payload]
      : schemaName === 'appState' && isObjectRecord(payload) && Array.isArray(payload.segments)
        ? payload.segments
        : [];

  const issues: ValidationIssue[] = [];
  const knownSegmentIds = new Set<string>();

  segments.forEach((segment) => {
    if (isObjectRecord(segment) && typeof segment.segmentId === 'string' && segment.segmentId.length > 0) {
      knownSegmentIds.add(segment.segmentId);
    }
  });

  segments.forEach((segment, segmentIndex) => {
    if (!isObjectRecord(segment) || typeof segment.segmentId !== 'string') {
      return;
    }

    const segmentPath = schemaName === 'segment' ? '' : `/segments/${segmentIndex}`;

    const checkCollection = (collectionKey: 'beds' | 'paths', idKey: 'bedId' | 'pathId') => {
      if (!Array.isArray(segment[collectionKey])) {
        return;
      }

      segment[collectionKey].forEach((item, itemIndex) => {
        if (!isObjectRecord(item)) {
          return;
        }

        const itemPath = `${segmentPath}/${collectionKey}/${itemIndex}`;
        const itemId = typeof item[idKey] === 'string' ? item[idKey] : `${collectionKey.slice(0, -1)}#${itemIndex}`;

        if (typeof item.segmentId !== 'string' || item.segmentId.length === 0) {
          return;
        }

        if (!knownSegmentIds.has(item.segmentId)) {
          issues.push({
            schemaName,
            path: `${itemPath}/segmentId`,
            keyword: 'invalidReference',
            message: `${collectionKey === 'beds' ? 'bed' : 'path'} '${itemId}' references unknown segmentId '${item.segmentId}'`,
          });
        }

        if (item.segmentId !== segment.segmentId) {
          issues.push({
            schemaName,
            path: `${itemPath}/segmentId`,
            keyword: 'invalidReference',
            message: `${collectionKey === 'beds' ? 'bed' : 'path'} '${itemId}' must belong to parent segment '${segment.segmentId}'`,
          });
        }
      });
    };

    checkCollection('beds', 'bedId');
    checkCollection('paths', 'pathId');
  });

  return issues;
};

const collectPathPlacementIssues = (schemaName: SchemaName, payload: unknown): ValidationIssue[] => {
  if (schemaName !== 'appState' || !isObjectRecord(payload)) {
    return [];
  }

  const segments = Array.isArray(payload.segments) ? payload.segments : [];
  const pathIds = new Set<string>();

  segments.forEach((segment) => {
    if (!isObjectRecord(segment) || !Array.isArray(segment.paths)) {
      return;
    }

    segment.paths.forEach((path) => {
      if (isObjectRecord(path) && typeof path.pathId === 'string' && path.pathId.length > 0) {
        pathIds.add(path.pathId);
      }
    });
  });

  if (pathIds.size === 0) {
    return [];
  }

  const issues: ValidationIssue[] = [];

  const addPlacementIssue = (path: string, pathId: string) => {
    issues.push({
      schemaName,
      path,
      keyword: 'invalidReference',
      message: `crop placement cannot target path entity '${pathId}'`,
    });
  };

  const cropPlans = Array.isArray(payload.cropPlans) ? payload.cropPlans : [];
  cropPlans.forEach((plan, planIndex) => {
    if (!isObjectRecord(plan) || typeof plan.bedId !== 'string') {
      return;
    }

    if (pathIds.has(plan.bedId)) {
      addPlacementIssue(`/cropPlans/${planIndex}/bedId`, plan.bedId);
    }
  });

  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  tasks.forEach((task, taskIndex) => {
    if (!isObjectRecord(task) || typeof task.bedId !== 'string') {
      return;
    }

    if (pathIds.has(task.bedId)) {
      addPlacementIssue(`/tasks/${taskIndex}/bedId`, task.bedId);
    }
  });

  const batches = Array.isArray(payload.batches) ? payload.batches : [];
  batches.forEach((batch, batchIndex) => {
    if (!isObjectRecord(batch)) {
      return;
    }

    const checkAssignments = (assignmentKey: 'assignments' | 'bedAssignments') => {
      if (!Array.isArray(batch[assignmentKey])) {
        return;
      }

      batch[assignmentKey].forEach((assignment, assignmentIndex) => {
        if (!isObjectRecord(assignment) || typeof assignment.bedId !== 'string') {
          return;
        }

        if (pathIds.has(assignment.bedId)) {
          addPlacementIssue(`/batches/${batchIndex}/${assignmentKey}/${assignmentIndex}/bedId`, assignment.bedId);
        }
      });
    };

    checkAssignments('assignments');
    checkAssignments('bedAssignments');
  });

  return issues;
};

const collectCropPlanReferenceIssues = (schemaName: SchemaName, payload: unknown): ValidationIssue[] => {
  if (schemaName !== 'appState' || !isObjectRecord(payload)) {
    return [];
  }

  const segments = Array.isArray(payload.segments) ? payload.segments : [];
  const cropPlans = Array.isArray(payload.cropPlans) ? payload.cropPlans : [];

  const bedBySegment = new Map<string, Set<string>>();
  const bedDimensions = new Map<string, { width: number; height: number }>();

  segments.forEach((segment) => {
    if (!isObjectRecord(segment) || typeof segment.segmentId !== 'string' || !Array.isArray(segment.beds)) {
      return;
    }

    const segmentBeds = new Set<string>();
    segment.beds.forEach((bed) => {
      if (!isObjectRecord(bed) || typeof bed.bedId !== 'string') {
        return;
      }

      segmentBeds.add(bed.bedId);

      const width = getWidthMeters(bed);
      const height = getLengthMeters(bed);
      if (width !== null && height !== null) {
        bedDimensions.set(`${segment.segmentId}:${bed.bedId}`, { width, height });
      }
    });

    bedBySegment.set(segment.segmentId, segmentBeds);
  });

  const issues: ValidationIssue[] = [];

  cropPlans.forEach((plan, planIndex) => {
    if (!isObjectRecord(plan)) {
      return;
    }

    if (typeof plan.segmentId === 'string' && typeof plan.bedId === 'string') {
      const bedsInSegment = bedBySegment.get(plan.segmentId);
      if (!bedsInSegment) {
        issues.push({
          schemaName,
          path: `/cropPlans/${planIndex}/segmentId`,
          keyword: 'invalidReference',
          message: `cropPlan references unknown segmentId '${plan.segmentId}'`,
        });
      } else if (!bedsInSegment.has(plan.bedId)) {
        issues.push({
          schemaName,
          path: `/cropPlans/${planIndex}/bedId`,
          keyword: 'invalidReference',
          message: `cropPlan bedId '${plan.bedId}' does not belong to segmentId '${plan.segmentId}'`,
        });
      }

      if (Array.isArray(plan.placements)) {
        const bedSize = bedDimensions.get(`${plan.segmentId}:${plan.bedId}`);

        plan.placements.forEach((placement, placementIndex) => {
          if (!isObjectRecord(placement)) {
            return;
          }

          const expandedPoints = expandPlacementPoints(placement);

          if (placement.type === 'formula' && expandedPoints.length > MAX_EXPANDED_FORMULA_POINTS) {
            issues.push({
              schemaName,
              path: `/cropPlans/${planIndex}/placements/${placementIndex}/formula`,
              keyword: 'maxItems',
              message: `placement formula expands to ${expandedPoints.length} points (max ${MAX_EXPANDED_FORMULA_POINTS})`,
            });
            return;
          }

          expandedPoints.forEach((point, pointIndex) => {
            if (!isObjectRecord(point)) {
              return;
            }

            const x = toFiniteNumber(point.x);
            const y = toFiniteNumber(point.y);

            if (x !== null && x < -EPSILON) {
              issues.push({
                schemaName,
                path: `/cropPlans/${planIndex}/placements/${placementIndex}/points/${pointIndex}/x`,
                keyword: 'minimum',
                message: `placement x must be >= 0 meters`,
              });
            }

            if (y !== null && y < -EPSILON) {
              issues.push({
                schemaName,
                path: `/cropPlans/${planIndex}/placements/${placementIndex}/points/${pointIndex}/y`,
                keyword: 'minimum',
                message: `placement y must be >= 0 meters`,
              });
            }

            if (bedSize && x !== null && x - bedSize.width > EPSILON) {
              issues.push({
                schemaName,
                path: `/cropPlans/${planIndex}/placements/${placementIndex}/points/${pointIndex}/x`,
                keyword: 'maximum',
                message: `placement x exceeds bed width ${bedSize.width}m`,
              });
            }

            if (bedSize && y !== null && y - bedSize.height > EPSILON) {
              issues.push({
                schemaName,
                path: `/cropPlans/${planIndex}/placements/${placementIndex}/points/${pointIndex}/y`,
                keyword: 'maximum',
                message: `placement y exceeds bed height ${bedSize.height}m`,
              });
            }
          });
        });
      }
    }
  });

  return issues;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const collectAppStateReferenceIssues = (schemaName: SchemaName, payload: unknown): ValidationIssue[] => {
  if (schemaName !== 'appState' || !isObjectRecord(payload)) {
    return [];
  }

  const crops = Array.isArray(payload.crops) ? payload.crops : [];
  const batches = Array.isArray(payload.batches) ? payload.batches : [];
  const cropPlans = Array.isArray(payload.cropPlans) ? payload.cropPlans : [];
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  const seedInventoryItems = Array.isArray(payload.seedInventoryItems) ? payload.seedInventoryItems : [];
  const segments = Array.isArray(payload.segments) ? payload.segments : [];

  const cropIds = new Set<string>();
  crops.forEach((crop) => {
    if (isObjectRecord(crop) && typeof crop.cropId === 'string' && crop.cropId.length > 0) {
      cropIds.add(crop.cropId);
    }
  });

  const bedIds = new Set<string>();
  segments.forEach((segment) => {
    if (!isObjectRecord(segment) || !Array.isArray(segment.beds)) {
      return;
    }

    segment.beds.forEach((bed) => {
      if (isObjectRecord(bed) && typeof bed.bedId === 'string' && bed.bedId.length > 0) {
        bedIds.add(bed.bedId);
      }
    });
  });
  const issues: ValidationIssue[] = [];

  const pushInvalidRef = (path: string, message: string) => {
    issues.push({
      schemaName,
      path,
      keyword: 'invalidReference',
      message,
    });
  };

  cropPlans.forEach((cropPlan, cropPlanIndex) => {
    if (!isObjectRecord(cropPlan)) {
      return;
    }

    if (typeof cropPlan.cropId === 'string' && !cropIds.has(cropPlan.cropId)) {
      pushInvalidRef(`/cropPlans/${cropPlanIndex}/cropId`, `cropPlan references unknown cropId '${cropPlan.cropId}'`);
    }

    if (typeof cropPlan.bedId === 'string' && !bedIds.has(cropPlan.bedId)) {
      pushInvalidRef(`/cropPlans/${cropPlanIndex}/bedId`, `cropPlan references unknown bedId '${cropPlan.bedId}'`);
    }
  });

  batches.forEach((batch, batchIndex) => {
    if (!isObjectRecord(batch)) {
      return;
    }

    const batchCultivarId = typeof batch.cultivarId === 'string' ? batch.cultivarId : typeof batch.cropId === 'string' ? batch.cropId : null;
    if (batchCultivarId && !cropIds.has(batchCultivarId)) {
      pushInvalidRef(`/batches/${batchIndex}/cultivarId`, `batch references unknown cultivarId '${batchCultivarId}'`);
    }

    const checkAssignments = (assignmentKey: 'assignments' | 'bedAssignments') => {
      if (!Array.isArray(batch[assignmentKey])) {
        return;
      }

      batch[assignmentKey].forEach((assignment, assignmentIndex) => {
        if (!isObjectRecord(assignment) || typeof assignment.bedId !== 'string') {
          return;
        }

        if (!bedIds.has(assignment.bedId)) {
          pushInvalidRef(
            `/batches/${batchIndex}/${assignmentKey}/${assignmentIndex}/bedId`,
            `batch assignment references unknown bedId '${assignment.bedId}'`,
          );
        }
      });
    };

    checkAssignments('assignments');
    checkAssignments('bedAssignments');
  });

  tasks.forEach((task, taskIndex) => {
    if (!isObjectRecord(task)) {
      return;
    }

    if (typeof task.cropId === 'string' && !cropIds.has(task.cropId)) {
      pushInvalidRef(`/tasks/${taskIndex}/cropId`, `task references unknown cropId '${task.cropId}'`);
    }

    if (typeof task.bedId === 'string' && !bedIds.has(task.bedId)) {
      pushInvalidRef(`/tasks/${taskIndex}/bedId`, `task references unknown bedId '${task.bedId}'`);
    }
  });

  const cultivars = Array.isArray(payload.cultivars) ? payload.cultivars : [];
  const cultivarIds = new Set(
    cultivars
      .filter((entry): entry is Record<string, unknown> => isObjectRecord(entry))
      .map((entry) => (typeof entry.cultivarId === 'string' ? entry.cultivarId : null))
      .filter((entry): entry is string => entry !== null),
  );

  seedInventoryItems.forEach((item, itemIndex) => {
    if (!isObjectRecord(item)) {
      return;
    }

    if (typeof item.cultivarId === 'string' && !cultivarIds.has(item.cultivarId)) {
      pushInvalidRef(`/seedInventoryItems/${itemIndex}/cultivarId`, `seedInventoryItem references unknown cultivarId '${item.cultivarId}'`);
    }

    if (typeof item.cropId === 'string' && !cropIds.has(item.cropId)) {
      pushInvalidRef(`/seedInventoryItems/${itemIndex}/cropId`, `seedInventoryItem references unknown cropId '${item.cropId}'`);
    }
  });

  return issues;
};

const validators: { [K in SchemaName]: ValidateFunction<SchemaTypeMap[K]> } = {
  appState: ajv.compile<SchemaTypeMap['appState']>(appStateSchema),
  batch: ajv.compile<SchemaTypeMap['batch']>(batchSchema),
  bed: ajv.compile<SchemaTypeMap['bed']>(bedSchema),
  crop: ajv.compile<SchemaTypeMap['crop']>(cropSchema),
  cropPlan: ajv.compile<SchemaTypeMap['cropPlan']>(cropPlanSchema),
  path: ajv.compile<SchemaTypeMap['path']>(pathSchema),
  seedInventoryItem: ajv.compile<SchemaTypeMap['seedInventoryItem']>(seedInventoryItemSchema),
  segment: ajv.compile<SchemaTypeMap['segment']>(segmentSchema),
  settings: ajv.compile<SchemaTypeMap['settings']>(settingsSchema),
  species: ajv.compile<SchemaTypeMap['species']>(speciesSchema),
  task: ajv.compile<SchemaTypeMap['task']>(taskSchema),
};

const normalizeError = (schemaName: SchemaName, error: ErrorObject): ValidationIssue => ({
  schemaName,
  path: error.instancePath || '/',
  message: error.message || 'Invalid value',
  keyword: error.keyword,
});

export const assertValid = <T extends SchemaName>(
  schemaName: T,
  payload: unknown,
): SchemaTypeMap[T] => {
  const result = validateSchema(schemaName, payload);

  if (result.ok) {
    return result.value;
  }

  throw new SchemaValidationError(schemaName, result.issues);
};

export const validateSchema = <T extends SchemaName>(
  schemaName: T,
  payload: unknown,
): ValidationResult<T> => {
  const validator = validators[schemaName];
  const normalizedPayload = schemaName === 'appState' ? remapLegacyCropReferences(payload) : payload;

  if (validator(normalizedPayload)) {
    const geometryIssues = collectSegmentGeometryIssues(schemaName, normalizedPayload);
    const layoutParentIssues = collectLayoutParentIssues(schemaName, normalizedPayload);
    const pathPlacementIssues = collectPathPlacementIssues(schemaName, normalizedPayload);
    const cropPlanReferenceIssues = collectCropPlanReferenceIssues(schemaName, normalizedPayload);

    if (
      geometryIssues.length === 0
      && layoutParentIssues.length === 0
      && pathPlacementIssues.length === 0
      && cropPlanReferenceIssues.length === 0
    ) {
      return { ok: true, value: normalizedPayload as SchemaTypeMap[T] };
    }

    return {
      ok: false,
      issues: [...geometryIssues, ...layoutParentIssues, ...pathPlacementIssues, ...cropPlanReferenceIssues],
    };
  }

  const issues = (validator.errors || []).map((error) => normalizeError(schemaName, error));
  const geometryIssues = collectSegmentGeometryIssues(schemaName, normalizedPayload);
  const layoutParentIssues = collectLayoutParentIssues(schemaName, normalizedPayload);
  const pathPlacementIssues = collectPathPlacementIssues(schemaName, normalizedPayload);
  const cropPlanReferenceIssues = collectCropPlanReferenceIssues(schemaName, normalizedPayload);
  return {
    ok: false,
    issues: [...issues, ...geometryIssues, ...layoutParentIssues, ...pathPlacementIssues, ...cropPlanReferenceIssues],
  };
};
