// The pure status classifier in packages/core: stage, gate and next command
// from plain facts, with no disk. Holds rules 45 and 48 as tests: every stage
// the classifier can name is a PIPELINE_STAGES entry, every entry is
// reachable, and the order agrees. The CLI's on-disk output is pinned by
// status-golden.test.mjs; treatment.test.mjs covers the CLI collector.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyEpisode,
  classifyProject,
  episodeStatusFromFacts,
  projectStatusFromFacts,
  scriptApproved,
  stageCommand,
} from '../packages/core/dist/session/status.js';
import { PIPELINE_BRANCHES, PIPELINE_STAGES } from '../packages/core/dist/agent/pipeline.js';
import * as barrel from '../packages/core/dist/index.js';
import * as cliStatus from '../dist/session/status.js';

const EPISODE_STAGE_IDS = PIPELINE_STAGES.filter(s => s.scope === 'episode').map(s => s.id);
const PROJECT_STAGE_IDS = PIPELINE_STAGES.filter(s => s.scope === 'project').map(s => s.id);

function facts(overrides = {}) {
  return {
    episode: 1, title: 'Pilot', hasScript: true, shotCount: 3,
    scriptApprovalArtifact: false, scriptStatusApproved: false,
    qaReported: false, qaApproved: false, videoQaReported: false,
    panelCount: 0, videoCount: 0, hasMusic: false, dialogueCount: 0, hasFinalCut: false,
    ...overrides,
  };
}

/** Cumulative facts at each point of a real run, in pipeline order. */
const PROGRESSION = [
  ['no script', 'script', facts({ hasScript: false, shotCount: 0 })],
  ['script drafted', 'approve-script', facts()],
  ['ready to storyboard', 'storyboard', facts({ scriptApprovalArtifact: true })],
  ['storyboarding (1/3 panels)', 'storyboard', facts({ scriptApprovalArtifact: true, panelCount: 1 })],
  ['panels complete', 'qa-storyboard', facts({ scriptApprovalArtifact: true, panelCount: 3 })],
  ['at QA gate', 'qa-approve', facts({ scriptApprovalArtifact: true, panelCount: 3, qaReported: true })],
  ['ready to render', 'render', facts({ scriptApprovalArtifact: true, panelCount: 3, qaReported: true, qaApproved: true })],
  ['rendering (2/3 clips)', 'render', facts({ scriptApprovalArtifact: true, panelCount: 3, qaReported: true, qaApproved: true, videoCount: 2 })],
  ['clips complete, unverified', 'qa-videos', facts({ scriptApprovalArtifact: true, panelCount: 3, qaReported: true, qaApproved: true, videoCount: 3 })],
  ['clips verified', 'assemble', facts({ scriptApprovalArtifact: true, panelCount: 3, qaReported: true, qaApproved: true, videoCount: 3, videoQaReported: true })],
  ['complete', undefined, facts({ scriptApprovalArtifact: true, panelCount: 3, qaReported: true, qaApproved: true, videoCount: 3, videoQaReported: true, hasFinalCut: true })],
];

test('classifyEpisode names the stage, the advancing pipeline stage and its shell-form command', () => {
  for (const [stage, nextStageId, f] of PROGRESSION) {
    const c = classifyEpisode(f);
    assert.equal(c.stage, stage);
    assert.equal(c.nextStageId, nextStageId, stage);
    assert.equal(c.nextCommand, nextStageId ? stageCommand(nextStageId, 1) : undefined, stage);
  }
  assert.equal(classifyEpisode(PROGRESSION[0][2]).nextCommand, 'workshop-episode -e 1 --concept "<what happens>"');
  assert.equal(classifyEpisode(facts({ episode: 12 })).nextCommand, 'approve-script -e 12');
});

