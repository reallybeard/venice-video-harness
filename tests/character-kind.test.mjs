// `Character.kind: 'person' | 'object'` (plan-schema-additions.md §4).
//
// Object cast members (recurring hero props and vehicles) ride the character
// system for identity anchoring — a locked reference, angle views, an @ImageN
// slot — but have no face. Three places used to assume every character is a
// person:
//   1. `resolveVideoModel`'s faces-off swap (`faceSafe`): an object-only shot
//      may stay on a `-basic` Seedance id; a person on screen still swaps;
//   2. `checkFacesOffCompatible`: when every character on screen is an
//      object, undecided sidecars are treated as faceless (explicit
//      `hasFace: true` still blocks);
//   3. the identity line: objects read `@ImageN is NAME: its shape, material
//      and markings.` instead of `— wearing WARDROBE`.
// `kind` defaults to `'person'` everywhere it is read, so a `series.json`
// written before the field existed behaves byte-identically (snapshot below).
//
// No network calls, no generation budget. `renderVideoFile` is reached with a
// capture client that throws before any HTTP call; the config dir is isolated.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolation: nothing in this file may touch the operator's config or key.
process.env.VENICE_VIDEO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'character-kind-config-'));
delete process.env.VENICE_API_KEY;

import {
  checkFacesOffCompatible,
  assertFacesOffCompatible,
  characterKindsFor,
  FacesOffModelError,
} from '../dist/venice/seedance-preflight.js';
import { resolveVideoModel, buildVideoPrompt, buildMultiShotPrompt, buildMontagePrompt } from '../dist/mini-drama/prompt-builder.js';
import { renderVideoFile } from '../dist/mini-drama/video-generator.js';

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'character-kind-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Write `name` under `dir`, with an optional provenance sidecar. */
function image(dir, name, hasFace) {
  const path = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, PNG);
  if (hasFace !== 'no-sidecar') {
    const prov = { generationModel: 'seedream-v5-lite', editModels: [] };
    if (hasFace !== undefined) prov.hasFace = hasFace;
    writeFileSync(path.replace(/\.png$/, '.provenance.json'), JSON.stringify(prov));
  }
  return path;
}

const ARIA = {
  name: 'ARIA', gender: 'female', age: 'mid 20s', description: 'inventor',
  fullDescription: 'ARIA, inventor', wardrobe: 'jacket', voiceDescription: 'warm',
  locked: true, seed: 42,
};
// Shape produced by the script writer's `objectCast` materialisation, plus `kind`.
const THE_PHONE = {
  name: 'THE PHONE', kind: 'object', gender: 'other', age: 'n/a',
  description: 'a cracked flip phone', fullDescription: 'a cracked flip phone',
  wardrobe: 'n/a', voiceDescription: 'n/a (inanimate object)',
  baseTraits: 'inanimate object, prop; a cracked flip phone',
  locked: true, seed: 7,
};

const series = (outputDir, characters, videoDefaults = {}) => ({
  name: 'Kind', slug: 'kind', concept: 'c', genre: 'drama', setting: 's',
  aesthetic: { style: 'Cinematic photography', palette: 'warm amber', lighting: 'natural', lensCharacteristics: 'shallow', filmStock: 'digital' },
  storyboardAspectRatio: '16:9',
  characters,
  locations: [],
  episodes: [],
  videoDefaults: {
    actionModel: 'seedance-2-0-reference-to-video',
    atmosphereModel: 'seedance-2-0-image-to-video',
    characterConsistencyModel: 'seedance-2-0-reference-to-video',
    imageDefaults: { generationModel: 'seedream-v5-lite', editModel: 'seedream-v5-lite-edit' },
    ...videoDefaults,
  },
  outputDir,
  createdAt: '', updatedAt: '',
});

const shot = (characters, extra = {}) => ({
  shotNumber: 1, type: 'action', duration: '5s', videoModel: 'action',
  environment: 'DAY_EXTERIOR', description: 'ARIA picks up THE PHONE.',
  characters, sfx: null, cameraMovement: 'static', transition: 'CUT',
  ...extra,
});

const BASIC_R2V = 'seedance-2-0-reference-to-video-basic';
const R2V = 'seedance-2-0-reference-to-video';

// ---- (a) object-only shot keeps the -basic id and passes preflight ---------

