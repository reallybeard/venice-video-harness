// The pure QA half in packages/core: storyboard QA, post-render video QA and
// the panel approval binding, exercised without ffmpeg, disk or a model.
// The src modules re-export these; the CLI-level behaviour is covered by
// video-qa.test.mjs and panel-approval.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  buildStoryboardQaUserPrompt,
  missingPanelResult,
  parseShotSelection,
  priorPanelNote,
  priorShotInLocation,
  shotQaFailure,
  shotQaFromReply,
  storyboardApprovalBlock,
  storyboardQaClean,
  storyboardQaModelChain,
  summarizeStoryboardQa,
} from '../packages/core/dist/mini-drama/storyboard-qa.js';
import {
  classifyBoundary,
  crossUnitFailure,
  crossUnitFromReply,
  findHeadGlitch,
  midBeatSampleSec,
  pickHeroFrames,
  pickProtagonist,
  summarizeVideoQa,
  unitIdentityFailure,
  videoQaBlocksAssembly,
  emptyCrossUnitResult,
} from '../packages/core/dist/mini-drama/video-qa.js';
import {
  canonicalJson,
  checkApproval,
  panelSettingsFrom,
  settingsDigestWith,
} from '../packages/core/dist/mini-drama/panel-approval.js';
import { extractJsonBlock } from '../packages/core/dist/venice/json-block.js';
import * as barrel from '../packages/core/dist/index.js';
import * as srcVideoQa from '../dist/mini-drama/video-qa.js';
import * as srcApproval from '../dist/mini-drama/panel-approval.js';
import { extractJsonBlock as clientExtractJsonBlock } from '../dist/venice/client.js';

const shot = (n, extra = {}) => ({
  shotNumber: n, type: 'action', duration: '5s', videoModel: 'action', environment: 'DAY_EXTERIOR',
  description: `shot ${n}`, characters: [], cameraMovement: 'static', transition: 'CUT', ...extra,
});

// ---- Storyboard QA ---------------------------------------------------------

test('parseShotSelection reads lists and ranges', () => {
  assert.deepEqual([...parseShotSelection('3,5,7')], [3, 5, 7]);
  assert.deepEqual([...parseShotSelection('1,4-6')], [1, 4, 5, 6]);
});

test('the model chain adds the vision companion only when it differs', () => {
  assert.deepEqual(storyboardQaModelChain('a', 'b'), ['a', 'b']);
  assert.deepEqual(storyboardQaModelChain('a', 'a'), ['a']);
});

test('priorShotInLocation picks the nearest earlier shot in the same location', () => {
  const shots = [shot(1, { location: 'bar' }), shot(2, { location: 'street' }), shot(3, { location: 'bar' }), shot(4, { location: 'bar' })];
  assert.equal(priorShotInLocation(shots, shots[3]).shotNumber, 3);
  assert.equal(priorShotInLocation(shots, shots[0]), undefined);
  assert.equal(priorShotInLocation(shots, shot(5)), undefined);
  assert.match(priorPanelNote(shot(3, { blocking: 'ARIA left' })), /shot 3, blocking: ARIA left\)/);
});

test('the user prompt carries description, blocking, landmarks, wardrobe and the prior-panel note', () => {
  const characters = [{ name: 'ARIA', description: 'inventor', wardrobe: 'jacket' }];
  const s = shot(2, { characters: ['ARIA'], blocking: 'ARIA screen left', episodeWardrobe: { ARIA: 'raincoat' } });
  const prompt = buildStoryboardQaUserPrompt({
    shot: s, characters, location: { spatialAnchors: 'bar along the back wall' }, priorPanelNote: 'PRIOR',
  });
  const lines = prompt.split('\n');
  assert.equal(lines[0], 'Analyze this storyboard panel (image 1) for shot 2.');
  assert.ok(lines.includes('Stated blocking: ARIA screen left'));
  assert.ok(lines.includes('Location landmarks (fixed layout): bar along the back wall'));
  assert.ok(lines.includes('Characters in shot: ARIA: inventor, wearing raincoat. Reference images follow the panel.'));
  assert.equal(lines.at(-1), 'PRIOR');

  const empty = buildStoryboardQaUserPrompt({ shot: shot(3), characters });
  assert.match(empty, /No characters expected in this shot/);
  assert.equal(empty.split('\n').length, 4);
});

