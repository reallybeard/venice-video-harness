// The pure pipeline gates in packages/core: whether a stage may run, the first
// reason it may not, and the command that clears it. The commands' printed
// output over real projects is pinned by gate-commands-golden.test.mjs; what
// `status` makes of a block is pinned by status-golden.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GATED_STAGES,
  GATE_REMEDY_COMMANDS,
  STORYBOARD_CHARACTER_SHEETS,
  STORYBOARD_LOCATION_PLATES,
  addCharacterValues,
  fillCommand,
  gateFor,
  missingReferences,
  scriptApproved,
  stageCommandTemplate,
} from '../packages/core/dist/session/gates.js';
import { stageCommand } from '../packages/core/dist/session/status.js';
import { PIPELINE_STAGES } from '../packages/core/dist/agent/pipeline.js';
import * as barrel from '../packages/core/dist/index.js';
import * as coreStatus from '../packages/core/dist/session/status.js';
import * as cliGates from '../dist/session/gates.js';

const MARA = { name: 'MARA', cast: { name: 'Mara', gender: 'female', age: '40s' } };

function stale(shotKey, ...kinds) {
  return { shotKey, mismatches: kinds.map(kind => ({ kind })) };
}

// ---- gateFor: each gated stage ------------------------------------------------

test('storyboard: an unapproved script blocks, and either approval marker clears it', () => {
  const result = gateFor('storyboard', { episode: 2 });
  assert.equal(result.blocked, true);
  assert.deepEqual(result.reason, { kind: 'script-not-approved' });
  assert.equal(result.summary, 'script not approved');
  assert.deepEqual(result.remedy, { stageId: 'approve-script', command: 'approve-script -e 2' });

  assert.deepEqual(gateFor('storyboard', { episode: 2, scriptApprovalArtifact: true }), { blocked: false });
  assert.deepEqual(gateFor('storyboard', { episode: 2, scriptStatusApproved: true }), { blocked: false });
});

test('storyboard: missing references block after approval, remedied one entity at a time', () => {
  const approved = { episode: 1, scriptStatusApproved: true };

  const both = gateFor('storyboard', { ...approved, missingReferences: { characters: [MARA, { name: 'GHOST' }], locations: ['capsule'] } });
  assert.equal(both.blocked, true);
  assert.equal(both.reason.kind, 'references-missing');
  assert.equal(both.summary, 'references missing for MARA, GHOST, location capsule');
  assert.deepEqual(both.remedy, {
    action: 'add-character',
    command: 'add-character --name "Mara" --gender female --age "40s" --description "..." --wardrobe "..."',
  });

  const unknownCast = gateFor('storyboard', { ...approved, missingReferences: { characters: [{ name: 'GHOST' }], locations: [] } });
  assert.equal(unknownCast.remedy.command, 'add-character --name "GHOST" --gender <gender> --age "<age>" --description "..." --wardrobe "..."');

  const locationOnly = gateFor('storyboard', { ...approved, missingReferences: { characters: [], locations: ['capsule'] } });
  assert.equal(locationOnly.summary, 'references missing for location capsule');
  assert.deepEqual(locationOnly.remedy, { action: 'generate-location-references', command: 'generate-location-references -l "capsule"' });

  assert.deepEqual(gateFor('storyboard', { ...approved, missingReferences: { characters: [], locations: [] } }), { blocked: false });
});

test('storyboard: script approval is checked before references (the command\'s order)', () => {
  const result = gateFor('storyboard', { episode: 1, missingReferences: { characters: [MARA], locations: [] } });
  assert.equal(result.reason.kind, 'script-not-approved');
});

