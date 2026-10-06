// `venice-video status` / `pipeline` are what an agent reads to decide the
// next command (rules 45, 48), so their output is a contract. This pins it:
// a matrix of synthetic projects, one per pipeline stage plus the edge cases
// the classifier has to get right, rendered through `collectProjectStatus`,
// `formatProjectStatus` and the CLI's `status` / `pipeline` commands, and
// compared byte for byte against tests/fixtures/status-golden.json.
//
// Each project also carries what a real run leaves beside the markers (cast
// references, videoDefaults, a qa-approved.json bound to its panels), so a
// case reads the gates (rules 54, 55, 63, 52) the way the commands do.
//
// The golden file was captured from the classifier before it moved into core.
// Regenerate it ONLY for an intended output change:
//   UPDATE_STATUS_GOLDEN=1 node --test tests/status-golden.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectProjectStatus, formatProjectStatus } from '../dist/session/status.js';
import { loadEpisodeScript, loadSeries } from '../dist/series/manager.js';
import { approvalForShot } from '../dist/mini-drama/panel-approval.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repoRoot, 'dist', 'mini-drama', 'cli.js');
const goldenPath = join(repoRoot, 'tests', 'fixtures', 'status-golden.json');
const update = process.env.UPDATE_STATUS_GOLDEN === '1';

const AESTHETIC = { style: 'documentary', palette: 'cold blue', lighting: 'hard', lensCharacteristics: 'large format', filmStock: 'fine grain', seed: 7 };
const MARA = { name: 'MARA', gender: 'female', age: '40s', description: 'pilot', fullDescription: 'A pilot.', wardrobe: 'suit', locked: true, voiceId: 'af_sky', seed: 1 };
const JUNO = { name: 'JUNO', gender: 'female', age: '20s', description: 'engineer', fullDescription: 'An engineer.', wardrobe: 'overalls', locked: false, seed: 2 };
const CAPSULE = { name: 'Capsule', slug: 'capsule', description: 'cockpit', lightingNotes: 'amber', seed: 3 };
const R2V = 'seedance-2-5-reference-to-video';
const VIDEO_DEFAULTS = {
  actionModel: R2V, atmosphereModel: R2V, characterConsistencyModel: R2V,
  imageDefaults: { generationModel: 'nano-banana-2', editModel: 'nano-banana-2-edit' },
};
/** The reference images a real run has on disk before storyboarding (rule 54). */
const REFS = { 'characters/mara/front.png': '', 'characters/juno/front.png': '', 'locations/capsule/north.png': '' };
/** Stands in for qa-approved.json until the project is on disk: replaced by a real per-shot binding (rule 63). */
const BIND = Symbol('bind approval');

function shot(shotNumber, characters = ['MARA']) {
  return {
    shotNumber, type: 'medium', environment: 'DAY_INTERIOR', location: 'capsule', duration: '15s',
    videoModel: 'character', description: `Shot ${shotNumber}.`, characters, dialogue: null, sfx: null,
    cameraMovement: 'static', transition: 'CUT',
  };
}

function script(episode, status, shotCount = 3) {
  return {
    episode, title: `Episode ${episode}`, seriesName: 'Rocketship', totalDuration: `${shotCount * 15}s`,
    status, locations: [], shots: Array.from({ length: shotCount }, (_, i) => shot(i + 1)),
  };
}

const padded = n => String(n).padStart(3, '0');
const shotFiles = (count, ext) => Array.from({ length: count }, (_, i) => `scene-001/shot-${padded(i + 1)}.${ext}`);

const QA_CRITICAL = { summary: { total: 3, pass: 1, flagLow: 0, flagCritical: 2, errored: 0 }, results: [] };
const QA_CLEAN = { summary: { total: 3, pass: 3, flagLow: 0, flagCritical: 0, errored: 0 }, results: [] };
const VQA_FAIL = { summary: { passed: false, criticals: 2, warnings: 0 } };
const VQA_PASS = { summary: { passed: true, criticals: 0, warnings: 1 } };