test('an unread shot is unchecked, not a pass, and suppresses the qa-approve suggestion', () => {
  const results = [
    shotQaFromReply(shot(1), { verdict: 'PASS', issues: [], notes: '' }),
    shotQaFailure(shot(2), 'empty reply'),
    missingPanelResult(shot(3)),
  ];
  assert.equal(results[1].errored, true);
  assert.equal(results[1].verdict, 'FLAG-LOW');
  const summary = summarizeStoryboardQa(results);
  assert.deepEqual(summary, { total: 3, pass: 1, flagCritical: 1, flagModerate: 0, flagLow: 1, errored: 1 });
  assert.equal(storyboardQaClean(summary), false);
  assert.equal(storyboardQaClean({ flagCritical: 0, errored: 1 }), false);
  assert.equal(storyboardQaClean({ flagCritical: 0, errored: 0 }), true);
});

test('the qa-approve gate blocks on criticals or unchecked shots and tolerates a partial summary', () => {
  assert.deepEqual(storyboardApprovalBlock({ flagCritical: 1, errored: 2 }), { blocked: true, criticalCount: 1, uncheckedCount: 2 });
  assert.deepEqual(storyboardApprovalBlock({ flagCritical: 0, errored: 0 }), { blocked: false, criticalCount: 0, uncheckedCount: 0 });
  assert.deepEqual(storyboardApprovalBlock(undefined), { blocked: false, criticalCount: 0, uncheckedCount: 0 });
});

// ---- Video QA --------------------------------------------------------------

test('findHeadGlitch flags a spike that reverts and ignores a held scene change', () => {
  const flash = [32, 32, 32, 32, 235, 235, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32];
  assert.deepEqual(findHeadGlitch(flash, 'u1'), { unitId: 'u1', frameIndex: 4, lumaDelta: 203 });
  const cut = [32, 32, 32, 32, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200];
  assert.equal(findHeadGlitch(cut, 'u1'), undefined);
  assert.equal(findHeadGlitch([], 'u1'), undefined);
  // Outside the window it is not a head glitch.
  assert.equal(findHeadGlitch(flash, 'u1', { windowFrames: 4 }), undefined);
});

test('classifyBoundary warns above 35 and fails above 60', () => {
  assert.equal(classifyBoundary('a', 'b', 100, 130), undefined);
  assert.deepEqual(classifyBoundary('a', 'b', 100, 140), { fromUnit: 'a', toUnit: 'b', lumaDelta: 40, severity: 'warn' });
  assert.deepEqual(classifyBoundary('a', 'b', 100, 30), { fromUnit: 'a', toUnit: 'b', lumaDelta: 70, severity: 'fail' });
});

test('midBeatSampleSec clamps inside the master', () => {
  assert.equal(midBeatSampleSec({ startOffsetSec: 2, durationSec: 4 }, 10), 4);
  assert.equal(midBeatSampleSec({ startOffsetSec: 8, durationSec: 6 }, 10), 9.9);
  assert.equal(midBeatSampleSec({ startOffsetSec: 0, durationSec: 0 }, 0), 0);
});

test('crossUnitFromReply maps 1-based frames to units and never counts unclear frames as drift', () => {
  const r = crossUnitFromReply(
    { verdict: 'FLAG-CRITICAL', issues: ['different hair'], driftingFrames: [2, 9], unclearFrames: [3], notes: '' },
    ['s01', 's02', 's03'],
  );
  assert.deepEqual(r.driftingUnits, ['s02']);
  assert.deepEqual(r.issues, ['different hair', 'protagonist not clearly visible in: s03 (not counted as drift)']);
  assert.equal(r.errored, undefined);
});

test('protagonist and hero frames follow film order', () => {
  const shots = [shot(1, { characters: ['WREN'] }), shot(2, { characters: ['OTTO', 'WREN'] }), shot(3, { characters: ['OTTO'] })];
  assert.equal(pickProtagonist(shots), 'WREN');
  assert.equal(pickProtagonist([shot(1)]), undefined);
  const samples = [
    { unitId: 'u2', shotNumber: 3, atSec: 1, framePath: 'c' },
    { unitId: 'u2', shotNumber: 2, atSec: 2, framePath: 'b' },
    { unitId: 'u1', shotNumber: 1, atSec: 1, framePath: 'a' },
  ];
  assert.deepEqual(pickHeroFrames(['u1', 'u2', 'u3'], samples, shots, 'wren').map(s => s.framePath), ['a', 'b']);
});

