declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options?: { eager?: boolean; import?: string },
    ) => Record<string, unknown>;
  }
}

import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import appStateSchema from './app-state.schema.json';
import bedSchema from './bed.schema.json';
import cropPlanSchema from './crop-plan.schema.json';
import cropSchema from './crop.schema.json';
import seedInventoryItemSchema from './seed-inventory-item.schema.json';
import settingsSchema from './settings.schema.json';
import taskSchema from './task.schema.json';
import type { AppState } from '../generated/contracts';

const goldenFixtures = import.meta.glob('../../../fixtures/golden/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, AppState>;
const fixturePaths = Object.keys(goldenFixtures).sort();

const stableSortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => stableSortValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
        .map(([key, nestedValue]) => [key, stableSortValue(nestedValue)]),
    );
  }

  return value;
};

const toCanonicalJson = (value: unknown): string => `${JSON.stringify(stableSortValue(value), null, 2)}\n`;

const formatAjvErrors = (errors: unknown): string => {
  if (!Array.isArray(errors) || errors.length === 0) {
    return 'Unknown schema validation error';
  }

  return errors
    .map((error) => {
      const instancePath =
        error && typeof error === 'object' && 'instancePath' in error
          ? String(error.instancePath || '/')
          : '/';
      const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : 'invalid';
      const params =
        error && typeof error === 'object' && 'params' in error ? JSON.stringify(error.params) : '{}';

      return `path=${instancePath} message=${message} details=${params}`;
    })
    .join('\n');
};

describe('AppState schema', () => {
  const buildValidator = () => {
    const ajv = new Ajv2020({ strict: true });
    ajv.addSchema(bedSchema);
    ajv.addSchema(cropSchema);
    ajv.addSchema(cropPlanSchema);
    ajv.addSchema(taskSchema);
    ajv.addSchema(seedInventoryItemSchema);
    ajv.addSchema(settingsSchema);
    return ajv.compile(appStateSchema);
  };

  it('accepts a valid AppState payload', () => {
    const validate = buildValidator();
    const payload: AppState = {
      schemaVersion: 1,
      beds: [
        {
          bedId: 'bed_001',
          gardenId: 'garden_001',
          name: 'North bed',
          createdAt: '2026-01-05T00:00:00Z',
          updatedAt: '2026-01-05T00:00:00Z',
        },
      ],
      crops: [
        {
          cropId: 'crop_tomato',
          name: 'Tomato',
          companionsGood: ['crop_basil'],
          companionsAvoid: ['crop_potato'],
          rules: {
            sowing: {
              sequence: 1,
              windows: [{ startMonth: 3, startWeek: 1, endMonth: 3, endWeek: 4 }],
            },
            transplant: {
              sequence: 2,
              windows: [{ startMonth: 4, startWeek: 1, endMonth: 5, endWeek: 1 }],
            },
            harvest: {
              sequence: 3,
              windows: [{ startMonth: 7, startWeek: 1, endMonth: 9, endWeek: 4 }],
            },
            storage: {
              sequence: 4,
              windows: [{ startMonth: 7, startWeek: 2, endMonth: 10, endWeek: 4 }],
            },
          },
          nutritionProfile: [
            {
              nutrient: 'vitamin_c',
              value: 14,
              unit: 'mg',
              source: 'USDA',
              assumptions: 'per 100g',
            },
          ],
          createdAt: '2026-01-05T00:00:00Z',
          updatedAt: '2026-01-05T00:00:00Z',
        },
      ],
      cropPlans: [
        {
          planId: 'plan_001',
          cropId: 'crop_tomato',
          bedId: 'bed_001',
          seasonYear: 2026,
          plannedWindows: {
            sowing: [{ startMonth: 3, startWeek: 1, endMonth: 3, endWeek: 4 }],
            harvest: [{ startMonth: 7, startWeek: 1, endMonth: 9, endWeek: 4 }],
          },
          expectedYield: {
            amount: 5,
            unit: 'kg',
          },
        },
      ],
      tasks: [
        {
          id: 'task_001',
          sourceKey: 'crop_tomato:bed_001',
          date: '2026-03-12',
          type: 'sow',
          cropId: 'crop_tomato',
          bedId: 'bed_001',
          batchId: 'batch_001',
          checklist: [],
          status: 'open',
        },
      ],
      seedInventoryItems: [
        {
          seedInventoryItemId: 'seed_item_001',
          cropId: 'crop_tomato',
          variety: 'Roma',
          quantity: 120,
          unit: 'seeds',
          status: 'available',
          createdAt: '2026-01-05T00:00:00Z',
          updatedAt: '2026-01-05T00:00:00Z',
        },
      ],
      settings: {
        settingsId: 'settings_001',
        locale: 'de-DE',
        timezone: 'Europe/Berlin',
        units: {
          temperature: 'celsius',
          yield: 'metric',
        },
        createdAt: '2026-01-05T00:00:00Z',
        updatedAt: '2026-01-05T00:00:00Z',
      },
    };

    expect(validate(payload)).toBe(true);
  });

  it('rejects AppState payload with invalid schemaVersion', () => {
    const validate = buildValidator();
    const payload = {
      beds: [],
      crops: [],
      cropPlans: [],
      tasks: [],
      seedInventoryItems: [],
      settings: {
        settingsId: 'settings_001',
        locale: 'de-DE',
        timezone: 'Europe/Berlin',
        units: {
          temperature: 'celsius',
          yield: 'metric',
        },
        createdAt: '2026-01-05T00:00:00Z',
        updatedAt: '2026-01-05T00:00:00Z',
      },
    };

    expect(validate(payload)).toBe(false);
  });

  it('accepts all golden fixtures', () => {
    const validate = buildValidator();

    expect(fixturePaths.length).toBeGreaterThan(0);

    for (const fixturePath of fixturePaths) {
      const fixture = goldenFixtures[fixturePath];
      const fixtureName = fixturePath.replace('../../../fixtures/golden/', '');
      const isValid = validate(fixture);

      expect(
        isValid,
        `Fixture ${fixtureName} failed schema validation:\n${formatAjvErrors(validate.errors)}`,
      ).toBe(true);
    }
  });

  it('keeps golden fixtures key-sorted for stable diffs', () => {
    for (const fixturePath of fixturePaths) {
      const fixture = goldenFixtures[fixturePath];
      const canonicalFixture = toCanonicalJson(fixture);
      const fixtureName = fixturePath.replace('../../../fixtures/golden/', '');
      const fixtureJson = `${JSON.stringify(fixture, null, 2)}\n`;

      expect(
        fixtureJson,
        `Fixture ${fixtureName} is not canonical JSON (sorted keys, 2-space indent, trailing newline).\n` +
          `Run: node -e "const fs=require('fs');const p='${fixturePath.replace(/'/g, "\\'")}';const j=JSON.parse(fs.readFileSync(p,'utf8'));const s=(v)=>Array.isArray(v)?v.map(s):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,val])=>[k,s(val)])):v;fs.writeFileSync(p,JSON.stringify(s(j),null,2)+'\\n');"`,
      ).toBe(canonicalFixture);
    }
  });
});
