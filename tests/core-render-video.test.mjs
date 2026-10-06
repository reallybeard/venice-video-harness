// Core's one-render pipeline (packages/core/src/mini-drama/render-video.ts)
// over in-memory ports and media callbacks. No files, no ffmpeg, no network:
// refs are plain strings, "stored" refs are a Set, waits resolve at once.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderVideo,
  prepareVideoRequest,
  assertFacesOffRequest,
  videoRenderRecipePass,
  FacesOffModelError,
  VideoGenerationFailedError,
} from 'venice-video-harness/core';

const READY = { kind: 'ready', bytes: new Uint8Array(2 * 1024 * 1024), contentType: 'video/mp4' };
const PROCESSING = { kind: 'processing', status: { status: 'PROCESSING', execution_duration: 4000 } };

function harness({ stored = [], faces = {}, durations = {}, pending, script = [PROCESSING, READY], padFails = false } = {}) {
  const store = new Set(stored);
  const lines = [];
  const calls = [];
  const sleeps = [];
  const recipes = [];
  const records = new Map();
  let queued = 0;
  let retrieves = 0;
  if (pending) records.set(pending.outputKey, pending);

  const logger = {
    debug() {},
    info: m => lines.push(`info ${m}`),
    warn: m => lines.push(`warn ${m}`),
    error: m => lines.push(`error ${m}`),
  };
  const ports = {
    logger,
    clock: { now: () => new Date(0), sleep: async ms => { sleeps.push(ms); } },
    references: {
      async url(ref) {
        calls.push(['url', ref]);
        if (!store.has(ref)) throw new Error(`ENOENT ${ref}`);
        return `data:image/png;base64,<${ref}>`;
      },
    },
    video: {
      async quote() { throw new Error('not used'); },
      async findPending(key) { calls.push(['findPending', key]); return records.get(key); },
      async resume(handle) { calls.push(['resume', handle.queueId]); return { ...handle, resumed: true }; },
      async queue(request, target) {
        queued += 1;
        calls.push(['queue', request]);
        const handle = { outputKey: target.outputKey, model: request.model, queueId: `q-${queued}`, queuedAt: 'T', resumed: false };
        records.set(target.outputKey, handle);
        return handle;
      },
      async retrieve(handle) {
        calls.push(['retrieve', handle.queueId]);
        if (handle.resumed && handle.queueId === 'q-gone') return { kind: 'gone', status: 404 };
        const a = script[Math.min(retrieves, script.length - 1)];
        retrieves += 1;
        if (a instanceof Error) throw a;
        return a;
      },
      async download(handle, media) {
        calls.push(['download', handle.queueId]);
        records.delete(handle.outputKey);
        return { ref: handle.outputKey, sizeBytes: media.bytes.length };
      },
      async complete(handle) { calls.push(['complete', handle.queueId]); },
      async clearPending(key) { calls.push(['clearPending', key]); records.delete(key); },
    },
  };
  const media = {
    async exists(ref) { return store.has(ref); },
    async hasFace(ref) { calls.push(['hasFace', ref]); return faces[ref]; },
    async audioUrl(ref, mime) { return store.has(ref) ? `data:${mime};base64,<${ref}>` : undefined; },
    async audioDurationSec(ref) {
      if (!(ref in durations)) throw new Error(`cannot probe ${ref}`);
      return durations[ref];
    },
    async padAudioForModel(model, ref) {
      calls.push(['pad', model, ref]);
      if (padFails) throw new Error('ffmpeg missing');
      const padded = `${ref}.padded.mp3`;
      store.add(padded);
      return { ref: padded, padded: true, durationSec: 3 };
    },
    async padLipSyncAudio(ref, targetSec) {
      calls.push(['padLipSync', ref, targetSec]);
      const wav = `${ref}.wav`;
      store.add(wav);
      return wav;
    },
    async appendRecipe(key, pass) { recipes.push([key, pass]); },
  };
  return { ports, media, lines, calls, sleeps, recipes, records, queuedBodies: () => calls.filter(c => c[0] === 'queue').map(c => c[1]) };
}

