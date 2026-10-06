// Core ports (packages/core/src/ports.ts) and the CLI's implementation of
// them (src/ports/, createCliPorts).
//
// No network: every Venice call goes to an injected fake client. The
// pending-job registry lives in a temp VENICE_VIDEO_CONFIG_DIR set below,
// before anything reads it. The ffmpeg-backed probe test skips when ffmpeg
// is not on PATH.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

process.env.VENICE_VIDEO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'core-ports-config-'));

const { createCliPorts, createCliLogger, createCliClock } = await import('../dist/ports/index.js');
const { VeniceRequestError } = await import('../dist/venice/client.js');
const { VideoRequestValidationError } = await import('../dist/venice/video.js');
const { listPendingJobs, recordPendingJob } = await import('../dist/venice/job-store.js');
const { OperationAbortedError, runInOperation } = await import('../dist/venice/operation-context.js');
const { referenceSetFromDisk } = await import('../dist/mini-drama/reference-set-from-disk.js');
const { getCharacterDir, getLocationDir } = await import('../dist/series/manager.js');

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
const MODEL = 'seedance-2-5-reference-to-video';

// The method surface core declares. A port missing one fails here and in tsc.
const PORT_METHODS = {
  references: ['referenceSet', 'read', 'url'],
  images: ['imageInfo', 'clipDuration', 'extractFrame', 'frameLumas'],
  vision: ['judge'],
  video: ['quote', 'findPending', 'resume', 'queue', 'retrieve', 'download', 'complete', 'clearPending'],
  clock: ['now', 'sleep'],
  logger: ['debug', 'info', 'warn', 'error', 'progress'],
};

const quiet = { log() {}, warn() {}, error() {} };

/** A VeniceClient stand-in whose answers are scripted per endpoint. */
function fakeClient({ queue = [], retrieve = [], complete = [], chat = [] } = {}) {
  const calls = { queue: [], retrieve: [], complete: [], quote: [], chat: [] };
  const next = (list, i) => list[Math.min(i, list.length - 1)];
  return {
    calls,
    async post(path, body) {
      if (path === '/api/v1/video/queue') {
        const answer = next(queue, calls.queue.length);
        calls.queue.push(structuredClone(body));
        if (answer instanceof Error) throw answer;
        return answer;
      }
      if (path === '/api/v1/video/complete') {
        const answer = next(complete, calls.complete.length);
        calls.complete.push(body);
        if (answer instanceof Error) throw answer;
        return {};
      }
      if (path === '/api/v1/video/quote') {
        calls.quote.push(body);
        return { quote: 1.25 };
      }
      throw new Error(`unexpected POST ${path}`);
    },
    async postBinaryOrJson(path, body) {
      assert.equal(path, '/api/v1/video/retrieve');
      const answer = next(retrieve, calls.retrieve.length);
      calls.retrieve.push(body);
      if (answer instanceof Error) throw answer;
      if (Buffer.isBuffer(answer)) return { contentType: 'video/mp4', value: answer };
      return { contentType: 'application/json', value: answer };
    },
    async chatJson(options) {
      calls.chat.push(options);
      return next(chat, calls.chat.length - 1);
    },
  };
}

function request(overrides = {}) {
  return { model: MODEL, prompt: 'a shot', duration: '10s', aspect_ratio: '16:9', ...overrides };
}

function outDir() {
  return mkdtempSync(join(tmpdir(), 'core-ports-out-'));
}

async function pendingFor(outputPath) {
  return (await listPendingJobs()).find(j => j.outputPath === outputPath);
}

// ---- Aggregate ---------------------------------------------------------------

test('createCliPorts builds every port without an API key, with the full method surface', () => {
  const saved = process.env.VENICE_API_KEY;
  process.env.VENICE_API_KEY = '';
  try {
    const ports = createCliPorts({ logging: { console: quiet } });
    for (const [port, methods] of Object.entries(PORT_METHODS)) {
      for (const m of methods) assert.equal(typeof ports[port][m], 'function', `${port}.${m}`);
    }
  } finally {
    process.env.VENICE_API_KEY = saved;
  }
});

test('the Venice client is created on first vision/video use, not at construction', async () => {
  const saved = process.env.VENICE_API_KEY;
  process.env.VENICE_API_KEY = '';
  try {
    const ports = createCliPorts({ logging: { console: quiet } });
    await assert.rejects(ports.video.quote(request()), /API key is required/);
  } finally {
    process.env.VENICE_API_KEY = saved;
  }
});