test('qa-approve: missing, unreadable, criticals, unchecked, clean', () => {
  const missing = gateFor('qa-approve', { episode: 3 });
  assert.equal(missing.reason.kind, 'qa-report-missing');
  assert.equal(missing.summary, 'no QA report');
  assert.deepEqual(missing.remedy, { stageId: 'qa-storyboard', command: 'qa-storyboard -e 3' });

  const unreadable = gateFor('qa-approve', { episode: 3, qaReported: true, qaReport: { parseError: 'Unexpected token' } });
  assert.deepEqual(unreadable.reason, { kind: 'qa-report-unreadable', error: 'Unexpected token' });
  assert.equal(unreadable.summary, 'qa-report.json unreadable');
  assert.equal(unreadable.remedy.stageId, 'qa-storyboard');

  const critical = gateFor('qa-approve', { episode: 3, qaReported: true, qaReport: { summary: { flagCritical: 2, errored: 1 }, criticalShots: [4, 7] } });
  assert.deepEqual(critical.reason, { kind: 'qa-issues', criticalCount: 2, uncheckedCount: 1, criticalShots: [4, 7] });
  assert.equal(critical.summary, '2 critical, 1 unchecked');
  assert.deepEqual(critical.remedy, { action: 'fix-panel', command: 'fix-panel -e 3 -s 4' });

  const criticalUnknownShot = gateFor('qa-approve', { episode: 3, qaReported: true, qaReport: { summary: { flagCritical: 1 } } });
  assert.equal(criticalUnknownShot.remedy.command, 'fix-panel -e 3 -s <shot>');

  // Unchecked only: nothing to fix, QA just has to read the shots.
  const unchecked = gateFor('qa-approve', { episode: 3, qaReported: true, qaReport: { summary: { flagCritical: 0, errored: 2 } } });
  assert.equal(unchecked.summary, '0 critical, 2 unchecked');
  assert.deepEqual(unchecked.remedy, { stageId: 'qa-storyboard', command: 'qa-storyboard -e 3' });

  assert.deepEqual(gateFor('qa-approve', { episode: 3, qaReported: true, qaReport: { summary: { flagCritical: 0, errored: 0 } } }), { blocked: false });
  // A report without a summary has nothing flagged: the command approves it.
  assert.deepEqual(gateFor('qa-approve', { episode: 3, qaReported: true, qaReport: {} }), { blocked: false });
});

test('render: not approved, unreadable, stale, bound', () => {
  const notApproved = gateFor('render', { episode: 1 });
  assert.deepEqual(notApproved.reason, { kind: 'qa-not-approved' });
  assert.equal(notApproved.summary, 'QA not approved');
  assert.deepEqual(notApproved.remedy, { stageId: 'qa-approve', command: 'qa-approve -e 1' });

  const unreadable = gateFor('render', { episode: 1, qaApproved: true, approval: { parseError: 'bad json' } });
  assert.deepEqual(unreadable.reason, { kind: 'approval-unreadable', error: 'bad json' });
  assert.equal(unreadable.summary, 'qa-approved.json unreadable');
  assert.equal(unreadable.remedy.stageId, 'qa-approve');

  const changed = [stale('001', 'panel-changed'), stale('003', 'not-recorded')];
  const stalled = gateFor('render', { episode: 1, qaApproved: true, approval: { approvedAt: '2026-10-01T00:00:00.000Z', stale: changed } });
  assert.deepEqual(stalled.reason, { kind: 'approval-stale', approvedAt: '2026-10-01T00:00:00.000Z', stale: changed });
  assert.equal(stalled.summary, '2 shot(s) changed after QA approval');
  assert.deepEqual(stalled.remedy, { stageId: 'qa-approve', command: 'qa-approve -e 1' });

  assert.deepEqual(gateFor('render', { episode: 1, qaApproved: true, approval: { stale: [] } }), { blocked: false });
});

test('assemble: a failing video-QA report blocks; a missing or unreadable one only advises', () => {
  const failed = gateFor('assemble', { episode: 1, videoQaReported: true, videoQaReport: { summary: { passed: false, criticals: 3 } } });
  assert.deepEqual(failed.reason, { kind: 'video-qa-failed', criticals: 3 });
  assert.equal(failed.summary, 'video QA found 3 critical issue(s)');
  assert.deepEqual(failed.remedy, { action: 'harvest-anchor', command: 'harvest-anchor -c <CHARACTER> --video <unit-master> --at <sec>' });

  const noCount = gateFor('assemble', { episode: 1, videoQaReported: true, videoQaReport: { summary: { passed: false } } });
  assert.equal(noCount.summary, 'video QA found ? critical issue(s)');

  assert.deepEqual(gateFor('assemble', { episode: 1 }), { blocked: false, advisory: 'video-qa-missing' });
  assert.deepEqual(gateFor('assemble', { episode: 1, videoQaReported: true, videoQaReport: { parseError: 'x' } }), { blocked: false, advisory: 'video-qa-unreadable' });
  assert.deepEqual(gateFor('assemble', { episode: 1, videoQaReported: true, videoQaReport: { summary: { passed: true } } }), { blocked: false });
  // No summary: treated as missing by videoQaBlocksAssembly, so it neither blocks nor advises.
  assert.deepEqual(gateFor('assemble', { episode: 1, videoQaReported: true, videoQaReport: {} }), { blocked: false });
});

