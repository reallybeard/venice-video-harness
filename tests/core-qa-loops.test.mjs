// The QA loops in core (packages/core/src/mini-drama/qa-loops.ts) over
// in-memory fake ports: a scripted vision judge, an image probe answering
// from per-clip luma arrays, and a fixed clock. No files, no ffmpeg, no
// network. The CLI wiring is pinned separately by tests/qa-loops-golden.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  judgeCrossUnitIdentity,
  judgeUnitIdentity,
  probeBoundary,
  probeHeadGlitch,
  probeUnitFrames,
  runStoryboardQa,
  runVideoQa,
} from '../packages/core/dist/mini-drama/qa-loops.js';
import {
  STORYBOARD_QA_SYSTEM_PROMPT,
  missingPanelResult,
  priorPanelNote,
} from '../packages/core/dist/mini-drama/storyboard-qa.js';
import {
  CROSS_UNIT_SYSTEM_PROMPT,
  IDENTITY_SYSTEM_PROMPT,
  emptyCrossUnitResult,
  summarizeVideoQa,
} from '../packages/core/dist/mini-drama/video-qa.js';
import * as barrel from '../packages/core/dist/index.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const FPS = 24;

const shot = (n, extra = {}) => ({
  shotNumber: n, type: 'medium', duration: 5, description: `shot ${n}`,
  characters: [], ...extra,
});

const SERIES = {
  name: 'Fixture', slug: 'fixture',
  characters: [
    { name: 'MARA', description: 'pilot' },
    { name: 'JUNO', description: 'engineer' },
    { name: 'KAI', description: 'medic' },
  ],
  locations: [
    { name: 'Capsule', slug: 'capsule', description: 'a cramped capsule', spatialAnchors: 'hatch behind the seats' },
    { name: 'Street', slug: 'street', description: 'a wet street' },
  ],
};

const fakeClock = () => ({ now: () => NOW, sleep: async () => {} });

/**
 * A VisionJudge whose answers come from `answer(request, callIndex)`: return
 * the reply, or throw to fail the call. Every request is recorded.
 */
function fakeVision(answer = () => ({ verdict: 'PASS', issues: [], notes: '' })) {
  const calls = [];
  return {
    calls,
    async judge(request) {
      calls.push(request);
      return answer(request, calls.length - 1);
    },
  };
}

/**
 * An ImageProbe over `clips`: `{ [ref]: { lumas: number[], failExtract?: boolean } }`
 * at 24fps. Every call is recorded with its arguments.
 */
function fakeImages(clips) {
  const calls = [];
  const clip = ref => {
    const c = clips[ref];
    if (!c) throw new Error(`no clip ${ref}`);
    return c;
  };
  return {
    calls,
    async imageInfo() { throw new Error('not used'); },
    async clipDuration(ref, opts) {
      calls.push({ op: 'clipDuration', ref, signal: opts?.signal });
      return clip(ref).lumas.length / FPS;
    },
    async frameLumas(ref, window, opts) {
      calls.push({ op: 'frameLumas', ref, window, signal: opts?.signal });
      const start = Math.round((window.startSec ?? 0) * FPS);
      return clip(ref).lumas.slice(start, start + window.frames);
    },
    async extractFrame(ref, at, opts) {
      calls.push({ op: 'extractFrame', ref, at, outputRef: opts?.outputRef, signal: opts?.signal });
      if (clip(ref).failExtract) throw new Error('decode failed');
      return opts?.outputRef ?? `${ref}@${at.atSec}`;
    },
  };
}

const flat = (luma, frames = 48) => Array.from({ length: frames }, () => luma);

// ---- Storyboard QA ---------------------------------------------------------

function storyboardRun(overrides = {}) {
  return {
    episode: 1,
    series: SERIES,
    shots: [
      shot(1, { characters: ['MARA', 'JUNO', 'KAI'], location: 'capsule' }),
      shot(2, { characters: ['KAI'], location: 'street' }),
      shot(3, { characters: ['JUNO'], location: 'capsule' }),
    ],
    model: 'vision-a',
    companionModel: 'vision-b',
    panel: async s => `panel:${s.shotNumber}`,
    characterSheet: async name => (name === 'KAI' ? undefined : `sheet:${name}`),
    ...overrides,
  };
}

