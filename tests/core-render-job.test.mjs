// Core render-job lifecycle (packages/core/src/venice/render-job.ts) over an
// in-memory VideoBackend and a fake Clock. No timers, no network, no files:
// every wait is recorded by the clock and resolves at once.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runVideoJob,
  DEFAULT_VIDEO_JOB_POLICY,
  RENDER_FILE_VIDEO_JOB_POLICY,
  GENERATE_VIDEO_JOB_POLICY,
  VideoJobTimeoutError,
  VideoJobPollError,
  VideoJobGoneError,
  VideoGenerationFailedError,
  VeniceRejectionError,
  SILENT_REJECT_THRESHOLD_VIDEO,
} from 'venice-video-harness/core';

const MODEL = 'seedance-2-5-text-to-video';
const OUT = 'episode-1/scene-001/shot-001.mp4';
const REQUEST = { model: MODEL, prompt: 'a lighthouse at dusk', duration: '5s' };
const TARGET = { outputKey: OUT, project: 'demo', episode: 1 };

const PROCESSING = { kind: 'processing', status: { status: 'PROCESSING', average_execution_time: 1, execution_duration: 1 } };
const READY = { kind: 'ready', bytes: new Uint8Array(SILENT_REJECT_THRESHOLD_VIDEO + 1), contentType: 'video/mp4' };
const TINY = { kind: 'ready', bytes: new Uint8Array(10), contentType: 'video/mp4' };
const FAILED = { kind: 'failed', status: 'FAILED', detail: 'Content policy', body: { status: 'FAILED', error: 'Content policy' } };
const GONE = { kind: 'gone', status: 404 };

class FakeAbortError extends Error {
  constructor() { super('aborted'); this.name = 'AbortError'; }
}

/**
 * In-memory VideoBackend. `retrieve` answers come from `script(handle, n)`
 * (n = retrieve calls so far for that queue id) or an array (one per call,
 * last one repeats). An Error answer rejects.
 */
function fakeBackend({ pending, script = [READY], queueAnswers = [] } = {}) {
  const records = new Map();
  const calls = [];
  const perQueue = new Map();
  let queued = 0;
  if (pending) records.set(OUT, { outputKey: OUT, model: MODEL, queueId: 'q-recorded', queuedAt: '2026-10-06T00:00:00Z', resumed: true, ...pending });

  const answer = (handle) => {
    const n = perQueue.get(handle.queueId) ?? 0;
    perQueue.set(handle.queueId, n + 1);
    const a = typeof script === 'function' ? script(handle, n) : script[Math.min(n, script.length - 1)];
    return a;
  };

  const backend = {
    records,
    calls,
    names: () => calls.map(c => c[0]),
    async quote() { throw new Error('not used'); },
    async findPending(outputKey) {
      calls.push(['findPending', outputKey]);
      const h = records.get(outputKey);
      return h ? { ...h, resumed: true } : undefined;
    },
    async resume(handle) {
      calls.push(['resume', handle.queueId]);
      return { ...handle, resumed: true };
    },
    async queue(request, target) {
      calls.push(['queue', request]);
      const a = queueAnswers[queued];
      queued += 1;
      if (a instanceof Error) throw a;
      const handle = { outputKey: target.outputKey, model: request.model, queueId: `q-${queued}`, queuedAt: '2026-10-06T01:00:00Z', resumed: false };
      records.set(target.outputKey, handle);
      return handle;
    },
    async retrieve(handle) {
      calls.push(['retrieve', handle.queueId]);
      const a = answer(handle);
      if (a instanceof Error) throw a;
      if (a.kind === 'gone' && !handle.resumed) throw Object.assign(new Error('HTTP 404'), { status: 404 });
      return a;
    },
    async download(handle, media) {
      calls.push(['download', handle.queueId]);
      records.delete(handle.outputKey);
      return { ref: handle.outputKey, sizeBytes: media.bytes.length };
    },
    async complete(handle) { calls.push(['complete', handle.queueId]); },
    async clearPending(outputKey) {
      calls.push(['clearPending', outputKey]);
      records.delete(outputKey);
    },
  };
  return backend;
}