// ---- Clock -------------------------------------------------------------------

test('Clock: now() is the wall clock; sleep() waits and rejects on abort', async () => {
  const clock = createCliClock();
  const before = Date.now();
  const now = clock.now();
  assert.ok(now instanceof Date);
  assert.ok(Math.abs(now.getTime() - before) < 1000);

  await clock.sleep(5);

  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(clock.sleep(10_000, ctl.signal), OperationAbortedError);

  const late = new AbortController();
  const p = clock.sleep(10_000, late.signal);
  late.abort();
  await assert.rejects(p, OperationAbortedError);
});

// ---- Logger ------------------------------------------------------------------

test('Logger: info to log, warn/error to their streams, debug only when enabled, progress to the operation sink', async () => {
  const lines = [];
  const sink = { log: (...a) => lines.push(['log', ...a]), warn: (...a) => lines.push(['warn', ...a]), error: (...a) => lines.push(['error', ...a]) };

  const logger = createCliLogger({ console: sink, debug: false });
  logger.debug('hidden');
  logger.info('hello', 1);
  logger.warn('careful');
  logger.error('broken');
  assert.deepEqual(lines, [['log', 'hello', 1], ['warn', 'careful'], ['error', 'broken']]);

  createCliLogger({ console: sink, debug: true }).debug('shown');
  assert.deepEqual(lines.at(-1), ['log', 'shown']);

  const updates = [];
  await runInOperation({ onProgress: u => updates.push(u) }, async () => {
    logger.progress({ phase: 'poll', detail: 'PROCESSING 10s' });
  });
  assert.deepEqual(updates, [{ phase: 'poll', detail: 'PROCESSING 10s' }]);
  assert.doesNotThrow(() => logger.progress({ phase: 'outside any operation' }));
});

// ---- ReferenceStore ------------------------------------------------------------

function makeSeries(dir) {
  const character = {
    name: 'ARIA', gender: 'female', age: '30s', description: 'd', fullDescription: 'fd',
    wardrobe: 'w', voiceDescription: '', locked: true, seed: 1,
  };
  return {
    name: 't', slug: 't', concept: '', genre: '', setting: '', aesthetic: null,
    characters: [character],
    locations: [{ name: 'Lab', slug: 'lab', description: 'a lab', seed: 2 }],
    episodes: [], videoDefaults: { actionModel: 'x', atmosphereModel: 'x' },
    outputDir: dir, createdAt: '', updatedAt: '',
  };
}

function makeShot(overrides = {}) {
  return {
    shotNumber: 1, type: 'action', duration: '10s', videoModel: 'action',
    description: 'x', characters: ['ARIA'], location: 'lab',
    dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT',
    ...overrides,
  };
}

function touch(p, bytes = PNG) {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, bytes);
}

test('ReferenceStore.referenceSet is referenceSetFromDisk over the project dir', async () => {
  const dir = outDir();
  const series = makeSeries(dir);
  const charDir = getCharacterDir(series, 'ARIA');
  touch(join(charDir, 'front.png'));
  touch(join(charDir, 'profile.png'));
  writeFileSync(join(charDir, 'front.provenance.json'), JSON.stringify({ hasFace: true }));
  const locDir = getLocationDir(series, 'lab');
  touch(join(locDir, 'north.png'));
  touch(join(locDir, 'east.png'));

  const { references } = createCliPorts({ logging: { console: quiet } });
  const shot = makeShot();
  const set = await references.referenceSet(series, shot);
  assert.deepEqual(set, referenceSetFromDisk(series, shot));
  assert.equal(set.characters[0].primary.ref, join(charDir, 'front.png'));
  assert.equal(set.characters[0].primary.hasFace, true);
  assert.deepEqual(set.locations[0].plates.map(p => p.wall), ['north', 'east']);

  const none = await references.referenceSet(series, shot, { characterNames: [] });
  assert.deepEqual(none.characters, []);
});

test('ReferenceStore.read sniffs the real format; url() is the render path\'s data URI', async () => {
  const dir = outDir();
  const png = join(dir, 'front.png');
  touch(png);
  const webpLabelledPng = join(dir, 'actually-webp.png');
  touch(webpLabelledPng, Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'ascii'));

  const { references } = createCliPorts({ logging: { console: quiet } });
  const read = await references.read(png);
  assert.ok(read.bytes instanceof Uint8Array);
  assert.deepEqual(Buffer.from(read.bytes), PNG);
  assert.equal(read.mimeType, 'image/png');
  assert.equal((await references.read(webpLabelledPng)).mimeType, 'image/webp');

  assert.equal(await references.url(png), `data:image/png;base64,${PNG.toString('base64')}`);
  await assert.rejects(references.read(join(dir, 'missing.png')));
  await assert.rejects(references.url(join(dir, 'missing.png')));
});