test('storyboard QA: panel, up to two sheets, then the prior same-location panel; analyzedAt from the clock', async () => {
  const vision = fakeVision();
  const controller = new AbortController();
  const report = await runStoryboardQa({ vision, clock: fakeClock() }, storyboardRun({ signal: controller.signal }));

  assert.equal(report.episode, 1);
  assert.equal(report.model, 'vision-a');
  assert.equal(report.analyzedAt, NOW.toISOString());
  assert.deepEqual(Object.keys(report), ['episode', 'model', 'analyzedAt', 'summary', 'results']);
  assert.deepEqual(report.summary, { total: 3, pass: 3, flagCritical: 0, flagModerate: 0, flagLow: 0, errored: 0 });

  assert.equal(vision.calls.length, 3);
  // Shot 1: three characters, only the first two are looked up; both have sheets.
  assert.deepEqual(vision.calls[0].images, ['panel:1', 'sheet:MARA', 'sheet:JUNO']);
  // Shot 2: KAI has no sheet; nothing earlier on the street.
  assert.deepEqual(vision.calls[1].images, ['panel:2']);
  // Shot 3: back in the capsule, so shot 1's panel rides along with its note.
  assert.deepEqual(vision.calls[2].images, ['panel:3', 'sheet:JUNO', 'panel:1']);
  assert.ok(vision.calls[2].userPrompt.includes(priorPanelNote(storyboardRun().shots[0])));
  assert.ok(vision.calls[2].userPrompt.includes('hatch behind the seats'));

  for (const [i, call] of vision.calls.entries()) {
    assert.equal(call.model, 'vision-a');
    assert.equal(call.systemPrompt, STORYBOARD_QA_SYSTEM_PROMPT);
    assert.equal(call.maxTokens, 4000);
    assert.equal(call.temperature, 0.3);
    assert.equal(call.label, `shot 00${i + 1} QA`);
    assert.equal(call.signal, controller.signal);
  }
});

test('storyboard QA: the prior panel is looked up in the whole script, not in the selection', async () => {
  const vision = fakeVision();
  const run = storyboardRun();
  const report = await runStoryboardQa({ vision, clock: fakeClock() }, { ...run, check: [run.shots[2]] });
  assert.equal(report.results.length, 1);
  assert.deepEqual(vision.calls[0].images, ['panel:3', 'sheet:JUNO', 'panel:1']);
});

test('storyboard QA: a prior panel that is missing is not attached and leaves no note', async () => {
  const vision = fakeVision();
  const run = storyboardRun({ panel: async s => (s.shotNumber === 1 ? undefined : `panel:${s.shotNumber}`) });
  await runStoryboardQa({ vision, clock: fakeClock() }, { ...run, check: [run.shots[2]] });
  assert.deepEqual(vision.calls[0].images, ['panel:3', 'sheet:JUNO']);
  assert.ok(!vision.calls[0].userPrompt.includes(priorPanelNote(run.shots[0])));
});

test('storyboard QA: a missing panel is FLAG-CRITICAL with no vision call', async () => {
  const vision = fakeVision();
  const events = [];
  const run = storyboardRun({ panel: async () => undefined, onEvent: e => { events.push(e); } });
  const report = await runStoryboardQa({ vision, clock: fakeClock() }, { ...run, check: [run.shots[1]] });
  assert.equal(vision.calls.length, 0);
  assert.deepEqual(report.results, [missingPanelResult(run.shots[1])]);
  assert.deepEqual(events.map(e => [e.type, e.index, e.total]), [['missing', 0, 1]]);
});

test('storyboard QA: an empty or failed read is retried once on the companion (rule 55)', async () => {
  const vision = fakeVision(req => {
    if (req.model === 'vision-a') throw new Error('empty response');
    return { verdict: 'FLAG-MODERATE', issues: ['hair darker'], notes: 'n' };
  });
  const events = [];
  const run = storyboardRun({ onEvent: e => { events.push(e); } });
  const report = await runStoryboardQa({ vision, clock: fakeClock() }, { ...run, check: [run.shots[1]] });

  assert.deepEqual(vision.calls.map(c => c.model), ['vision-a', 'vision-b']);
  assert.deepEqual(events.map(e => e.type), ['retry', 'checked']);
  assert.deepEqual(
    { model: events[0].model, nextModel: events[0].nextModel, reason: events[0].reason },
    { model: 'vision-a', nextModel: 'vision-b', reason: 'empty response' },
  );
  assert.equal(events[1].model, 'vision-b');
  assert.equal(events[1].viaFallback, true);
  // The report names the reader that was asked for, not the rescuer.
  assert.equal(report.model, 'vision-a');
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].verdict, 'FLAG-MODERATE');
  assert.equal(report.results[0].errored, undefined);
});

