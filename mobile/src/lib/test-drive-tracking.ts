import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert } from 'react-native';
import {
  bufferRoutePoints,
  clearCompletedRoute,
  markRoutePointsUploaded,
  pendingRoutePointsThrough,
} from './route-buffer';
import { supabase } from './supabase';

const taskName = 'active-test-drive-route';
const activeDriveKey = 'gdm.active-test-drive-v2';

type AnchorKind = 'start' | 'reached' | 'end';

type PendingAnchor = {
  kind: AnchorKind;
  latitude: number;
  longitude: number;
  recordedAt: string;
  odometer: number | null;
  expectedVersion: number;
  requestId: string;
};

export type TestDriveTrackingPhase =
  'STARTING' | 'ACTIVE' | 'REACHING' | 'ENDING' | 'ROUTE_PENDING' | 'FINALIZING';

export type TestDriveTrackingState = {
  schemaVersion: 2;
  testDriveId: string;
  version: number;
  phase: TestDriveTrackingPhase;
  destinationReached: boolean;
  pendingAnchor?: PendingAnchor;
  completedAt?: string;
  finalizeRequestId?: string;
};

const trackingPhases: TestDriveTrackingPhase[] = [
  'STARTING',
  'ACTIVE',
  'REACHING',
  'ENDING',
  'ROUTE_PENDING',
  'FINALIZING',
];

type EdgeEnvelope<T> = {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
};

type DriveMutationResult = {
  id: string;
  version: number;
  status: 'READY' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  replayed: boolean;
  route_summary_id?: string;
};

function createRequestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function isTrackingState(value: unknown): value is TestDriveTrackingState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<TestDriveTrackingState>;
  return (
    candidate.schemaVersion === 2 &&
    typeof candidate.testDriveId === 'string' &&
    /^[0-9a-f-]{36}$/i.test(candidate.testDriveId) &&
    typeof candidate.version === 'number' &&
    Number.isInteger(candidate.version) &&
    candidate.version > 0 &&
    trackingPhases.includes(candidate.phase as TestDriveTrackingPhase) &&
    typeof candidate.destinationReached === 'boolean'
  );
}

async function readTrackingState() {
  const stored = await AsyncStorage.getItem(activeDriveKey);
  if (!stored) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (isTrackingState(parsed)) return parsed;
  } catch {
    // A corrupt non-sensitive cache must fail closed and may be replaced safely.
  }
  await AsyncStorage.removeItem(activeDriveKey);
  return null;
}

async function writeTrackingState(state: TestDriveTrackingState) {
  await AsyncStorage.setItem(activeDriveKey, JSON.stringify(state));
  return state;
}

TaskManager.defineTask(taskName, async ({ data, error }) => {
  const state = await readTrackingState();
  if (error || !state || !['ACTIVE', 'REACHING', 'ENDING'].includes(state.phase)) return;
  const locations =
    (data as { locations?: Location.LocationObject[] } | undefined)?.locations ?? [];
  bufferRoutePoints(
    state.testDriveId,
    locations.map((location) => ({
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      accuracy: location.coords.accuracy,
      recordedAt: new Date(location.timestamp).toISOString(),
    })),
  );
});

async function invokeAnchor(testDriveId: string, anchor: PendingAnchor) {
  const { data, error } = await supabase.functions.invoke<
    EdgeEnvelope<{ test_drive: DriveMutationResult }>
  >('test-drive-anchor', {
    body: {
      test_drive_id: testDriveId,
      kind: anchor.kind,
      latitude: anchor.latitude,
      longitude: anchor.longitude,
      recorded_at: anchor.recordedAt,
      odometer: anchor.odometer ?? undefined,
      expected_version: anchor.expectedVersion,
      request_id: anchor.requestId,
    },
  });
  if (error || !data?.ok || !data.data?.test_drive)
    throw error ?? new Error(data?.error?.code ?? 'TEST_DRIVE_ANCHOR_FAILED');
  return data.data.test_drive;
}

async function ensureLocationUpdatesStarted() {
  if (await Location.hasStartedLocationUpdatesAsync(taskName)) return;
  if (!(await TaskManager.isAvailableAsync())) throw new Error('BACKGROUND_LOCATION_UNAVAILABLE');
  await Location.startLocationUpdatesAsync(taskName, {
    accuracy: Location.Accuracy.Balanced,
    distanceInterval: 25,
    timeInterval: 15_000,
    pausesUpdatesAutomatically: false,
    foregroundService: {
      notificationTitle: 'Test drive in progress',
      notificationBody: 'Go Digital CRM is recording this active test-drive route.',
    },
  });
}

async function stopLocationUpdates() {
  if (await Location.hasStartedLocationUpdatesAsync(taskName))
    await Location.stopLocationUpdatesAsync(taskName);
}