// ---- VisionJudge ---------------------------------------------------------------

test('VisionJudge.judge sends image refs as PNG data URIs through chatJson, verbatim otherwise', async () => {
  const dir = outDir();
  const a = join(dir, 'a.png');
  const b = join(dir, 'b.png');
  touch(a);
  touch(b, Buffer.concat([PNG, Buffer.from([1])]));
  const client = fakeClient({ chat: [{ verdict: 'PASS' }] });
  const { vision } = createCliPorts({ client, logging: { console: quiet } });

  const reply = await vision.judge({
    model: 'm', systemPrompt: 'sys', userPrompt: 'user', images: [a, b],
    maxTokens: 2000, temperature: 0.2, label: 'unit u1 identity QA',
  });
  assert.deepEqual(reply, { verdict: 'PASS' });
  assert.deepEqual(client.calls.chat, [{
    model: 'm', systemPrompt: 'sys', userPrompt: 'user',
    images: [
      `data:image/png;base64,${readFileSync(a).toString('base64')}`,
      `data:image/png;base64,${readFileSync(b).toString('base64')}`,
    ],
    maxTokens: 2000, temperature: 0.2, label: 'unit u1 identity QA',
  }]);

  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(vision.judge({ model: 'm', systemPrompt: 's', userPrompt: 'u', images: [], signal: ctl.signal }), OperationAbortedError);
  assert.equal(client.calls.chat.length, 1);
});

// ---- VideoBackend: re-attach contract ------------------------------------------

test('queue records the pending job before it resolves; a new process finds and resumes it without re-queueing', async () => {
  const dir = outDir();
  const outputKey = join(dir, 'scene-001', 'shot-001.mp4');
  const client = fakeClient({ queue: [{ model: MODEL, queue_id: 'q-1' }] });
  const ports = createCliPorts({ client, logging: { console: quiet } });

  assert.equal(await ports.video.findPending(outputKey), undefined);
  const handle = await ports.video.queue(request(), { outputKey, project: dir, episode: 1 });
  assert.equal(client.calls.queue.length, 1);
  assert.deepEqual(client.calls.queue[0], request());
  assert.equal(handle.queueId, 'q-1');
  assert.equal(handle.model, MODEL);
  assert.equal(handle.outputKey, outputKey);
  assert.equal(handle.resumed, false);
  assert.ok(!Number.isNaN(Date.parse(handle.queuedAt)));

  const recorded = await pendingFor(outputKey);
  assert.equal(recorded.queueId, 'q-1');
  assert.equal(recorded.kind, 'video');
  assert.equal(recorded.episode, 1);

  // "Next run": fresh ports, same registry.
  const nextClient = fakeClient();
  const next = createCliPorts({ client: nextClient, logging: { console: quiet } });
  const found = await next.video.findPending(outputKey);
  assert.equal(found.queueId, 'q-1');
  assert.equal(found.resumed, true);
  const resumed = await next.video.resume(found);
  assert.equal(resumed.resumed, true);
  assert.equal(nextClient.calls.queue.length, 0, 'resume never re-submits');
});

test('relative and absolute output keys address the same pending record', async () => {
  const dir = outDir();
  const abs = join(dir, 'shot-002.mp4');
  await recordPendingJob({ kind: 'video', model: MODEL, queueId: 'q-rel', outputPath: abs });
  const { video } = createCliPorts({ client: fakeClient(), logging: { console: quiet } });
  assert.equal((await video.findPending(relative(process.cwd(), abs))).queueId, 'q-rel');
  assert.equal((await video.findPending(abs)).queueId, 'q-rel');
});

test('findPending ignores audio jobs', async () => {
  const dir = outDir();
  const audioKey = join(dir, 'cue.mp3');
  await recordPendingJob({ kind: 'audio', model: 'elevenlabs-music', queueId: 'a-1', outputPath: audioKey });
  const { video } = createCliPorts({ client: fakeClient(), logging: { console: quiet } });
  assert.equal(await video.findPending(audioKey), undefined);
});

