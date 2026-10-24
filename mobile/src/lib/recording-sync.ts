import AsyncStorage from '@react-native-async-storage/async-storage';
import * as BackgroundTask from 'expo-background-task';
import * as Crypto from 'expo-crypto';
import { Directory, File } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library/legacy';
import * as SQLite from 'expo-sqlite';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import {
  callRecordingExtension,
  isCallRecordingFile,
  normalizeRecordedPhone,
  parseCallRecordingFileName,
  uploadableCallRecordingExtensions,
} from '@/lib/call-recording-filename';
import { sha256Digest, uploadCallRecordingFile } from '@/lib/calls';
import { supabase } from '@/lib/supabase';

// Phone call recordings -> CRM calls.
//
// The user picks the folder their phone's call recorder writes to (Android
// Storage Access Framework, a persistable grant). Each new audio file is
// logged once: log_recorded_phone_call files it on the lead with that number
// (or as a call with no lead), then the audio is uploaded to the call. A local
// SQLite ledger remembers every file so nothing is sent twice; the server's
// SHA-256 key makes a repeat harmless anyway. Sync runs when the app opens or
// returns to the foreground, from the Recordings screen, and as a best-effort
// background task (Android runs it at most every 15 minutes, when it chooses).

export type RecordingStatus =
  'PENDING' | 'NEEDS_NUMBER' | 'SYNCED' | 'FAILED' | 'UNSUPPORTED' | 'OLDER';

export type RecordingRow = {
  uri: string;
  name: string;
  size: number;
  modifiedAt: number;
  source: 'FOLDER' | 'PICKED';
  phone: string | null;
  startedAt: number | null;
  direction: 'INBOUND' | 'OUTBOUND' | null;
  contactName: string | null;
  status: RecordingStatus;
  callId: string | null;
  leadId: string | null;
  customerName: string | null;
  matched: boolean;
  error: string | null;
  attempts: number;
  updatedAt: number;
};

export type RecordingFolder = { uri: string; name: string; grantedAt: number; userId?: string };

export type SyncSummary = { synced: number; failed: number; remaining: number };

const folderKey = 'recording-sync.folder';
const lastRunKey = 'recording-sync.last-run';
const autoSyncKey = 'recording-sync.auto-sync';
const folderOfferKey = 'recording-sync.folder-offered';
export const recordingSyncTaskName = 'call-recording-sync';
const filesPerRun = 5;
const maximumAttempts = 5;

const database = SQLite.openDatabaseSync('call-recordings.db');

export function initializeRecordingLedger() {
  database.execSync(
    `create table if not exists recordings (
      user_id text not null, uri text not null, name text not null, size integer not null,
      modified_at integer not null, source text not null, phone text, started_at integer,
      direction text, contact_name text, status text not null, call_id text, lead_id text,
      customer_name text, matched integer not null default 0, error text,
      attempts integer not null default 0, updated_at integer not null,
      primary key (user_id, uri)
    );
    create index if not exists recordings_status_idx on recordings (user_id, status, modified_at);`,
  );
}

type LedgerRecord = {
  uri: string;
  name: string;
  size: number;
  modified_at: number;
  source: 'FOLDER' | 'PICKED';
  phone: string | null;
  started_at: number | null;
  direction: 'INBOUND' | 'OUTBOUND' | null;
  contact_name: string | null;
  status: RecordingStatus;
  call_id: string | null;
  lead_id: string | null;
  customer_name: string | null;
  matched: number;
  error: string | null;
  attempts: number;
  updated_at: number;
};

function toRow(record: LedgerRecord): RecordingRow {
  return {
    uri: record.uri,
    name: record.name,
    size: record.size,
    modifiedAt: record.modified_at,
    source: record.source,
    phone: record.phone,
    startedAt: record.started_at,
    direction: record.direction,
    contactName: record.contact_name,
    status: record.status,
    callId: record.call_id,
    leadId: record.lead_id,
    customerName: record.customer_name,
    matched: record.matched === 1,
    error: record.error,
    attempts: record.attempts,
    updatedAt: record.updated_at,
  };
}