/**
 * One episode's on-disk state, cumulative: each stage implies the files of the
 * stages before it, the way a real run leaves them.
 */
const STAGES = ['none', 'script', 'approved', 'panels', 'qa-report', 'qa-approved', 'clips', 'video-qa', 'final'];
function episodeFiles(n, upTo, { status = 'draft', approvedBy = 'file', panels = 3, clips = 3, qa = QA_CLEAN, videoQa = VQA_PASS, shots = 3, approval = BIND } = {}) {
  const at = s => STAGES.indexOf(upTo) >= STAGES.indexOf(s);
  const files = {};
  if (at('script')) files['script.json'] = script(n, approvedBy === 'status' && at('approved') ? 'approved' : status, shots);
  if (at('approved') && approvedBy === 'file') files['script-approved.json'] = { episode: n, approvedAt: '2026-10-01T00:00:00.000Z' };
  if (at('panels')) for (const f of shotFiles(panels, 'png')) files[f] = '';
  if (at('qa-report')) files['qa-report.json'] = qa;
  if (at('qa-approved')) files['qa-approved.json'] = approval;
  if (at('clips')) for (const f of shotFiles(clips, 'mp4')) files[f] = '';
  if (at('video-qa') && videoQa) files['video-qa-report.json'] = videoQa;
  if (at('final')) files[`episode-${padded(n)}-final.mp4`] = '';
  return files;
}

/** The matrix: every stage, both approval markers, and the gate edge cases. */
const CASES = [
  { id: 'empty-project', series: { aesthetic: null, characters: [], episodes: [] } },
  { id: 'aesthetic-only', series: { characters: [], episodes: [] } },
  { id: 'cast-no-episodes', series: { episodes: [] } },
  { id: 'no-aesthetic-with-episodes', series: { aesthetic: null }, episodes: { 1: episodeFiles(1, 'script') } },
  { id: 'no-script', episodes: { 1: {} } },
  { id: 'workshop-draft', episodes: { 1: {} }, root: { 'workshop.json': { version: 1, status: 'draft', revision: 1 } } },
  { id: 'script-drafted', episodes: { 1: episodeFiles(1, 'script') } },
  { id: 'approved-via-file', episodes: { 1: episodeFiles(1, 'approved') } },
  { id: 'approved-via-status', episodes: { 1: episodeFiles(1, 'approved', { approvedBy: 'status' }) } },
  { id: 'approved-via-both', episodes: { 1: { ...episodeFiles(1, 'approved'), 'script.json': script(1, 'approved') } } },
  { id: 'refs-missing', episodes: { 1: episodeFiles(1, 'approved') }, refs: false, note: 'no characters/<slug>/front.png: storyboard-episode blocks (rule 54)' },
  { id: 'refs-present', episodes: { 1: episodeFiles(1, 'approved') }, root: { 'characters/mara/front.png': '', 'characters/juno/front.png': '', 'locations/capsule/north.png': '' } },
  { id: 'panels-partial', episodes: { 1: episodeFiles(1, 'panels', { panels: 1 }) } },
  { id: 'panels-complete', episodes: { 1: episodeFiles(1, 'panels') } },
  { id: 'panels-with-archives', episodes: { 1: { ...episodeFiles(1, 'panels', { panels: 2 }), 'scene-001/shot-001-v1.png': '', 'scene-001/shot-003.prompt.json': '' } } },
  { id: 'qa-critical', episodes: { 1: episodeFiles(1, 'qa-report', { qa: QA_CRITICAL }) } },
  { id: 'qa-reported-clean', episodes: { 1: episodeFiles(1, 'qa-report') } },
  { id: 'qa-approved', episodes: { 1: episodeFiles(1, 'qa-approved') } },
  { id: 'qa-approved-unbound', episodes: { 1: { ...episodeFiles(1, 'qa-approved'), 'qa-approved.json': '{not json' } }, note: 'generate-videos refuses an unparseable / stale approval (rule 63)' },
  {
    id: 'qa-approved-legacy', note: 'an approval written before per-shot binding: generate-videos refuses every shot (rule 63)',
    episodes: { 1: episodeFiles(1, 'qa-approved', { approval: { episode: 1, approvedAt: '2026-10-01T00:00:00.000Z', notes: '' } }) },
  },
  {
    id: 'qa-approved-stale', note: 'a panel regenerated after qa-approve: generate-videos refuses that shot (rule 63)',
    episodes: { 1: episodeFiles(1, 'qa-approved') }, after: { 1: { 'scene-001/shot-002.png': 'retouched' } },
  },
  { id: 'clips-partial', episodes: { 1: episodeFiles(1, 'clips', { clips: 2 }) } },
  { id: 'clips-complete-unverified', episodes: { 1: episodeFiles(1, 'clips') } },
  { id: 'video-qa-fail', episodes: { 1: episodeFiles(1, 'video-qa', { videoQa: VQA_FAIL }) } },
  { id: 'video-qa-pass', episodes: { 1: episodeFiles(1, 'video-qa') } },
  { id: 'assembled', episodes: { 1: { ...episodeFiles(1, 'final'), 'audio/music.mp3': '', 'audio/dialogue-shot-001.mp3': '', 'audio/dialogue-shot-002.mp3': '' } } },
  { id: 'assembled-without-video-qa', episodes: { 1: episodeFiles(1, 'final', { videoQa: null }) } },
  { id: 'zero-shot-script', episodes: { 1: episodeFiles(1, 'approved', { shots: 0 }) } },
  { id: 'more-panels-than-shots', episodes: { 1: { ...episodeFiles(1, 'panels', { panels: 4, shots: 2 }) } } },
  {
    id: 'multi-episode',
    series: { episodes: [{ number: 1, title: 'Launch' }, { number: 2, title: 'Drift' }, { number: 3 }] },
    episodes: { 1: episodeFiles(1, 'final'), 2: episodeFiles(2, 'script'), 3: {} },
  },
  {
    id: 'multi-episode-loop-on-later',
    series: { episodes: [{ number: 1, title: 'Launch' }, { number: 2, title: 'Drift' }] },
    episodes: { 1: {}, 2: episodeFiles(2, 'panels', { panels: 1 }) },
  },
  {
    id: 'all-complete',
    series: { episodes: [{ number: 1, title: 'Launch' }, { number: 2, title: 'Drift' }] },
    episodes: { 1: episodeFiles(1, 'final'), 2: episodeFiles(2, 'final') },
  },
];

