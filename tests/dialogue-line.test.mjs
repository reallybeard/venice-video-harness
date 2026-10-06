// `ShotScript.dialogue` is `DialogueLine | DialogueLine[] | null`.
//
// Every consumer reads it through `dialogueLines(shot)` and decides voice-over
// through `isVoiceOverLine(line)`, both in core. A legacy single object must
// behave exactly as before (the dialogue-improv / audio-routing suites are
// the byte-identity guard for that); this file covers the normaliser itself,
// the explicit `voiceOver` flag, and the two-line case in each prompt
// builder. Nothing here reaches the CLI or a queue call.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dialogueLines,
  firstDialogueLine,
  isVoiceOverLine,
  onCameraDialogueLines,
  VOICE_OVER_SPEAKERS,
} from '../packages/core/dist/series/dialogue.js';
import * as barrel from '../packages/core/dist/index.js';
import {
  buildVideoPrompt,
  buildMultiShotPrompt,
  buildMontagePrompt,
  buildKlingMultiShotPrompt,
} from '../dist/mini-drama/prompt-builder.js';
import { mustRenderAsExactLipSync } from '../dist/mini-drama/generation-planner.js';
import { generateSubtitles } from '../dist/mini-drama/subtitle-generator.js';

const SEEDANCE = 'seedance-2-0-enhanced-reference-to-video';
const TURBO = 'minimax-h3-max-turbo-text-to-video';
const KLING = 'kling-v3-0-multi-shot';

function seriesFor(model, extraDefaults = {}) {
  return {
    name: 'Lines', slug: 'lines', concept: 'x', genre: 'drama', setting: 's', outputDir: '/tmp/none',
    aesthetic: { style: 'grainy 16mm noir', palette: 'amber and teal', lighting: 'low-key' },
    characters: [
      { name: 'ARIA', description: 'tall', wardrobe: 'red coat', voiceDescription: 'husky alto', voiceReferencePath: 'characters/aria/voice-reference.mp3' },
      { name: 'BOB', description: 'short', wardrobe: 'grey suit', voiceDescription: 'gravel baritone', voiceReferencePath: 'characters/bob/voice-reference.mp3' },
    ],
    locations: [],
    episodes: [{ number: 1, title: 'One', status: 'approved' }],
    videoDefaults: { actionModel: model, atmosphereModel: model, characterConsistencyModel: model, ...extraDefaults },
  };
}

function shotWith(dialogue, overrides = {}) {
  return {
    shotNumber: 1, type: 'dialogue', duration: '5s', videoModel: 'action',
    description: 'ARIA and BOB at the counter.', characters: ['ARIA', 'BOB'],
    dialogue, sfx: null, cameraMovement: 'static', transition: 'cut',
    ...overrides,
  };
}

const ARIA = { id: 'l1', character: 'ARIA', line: 'Hello there.', delivery: 'soft' };
const BOB = { id: 'l2', character: 'BOB', line: 'Hi yourself.' };
const NARR = { character: 'NARRATOR', line: 'And so it began.' };

// ── normaliser ─────────────────────────────────────────────────────────────

test('dialogueLines: single object -> one-element list, null/missing -> [], list -> same list', () => {
  const single = shotWith(ARIA);
  assert.deepEqual(dialogueLines(single), [ARIA]);
  assert.equal(dialogueLines(single)[0], ARIA, 'the same object, not a copy');
  assert.deepEqual(dialogueLines(shotWith(null)), []);
  assert.deepEqual(dialogueLines({}), []);
  const list = [ARIA, BOB];
  assert.equal(dialogueLines(shotWith(list)), list);
  assert.equal(firstDialogueLine(shotWith(list)), ARIA);
  assert.equal(firstDialogueLine(shotWith(null)), undefined);
});

test('isVoiceOverLine: NARRATOR / V.O. / VO by name, case-insensitive; anyone else is on camera', () => {
  for (const name of ['NARRATOR', 'V.O.', 'VO', 'narrator', 'Vo']) {
    assert.equal(isVoiceOverLine({ character: name, line: 'x' }), true, name);
  }
  assert.equal(isVoiceOverLine({ character: 'ARIA', line: 'x' }), false);
  assert.equal(isVoiceOverLine({ character: 'The Narrator', line: 'x' }), false, 'exact-name convention only');
  assert.deepEqual([...VOICE_OVER_SPEAKERS].sort(), ['NARRATOR', 'V.O.', 'VO']);
});

test('isVoiceOverLine: an explicit voiceOver flag wins over the name either way', () => {
  assert.equal(isVoiceOverLine({ character: 'ARIA', line: 'x', voiceOver: true }), true, 'non-NARRATOR speaker marked VO');
  assert.equal(isVoiceOverLine({ character: 'NARRATOR', line: 'x', voiceOver: false }), false, 'NARRATOR explicitly on camera');
  assert.deepEqual(onCameraDialogueLines(shotWith([ARIA, { ...BOB, voiceOver: true }, NARR])), [ARIA]);
});

test('the dialogue helpers are on the core barrel', () => {
  assert.equal(barrel.dialogueLines, dialogueLines);
  assert.equal(barrel.isVoiceOverLine, isVoiceOverLine);
  assert.equal(barrel.onCameraDialogueLines, onCameraDialogueLines);
  assert.equal(barrel.firstDialogueLine, firstDialogueLine);
});

