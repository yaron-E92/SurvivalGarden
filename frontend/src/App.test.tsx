import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options?: { eager?: boolean; import?: string },
    ) => Record<string, unknown>;
  }
}

const realBatchFixtures = import.meta.glob('../../fixtures/real/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, { batches?: Array<Record<string, unknown>> }>;

import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import App, { RecoveryScreen } from './App';
import {
  initializeAppStateStorage,
  loadAppStateFromIndexedDb,
  parseImportedAppState,
  resetToGoldenDataset,
  saveAppStateToIndexedDb,
  SchemaValidationError,
  serializeAppStateForExport,
} from './data';

vi.mock('./data', () => ({
  initializeAppStateStorage: vi.fn().mockResolvedValue(undefined),
  resetToGoldenDataset: vi.fn().mockResolvedValue(undefined),
  loadAppStateFromIndexedDb: vi.fn().mockResolvedValue(null),
  parseImportedAppState: vi.fn(),
  saveAppStateToIndexedDb: vi.fn().mockResolvedValue(undefined),
  serializeAppStateForExport: vi.fn().mockReturnValue('{"schemaVersion":1}'),
  assertValid: vi.fn((schemaName: string, value: unknown) => value),
  upsertCropInAppState: vi.fn((appState: { crops?: Array<{ cropId: string }> }, crop: { cropId: string }) => ({
    ...appState,
    crops: [...(appState.crops ?? []).filter((entry: { cropId: string }) => entry.cropId !== crop.cropId), crop],
  })),
  upsertBatchInAppState: vi.fn((appState: { batches?: Array<{ batchId: string }> }, batch: { batchId: string }) => ({
    ...appState,
    batches: [...(appState.batches ?? []).filter((entry: { batchId: string }) => entry.batchId !== batch.batchId), batch],
  })),
  listBedsFromAppState: vi.fn().mockReturnValue([]),
  listBatchesFromAppState: vi.fn().mockReturnValue([]),
  listTasksFromAppState: vi.fn().mockReturnValue([]),
  SchemaValidationError: class extends Error {
    schemaName: string;
    issues: Array<{ schemaName: string; keyword: string; path: string; message: string }>;

    constructor(schemaName: string, issues: Array<{ schemaName: string; keyword: string; path: string; message: string }>) {
      super('Schema validation failed');
      this.name = 'SchemaValidationError';
      this.schemaName = schemaName;
      this.issues = issues;
    }
  },
}));

const buildBatchCreationState = () => ({
  schemaVersion: 1,
  beds: [],
  species: [
    {
      id: 'species_lettuce',
      commonName: 'Lettuce',
      scientificName: 'Lactuca sativa',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'species_basil',
      commonName: 'Basil',
      scientificName: 'Ocimum basilicum',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ],
  crops: [
    {
      cropId: 'crop_lettuce_romaine',
      name: 'Lettuce',
      cultivar: 'Lettuce',
      speciesId: 'species_lettuce',
      species: {
        id: 'species_lettuce',
        commonName: 'Lettuce',
        scientificName: 'Lactuca sativa',
      },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    {
      cropId: 'crop_basil_genoveser',
      name: 'Basil',
      cultivar: 'Basil',
      speciesId: 'species_basil',
      species: {
        id: 'species_basil',
        commonName: 'Basil',
        scientificName: 'Ocimum basilicum',
      },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ],
  cropPlans: [],
  cultivars: [
    {
      cultivarId: 'cultivar_lettuce_romaine',
      cropTypeId: 'crop_lettuce_romaine',
      name: 'Romaine',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    {
      cultivarId: 'cultivar_basil_genoveser',
      cropTypeId: 'crop_basil_genoveser',
      name: 'Genoveser',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ],
  batches: [],
  tasks: [],
  seedInventoryItems: [],
  settings: {
    settingsId: 'settings-1',
    locale: 'en-US',
    timezone: 'UTC',
    units: { temperature: 'celsius', yield: 'metric' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
});

describe('App', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_ENABLE_DEV_RESET', '');
    if (typeof URL.createObjectURL === 'function') {
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    } else {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: vi.fn().mockReturnValue('blob:test'),
      });
    }

    if (typeof URL.revokeObjectURL === 'function') {
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    } else {
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        writable: true,
        value: vi.fn(),
      });
    }

    if (typeof File !== 'undefined' && typeof File.prototype.text !== 'function') {
      Object.defineProperty(File.prototype, 'text', {
        configurable: true,
        writable: true,
        value: vi.fn().mockResolvedValue(''),
      });
    }
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });


  it('renders recovery mode and requires explicit reset confirmation', async () => {
    render(<RecoveryScreen error={new Error('corrupt state')} onRetry={vi.fn()} showDevResetButton />);

    expect(screen.getByRole('heading', { name: 'Recovery mode' })).toBeInTheDocument();
    const resetButton = screen.getByRole('button', { name: 'Restore golden dataset' });
    expect(resetButton).toBeDisabled();

    fireEvent.click(resetButton);
    expect(resetToGoldenDataset).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox', { name: /I understand this will replace local data/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore golden dataset' }));

    await waitFor(() => {
      expect(resetToGoldenDataset).toHaveBeenCalledTimes(1);
    });
  });

  it('exports readable data from recovery mode', async () => {
    vi.mocked(loadAppStateFromIndexedDb).mockResolvedValue({ schemaVersion: 1, beds: [], crops: [], cropPlans: [], batches: [], seedInventory: [], tasks: [] } as never);
    render(<RecoveryScreen error={new Error('boom')} onRetry={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Export readable data' }));

    await waitFor(() => {
      expect(serializeAppStateForExport).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Export complete:/)).toBeInTheDocument();
    });
  });


  it('calls retry from recovery mode without auto-looping actions', () => {
    const onRetry = vi.fn();
    render(<RecoveryScreen error={new Error('fail')} onRetry={onRetry} />);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(resetToGoldenDataset).not.toHaveBeenCalled();
  });

  it('hides recovery reset action when flag-backed prop is disabled', () => {
    render(<RecoveryScreen error={new Error('fail')} onRetry={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Restore golden dataset' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /I understand this will replace local data/i })).not.toBeInTheDocument();
  });

  it('renders the app title and primary navigation', () => {
    render(
      <MemoryRouter initialEntries={['/beds']}>
        <App />
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { name: 'SurvivalGarden' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Beds' })).toBeInTheDocument();
  });

  it('deletes a segment path and persists updated segment state', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(loadAppStateFromIndexedDb).mockResolvedValue({
      schemaVersion: 1,
      beds: [],
      crops: [],
      cropPlans: [],
      batches: [],
      seedInventoryItems: [],
      tasks: [],
      settings: {
        settingsId: 'settings-1',
        locale: 'en-DE',
        timezone: 'Europe/Berlin',
        units: { temperature: 'celsius', yield: 'metric' },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      segments: [
        {
          segmentId: 'segment-1',
          name: 'North',
          width: 4,
          height: 3,
          originReference: 'nw_corner',
          beds: [],
          paths: [
            { pathId: 'path-1', name: 'Main', x: 0, y: 0, width: 1, height: 3 },
          ],
        },
      ],
    } as never);

    render(
      <MemoryRouter initialEntries={['/beds']}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete path' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete path' }));

    await waitFor(() => {
      expect(saveAppStateToIndexedDb).toHaveBeenCalledWith(expect.objectContaining({
        segments: [
          expect.objectContaining({
            segmentId: 'segment-1',
            paths: [],
          }),
        ],
      }));
    });

    expect(screen.getByText('Deleted path path-1.')).toBeInTheDocument();
  });

  it('blocks deleting a segment path when downstream references exist', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(loadAppStateFromIndexedDb).mockResolvedValue({
      schemaVersion: 1,
      beds: [],
      crops: [],
      cropPlans: [{ planId: 'plan-1', cropId: 'crop-1', bedId: 'path-1', seasonYear: 2026, plannedWindows: { sowing: [], harvest: [] }, expectedYield: { amount: 1, unit: 'kg' } }],
      batches: [],
      seedInventoryItems: [],
      tasks: [],
      settings: {
        settingsId: 'settings-1',
        locale: 'en-DE',
        timezone: 'Europe/Berlin',
        units: { temperature: 'celsius', yield: 'metric' },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      segments: [
        {
          segmentId: 'segment-1',
          name: 'North',
          width: 4,
          height: 3,
          originReference: 'nw_corner',
          beds: [],
          paths: [
            { pathId: 'path-1', name: 'Main', x: 0, y: 0, width: 1, height: 3 },
          ],
        },
      ],
    } as never);

    render(
      <MemoryRouter initialEntries={['/beds']}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete path' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete path' }));

    await waitFor(() => {
      expect(screen.getByText('Cannot delete path path-1 because it is referenced by 1 crop plan.')).toBeInTheDocument();
    });

    expect(saveAppStateToIndexedDb).not.toHaveBeenCalled();
  });

  it('hides dev reset action when flag is disabled', () => {
    render(
      <MemoryRouter initialEntries={['/data']}>
        <App />
      </MemoryRouter>
    );

    expect(screen.queryByRole('button', { name: 'Restore golden dataset' })).not.toBeInTheDocument();
  });

  it('shows dev reset action when flag is enabled and resets to golden dataset', () => {
    vi.stubEnv('VITE_ENABLE_DEV_RESET', 'true');

    render(
      <MemoryRouter initialEntries={['/data']}>
        <App />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Restore golden dataset' }));

    expect(resetToGoldenDataset).toHaveBeenCalledTimes(1);
    expect(initializeAppStateStorage).toHaveBeenCalled();
  });

  it('hides taxonomy repair flow when flag is disabled', async () => {
    render(
      <MemoryRouter initialEntries={['/taxonomy']}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Create crop type' })).toBeInTheDocument();
    });

    expect(screen.queryByRole('heading', { name: 'Repair crop type taxonomy' })).not.toBeInTheDocument();
  });

  it('shows taxonomy repair flow when flag is enabled', async () => {
    vi.stubEnv('VITE_ENABLE_DEV_RESET', 'true');

    render(
      <MemoryRouter initialEntries={['/taxonomy']}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Repair crop type taxonomy' })).toBeInTheDocument();
    });
  });

  it('exports JSON from current app state and triggers download', async () => {
    const mockAppState = {
      schemaVersion: 1,
      beds: [],
      crops: [],
      cropPlans: [],
      batches: [{ batchId: 'batch-1', photos: [{ id: 'photo-1', storageRef: 'photo-1', filename: 'leaf.jpg' }] }],
      seedInventory: [],
      tasks: [],
    };
    vi.mocked(loadAppStateFromIndexedDb).mockResolvedValue(mockAppState as never);

    render(
      <MemoryRouter initialEntries={['/data']}>
        <App />
      </MemoryRouter>
    );

    const appendChildSpy = vi.spyOn(document.body, 'appendChild');
    const removeChildSpy = vi.spyOn(document.body, 'removeChild');
    const anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));

    await waitFor(() => {
      expect(serializeAppStateForExport).toHaveBeenCalledWith(mockAppState);
      expect(anchorClickSpy).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByText(/Export complete:/)).toBeInTheDocument();
    expect(appendChildSpy).not.toHaveBeenCalled();
    expect(removeChildSpy).not.toHaveBeenCalled();
  });

  it('blocks download and surfaces validation issues when export serialization fails', async () => {
    vi.mocked(loadAppStateFromIndexedDb).mockResolvedValue({ schemaVersion: 1 } as never);
    const validationError = new SchemaValidationError('appState', [
      {
        schemaName: 'appState',
        keyword: 'type',
        path: '/batches/0/photos/0/storageRef',
        message: 'must be string',
      },
    ]);
    vi.mocked(serializeAppStateForExport).mockImplementation(() => {
      throw validationError;
    });

    const anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(
      <MemoryRouter initialEntries={['/data']}>
        <App />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));

    await waitFor(() => {
      expect(screen.getByText(/Export failed:/)).toBeInTheDocument();
    });

    expect(anchorClickSpy).not.toHaveBeenCalled();
  });

  it('shows import validation errors and does not persist invalid payloads', async () => {
    const validationError = new SchemaValidationError('appState', [
      {
        schemaName: 'appState',
        keyword: 'type',
        path: '/batches/0/photos/0/storageRef',
        message: 'must be string',
      },
    ]);
    vi.mocked(parseImportedAppState).mockImplementation(() => {
      throw validationError;
    });

    render(
      <MemoryRouter initialEntries={['/data']}>
        <App />
      </MemoryRouter>
    );

    const input = screen.getByLabelText('Import JSON');
    const file = new File(['{invalid'], 'bad.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('Import failed. Fix the errors below and try again.')).toBeInTheDocument();
    });

    expect(screen.getByText(/\/batches\/0\/photos\/0\/storageRef/)).toBeInTheDocument();
    expect(saveAppStateToIndexedDb).not.toHaveBeenCalled();
  });

  it('requires replace confirmation before saving imported data', async () => {
    const importedState = { schemaVersion: 1, beds: [], crops: [], cropPlans: [], batches: [], seedInventoryItems: [], tasks: [] };
    vi.mocked(parseImportedAppState).mockReturnValue(importedState as never);

    render(
      <MemoryRouter initialEntries={['/data']}>
        <App />
      </MemoryRouter>
    );

    const input = screen.getByLabelText('Import JSON');
    const file = new File(['{"schemaVersion":1}'], 'good.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('Import file is valid. Replace existing data?')).toBeInTheDocument();
    });

    expect(saveAppStateToIndexedDb).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Replace existing data' }));

    await waitFor(() => {
      expect(saveAppStateToIndexedDb).toHaveBeenCalledWith(importedState, { mode: 'replace' });
      expect(screen.getByText('Import complete. Existing data was replaced.')).toBeInTheDocument();
    });
  });

  it('previews batch json with partial success and imports only after confirmation', async () => {
    const validOnlyState = { schemaVersion: 1, beds: [], crops: [], cropPlans: [], batches: [{ batchId: 'batch-1', startedAt: '2026-01-01' }], seedInventoryItems: [], tasks: [] };
    const validationError = new SchemaValidationError('batch', [
      {
        schemaName: 'batch',
        keyword: 'required',
        path: '/batches/0/startedAt',
        message: "must have required property 'startedAt'",
      },
    ]);
    vi.mocked(parseImportedAppState).mockImplementation((payload: string) => {
      if (payload.includes('"batch-invalid"')) {
        throw validationError;
      }
      if (payload.includes('"batches":[{"batchId":"batch-1"},{"batchId":"batch-invalid"}]')) {
        return validOnlyState as never;
      }
      return validOnlyState as never;
    });
    vi.mocked(saveAppStateToIndexedDb).mockResolvedValue({
      beds: { added: 0, updated: 0, unchanged: 0 },
      crops: { added: 0, updated: 0, unchanged: 0 },
      cropPlans: { added: 0, updated: 0, unchanged: 0 },
      batches: { added: 1, updated: 0, unchanged: 0 },
      tasks: { added: 0, updated: 0, unchanged: 0 },
      seedInventoryItems: { added: 0, updated: 0, unchanged: 0 },
      conflicts: [],
      warnings: [],
    } as never);

    render(
      <MemoryRouter initialEntries={['/data']}>
        <App />
      </MemoryRouter>
    );

    const input = screen.getByLabelText('Import Batch JSON');
    const file = new File(['{"batches":[{"batchId":"batch-1"},{"batchId":"batch-invalid"}]}'], 'batches.json', { type: 'application/json' });
    vi.spyOn(file, 'text').mockResolvedValue('{"batches":[{"batchId":"batch-1"},{"batchId":"batch-invalid"}]}');
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText(/Batch import ready: 1 valid batch\(es\) from 2 payload batch\(es\), invalid 1\./)).toBeInTheDocument();
      expect(screen.getByText('Import Preview')).toBeInTheDocument();
      expect(screen.getByText('Batch: Unknown cultivar (Unknown crop type)')).toBeInTheDocument();
      expect(screen.getByText('Seeds: 0')).toBeInTheDocument();
      expect(screen.getByText('Events: 0')).toBeInTheDocument();
      expect(screen.getByLabelText('Auto-rename on ID conflict (presentation preview)')).toBeInTheDocument();
      expect(screen.getByText(/ID collision statuses:/)).toBeInTheDocument();
      expect(screen.getByText(/schema_validation_failed \(batchId: batch-invalid, field: startedAt\)/)).toBeInTheDocument();
    });

    expect(saveAppStateToIndexedDb).not.toHaveBeenCalledWith(validOnlyState, { mode: 'merge' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Import Preview')).not.toBeInTheDocument();

    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => {
      expect(screen.getByText('Import Preview')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => {
      expect(saveAppStateToIndexedDb).toHaveBeenCalledWith(expect.objectContaining(validOnlyState), { mode: 'merge' });
      expect(screen.getByText('Collision Status Summary')).toBeInTheDocument();
      expect(screen.getByText('skipped (identical_batch): 0')).toBeInTheDocument();
      expect(screen.getByText('merged (eventsAdded): 0')).toBeInTheDocument();
      expect(screen.getByText('rejected (batch_identity_conflict): 0')).toBeInTheDocument();
      expect(screen.getByText('renamed (newId): 0')).toBeInTheDocument();
    });
  });


  it('previews segment json import with per-segment counts and statuses before confirmation', async () => {
    vi.mocked(loadAppStateFromIndexedDb).mockResolvedValue({
      schemaVersion: 1,
      beds: [],
      crops: [],
      cropPlans: [],
      batches: [],
      seedInventoryItems: [],
      tasks: [],
      segments: [
        {
          segmentId: 'segment_existing',
          name: 'Existing Segment',
          width: 5,
          height: 5,
          originReference: 'nw_corner',
          beds: [],
          paths: [],
        },
      ],
    } as never);

    vi.mocked(parseImportedAppState).mockReturnValue({
      schemaVersion: 1,
      beds: [],
      crops: [],
      cropPlans: [],
      batches: [],
      seedInventoryItems: [],
      tasks: [],
      segments: [
        {
          segmentId: 'segment_new',
          name: 'North Segment',
          width: 5.8,
          height: 4.5,
          originReference: 'nw_corner',
          beds: [{ bedId: 'bed_n1' }],
          paths: [{ pathId: 'path_north_1' }],
        },
        {
          segmentId: 'segment_existing',
          name: 'Existing Segment',
          width: 5,
          height: 5,
          originReference: 'nw_corner',
          beds: [],
          paths: [],
        },
      ],
    } as never);

    render(
      <MemoryRouter initialEntries={['/data']}>
        <App />
      </MemoryRouter>
    );

    const input = screen.getByLabelText('Import Segment JSON');
    const file = new File(['{"segments":[]}'], 'segments.json', { type: 'application/json' });
    vi.spyOn(file, 'text').mockResolvedValue('{"segments":[]}');
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('Segment Import Preview')).toBeInTheDocument();
      expect(screen.getByText('Segment: North Segment (segment_new)')).toBeInTheDocument();
      expect(screen.getByText('Beds: 1 · Paths: 1')).toBeInTheDocument();
      expect(screen.getByText('Status: imported')).toBeInTheDocument();
      expect(screen.getByText('Status: skipped (identical_segment)')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Import segments' }));

    await waitFor(() => {
      expect(screen.getByText('Segment Import Summary')).toBeInTheDocument();
      expect(screen.getByText('imported: 1')).toBeInTheDocument();
      expect(screen.getByText('merged: 0')).toBeInTheDocument();
      expect(screen.getByText('skipped (identical_segment): 1')).toBeInTheDocument();
      expect(screen.getByText('rejected (segment_identity_conflict): 0')).toBeInTheDocument();
    });
  });

  it('surfaces segment identity conflicts as rejected without silent overwrite', async () => {
    vi.mocked(loadAppStateFromIndexedDb).mockResolvedValue({
      schemaVersion: 1,
      beds: [],
      crops: [],
      cropPlans: [],
      batches: [],
      seedInventoryItems: [],
      tasks: [],
      segments: [
        {
          segmentId: 'segment_north',
          name: 'North Segment',
          width: 5.8,
          height: 4.5,
          originReference: 'nw_corner',
          beds: [],
          paths: [],
        },
      ],
    } as never);

    vi.mocked(parseImportedAppState).mockReturnValue({
      schemaVersion: 1,
      beds: [],
      crops: [],
      cropPlans: [],
      batches: [],
      seedInventoryItems: [],
      tasks: [],
      segments: [
        {
          segmentId: 'segment_north',
          name: 'Conflicting Name',
          width: 5.8,
          height: 4.5,
          originReference: 'se_corner',
          beds: [],
          paths: [],
        },
      ],
    } as never);

    render(
      <MemoryRouter initialEntries={['/data']}>
        <App />
      </MemoryRouter>
    );

    const input = screen.getByLabelText('Import Segment JSON');
    const file = new File(['{"segments":[]}'], 'segments-conflict.json', { type: 'application/json' });
    vi.spyOn(file, 'text').mockResolvedValue('{"segments":[]}');
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('Status: rejected (segment_identity_conflict)')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Import segments' }));

    await waitFor(() => {
      expect(screen.getByText('rejected (segment_identity_conflict): 1')).toBeInTheDocument();
      expect(screen.getByText(/rejected \(segment_identity_conflict\): identity mismatch for segmentId segment_north/)).toBeInTheDocument();
    });
  });

  it('rejects malformed batch json import', async () => {
    render(
      <MemoryRouter initialEntries={['/data']}>
        <App />
      </MemoryRouter>
    );

    const input = screen.getByLabelText('Import Batch JSON');
    const file = new File(['{invalid'], 'bad-batches.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('Import failed. Fix the errors below and try again.')).toBeInTheDocument();
    });

    expect(saveAppStateToIndexedDb).not.toHaveBeenCalledWith(expect.anything(), { mode: 'merge' });
  });


  it('shows auto-rename capability note when toggle is enabled', async () => {
    const validOnlyState = { schemaVersion: 1, beds: [], crops: [], cropPlans: [], batches: [{ batchId: 'batch-1', startedAt: '2026-01-01' }], seedInventoryItems: [], tasks: [] };
    vi.mocked(parseImportedAppState).mockReturnValue(validOnlyState as never);
    vi.mocked(saveAppStateToIndexedDb).mockResolvedValue({
      beds: { added: 0, updated: 0, unchanged: 0 },
      crops: { added: 0, updated: 0, unchanged: 0 },
      cropPlans: { added: 0, updated: 0, unchanged: 0 },
      batches: { added: 1, updated: 0, unchanged: 0 },
      tasks: { added: 0, updated: 0, unchanged: 0 },
      seedInventoryItems: { added: 0, updated: 0, unchanged: 0 },
      conflicts: [],
      warnings: [],
    } as never);

    render(
      <MemoryRouter initialEntries={['/data']}>
        <App />
      </MemoryRouter>
    );

    const input = screen.getByLabelText('Import Batch JSON');
    const file = new File(['{"batches":[{"batchId":"batch-1","startedAt":"2026-01-01"}]}'], 'batches.json', { type: 'application/json' });
    vi.spyOn(file, 'text').mockResolvedValue('{"batches":[{"batchId":"batch-1","startedAt":"2026-01-01"}]}');
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('Import Preview')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('Auto-rename on ID conflict (presentation preview)'));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => {
      expect(screen.getByText(/Auto-rename requested, but this importer currently reports collisions as deterministic rejects\./)).toBeInTheDocument();
    });
  });

  it('accepts deep-link batch import payload and requires confirmation before merge', async () => {
    const validOnlyState = { schemaVersion: 1, beds: [], crops: [], cropPlans: [], batches: [{ batchId: 'batch-1', startedAt: '2026-01-01' }], seedInventoryItems: [], tasks: [] };
    vi.mocked(parseImportedAppState).mockImplementation((payload: string) => {
      if (payload.includes('"batches":[{"batchId":"batch-1"}]')) {
        return validOnlyState as never;
      }
      return {
        schemaVersion: 1,
        beds: [],
        crops: [],
        cropPlans: [],
        batches: [{ batchId: 'batch-1', startedAt: '2026-01-01' }],
        seedInventoryItems: [],
        tasks: [],
      } as never;
    });

    const deepLinkPayload = btoa(JSON.stringify({
      batches: [{ batchId: 'batch-1', startedAt: '2026-01-01' }],
    }));

    render(
      <MemoryRouter initialEntries={[`/import-batches?data=${deepLinkPayload}`]}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Deep link ready: 1 valid batch\(es\) from 1 payload batch\(es\)\./)).toBeInTheDocument();
    });

    expect(screen.getByText('Import Preview')).toBeInTheDocument();
    expect(saveAppStateToIndexedDb).not.toHaveBeenCalledWith(expect.anything(), { mode: 'merge' });

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => {
      expect(saveAppStateToIndexedDb).toHaveBeenCalledWith(expect.objectContaining(validOnlyState), { mode: 'merge' });
    });
  });

  it('shows deep-link import error when payload is malformed', async () => {
    render(
      <MemoryRouter initialEntries={['/import-batches?data=%%%'] }>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Deep-link import failed. Payload was invalid or too large.')).toBeInTheDocument();
    });

    expect(saveAppStateToIndexedDb).not.toHaveBeenCalledWith(expect.anything(), { mode: 'merge' });
  });

  it('accepts deep-link segment import payload and requires confirmation before import', async () => {
    vi.mocked(loadAppStateFromIndexedDb).mockResolvedValue({
      schemaVersion: 1,
      beds: [],
      crops: [],
      cropPlans: [],
      batches: [],
      seedInventoryItems: [],
      tasks: [],
      segments: [],
    } as never);

    const validSegmentState = {
      schemaVersion: 1,
      beds: [],
      crops: [],
      cropPlans: [],
      batches: [],
      seedInventoryItems: [],
      tasks: [],
      segments: [
        {
          segmentId: 'segment_north',
          name: 'North Segment',
          width: 5.8,
          height: 4.5,
          originReference: 'nw_corner',
          beds: [
            {
              bedId: 'bed_n1',
              gardenId: 'garden_main',
              name: 'Bed N1',
              type: 'vegetable_bed',
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
              x: 0.2,
              y: 0.3,
              width: 1.2,
              height: 3.8,
            },
          ],
          paths: [
            {
              pathId: 'path_n1_main',
              name: 'Main Path',
              x: 1.5,
              y: 0,
              width: 0.4,
              height: 4.5,
            },
          ],
        },
      ],
    };

    vi.mocked(parseImportedAppState).mockReturnValue(validSegmentState as never);

    const deepLinkPayload = btoa(JSON.stringify({
      segments: [
        {
          segmentId: 'segment_north',
          name: 'North Segment',
        },
      ],
    }));

    render(
      <MemoryRouter initialEntries={[`/import-segments?data=${deepLinkPayload}`]}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/Deep link ready: 1 valid segment\(s\) from 1 payload segment\(s\)\./)).toBeInTheDocument();
    });

    expect(screen.getByText('Size: 5.8 m × 4.5 m')).toBeInTheDocument();
    expect(screen.getByText('Types: vegetable_bed')).toBeInTheDocument();
    expect(saveAppStateToIndexedDb).not.toHaveBeenCalledWith(expect.objectContaining({ segments: expect.anything() }), { mode: 'replace' });

    fireEvent.click(screen.getByRole('button', { name: 'Import segments' }));

    await waitFor(() => {
      expect(saveAppStateToIndexedDb).toHaveBeenCalledWith(expect.objectContaining({ segments: validSegmentState.segments }), { mode: 'replace' });
    });
  });

  it('shows deep-link segment import error when payload is malformed', async () => {
    render(
      <MemoryRouter initialEntries={['/import-segments?data=%%%']}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Deep-link import failed. Payload was invalid or too large.')).toBeInTheDocument();
    });
  });

  it('renders deterministic nutrition coverage totals and per-day values from non-trivial yields', async () => {
    vi.mocked(loadAppStateFromIndexedDb).mockResolvedValue({
      schemaVersion: 1,
      beds: [],
      batches: [],
      tasks: [],
      seedInventoryItems: [],
      settings: {
        settingsId: 'settings-1',
        locale: 'en-DE',
        timezone: 'Europe/Berlin',
        units: { temperature: 'celsius', yield: 'metric' },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      crops: [
        {
          cropId: 'crop_potato_unknown_variety',
          name: 'Potato',
          companionsGood: [],
          companionsAvoid: [],
          rules: {
            sowing: { sequence: 1, windows: [] },
            transplant: { sequence: 2, windows: [] },
            harvest: { sequence: 3, windows: [] },
            storage: { sequence: 4, windows: [] },
          },
          nutritionProfile: [
            { nutrient: 'kcal', value: 77, unit: 'kcal', source: 'USDA', assumptions: 'Per 100g edible portion.' },
            { nutrient: 'protein', value: 2, unit: 'g', source: 'USDA', assumptions: 'Per 100g edible portion.' },
          ],
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        {
          cropId: 'crop_beans_unknown_variety',
          name: 'Beans',
          companionsGood: [],
          companionsAvoid: [],
          rules: {
            sowing: { sequence: 1, windows: [] },
            transplant: { sequence: 2, windows: [] },
            harvest: { sequence: 3, windows: [] },
            storage: { sequence: 4, windows: [] },
          },
          nutritionProfile: [
            { nutrient: 'kcal', value: 127, unit: 'kcal', source: 'USDA', assumptions: 'Per 100g cooked.' },
            { nutrient: 'protein', value: 8.7, unit: 'g', source: 'USDA', assumptions: 'Per 100g cooked.' },
          ],
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      cropPlans: [
        {
          planId: 'plan_1',
          cropId: 'crop_potato_unknown_variety',
          seasonYear: 2026,
          plannedWindows: { sowing: [], harvest: [] },
          expectedYield: { amount: 22, unit: 'kg' },
        },
        {
          planId: 'plan_2',
          cropId: 'crop_beans_unknown_variety',
          seasonYear: 2026,
          plannedWindows: { sowing: [], harvest: [] },
          expectedYield: { amount: 8, unit: 'kg' },
        },
      ],
    } as never);

    render(
      <MemoryRouter initialEntries={['/nutrition']}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Macro coverage')).toBeInTheDocument();
    });

    expect(
      screen.getByText((_, element) => {
        const text = element?.textContent?.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';
        return element?.tagName === 'LI' && text.includes('calories') && text.includes('total 27100 kcal') && text.includes('per day 74 kcal') && text.includes('coverage vs generic target: 4%');
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => {
        const text = element?.textContent?.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';
        return element?.tagName === 'LI' && text.includes('protein') && text.includes('total 1136 g') && text.includes('per day 3.11 g') && text.includes('coverage vs generic target: 6%');
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Excluded crops warning: none.')).toBeInTheDocument();
    expect(screen.getByText('Key micronutrients')).toBeInTheDocument();
    expect(screen.getByText(/coverage labels use generic targets only/i)).toBeInTheDocument();
    expect(screen.getByText(/Generic targets are for reference labels only and this estimate is rough/i)).toBeInTheDocument();
  });

  it('excludes crops with missing nutrition inputs and lists deterministic warning entries', async () => {
    vi.mocked(loadAppStateFromIndexedDb).mockResolvedValue({
      schemaVersion: 1,
      beds: [],
      batches: [],
      tasks: [],
      seedInventoryItems: [],
      settings: {
        settingsId: 'settings-1',
        locale: 'en-DE',
        timezone: 'Europe/Berlin',
        units: { temperature: 'celsius', yield: 'metric' },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      crops: [
        {
          cropId: 'crop_unknown',
          name: 'Mystery Crop',
          companionsGood: [],
          companionsAvoid: [],
          rules: {
            sowing: { sequence: 1, windows: [] },
            transplant: { sequence: 2, windows: [] },
            harvest: { sequence: 3, windows: [] },
            storage: { sequence: 4, windows: [] },
          },
          nutritionProfile: [],
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        {
          cropId: 'crop_tomato_san_marzano',
          name: 'Tomato',
          cultivar: 'San Marzano',
          speciesId: 'species_tomato',
          companionsGood: [],
          companionsAvoid: [],
          rules: {
            sowing: { sequence: 1, windows: [] },
            transplant: { sequence: 2, windows: [] },
            harvest: { sequence: 3, windows: [] },
            storage: { sequence: 4, windows: [] },
          },
          nutritionProfile: [{ nutrient: 'kcal', value: 18, unit: 'kcal', source: 'USDA', assumptions: 'Per 100g edible portion.' }],
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      cropPlans: [
        {
          planId: 'plan_unknown',
          cropId: 'crop_unknown',
          seasonYear: 2026,
          plannedWindows: { sowing: [], harvest: [] },
          expectedYield: { amount: 12, unit: 'kg' },
        },
        {
          planId: 'plan_tomato_missing_mass',
          cropId: 'crop_tomato_san_marzano',
          seasonYear: 2026,
          plannedWindows: { sowing: [], harvest: [] },
          expectedYield: { amount: 8, unit: 'pieces' },
        },
      ],
    } as never);

    render(
      <MemoryRouter initialEntries={['/nutrition']}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Excluded crops (missing nutrition data)')).toBeInTheDocument();
    });

    expect(screen.getByText('Mystery Crop (plan_unknown) — missing nutrition profile')).toBeInTheDocument();
    expect(screen.getByText('Tomato (plan_tomato_missing_mass) — missing mass expected yield')).toBeInTheDocument();
  });


  it('keeps a created species after save and reload on the batches page', async () => {
    let persistedAppState = {
      schemaVersion: 1,
      beds: [],
      species: [],
      crops: [],
      cropPlans: [],
      batches: [],
      tasks: [],
      seedInventoryItems: [],
      settings: {
        settingsId: 'settings-1',
        locale: 'en-US',
        timezone: 'UTC',
        units: { temperature: 'celsius', yield: 'metric' },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    };

    vi.mocked(loadAppStateFromIndexedDb).mockImplementation(async () => persistedAppState as never);
    vi.mocked(saveAppStateToIndexedDb).mockImplementation(async (nextState) => {
      persistedAppState = nextState as typeof persistedAppState;
      return undefined as never;
    });

    const { unmount } = render(
      <MemoryRouter initialEntries={['/taxonomy']}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Create species' })).toBeInTheDocument();
    });

    const createSpeciesForm = screen.getByRole('heading', { name: 'Create species' }).closest('form');
    expect(createSpeciesForm).not.toBeNull();
    const form = createSpeciesForm as HTMLFormElement;

    fireEvent.change(within(form).getByLabelText('Species ID'), { target: { value: 'species_pea' } });
    fireEvent.change(within(form).getByLabelText('Common name'), { target: { value: 'Pea' } });
    fireEvent.change(within(form).getByLabelText('Scientific name'), { target: { value: 'Pisum sativum' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create species' }));

    await waitFor(() => {
      expect(saveAppStateToIndexedDb).toHaveBeenCalledWith(expect.objectContaining({
        species: [
          expect.objectContaining({
            id: 'species_pea',
            commonName: 'Pea',
            scientificName: 'Pisum sativum',
          }),
        ],
      }));
      expect(screen.getByText('Species created.')).toBeInTheDocument();
    });

    unmount();

    render(
      <MemoryRouter initialEntries={['/taxonomy']}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => {
      const editSpeciesForm = screen.getByRole('heading', { name: 'Edit species metadata' }).closest('form');
      expect(editSpeciesForm).not.toBeNull();
      expect(within(editSpeciesForm as HTMLFormElement).getByDisplayValue('Pea (Pisum sativum)')).toBeInTheDocument();
    });
  });

  it('routes crop creation to taxonomy instead of batches', async () => {
    vi.mocked(loadAppStateFromIndexedDb).mockResolvedValue({
      schemaVersion: 1,
      beds: [
        {
          bedId: 'bed_1',
          gardenId: 'garden_1',
          name: 'North Bed',
          type: 'vegetable_bed',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      batches: [],
      tasks: [],
      seedInventoryItems: [],
      settings: {
        settingsId: 'settings-1',
        locale: 'en-DE',
        timezone: 'Europe/Berlin',
        units: { temperature: 'celsius', yield: 'metric' },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      crops: [],
      cropPlans: [],
    } as never);

    render(
      <MemoryRouter initialEntries={['/batches']}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Add new crop' })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: 'Open crop type taxonomy form' })).toHaveAttribute('href', '/taxonomy#create-crop');
  });

  it('shows crop cultivar editing on batches instead of taxonomy', async () => {
    vi.mocked(loadAppStateFromIndexedDb).mockResolvedValue({
      schemaVersion: 1,
      beds: [],
      species: [
        {
          id: 'species_potato',
          commonName: 'Potato',
          scientificName: 'Solanum tuberosum',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      crops: [
        {
          cropId: 'crop_user_agria',
          name: 'Agria',
          cultivar: 'Agria',
          speciesId: 'species_potato',
          species: {
            id: 'species_potato',
            commonName: 'Potato',
            scientificName: 'Solanum tuberosum',
          },
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      cropPlans: [],
      batches: [],
      tasks: [],
      seedInventoryItems: [],
      settings: {
        settingsId: 'settings-1',
        locale: 'en-US',
        timezone: 'UTC',
        units: { temperature: 'celsius', yield: 'metric' },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    } as never);

    const { unmount } = render(
      <MemoryRouter initialEntries={['/batches']}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Edit crop type metadata' })).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: 'Edit crop type metadata' })).toHaveAttribute('href', '/batches#edit-crop');

    unmount();

    render(
      <MemoryRouter initialEntries={['/taxonomy']}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Create crop type' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: 'Edit crop type metadata' })).not.toBeInTheDocument();
  });


  it('labels the batch form selector as cultivar and shows derived taxonomy context', async () => {
    vi.mocked(loadAppStateFromIndexedDb).mockResolvedValue({
      schemaVersion: 1,
      beds: [],
      species: [
        {
          id: 'species_kohlrabi',
          commonName: 'Kohlrabi',
          scientificName: 'Brassica oleracea',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      crops: [
        {
          cropId: 'crop_kohlrabi',
          name: 'Kohlrabi',
          cultivar: 'Kohlrabi',
          speciesId: 'species_kohlrabi',
          species: {
            id: 'species_kohlrabi',
            commonName: 'Kohlrabi',
            scientificName: 'Brassica oleracea',
          },
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      cropPlans: [],
      cultivars: [
        {
          cultivarId: 'cultivar_kohlrabi_delikatess_weiss',
          cropTypeId: 'crop_kohlrabi',
          name: 'Delikatess Weiß',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      batches: [],
      tasks: [],
      seedInventoryItems: [],
      settings: {
        settingsId: 'settings-1',
        locale: 'en-US',
        timezone: 'UTC',
        units: { temperature: 'celsius', yield: 'metric' },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    } as never);

    render(
      <MemoryRouter initialEntries={['/batches']}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Create batch' })).toBeInTheDocument();
    });

    const createBatchForm = screen.getByRole('heading', { name: 'Create batch' }).closest('form') as HTMLFormElement;
    expect(within(createBatchForm).getByPlaceholderText('Cultivar · Crop Type · Species')).toBeInTheDocument();
    expect(within(createBatchForm).getByLabelText(/^Crop Type/)).toHaveValue('');
    expect(within(createBatchForm).getByLabelText(/^Species/)).toHaveValue('');
    expect(screen.getByText('Select an existing cultivar record. Crop type and species are derived automatically.')).toBeInTheDocument();
    expect(screen.queryByText('Cultivar / variety label (legacy temporary field)')).not.toBeInTheDocument();
  });

  it('submits supported sowing start methods with the expected stored stage-event method', async () => {
    const realFixture = realBatchFixtures['../../fixtures/real/actual-batches-vnext-2026-03-07.json'];
    const migratedBasilBatch = realFixture?.batches?.find((batch) => batch.batchId === 'batch-basil-genoveser-2026-01');
    const migratedLettuceBatch = realFixture?.batches?.find((batch) => batch.batchId === 'batch-lettuce-2026-03-06-01');

    expect(migratedBasilBatch).toBeDefined();
    expect(migratedLettuceBatch).toBeDefined();

    vi.mocked(loadAppStateFromIndexedDb).mockResolvedValue(buildBatchCreationState() as never);

    render(
      <MemoryRouter initialEntries={['/batches']}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Create batch' })).toBeInTheDocument();
    });

    const createBatchForm = screen.getByRole('heading', { name: 'Create batch' }).closest('form') as HTMLFormElement;
    const cultivarInput = within(createBatchForm).getByPlaceholderText('Cultivar · Crop Type · Species');
    const startedAtInput = within(createBatchForm).getByLabelText('Started at');
    const startMethodSelect = within(createBatchForm).getAllByRole('combobox')[1] as HTMLSelectElement;

    const cases = [
      {
        cultivarLabel: 'Romaine',
        startedAt: '2026-03-06T18:30',
        selectedMethod: 'pre_sow_paper_towel',
        expectedMethod: 'pre_sow_paper_towel',
        expectedStartMethod: 'pre_sow_paper_towel',
        sourceBatchId: migratedLettuceBatch?.batchId,
      },
      {
        cultivarLabel: 'Genoveser',
        startedAt: '2026-03-05T12:00',
        selectedMethod: 'pre_sow_indoor',
        expectedMethod: 'pre_sow_indoor',
        expectedStartMethod: 'pre_sow_indoor',
        sourceBatchId: migratedBasilBatch?.batchId,
      },
      {
        cultivarLabel: 'Romaine',
        startedAt: '2026-03-08T08:15',
        selectedMethod: 'direct_sow',
        expectedMethod: 'direct_sow',
        expectedStartMethod: 'direct_sow',
        sourceBatchId: 'synthetic-direct-sow-coverage',
      },
      {
        cultivarLabel: 'Genoveser',
        startedAt: '2026-03-09T09:45',
        selectedMethod: 'sow_indoor',
        expectedMethod: 'sow_indoor',
        expectedStartMethod: 'sow_indoor',
        sourceBatchId: 'synthetic-sow-indoor-coverage',
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      fireEvent.change(cultivarInput, { target: { value: testCase.cultivarLabel } });
      fireEvent.change(startedAtInput, { target: { value: testCase.startedAt } });
      fireEvent.change(startMethodSelect, { target: { value: testCase.selectedMethod } });
      fireEvent.click(within(createBatchForm).getByRole('button', { name: 'Create batch' }));

      await waitFor(() => {
        expect(saveAppStateToIndexedDb).toHaveBeenCalledTimes(index + 1);
      });

      const saveCalls = vi.mocked(saveAppStateToIndexedDb).mock.calls;
      const savedState = saveCalls[saveCalls.length - 1]?.[0] as { batches: Array<Record<string, unknown>> };
      const savedBatches = savedState.batches;
      const savedBatch = savedBatches[savedBatches.length - 1];

      expect(savedBatch).toMatchObject({
        startMethod: testCase.expectedStartMethod,
        stage: 'sowing',
        stageEvents: [
          {
            stage: 'sowing',
            method: testCase.expectedMethod,
          },
        ],
      });
      expect(savedBatch?.startedAt).toBe(new Date(testCase.startedAt).toISOString());
      expect(screen.getByText('Batch created.')).toBeInTheDocument();
      expect(testCase.sourceBatchId).toBeTruthy();
    }
  });

  it('renders deterministic vegan nutrition flags with non-prescriptive language', async () => {
    vi.mocked(loadAppStateFromIndexedDb).mockResolvedValue({
      schemaVersion: 1,
      beds: [],
      batches: [],
      tasks: [],
      seedInventoryItems: [],
      settings: {
        settingsId: 'settings-1',
        locale: 'en-DE',
        timezone: 'Europe/Berlin',
        units: { temperature: 'celsius', yield: 'metric' },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      crops: [],
      cropPlans: [],
    } as never);

    render(
      <MemoryRouter initialEntries={['/nutrition']}>
        <App />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Nutrition flags (B12, iodine)')).toBeInTheDocument();
    });

    const flagsSection = screen.getByText('Nutrition flags (B12, iodine)').closest('article');
    const flags = within(flagsSection as HTMLElement).getAllByRole('listitem');
    expect(flags).toHaveLength(2);
    expect(flags[0]).toHaveTextContent('Vitamin B12 coverage gap');
    expect(flags[1]).toHaveTextContent('Iodine planning check');

    expect(screen.getByText('Informational only, not medical advice.')).toBeInTheDocument();
    for (const flag of flags) {
      const text = flag.textContent?.toLowerCase() ?? '';
      expect(text).not.toContain('mg');
      expect(text).not.toContain('mcg');
      expect(text).not.toMatch(/\biu\b/);
      expect(text).not.toContain('dose');
      expect(text).not.toContain('dosage');
    }
  });
});
