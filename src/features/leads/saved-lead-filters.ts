import {
  leadStageFilters,
  leadTemperatureFilters,
  type LeadQuery,
  type LeadStageFilter,
  type LeadTemperatureFilter,
} from './lead-workspace-query';

export const MAX_SAVED_LEAD_FILTERS = 5;

export type SavedLeadFilterValues = Pick<
  LeadQuery,
  'search' | 'model' | 'source' | 'stage' | 'temperature' | 'followupFrom' | 'followupTo'
>;

export type SavedLeadFilter = {
  id: string;
  name: string;
  filters: SavedLeadFilterValues;
  createdAt: string;
};

type SavedLeadFilterStore = {
  key: string;
  filters: SavedLeadFilter[];
};

const databaseName = 'go-digital-marketing-crm';
const databaseVersion = 1;
const objectStoreName = 'lead-saved-filters';

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(databaseName, databaseVersion);
    request.onerror = () => reject(request.error ?? new Error('SAVED_FILTERS_STORAGE_UNAVAILABLE'));
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(objectStoreName)) {
        request.result.createObjectStore(objectStoreName, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function validFilterValues(value: unknown): SavedLeadFilterValues | null {
  if (!value || typeof value !== 'object') return null;
  const filters = value as Partial<SavedLeadFilterValues>;
  const text = (candidate: unknown, length: number) =>
    typeof candidate === 'string' ? candidate.trim().slice(0, length) : '';
  const stage = leadStageFilters.includes(filters.stage as LeadStageFilter)
    ? (filters.stage as LeadStageFilter)
    : 'all';
  const temperature = leadTemperatureFilters.includes(filters.temperature as LeadTemperatureFilter)
    ? (filters.temperature as LeadTemperatureFilter)
    : 'all';

  return {
    search: text(filters.search, 160),
    model: text(filters.model, 160),
    source: text(filters.source, 100),
    stage,
    temperature,
    followupFrom: text(filters.followupFrom, 10),
    followupTo: text(filters.followupTo, 10),
  };
}

function validSavedFilter(value: unknown): SavedLeadFilter | null {
  if (!value || typeof value !== 'object') return null;
  const filter = value as Partial<SavedLeadFilter>;
  if (
    typeof filter.id !== 'string' ||
    typeof filter.name !== 'string' ||
    typeof filter.createdAt !== 'string'
  )
    return null;
  const filters = validFilterValues(filter.filters);
  if (!filters) return null;
  const name = filter.name.trim().slice(0, 40);
  if (!name) return null;
  return { id: filter.id, name, filters, createdAt: filter.createdAt };
}

export function savedLeadFilterValues(query: LeadQuery): SavedLeadFilterValues {
  return {
    search: query.search,
    model: query.model,
    source: query.source,
    stage: query.stage,
    temperature: query.temperature,
    followupFrom: query.followupFrom,
    followupTo: query.followupTo,
  };
}

export function emptySavedLeadFilterValues(): SavedLeadFilterValues {
  return {
    search: '',
    model: '',
    source: '',
    stage: 'all',
    temperature: 'all',
    followupFrom: '',
    followupTo: '',
  };
}

export async function loadSavedLeadFilters(key: string): Promise<SavedLeadFilter[]> {
  const database = await openDatabase();
  try {
    return await new Promise<SavedLeadFilter[]>((resolve, reject) => {
      const request = database
        .transaction(objectStoreName, 'readonly')
        .objectStore(objectStoreName)
        .get(key);
      request.onerror = () => reject(request.error ?? new Error('SAVED_FILTERS_READ_FAILED'));
      request.onsuccess = () => {
        const stored = request.result as SavedLeadFilterStore | undefined;
        const filters = Array.isArray(stored?.filters)
          ? stored.filters
              .map(validSavedFilter)
              .filter((filter): filter is SavedLeadFilter => Boolean(filter))
          : [];
        resolve(filters.slice(0, MAX_SAVED_LEAD_FILTERS));
      };
    });
  } finally {
    database.close();
  }
}

export async function saveSavedLeadFilters(key: string, filters: SavedLeadFilter[]): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(objectStoreName, 'readwrite');
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('SAVED_FILTERS_WRITE_FAILED'));
      transaction.oncomplete = () => resolve();
      transaction.objectStore(objectStoreName).put({
        key,
        filters: filters.slice(0, MAX_SAVED_LEAD_FILTERS),
      } satisfies SavedLeadFilterStore);
    });
  } finally {
    database.close();
  }
}
