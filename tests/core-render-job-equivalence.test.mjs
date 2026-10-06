// The core render-job presets decide exactly what the CLI's two poll loops
// decide, on the same scripted /video/retrieve sequences:
//
//   RENDER_FILE_VIDEO_JOB_POLICY  ≡ renderVideoFile → pollRenderedVideo  (video-generator.ts)
//   GENERATE_VIDEO_JOB_POLICY     ≡ generateVideo   → pollVideoResult    (venice/video.ts)
//
// Each scenario runs twice against one scripted fake VeniceClient: once
// through the existing CLI function (its 10 s waits driven by node:test's
// mocked setTimeout, so nothing really sleeps), once through `runVideoJob`
// over the CLI's own VideoBackend adapter (`createCliVideoBackend`) and a
// fake Clock. Compared: outcome (ok / failed / rejected / error + message),
// queue, retrieve and complete call counts, whether the pending-job record
// survives, and whether the file was written.
//
// Error classes: where the CLI throws a plain `Error` (timeout, poll budget),
// core throws `VideoJobTimeoutError` / `VideoJobPollError`, which extend
// `Error` with the identical message; the comparison is on the message.
//
// No network, no API key: the pending-job registry lives in a temp
// VENICE_VIDEO_CONFIG_DIR set before anything reads it.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

process.env.VENICE_VIDEO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'render-job-eq-config-'));

const { renderVideoFile } = await import('../dist/mini-drama/video-generator.js');
const { generateVideo, VideoGenerationFailedError } = await import('../dist/venice/video.js');
const { VeniceRequestError } = await import('../dist/venice/client.js');
const { findPendingJob, recordPendingJob } = await import('../dist/venice/job-store.js');
const { createCliVideoBackend } = await import('../dist/ports/index.js');
const {
  runVideoJob,
  RENDER_FILE_VIDEO_JOB_POLICY,
  GENERATE_VIDEO_JOB_POLICY,
  VeniceRejectionError,
  SILENT_REJECT_THRESHOLD_VIDEO,
} = await import('venice-video-harness/core');

const MODEL = 'seedance-2-5-text-to-video';
const PROMPT = 'a lighthouse at dusk';
const RECORDED = 'q-recorded';

// ---- scripted answers --------------------------------------------------------

const P = { status: 'PROCESSING', average_execution_time: 1000, execution_duration: 10 };
const F = { status: 'FAILED', error: 'Content policy' };
const R = 'ready';
const T = 'tiny';
const E = 'error';
const GONE = 'gone';

function materialize(a) {
  if (a === R) return { contentType: 'video/mp4', value: Buffer.alloc(SILENT_REJECT_THRESHOLD_VIDEO + 1) };
  if (a === T) return { contentType: 'video/mp4', value: Buffer.alloc(10) };
  if (a === E) throw new VeniceRequestError('Venice API error 503 on /api/v1/video/retrieve: upstream', 503, {});
  if (a === GONE) throw new VeniceRequestError('Venice API error 404 on /api/v1/video/retrieve: not found', 404, {});
  return { contentType: 'application/json', value: structuredClone(a) };
}

/** A VeniceClient stand-in. `script(queueId, n)` answers the n-th retrieve of that queue id. */
function stubClient(script) {
  const calls = { queue: 0, retrieve: 0, complete: 0 };
  const perQueue = new Map();
  return {
    calls,
    async post(path, body) {
      if (path === '/api/v1/video/queue') {
        calls.queue += 1;
        return { queue_id: `q-new-${calls.queue}`, model: body.model };
      }
      if (path === '/api/v1/video/complete') {
        calls.complete += 1;
        return {};
      }
      throw new Error(`unexpected POST ${path}`);
    },
    async postBinaryOrJson(path, body) {
      assert.equal(path, '/api/v1/video/retrieve');
      calls.retrieve += 1;
      const n = perQueue.get(body.queue_id) ?? 0;
      perQueue.set(body.queue_id, n + 1);
      return materialize(script(body.queue_id, n));
    },
  };
}

const seq = (...answers) => (_q, n) => answers[Math.min(n, answers.length - 1)];

// ---- harness -------------------------------------------------------------------

/** Silence console and the CLI's `\r  Polling…` line while `fn` runs; pass anything else through. */
async function quiet(fn) {
  const { log, warn, error } = console;
  const write = process.stdout.write;
  console.log = console.warn = console.error = () => {};
  process.stdout.write = function (chunk, ...rest) {
    if (typeof chunk === 'string' && (chunk.startsWith('\r  Polling') || chunk === '\n')) return true;
    return write.call(this, chunk, ...rest);
  };
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, warn, error });
    process.stdout.write = write;
  }
}

