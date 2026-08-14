import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  bufferRoutePoint,
  clearCompletedRoute,
  markRoutePointsUploaded,
  pendingRoutePoints,
} from './route-buffer';
import { supabase } from './supabase';

const taskName = 'active-test-drive-route';
const activeDriveKey = 'gdm.active-test-drive-id';

TaskManager.defineTask(taskName, async ({ data, error }) => {
  const activeTestDriveId = await AsyncStorage.getItem(activeDriveKey);
  if (error || !activeTestDriveId) return;
  const locations =
    (data as { locations?: Location.LocationObject[] } | undefined)?.locations ?? [];
  const currentCount = pendingRoutePoints(activeTestDriveId).length;
  locations.forEach((location, offset) =>
    bufferRoutePoint(activeTestDriveId!, {
      sequenceNo: currentCount + offset + 1,
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      accuracy: location.coords.accuracy,
      recordedAt: new Date(location.timestamp).toISOString(),
    }),
  );
});

async function persistAnchor(
  testDriveId: string,
  kind: 'start' | 'reached' | 'end',
  location: Location.LocationObject,
  odometer?: number,
) {
  const { error } = await supabase.functions.invoke('test-drive-anchor', {
    body: {
      test_drive_id: testDriveId,
      kind,
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      recorded_at: new Date(location.timestamp).toISOString(),
      odometer,
    },
  });
  if (error) throw error;
}

export async function startTestDriveTracking(testDriveId: string, odometer: number) {
  const foreground = await Location.requestForegroundPermissionsAsync();
  const background = await Location.requestBackgroundPermissionsAsync();
  if (foreground.status !== 'granted' || background.status !== 'granted')
    throw new Error('LOCATION_PERMISSION_REQUIRED');
  const start = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  await persistAnchor(testDriveId, 'start', start, odometer);
  await AsyncStorage.setItem(activeDriveKey, testDriveId);
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

export async function markDestinationReached(testDriveId: string) {
  const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  await persistAnchor(testDriveId, 'reached', location);
}

export async function stopTestDriveTracking(testDriveId: string, odometer: number) {
  const end = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  await persistAnchor(testDriveId, 'end', end, odometer);
  if (await Location.hasStartedLocationUpdatesAsync(taskName))
    await Location.stopLocationUpdatesAsync(taskName);
  const points = pendingRoutePoints(testDriveId);
  const { error } = await supabase.functions.invoke('test-drive-complete', {
    body: { test_drive_id: testDriveId, points },
  });
  if (error) throw error;
  if (points.length) markRoutePointsUploaded(testDriveId, points[points.length - 1]!.sequenceNo);
  clearCompletedRoute(testDriveId);
  await AsyncStorage.removeItem(activeDriveKey);
}