test('storyboard QA: when every model fails the shot is UNCHECKED and counted as errored, not passed', async () => {
  const vision = fakeVision(req => { throw new Error(`${req.model} down`); });
  const events = [];
  const run = storyboardRun({ onEvent: e => { events.push(e); } });
  const report = await runStoryboardQa({ vision, clock: fakeClock() }, { ...run, check: [run.shots[1]] });

  assert.deepEqual(events.map(e => e.type), ['retry', 'unchecked']);
  assert.equal(events[1].reason, 'vision-b down');
  assert.equal(report.results[0].errored, true);
  assert.equal(report.results[0].verdict, 'FLAG-LOW');
  assert.deepEqual(report.results[0].issues, ['QA analysis failed: vision-b down']);
  assert.equal(report.summary.errored, 1);
  assert.equal(report.summary.pass, 0);
});

test('storyboard QA: when the reader is the companion there is one attempt and no retry', async () => {
  const vision = fakeVision(() => { throw new Error('down'); });
  const events = [];
  const run = storyboardRun({ companionModel: 'vision-a', onEvent: e => { events.push(e); } });
  await runStoryboardQa({ vision, clock: fakeClock() }, { ...run, check: [run.shots[1]] });
  assert.equal(vision.calls.length, 1);
  assert.deepEqual(events.map(e => e.type), ['unchecked']);
});

test('storyboard QA: a progress handler that throws on "checked" counts as a failed attempt (kept CLI behaviour)', async () => {
  const vision = fakeVision();
  let first = true;
  const run = storyboardRun({
    onEvent: e => {
      if (e.type === 'checked' && first) { first = false; throw new Error('print failed'); }
    },
  });
  const report = await runStoryboardQa({ vision, clock: fakeClock() }, { ...run, check: [run.shots[1]] });
  assert.deepEqual(vision.calls.map(c => c.model), ['vision-a', 'vision-b']);
  // The first reply was recorded before its event threw; the companion's reply too.
  assert.equal(report.results.length, 2);
});

// ---- Video QA: programmatic -------------------------------------------------

test('probeHeadGlitch: reads window+4 head lumas and finds a flash that reverts', async () => {
  const lumas = flat(100);
  lumas[3] = 200;
  const images = fakeImages({ u1: { lumas } });
  const finding = await probeHeadGlitch(images, 'u1', 'u1');
  assert.deepEqual(finding, { unitId: 'u1', frameIndex: 3, lumaDelta: 100 });
  assert.deepEqual(images.calls[0].window, { frames: 16 });

  const held = flat(100);
  for (let i = 3; i < held.length; i++) held[i] = 200;
  assert.equal(await probeHeadGlitch(fakeImages({ u1: { lumas: held } }), 'u1', 'u1'), undefined);
});

test('probeBoundary: last frame 0.2s before the end against 0.2s into the next unit', async () => {
  const images = fakeImages({ a: { lumas: flat(100) }, b: { lumas: flat(140) }, c: { lumas: flat(230) }, d: { lumas: flat(110) } });
  const warn = await probeBoundary(images, { unitId: 'a', clip: 'a' }, { unitId: 'b', clip: 'b' });
  assert.deepEqual(warn, { prevLuma: 100, nextLuma: 140, finding: { fromUnit: 'a', toUnit: 'b', lumaDelta: 40, severity: 'warn' } });
  const lumaCalls = images.calls.filter(c => c.op === 'frameLumas');
  assert.deepEqual(lumaCalls.map(c => [c.ref, c.window]), [['a', { startSec: 1.8, frames: 1 }], ['b', { startSec: 0.2, frames: 1 }]]);

  const fail = await probeBoundary(images, { unitId: 'a', clip: 'a' }, { unitId: 'c', clip: 'c' });
  assert.equal(fail.finding.severity, 'fail');
  assert.deepEqual(await probeBoundary(images, { unitId: 'a', clip: 'a' }, { unitId: 'd', clip: 'd' }), { prevLuma: 100, nextLuma: 110 });

  const empty = fakeImages({ a: { lumas: flat(100) }, z: { lumas: [] } });
  assert.equal(await probeBoundary(empty, { unitId: 'a', clip: 'a' }, { unitId: 'z', clip: 'z' }), undefined);
});