test('resolveVideoModel: an object-only shot keeps a faces-off characterConsistencyModel', () => {
  const s = series('/tmp/unused', [ARIA, THE_PHONE], { characterConsistencyModel: BASIC_R2V });
  const r = resolveVideoModel(shot(['THE PHONE']), s);
  assert.equal(r.modelId, BASIC_R2V, 'no person on screen: the configured -basic id stays');
  assert.equal(r.useImageTags, true, 'still R2V: the object wants its reference anchored');
  assert.match(r.reason, /objects only, no person on screen/);
  assert.match(r.reason, /faces-off id kept/);
});

test('checkFacesOffCompatible: object-only shot treats undecided sidecars as faceless', async () => {
  const { dir, cleanup } = fixtureDir();
  try {
    const undecided = image(dir, 'front.png', undefined);     // sidecar, no hasFace
    const noSidecar = image(dir, 'anchor.png', 'no-sidecar');
    const plate = image(dir, 'north.png', false);
    const kinds = characterKindsFor({ characters: [ARIA, THE_PHONE] }, ['THE PHONE']);
    assert.deepEqual(kinds, { 'THE PHONE': 'object' });
    const v = await checkFacesOffCompatible({
      model: BASIC_R2V,
      imagePaths: [undecided, noSidecar, plate],
      characters: ['THE PHONE'],
      characterKinds: kinds,
    });
    assert.equal(v, undefined, 'an object has no face; nothing to screen');
  } finally {
    cleanup();
  }
});

test('checkFacesOffCompatible: an explicit hasFace:true still blocks an object-only shot', async () => {
  const { dir, cleanup } = fixtureDir();
  try {
    const face = image(dir, 'front.png', true);
    const v = await checkFacesOffCompatible({
      model: BASIC_R2V,
      imagePaths: [face],
      characters: ['THE PHONE'],
      characterKinds: { 'THE PHONE': 'object' },
    });
    assert.ok(v, 'the sidecar says a face is in the image');
    assert.deepEqual(v.faceImages, [face]);
    assert.match(v.message, /sends an image with a face/, 'an object is not named as the person');
    assert.doesNotMatch(v.message, /shows THE PHONE/);
    await assert.rejects(
      assertFacesOffCompatible({ model: BASIC_R2V, imagePaths: [face], characters: ['THE PHONE'], characterKinds: { 'THE PHONE': 'object' } }),
      FacesOffModelError,
    );
  } finally {
    cleanup();
  }
});

test('checkFacesOffCompatible: a name missing from characterKinds is a person', async () => {
  const { dir, cleanup } = fixtureDir();
  try {
    const undecided = image(dir, 'panel.png', undefined);
    const v = await checkFacesOffCompatible({
      model: BASIC_R2V,
      imagePaths: [undecided],
      characters: ['THE PHONE', 'STRANGER'],
      characterKinds: { 'THE PHONE': 'object' },
    });
    assert.ok(v, 'STRANGER is unknown, so treated as a person');
    assert.match(v.message, /shows STRANGER/);
  } finally {
    cleanup();
  }
});

test('renderVideoFile: an object-only shot on a -basic id passes preflight (fails later, before any HTTP call, on the stubbed client)', async () => {
  const { dir, cleanup } = fixtureDir();
  try {
    const ref = image(join(dir, 'characters', 'the-phone'), 'front.png', undefined);
    const calls = [];
    const sentinel = new Error('stub client: preflight passed');
    const client = {
      async post(path) { calls.push(path); throw sentinel; },
      async postBinaryOrJson(path) { calls.push(path); throw sentinel; },
    };
    await assert.rejects(
      renderVideoFile(client, {
        prompt: { prompt: 'p', model: BASIC_R2V, duration: '5s', audio: true },
        outputPath: join(dir, 'out.mp4'),
        referenceImagePaths: [ref],
        characters: ['THE PHONE'],
        characterKinds: { 'THE PHONE': 'object' },
        forceRequeue: true,
      }),
      (err) => {
        assert.ok(!(err instanceof FacesOffModelError), `preflight must not refuse an object-only shot: ${err?.message}`);
        return true;
      },
    );
    assert.deepEqual(calls, ['/api/v1/video/queue'], 'preflight passed; the (stubbed) queue call was the first HTTP touch');
    calls.length = 0;
    // Same request without the kinds map is refused (legacy behaviour).
    await assert.rejects(
      renderVideoFile(client, {
        prompt: { prompt: 'p', model: BASIC_R2V, duration: '5s', audio: true },
        outputPath: join(dir, 'out2.mp4'),
        referenceImagePaths: [ref],
        characters: ['THE PHONE'],
        forceRequeue: true,
      }),
      FacesOffModelError,
    );
    assert.equal(calls.length, 0, 'refused before any HTTP call');
  } finally {
    cleanup();
  }
});

