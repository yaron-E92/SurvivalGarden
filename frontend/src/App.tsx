import { useCallback, useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { AppStateStorageError, initializeAppStateStorage } from './data';

function BedsPage() {
  return <p>Beds</p>;
}

function CalendarPage() {
  return <p>Calendar</p>;
}

function BatchesPage() {
  return <p>Batches</p>;
}

function NutritionPage() {
  return <p>Nutrition</p>;
}

function DataPage() {
  return <p>Data</p>;
}

const STORAGE_DB_NAME = 'survival-garden';

const resetLocalData = async (): Promise<void> => {
  if (typeof indexedDB === 'undefined') {
    throw new AppStateStorageError('IndexedDB is not available in this environment.');
  }

  await new Promise<void>((resolve, reject) => {
    const deleteRequest = indexedDB.deleteDatabase(STORAGE_DB_NAME);

    deleteRequest.onsuccess = () => resolve();
    deleteRequest.onerror = () => reject(new AppStateStorageError('Failed to reset local data storage.'));
    deleteRequest.onblocked = () =>
      reject(new AppStateStorageError('Close other SurvivalGarden tabs and try reset again.'));
  });
};

function App() {
  const [storageError, setStorageError] = useState<string | null>(null);
  const [isInitializingStorage, setIsInitializingStorage] = useState(true);

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

  const handleReset = useCallback(async () => {
    setIsInitializingStorage(true);

    try {
      await resetLocalData();
      await initializeStorage();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to reset local data storage.';
      setStorageError(message);
      setIsInitializingStorage(false);
    }
  }, [initializeStorage]);

  if (isInitializingStorage) {
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
            Reset local data
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

      <main className="app-content">
        <Routes>
          <Route path="/" element={<Navigate to="/beds" replace />} />
          <Route path="/beds" element={<BedsPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/batches" element={<BatchesPage />} />
          <Route path="/nutrition" element={<NutritionPage />} />
          <Route path="/data" element={<DataPage />} />
          <Route path="*" element={<Navigate to="/beds" replace />} />
        </Routes>
      </main>

      <nav className="tab-nav" aria-label="Primary">
        <NavLink to="/beds">Beds</NavLink>
        <NavLink to="/calendar">Calendar</NavLink>
        <NavLink to="/batches">Batches</NavLink>
        <NavLink to="/nutrition">Nutrition</NavLink>
        <NavLink to="/data">Data</NavLink>
      </nav>
    </div>
  );
}

export default App;
