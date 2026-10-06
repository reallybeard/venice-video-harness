// The prompt builders and the @ImageN slot planner live in packages/core and
// take the shot's ReferenceSet as data; the src modules build the set from
// disk and delegate. This pins the contract: core given an in-memory set
// (no project directory at all) returns exactly what the CLI wrapper returns
// for the same images materialised on disk, and the builders that read no
// references are re-exported, not copied.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '../packages/core/dist/index.js';
import * as corePrompt from '../packages/core/dist/mini-drama/prompt-builder.js';
import * as coreSlots from '../packages/core/dist/mini-drama/reference-slots.js';
import * as coreLocations from '../packages/core/dist/series/locations.js';
import * as srcPrompt from '../dist/mini-drama/prompt-builder.js';
import * as srcSlots from '../dist/mini-drama/reference-slots.js';
import * as manager from '../dist/series/manager.js';

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);

const dir = mkdtempSync(join(tmpdir(), 'venice-core-prompt-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function put(rel) {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), PNG);
}
put('characters/aria/front.png');
put('characters/aria/three-quarter.png');
put('characters/bo/anchor.png');
put('characters/bo/front.png');
put('locations/workshop/north.png');
put('locations/workshop/south.png');
put('locations/workshop/reverse-angle.png');
put('storyboards/e01-fix.png');

const series = {
  name: 'Core Prompt', slug: 'core-prompt', concept: 'c', genre: 'drama', setting: 's',
  aesthetic: {
    style: 'Moody neo-noir illustration', palette: 'teal and amber palette',
    lighting: 'hard practical light', lensCharacteristics: 'anamorphic flares', filmStock: 'digital',
  },
  storyboardAspectRatio: '16:9',
  characters: [
    { name: 'ARIA', gender: 'female', age: 'mid 20s', description: 'inventor', fullDescription: 'ARIA, inventor', wardrobe: 'oil-stained jacket', voiceDescription: 'bright voice', voiceReferencePath: 'characters/aria/voice-reference.mp3', locked: true, seed: 1 },
    { name: 'BO', gender: 'male', age: '60s', description: 'mechanic', fullDescription: 'BO, mechanic', wardrobe: 'overalls', voiceDescription: 'gravelly', locked: true, seed: 2 },
  ],
  locations: [
    { name: 'Workshop', slug: 'workshop', description: 'a cramped workshop', lightingNotes: 'warm lamplight', spatialAnchors: 'bench on the back wall', seed: 7 },
  ],
  episodes: [],
  videoDefaults: {
    actionModel: 'seedance-2-5-reference-to-video',
    atmosphereModel: 'seedance-2-5-reference-to-video',
    characterConsistencyModel: 'seedance-2-5-reference-to-video',
    imageDefaults: { generationModel: 'nano-banana-2', editModel: 'nano-banana-2-edit' },
  },
  outputDir: dir,
  createdAt: '', updatedAt: '',
};

function shot(n, over = {}) {
  return {
    shotNumber: n, type: 'action', duration: '5s', videoModel: 'action',
    description: `ARIA hands BO a wrench, beat ${n}`,
    characters: ['ARIA', 'BO'],
    dialogue: { character: 'ARIA', line: 'Hold it steady.', delivery: 'urgent' },
    sfx: 'ratchet clicks', cameraMovement: 'slow dolly forward', transition: 'CUT',
    location: 'workshop', blocking: 'ARIA screen left, BO screen right',
    ...over,
  };
}

// The same images as disk, written by hand: no referenceSetFromDisk, no fs.
const p = rel => join(dir, rel);
const refsInMemory = {
  characters: [
    { name: 'ARIA', primary: { ref: p('characters/aria/front.png') }, angles: [{ ref: p('characters/aria/three-quarter.png'), view: 'three-quarter' }] },
    { name: 'BO', primary: { ref: p('characters/bo/anchor.png') }, angles: [] },
  ],
  locations: [
    { slug: 'workshop', plates: [
      { ref: p('locations/workshop/north.png'), wall: 'north' },
      { ref: p('locations/workshop/south.png'), wall: 'south' },
      { ref: p('locations/workshop/reverse-angle.png'), wall: 'reverse-angle' },
    ] },
  ],
  storyboard: { ref: p('storyboards/e01-fix.png') },
};

// Core never reads outputDir; point it nowhere to prove the call is disk-free.
const seriesNoDisk = { ...series, outputDir: join(dir, 'does-not-exist') };

test('core exposes the prompt builders, slot planner and getLocation', () => {
  for (const name of [
    'buildVideoPrompt', 'buildImagePrompt', 'buildMontagePrompt', 'buildMultiShotPrompt',
    'buildKlingMultiShotPrompt', 'buildCharacterReferencePrompt', 'buildCharacterReferencePromptParts',
    'resolveVideoModel', 'shouldImproviseDialogue', 'formatDialogueLine', 'buildReferenceSlotPlan', 'getLocation',
  ]) {
    assert.equal(typeof core[name], 'function', name);
  }
  assert.equal(typeof core.IMPROV_DIALOGUE_NOTE, 'string');
  assert.equal(core.buildVideoPrompt, corePrompt.buildVideoPrompt);
  assert.equal(core.buildReferenceSlotPlan, coreSlots.buildReferenceSlotPlan);
  assert.equal(core.getLocation, coreLocations.getLocation);
});

test('builders that read no references are re-exported by src, not copied', () => {
  for (const name of [
    'resolveVideoModel', 'buildImagePrompt', 'buildKlingMultiShotPrompt',
    'buildCharacterReferencePrompt', 'buildCharacterReferencePromptParts',
  ]) {
    assert.equal(srcPrompt[name], corePrompt[name], name);
  }
  assert.equal(manager.getLocation, coreLocations.getLocation);
});

test('core buildVideoPrompt with an in-memory ReferenceSet equals the CLI wrapper on disk', () => {
  const shots = [
    shot(1),
    shot(2, { storyboardRef: 'e01-fix', characters: ['ARIA'], dialogue: null }),
    shot(3, { characters: [], dialogue: null, type: 'establishing', videoModel: 'atmosphere' }),
    shot(4, { dialogue: [{ character: 'ARIA', line: 'One.' }, { character: 'BO', line: 'Two.' }] }),
  ];
  for (const s of shots) {
    const fromDisk = srcPrompt.buildVideoPrompt(s, series, shots[0]);
    const inMemory = core.buildVideoPrompt(s, seriesNoDisk, refsInMemory, shots[0]);
    assert.deepEqual(inMemory, fromDisk, `shot ${s.shotNumber}`);
  }
  const first = core.buildVideoPrompt(shots[1], seriesNoDisk, refsInMemory);
  assert.deepEqual(first.referenceSlots.map(sl => [sl.kind, sl.ref]), [
    ['character-primary', p('characters/aria/front.png')],
    ['storyboard', p('storyboards/e01-fix.png')],
    ['location', p('locations/workshop/north.png')],
    ['location', p('locations/workshop/south.png')],
    ['location', p('locations/workshop/reverse-angle.png')],
    ['character-angle', p('characters/aria/three-quarter.png')],
  ]);
});

test('core multi-shot and montage builders with a ReferenceSet equal the CLI wrappers', () => {
  const shots = [shot(1), shot(2, { characters: ['ARIA'] })];
  const unit = {
    unitId: 'u1', unitType: 'multishot', shotNumbers: [1, 2], outputFile: 'u1.mp4',
    model: 'action', duration: '10s', startFrameStrategy: 'none', endFrameStrategy: 'natural',
    decisionReasons: [], fallbackToSingles: false,
  };
  assert.deepEqual(
    core.buildMultiShotPrompt(shots, unit, seriesNoDisk, refsInMemory),
    srcPrompt.buildMultiShotPrompt(shots, unit, series),
  );
  const montage = {
    ...unit, unitType: 'montage', model: 'seedance-2-5-reference-to-video', duration: '10s',
    montageBeats: [{ shotNumber: 1, startSec: 0, endSec: 5 }, { shotNumber: 2, startSec: 5, endSec: 10 }],
  };
  assert.deepEqual(
    core.buildMontagePrompt(shots, montage, seriesNoDisk, refsInMemory),
    srcPrompt.buildMontagePrompt(shots, montage, series),
  );
});

test('core buildImagePrompt and the slot planner match the src modules', () => {
  const s = shot(1, { storyboardRef: 'e01-fix' });
  assert.deepEqual(core.buildImagePrompt(s, seriesNoDisk), srcPrompt.buildImagePrompt(s, series));
  const model = 'seedance-2-5-reference-to-video';
  const toPlain = plan => ({ ...plan, characterSlotByName: [...plan.characterSlotByName] });
  assert.deepEqual(
    toPlain(core.buildReferenceSlotPlan(seriesNoDisk, s, model, refsInMemory)),
    toPlain(srcSlots.buildReferenceSlotPlan(series, s, model)),
  );
});

test('a browser-shaped set plans with asset ids, and the function form is called lazily', () => {
  const assetRefs = {
    characters: [{ name: 'ARIA', primary: { ref: 'asset:aria-front' }, angles: [] }],
    locations: [{ slug: 'workshop', plates: [{ ref: 'asset:workshop-north', wall: 'north' }] }],
  };
  const s = shot(5, { characters: ['ARIA'] });
  const out = core.buildVideoPrompt(s, seriesNoDisk, assetRefs);
  assert.deepEqual(out.referenceSlots.map(sl => sl.ref), ['asset:aria-front', 'asset:workshop-north']);
  assert.match(out.prompt, /@Image1 is ARIA/);

  const calls = [];
  const source = (planShot, options) => { calls.push([planShot.characters, options.characterNames]); return assetRefs; };
  assert.deepEqual(core.buildVideoPrompt(s, seriesNoDisk, source), out);
  assert.deepEqual(calls, [[['ARIA'], ['ARIA']]]);

  // A model without @Image tags never asks for references.
  calls.length = 0;
  const kling = { ...seriesNoDisk, videoDefaults: { ...seriesNoDisk.videoDefaults, characterConsistencyModel: 'kling-o3-standard-reference-to-video' } };
  core.buildVideoPrompt(s, kling, source);
  assert.deepEqual(calls, []);

  // Montage plans from one synthetic shot carrying the union of the unit's characters.
  calls.length = 0;
  const shots = [shot(1, { characters: ['ARIA'] }), shot(2, { characters: ['BO'] })];
  core.buildMontagePrompt(shots, {
    unitId: 'm', unitType: 'montage', shotNumbers: [1, 2], outputFile: 'm.mp4', model: 'seedance-2-5-reference-to-video',
    duration: '10s', startFrameStrategy: 'none', endFrameStrategy: 'natural', decisionReasons: [], fallbackToSingles: false,
    montageBeats: [{ shotNumber: 1, startSec: 0, endSec: 5 }, { shotNumber: 2, startSec: 5, endSec: 10 }],
  }, seriesNoDisk, source);
  assert.deepEqual(calls, [[['ARIA', 'BO'], ['ARIA', 'BO']]]);
});

test('a tag model given something that is not a reference set throws', () => {
  assert.throws(() => core.buildVideoPrompt(shot(1), seriesNoDisk, shot(0)), TypeError);
});
