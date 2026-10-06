// The generation planner and montage planning live in packages/core; the src
// modules re-export them. This pins both halves of that contract: core plans
// an episode on its own (no Node APIs, so a browser host can run it), and the
// CLI's modules hand back the very same functions rather than copies.

import assert from 'node:assert/strict';
import test from 'node:test';
import * as core from '../packages/core/dist/index.js';
import * as corePlanner from '../packages/core/dist/mini-drama/generation-planner.js';
import * as coreMontage from '../packages/core/dist/mini-drama/montage.js';
import * as coreShotPaths from '../packages/core/dist/mini-drama/shot-paths.js';
import * as srcPlanner from '../dist/mini-drama/generation-planner.js';
import * as srcMontage from '../dist/mini-drama/montage.js';
import * as srcShotPaths from '../dist/mini-drama/shot-paths.js';

function shot(n, over = {}) {
  return {
    shotNumber: n,
    type: 'action',
    duration: '4s',
    videoModel: 'action',
    description: `DRIVER grips the wheel, beat ${n}`,
    characters: ['DRIVER'],
    dialogue: null,
    sfx: null,
    cameraMovement: 'tracking',
    transition: 'CUT',
    location: 'canyon-highway',
    ...over,
  };
}

const script = {
  episode: 1,
  title: 'Dust Line',
  shots: [
    shot(1, { type: 'establishing', duration: '3s', characters: [] }),
    shot(2, { duration: '5s' }),
    shot(3, { duration: '5s' }),
    shot(4, { duration: '5s', location: 'ridge' }),
    shot(5, { duration: '5s', location: 'ridge' }),
    shot(6, { type: 'insert', duration: '3s', description: 'title card: DUST LINE', characters: [], location: 'ridge' }),
  ],
};

test('the core barrel exposes the planner, montage planning and shotKey', () => {
  for (const name of [
    'buildGenerationPlan', 'mustRenderAsExactLipSync', 'mustStayAsWanLipSync', 'shouldUseSeedanceKeyframe',
    'groupShotsIntoScenes', 'planMontageUnits', 'layoutMontageBeats', 'formatBeatTimestamp', 'shotKey',
  ]) {
    assert.equal(typeof core[name], 'function', name);
  }
});

test('the src modules re-export the core functions, not copies', () => {
  for (const name of ['buildGenerationPlan', 'mustRenderAsExactLipSync', 'mustStayAsWanLipSync', 'shouldUseSeedanceKeyframe']) {
    assert.equal(srcPlanner[name], corePlanner[name], name);
  }
  for (const name of ['groupShotsIntoScenes', 'planMontageUnits', 'layoutMontageBeats', 'formatBeatTimestamp']) {
    assert.equal(srcMontage[name], coreMontage[name], name);
  }
  assert.equal(srcShotPaths.shotKey, coreShotPaths.shotKey);
  assert.equal(srcPlanner.parseShotDuration, core.parseShotDuration);
});

test('the IO halves stay in src and out of core', () => {
  assert.equal(typeof srcPlanner.saveGenerationPlan, 'function');
  assert.equal(typeof srcPlanner.loadGenerationPlan, 'function');
  assert.equal(typeof srcMontage.cutMontageIntoShots, 'function');
  assert.equal(typeof srcShotPaths.dialogueFileForShot, 'function');
  for (const name of ['saveGenerationPlan', 'loadGenerationPlan', 'cutMontageIntoShots', 'dialogueFileForShot', 'placeNarrationCues']) {
    assert.equal(core[name], undefined, name);
  }
});

test('core plans a montage-first episode: one unit per scene, inserts as singles', () => {
  const plan = core.buildGenerationPlan(script, { videoDefaults: {} });
  assert.deepEqual(plan.units.map(u => [u.unitType, u.shotNumbers]), [
    ['montage', [1, 2, 3]],
    ['montage', [4, 5]],
    ['single', [6]],
  ]);
  assert.deepEqual(plan.units[0].montageBeats, [
    { shotNumber: 1, startSec: 0, endSec: 3 },
    { shotNumber: 2, startSec: 3, endSec: 8 },
    { shotNumber: 3, startSec: 8, endSec: 13 },
  ]);
  assert.equal(plan.units[0].sceneNumber, 1);
  assert.equal(plan.units[1].sceneNumber, 2);
  assert.deepEqual(core.groupShotsIntoScenes(script.shots).map(s => s.location), ['canyon-highway', 'ridge']);
  assert.equal(core.formatBeatTimestamp(65), '1:05');
  assert.equal(core.shotKey('3b'), '003b');
});

test('core plans the per-shot lane when montage mode is off', () => {
  const plan = core.buildGenerationPlan(script, { videoDefaults: { montageMode: false } });
  assert.deepEqual(plan.units.map(u => [u.unitType, u.shotNumbers]), [
    ['single', [1]],
    ['multishot', [2, 3]],
    ['multishot', [4, 5]],
    ['single', [6]],
  ]);
});