async function requestTrackingPermissions() {
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (foreground.status !== 'granted') throw new Error('LOCATION_PERMISSION_REQUIRED');
  const existingBackground = await Location.getBackgroundPermissionsAsync();
  if (existingBackground.status === 'granted') return;
  const shouldContinue = await new Promise<boolean>((resolve) => {
    Alert.alert(
      'Allow route recording',
      'Background location records only an active test-drive route. Your phone may open system settings to grant “Allow all the time”.',
      [
        { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Continue', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
  if (!shouldContinue) throw new Error('LOCATION_PERMISSION_REQUIRED');
  const background = await Location.requestBackgroundPermissionsAsync();
  if (background.status !== 'granted') throw new Error('LOCATION_PERMISSION_REQUIRED');
}

function anchorFromLocation(
  kind: AnchorKind,
  location: Location.LocationObject,
  expectedVersion: number,
  odometer: number | null,
): PendingAnchor {
  return {
    kind,
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    recordedAt: new Date(location.timestamp).toISOString(),
    odometer,
    expectedVersion,
    requestId: createRequestId(),
  };
}

async function finalizePersistedRoute(state: TestDriveTrackingState) {
  if (!state.completedAt) throw new Error('TEST_DRIVE_END_ANCHOR_MISSING');
  await stopLocationUpdates();
  const points = pendingRoutePointsThrough(state.testDriveId, state.completedAt).map((point) => ({
    sequenceNo: point.sequenceNo,
    latitude: point.latitude,
    longitude: point.longitude,
    recordedAt: point.recordedAt,
  }));
  const finalizing = await writeTrackingState({
    ...state,
    phase: 'FINALIZING',
    finalizeRequestId: state.finalizeRequestId ?? createRequestId(),
  });
  const { data, error } = await supabase.functions.invoke<
    EdgeEnvelope<{ test_drive: DriveMutationResult }>
  >('test-drive-complete', {
    body: {
      test_drive_id: finalizing.testDriveId,
      points,
      expected_version: finalizing.version,
      request_id: finalizing.finalizeRequestId,
    },
  });
  if (error || !data?.ok || !data.data?.test_drive)
    throw error ?? new Error(data?.error?.code ?? 'TEST_DRIVE_ROUTE_FINALIZATION_FAILED');
  if (points.length) markRoutePointsUploaded(state.testDriveId, points.at(-1)!.sequenceNo);
  clearCompletedRoute(state.testDriveId);
  await AsyncStorage.removeItem(activeDriveKey);
  return data.data.test_drive;
}

async function completePendingAnchor(state: TestDriveTrackingState) {
  if (!state.pendingAnchor) throw new Error('TEST_DRIVE_PENDING_ANCHOR_MISSING');
  const result = await invokeAnchor(state.testDriveId, state.pendingAnchor);
  if (state.pendingAnchor.kind === 'end') {
    const routePending = await writeTrackingState({
      ...state,
      version: result.version,
      phase: 'ROUTE_PENDING',
      completedAt: state.pendingAnchor.recordedAt,
      pendingAnchor: undefined,
    });
    return finalizePersistedRoute(routePending);
  }
  const active = await writeTrackingState({
    ...state,
    version: result.version,
    phase: 'ACTIVE',
    destinationReached: state.pendingAnchor.kind === 'reached' || state.destinationReached,
    pendingAnchor: undefined,
  });
  await ensureLocationUpdatesStarted();
  return { ...result, trackingState: active };
}

export async function getTestDriveTrackingState() {
  return readTrackingState();
}

export async function startTestDriveTracking(
  testDriveId: string,
  expectedVersion: number,
  odometer: number,
) {
  const existing = await readTrackingState();
  if (existing && existing.testDriveId !== testDriveId)
    throw new Error('ANOTHER_TEST_DRIVE_IS_ACTIVE');
  if (existing) return resumeTestDriveTracking();
  await requestTrackingPermissions();
  const start = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  const state = await writeTrackingState({
    schemaVersion: 2,
    testDriveId,
    version: expectedVersion,
    phase: 'STARTING',
    destinationReached: false,
    pendingAnchor: anchorFromLocation('start', start, expectedVersion, odometer),
  });
  return completePendingAnchor(state);
}

export async function attachActiveTestDriveTracking(testDriveId: string, expectedVersion: number) {
  const existing = await readTrackingState();
  if (existing && existing.testDriveId !== testDriveId)
    throw new Error('ANOTHER_TEST_DRIVE_IS_ACTIVE');
  if (existing) return resumeTestDriveTracking();
  await requestTrackingPermissions();
  const state = await writeTrackingState({
    schemaVersion: 2,
    testDriveId,
    version: expectedVersion,
    phase: 'ACTIVE',
    destinationReached: false,
  });
  await ensureLocationUpdatesStarted();
  return state;
}

export async function markDestinationReached(testDriveId: string) {
  const current = await readTrackingState();
  if (!current || current.testDriveId !== testDriveId)
    throw new Error('TEST_DRIVE_TRACKING_NOT_ACTIVE');
  if (current.destinationReached) return current;
  if (current.phase !== 'ACTIVE') return resumeTestDriveTracking();
  const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  const reaching = await writeTrackingState({
    ...current,
    phase: 'REACHING',
    pendingAnchor: anchorFromLocation('reached', location, current.version, null),
  });
  return completePendingAnchor(reaching);
}

export async function stopTestDriveTracking(testDriveId: string, odometer: number) {
  const current = await readTrackingState();
  if (!current || current.testDriveId !== testDriveId)
    throw new Error('TEST_DRIVE_TRACKING_NOT_ACTIVE');
  if (current.phase !== 'ACTIVE') return resumeTestDriveTracking();
  const end = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  const ending = await writeTrackingState({
    ...current,
    phase: 'ENDING',
    pendingAnchor: anchorFromLocation('end', end, current.version, odometer),
  });
  return completePendingAnchor(ending);
}

export async function resumeTestDriveTracking() {
  const state = await readTrackingState();
  if (!state) return null;
  if (state.pendingAnchor) return completePendingAnchor(state);
  if (state.phase === 'ROUTE_PENDING' || state.phase === 'FINALIZING')
    return finalizePersistedRoute(state);
  await requestTrackingPermissions();
  await ensureLocationUpdatesStarted();
  return state;
}