test('the classification walks the pipeline table in its order', () => {
  const indices = PROGRESSION.filter(([, id]) => id).map(([, id]) => EPISODE_STAGE_IDS.indexOf(id));
  for (let i = 1; i < indices.length; i += 1) assert.ok(indices[i] >= indices[i - 1], `stage order regressed at ${i}`);
  assert.deepEqual([...new Set(PROGRESSION.map(([, id]) => id).filter(Boolean))], EPISODE_STAGE_IDS);
});

test('every episode stage classifyEpisode can return is in PIPELINE_STAGES, and every one is reachable (rules 45/48)', () => {
  const seen = new Set();
  const bools = [false, true];
  for (const hasScript of bools) for (const scriptApprovalArtifact of bools) for (const scriptStatusApproved of bools)
  for (const qaReported of bools) for (const qaApproved of bools) for (const videoQaReported of bools) for (const hasFinalCut of bools)
  for (const panelCount of [0, 1, 3, 4]) for (const videoCount of [0, 1, 3, 4]) for (const shotCount of [0, 3]) {
    const c = classifyEpisode(facts({
      hasScript, shotCount: hasScript ? shotCount : 0, scriptApprovalArtifact, scriptStatusApproved,
      qaReported, qaApproved, videoQaReported, hasFinalCut, panelCount, videoCount,
    }));
    seen.add(c.nextStageId);
    if (c.nextStageId) {
      assert.ok(EPISODE_STAGE_IDS.includes(c.nextStageId), `"${c.nextStageId}" is not an episode stage in PIPELINE_STAGES`);
      assert.equal(c.gate, PIPELINE_STAGES.find(s => s.id === c.nextStageId).gate);
    } else {
      assert.equal(c.stage, 'complete');
      assert.equal(c.nextCommand, undefined);
    }
  }
  seen.delete(undefined);
  assert.deepEqual([...seen].sort(), [...EPISODE_STAGE_IDS].sort());
});

test('every project stage classifyProject can return is in PIPELINE_STAGES, and every one is reachable', () => {
  const project = (overrides, episodes = []) => ({
    projectDir: '/films/x', name: 'X', slug: 'x', aestheticSet: true, characterCount: 1,
    lockedVoiceCount: 0, locationCount: 0, episodes, ...overrides,
  });
  const seen = new Set();
  for (const aestheticSet of [false, true]) for (const characterCount of [0, 2]) for (const episodes of [[], [facts()]]) {
    const c = classifyProject(project({ aestheticSet, characterCount }, episodes));
    seen.add(c.nextStageId);
  }
  const projectSeen = [...seen].filter(id => PROJECT_STAGE_IDS.includes(id));
  assert.deepEqual(projectSeen.sort(), [...PROJECT_STAGE_IDS].sort());
  assert.deepEqual([...seen].filter(id => !PROJECT_STAGE_IDS.includes(id)), ['approve-script']);

  const prereq = classifyProject(project({ aestheticSet: false }, [facts()]));
  assert.equal(prereq.nextStageId, 'aesthetic', 'project prerequisites outrank episode steps');
  assert.equal(prereq.nextCommand, 'explore-aesthetic   # then: set-aesthetic');
  assert.equal(prereq.nextEpisode, undefined);

  const done = PROGRESSION.at(-1)[2];
  const second = classifyProject(project({}, [done, facts({ episode: 2 })]));
  assert.equal(second.nextStageId, 'approve-script');
  assert.equal(second.nextEpisode, 2);
  assert.equal(second.nextCommand, 'approve-script -e 2');
  assert.equal(second.gate, PIPELINE_STAGES.find(s => s.id === 'approve-script').gate);
  assert.equal(second.loopCommand, 'loop -e 1 --mode <looping|production>');

  const allDone = classifyProject(project({}, [done]));
  assert.equal(allDone.nextStageId, undefined);
  assert.equal(allDone.nextCommand, undefined);
});