function fakeClock({ onSleep } = {}) {
  const slept = [];
  let t = Date.parse('2026-10-06T00:00:00Z');
  return {
    slept,
    now: () => new Date(t),
    async sleep(ms, signal) {
      if (signal?.aborted) throw new FakeAbortError();
      slept.push(ms);
      t += ms;
      onSleep?.(slept.length);
      if (signal?.aborted) throw new FakeAbortError();
    },
  };
}

function fakeLogger() {
  const lines = { info: [], warn: [], error: [], debug: [], progress: [] };
  return {
    lines,
    debug: (m) => lines.debug.push(m),
    info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m),
    error: (m) => lines.error.push(m),
    progress: (u) => lines.progress.push(u),
  };
}

function ports(backendOpts, clockOpts) {
  return { video: fakeBackend(backendOpts), clock: fakeClock(clockOpts), logger: fakeLogger() };
}

const count = (p, name) => p.video.names().filter(n => n === name).length;

// ---- re-attach / queue -------------------------------------------------------

test('re-attach never queues: a recorded job is resumed and polled', async () => {
  const p = ports({ pending: {}, script: [PROCESSING, READY] });
  const result = await runVideoJob(p, REQUEST, TARGET);
  assert.deepEqual(p.video.names(), ['findPending', 'resume', 'retrieve', 'retrieve', 'download', 'complete']);
  assert.equal(result.resumed, true);
  assert.equal(result.requeued, false);
  assert.equal(result.handle.queueId, 'q-recorded');
  assert.equal(result.polls, 2);
});

test('no recorded job: queues exactly once, then polls', async () => {
  const p = ports({ script: [PROCESSING, READY] });
  const result = await runVideoJob(p, REQUEST, TARGET);
  assert.deepEqual(p.video.names(), ['findPending', 'queue', 'retrieve', 'retrieve', 'download', 'complete']);
  assert.deepEqual(p.video.calls[1][1], REQUEST, 'the request goes to the backend untouched');
  assert.equal(result.resumed, false);
});

test('the queue call is never retried: a queue failure rejects with that error and nothing is polled', async () => {
  const boom = Object.assign(new Error('HTTP 502'), { status: 502 });
  const p = ports({ queueAnswers: [boom] });
  await assert.rejects(runVideoJob(p, REQUEST, TARGET), (err) => err === boom);
  assert.equal(count(p, 'queue'), 1);
  assert.equal(count(p, 'retrieve'), 0);
  assert.equal(count(p, 'clearPending'), 0);
});

test('forceRequeue skips the recorded job (explicit operator override)', async () => {
  const p = ports({ pending: {} });
  const result = await runVideoJob(p, REQUEST, TARGET, undefined, { forceRequeue: true });
  assert.deepEqual(p.video.names(), ['queue', 'retrieve', 'download', 'complete']);
  assert.equal(result.handle.queueId, 'q-1');
});

// ---- gone -----------------------------------------------------------------------

