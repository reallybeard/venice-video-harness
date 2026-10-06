// A cancelled multi-shot unit stops instead of retrying.
//
// `renderMultiShotUnitUntilSuccess` caught every error that wasn't classified
// as final and retried after a plain `setTimeout`. A Ctrl-C (the operation's
// AbortSignal) therefore counted as a failed attempt, and every retry failed
// the same way: the unit spun every 15 s until the process was killed. Two
// paths, both covered:
//
//   - the attempt itself rejects with an abort error;
//   - the attempt fails for another reason (a queue 5xx) after the operator
//     cancelled, and the 15 s wait has to notice the cancel.
//
// Drives `generateEpisodeVideos` with one multi-shot unit and a scripted
// client inside `runInOperation`. No network. The 15 s retry sleep is
// detected rather than waited on, so the unfixed loop fails at once.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateEpisodeVideos } from '../dist/mini-drama/video-generator.js';
import { VeniceRequestError } from '../dist/venice/client.js';
import { OperationAbortedError, isAbortError, runInOperation } from '../dist/venice/operation-context.js';

process.env.VENICE_VIDEO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'multishot-cancel-config-'));

/** MULTISHOT_RETRY_DELAY_MS in video-generator.ts. The poll interval (10 s) is below it. */
const RETRY_DELAY_MS = 15_000;

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);

const series = () => ({
  name: 'S', slug: 's', concept: 'c', genre: 'drama', setting: 's',
  aesthetic: { style: 'Cinematic', palette: 'warm', lighting: 'natural', lensCharacteristics: 'shallow', filmStock: 'digital' },
  storyboardAspectRatio: '16:9',
  characters: [],
  locations: [],
  episodes: [],
  videoDefaults: {
    imageDefaults: { generationModel: 'nano-banana-2', editModel: 'nano-banana-2-edit' },
  },
  outputDir: '/tmp/unused',
  createdAt: '', updatedAt: '',
});

const shot = (shotNumber) => ({
  shotNumber, type: 'action', duration: '5s', videoModel: 'action',
  environment: 'DAY_EXTERIOR', description: `beat ${shotNumber}`, characters: [],
  cameraMovement: 'static', transition: 'CUT',
});

const plan = {
  units: [{
    unitId: 'unit-001', unitType: 'multishot', shotNumbers: [1, 2], outputFile: 'unit-001.mp4',
    model: 'seedance-2-5-reference-to-video', duration: '10s', startFrameStrategy: 'panel', endFrameStrategy: 'natural',
    decisionReasons: [], fallbackToSingles: false,
  }],
};

function sceneWithPanel() {
  const dir = mkdtempSync(join(tmpdir(), 'multishot-cancel-'));
  writeFileSync(join(dir, 'shot-001.png'), PNG);
  writeFileSync(join(dir, 'shot-001.provenance.json'), JSON.stringify({ generationModel: 'nano-banana-2', editModels: [], hasFace: false }));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Every queue call runs `onQueue`, which throws; nothing is ever retrieved. */
function failingQueueClient(onQueue) {
  const queued = [];
  return {
    queued,
    async post(path, body) {
      assert.equal(path, '/api/v1/video/queue', `unexpected POST ${path}`);
      queued.push(body);
      return onQueue();
    },
    async postBinaryOrJson(path) {
      throw new Error(`unexpected retrieve ${path}`);
    },
  };
}

/** Timers fire at once, except the multi-shot retry sleep, which resolves `retried` instead. */
function immediateTimers() {
  const real = globalThis.setTimeout;
  let markRetried;
  const retried = new Promise(r => { markRetried = r; });
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms >= RETRY_DELAY_MS) {
      markRetried();
      return real(() => {}, 0);
    }
    return real(fn, 0, ...args);
  };
  return { retried, restore: () => { globalThis.setTimeout = real; } };
}

function quiet(fn) {
  const w = console.warn, e = console.error, l = console.log;
  console.warn = console.error = console.log = () => {};
  return fn().finally(() => { console.warn = w; console.error = e; console.log = l; });
}

async function runCancelled(controller, client, dir) {
  const timers = immediateTimers();
  try {
    return await quiet(() => Promise.race([
      runInOperation({ signal: controller.signal }, () =>
        generateEpisodeVideos(client, series(), [shot(1), shot(2)], dir, plan))
        .then(() => ({ kind: 'resolved' }), err => ({ kind: 'threw', err })),
      timers.retried.then(() => ({ kind: 'retried' })),
    ]));
  } finally {
    timers.restore();
  }
}

test('an attempt that rejects with an abort error stops the unit', async () => {
  const { dir, cleanup } = sceneWithPanel();
  try {
    const controller = new AbortController();
    const client = failingQueueClient(() => {
      controller.abort();
      throw new OperationAbortedError();
    });
    const outcome = await runCancelled(controller, client, dir);
    assert.notEqual(outcome.kind, 'retried', 'a cancelled attempt was rescheduled as a failure');
    assert.equal(outcome.kind, 'threw');
    assert.ok(isAbortError(outcome.err), `got ${outcome.err?.constructor?.name}: ${outcome.err?.message}`);
    assert.equal(client.queued.length, 1);
  } finally {
    cleanup();
  }
});

test('a cancel during a failing attempt ends the retry wait', async () => {
  const { dir, cleanup } = sceneWithPanel();
  try {
    const controller = new AbortController();
    const client = failingQueueClient(() => {
      controller.abort();
      throw new VeniceRequestError('Internal Server Error', 500, { error: 'boom' });
    });
    const outcome = await runCancelled(controller, client, dir);
    assert.notEqual(outcome.kind, 'retried', 'the unit waited 15 s to retry a cancelled operation');
    assert.equal(outcome.kind, 'threw');
    assert.ok(isAbortError(outcome.err), `got ${outcome.err?.constructor?.name}: ${outcome.err?.message}`);
    assert.equal(client.queued.length, 1);
  } finally {
    cleanup();
  }
});