test('status commands are the pipeline commands in shell form', () => {
  for (const stage of PIPELINE_STAGES) {
    const command = stageCommand(stage.id, 7);
    assert.ok(!/-p <project>/.test(command), `${stage.id}: -p left in`);
    assert.ok(!/-e <n>/.test(command), `${stage.id}: -e not filled`);
    if (stage.id === 'aesthetic') {
      // The one documented exception: --style <n> is meaningless before explore prints the options.
      assert.equal(command.split(/\s/)[0], stage.command.split(/\s/)[0]);
      assert.ok(command.includes('# then: set-aesthetic'));
    } else {
      assert.equal(command, stage.command.split(' -p <project>').join('').split('-e <n>').join('-e 7'));
    }
  }
  assert.throws(() => stageCommand('not-a-stage', 1), /not in PIPELINE_STAGES/);
  const loop = PIPELINE_BRANCHES.find(b => b.id === 'loop');
  const c = classifyProject({
    projectDir: '/x', name: 'x', slug: 'x', aestheticSet: true, characterCount: 1, lockedVoiceCount: 0, locationCount: 0,
    episodes: [facts({ episode: 4 })],
  });
  assert.equal(c.loopCommand, loop.command.replace(' -p <project>', '').replace('-e <n>', '-e 4'));
});

test('a script is approved by either marker (rule 45)', () => {
  assert.equal(scriptApproved({ scriptApprovalArtifact: false, scriptStatusApproved: false }), false);
  assert.equal(scriptApproved({ scriptApprovalArtifact: true, scriptStatusApproved: false }), true);
  assert.equal(scriptApproved({ scriptApprovalArtifact: false, scriptStatusApproved: true }), true);
  assert.equal(classifyEpisode(facts({ scriptStatusApproved: true })).nextStageId, 'storyboard');
  assert.equal(classifyEpisode(facts({ scriptApprovalArtifact: true })).nextStageId, 'storyboard');
});

test('loop is available exactly when the script has shots', () => {
  assert.equal(classifyEpisode(facts({ hasScript: false, shotCount: 0 })).loopAvailable, false);
  assert.equal(classifyEpisode(facts({ shotCount: 0, scriptApprovalArtifact: true })).loopAvailable, false);
  assert.equal(classifyEpisode(facts()).loopAvailable, true);
});

test('the reports keep the CLI JSON shape: key order, title and nextCommand presence', () => {
  const ep = episodeStatusFromFacts(facts({ title: undefined }));
  assert.deepEqual(Object.keys(ep), [
    'episode', 'title', 'hasScript', 'shotCount', 'scriptApproved', 'qaReported', 'qaApproved', 'videoQaReported',
    'panelCount', 'videoCount', 'hasMusic', 'dialogueCount', 'hasFinalCut', 'stage', 'loopAvailable', 'nextCommand',
  ]);
  assert.equal('nextCommand' in episodeStatusFromFacts(PROGRESSION.at(-1)[2]), false);

  const project = projectStatusFromFacts({
    projectDir: '/films/x', name: 'X', slug: 'x', aestheticSet: true, characterCount: 1,
    lockedVoiceCount: 1, locationCount: 2, episodes: [PROGRESSION.at(-1)[2]],
  });
  assert.deepEqual(Object.keys(project), [
    'projectDir', 'name', 'slug', 'aestheticSet', 'characterCount', 'lockedVoiceCount', 'locationCount',
    'episodes', 'nextCommand', 'loopCommand',
  ]);
  assert.equal(project.nextCommand, undefined);
  assert.equal(project.episodes[0].scriptApproved, true);
});

test('core exposes the classifier on the barrel and the CLI re-exports it', () => {
  for (const name of ['classifyEpisode', 'classifyProject', 'projectStatusFromFacts', 'episodeStatusFromFacts',
    'scriptApproved', 'stageCommand', 'qualifyCommand', 'formatProjectStatus']) {
    assert.equal(typeof barrel[name], 'function', `barrel: ${name}`);
    assert.equal(cliStatus[name], barrel[name], `src/session/status re-export: ${name}`);
  }
  assert.equal(typeof cliStatus.collectProjectFacts, 'function');
});