test('queue validates duration before any call: an off-ladder request never reaches Venice', async () => {
  const dir = outDir();
  const client = fakeClient({ queue: [{ model: MODEL, queue_id: 'never' }] });
  const { video } = createCliPorts({ client, logging: { console: quiet } });
  const outputKey = join(dir, 'shot-003.mp4');
  await assert.rejects(video.queue(request({ duration: '99s' }), { outputKey }), VideoRequestValidationError);
  assert.equal(client.calls.queue.length, 0);
  assert.equal(await pendingFor(outputKey), undefined);
});

test('queue is not retried on a 5xx and records nothing when it fails', async () => {
  const dir = outDir();
  const client = fakeClient({ queue: [new VeniceRequestError('boom', 503, {})] });
  const { video } = createCliPorts({ client, logging: { console: quiet } });
  const outputKey = join(dir, 'shot-004.mp4');
  const savedError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(video.queue(request(), { outputKey }), err => err.status === 503);
  } finally {
    console.error = savedError;
  }
  assert.equal(client.calls.queue.length, 1);
  assert.equal(await pendingFor(outputKey), undefined);
});

test('queue resubmits once with Seedance consent on 409 needs_consent (the render path\'s handshake)', async () => {
  const dir = outDir();
  const client = fakeClient({
    queue: [
      new VeniceRequestError('consent', 409, { error: { code: 'needs_consent' } }),
      { model: MODEL, queue_id: 'q-consent' },
    ],
  });
  const { video } = createCliPorts({ client, logging: { console: quiet } });
  const savedLog = console.log;
  console.log = () => {};
  let handle;
  try {
    handle = await video.queue(request(), { outputKey: join(dir, 'shot-005.mp4') });
  } finally {
    console.log = savedLog;
  }
  assert.equal(handle.queueId, 'q-consent');
  assert.equal(client.calls.queue.length, 2);
  assert.equal(client.calls.queue[0].consents, undefined);
  assert.deepEqual(client.calls.queue[1].consents, {
    seedance: {
      confirmed_terms_and_privacy: true,
      confirmed_legal_right: true,
      confirmed_screening_acknowledged: true,
    },
  });
});

test('retrieve: processing refreshes the heartbeat; FAILED is reported and leaves the record for the caller', async () => {
  const dir = outDir();
  const outputKey = join(dir, 'shot-006.mp4');
  const client = fakeClient({
    queue: [{ model: MODEL, queue_id: 'q-6' }],
    retrieve: [
      { status: 'PROCESSING', average_execution_time: 1, execution_duration: 2 },
      { status: 'FAILED', error: 'Content policy' },
    ],
  });
  const { video } = createCliPorts({ client, logging: { console: quiet } });
  const handle = await video.queue(request(), { outputKey });
  const before = (await pendingFor(outputKey)).updatedAt;
  await new Promise(r => setTimeout(r, 5));

  const first = await video.retrieve(handle);
  assert.equal(first.kind, 'processing');
  assert.equal(first.status.status, 'PROCESSING');
  assert.deepEqual(client.calls.retrieve[0], { model: MODEL, queue_id: 'q-6' });
  assert.ok((await pendingFor(outputKey)).updatedAt > before, 'heartbeat bumped');

  const second = await video.retrieve(handle);
  assert.equal(second.kind, 'failed');
  assert.equal(second.status, 'FAILED');
  assert.equal(second.detail, 'Content policy');
  assert.ok(await pendingFor(outputKey), 'retrieve never clears; the loop decides');

  await video.clearPending(outputKey);
  assert.equal(await pendingFor(outputKey), undefined);
});

test('ready -> download archives the prior file, writes, clears the record; complete is best-effort', async () => {
  const dir = outDir();
  const outputKey = join(dir, 'shot-007.mp4');
  writeFileSync(outputKey, 'old take');
  const mp4 = Buffer.from('fresh mp4 bytes');
  const client = fakeClient({
    queue: [{ model: MODEL, queue_id: 'q-7' }],
    retrieve: [mp4],
    complete: [new Error('cleanup endpoint down')],
  });
  const { video } = createCliPorts({ client, logging: { console: quiet } });
  const handle = await video.queue(request(), { outputKey });

  const result = await video.retrieve(handle);
  assert.equal(result.kind, 'ready');
  assert.ok(result.bytes instanceof Uint8Array);
  assert.equal(result.contentType, 'video/mp4');

  const saved = await video.download(handle, { bytes: result.bytes });
  assert.equal(saved.ref, outputKey);
  assert.equal(saved.sizeBytes, mp4.length);
  assert.equal(saved.archivedRef, join(dir, 'shot-007-v1.mp4'));
  assert.equal(readFileSync(outputKey, 'utf-8'), 'fresh mp4 bytes');
  assert.equal(readFileSync(saved.archivedRef, 'utf-8'), 'old take');
  assert.equal(await pendingFor(outputKey), undefined);
  assert.equal(await video.findPending(outputKey), undefined);

  await video.complete(handle);
  assert.deepEqual(client.calls.complete, [{ model: MODEL, queue_id: 'q-7' }]);

  // A second take archives to the next free version.
  const again = await video.download(handle, { bytes: Buffer.from('third') });
  assert.equal(again.archivedRef, join(dir, 'shot-007-v2.mp4'));
});

