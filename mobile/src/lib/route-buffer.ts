import * as SQLite from 'expo-sqlite';

export type RoutePoint = {
  sequenceNo: number;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  recordedAt: string;
};

export const maximumBufferedRoutePoints = 2000;

const database = SQLite.openDatabaseSync('test-drive-route.db');

export function initializeRouteBuffer() {
  database.execSync(
    `create table if not exists route_points (test_drive_id text not null, sequence_no integer not null, latitude real not null, longitude real not null, accuracy real, recorded_at text not null, uploaded_at text, primary key (test_drive_id, sequence_no));`,
  );
}

export function bufferRoutePoint(testDriveId: string, point: RoutePoint) {
  database.runSync(
    'insert or replace into route_points (test_drive_id, sequence_no, latitude, longitude, accuracy, recorded_at) values (?, ?, ?, ?, ?, ?)',
    [
      testDriveId,
      point.sequenceNo,
      point.latitude,
      point.longitude,
      point.accuracy,
      point.recordedAt,
    ],
  );
}

export function bufferRoutePoints(
  testDriveId: string,
  points: Array<Omit<RoutePoint, 'sequenceNo'>>,
) {
  if (points.length === 0) return;

  database.withTransactionSync(() => {
    const current = database.getFirstSync<{ highestSequence: number | null }>(
      'select max(sequence_no) as highestSequence from route_points where test_drive_id = ?',
      [testDriveId],
    );
    const highestSequence = current?.highestSequence ?? 0;
    const remainingCapacity = Math.max(0, maximumBufferedRoutePoints - highestSequence);

    points.slice(0, remainingCapacity).forEach((point, offset) => {
      bufferRoutePoint(testDriveId, {
        ...point,
        sequenceNo: highestSequence + offset + 1,
      });
    });
  });
}

export function pendingRoutePoints(testDriveId: string) {
  return database.getAllSync<RoutePoint>(
    'select sequence_no as sequenceNo, latitude, longitude, accuracy, recorded_at as recordedAt from route_points where test_drive_id = ? and uploaded_at is null order by sequence_no',
    [testDriveId],
  );
}

export function pendingRoutePointsThrough(testDriveId: string, recordedThrough: string) {
  return database.getAllSync<RoutePoint>(
    'select sequence_no as sequenceNo, latitude, longitude, accuracy, recorded_at as recordedAt from route_points where test_drive_id = ? and uploaded_at is null and recorded_at <= ? order by sequence_no',
    [testDriveId, recordedThrough],
  );
}

export function markRoutePointsUploaded(testDriveId: string, throughSequence: number) {
  database.runSync(
    'update route_points set uploaded_at = ? where test_drive_id = ? and sequence_no <= ?',
    [new Date().toISOString(), testDriveId, throughSequence],
  );
}

export function clearCompletedRoute(testDriveId: string) {
  database.runSync('delete from route_points where test_drive_id = ?', [testDriveId]);
}