/** Run `fn` with setTimeout mocked, firing each pending wait as soon as the loop is idle. */
async function withFakeTimers(fn) {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let settled = false;
    const promise = fn();
    promise.then(() => { settled = true; }, () => { settled = true; });
    while (!settled) {
      await new Promise((r) => setImmediate(r));
      mock.timers.tick(10_000);
    }
    return await promise;
  } finally {
    mock.timers.reset();
  }
}

function fakeClock() {
  let t = Date.parse('2026-10-06T00:00:00Z');
  return { now: () => new Date(t), async sleep(ms) { t += ms; } };
}

const quietLogger = { debug() {}, info() {}, warn() {}, error() {}, progress() {} };

async function observe(client, outputPath, run) {
  let outcome;
  try {
    await quiet(run);
    outcome = { result: 'ok' };
  } catch (err) {
    const result = err instanceof VideoGenerationFailedError ? 'failed'
      : err instanceof VeniceRejectionError ? 'rejected'
        : 'error';
    outcome = { result, message: err.message };
  }
  return {
    ...outcome,
    ...client.calls,
    pending: Boolean(await findPendingJob(resolve(outputPath))),
    written: existsSync(outputPath),
  };
}

async function setUp({ resumed }) {
  const dir = mkdtempSync(join(tmpdir(), 'render-job-eq-'));
  const outputPath = join(dir, 'scene-001', 'shot-001.mp4');
  if (resumed) {
    await recordPendingJob({ kind: 'video', model: MODEL, queueId: RECORDED, outputPath: resolve(outputPath), prompt: PROMPT });
  }
  return outputPath;
}

const coreRun = (policy) => async (script, resumed) => {
  const outputPath = await setUp({ resumed });
  const client = stubClient(script);
  const ports = { video: createCliVideoBackend(() => client, quietLogger), clock: fakeClock(), logger: quietLogger };
  return observe(client, outputPath, () => runVideoJob(
    ports,
    { model: MODEL, prompt: PROMPT, duration: '5s' },
    { outputKey: outputPath },
    policy,
  ));
};

const legacyRender = async (script, resumed) => {
  const outputPath = await setUp({ resumed });
  const client = stubClient(script);
  return observe(client, outputPath, () => withFakeTimers(() => renderVideoFile(client, {
    prompt: { prompt: PROMPT, model: MODEL, duration: '5s', audio: true },
    outputPath,
    characters: [],
  })));
};

const legacyGenerate = async (script, resumed) => {
  const outputPath = await setUp({ resumed });
  const client = stubClient(script);
  return observe(client, outputPath, () => withFakeTimers(() => generateVideo(client, {
    model: MODEL,
    prompt: PROMPT,
    duration: '5s',
    outputPath,
  })));
};

// ---- scenarios ---------------------------------------------------------------------

const SCENARIOS = [
  { name: 'processing, then ready', script: seq(P, P, R) },
  { name: 'processing, then FAILED', script: seq(P, F) },
  { name: 'processing forever (deadline)', script: seq(P) },
  { name: 'two transient retrieve errors, then ready', script: seq(E, E, P, R) },
  { name: 'five errors, a success, five errors, ready', script: seq(E, E, E, E, E, P, E, E, E, E, E, R) },
  { name: 'retrieve errors forever (error budget)', script: seq(E) },
  { name: 'placeholder bytes (silent reject)', script: seq(P, T) },
  { name: 'resumed, then ready', script: seq(P, R), resumed: true },
  { name: 'resumed but gone: requeue once', script: (q, n) => (q === RECORDED ? GONE : [P, R][Math.min(n, 1)]), resumed: true },
  { name: 'resumed, FAILED', script: seq(F), resumed: true },
];