// ── voiceOver honoured by the consumers ─────────────────────────────────────

test('voiceOver: true on a named speaker is treated as VO by the single-shot builder and the lip-sync gate', () => {
  const series = seriesFor(SEEDANCE);
  const vo = buildVideoPrompt(shotWith({ ...ARIA, voiceOver: true }), series);
  assert.ok(!vo.prompt.includes('Hello there.'), 'VO line withheld from the prompt');
  assert.ok(vo.prompt.includes('No narration, no voice-over, no spoken words in this shot.'));
  assert.equal(vo.voiceReferenceSlots, undefined, 'no @Audio binding for a VO line');

  const lipSync = seriesFor(SEEDANCE, { audioStrategy: 'lip-sync' }).videoDefaults;
  assert.equal(mustRenderAsExactLipSync(shotWith(ARIA), lipSync), true);
  assert.equal(mustRenderAsExactLipSync(shotWith({ ...ARIA, voiceOver: true }), lipSync), false);
  assert.equal(mustRenderAsExactLipSync(shotWith({ ...NARR, voiceOver: false }), lipSync), true, 'NARRATOR on camera when told so');
});

test('a one-element list produces the same prompt as the bare object', () => {
  const series = seriesFor(SEEDANCE);
  const asObject = buildVideoPrompt(shotWith(ARIA), series);
  const asList = buildVideoPrompt(shotWith([ARIA]), series);
  assert.equal(asList.prompt, asObject.prompt);
  assert.deepEqual(asList.voiceReferenceSlots, asObject.voiceReferenceSlots);
  assert.equal(asList.audio, asObject.audio);
});

// ── two lines on a shot ─────────────────────────────────────────────────────

test('buildVideoPrompt: two lines emit two dialogue blocks, in order, with a voice slot per speaker', () => {
  const series = seriesFor(SEEDANCE);
  const p = buildVideoPrompt(shotWith([ARIA, BOB]), series);
  const a = p.prompt.indexOf(']: "Hello there."');
  const b = p.prompt.indexOf(']: "Hi yourself."');
  assert.ok(a >= 0, 'first line present');
  assert.ok(b >= 0, 'second line present');
  assert.ok(a < b, 'script order kept');
  assert.equal((p.prompt.match(/\]: "/g) ?? []).length, 2, 'exactly two dialogue blocks');
  assert.deepEqual(p.voiceReferenceSlots, [
    { characterName: 'ARIA', audioIndex: 1 },
    { characterName: 'BOB', audioIndex: 2 },
  ]);
  // No reference images in this fixture, so refs are bare names rather than @ImageN.
  assert.ok(p.prompt.includes('Use @Audio1 only for ARIA\'s voice identity'), 'both speakers bound: slot 1 named');
  assert.ok(p.prompt.includes('Use @Audio2 only for BOB\'s voice identity'), 'both speakers bound: slot 2 named');
  assert.ok(!p.prompt.includes('use it only if'), 'neither speaker is a "non-speaking" binding');
});

test('buildVideoPrompt: a VO line in a list is withheld while the on-camera line still renders', () => {
  const p = buildVideoPrompt(shotWith([NARR, BOB]), seriesFor(SEEDANCE));
  assert.ok(!p.prompt.includes('And so it began.'));
  assert.ok(p.prompt.includes(']: "Hi yourself."'));
  assert.ok(!p.prompt.includes('No narration, no voice-over'), 'the no-speech clause is for all-VO shots only');
});

test('simple-prompt model: two lines both render as intent with a single improv note', () => {
  const p = buildVideoPrompt(shotWith([ARIA, BOB]), seriesFor(TURBO));
  assert.ok(p.prompt.includes('conveys: "Hello there."'));
  assert.ok(p.prompt.includes('conveys: "Hi yourself."'));
  assert.equal((p.prompt.match(/Improvise the spoken dialogue/g) ?? []).length, 1);
});

function unitFor(model) {
  return {
    kind: 'multi-shot', shotNumbers: [1, 2], model, duration: '10s',
    montageBeats: [{ startSec: 0, endSec: 5 }, { startSec: 5, endSec: 10 }],
  };
}

test('multi-shot / montage / Kling builders emit one block per line in order', () => {
  const shots = [
    shotWith([ARIA, BOB], { shotNumber: 1 }),
    shotWith({ character: 'ARIA', line: 'Second beat.' }, { shotNumber: 2 }),
  ];
  for (const [fn, model] of [
    [buildMultiShotPrompt, SEEDANCE],
    [buildMontagePrompt, SEEDANCE],
    [buildKlingMultiShotPrompt, KLING],
  ]) {
    const p = fn(shots, unitFor(model), seriesFor(model));
    const a = p.prompt.indexOf('"Hello there."');
    const b = p.prompt.indexOf('"Hi yourself."');
    const c = p.prompt.indexOf('"Second beat."');
    assert.ok(a >= 0 && b >= 0 && c >= 0, `${fn.name}: all three lines present`);
    assert.ok(a < b && b < c, `${fn.name}: order kept`);
  }
});

test('subtitles: a shot with two lines yields one cue carrying both, in order', () => {
  const entries = generateSubtitles([shotWith([{ character: 'ARIA', line: 'One two.' }, { character: 'BOB', line: 'Three four.' }])]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, 'One two. Three four.');
});