const R2V = 'seedance-2-5-reference-to-video';
const slots = n => Array.from({ length: n }, (_, i) => ({ ref: `ref-${i + 1}.png`, role: 'character', label: `C${i + 1}` }));

test('R2V: pure reference mode, refs through references.url, a missing ref sent raw, recipe written', async () => {
  const h = harness({ stored: ['ref-1.png', 'ref-2.png', 'panel.png'] });
  const request = {
    prompt: { model: R2V, prompt: '@Image1 walks.', duration: '5s', audio: true, referenceSlots: slots(3) },
    outputKey: 'out/shot-001.mp4',
    anchorImage: 'panel.png',
    referenceImages: ['ref-1.png', 'ref-2.png', 'ref-3.png'],
    aspectRatio: '16:9',
    project: 'demo',
    episode: 1,
  };
  const result = await renderVideo(h.ports, h.media, request);
  const [body] = h.queuedBodies();
  assert.equal(body.image_url, undefined);
  assert.deepEqual(body.reference_image_urls, ['data:image/png;base64,<ref-1.png>', 'data:image/png;base64,<ref-2.png>', 'ref-3.png']);
  assert.ok(!h.calls.some(c => c[0] === 'url' && c[1] === 'panel.png'), 'the start frame is not read in pure reference mode');
  assert.ok(!h.calls.some(c => c[0] === 'url' && c[1] === 'ref-3.png'), 'a missing ref is not read');
  assert.deepEqual(h.sleeps, [10_000, 10_000]);
  assert.ok(h.lines.includes('info   Queueing video: model=seedance-2-5-reference-to-video, duration=5s, aspect=16:9, prompt=14 chars'));
  assert.ok(h.lines.includes('info   Video saved: out/shot-001.mp4 (2.0 MB, 20s)'));
  assert.deepEqual(h.calls.slice(-2).map(c => c[0]), ['download', 'complete']);
  assert.equal(h.recipes.length, 1);
  assert.equal(h.recipes[0][0], 'out/shot-001.mp4');
  assert.equal(h.recipes[0][1].role, 'identity');
  assert.deepEqual(h.recipes[0][1].referenceImagePaths, ['ref-1.png', 'ref-2.png', 'ref-3.png']);
  assert.equal(result.recipe, h.recipes[0][1]);
  assert.equal(result.job.handle.queueId, 'q-1');
});

test('i2v: start and end frames resolved only when stored; a content pass when nothing anchors identity', async () => {
  const h = harness({ stored: ['a.png', 'b.png'] });
  const prompt = { model: 'kling-v3-pro-image-to-video', prompt: 'p', duration: '5s', audio: true };
  const body = await prepareVideoRequest(h.ports, h.media, { prompt, outputKey: 'o.mp4', anchorImage: 'a.png', endFrameImage: 'b.png' });
  assert.equal(body.image_url, 'data:image/png;base64,<a.png>');
  assert.equal(body.end_image_url, 'data:image/png;base64,<b.png>');
  const missing = await prepareVideoRequest(h.ports, h.media, { prompt, outputKey: 'o.mp4', anchorImage: 'gone.png' });
  assert.equal(missing.image_url, undefined);
  assert.equal(videoRenderRecipePass({ prompt, outputKey: 'o.mp4', anchorImage: 'a.png' }, body).role, 'content');
});

