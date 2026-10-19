// Sarvam batch speech-to-text: https://docs.sarvam.ai/api-reference/speech-to-text/stt/job
//
// The short REST endpoint stops at 30 seconds of audio, so call recordings go
// through the batch job API: create, upload, start, poll, download. Speaker
// separation is on, so turns come from the audio rather than an LLM guess.
// Errors leave as fixed codes only; provider bodies are never surfaced.

const jobBase = 'https://api.sarvam.ai/speech-to-text/job/v1';

type FetchLike = typeof fetch;

export type SarvamAudio = {
  body: ReadableStream<Uint8Array> | Uint8Array;
  sizeBytes: number;
  fileName: string;
  mimeType: string;
};

export type SarvamTurn = {
  speakerId: string;
  text: string;
  start: number | null;
  end: number | null;
};

export type SarvamResult = {
  transcript: string;
  languageCode: string | null;
  turns: SarvamTurn[];
  durationSeconds: number | null;
};

export type SarvamJobStatus =
  { state: 'RUNNING' } | { state: 'COMPLETED'; outputFile: string } | { state: 'FAILED' };

function failureCode(status: number) {
  if (status === 401 || status === 403) return 'SARVAM_AUTH_FAILED';
  if (status === 429) return 'SARVAM_RATE_LIMITED';
  if (status >= 500) return 'SARVAM_UNAVAILABLE';
  return 'SARVAM_REQUEST_FAILED';
}