test('summarizeVideoQa: criticals, unchecked results and the assembly gate', () => {
  const clean = summarizeVideoQa({ units: 2, headGlitches: [], boundaries: [], unitIdentity: [], crossUnit: emptyCrossUnitResult() });
  assert.deepEqual(clean, { units: 2, criticals: 0, errored: 0, passed: true });

  const s = summarizeVideoQa({
    units: 3,
    headGlitches: [{ unitId: 'u1', frameIndex: 2, lumaDelta: 90 }],
    boundaries: [{ fromUnit: 'u1', toUnit: 'u2', lumaDelta: 40, severity: 'warn' }, { fromUnit: 'u2', toUnit: 'u3', lumaDelta: 70, severity: 'fail' }],
    unitIdentity: [
      { unitId: 'u1', verdict: 'FLAG-CRITICAL', issues: [] },
      unitIdentityFailure('u2', 'empty'),
    ],
    crossUnit: crossUnitFailure('empty'),
  });
  assert.deepEqual(s, { units: 3, criticals: 3, errored: 2, passed: false });

  // Unchecked only: not passed, no criticals.
  const unchecked = summarizeVideoQa({ units: 1, headGlitches: [], boundaries: [], unitIdentity: [unitIdentityFailure('u1', 'x')], crossUnit: emptyCrossUnitResult() });
  assert.deepEqual(unchecked, { units: 1, criticals: 0, errored: 1, passed: false });

  assert.equal(videoQaBlocksAssembly({ summary: s }), true);
  assert.equal(videoQaBlocksAssembly({ summary: clean }), false);
  assert.equal(videoQaBlocksAssembly({}), false);
  assert.equal(videoQaBlocksAssembly(undefined), false);
});

// ---- Panel approval --------------------------------------------------------

const sha256 = s => createHash('sha256').update(s).digest('hex');

test('settingsDigestWith(sha256) is the CLI digest', () => {
  const settings = { prompt: 'p', generationModel: 'g', editModel: 'e', aspectRatio: '16:9', referenceImages: ['x.png'] };
  assert.equal(settingsDigestWith(settings, sha256), srcApproval.settingsDigest(settings));
  assert.equal(canonicalJson({ b: 1, a: [1, { d: undefined, c: 'x' }] }), '{"a":[1,{"c":"x"}],"b":1}');
});

test('panelSettingsFrom folds the location note in and defaults the image models', () => {
  const series = { videoDefaults: {}, characters: [] };
  const s = panelSettingsFrom({
    series,
    shot: shot(1, { skipRefine: true }),
    imagePrompt: { prompt: 'P', negativePrompt: 'N', seed: 7 },
    location: { description: 'a bar', lightingNotes: 'neon', spatialAnchors: 'door left' },
    referenceImages: ['locations/bar/north.png'],
  });
  assert.equal(s.prompt, 'P Location: a bar Lighting: neon. Fixed layout (never rearrange): door left.');
  assert.equal(s.aspectRatio, '16:9');
  assert.equal(s.skipRefine, true);
  assert.equal(typeof s.generationModel, 'string');
  assert.equal(panelSettingsFrom({ series, shot: shot(1), imagePrompt: { prompt: 'P' }, referenceImages: [] }).prompt, 'P');
});

test('checkApproval reports only the shots that changed', () => {
  const artifact = { episode: 1, approvedAt: 'now', notes: '', shots: { '001': { panelSha256: 'a', settingsDigest: 's' } } };
  const out = checkApproval(artifact, [
    { shotKey: '001', shotNumber: 1, panelSha256: 'a', settingsDigest: 's' },
    { shotKey: '002', shotNumber: 2, panelSha256: 'b', settingsDigest: 's' },
  ]);
  assert.deepEqual(out, [{ shotKey: '002', shotNumber: 2, mismatches: [{ kind: 'not-recorded' }] }]);
});

// ---- Surfaces --------------------------------------------------------------

test('extractJsonBlock is the same function from core and the client', () => {
  assert.equal(clientExtractJsonBlock, extractJsonBlock);
  assert.deepEqual(JSON.parse(extractJsonBlock('```json\n{"a":1}\n```')), { a: 1 });
});

test('the barrel and the src modules expose the moved QA code', () => {
  for (const name of ['summarizeStoryboardQa', 'STORYBOARD_QA_SYSTEM_PROMPT', 'findHeadGlitch', 'IDENTITY_SYSTEM_PROMPT',
    'compareApproval', 'checkApproval', 'canonicalJson', 'extractJsonBlock']) {
    assert.ok(name in barrel, `barrel is missing ${name}`);
  }
  assert.equal(srcVideoQa.findHeadGlitch, findHeadGlitch);
  assert.equal(srcApproval.checkApproval, checkApproval);
});