test('faces-off: a person on a -basic id is refused before any read or queue; data: and URL refs are not inspected', async () => {
  const h = harness({ stored: ['panel.png'], faces: { 'panel.png': true } });
  const request = {
    prompt: { model: 'seedance-2-0-image-to-video-basic', prompt: 'p', duration: '5s', audio: true },
    outputKey: 'o.mp4',
    anchorImage: 'panel.png',
    referenceImages: ['panel.png', 'data:image/png;base64,AA', 'https://x/y.png'],
    characters: ['MARA'],
  };
  await assert.rejects(renderVideo(h.ports, h.media, request), FacesOffModelError);
  assert.deepEqual(h.calls, [['hasFace', 'panel.png']]);

  const clear = harness({ faces: { 'plate.png': false } });
  await assertFacesOffRequest(clear.media, { prompt: { model: 'seedance-2-0-image-to-video-basic' }, anchorImage: 'plate.png' });
  const notFacesOff = harness();
  await assertFacesOffRequest(notFacesOff.media, { prompt: { model: R2V }, anchorImage: 'p.png', characters: ['MARA'] });
  assert.deepEqual(notFacesOff.calls, [], 'provenance is only read on a faces-off model');
});

test('dialogue audio: padded to the model minimum for audio_url; a failed pad falls back to the ready audioUrl', async () => {
  const model = 'wan-2-7-image-to-video';
  const h = harness({ stored: ['p.png', 'line.mp3'] });
  const prompt = { model, prompt: 'p', duration: '5s', audio: true };
  const body = await prepareVideoRequest(h.ports, h.media, { prompt, outputKey: 'o.mp4', anchorImage: 'p.png', dialogueAudio: 'line.mp3' });
  assert.equal(body.audio_url, 'data:audio/mpeg;base64,<line.mp3.padded.mp3>');
  assert.ok(h.lines.includes(`info   Padded line.mp3 -> line.mp3.padded.mp3 (3.00s) for ${model}.`));

  const f = harness({ stored: ['p.png'], padFails: true });
  const fallback = await prepareVideoRequest(f.ports, f.media, {
    prompt, outputKey: 'o.mp4', anchorImage: 'p.png', dialogueAudio: 'line.mp3', audioUrl: 'data:audio/mpeg;base64,RAW',
  });
  assert.equal(fallback.audio_url, 'data:audio/mpeg;base64,RAW');
  assert.ok(f.lines.includes('warn   Wan audio pre-flight failed (ffmpeg missing). Falling back to raw audioUrl.'));
});

test('voice references: missing and unprobeable clips skipped, data: URIs pass, only alongside a reference image', async () => {
  const h = harness({ stored: ['ref-1.png', 'v1.mp3', 'v2.wav', 'bad.mp3'], durations: { 'v1.mp3': 4, 'v2.wav': 3 } });
  const prompt = { model: R2V, prompt: 'p', duration: '5s', audio: true, referenceSlots: slots(1) };
  const body = await prepareVideoRequest(h.ports, h.media, {
    prompt, outputKey: 'o.mp4', referenceImages: ['ref-1.png'],
    voiceReferences: ['v1.mp3', 'missing.mp3', 'bad.mp3', 'v2.wav'],
  });
  assert.deepEqual(body.reference_audio_urls, ['data:audio/mpeg;base64,<v1.mp3>', 'data:audio/wav;base64,<v2.wav>']);
  assert.ok(h.lines.includes('warn   ⚠ Voice reference missing on disk, skipping: missing.mp3'));
  assert.ok(h.lines.includes('warn   ⚠ Could not probe voice reference (cannot probe bad.mp3); skipping bad.mp3'));
  assert.ok(h.lines.includes('info   Reference audio (@Audio1..@Audio2): 2 voice clip(s), 7.00s total'));

  const noRefs = harness({ stored: ['v1.mp3'], durations: { 'v1.mp3': 4 } });
  const bare = await prepareVideoRequest(noRefs.ports, noRefs.media, {
    prompt: { ...prompt, referenceSlots: undefined }, outputKey: 'o.mp4', voiceReferences: ['v1.mp3'],
  });
  assert.equal(bare.reference_audio_urls, undefined);
});