async function writeJsonOrText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Every case gets what a real run leaves on disk alongside its markers:
 * `videoDefaults`, the cast's reference images (unless `refs: false`), and a
 * qa-approved.json bound to the panels it approved (unless the case supplies
 * its own). `after` files are written once the approvals are bound.
 */
async function buildProject(workspace, c) {
  const dir = join(workspace, c.id);
  const series = {
    name: 'Rocketship', slug: 'rocketship', concept: 'A signal', genre: 'sci-fi', setting: 'orbit',
    outputDir: dir, aesthetic: AESTHETIC, characters: [MARA, JUNO], locations: [CAPSULE],
    episodes: [{ number: 1, title: 'Pilot' }], videoDefaults: VIDEO_DEFAULTS,
    ...c.series,
  };
  await writeJsonOrText(join(dir, 'series.json'), series);
  const root = { ...(c.refs === false ? {} : REFS), ...c.root };
  for (const [path, value] of Object.entries(root)) await writeJsonOrText(join(dir, path), value);
  const toBind = [];
  for (const [n, files] of Object.entries(c.episodes ?? {})) {
    const episodeDir = join(dir, 'episodes', `episode-${padded(Number(n))}`);
    await mkdir(episodeDir, { recursive: true });
    for (const [path, value] of Object.entries(files)) {
      if (value === BIND) toBind.push(Number(n));
      else await writeJsonOrText(join(episodeDir, path), value);
    }
  }
  if (toBind.length > 0) {
    const loaded = await loadSeries(dir);
    for (const n of toBind) {
      const episodeDir = join(dir, 'episodes', `episode-${padded(n)}`);
      const shots = {};
      for (const s of (await loadEpisodeScript(loaded, n)).shots) {
        const binding = approvalForShot(loaded, s, join(episodeDir, 'scene-001'));
        if (binding) shots[padded(s.shotNumber)] = binding;
      }
      await writeJsonOrText(join(episodeDir, 'qa-approved.json'), { episode: n, approvedAt: '2026-10-01T00:00:00.000Z', notes: '', shots });
    }
  }
  for (const [n, files] of Object.entries(c.after ?? {})) {
    const episodeDir = join(dir, 'episodes', `episode-${padded(Number(n))}`);
    for (const [path, value] of Object.entries(files)) await writeJsonOrText(join(episodeDir, path), value);
  }
  return dir;
}