export function listRecordings(userId: string, limit = 100) {
  return database
    .getAllSync<LedgerRecord>(
      'select * from recordings where user_id = ? order by modified_at desc limit ?',
      [userId, limit],
    )
    .map(toRow);
}

export function recordingCounts(userId: string) {
  const rows = database.getAllSync<{ status: RecordingStatus; n: number }>(
    'select status, count(*) as n from recordings where user_id = ? group by status',
    [userId],
  );
  return Object.fromEntries(rows.map((row) => [row.status, row.n])) as Partial<
    Record<RecordingStatus, number>
  >;
}

async function currentUserId() {
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}

// The folder belongs to the user who chose it. On a phone that changes hands,
// the next user picks it again, so their own grant time decides which files
// are older and another user's calls are never filed under them. A folder
// saved before folders had an owner goes to whoever is signed in.
export async function getRecordingFolder(): Promise<RecordingFolder | null> {
  try {
    const value = await AsyncStorage.getItem(folderKey);
    if (!value) return null;
    const folder = JSON.parse(value) as RecordingFolder;
    const userId = await currentUserId();
    if (!userId) return null;
    if (!folder.userId) {
      const owned = { ...folder, userId };
      await AsyncStorage.setItem(folderKey, JSON.stringify(owned));
      return owned;
    }
    return folder.userId === userId ? folder : null;
  } catch {
    return null;
  }
}

// Per user, like the ledger: another account's run says nothing about yours.
export async function getLastRecordingSync() {
  const userId = await currentUserId();
  if (!userId) return null;
  const value = await AsyncStorage.getItem(`${lastRunKey}.${userId}`);
  return value ? Number(value) : null;
}

// Cached copy of the server-side auto_sync preference, so the background task
// can decide without a network round trip.
export async function setCachedAutoSync(enabled: boolean) {
  await AsyncStorage.setItem(autoSyncKey, enabled ? '1' : '0');
  await (enabled ? registerRecordingSyncTask() : unregisterRecordingSyncTask());
}

export async function getCachedAutoSync() {
  return (await AsyncStorage.getItem(autoSyncKey)) !== '0';
}

export function recordingFolderSupported() {
  return Platform.OS === 'android';
}