test('lip-sync via reference audio: probed, padded to the planned length as WAV; a missing clip renders without it', async () => {
  const model = 'wan-3-0-reference-to-video';
  const h = harness({ stored: ['ref-1.png', 'line.mp3'], durations: { 'line.mp3': 2.5 } });
  const prompt = { model, prompt: '@Image1 speaks.', duration: '5s', audio: true, referenceSlots: slots(1) };
  const body = await prepareVideoRequest(h.ports, h.media, { prompt, outputKey: 'o.mp4', referenceImages: ['ref-1.png'], dialogueAudio: 'line.mp3' });
  const pad = h.calls.find(c => c[0] === 'padLipSync');
  assert.equal(pad[1], 'line.mp3');
  assert.equal(pad[2], 5);
  assert.deepEqual(body.reference_audio_urls, ['data:audio/wav;base64,<line.mp3.wav>']);

  const m = harness({ stored: ['ref-1.png'] });
  await prepareVideoRequest(m.ports, m.media, { prompt, outputKey: 'o.mp4', referenceImages: ['ref-1.png'], dialogueAudio: 'gone.mp3' });
  assert.ok(m.lines.includes('warn   ⚠ Lip-sync audio missing on disk, rendering without it: gone.mp3'));
});

test('re-attach: a recorded job is resumed, never re-queued', async () => {
  const pending = { outputKey: 'o.mp4', model: R2V, queueId: 'q-recorded', queuedAt: 'T', resumed: true };
  const h = harness({ stored: ['ref-1.png'], pending, script: [READY] });
  const result = await renderVideo(h.ports, h.media, {
    prompt: { model: R2V, prompt: 'p', duration: '5s', audio: true, referenceSlots: slots(1) },
    outputKey: 'o.mp4', referenceImages: ['ref-1.png'],
  });
  assert.equal(h.queuedBodies().length, 0);
  assert.equal(result.job.resumed, true);
  assert.equal(result.job.handle.queueId, 'q-recorded');
});

test('re-attach to a reaped job: the record is cleared and the render runs again from the top, once', async () => {
  const pending = { outputKey: 'o.mp4', model: R2V, queueId: 'q-gone', queuedAt: 'T', resumed: true };
  const h = harness({ stored: ['ref-1.png'], pending, script: [READY] });
  await renderVideo(h.ports, h.media, {
    prompt: { model: R2V, prompt: 'p', duration: '5s', audio: true, referenceSlots: slots(1) },
    outputKey: 'o.mp4', referenceImages: ['ref-1.png'],
  });
  assert.ok(h.lines.includes("warn \n  ⚠ Recorded job q-gone is gone on Venice's side; queueing a fresh generation."));
  assert.equal(h.lines.filter(l => l.startsWith('info   Queueing video:')).length, 2, 'the request is prepared again');
  assert.equal(h.queuedBodies().length, 1);
  assert.equal(h.calls.filter(c => c[0] === 'findPending').length, 1, 'the second run does not look for a record');
  assert.ok(h.calls.some(c => c[0] === 'clearPending'));
});

test('a failed job propagates and writes no recipe; progress reaches onProgress', async () => {
  const failed = { kind: 'failed', status: 'FAILED', detail: 'policy', body: { status: 'FAILED' } };
  const h = harness({ script: [PROCESSING, failed] });
  const progress = [];
  await assert.rejects(
    renderVideo(h.ports, h.media, {
      prompt: { model: 'seedance-2-5-text-to-video', prompt: 'p', duration: '5s', audio: true },
      outputKey: 'o.mp4',
    }, { onProgress: s => progress.push(s.status) }),
    VideoGenerationFailedError,
  );
  assert.deepEqual(progress, ['PROCESSING']);
  assert.equal(h.recipes.length, 0);
});

test('no appendRecipe: the render still completes and returns the pass', async () => {
  const h = harness({ script: [READY] });
  delete h.media.appendRecipe;
  const result = await renderVideo(h.ports, h.media, {
    prompt: { model: 'seedance-2-5-text-to-video', prompt: 'p', duration: '5s', audio: true },
    outputKey: 'o.mp4',
  });
  assert.equal(result.recipe.kind, 'video-generate');
  assert.equal(result.recipe.role, 'content');
});
