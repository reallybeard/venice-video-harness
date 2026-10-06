// A forced approval is recorded on the binding and counts at the render gate
// the same way a QA-cleared one does.
//
// Core: `ApprovalBinding.force` / `reason`, `approvalCounts(binding,
// qaCleared)`, and the render gate's optional per-shot fact `approvedShots`
// (a host that approves panel by panel supplies it). CLI: `qa-approve
// --force [--reason]` writes the flag only when --force waived QA issues.
// The CLI's own gate output is pinned by tests/gate-commands-golden.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { approvalCounts, compareApproval } from '../packages/core/dist/mini-drama/panel-approval.js';
import { gateFor } from '../packages/core/dist/session/gates.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repoRoot, 'dist', 'mini-drama', 'cli.js');

const BINDING = { panelSha256: 'a'.repeat(64), settingsDigest: 'b'.repeat(64) };

test('approvalCounts: QA cleared, or forced; never without a binding', () => {
  assert.equal(approvalCounts(BINDING, true), true);
  assert.equal(approvalCounts(BINDING, false), false);
  assert.equal(approvalCounts({ ...BINDING, force: true, reason: 'reviewed by hand' }, false), true);
  assert.equal(approvalCounts({ ...BINDING, force: false }, false), false);
  assert.equal(approvalCounts(undefined, true), false);
});

test('force and reason do not change freshness: compareApproval reads the hashes only', () => {
  const current = { panelSha256: BINDING.panelSha256, settingsDigest: BINDING.settingsDigest };
  assert.deepEqual(compareApproval({ ...BINDING, force: true, reason: 'r' }, current), []);
});

test('render gate: a forced approval passes the way a QA-cleared one does; an unforced one past QA blocks', () => {
  const facts = { episode: 4, qaApproved: true, approval: { approvedAt: 't', stale: [] } };
  assert.deepEqual(gateFor('render', facts), { blocked: false });

  const cleared = { shotKey: '001', qaCleared: true, binding: BINDING };
  const forced = { shotKey: '002', qaCleared: false, binding: { ...BINDING, force: true, reason: 'accepted' } };
  const unforced = { shotKey: '003', qaCleared: false, binding: BINDING };
  assert.deepEqual(gateFor('render', { ...facts, approvedShots: [cleared, forced] }), { blocked: false });

  const blocked = gateFor('render', { ...facts, approvedShots: [cleared, forced, unforced] });
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.reason, { kind: 'approval-not-cleared', shots: ['003'] });
  assert.equal(blocked.summary, '1 shot(s) approved without a QA pass or force');
  assert.equal(blocked.remedy.stageId, 'qa-approve');
  assert.match(blocked.remedy.command, /qa-approve/);
  assert.equal(gateFor('render', { ...facts, approvedShots: [unforced] }, { bypass: ['approval-not-cleared'] }).blocked, false);

  // A stale approval is reported first; no approval at all is still qa-not-approved.
  const stale = [{ shotKey: '001', shotNumber: 1, mismatches: [{ kind: 'panel-changed' }] }];
  assert.equal(gateFor('render', { ...facts, approval: { stale }, approvedShots: [unforced] }).reason.kind, 'approval-stale');
  assert.equal(gateFor('render', { episode: 4, approvedShots: [unforced] }).reason.kind, 'qa-not-approved');
});

// ---- The CLI -----------------------------------------------------------------

const VIDEO_DEFAULTS = {
  actionModel: 'seedance-2-5-reference-to-video', atmosphereModel: 'seedance-2-5-reference-to-video',
  imageDefaults: { generationModel: 'nano-banana-2', editModel: 'nano-banana-2-edit' },
};
const shot = n => ({
  shotNumber: n, type: 'medium', environment: 'DAY_INTERIOR', duration: '5s', videoModel: 'action',
  description: `Shot ${n}.`, characters: [], dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT',
});
const QA_CRITICAL = { summary: { total: 2, pass: 1, flagCritical: 1, flagModerate: 0, flagLow: 0, errored: 0 }, results: [] };
const QA_CLEAN = { summary: { total: 2, pass: 2, flagCritical: 0, flagModerate: 0, flagLow: 0, errored: 0 }, results: [] };

async function project(qaReport) {
  const dir = await mkdtemp(join(tmpdir(), 'approval-force-'));
  const episodeDir = join(dir, 'episodes', 'episode-001');
  await mkdir(join(episodeDir, 'scene-001'), { recursive: true });
  await writeFile(join(dir, 'series.json'), JSON.stringify({
    name: 'S', slug: 's', concept: 'c', genre: 'drama', setting: 's', outputDir: dir,
    aesthetic: { style: 'x', palette: 'x', lighting: 'x', lensCharacteristics: 'x', filmStock: 'x' },
    characters: [], locations: [], episodes: [{ number: 1, title: 'Pilot' }], videoDefaults: VIDEO_DEFAULTS,
  }));
  await writeFile(join(episodeDir, 'script.json'), JSON.stringify({
    episode: 1, title: 'Pilot', seriesName: 'S', totalDuration: '10s', status: 'approved', locations: [], shots: [shot(1), shot(2)],
  }));
  await writeFile(join(episodeDir, 'scene-001', 'shot-001.png'), 'panel 1');
  await writeFile(join(episodeDir, 'scene-001', 'shot-002.png'), 'panel 2');
  await writeFile(join(episodeDir, 'qa-report.json'), JSON.stringify(qaReport));
  return { dir, approvedPath: join(episodeDir, 'qa-approved.json') };
}

async function run(args) {
  const configDir = await mkdtemp(join(tmpdir(), 'approval-force-config-'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, VENICE_VIDEO_CONFIG_DIR: configDir, VENICE_API_KEY: '', NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8').on('data', d => { stdout += d; });
    child.stderr.setEncoding('utf-8').on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('qa-approve --force --reason over a critical report records force and the reason on every binding', async () => {
  const { dir, approvedPath } = await project(QA_CRITICAL);
  const { code } = await run(['qa-approve', '-p', dir, '-e', '1', '--force', '--reason', 'reviewed shot 2 by hand']);
  assert.equal(code, 0);
  const artifact = JSON.parse(await readFile(approvedPath, 'utf-8'));
  assert.deepEqual(Object.keys(artifact.shots), ['001', '002']);
  for (const binding of Object.values(artifact.shots)) {
    assert.equal(binding.force, true);
    assert.equal(binding.reason, 'reviewed shot 2 by hand');
    assert.match(binding.panelSha256, /^[0-9a-f]{64}$/);
  }
});

test('qa-approve over a clean report writes no force, with or without --force', async () => {
  for (const extra of [[], ['--force']]) {
    const { dir, approvedPath } = await project(QA_CLEAN);
    const { code } = await run(['qa-approve', '-p', dir, '-e', '1', ...extra]);
    assert.equal(code, 0);
    const artifact = JSON.parse(await readFile(approvedPath, 'utf-8'));
    for (const binding of Object.values(artifact.shots)) {
      assert.deepEqual(Object.keys(binding).sort(), ['panelSha256', 'settingsDigest']);
    }
  }
});

test('qa-approve --reason without --force is refused before anything is written', async () => {
  const { dir } = await project(QA_CRITICAL);
  const { code, stderr } = await run(['qa-approve', '-p', dir, '-e', '1', '--reason', 'because']);
  assert.equal(code, 1);
  assert.match(stderr, /needs --force/);
});