test('ungated stages always pass', () => {
  const ungated = PIPELINE_STAGES.filter(s => s.scope === 'episode' && !GATED_STAGES.includes(s.id));
  assert.ok(ungated.length > 0);
  for (const stage of ungated) {
    assert.deepEqual(gateFor(stage.id, { episode: 1 }), { blocked: false }, stage.id);
  }
  assert.deepEqual([...GATED_STAGES], ['storyboard', 'qa-approve', 'render', 'assemble']);
});

// ---- Absent facts, bypass ------------------------------------------------------

test('a gate fact the host did not supply never blocks', () => {
  // Existence markers set, contents unread: only the marker gates decide.
  assert.deepEqual(gateFor('storyboard', { episode: 1, scriptStatusApproved: true }), { blocked: false });
  assert.deepEqual(gateFor('qa-approve', { episode: 1, qaReported: true }), { blocked: false });
  assert.deepEqual(gateFor('render', { episode: 1, qaApproved: true }), { blocked: false });
  assert.deepEqual(gateFor('assemble', { episode: 1, videoQaReported: true }), { blocked: false });
});

test('bypass waives the named reason and only it', () => {
  const facts = { episode: 1, missingReferences: { characters: [MARA], locations: [] } };
  // --skip-approval waives approval, not the reference preflight.
  const skipApproval = gateFor('storyboard', facts, { bypass: ['script-not-approved'] });
  assert.equal(skipApproval.reason.kind, 'references-missing');
  assert.deepEqual(gateFor('storyboard', { episode: 1 }, { bypass: ['script-not-approved'] }), { blocked: false });

  // qa-approve --force waives QA issues, not a missing or unreadable report.
  const flagged = { episode: 1, qaReported: true, qaReport: { summary: { flagCritical: 1 } } };
  assert.deepEqual(gateFor('qa-approve', flagged, { bypass: ['qa-issues'] }), { blocked: false });
  assert.equal(gateFor('qa-approve', { episode: 1 }, { bypass: ['qa-issues'] }).reason.kind, 'qa-report-missing');
  assert.equal(gateFor('qa-approve', { episode: 1, qaReported: true, qaReport: { parseError: 'x' } }, { bypass: ['qa-issues'] }).reason.kind, 'qa-report-unreadable');

  // Waiving the video-QA block also silences its advisory (--skip-video-qa skips the whole check).
  assert.deepEqual(gateFor('assemble', { episode: 1 }, { bypass: ['video-qa-failed'] }), { blocked: false });
  const failed = { episode: 1, videoQaReported: true, videoQaReport: { summary: { passed: false } } };
  assert.deepEqual(gateFor('assemble', failed, { bypass: ['video-qa-failed'] }), { blocked: false });
});

// ---- Remedies ------------------------------------------------------------------

test('a stage remedy is exactly the command status suggests for that stage', () => {
  const cases = [
    gateFor('storyboard', { episode: 4 }),
    gateFor('qa-approve', { episode: 4 }),
    gateFor('qa-approve', { episode: 4, qaReported: true, qaReport: { summary: { errored: 1 } } }),
    gateFor('render', { episode: 4 }),
  ];
  for (const result of cases) {
    assert.equal(result.blocked, true);
    assert.ok(result.remedy.stageId, result.summary);
    assert.equal(result.remedy.action, undefined);
    assert.equal(result.remedy.command, stageCommand(result.remedy.stageId, 4));
  }
});

test('action remedies are not pipeline stages, and pipeline does not list them', () => {
  const stageIds = new Set(PIPELINE_STAGES.map(s => s.id));
  for (const [action, template] of Object.entries(GATE_REMEDY_COMMANDS)) {
    assert.ok(!stageIds.has(action), `${action} must not be a pipeline stage`);
    assert.ok(template.startsWith(`${action} -p <project>`), template);
  }
  // add-character is a project-scope stage too, with a shorter template; the remedy uses the full one.
  assert.notEqual(GATE_REMEDY_COMMANDS['add-character'], PIPELINE_STAGES.find(s => s.command.startsWith('add-character'))?.command);
});

test('fillCommand: project, episode and placeholders, in one pass', () => {
  const template = 'thing -p <project> -e <n> --name "<NAME>" --at <sec>';
  assert.equal(fillCommand(template), 'thing -e <n> --name "<NAME>" --at <sec>');
  assert.equal(fillCommand(template, { episode: 2 }), 'thing -e 2 --name "<NAME>" --at <sec>');
  assert.equal(fillCommand(template, { project: '/p', episode: 2, values: { NAME: 'Mara' } }), 'thing -p /p -e 2 --name "Mara" --at <sec>');
  // A filled value that looks like a placeholder is not filled again.
  assert.equal(fillCommand(template, { project: '<sec>', values: { NAME: '<sec>', sec: '9' } }), 'thing -p <sec> -e <n> --name "<sec>" --at 9');
  // Unknown and inherited keys stay as they are.
  assert.equal(fillCommand('x <toString> <constructor>'), 'x <toString> <constructor>');
});