function runCli(args, configDir) {
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

async function render() {
  const workspace = await mkdtemp(join(tmpdir(), 'venice-status-golden-'));
  const configDir = await mkdtemp(join(tmpdir(), 'venice-status-golden-config-'));
  const roots = [workspace, await realpath(workspace)];
  const normalize = text => roots.reduce((t, root) => t.split(root).join('<WORKSPACE>'), text);

  const out = { cases: {}, pipeline: {} };
  await Promise.all(CASES.map(async c => {
    const dir = await buildProject(workspace, c);
    const status = await collectProjectStatus(dir);
    const [json, text] = await Promise.all([
      runCli(['status', '-p', dir, '--json'], configDir),
      runCli(['status', '-p', dir], configDir),
    ]);
    out.cases[c.id] = normalize(JSON.stringify({
      collect: status,
      // `in` checks: an explicit `undefined` key is invisible to JSON but not to deepStrictEqual.
      keys: { project: Object.keys(status), episodes: status.episodes.map(e => Object.keys(e)) },
      format: formatProjectStatus(status),
      formatSelected: formatProjectStatus(status, 1),
      cliJson: { code: json.code, stdout: json.stdout, stderr: json.stderr },
      cliText: { code: text.code, stdout: text.stdout, stderr: text.stderr },
    }, null, 2));
  }));
  const [pipelineJson, pipelineText] = await Promise.all([
    runCli(['pipeline', '--json'], configDir),
    runCli(['pipeline'], configDir),
  ]);
  out.pipeline = { json: pipelineJson, text: pipelineText };
  return out;
}

test('status and pipeline output is byte-identical to the golden capture', { timeout: 120_000 }, async () => {
  const actual = await render();
  if (update) {
    const ordered = { cases: Object.fromEntries(CASES.map(c => [c.id, actual.cases[c.id]])), pipeline: actual.pipeline };
    await writeFile(goldenPath, `${JSON.stringify(ordered, null, 2)}\n`);
    return;
  }
  const golden = JSON.parse(await readFile(goldenPath, 'utf-8'));
  assert.deepEqual(Object.keys(actual.cases).sort(), Object.keys(golden.cases).sort());
  for (const c of CASES) assert.equal(actual.cases[c.id], golden.cases[c.id], `status output changed for case "${c.id}"`);
  assert.deepEqual(actual.pipeline, golden.pipeline);
});

test('the golden matrix reaches every status stage the reporter can print', async () => {
  const golden = JSON.parse(await readFile(goldenPath, 'utf-8'));
  const stages = new Set();
  for (const raw of Object.values(golden.cases)) {
    for (const ep of JSON.parse(raw).collect.episodes) stages.add(ep.stage.replace(/ \(\d+\/\d+ \w+\)$/, ' (n/m)'));
  }
  for (const expected of [
    'no script', 'script drafted', 'ready to storyboard', 'storyboarding (n/m)', 'panels complete',
    'at QA gate', 'ready to render', 'rendering (n/m)', 'clips complete, unverified', 'clips verified', 'complete',
  ]) assert.ok(stages.has(expected), `no case reaches stage "${expected}"`);
});
