// A failed write of a downloaded clip is not a poll error.
//
// `pollRenderedVideo` stored the clip (archive, write, clear the pending
// record) inside the retrieve `try`. A write failure (EACCES, ENOSPC, a bad
// output dir) was counted as a transient poll error; the next retrieve
// succeeded and reset the count, so the 6-error budget never ran out and the
// paid, downloaded clip was fetched again every 10 s until the 60-minute
// deadline: about 360 downloads, then a timeout that blamed the wrong thing.
//
// Drives `renderVideoFile` against a scripted client whose retrieve always
// returns the clip, into a read-only directory. No network. Timers are made
// immediate, so the unfixed loop fails the test in well under a second.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { renderVideoFile } from '../dist/mini-drama/video-generator.js';
import { findPendingJob } from '../dist/venice/job-store.js';

process.env.VENICE_VIDEO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'clip-write-config-'));

const CLIP = Buffer.from('not really an mp4, but bytes all the same');

function clipClient() {
  const calls = { queue: 0, retrieve: 0, complete: 0 };
  return {
    calls,
    async post(path, body) {
      if (path === '/api/v1/video/queue') {
        calls.queue += 1;
        return { queue_id: 'q-1', model: body.model };
      }
      if (path === '/api/v1/video/complete') {
        calls.complete += 1;
        return {};
      }
      throw new Error(`unexpected POST ${path}`);
    },
    async postBinaryOrJson(path) {
      assert.equal(path, '/api/v1/video/retrieve');
      calls.retrieve += 1;
      return { contentType: 'video/mp4', value: CLIP };
    },
  };
}

function immediateTimers() {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...args) => real(fn, 0, ...args);
  return () => { globalThis.setTimeout = real; };
}

async function quiet(fn) {
  const w = console.warn, e = console.error, l = console.log, out = process.stdout.write;
  console.warn = console.error = console.log = () => {};
  process.stdout.write = () => true;
  try { return await fn(); } finally {
    console.warn = w; console.error = e; console.log = l; process.stdout.write = out;
  }
}

test('a clip that cannot be written fails at once: one download, the job stays recorded', {
  skip: process.getuid?.() === 0 ? 'root ignores directory permissions' : false,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'clip-write-'));
  const locked = join(root, 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0o555);
  const outputPath = join(locked, 'out.mp4');
  const client = clipClient();
  const restore = immediateTimers();
  try {
    const outcome = await quiet(() => renderVideoFile(client, {
      prompt: { model: 'seedance-2-5-text-to-video', prompt: 'a lighthouse at dusk', duration: '5s', audio: true },
      outputPath,
      aspectRatio: '16:9',
      project: root,
    }).then(() => ({ kind: 'resolved' }), err => ({ kind: 'threw', err })));

    assert.equal(outcome.kind, 'threw');
    assert.equal(outcome.err.code, 'EACCES', `got ${outcome.err?.constructor?.name}: ${outcome.err?.message}`);
    assert.equal(client.calls.queue, 1);
    assert.equal(client.calls.retrieve, 1, 'the downloaded clip was fetched again after the write failed');
    assert.equal(existsSync(outputPath), false);
    const pending = await findPendingJob(resolve(outputPath));
    assert.equal(pending?.queueId, 'q-1', 'the pending record is kept so the next run re-attaches');
  } finally {
    restore();
    chmodSync(locked, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});