test('probeUnitFrames: one mid-beat frame per character shot; faceless beats and failed extractions are skipped', async () => {
  const images = fakeImages({ u1: { lumas: flat(100, 96) }, u2: { lumas: flat(100, 48) }, u3: { lumas: flat(100), failExtract: true } });
  const shots = [shot(1, { characters: ['MARA'] }), shot(2), shot(3, { characters: ['JUNO'] }), shot(4, { characters: ['MARA'] })];
  const units = [
    { unitId: 'u1', clip: 'u1', shotNumbers: [1, 2], segments: [
      { shotNumber: 1, startOffsetSec: 0, durationSec: 2 },
      { shotNumber: 2, startOffsetSec: 2, durationSec: 2 },
    ] },
    { unitId: 'u2', clip: 'u2', shotNumbers: [3] },
    { unitId: 'u3', clip: 'u3', shotNumbers: [4] },
  ];
  const samples = await probeUnitFrames(images, units, shots, {
    frameRef: (unitId, n) => (unitId === 'u2' ? undefined : `frames/${unitId}-${n}.png`),
  });
  assert.deepEqual(samples, [
    { unitId: 'u1', shotNumber: 1, atSec: 1, framePath: 'frames/u1-1.png' },
    // No segments: the whole clip is shot 3's beat; the probe picked the ref.
    { unitId: 'u2', shotNumber: 3, atSec: 1, framePath: 'u2@1' },
  ]);
  const extracts = images.calls.filter(c => c.op === 'extractFrame');
  assert.deepEqual(extracts.map(c => [c.ref, c.at, c.outputRef]), [
    ['u1', { atSec: 1 }, 'frames/u1-1.png'],
    ['u2', { atSec: 1 }, undefined],
    ['u3', { atSec: 1 }, 'frames/u3-4.png'],
  ]);
});

// ---- Video QA: vision --------------------------------------------------------

const sample = (unitId, shotNumber) => ({ unitId, shotNumber, atSec: 1, framePath: `f:${unitId}-${shotNumber}` });

test('judgeUnitIdentity: frames first (max 3), then sheets of the first two characters that have one', async () => {
  const vision = fakeVision(() => ({ verdict: 'FLAG-CRITICAL', issues: ['different face'] }));
  const frames = [sample('u1', 1), sample('u1', 2), sample('u1', 3), sample('u1', 4)];
  const result = await judgeUnitIdentity(vision, {
    model: 'vq', unitId: 'u1', frames, characterNames: ['MARA', 'KAI', 'JUNO'],
    characterSheet: async name => (name === 'KAI' ? undefined : `sheet:${name}`),
  });
  assert.deepEqual(result, { unitId: 'u1', verdict: 'FLAG-CRITICAL', issues: ['different face'] });
  const [call] = vision.calls;
  // Only MARA and KAI are considered (IDENTITY_MAX_REFERENCES); KAI has no sheet.
  assert.deepEqual(call.images, ['f:u1-1', 'f:u1-2', 'f:u1-3', 'sheet:MARA']);
  assert.equal(call.systemPrompt, IDENTITY_SYSTEM_PROMPT);
  assert.equal(call.maxTokens, 2000);
  assert.equal(call.temperature, 0.2);
  assert.equal(call.label, 'unit u1 identity QA');
});

test('judgeUnitIdentity: no sheets is PASS without a call; a failed call is UNCHECKED', async () => {
  const silent = fakeVision();
  const pass = await judgeUnitIdentity(silent, {
    model: 'vq', unitId: 'u1', frames: [sample('u1', 1)], characterNames: ['KAI'], characterSheet: async () => undefined,
  });
  assert.deepEqual(pass, { unitId: 'u1', verdict: 'PASS', issues: [], errored: false });
  assert.equal(silent.calls.length, 0);

  const failing = fakeVision(() => { throw new Error('timeout'); });
  const unchecked = await judgeUnitIdentity(failing, {
    model: 'vq', unitId: 'u1', frames: [sample('u1', 1)], characterNames: ['MARA'], characterSheet: async n => `sheet:${n}`,
  });
  assert.deepEqual(unchecked, { unitId: 'u1', verdict: 'FLAG-LOW', issues: ['identity QA failed: timeout'], errored: true });
});