test('a reaped queue id is "gone" only on a resumed handle; on a fresh handle the error surfaces', async () => {
  const dir = outDir();
  const outputKey = join(dir, 'shot-008.mp4');
  await recordPendingJob({ kind: 'video', model: MODEL, queueId: 'q-dead', outputPath: outputKey });
  const client = fakeClient({ retrieve: [new VeniceRequestError('not found', 404, {})] });
  const { video } = createCliPorts({ client, logging: { console: quiet } });

  const handle = await video.resume(await video.findPending(outputKey));
  assert.deepEqual(await video.retrieve(handle), { kind: 'gone', status: 404 });

  await assert.rejects(video.retrieve({ ...handle, resumed: false }), err => err.status === 404);
});

test('cancelling a retrieve rejects and leaves the record, so the next run re-attaches', async () => {
  const dir = outDir();
  const outputKey = join(dir, 'shot-009.mp4');
  const client = fakeClient({ queue: [{ model: MODEL, queue_id: 'q-9' }] });
  const { video } = createCliPorts({ client, logging: { console: quiet } });
  const handle = await video.queue(request(), { outputKey });

  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(video.retrieve(handle, { signal: ctl.signal }), OperationAbortedError);
  assert.equal(client.calls.retrieve.length, 0);
  assert.equal((await video.findPending(outputKey)).queueId, 'q-9');
});

test('quote validates first, then posts the request as given', async () => {
  const client = fakeClient();
  const { video } = createCliPorts({ client, logging: { console: quiet } });
  await assert.rejects(video.quote({ model: MODEL, duration: '99s' }), VideoRequestValidationError);
  assert.equal(client.calls.quote.length, 0);
  assert.deepEqual(await video.quote({ model: MODEL, duration: '10s' }), { quote: 1.25 });
  assert.deepEqual(client.calls.quote, [{ model: MODEL, duration: '10s' }]);
});

// ---- ImageProbe (ffmpeg) -------------------------------------------------------

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

test('ImageProbe over ffmpeg: duration, frames at a time and from the end, dimensions, luma windows', { skip: !hasFfmpeg && 'ffmpeg not on PATH' }, async () => {
  const dir = outDir();
  const clip = join(dir, 'clip.mp4');
  const made = spawnSync('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=64x36:r=24:d=2',
    '-pix_fmt', 'yuv420p', clip,
  ]);
  assert.equal(made.status, 0, String(made.stderr));

  const { images } = createCliPorts({ framesDir: join(dir, 'frames'), logging: { console: quiet } });
  const duration = await images.clipDuration(clip);
  assert.ok(Math.abs(duration - 2) < 0.1, `duration ${duration}`);
  assert.equal(await images.clipDuration(join(dir, 'nope.mp4')), 0);

  const at = await images.extractFrame(clip, { atSec: 0.5 });
  assert.ok(existsSync(at));
  assert.deepEqual(await images.imageInfo(at), { width: 64, height: 36 });

  const named = join(dir, 'last.png');
  assert.equal(await images.extractFrame(clip, { fromEndSec: 0 }, { outputRef: named }), named);
  assert.ok(existsSync(named));

  await assert.rejects(images.extractFrame(join(dir, 'nope.mp4'), { atSec: 0 }));
  assert.equal(await images.imageInfo(join(dir, 'nope.png')), undefined);

  const head = await images.frameLumas(clip, { frames: 6 });
  assert.equal(head.length, 6);
  for (const y of head) assert.ok(y > 100 && y < 150, `gray luma ${y}`);
  const mid = await images.frameLumas(clip, { startSec: 1, frames: 3 });
  assert.equal(mid.length, 3);
  const one = await images.frameLumas(clip, { startSec: 1, frames: 1 });
  assert.equal(one.length, 1);
  assert.deepEqual(await images.frameLumas(join(dir, 'nope.mp4'), { frames: 3 }), []);
});
