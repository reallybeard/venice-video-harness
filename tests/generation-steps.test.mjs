// The generation steps in core (packages/core/src/mini-drama/generation-steps.ts):
// pure per-unit decisions a host calls while it walks the plan its own way.
// The CLI's walk (generateEpisodeVideos) is pinned by
// tests/generation-loop-golden.test.mjs; this file pins the steps alone.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MULTISHOT_RETRY_DELAY_MS,
  generationUnitContext,
  isFinalMultiShotError,
  renderFailureDisposition,
  resolveUnitShots,
  unitFrameTargets,
} from '../packages/core/dist/mini-drama/generation-steps.js';
import { FacesOffModelError } from '../packages/core/dist/venice/faces-off.js';
import { VideoGenerationFailedError } from '../packages/core/dist/venice/video-errors.js';
import { VideoJobGoneError, VideoJobPollError, VideoJobTimeoutError } from '../packages/core/dist/venice/render-job.js';
import { VideoRefusalError } from '../dist/mini-drama/video-generator.js';
import { OperationAbortedError } from '../dist/venice/operation-context.js';
import { VeniceRequestError } from '../dist/venice/client.js';
import * as barrel from '../packages/core/dist/index.js';

const shot = (shotNumber, extra = {}) => ({ shotNumber, type: 'action', duration: '5s', description: `beat ${shotNumber}`, characters: [], ...extra });
const unit = (unitId, shotNumbers, extra = {}) => ({
  unitId, unitType: shotNumbers.length > 1 ? 'multishot' : 'single', shotNumbers, outputFile: `${unitId}.mp4`,
  model: 'm', duration: '5s', startFrameStrategy: 'panel', endFrameStrategy: 'natural', decisionReasons: [], fallbackToSingles: false,
  ...extra,
});

test('MULTISHOT_RETRY_DELAY_MS is the CLI wait, 15s', () => {
  assert.equal(MULTISHOT_RETRY_DELAY_MS, 15_000);
});

test('resolveUnitShots: a cursor keeps an insert ("13b") apart from its base shot; unknown numbers drop', () => {
  const base = shot(13, { description: 'base' });
  const insert = shot(13, { description: 'insert' });
  const shots = [shot(12), base, insert, shot(14)];
  const plan = { units: [unit('u1', [12, 13]), unit('u2', [13]), unit('u3', [14, 99])] };
  const resolved = resolveUnitShots(shots, plan);
  assert.deepEqual(resolved.map(list => list.map(s => s.description)), [['beat 12', 'base'], ['insert'], ['beat 14']]);
});

test('generationUnitContext: the last clip so far, the last shot of the nearest unit with shots, the next first shot', () => {
  const shots = [shot(1), shot(2), shot(3), shot(4)];
  const plan = { units: [unit('u1', [1, 2]), unit('u2', [77]), unit('u3', [3]), unit('u4', [4])] };
  const unitShots = resolveUnitShots(shots, plan);

  assert.deepEqual(generationUnitContext(plan, unitShots, 0, []), {
    previousRenderedShot: undefined, previousShot: undefined, nextShotNumber: 77,
  });
  // u2 resolves to no shots; u3's previous shot skips it back to u1's last.
  const ctx = generationUnitContext(plan, unitShots, 2, ['a.mp4', 'b.mp4']);
  assert.equal(ctx.previousRenderedShot, 'b.mp4');
  assert.equal(ctx.previousShot, shots[1]);
  assert.equal(ctx.nextShotNumber, 4);
  assert.equal(generationUnitContext(plan, unitShots, 3, ['a.mp4']).nextShotNumber, undefined);
});

test('unitFrameTargets: chain only on previous-last-frame with a clip that exists', () => {
  const chained = unit('u', [2], { startFrameStrategy: 'previous-last-frame' });
  assert.equal(unitFrameTargets(chained, { previousRenderedShot: 'p.mp4' }, { hasNextPanel: false }).start, 'chain');
  assert.equal(unitFrameTargets(chained, { previousRenderedShot: 'p.mp4' }, { hasNextPanel: false, hasPreviousClip: false }).start, 'panel');
  assert.equal(unitFrameTargets(chained, {}, { hasNextPanel: false }).start, 'panel');
  assert.equal(unitFrameTargets(unit('u', [2]), { previousRenderedShot: 'p.mp4' }, { hasNextPanel: false }).start, 'panel');
});

test('unitFrameTargets: the next panel only when asked for, a next unit exists and its panel is there', () => {
  const targeted = unit('u', [2], { endFrameStrategy: 'next-panel-target' });
  assert.deepEqual(unitFrameTargets(targeted, { nextShotNumber: 3 }, { hasNextPanel: true }), { start: 'panel', end: 'next-panel', nextShotNumber: 3 });
  assert.deepEqual(unitFrameTargets(targeted, { nextShotNumber: 3 }, { hasNextPanel: false }), { start: 'panel', end: 'natural', endFallback: 'next-panel-missing' });
  assert.deepEqual(unitFrameTargets(targeted, {}, { hasNextPanel: true }), { start: 'panel', end: 'natural' });
  assert.deepEqual(unitFrameTargets(unit('u', [2]), { nextShotNumber: 3 }, { hasNextPanel: true }), { start: 'panel', end: 'natural' });
});

