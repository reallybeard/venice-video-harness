// Core's storyboard panel planner with host-neutral references (asset ids,
// not paths): every pass-1 branch, the pass-2 step per shot, the identity
// refine's layer selection, and the scene-ref prompt. The CLI's requests are
// pinned byte for byte by storyboard-panels-golden.test.mjs.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildImagePrompt, buildReferenceDraftPrompt, buildSceneRefPrompt, buildStyleMatchPrompt, panelLocationNote, panelRefineOrder,
  panelRefineStep, planCharacterFix, planPanelDraft, styleAnchorShot, styleMatchAesthetic,
} from 'venice-video-harness/core';

const MARA = { name: 'MARA', gender: 'female', age: '40s', description: 'a bush pilot', fullDescription: 'Mara, a bush pilot', wardrobe: 'leather jacket', locked: true, seed: 1 };
const JUNO = { name: 'JUNO', gender: 'female', age: '20s', description: 'an engineer', fullDescription: 'Juno', wardrobe: 'overalls', locked: true, seed: 2 };
const TOMAS = { name: 'TOMAS', gender: 'male', age: '20s', description: 'a radio operator', fullDescription: 'Tomas', wardrobe: 'sweater', locked: true, seed: 3 };
const CAPSULE = { name: 'Capsule', slug: 'capsule', description: 'a cockpit', lightingNotes: 'amber', seed: 4 };

const series = (extra = {}) => ({
  name: 'S', slug: 's', concept: '', genre: '', setting: '', outputDir: '/x', createdAt: '', updatedAt: '',
  aesthetic: { style: 'noir', palette: 'cold', lighting: '' }, aestheticSeed: 9,
  characters: [MARA, JUNO, TOMAS], locations: [CAPSULE], episodes: [],
  videoDefaults: { actionModel: 'x', atmosphereModel: 'x' }, ...extra,
});
const shot = (characters, location, extra = {}) => ({
  shotNumber: 1, type: 'medium', environment: 'NIGHT_INTERIOR', duration: '15s', videoModel: 'character', description: 'Action.',
  characters, dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT', ...(location ? { location } : {}), ...extra,
});

test('a character shot with a plate is composed into the plate, one edit', () => {
  const s = series();
  const sh = shot(['MARA'], 'capsule', { blocking: 'Mara left.', episodeWardrobe: { MARA: 'flight suit' } });
  const plan = planPanelDraft({ series: s, shot: sh, characters: [{ character: MARA, primary: 'asset-mara' }], locationPlate: 'asset-north' });
  assert.equal(plan.generate, undefined);
  assert.equal(plan.prompt, buildImagePrompt(sh, s).prompt + panelLocationNote(CAPSULE));
  assert.deepEqual(plan.compose, {
    baseKind: 'location', base: 'asset-north',
    characters: [{ name: 'MARA', identityLine: 'a bush pilot, wearing flight suit', ref: 'asset-mara' }],
    sceneDescription: plan.prompt, blocking: 'Mara left.', aesthetic: 'noir, cold', model: 'nano-banana-2-edit',
    recipeLabel: 'reference-drafted panel (location base)',
  });
});

test('a character shot without a plate is a t2i draft, then an identity composite', () => {
  const s = series({ storyboardAspectRatio: '9:16', videoDefaults: { actionModel: 'x', atmosphereModel: 'x', imageDefaults: { generationModel: 'gpt-image-2', editModel: 'qwen-image-2-edit' } } });
  const sh = shot(['MARA', 'JUNO'], undefined);
  const plan = planPanelDraft({ series: s, shot: sh, characters: [{ character: MARA, primary: 'a' }, { character: JUNO, primary: 'b' }], cfgScale: 7 });
  const image = buildImagePrompt(sh, s);
  assert.deepEqual(plan.generate, {
    model: 'gpt-image-2', prompt: image.prompt, negative_prompt: image.negativePrompt, resolution: '1K', aspect_ratio: '9:16',
    steps: 30, cfg_scale: 7, seed: image.seed, safe_mode: false, hide_watermark: true,
  });
  assert.equal(plan.generateLabel, 'scene draft (pre-identity)');
  assert.equal(plan.generateHasFace, true);
  assert.equal(plan.compose.baseKind, 'scene-draft');
  assert.equal(plan.compose.base, undefined);
  assert.equal(plan.compose.model, 'qwen-image-2-edit');
  assert.deepEqual(plan.compose.characters.map(c => c.ref), ['a', 'b']);
});

test('faceless shots: an edit of the plate, else plain t2i', () => {
  const s = series();
  const onPlate = planPanelDraft({ series: s, shot: shot([], 'capsule'), characters: [], locationPlate: 'p' });
  assert.equal(onPlate.generate, undefined);
  assert.equal(onPlate.compose.base, 'p');
  assert.deepEqual(onPlate.compose.characters, []);
  assert.equal(onPlate.compose.recipeLabel, 'reference-drafted establishing panel (location base)');
  const plain = planPanelDraft({ series: s, shot: shot([], undefined), characters: [] });
  assert.equal(plain.compose, undefined);
  assert.equal(plain.generateLabel, 'base panel');
  assert.equal(plain.generateHasFace, false);
});