// ---- (b) object + person swaps to the twin ---------------------------------

test('resolveVideoModel: object + person on screen swaps a faces-off id for its twin, naming the person', () => {
  const s = series('/tmp/unused', [ARIA, THE_PHONE], { characterConsistencyModel: BASIC_R2V });
  const r = resolveVideoModel(shot(['THE PHONE', 'ARIA']), s);
  assert.equal(r.modelId, R2V);
  assert.match(r.reason, /person on screen — seedance-2-0-reference-to-video-basic runs without face handling/);
});

test('resolveVideoModel: a faces-off lipSyncModel is swapped when a person speaks', () => {
  const s = series('/tmp/unused', [ARIA, THE_PHONE], {
    lipSyncModel: BASIC_R2V, audioStrategy: 'lip-sync',
  });
  const personSpeaks = resolveVideoModel(shot(['ARIA'], {
    type: 'dialogue', motion: 'low', dialogue: { character: 'ARIA', line: 'hi', delivery: 'soft' },
  }), s);
  assert.equal(personSpeaks.modelId, R2V);
});

test('checkFacesOffCompatible: object + person — undecided sidecars count as faces, message names only the person', async () => {
  const { dir, cleanup } = fixtureDir();
  try {
    const undecided = image(dir, 'panel.png', undefined);
    const v = await checkFacesOffCompatible({
      model: BASIC_R2V,
      imagePaths: [undecided],
      characters: ['THE PHONE', 'ARIA'],
      characterKinds: characterKindsFor({ characters: [ARIA, THE_PHONE] }, ['THE PHONE', 'ARIA']),
    });
    assert.ok(v);
    assert.deepEqual(v.faceImages, [undecided]);
    assert.match(v.message, /shows ARIA/);
  } finally {
    cleanup();
  }
});

// ---- (c) identity line wording -------------------------------------------

test('buildVideoPrompt: an object gets the object role clause, a person keeps the wardrobe line', () => {
  const { dir, cleanup } = fixtureDir();
  try {
    image(join(dir, 'characters', 'aria'), 'front.png', true);
    image(join(dir, 'characters', 'the-phone'), 'front.png', false);
    const s = series(dir, [ARIA, THE_PHONE]);
    const p = buildVideoPrompt(shot(['ARIA', 'THE PHONE']), s);
    assert.equal(p.model, R2V);
    assert.match(p.prompt, /@Image1 is ARIA — wearing jacket\./);
    assert.match(p.prompt, /@Image2 is THE PHONE: its shape, material and markings\./);
    assert.doesNotMatch(p.prompt, /THE PHONE — wearing/);
    assert.doesNotMatch(p.prompt, /wearing n\/a/);
  } finally {
    cleanup();
  }
});

test('buildMultiShotPrompt: the object role clause is used on the multi-shot path too', () => {
  const { dir, cleanup } = fixtureDir();
  try {
    image(join(dir, 'characters', 'aria'), 'front.png', true);
    image(join(dir, 'characters', 'the-phone'), 'front.png', false);
    const s = series(dir, [ARIA, THE_PHONE]);
    const shots = [shot(['ARIA', 'THE PHONE'], { shotNumber: 1 }), shot(['THE PHONE'], { shotNumber: 2, description: 'THE PHONE buzzes.' })];
    const unit = {
      unitId: 'u', unitType: 'multi-shot', shotNumbers: [1, 2], outputFile: 'u.mp4',
      model: R2V, duration: '10s',
      startFrameStrategy: 'none', endFrameStrategy: 'none', decisionReasons: [], fallbackToSingles: false,
    };
    const p = buildMultiShotPrompt(shots, unit, s);
    assert.match(p.prompt, /@Image1 is ARIA — wearing jacket\./);
    assert.match(p.prompt, /@Image2 is THE PHONE: its shape, material and markings\./);
    assert.doesNotMatch(p.prompt, /THE PHONE — wearing/);
  } finally {
    cleanup();
  }
});