test('gone on a resumed id: clear, requeue once, then poll the fresh job', async () => {
  const p = ports({ pending: {}, script: (h) => (h.queueId === 'q-recorded' ? GONE : READY) });
  const result = await runVideoJob(p, REQUEST, TARGET);
  assert.deepEqual(p.video.names(), ['findPending', 'resume', 'retrieve', 'clearPending', 'queue', 'retrieve', 'download', 'complete']);
  assert.equal(result.requeued, true);
  assert.equal(result.resumed, false);
  assert.equal(result.handle.queueId, 'q-1');
  assert.match(p.logger.lines.warn[0], /Recorded job q-recorded is gone on Venice's side; queueing a fresh generation/);
});

test('gone is requeued at most once per run', async () => {
  // A backend that (against the contract) reports gone for the fresh handle too.
  const p = ports({ pending: {}, script: [GONE] });
  p.video.retrieve = async (handle) => { p.video.calls.push(['retrieve', handle.queueId]); return GONE; };
  await assert.rejects(runVideoJob(p, REQUEST, TARGET), VideoJobGoneError);
  assert.equal(count(p, 'queue'), 1);
  assert.equal(count(p, 'clearPending'), 2);
  assert.equal(p.video.records.size, 0);
});

test('requeueOnGone: false clears the record and throws VideoJobGoneError without queueing', async () => {
  const p = ports({ pending: {}, script: [GONE] });
  await assert.rejects(runVideoJob(p, REQUEST, TARGET, { requeueOnGone: false }), (err) => {
    assert.ok(err instanceof VideoJobGoneError);
    assert.equal(err.queueId, 'q-recorded');
    assert.equal(err.status, 404);
    return true;
  });
  assert.equal(count(p, 'queue'), 0);
  assert.equal(p.video.records.size, 0);
});

// ---- failed ----------------------------------------------------------------------

test('failed: record cleared, VideoGenerationFailedError, no download or complete', async () => {
  const p = ports({ script: [PROCESSING, FAILED] });
  await assert.rejects(runVideoJob(p, REQUEST, TARGET), (err) => {
    assert.ok(err instanceof VideoGenerationFailedError);
    assert.equal(err.message, `Video generation FAILED for ${MODEL} (q-1): Content policy`);
    assert.deepEqual(err.body, FAILED.body);
    return true;
  });
  assert.deepEqual(p.video.names(), ['findPending', 'queue', 'retrieve', 'retrieve', 'clearPending']);
  assert.equal(p.video.records.size, 0);
});

test('clearOnFailed: false leaves the record', async () => {
  const p = ports({ script: [FAILED] });
  await assert.rejects(runVideoJob(p, REQUEST, TARGET, { clearOnFailed: false }), VideoGenerationFailedError);
  assert.equal(count(p, 'clearPending'), 0);
  assert.equal(p.video.records.size, 1);
});

// ---- deadline ----------------------------------------------------------------------

test('deadline (maxWaitMs): times out with the record kept, after exactly maxWaitMs of waiting', async () => {
  const p = ports({ script: [PROCESSING] });
  const policy = { pollIntervalMs: 10, maxWaitMs: 50, sleepBeforeFirstPoll: true };
  await assert.rejects(runVideoJob(p, REQUEST, TARGET, policy), (err) => {
    assert.ok(err instanceof VideoJobTimeoutError);
    assert.equal(err.reason, 'max-wait');
    assert.equal(err.polls, 5);
    assert.equal(err.waitedMs, 50);
    return true;
  });
  assert.equal(count(p, 'retrieve'), 5);
  assert.deepEqual(p.clock.slept, [10, 10, 10, 10, 10]);
  assert.equal(count(p, 'clearPending'), 0);
  assert.equal(p.video.records.size, 1, 'a timed-out job may still finish: the next run re-attaches');
});

test('deadline (maxPolls): stops after maxPolls retrieves; the hint is appended', async () => {
  const p = ports({ script: [PROCESSING] });
  await assert.rejects(runVideoJob(p, REQUEST, TARGET, { maxPolls: 3, maxWaitMs: undefined, timeoutHint: 'Re-run.' }), (err) => {
    assert.ok(err instanceof VideoJobTimeoutError);
    assert.equal(err.reason, 'max-polls');
    assert.equal(err.message, `Timed out waiting for video generation: ${MODEL} (q-1). Re-run.`);
    return true;
  });
  assert.equal(count(p, 'retrieve'), 3);
  assert.equal(p.clock.slept.length, 2, 'polls at once, then waits between');
});

test('the default policy waits up to 60 minutes and says how to re-attach', async () => {
  const p = ports({ script: [PROCESSING] });
  await assert.rejects(runVideoJob(p, REQUEST, TARGET), (err) => {
    assert.ok(err instanceof VideoJobTimeoutError);
    assert.equal(err.message, `Timed out after 60 min waiting for ${MODEL} (q-1). ${DEFAULT_VIDEO_JOB_POLICY.timeoutHint}`);
    return true;
  });
  assert.equal(count(p, 'retrieve'), 361, 'one immediate poll plus 360 after 10 s waits');
});

// ---- cadence --------------------------------------------------------------------------

test('poll cadence goes through Clock.sleep: default polls at once, then every interval', async () => {
  const p = ports({ script: [PROCESSING, PROCESSING, READY] });
  const result = await runVideoJob(p, REQUEST, TARGET);
  assert.deepEqual(p.clock.slept, [10_000, 10_000]);
  assert.equal(result.waitedMs, 20_000);
});

test('sleepBeforeFirstPoll waits one interval before the first retrieve', async () => {
  const p = ports({ script: [READY] });
  await runVideoJob(p, REQUEST, TARGET, { sleepBeforeFirstPoll: true, pollIntervalMs: 7 });
  assert.deepEqual(p.clock.slept, [7]);
});

test('processing answers are reported as progress and to onProgress', async () => {
  const p = ports({ script: [PROCESSING, READY] });
  const seen = [];
  await runVideoJob(p, REQUEST, TARGET, undefined, { onProgress: (s) => seen.push(s.status) });
  assert.deepEqual(seen, ['PROCESSING']);
  assert.deepEqual(p.logger.lines.progress, [{ phase: 'poll', detail: 'PROCESSING 0s' }]);
});

// ---- error budget ---------------------------------------------------------------------

test('error budget: transient retrieve errors are tolerated and reset by a success', async () => {
  const e = new Error('HTTP 503');
  const p = ports({ script: [e, e, PROCESSING, e, e, e, e, e, READY] });
  const result = await runVideoJob(p, REQUEST, TARGET);
  assert.equal(result.polls, 9);
  assert.equal(p.logger.lines.warn.length, 7);
  assert.equal(p.logger.lines.warn[0], '  Poll error 1/6 (will retry): Error: HTTP 503');
});

test('error budget: the Nth consecutive error ends the job with VideoJobPollError, record kept', async () => {
  const e = new Error('HTTP 503');
  const p = ports({ script: [e] });
  await assert.rejects(runVideoJob(p, REQUEST, TARGET), (err) => {
    assert.ok(err instanceof VideoJobPollError);
    assert.equal(err.attempts, 6);
    assert.equal(err.lastError, e);
    assert.equal(err.message, `Polling ${MODEL} (q-1) failed 6 times in a row; giving up. Last error: HTTP 503`);
    return true;
  });
  assert.equal(count(p, 'retrieve'), 6);
  assert.equal(p.video.records.size, 1);
});

test('maxConsecutiveErrors 0: the first retrieve error propagates unchanged', async () => {
  const e = new Error('HTTP 500');
  const p = ports({ script: [PROCESSING, e, READY] });
  await assert.rejects(runVideoJob(p, REQUEST, TARGET, { maxConsecutiveErrors: 0 }), (err) => err === e);
  assert.equal(count(p, 'retrieve'), 2);
  assert.equal(p.video.records.size, 1);
});

// ---- abort -----------------------------------------------------------------------------

test('abort during a wait stops polling and leaves the pending record', async () => {
  const controller = new AbortController();
  const p = ports({ script: [PROCESSING] }, { onSleep: (n) => { if (n === 2) controller.abort(); } });
  await assert.rejects(runVideoJob(p, REQUEST, TARGET, undefined, { signal: controller.signal }), FakeAbortError);
  assert.equal(count(p, 'retrieve'), 2);
  assert.equal(count(p, 'clearPending'), 0);
  assert.equal(count(p, 'download'), 0);
  assert.equal(p.video.records.size, 1);
});

test('an already-aborted signal queues nothing and surfaces the clock\'s abort error', async () => {
  const controller = new AbortController();
  controller.abort();
  const p = ports({});
  await assert.rejects(runVideoJob(p, REQUEST, TARGET, undefined, { signal: controller.signal }), FakeAbortError);
  assert.deepEqual(p.video.names(), []);
});

test('an abort error from retrieve is not counted against the error budget', async () => {
  const controller = new AbortController();
  const p = ports({});
  p.video.retrieve = async () => { controller.abort(); throw new FakeAbortError(); };
  p.video.records.set(OUT, { outputKey: OUT, model: MODEL, queueId: 'q-x', queuedAt: '', resumed: true });
  await assert.rejects(runVideoJob(p, REQUEST, TARGET, undefined, { signal: controller.signal }), FakeAbortError);
  assert.equal(p.logger.lines.warn.length, 0);
  assert.equal(p.video.records.size, 1);
});

// ---- download / complete ---------------------------------------------------------------

test('ready: download (which clears the record) runs before complete', async () => {
  const p = ports({ script: [READY] });
  const result = await runVideoJob(p, REQUEST, TARGET);
  const names = p.video.names();
  assert.deepEqual(names.slice(-3), ['retrieve', 'download', 'complete']);
  assert.equal(result.download.sizeBytes, READY.bytes.length);
  assert.equal(p.video.records.size, 0);
});

test('a download failure propagates, complete is not called, and the record stays for a re-attach', async () => {
  const p = ports({ script: [READY] });
  const diskFull = new Error('ENOSPC');
  p.video.download = async () => { p.video.calls.push(['download']); throw diskFull; };
  await assert.rejects(runVideoJob(p, REQUEST, TARGET), (err) => err === diskFull);
  assert.equal(count(p, 'complete'), 0);
  assert.equal(count(p, 'retrieve'), 1, 'not retried as a poll error');
  assert.equal(p.video.records.size, 1);
});

// ---- silent reject ------------------------------------------------------------------------

test('silent reject (default): placeholder bytes are not stored and the record is cleared', async () => {
  const p = ports({ script: [TINY] });
  await assert.rejects(runVideoJob(p, REQUEST, TARGET), (err) => {
    assert.ok(err instanceof VeniceRejectionError);
    assert.equal(err.kind, 'video');
    assert.equal(err.prompt, REQUEST.prompt);
    return true;
  });
  assert.equal(count(p, 'download'), 0);
  assert.equal(count(p, 'complete'), 0);
  assert.equal(p.video.records.size, 0);
});

test('silent reject: the threshold is configurable and the check can be off', async () => {
  const lowRes = ports({ script: [TINY] });
  await runVideoJob(lowRes, REQUEST, TARGET, { silentReject: { thresholdBytes: 5 } });
  assert.equal(count(lowRes, 'download'), 1);

  const off = ports({ script: [TINY] });
  await runVideoJob(off, REQUEST, TARGET, { silentReject: false });
  assert.equal(count(off, 'download'), 1);
});

// ---- presets ---------------------------------------------------------------------------------

test('presets list every policy key (so spreading one over the default leaves nothing of the default behind) and are frozen', () => {
  const keys = [
    'pollIntervalMs', 'sleepBeforeFirstPoll', 'maxPolls', 'maxWaitMs', 'maxConsecutiveErrors',
    'requeueOnGone', 'clearOnFailed', 'silentReject', 'clearOnSilentReject', 'timeoutHint',
  ];
  for (const preset of [DEFAULT_VIDEO_JOB_POLICY, RENDER_FILE_VIDEO_JOB_POLICY, GENERATE_VIDEO_JOB_POLICY]) {
    assert.deepEqual(Object.keys(preset).sort(), [...keys].sort());
    assert.ok(Object.isFrozen(preset));
  }
});

test('a key set to undefined removes the default: no wait cap with maxPolls alone', async () => {
  const p = ports({ script: [PROCESSING] });
  await assert.rejects(
    runVideoJob(p, REQUEST, TARGET, { pollIntervalMs: 60 * 60 * 1000, maxWaitMs: undefined, maxPolls: 4 }),
    (err) => err instanceof VideoJobTimeoutError && err.reason === 'max-polls',
  );
  assert.equal(count(p, 'retrieve'), 4);
});

test('GENERATE preset: silent reject leaves the record (pollVideoResult behaviour)', async () => {
  const p = ports({ script: [TINY] });
  await assert.rejects(runVideoJob(p, REQUEST, TARGET, GENERATE_VIDEO_JOB_POLICY), VeniceRejectionError);
  assert.equal(p.video.records.size, 1);
});

test('RENDER_FILE preset: no silent-reject check, sleeps before every poll', async () => {
  const p = ports({ script: [PROCESSING, TINY] });
  const result = await runVideoJob(p, REQUEST, TARGET, RENDER_FILE_VIDEO_JOB_POLICY);
  assert.equal(result.download.sizeBytes, TINY.bytes.length);
  assert.deepEqual(p.clock.slept, [10_000, 10_000]);
});