test('characters with no reference are text-only; none at all is plain t2i', () => {
  const plan = planPanelDraft({ series: series(), shot: shot(['MARA', 'JUNO'], 'capsule'), characters: [{ character: MARA }, { character: JUNO, primary: 'j' }], locationPlate: 'p' });
  assert.deepEqual(plan.missingReferences, ['MARA']);
  assert.deepEqual(plan.compose.characters.map(c => c.name), ['JUNO']);
  const none = planPanelDraft({ series: series(), shot: shot(['MARA'], undefined), characters: [{ character: MARA }] });
  assert.equal(none.compose, undefined);
  assert.equal(none.generateLabel, 'base panel');
  assert.equal(none.generateHasFace, true);
});

test('the reference draft prompt numbers layers after the base', () => {
  const prompt = buildReferenceDraftPrompt({ baseKind: 'scene-draft', characters: [{ name: 'A', identityLine: 'x' }], sceneDescription: 'Scene.', aesthetic: 'noir' });
  assert.match(prompt, /^Image 1 is the scene draft/);
  assert.match(prompt, /match the person in image 2 exactly/);
  assert.match(prompt, /STYLE: noir\.$/);
});

test('pass 2: identity unless reference-drafted, style against the plate then the anchor', () => {
  const shots = [shot([], undefined, { shotNumber: 1 }), shot(['MARA'], undefined, { shotNumber: 2 }), shot(['JUNO'], undefined, { shotNumber: 3 })];
  assert.deepEqual(panelRefineOrder(shots).map(s => s.shotNumber), [2, 3, 1]);
  assert.equal(styleAnchorShot(shots).shotNumber, 2);
  assert.deepEqual(panelRefineStep(shot(['MARA'], undefined), { referenceDrafted: true }), { kind: 'skip', reason: 'reference-drafted' });
  assert.deepEqual(panelRefineStep(shot(['MARA'], undefined), { referenceDrafted: false }), { kind: 'identity' });
  assert.deepEqual(panelRefineStep(shot([], 'capsule'), { referenceDrafted: true, locationPlate: 'p', styleAnchor: 'a' }), { kind: 'style', anchor: 'p', locationAnchor: true });
  assert.deepEqual(panelRefineStep(shot([], undefined), { referenceDrafted: false, styleAnchor: 'a' }), { kind: 'style', anchor: 'a', locationAnchor: false });
  assert.deepEqual(panelRefineStep(shot([], undefined), { referenceDrafted: false }), { kind: 'skip', reason: 'no-anchor' });
  assert.deepEqual(panelRefineStep(shot(['MARA'], undefined, { skipRefine: true }), { referenceDrafted: false }), { kind: 'skip', reason: 'skip-refine' });
});

test('the style match keeps empty aesthetic parts and flags daytime', () => {
  assert.equal(styleMatchAesthetic({ style: 'noir', palette: 'cold', lighting: '' }), 'noir, cold, ');
  assert.match(buildStyleMatchPrompt('noir', 'DAY_EXTERIOR'), /BRIGHT DAYTIME/);
  assert.doesNotMatch(buildStyleMatchPrompt('noir', 'NIGHT_INTERIOR'), /DAYTIME/);
});

test('the identity refine: second angle alone, plate in the last layer, plate dropped for two', () => {
  const refs = { MARA: { primary: 'm', secondAngle: 'm2' }, JUNO: { primary: 'j' }, TOMAS: { primary: 't' } };
  const asked = [];
  const referencesOf = c => { asked.push(c.name); return refs[c.name]; };
  assert.deepEqual(planCharacterFix({ characters: [MARA], referencesOf }).references, ['m', 'm2']);
  const withPlate = planCharacterFix({ characters: [MARA], referencesOf, environmentRef: 'p' });
  assert.deepEqual(withPlate.references, ['m', 'p']);
  assert.match(withPlate.prompt, /final reference image is the location environment/);
  asked.length = 0;
  const three = planCharacterFix({ characters: [MARA, JUNO, TOMAS], referencesOf, environmentRef: 'p' });
  assert.deepEqual(asked, ['MARA', 'JUNO']);
  assert.deepEqual(three.references, ['m', 'j']);
  assert.equal(three.locationDropped, true);
  assert.deepEqual(three.anchored, ['MARA', 'JUNO']);
  assert.deepEqual(three.textOnly, ['TOMAS']);
  assert.match(three.prompt, /^Make both characters match/);
});

test('the scene-ref prompt leads with the description when there is one', () => {
  assert.match(buildSceneRefPrompt('Paint the logo.'), /^Paint the logo\. Preserve/);
  assert.match(buildSceneRefPrompt(), /^Integrate the visual elements/);
});