// `initialUri` opens the picker at a folder found by findRecorderFolder, so
// granting it is one tap instead of browsing the phone's storage.
export async function chooseRecordingFolder(initialUri?: string): Promise<RecordingFolder | null> {
  const previous = await getRecordingFolder();
  let directory: Directory;
  try {
    directory = await Directory.pickDirectoryAsync(previous?.uri ?? initialUri);
  } catch (error) {
    if (String(error).toLowerCase().includes('cancel')) return previous;
    throw error;
  }
  const folder: RecordingFolder = {
    uri: directory.uri,
    name: decodeURIComponent(directory.name || directory.uri.split(/%3A|\//).at(-1) || 'Folder'),
    // Only calls recorded from now on are picked up automatically; older
    // recordings wait in "Older" until the user asks for them.
    grantedAt: previous?.uri === directory.uri ? previous.grantedAt : Date.now(),
    userId: (await currentUserId()) ?? undefined,
  };
  await AsyncStorage.setItem(folderKey, JSON.stringify(folder));
  await registerRecordingSyncTask();
  return folder;
}

export type RecorderFolderGuess = { initialUri: string; label: string };

// MediaStore paths look like /storage/emulated/0/Recordings/Call/x.mp3; the
// picker opens at the matching document of the primary storage volume.
export function recorderFolderFromPath(fileUri: string): RecorderFolderGuess | null {
  const path = decodeURIComponent(fileUri.replace(/^file:\/\//, ''));
  const match = path.match(/^\/storage\/emulated\/0\/(.+)\/[^/]+$/);
  if (!match) return null;
  return {
    initialUri: `content://com.android.externalstorage.documents/document/primary%3A${encodeURIComponent(match[1])}`,
    label: match[1],
  };
}

/**
 * After the first call with no folder chosen, looks for the recording the
 * dialer just wrote: audio added since the call started, preferring a file
 * whose name carries the number. Asked once per install; reading audio needs
 * the media permission, and a refusal is final for this offer.
 */
export async function findRecorderFolder(
  callStartedAt: number,
  phone: string,
): Promise<RecorderFolderGuess | 'NOT_FOUND' | null> {
  if (!recordingFolderSupported() || (await getRecordingFolder())) return null;
  if (await AsyncStorage.getItem(folderOfferKey)) return null;
  await AsyncStorage.setItem(folderOfferKey, String(Date.now()));
  const permission = await MediaLibrary.requestPermissionsAsync(false, ['audio']);
  if (!permission.granted) return null;
  const digits = phone.replace(/\D/g, '').slice(-10);
  const page = await MediaLibrary.getAssetsAsync({
    mediaType: MediaLibrary.MediaType.audio,
    createdAfter: callStartedAt - 60_000,
    sortBy: [[MediaLibrary.SortBy.creationTime, false]],
    first: 20,
  });
  const candidates = page.assets.filter((asset) => isCallRecordingFile(asset.filename));
  const asset =
    candidates.find((item) => digits && item.filename.replace(/\D/g, '').includes(digits)) ??
    candidates[0];
  return (asset && recorderFolderFromPath(asset.uri)) || 'NOT_FOUND';
}

export async function forgetRecordingFolder() {
  await AsyncStorage.removeItem(folderKey);
  await unregisterRecordingSyncTask();
}

function fileModifiedAt(file: File) {
  return file.modificationTime ?? file.lastModified ?? Date.now();
}

function listAudioFiles(directory: Directory, depth = 0): File[] {
  const files: File[] = [];
  for (const entry of directory.list()) {
    if (entry instanceof File) {
      if (isCallRecordingFile(entry.name)) files.push(entry);
    } else if (depth < 1) {
      files.push(...listAudioFiles(entry, depth + 1));
    }
  }
  return files;
}

function initialStatus(name: string, phone: string | null, older: boolean): RecordingStatus {
  if (!uploadableCallRecordingExtensions.has(callRecordingExtension(name))) return 'UNSUPPORTED';
  if (older) return 'OLDER';
  return phone ? 'PENDING' : 'NEEDS_NUMBER';
}

function insertRecording(
  userId: string,
  input: {
    uri: string;
    name: string;
    size: number;
    modifiedAt: number;
    source: 'FOLDER' | 'PICKED';
    older: boolean;
  },
) {
  const parsed = parseCallRecordingFileName(input.name);
  const result = database.runSync(
    `insert or ignore into recordings (
      user_id, uri, name, size, modified_at, source, phone, started_at, direction,
      contact_name, status, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      input.uri,
      input.name,
      input.size,
      input.modifiedAt,
      input.source,
      parsed.phone,
      parsed.startedAt?.getTime() ?? null,
      parsed.direction,
      parsed.contactName,
      initialStatus(input.name, parsed.phone, input.older),
      Date.now(),
    ],
  );
  return result.changes > 0;
}

// Adds the folder's new files to the ledger. Reading a directory listing is
// cheap; file contents are only read when a file is synced.
export async function scanRecordingFolder(userId: string) {
  const folder = await getRecordingFolder();
  if (!folder) return 0;
  const directory = new Directory(folder.uri);
  const files = listAudioFiles(directory);
  // A file deleted from the folder before it synced has nothing left to send;
  // synced rows stay because they are the call's history.
  const present = new Set(files.map((file) => file.uri));
  const unsynced = database.getAllSync<{ uri: string }>(
    `select uri from recordings where user_id = ? and source = 'FOLDER' and status <> 'SYNCED'`,
    [userId],
  );
  for (const row of unsynced) {
    if (!present.has(row.uri))
      database.runSync('delete from recordings where user_id = ? and uri = ?', [userId, row.uri]);
  }
  let added = 0;
  for (const file of files) {
    const modifiedAt = fileModifiedAt(file);
    if (
      insertRecording(userId, {
        uri: file.uri,
        name: file.name,
        size: file.size ?? 0,
        modifiedAt,
        source: 'FOLDER',
        older: modifiedAt < folder.grantedAt,
      })
    )
      added += 1;
  }
  return added;
}

export function addPickedRecordings(
  userId: string,
  assets: Array<{ uri: string; name: string; size?: number | null }>,
) {
  for (const asset of assets) {
    insertRecording(userId, {
      uri: asset.uri,
      name: asset.name,
      size: asset.size ?? 0,
      modifiedAt: Date.now(),
      source: 'PICKED',
      older: false,
    });
  }
}

// A lead created from a synced call: the list then shows the customer instead
// of "no lead yet".
export function markRecordingLead(callId: string, leadId: string, customerName: string) {
  database.runSync(
    `update recordings set lead_id = ?, customer_name = ?, matched = 1, updated_at = ?
       where call_id = ?`,
    [leadId, customerName, Date.now(), callId],
  );
}

export function setRecordingDetails(
  userId: string,
  uri: string,
  input: { phone: string; direction: 'INBOUND' | 'OUTBOUND'; startedAt?: number | null },
) {
  const phone = normalizeRecordedPhone(input.phone);
  if (!phone) throw new Error('RECORDED_CALL_PHONE_INVALID');
  database.runSync(
    `update recordings set phone = ?, direction = ?, started_at = coalesce(?, started_at),
       status = 'PENDING', error = null, attempts = 0, updated_at = ?
     where user_id = ? and uri = ? and status in ('NEEDS_NUMBER', 'FAILED', 'PENDING', 'OLDER')`,
    [phone, input.direction, input.startedAt ?? null, Date.now(), userId, uri],
  );
}

export function includeOlderRecordings(userId: string) {
  database.runSync(
    `update recordings set status = case when phone is null then 'NEEDS_NUMBER' else 'PENDING' end,
       updated_at = ? where user_id = ? and status = 'OLDER'`,
    [Date.now(), userId],
  );
}

export function retryRecording(userId: string, uri: string) {
  database.runSync(
    `update recordings set status = case when phone is null then 'NEEDS_NUMBER' else 'PENDING' end,
       error = null, attempts = 0, updated_at = ? where user_id = ? and uri = ? and status = 'FAILED'`,
    [Date.now(), userId, uri],
  );
}

function errorCode(error: unknown) {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error ?? 'SYNC_FAILED');
  return message.match(/[A-Z][A-Z0-9_]{5,}/)?.[0] ?? message.slice(0, 120);
}

type SyncedCall = {
  call_id: string;
  organization_id: string;
  branch_id: string;
  lead_id: string | null;
  customer_name: string | null;
  matched: boolean;
  duplicate: boolean;
  has_recording: boolean;
};

async function syncOne(userId: string, record: LedgerRecord) {
  const file = new File(record.uri);
  if (!file.exists) throw new Error('RECORDING_FILE_MISSING');
  const digest = await sha256Digest(file);
  const startedAt = record.started_at ?? record.modified_at;
  const logged = await supabase.rpc('log_recorded_phone_call', {
    target_phone: record.phone,
    target_direction: record.direction ?? 'OUTBOUND',
    // The server refuses times in the future; a phone clock a little ahead of
    // the server's is not the user's fault.
    target_started_at: new Date(Math.min(startedAt, Date.now())).toISOString(),
    target_duration_seconds: null,
    target_sync_key: digest.hex,
    target_file_name: record.name,
  });
  if (logged.error || !logged.data) throw logged.error ?? new Error('RECORDING_SYNC_FAILED');
  const call = logged.data as SyncedCall;
  if (!call.has_recording) {
    await uploadCallRecordingFile({
      callId: call.call_id,
      organizationId: call.organization_id,
      branchId: call.branch_id,
      uri: record.uri,
      name: record.name,
      mimeType: file.type || null,
      checksumBase64: digest.base64,
      requestId: Crypto.randomUUID(),
    });
  }
  database.runSync(
    `update recordings set status = 'SYNCED', call_id = ?, lead_id = ?, customer_name = ?,
       matched = ?, error = null, updated_at = ? where user_id = ? and uri = ?`,
    [
      call.call_id,
      call.lead_id,
      call.customer_name,
      call.matched ? 1 : 0,
      Date.now(),
      userId,
      record.uri,
    ],
  );
}

let running: Promise<SyncSummary> | null = null;
const finishedListeners = new Set<(summary?: SyncSummary) => void>();

// Lets an open screen redraw after a run it did not start (app open, return
// to the foreground, the background task). The summary is missing when the run
// failed. Returns the unsubscribe function.
export function onRecordingSyncFinished(listener: (summary?: SyncSummary) => void) {
  finishedListeners.add(listener);
  return () => {
    finishedListeners.delete(listener);
  };
}

// Scans the folder and syncs up to five waiting files, one at a time. A run
// already in progress is shared rather than started twice.
export function syncRecordings(options: { userId?: string; scan?: boolean } = {}) {
  if (running) return running;
  running = (async () => {
    const userId = options.userId ?? (await currentUserId());
    if (!userId) return { synced: 0, failed: 0, remaining: 0 };
    initializeRecordingLedger();
    if (options.scan !== false) {
      try {
        await scanRecordingFolder(userId);
      } catch {
        // The grant was revoked or the folder removed; files already in the
        // ledger can still be sent.
      }
    }
    const waiting = database.getAllSync<LedgerRecord>(
      `select * from recordings where user_id = ? and status in ('PENDING', 'FAILED')
         and attempts < ? and phone is not null
       order by modified_at desc limit ?`,
      [userId, maximumAttempts, filesPerRun],
    );
    let synced = 0;
    let failed = 0;
    for (const record of waiting) {
      try {
        await syncOne(userId, record);
        synced += 1;
      } catch (error) {
        failed += 1;
        database.runSync(
          `update recordings set status = 'FAILED', error = ?, attempts = attempts + 1,
             updated_at = ? where user_id = ? and uri = ?`,
          [errorCode(error), Date.now(), userId, record.uri],
        );
      }
    }
    const remaining =
      database.getFirstSync<{ n: number }>(
        `select count(*) as n from recordings where user_id = ? and status = 'PENDING'`,
        [userId],
      )?.n ?? 0;
    await AsyncStorage.setItem(`${lastRunKey}.${userId}`, String(Date.now()));
    return { synced, failed, remaining };
  })().finally(() => {
    running = null;
  });
  const run = running;
  void run.then(
    (summary) => finishedListeners.forEach((listener) => listener(summary)),
    () => finishedListeners.forEach((listener) => listener()),
  );
  return run;
}

// Foreground trigger: app start and every return to the foreground.
export async function autoSyncRecordings() {
  if (!recordingFolderSupported()) return null;
  if (!(await getRecordingFolder()) || !(await getCachedAutoSync())) return null;
  return syncRecordings();
}

TaskManager.defineTask(recordingSyncTaskName, async () => {
  try {
    await autoSyncRecordings();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerRecordingSyncTask() {
  if (!recordingFolderSupported()) return;
  try {
    if ((await BackgroundTask.getStatusAsync()) !== BackgroundTask.BackgroundTaskStatus.Available)
      return;
    if (await TaskManager.isTaskRegisteredAsync(recordingSyncTaskName)) return;
    await BackgroundTask.registerTaskAsync(recordingSyncTaskName, { minimumInterval: 15 });
  } catch {
    // Background work is best effort; the foreground trigger still syncs.
  }
}

export async function unregisterRecordingSyncTask() {
  try {
    if (await TaskManager.isTaskRegisteredAsync(recordingSyncTaskName))
      await BackgroundTask.unregisterTaskAsync(recordingSyncTaskName);
  } catch {
    // Nothing registered.
  }
}