test('stageCommandTemplate reads the pipeline table and refuses unknown ids', () => {
  assert.equal(stageCommandTemplate('qa-approve'), 'qa-approve -p <project> -e <n>');
  assert.throws(() => stageCommandTemplate('fix-panel'), /not in PIPELINE_STAGES/);
});

test('addCharacterValues falls back to placeholders for a character the series lacks', () => {
  assert.deepEqual(addCharacterValues(MARA), { NAME: 'Mara', gender: 'female', age: '40s' });
  assert.deepEqual(addCharacterValues({ name: 'GHOST' }), { NAME: 'GHOST', gender: '<gender>', age: '<age>' });
  assert.deepEqual(addCharacterValues({ name: 'X', cast: { name: 'X' } }), { NAME: 'X', gender: '<gender>', age: '<age>' });
});

// ---- Rule 54 -------------------------------------------------------------------

test('missingReferences dedupes by upper-cased name, skips unknown slugs, probes by series slug', () => {
  const series = {
    characters: [{ name: 'Mara', gender: 'female', age: '40s' }, { name: 'Juno', gender: 'male', age: '20s' }],
    locations: [{ name: 'Capsule Interior', slug: 'capsule' }, { name: 'Dock', slug: 'dock' }],
  };
  const shots = [
    { characters: ['Mara', 'JUNO'], location: 'capsule' },
    { characters: ['mara', 'Ghost'], location: 'Capsule Interior' },
    { characters: [], location: 'nowhere' },
    { characters: ['Juno'], location: 'dock' },
    { characters: [] },
  ];
  const probes = [];
  const present = new Set(['character:JUNO', 'location:dock']);
  const result = missingReferences(series, shots, (entity, files) => {
    probes.push({ entity, files });
    return present.has(entity.kind === 'character' ? `character:${entity.name}` : `location:${entity.slug}`);
  });

  assert.deepEqual(result, {
    characters: [
      { name: 'MARA', cast: { name: 'Mara', gender: 'female', age: '40s' } },
      { name: 'GHOST' },
    ],
    locations: ['capsule', 'Capsule Interior'],
  });
  // Characters probed once each, upper-cased, against the sheet list.
  const charProbes = probes.filter(p => p.entity.kind === 'character');
  assert.deepEqual(charProbes.map(p => p.entity.name), ['MARA', 'JUNO', 'GHOST']);
  assert.ok(charProbes.every(p => p.files === STORYBOARD_CHARACTER_SHEETS));
  // Locations probed by resolved slug; the unknown slug is never probed.
  const locProbes = probes.filter(p => p.entity.kind === 'location');
  assert.deepEqual(locProbes.map(p => p.entity.slug), ['capsule', 'capsule', 'dock']);
  assert.ok(locProbes.every(p => p.files === STORYBOARD_LOCATION_PLATES));
});

test('rule 54 accepts the sheets and plates the command has always accepted', () => {
  // anchor.png is deliberately absent (open question: rule 54 says it counts).
  assert.deepEqual([...STORYBOARD_CHARACTER_SHEETS], ['front.png', 'three-quarter.png']);
  assert.deepEqual([...STORYBOARD_LOCATION_PLATES], [
    'north.png', 'south.png', 'east.png', 'west.png', 'wide.png', 'angle-2.png', 'angle-3.png', 'angle-4.png', 'medium.png', 'detail.png',
  ]);
});

// ---- Exports -------------------------------------------------------------------

test('the barrel, the status module and the CLI re-export the same gate functions', () => {
  assert.equal(barrel.gateFor, gateFor);
  assert.equal(barrel.missingReferences, missingReferences);
  assert.equal(barrel.fillCommand, fillCommand);
  assert.equal(barrel.scriptApproved, scriptApproved);
  assert.equal(coreStatus.scriptApproved, scriptApproved);
  assert.equal(cliGates.gateFor, gateFor);
  assert.equal(cliGates.missingReferences, missingReferences);
  assert.equal(cliGates.GATE_REMEDY_COMMANDS, GATE_REMEDY_COMMANDS);
});