test('judgeCrossUnitIdentity: fewer than two hero frames is an empty PASS; otherwise ONE call in film order', async () => {
  const silent = fakeVision();
  assert.deepEqual(
    await judgeCrossUnitIdentity(silent, { model: 'vq', heroFrames: [sample('u1', 1)], protagonist: 'MARA' }),
    emptyCrossUnitResult(),
  );
  assert.equal(silent.calls.length, 0);

  const vision = fakeVision(() => ({ verdict: 'FLAG-CRITICAL', issues: ['lead changes'], driftingFrames: [2], unclearFrames: [] }));
  const result = await judgeCrossUnitIdentity(vision, {
    model: 'vq', heroFrames: [sample('u1', 1), sample('u3', 4), sample('u5', 6)], protagonist: 'MARA',
  });
  assert.deepEqual(result, { verdict: 'FLAG-CRITICAL', issues: ['lead changes'], driftingUnits: ['u3'] });
  assert.equal(vision.calls.length, 1);
  assert.deepEqual(vision.calls[0].images, ['f:u1-1', 'f:u3-4', 'f:u5-6']);
  assert.equal(vision.calls[0].systemPrompt, CROSS_UNIT_SYSTEM_PROMPT);
  assert.equal(vision.calls[0].label, 'cross-unit identity QA');

  const failing = fakeVision(() => { throw new Error('400'); });
  const unchecked = await judgeCrossUnitIdentity(failing, { model: 'vq', heroFrames: [sample('u1', 1), sample('u2', 3)], protagonist: 'MARA' });
  assert.equal(unchecked.errored, true);
  assert.deepEqual(unchecked.issues, ['cross-unit QA failed: 400']);
});

// ---- Video QA: the whole run ---------------------------------------------------

function videoFixture() {
  const glitchy = flat(100);
  glitchy[3] = 200;
  const clips = { u1: { lumas: glitchy }, u2: { lumas: flat(140) }, u3: { lumas: flat(230) } };
  const shots = [
    shot(1, { characters: ['MARA'] }),
    shot(2, { characters: ['MARA', 'JUNO'] }),
    shot(3, { characters: ['JUNO'] }),
    shot(4, { characters: ['MARA'] }),
  ];
  const units = [
    { unitId: 'u1', clip: 'u1', shotNumbers: [1, 2], segments: [
      { shotNumber: 1, startOffsetSec: 0, durationSec: 1 },
      { shotNumber: 2, startOffsetSec: 1, durationSec: 1 },
    ] },
    { unitId: 'u2', clip: 'u2', shotNumbers: [3] },
    { unitId: 'u3', clip: 'u3', shotNumbers: [4] },
  ];
  return { clips, shots, units };
}

test('runVideoQa --skip-vision: only the free checks, in order; the model reads programmatic-only', async () => {
  const { clips, shots, units } = videoFixture();
  const images = fakeImages(clips);
  const vision = fakeVision();
  const events = [];
  const report = await runVideoQa({ images, vision, clock: fakeClock() }, {
    episode: 2, units, shots, model: 'vq', skipVision: true,
    characterSheet: async n => `sheet:${n}`, onEvent: e => { events.push(e); },
  });

  assert.deepEqual(events.map(e => e.type), ['head-glitch', 'head-glitch-scan-done', 'boundary', 'boundary', 'boundary-scan-done']);
  assert.equal(vision.calls.length, 0);
  assert.equal(images.calls.filter(c => c.op === 'extractFrame').length, 0);
  assert.deepEqual(Object.keys(report), ['episode', 'model', 'analyzedAt', 'headGlitches', 'boundaries', 'unitIdentity', 'crossUnit', 'summary']);
  assert.equal(report.model, 'programmatic-only');
  assert.equal(report.analyzedAt, NOW.toISOString());
  assert.deepEqual(report.headGlitches, [{ unitId: 'u1', frameIndex: 3, lumaDelta: 100 }]);
  assert.deepEqual(report.boundaries.map(b => [b.fromUnit, b.toUnit, b.severity]), [['u1', 'u2', 'warn'], ['u2', 'u3', 'fail']]);
  assert.deepEqual(report.unitIdentity, []);
  assert.deepEqual(report.crossUnit, emptyCrossUnitResult());
  assert.deepEqual(report.summary, summarizeVideoQa({
    units: 3, headGlitches: report.headGlitches, boundaries: report.boundaries, unitIdentity: [], crossUnit: report.crossUnit,
  }));
});