const failed = () => new VideoGenerationFailedError('m', 'q1', 'FAILED', { status: 'FAILED' });
const facesOff = () => new FacesOffModelError({ model: 'x-basic', faceCapableModel: 'x', faceImages: ['a.png'], characters: [], message: 'faces-off' });
const refusal = (kind, creditsRefunded) => new VideoRefusalError({
  kind, model: 'm', retryable: false, message: 'refused',
  ...(kind === 'provider-content-policy' ? { refusal: { creditsRefunded, message: 'policy' } } : {}),
}, 422, {});

test('renderFailureDisposition: final, record, refusal and re-bill for each error core knows', () => {
  const cases = [
    [new OperationAbortedError(), { kind: 'cancelled', final: true, recordKept: true, providerRefusal: false, retryRebills: 'no' }],
    [Object.assign(new Error('x'), { name: 'AbortError' }), { kind: 'cancelled', final: true, recordKept: true, providerRefusal: false, retryRebills: 'no' }],
    [refusal('face-screening'), { kind: 'refused', final: true, recordKept: false, providerRefusal: false, retryRebills: 'no' }],
    [refusal('provider-content-policy', true), { kind: 'refused', final: true, recordKept: false, providerRefusal: true, retryRebills: 'no' }],
    [refusal('provider-content-policy', false), { kind: 'refused', final: true, recordKept: false, providerRefusal: true, retryRebills: 'yes' }],
    [failed(), { kind: 'failed', final: true, recordKept: false, providerRefusal: false, retryRebills: 'yes' }],
    [facesOff(), { kind: 'faces-off', final: true, recordKept: false, providerRefusal: false, retryRebills: 'no' }],
    [new VideoJobTimeoutError({ model: 'm', queueId: 'q', reason: 'max-wait', polls: 1, waitedMs: 1 }), { kind: 'timed-out', final: false, recordKept: true, providerRefusal: false, retryRebills: 'no' }],
    [new VideoJobPollError('m', 'q', 6, new Error('503')), { kind: 'poll-failed', final: false, recordKept: true, providerRefusal: false, retryRebills: 'no' }],
    [new VideoJobGoneError('m', 'q', 404), { kind: 'gone', final: false, recordKept: false, providerRefusal: false, retryRebills: 'yes' }],
    [new VeniceRequestError('Internal Server Error', 500, {}), { kind: 'other', final: false, recordKept: false, providerRefusal: false, retryRebills: 'unknown' }],
    ['a string', { kind: 'other', final: false, recordKept: false, providerRefusal: false, retryRebills: 'unknown' }],
  ];
  for (const [err, expected] of cases) {
    assert.deepEqual(renderFailureDisposition(err), expected, String(err?.name ?? err));
  }
});

test('renderFailureDisposition agrees with isFinalMultiShotError and the CLI multi-shot retry', () => {
  // What renderMultiShotUnitUntilSuccess rethrew before it called core:
  // an abort, a VideoRefusalError, a FAILED render, a faces-off refusal.
  const cliFinal = err => err instanceof OperationAbortedError || err instanceof VideoRefusalError
    || err instanceof VideoGenerationFailedError || err instanceof FacesOffModelError;
  const errors = [
    new OperationAbortedError(), refusal('face-screening'), refusal('provider-content-policy', true), failed(), facesOff(),
    new VeniceRequestError('Bad Gateway', 502, {}), new Error('socket hang up'),
    new VideoJobTimeoutError({ model: 'm', queueId: 'q', reason: 'max-wait', polls: 1, waitedMs: 1 }),
  ];
  for (const err of errors) {
    assert.equal(renderFailureDisposition(err).final, cliFinal(err), err.name);
    if (isFinalMultiShotError(err)) assert.equal(renderFailureDisposition(err).final, true, err.name);
  }
  assert.equal(isFinalMultiShotError(failed()), true);
  assert.equal(isFinalMultiShotError(facesOff()), true);
  assert.equal(isFinalMultiShotError(new OperationAbortedError()), false);
});

test('the core barrel exports the generation steps and no generation loop', () => {
  for (const name of ['resolveUnitShots', 'generationUnitContext', 'unitFrameTargets', 'isFinalMultiShotError', 'renderFailureDisposition', 'renderVideo']) {
    assert.equal(typeof barrel[name], 'function', name);
  }
  assert.equal(barrel.MULTISHOT_RETRY_DELAY_MS, 15_000);
  assert.equal(barrel.runGenerationUnits, undefined);
  assert.equal(barrel.renderMultiShotUntilSuccess, undefined);
});
