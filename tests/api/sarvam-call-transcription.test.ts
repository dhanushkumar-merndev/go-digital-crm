import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeCall,
  translateCallTurns,
  translationChunks,
} from '../../trigger/providers/groq-text';
import {
  downloadSarvamResult,
  getSarvamJobStatus,
  parseSarvamResult,
  submitSarvamJob,
} from '../../trigger/providers/sarvam-stt';

type Call = { url: string; init?: RequestInit };

function mockFetch(responses: Array<(call: Call) => Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${call.url}`);
    return next(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const audio = () => ({
  body: new Uint8Array([1, 2, 3]),
  sizeBytes: 3,
  fileName: 'call-1.m4a',
  mimeType: 'audio/mp4',
});

const groqReply = (content: unknown) =>
  json({ choices: [{ message: { content: JSON.stringify(content) } }] });

describe('Sarvam batch speech-to-text adapter', () => {
  it('creates a diarized job, uploads the recording to the signed URL and starts it', async () => {
    const { fetchImpl, calls } = mockFetch([
      json({ job_id: 'job-1', job_state: 'Accepted' }, 202),
      json({
        job_id: 'job-1',
        storage_container_type: 'Azure',
        upload_urls: { 'call-1.m4a': { file_url: 'https://blob.example/upload?sig=1' } },
      }),
      () => new Response(null, { status: 201 }),
      json({ job_id: 'job-1', job_state: 'Pending' }),
    ]);
    const jobId = await submitSarvamJob({
      apiKey: 'k',
      model: 'saaras:v3',
      audio: audio(),
      fetchImpl,
    });
    expect(jobId).toBe('job-1');
    expect(calls.map((call) => `${call.init?.method} ${call.url}`)).toEqual([
      'POST https://api.sarvam.ai/speech-to-text/job/v1',
      'POST https://api.sarvam.ai/speech-to-text/job/v1/upload-files',
      'PUT https://blob.example/upload?sig=1',
      'POST https://api.sarvam.ai/speech-to-text/job/v1/job-1/start',
    ]);
    const created = JSON.parse(String(calls[0].init?.body));
    expect(created.job_parameters).toMatchObject({
      model: 'saaras:v3',
      mode: 'transcribe',
      language_code: 'unknown',
      with_diarization: true,
      num_speakers: 2,
    });
    expect((calls[0].init?.headers as Record<string, string>)['api-subscription-key']).toBe('k');
    const putHeaders = calls[2].init?.headers as Record<string, string>;
    expect(putHeaders['x-ms-blob-type']).toBe('BlockBlob');
    expect(putHeaders['content-length']).toBe('3');
    // The key is never sent to the storage URL.
    expect(putHeaders['api-subscription-key']).toBeUndefined();
  });

  it.each([
    [401, 'SARVAM_AUTH_FAILED'],
    [403, 'SARVAM_AUTH_FAILED'],
    [429, 'SARVAM_RATE_LIMITED'],
    [503, 'SARVAM_UNAVAILABLE'],
    [422, 'SARVAM_REQUEST_FAILED'],
  ])('maps HTTP %i to %s without the provider body', async (status, code) => {
    const { fetchImpl } = mockFetch([json({ error: { message: 'secret detail' } }, status)]);
    await expect(
      submitSarvamJob({ apiKey: 'k', model: 'saaras:v3', audio: audio(), fetchImpl }),
    ).rejects.toThrow(new RegExp(`^${code}$`));
  });

  it('rejects a malformed upload URL map and a failed upload', async () => {
    const malformed = mockFetch([
      json({ job_id: 'job-1' }),
      json({ job_id: 'job-1', upload_urls: { 'call-1.m4a': { file_url: 'http://plain' } } }),
    ]);
    await expect(
      submitSarvamJob({
        apiKey: 'k',
        model: 'saaras:v3',
        audio: audio(),
        fetchImpl: malformed.fetchImpl,
      }),
    ).rejects.toThrow('SARVAM_MALFORMED_RESPONSE');
    const failedUpload = mockFetch([
      json({ job_id: 'job-1' }),
      json({ upload_urls: { 'call-1.m4a': { file_url: 'https://blob.example/u' } } }),
      () => new Response(null, { status: 403 }),
    ]);
    await expect(
      submitSarvamJob({
        apiKey: 'k',
        model: 'saaras:v3',
        audio: audio(),
        fetchImpl: failedUpload.fetchImpl,
      }),
    ).rejects.toThrow('SARVAM_UPLOAD_FAILED');
  });

  it('reports running, completed and failed jobs', async () => {
    const status = (body: unknown) =>
      getSarvamJobStatus({
        apiKey: 'k',
        jobId: 'job-1',
        fetchImpl: mockFetch([json(body)]).fetchImpl,
      });
    await expect(status({ job_state: 'Running' })).resolves.toEqual({ state: 'RUNNING' });
    await expect(
      status({
        job_state: 'Completed',
        job_details: [{ state: 'Success', outputs: [{ file_name: '0.json', file_id: '0' }] }],
      }),
    ).resolves.toEqual({ state: 'COMPLETED', outputFile: '0.json' });
    await expect(
      status({ job_state: 'Completed', job_details: [{ state: 'API Error', outputs: [] }] }),
    ).resolves.toEqual({ state: 'FAILED' });
    await expect(status({ job_state: 'Failed' })).resolves.toEqual({ state: 'FAILED' });
  });

  it('downloads the result through its signed URL and parses diarized turns', async () => {
    const { fetchImpl, calls } = mockFetch([
      json({ download_urls: { '0.json': { file_url: 'https://blob.example/0.json?sig=2' } } }),
      json({
        transcript: 'வணக்கம் எலிவேட் விலை?',
        language_code: 'ta-IN',
        diarized_transcript: {
          entries: [
            {
              transcript: 'வணக்கம்',
              speaker_id: '0',
              start_time_seconds: 0,
              end_time_seconds: 2.1,
            },
            { transcript: '', speaker_id: '1', start_time_seconds: 2.1, end_time_seconds: 2.5 },
            {
              transcript: 'எலிவேட் விலை?',
              speaker_id: '1',
              start_time_seconds: 2.5,
              end_time_seconds: 241.2,
            },
          ],
        },
      }),
    ]);
    const result = await downloadSarvamResult({
      apiKey: 'k',
      jobId: 'job-1',
      outputFile: '0.json',
      fetchImpl,
    });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ job_id: 'job-1', files: ['0.json'] });
    expect(result.languageCode).toBe('ta-IN');
    expect(result.turns).toEqual([
      { speakerId: '0', text: 'வணக்கம்', start: 0, end: 2.1 },
      { speakerId: '1', text: 'எலிவேட் விலை?', start: 2.5, end: 241.2 },
    ]);
    // The charge follows the real length, rounded up to whole seconds.
    expect(result.durationSeconds).toBe(242);
  });

  it('keeps a plain transcript as one unattributed turn and refuses an empty or malformed one', () => {
    expect(parseSarvamResult({ transcript: 'hello there', language_code: 'en-IN' }).turns).toEqual([
      { speakerId: 'unknown', text: 'hello there', start: null, end: null },
    ]);
    expect(() => parseSarvamResult({ transcript: '  ' })).toThrow('SARVAM_EMPTY_TRANSCRIPT');
    expect(() => parseSarvamResult(null)).toThrow('SARVAM_MALFORMED_RESULT');
  });
});

describe('Groq translation and call analysis', () => {
  it('splits a long call into bounded chunks without losing turn order', () => {
    const turns = Array.from({ length: 5 }, (_, index) => ({
      speakerId: String(index % 2),
      text: 'x'.repeat(2_500),
    }));
    const chunks = translationChunks(turns);
    expect(chunks.map((chunk) => [chunk.offset, chunk.turns.length])).toEqual([
      [0, 2],
      [2, 2],
      [4, 1],
    ]);
  });

  it('translates every turn in place and keeps the first confident speaker roles', async () => {
    const turns = [
      { speakerId: '0', text: 'a'.repeat(5_000) },
      { speakerId: '1', text: 'b'.repeat(5_000) },
    ];
    const { fetchImpl, calls } = mockFetch([
      groqReply({
        turns: [{ id: 0, english: 'Hello from the showroom' }],
        roles: { '0': 'AGENT', '1': 'CUSTOMER' },
      }),
      // A later chunk cannot swap roles, and an out-of-range id is ignored.
      groqReply({
        turns: [
          { id: 0, english: 'What is the price?' },
          { id: 7, english: 'x' },
        ],
        roles: { '0': 'CUSTOMER' },
      }),
    ]);
    const result = await translateCallTurns({
      apiKey: 'g',
      model: 'openai/gpt-oss-120b',
      languageCode: 'ta-IN',
      turns,
      fetchImpl,
    });
    expect(result.english).toEqual(['Hello from the showroom', 'What is the price?']);
    expect(result.roles).toEqual({ '0': 'AGENT', '1': 'CUSTOMER' });
    expect(calls).toHaveLength(2);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(JSON.parse(body.messages[1].content)).toMatchObject({ language: 'ta-IN' });
  });

  it('falls back to the original words when a turn is left untranslated', async () => {
    const { fetchImpl } = mockFetch([groqReply({ turns: [], roles: {} })]);
    const result = await translateCallTurns({
      apiKey: 'g',
      model: 'm',
      languageCode: 'hi-IN',
      turns: [{ speakerId: '0', text: 'नमस्ते' }],
      fetchImpl,
    });
    expect(result).toEqual({ english: ['नमस्ते'], roles: {} });
  });

  it.each([
    [() => json({ error: {} }, 401), 'GROQ_AUTH_FAILED'],
    [() => json({ error: {} }, 429), 'GROQ_RATE_LIMITED'],
    [() => json({ error: {} }, 500), 'GROQ_UNAVAILABLE'],
    [() => json({ choices: [{ message: { content: 'not json' } }] }), 'GROQ_MALFORMED_RESPONSE'],
    [() => json({ choices: [] }), 'GROQ_MALFORMED_RESPONSE'],
  ])('reports provider failures as fixed codes (%#)', async (response, code) => {
    const { fetchImpl } = mockFetch([response()]);
    await expect(
      analyzeCall({ apiKey: 'g', model: 'm', transcript: 'AGENT: hi', fetchImpl }),
    ).rejects.toThrow(new RegExp(`^${code}$`));
  });

  it('keeps only supported, well-formed suggestions', async () => {
    const { fetchImpl } = mockFetch([
      groqReply({
        summary: '  Customer wants an Elevate next month.  ',
        fields: {
          interested_model: 'Honda Elevate',
          temperature: 'HOT',
          lifecycle_status: 'Contacted',
          lost_reason: 'Price',
          next_followup_at: '2026-10-21T10:00:00+05:30',
          budget: '12 lakh',
        },
      }),
    ]);
    const analysis = await analyzeCall({ apiKey: 'g', model: 'm', transcript: 'x', fetchImpl });
    expect(analysis.summary).toBe('Customer wants an Elevate next month.');
    expect(analysis.fields).toEqual({
      interested_model: 'Honda Elevate',
      temperature: 'HOT',
      lifecycle_status: 'Contacted',
      next_followup_at: '2026-10-21T04:30:00.000Z',
    });
  });

  it('suggests the lead requirements with their stored types', async () => {
    const { fetchImpl } = mockFetch([
      groqReply({
        summary: 'Nexon EV, 15 lakh, loan, exchanging an i20.',
        fields: {
          variant: ' Empowered Plus ',
          budget_max: 1500000.4,
          purchase_timeline: 'This month',
          finance_required: true,
          exchange_required: true,
          test_drive_required: 'yes',
          competitors: ['MG ZS EV', '', 42],
          temperature: 'hot',
        },
      }),
    ]);
    const analysis = await analyzeCall({ apiKey: 'g', model: 'm', transcript: 'x', fetchImpl });
    expect(analysis.fields).toEqual({
      variant: 'Empowered Plus',
      budget_max: 1500000,
      purchase_timeline: 'This month',
      finance_required: true,
      exchange_required: true,
      competitors: ['MG ZS EV'],
      temperature: 'HOT',
    });
  });

  it('drops a budget that is not a positive number', async () => {
    const { fetchImpl } = mockFetch([
      groqReply({ summary: 's', fields: { budget_max: '15 lakh' } }),
      groqReply({ summary: 's', fields: { budget_max: -5 } }),
    ]);
    for (let round = 0; round < 2; round += 1) {
      const analysis = await analyzeCall({ apiKey: 'g', model: 'm', transcript: 'x', fetchImpl });
      expect(analysis.fields).toEqual({});
    }
  });

  it('gives the model the call time so relative days can be resolved', async () => {
    const { fetchImpl, calls } = mockFetch([groqReply({ summary: 's', fields: {} })]);
    await analyzeCall({
      apiKey: 'g',
      model: 'm',
      transcript: 'AGENT: See you this Saturday.',
      callStartedAt: '2026-10-21T08:49:00Z',
      fetchImpl,
    });
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const user = body.messages.find((message) => message.role === 'user')?.content ?? '';
    expect(user).toMatch(
      /^Call time: Wednesday[, ]+21 October 2026.*2:19 pm \(India, UTC\+05:30\)/,
    );
    expect(user).toContain('AGENT: See you this Saturday.');
  });
});

describe('AI call requirement suggestions migration', () => {
  const migration = readFileSync(
    join(process.cwd(), 'supabase/migrations/202610210001_ai_call_requirement_suggestions.sql'),
    'utf8',
  );
  const requirementKeys = [
    'variant',
    'budget_max',
    'purchase_timeline',
    'finance_required',
    'exchange_required',
    'test_drive_required',
    'competitors',
  ];

  it('accepts the requirement keys from the worker and in a review', () => {
    for (const key of requirementKeys) {
      // Allowed in save_ai_call_analysis_result and review_ai_call_fields, routed in review.
      expect(migration.split(`'${key}'`).length - 1).toBeGreaterThanOrEqual(3);
    }
    expect(migration).toContain('not between 1 and 15');
    expect(migration).toContain('jsonb_array_length(decisions) > 15');
  });

  it('writes approved requirements through update_lead_requirements, merged over the current row', () => {
    expect(migration).toContain('perform public.update_lead_requirements(');
    expect(migration).toContain(
      "coalesce(current_requirements - 'version' - 'updated_at', '{}'::jsonb) || requirements_patch",
    );
    expect(migration).toContain("md5(target_request_id::text || ':requirements')::uuid");
  });

  it('shows the current requirement value beside each suggestion', () => {
    expect(migration).toContain('app_private.lead_requirements_json(lead_row.id) -> suggested.key');
  });
});

describe('call transcription pricing and job contract', () => {
  const migration = readFileSync(
    join(process.cwd(), 'supabase/migrations/202610192000_sarvam_call_transcription.sql'),
    'utf8',
  );

  it('prices Sarvam cost plus margin per second of audio, minimum one credit', () => {
    expect(migration).toContain('values (true, 45, 30, 1)');
    expect(migration).toContain('* pricing.stt_inr_per_hour * (1 + pricing.margin_percent / 100)');
    expect(migration).toContain('select greatest(1, ceil(');
  });

  it('polls a submitted job without spending an attempt and hides the internal state', () => {
    expect(migration).toContain("attempt_count = case when job_row.status = 'WAITING_PROVIDER'");
    expect(migration).toContain(
      "(job_row.status = 'WAITING_PROVIDER' and job_row.provider_poll_after <= now())",
    );
    expect(migration).toContain(
      "'status', case when job_row.status = 'WAITING_PROVIDER' then 'PROCESSING' else job_row.status end",
    );
  });

  it('keeps worker RPCs service-role only and charges a regeneration again', () => {
    for (const name of [
      'record_ai_call_provider_submission(uuid, uuid, text, integer)',
      'defer_ai_call_provider_poll(uuid, uuid)',
      'fail_ai_call_processing_job(uuid, uuid, text)',
      'quote_ai_call_credits(integer)',
    ]) {
      expect(migration).toContain(`revoke all on function public.${name}`);
      expect(migration).toContain(`grant execute on function public.${name} to service_role;`);
    }
    expect(migration).toContain('generation = job_row.generation + 1');
  });
});

describe('AI call retry backoff migration', () => {
  const migration = readFileSync(
    join(process.cwd(), 'supabase/migrations/202610210002_ai_call_retry_backoff.sql'),
    'utf8',
  );

  it('delays each automatic retry exponentially and the claim respects it', () => {
    expect(migration).toContain('add column if not exists retry_after timestamptz');
    expect(migration).toContain(
      'now() + make_interval(mins => power(2, greatest(job_row.attempt_count, 1) - 1)::integer)',
    );
    expect(migration).toContain(
      "(job_row.status = 'RETRY' and coalesce(job_row.retry_after, now()) <= now())",
    );
  });

  it('patches the live definitions instead of re-emitting old bodies', () => {
    expect(migration).toContain("'public.retry_ai_call_processing_job(uuid,uuid,text)'");
    expect(migration).toContain("'public.claim_ai_call_processing_jobs(text,integer)'");
    expect(migration).not.toContain('create or replace function');
  });

  it('fills an empty call duration from the transcribed audio length', () => {
    expect(migration).toContain(
      "'public.save_ai_call_provider_transcript(uuid,uuid,text,text,jsonb,integer,text)'",
    );
    expect(migration).toContain(
      'update public.calls set duration_seconds = target_audio_duration_seconds',
    );
    expect(migration).toMatch(/where id = job_row\.call_id[\s\S]*and duration_seconds is null;/);
  });
});