test('runVideoQa: vision-start precedes sampling; per-unit identity then one cross-unit call; signal reaches every port call', async () => {
  const { clips, shots, units } = videoFixture();
  const images = fakeImages(clips);
  const order = [];
  const vision = fakeVision(req => {
    order.push(`judge:${req.label}`);
    if (req.label === 'cross-unit identity QA') {
      return { verdict: 'FLAG-CRITICAL', issues: ['u2 lead differs'], driftingFrames: [2], unclearFrames: [] };
    }
    return { verdict: 'PASS', issues: [] };
  });
  const recordingImages = {
    ...images,
    async extractFrame(...args) { order.push('extract'); return images.extractFrame(...args); },
  };
  const controller = new AbortController();
  const events = [];
  const report = await runVideoQa({ images: recordingImages, vision, clock: fakeClock() }, {
    episode: 2, units, shots, model: 'vq', signal: controller.signal,
    characterSheet: async n => `sheet:${n}`,
    frameRef: (unitId, n) => `frames/${unitId}-${n}.png`,
    onEvent: e => { events.push(e); order.push(`event:${e.type}`); },
  });

  assert.deepEqual(events.map(e => e.type), [
    'head-glitch', 'head-glitch-scan-done', 'boundary', 'boundary', 'boundary-scan-done',
    'vision-start', 'unit-identity', 'unit-identity', 'unit-identity', 'cross-unit',
  ]);
  assert.ok(order.indexOf('event:vision-start') < order.indexOf('extract'));
  assert.ok(order.lastIndexOf('extract') < order.indexOf('judge:unit u1 identity QA'));

  // u1's identity call carries both of its beats and the sheets of MARA and JUNO.
  const u1 = vision.calls.find(c => c.label === 'unit u1 identity QA');
  assert.deepEqual(u1.images, ['frames/u1-1.png', 'frames/u1-2.png', 'sheet:MARA', 'sheet:JUNO']);
  // MARA is in the most shots; u2 (JUNO only) has no hero frame, so the cross-unit call sees u1 and u3.
  const cross = vision.calls.find(c => c.label === 'cross-unit identity QA');
  assert.deepEqual(cross.images, ['frames/u1-1.png', 'frames/u3-4.png']);
  assert.deepEqual(events.at(-1).protagonist, 'MARA');
  assert.equal(events.at(-1).frames, 2);
  assert.deepEqual(report.crossUnit.driftingUnits, ['u3']);

  assert.equal(report.model, 'vq');
  assert.equal(report.unitIdentity.length, 3);
  assert.deepEqual(report.summary, summarizeVideoQa({
    units: 3, headGlitches: report.headGlitches, boundaries: report.boundaries,
    unitIdentity: report.unitIdentity, crossUnit: report.crossUnit,
  }));
  assert.equal(report.summary.passed, false);

  for (const call of images.calls) assert.equal(call.signal, controller.signal, `${call.op} got the signal`);
  for (const call of vision.calls) assert.equal(call.signal, controller.signal);
});

test('runVideoQa: a progress handler that throws aborts the run', async () => {
  const { clips, shots, units } = videoFixture();
  await assert.rejects(
    runVideoQa({ images: fakeImages(clips), vision: fakeVision(), clock: fakeClock() }, {
      episode: 2, units, shots, model: 'vq', characterSheet: async () => undefined,
      onEvent: e => { if (e.type === 'vision-start') throw new Error('no API key'); },
    }),
    /no API key/,
  );
});

test('the core barrel exports the QA loops', () => {
  for (const name of ['runStoryboardQa', 'runVideoQa', 'probeHeadGlitch', 'probeBoundary', 'probeUnitFrames', 'judgeUnitIdentity', 'judgeCrossUnitIdentity']) {
    assert.equal(typeof barrel[name], 'function', name);
  }
});