// What each existing loop actually does, pinned so a drift in either side shows here too.
const EXPECTED = {
  render: {
    'processing, then ready': { result: 'ok', queue: 1, retrieve: 3, complete: 1, pending: false, written: true },
    'processing, then FAILED': { result: 'failed', queue: 1, retrieve: 2, pending: false, written: false },
    'processing forever (deadline)': { result: 'error', queue: 1, retrieve: 360, pending: true, written: false },
    'two transient retrieve errors, then ready': { result: 'ok', retrieve: 4, written: true },
    'five errors, a success, five errors, ready': { result: 'ok', retrieve: 12, written: true },
    'retrieve errors forever (error budget)': { result: 'error', retrieve: 6, pending: true },
    'placeholder bytes (silent reject)': { result: 'ok', written: true, pending: false },
    'resumed, then ready': { result: 'ok', queue: 0, retrieve: 2, written: true },
    'resumed but gone: requeue once': { result: 'ok', queue: 1, retrieve: 3, written: true, pending: false },
    'resumed, FAILED': { result: 'failed', queue: 0, retrieve: 1, pending: false },
  },
  generate: {
    'processing, then ready': { result: 'ok', queue: 1, retrieve: 3, complete: 1, pending: false, written: true },
    'processing, then FAILED': { result: 'failed', queue: 1, retrieve: 2, pending: false, written: false },
    'processing forever (deadline)': { result: 'error', queue: 1, retrieve: 180, pending: true, written: false },
    'two transient retrieve errors, then ready': { result: 'error', retrieve: 1, pending: true, written: false },
    'five errors, a success, five errors, ready': { result: 'error', retrieve: 1, pending: true },
    'retrieve errors forever (error budget)': { result: 'error', retrieve: 1, pending: true },
    'placeholder bytes (silent reject)': { result: 'rejected', retrieve: 2, written: false, pending: true, complete: 0 },
    'resumed, then ready': { result: 'ok', queue: 0, retrieve: 2, written: true },
    'resumed but gone: requeue once': { result: 'ok', queue: 1, retrieve: 3, written: true, pending: false },
    'resumed, FAILED': { result: 'failed', queue: 0, retrieve: 1, pending: false },
  },
};

test('cancellation: both stop at the next check with OperationAbortedError and keep the record', async () => {
  const { runInOperation } = await import('../dist/venice/operation-context.js');
  const { createCliClock } = await import('../dist/ports/index.js');

  // The second retrieve answers PROCESSING and cancels the operation (Ctrl-C mid-poll).
  const cancelling = (controller) => (q, n) => { if (n === 1) controller.abort(); return P; };

  const legacyController = new AbortController();
  const legacyOut = await setUp({ resumed: false });
  const legacyClient = stubClient(cancelling(legacyController));
  const legacy = await observe(legacyClient, legacyOut, () => withFakeTimers(() => runInOperation(
    { signal: legacyController.signal },
    () => renderVideoFile(legacyClient, { prompt: { prompt: PROMPT, model: MODEL, duration: '5s', audio: true }, outputPath: legacyOut, characters: [] }),
  )));

  const coreController = new AbortController();
  const coreOut = await setUp({ resumed: false });
  const coreClient = stubClient(cancelling(coreController));
  const ports = { video: createCliVideoBackend(() => coreClient, quietLogger), clock: createCliClock(), logger: quietLogger };
  const core = await observe(coreClient, coreOut, () => withFakeTimers(() => runVideoJob(
    ports,
    { model: MODEL, prompt: PROMPT, duration: '5s' },
    { outputKey: coreOut },
    RENDER_FILE_VIDEO_JOB_POLICY,
    { signal: coreController.signal },
  )));

  assert.deepEqual(core, legacy);
  assert.deepEqual(legacy, { result: 'error', message: 'Operation cancelled.', queue: 1, retrieve: 2, complete: 0, pending: true, written: false });
});

for (const scenario of SCENARIOS) {
  test(`RENDER_FILE preset ≡ renderVideoFile: ${scenario.name}`, async () => {
    const legacy = await legacyRender(scenario.script, scenario.resumed);
    const core = await coreRun(RENDER_FILE_VIDEO_JOB_POLICY)(scenario.script, scenario.resumed);
    assert.deepEqual(core, legacy);
    for (const [k, v] of Object.entries(EXPECTED.render[scenario.name])) assert.equal(legacy[k], v, k);
  });

  test(`GENERATE_VIDEO preset ≡ generateVideo: ${scenario.name}`, async () => {
    const legacy = await legacyGenerate(scenario.script, scenario.resumed);
    const core = await coreRun(GENERATE_VIDEO_JOB_POLICY)(scenario.script, scenario.resumed);
    assert.deepEqual(core, legacy);
    for (const [k, v] of Object.entries(EXPECTED.generate[scenario.name])) assert.equal(legacy[k], v, k);
  });
}