async function sarvamJson(
  fetchImpl: FetchLike,
  apiKey: string,
  url: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
) {
  const response = await fetchImpl(url, {
    method: init.method,
    headers: {
      'api-subscription-key': apiKey,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(failureCode(response.status));
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!payload || typeof payload !== 'object') throw new Error('SARVAM_MALFORMED_RESPONSE');
  return payload;
}

function signedUrl(map: unknown, fileName: string) {
  const entry =
    map && typeof map === 'object' ? (map as Record<string, unknown>)[fileName] : undefined;
  const url =
    entry && typeof entry === 'object' ? (entry as { file_url?: unknown }).file_url : undefined;
  if (typeof url !== 'string' || !/^https:\/\//.test(url))
    throw new Error('SARVAM_MALFORMED_RESPONSE');
  return url;
}

/** Creates the job, uploads the recording and starts it. Returns Sarvam's job id. */
export async function submitSarvamJob(input: {
  apiKey: string;
  model: string;
  audio: SarvamAudio;
  fetchImpl?: FetchLike;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const created = await sarvamJson(fetchImpl, input.apiKey, jobBase, {
    method: 'POST',
    body: {
      job_parameters: {
        model: input.model,
        mode: 'transcribe',
        language_code: 'unknown',
        with_diarization: true,
        num_speakers: 2,
      },
    },
  });
  const jobId = created.job_id;
  if (typeof jobId !== 'string' || !jobId) throw new Error('SARVAM_MALFORMED_RESPONSE');

  const upload = await sarvamJson(fetchImpl, input.apiKey, `${jobBase}/upload-files`, {
    method: 'POST',
    body: { job_id: jobId, files: [input.audio.fileName] },
  });
  const uploadUrl = signedUrl(upload.upload_urls, input.audio.fileName);
  const azure = String(upload.storage_container_type ?? '').startsWith('Azure');
  const put = await fetchImpl(uploadUrl, {
    method: 'PUT',
    headers: {
      'content-type': input.audio.mimeType,
      'content-length': String(input.audio.sizeBytes),
      ...(azure ? { 'x-ms-blob-type': 'BlockBlob' } : {}),
    },
    body: input.audio.body,
    // A stream body must be sent half-duplex; the recording is never buffered.
    ...(input.audio.body instanceof Uint8Array ? {} : { duplex: 'half' }),
    signal: AbortSignal.timeout(10 * 60_000),
  } as RequestInit);
  if (!put.ok) throw new Error('SARVAM_UPLOAD_FAILED');

  await sarvamJson(fetchImpl, input.apiKey, `${jobBase}/${encodeURIComponent(jobId)}/start`, {
    method: 'POST',
  });
  return jobId;
}

export async function getSarvamJobStatus(input: {
  apiKey: string;
  jobId: string;
  fetchImpl?: FetchLike;
}): Promise<SarvamJobStatus> {
  const status = await sarvamJson(
    input.fetchImpl ?? fetch,
    input.apiKey,
    `${jobBase}/${encodeURIComponent(input.jobId)}/status`,
    { method: 'GET' },
  );
  const state = status.job_state;
  if (state === 'Accepted' || state === 'Pending' || state === 'Running')
    return { state: 'RUNNING' };
  if (state !== 'Completed' && state !== 'PartiallyCompleted') return { state: 'FAILED' };
  const details = Array.isArray(status.job_details) ? status.job_details : [];
  for (const detail of details) {
    if (!detail || typeof detail !== 'object') continue;
    const task = detail as { state?: unknown; outputs?: unknown };
    if (task.state !== 'Success' || !Array.isArray(task.outputs)) continue;
    const output = task.outputs.find(
      (file): file is { file_name: string } =>
        Boolean(file) && typeof (file as { file_name?: unknown }).file_name === 'string',
    );
    if (output) return { state: 'COMPLETED', outputFile: output.file_name };
  }
  return { state: 'FAILED' };
}

function seconds(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseSarvamResult(payload: unknown): SarvamResult {
  if (!payload || typeof payload !== 'object') throw new Error('SARVAM_MALFORMED_RESULT');
  const record = payload as {
    transcript?: unknown;
    language_code?: unknown;
    diarized_transcript?: { entries?: unknown } | null;
    timestamps?: { end_time_seconds?: unknown } | null;
  };
  const entries = Array.isArray(record.diarized_transcript?.entries)
    ? record.diarized_transcript.entries
    : [];
  const turns = entries.flatMap((entry): SarvamTurn[] => {
    if (!entry || typeof entry !== 'object') return [];
    const value = entry as Record<string, unknown>;
    const text = typeof value.transcript === 'string' ? value.transcript.trim() : '';
    if (!text) return [];
    return [
      {
        speakerId: String(value.speaker_id ?? 'unknown').slice(0, 20),
        text: text.slice(0, 12_000),
        start: seconds(value.start_time_seconds),
        end: seconds(value.end_time_seconds),
      },
    ];
  });
  const transcript =
    typeof record.transcript === 'string' && record.transcript.trim()
      ? record.transcript.trim()
      : turns.map((turn) => turn.text).join('\n');
  if (!transcript) throw new Error('SARVAM_EMPTY_TRANSCRIPT');
  const chunkEnds = Array.isArray(record.timestamps?.end_time_seconds)
    ? record.timestamps.end_time_seconds.map(seconds)
    : [];
  const ends = [...turns.map((turn) => turn.end), ...chunkEnds].filter(
    (value): value is number => value !== null,
  );
  return {
    transcript: transcript.slice(0, 1_000_000),
    languageCode:
      typeof record.language_code === 'string' && record.language_code.trim()
        ? record.language_code.trim().slice(0, 20)
        : null,
    turns: turns.length
      ? turns
      : [{ speakerId: 'unknown', text: transcript.slice(0, 12_000), start: null, end: null }],
    durationSeconds: ends.length ? Math.ceil(Math.max(...ends)) : null,
  };
}

export async function downloadSarvamResult(input: {
  apiKey: string;
  jobId: string;
  outputFile: string;
  fetchImpl?: FetchLike;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const download = await sarvamJson(fetchImpl, input.apiKey, `${jobBase}/download-files`, {
    method: 'POST',
    body: { job_id: input.jobId, files: [input.outputFile] },
  });
  const response = await fetchImpl(signedUrl(download.download_urls, input.outputFile), {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error('SARVAM_RESULT_DOWNLOAD_FAILED');
  return parseSarvamResult(await response.json().catch(() => null));
}