test('buildMontagePrompt: the object role clause is used on the montage path, with its own lock suffix', () => {
  const { dir, cleanup } = fixtureDir();
  try {
    image(join(dir, 'characters', 'aria'), 'front.png', true);
    image(join(dir, 'characters', 'the-phone'), 'front.png', false);
    const s = series(dir, [ARIA, THE_PHONE]);
    const shots = [shot(['ARIA', 'THE PHONE'], { shotNumber: 1 }), shot(['THE PHONE'], { shotNumber: 2, description: 'THE PHONE buzzes.' })];
    const unit = {
      unitId: 'm', unitType: 'montage', shotNumbers: [1, 2], outputFile: 'm.mp4',
      model: R2V, duration: '10s',
      montageBeats: [{ shotNumber: 1, startSec: 0, endSec: 5 }, { shotNumber: 2, startSec: 5, endSec: 10 }],
      startFrameStrategy: 'none', endFrameStrategy: 'none', decisionReasons: [], fallbackToSingles: false,
    };
    const p = buildMontagePrompt(shots, unit, s);
    assert.match(p.prompt, /@Image1 is ARIA — wearing jacket\. Wardrobe locked, identical in every beat\./);
    assert.match(p.prompt, /@Image2 is THE PHONE: its shape, material and markings\. Appearance locked, identical in every beat\./);
  } finally {
    cleanup();
  }
});

// ---- (d) legacy series.json without `kind` is byte-identical ---------------

// Snapshot of the single-shot prompt for a two-character series (one of them
// an object-cast member by the pre-`kind` baseTraits convention, no `kind`
// field) captured on the base commit before this change landed. Any drift
// here means a `series.json` written before `kind` existed no longer renders
// the same prompt.
const LEGACY_SNAPSHOT = {
  prompt:
    'locked-off static shot. @Image1 is ARIA — wearing jacket. @Image2 is THE PHONE — wearing n/a. '
    + '@Image1 picks up @Image2. Bright daytime scene, natural light, no rain. '
    + 'Cinematic photography, warm amber, natural, shallow, shot on digital. '
    + 'No background music. Only generate dialogue, ambient sound, and sound effects.',
  model: 'seedance-2-0-reference-to-video',
  resolution: {
    modelId: 'seedance-2-0-reference-to-video',
    upgraded: false,
    reason: 'characters present — R2V for identity anchoring',
    autoUseElements: false,
    autoUseReferenceImages: true,
    useImageTags: true,
  },
};

test('legacy series.json without kind: prompt + routing are byte-identical to the pre-kind snapshot', () => {
  const { dir, cleanup } = fixtureDir();
  try {
    image(join(dir, 'characters', 'aria'), 'front.png', 'no-sidecar');
    image(join(dir, 'characters', 'the-phone'), 'front.png', 'no-sidecar');
    const { kind: _drop, ...legacyPhone } = THE_PHONE;
    assert.equal(legacyPhone.kind, undefined);
    const s = series(dir, [ARIA, legacyPhone]);
    const sh = shot(['ARIA', 'THE PHONE']);
    const p = buildVideoPrompt(sh, s);
    const r = resolveVideoModel(sh, s);
    assert.deepEqual({ prompt: p.prompt, model: p.model, resolution: r }, LEGACY_SNAPSHOT);
  } finally {
    cleanup();
  }
});

test('legacy: without kind, a faces-off id is still swapped and the preflight still screens undecided sidecars', async () => {
  const { dir, cleanup } = fixtureDir();
  try {
    const { kind: _drop, ...legacyPhone } = THE_PHONE;
    const s = series('/tmp/unused', [ARIA, legacyPhone], { characterConsistencyModel: BASIC_R2V });
    const r = resolveVideoModel(shot(['THE PHONE']), s);
    assert.equal(r.modelId, R2V, 'no kind → person → twin');
    assert.deepEqual(characterKindsFor(s, ['THE PHONE']), { 'THE PHONE': 'person' });

    const undecided = image(dir, 'panel.png', undefined);
    const v = await checkFacesOffCompatible({ model: BASIC_R2V, imagePaths: [undecided], characters: ['THE PHONE'] });
    assert.ok(v, 'legacy call without characterKinds behaves as before');
    assert.match(v.message, /shows THE PHONE/);
  } finally {
    cleanup();
  }
});
