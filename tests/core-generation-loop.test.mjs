// Core's episode generation loop (packages/core/src/mini-drama/generation-loop.ts)
// over a recording renderer and a fake clock. No files, no renders.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runGenerationUnits,
  resolveUnitShots,
  MULTISHOT_RETRY_DELAY_MS,
} from 'venice-video-harness/core';

const MODEL = 'seedance-2-5-reference-to-video';
const shot = (shotNumber, over = {}) => ({ shotNumber, duration: '5s', type: 'action', characters: ['MARA'], description: '', ...over });
const unit = (unitId, unitType, shotNumbers, over = {}) => ({ unitId, unitType, model: MODEL, duration: '5s', shotNumbers, outputFile: `${unitId}.mp4`, ...over });

function harness(renderer = {}) {
  const lines = [];
  const progress = [];
  const sleeps = [];
  const calls = [];
  const ports = {
    logger: {
      debug() {},
      info: m => lines.push(`info ${m}`),
      warn: m => lines.push(`warn ${m}`),
      error: m => lines.push(`error ${m}`),
      progress: u => progress.push(u),
    },
    clock: { now: () => new Date(0), sleep: async ms => { sleeps.push(ms); } },
  };
  const r = {
    async single(s, u, ctx) { calls.push(['single', u.unitId, s.shotNumber, ctx]); return [`${u.unitId}/shot-${s.shotNumber}.mp4`]; },
    async multishot(ss, u, ctx) { calls.push(['multishot', u.unitId, ss.map(s => s.shotNumber), ctx]); return ss.map(s => `${u.unitId}/shot-${s.shotNumber}.mp4`); },
    async montage(ss, u, ctx) { calls.push(['montage', u.unitId, ss.map(s => s.shotNumber), ctx]); return ss.map(s => `${u.unitId}/shot-${s.shotNumber}.mp4`); },
    isFinalError: () => false,
    ...renderer,
  };
  return { ports, renderer: r, lines, progress, sleeps, calls };
}

test('units render in order with the chaining context carried between them', async () => {
  const h = harness({ async single(s, u, ctx) { h.calls.push(['single', u.unitId, s.shotNumber, ctx]); return u.unitId === 'u3' ? [] : [`${u.unitId}.mp4`]; } });
  const shots = [shot(1), shot(2), shot(3), shot(4)];
  const plan = { units: [unit('u1', 'single', [1]), unit('u2', 'multishot', [2, 3], { duration: '10s' }), unit('u3', 'single', [4])] };
  const result = await runGenerationUnits(h.ports, h.renderer, shots, plan);

  assert.deepEqual(result.videoPaths, ['u1.mp4', 'u2/shot-2.mp4', 'u2/shot-3.mp4']);
  assert.equal(result.plan, plan);
  const [first, second, third] = h.calls;
  assert.deepEqual(first[3], { previousRenderedShot: undefined, previousShot: undefined, nextShotNumber: 2 });
  assert.deepEqual(second[3], { previousRenderedShot: 'u1.mp4', previousShot: shots[0], nextShotNumber: 4 });
  assert.deepEqual(third[3], { previousRenderedShot: 'u2/shot-3.mp4', previousShot: shots[2], nextShotNumber: undefined });
  assert.deepEqual(h.progress.map(p => p.detail), ['unit 1/3 · shot 1', 'unit 2/3 · shot 2', 'unit 3/3 · shot 4']);
  assert.equal(h.lines.filter(l => l === 'info ').length, 3);
});

test('a duration the model cannot render fails before any unit runs', async () => {
  const h = harness();
  const plan = { units: [unit('u1', 'single', [1], { model: 'veo3.1-fast-image-to-video', duration: '3s' })] };
  await assert.rejects(runGenerationUnits(h.ports, h.renderer, [shot(1, { duration: '3s' })], plan));
  assert.equal(h.calls.length, 0);
});

test('suffixed inserts resolve by cursor, not by number', () => {
  const shots = [shot(13), { ...shot(13), shotLabel: '13b' }, shot(14)];
  const plan = { units: [unit('a', 'single', [13]), unit('b', 'single', [13]), unit('c', 'single', [14, 99])] };
  const resolved = resolveUnitShots(shots, plan);
  assert.equal(resolved[0][0], shots[0]);
  assert.equal(resolved[1][0], shots[1]);
  assert.deepEqual(resolved[2], [shots[2]]);
});

test('a failed multi-shot attempt is retried after the delay; HTTP errors log their body', async () => {
  let attempts = 0;
  const httpErr = Object.assign(new Error('Venice API error 500'), { status: 500, body: { error: 'upstream' } });
  const h = harness({
    async multishot(ss, u) {
      attempts += 1;
      if (attempts === 1) throw httpErr;
      if (attempts === 2) throw new Error('timeout');
      return ss.map(s => `${u.unitId}/${s.shotNumber}.mp4`);
    },
    describeHttpError: err => (err === httpErr ? { status: 500, message: err.message, body: err.body } : undefined),
  });
  const plan = { units: [unit('u1', 'multishot', [1, 2], { duration: '10s' })] };
  const result = await runGenerationUnits(h.ports, h.renderer, [shot(1), shot(2)], plan);
  assert.deepEqual(result.videoPaths, ['u1/1.mp4', 'u1/2.mp4']);
  assert.deepEqual(h.sleeps, [MULTISHOT_RETRY_DELAY_MS, MULTISHOT_RETRY_DELAY_MS]);
  assert.deepEqual(h.lines.filter(l => l !== 'info '), [
    'warn   u1: multi-shot attempt 1 failed (HTTP 500): Venice API error 500',
    'warn   Error body: {\n  "error": "upstream"\n}',
    'warn   u1: keeping multi-shot strategy, retrying in 15s',
    'info   u1: retrying multi-shot render (attempt 2)',
    'warn   u1: multi-shot attempt 2 failed - Error: timeout',
    'warn   u1: keeping multi-shot strategy, retrying in 15s',
    'info   u1: retrying multi-shot render (attempt 3)',
  ]);
});

test('a final error ends the multi-shot unit and the loop; single and montage errors are never retried', async () => {
  const refusal = new Error('refused');
  const h = harness({ async multishot() { throw refusal; }, isFinalError: err => err === refusal });
  const plan = { units: [unit('u1', 'multishot', [1, 2], { duration: '10s' }), unit('u2', 'single', [3])] };
  await assert.rejects(runGenerationUnits(h.ports, h.renderer, [shot(1), shot(2), shot(3)], plan), refusal);
  assert.deepEqual(h.sleeps, []);

  const boom = new Error('boom');
  const m = harness({ async montage() { throw boom; } });
  await assert.rejects(
    runGenerationUnits(m.ports, m.renderer, [shot(1), shot(2)], { units: [unit('m1', 'montage', [1, 2], { duration: '10s' })] }),
    boom,
  );
  assert.deepEqual(m.sleeps, []);
});
