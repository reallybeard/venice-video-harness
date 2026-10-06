// The approval / precondition gates are what stand between an agent and a
// wasted (or billed) pass: storyboard-episode (script approval + rule-54
// reference preflight), qa-approve (rule 55), generate-videos (rule 63
// approval binding) and assemble-episode (rule 52 video-QA block). This pins
// what each command prints and its exit code when it blocks, and just past
// the gate when it does not, over synthetic projects, byte for byte against
// tests/fixtures/gate-commands-golden.json.
//
// No case reaches Venice: every spawn runs with an empty VENICE_API_KEY and a
// temp VENICE_VIDEO_CONFIG_DIR, so a gate that passes stops at the API-key
// read (storyboard-episode, generate-videos) or at ffprobe on an empty clip
// (assemble-episode).
//
// Captured before the gates moved into core. Regenerate ONLY for an intended
// output change:
//   UPDATE_GATE_GOLDEN=1 node --test tests/gate-commands-golden.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSeries, loadEpisodeScript } from '../dist/series/manager.js';
import { approvalForShot } from '../dist/mini-drama/panel-approval.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repoRoot, 'dist', 'mini-drama', 'cli.js');
const goldenPath = join(repoRoot, 'tests', 'fixtures', 'gate-commands-golden.json');
const update = process.env.UPDATE_GATE_GOLDEN === '1';

const AESTHETIC = { style: 'documentary', palette: 'cold blue', lighting: 'hard', lensCharacteristics: 'large format', filmStock: 'fine grain', seed: 7 };
const MARA = { name: 'MARA', gender: 'female', age: '40s', description: 'pilot', fullDescription: 'A pilot.', wardrobe: 'suit', locked: true, voiceId: 'af_sky', seed: 1 };
const JUNO = { name: 'JUNO', gender: 'female', age: '20s', description: 'engineer', fullDescription: 'An engineer.', wardrobe: 'overalls', locked: false, seed: 2 };
const CAPSULE = { name: 'Capsule', slug: 'capsule', description: 'cockpit', lightingNotes: 'amber', seed: 3 };
const R2V = 'seedance-2-5-reference-to-video';
const VIDEO_DEFAULTS = {
  actionModel: R2V, atmosphereModel: R2V, characterConsistencyModel: R2V,
  imageDefaults: { generationModel: 'nano-banana-2', editModel: 'nano-banana-2-edit' },
};

const padded = n => String(n).padStart(3, '0');

function shot(shotNumber, characters = ['MARA'], location = 'capsule') {
  return {
    shotNumber, type: 'medium', environment: 'DAY_INTERIOR', location, duration: '15s',
    videoModel: 'character', description: `Shot ${shotNumber}.`, characters, dialogue: null, sfx: null,
    cameraMovement: 'static', transition: 'CUT',
  };
}

function script(shots, status = 'draft') {
  return { episode: 1, title: 'Pilot', seriesName: 'Rocketship', totalDuration: `${shots.length * 15}s`, status, locations: [], shots };
}

const THREE = [shot(1), shot(2), shot(3)];
const REFS = { 'characters/mara/front.png': 'mara', 'characters/juno/three-quarter.png': 'juno', 'locations/capsule/north.png': 'capsule' };
const APPROVED = { 'script-approved.json': { episode: 1, approvedAt: '2026-10-01T00:00:00.000Z' } };
const panels = (count = 3) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`scene-001/shot-${padded(i + 1)}.png`, `panel ${i + 1}`]));
const clips = (count = 3) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`scene-001/shot-${padded(i + 1)}.mp4`, '']));
const QA_CLEAN = { summary: { total: 3, pass: 3, flagCritical: 0, flagModerate: 0, flagLow: 0, errored: 0 }, results: [] };
const QA_CRITICAL = { summary: { total: 3, pass: 1, flagCritical: 2, flagModerate: 0, flagLow: 0, errored: 0 }, results: [] };
const QA_UNCHECKED = { summary: { total: 3, pass: 2, flagCritical: 0, flagModerate: 0, flagLow: 0, errored: 1 }, results: [] };
const LEGACY_APPROVAL = { episode: 1, approvedAt: '2026-10-01T00:00:00.000Z', notes: 'ok' };
const VQA_FAIL = { summary: { passed: false, criticals: 2, warnings: 0 } };
const VQA_PASS = { summary: { passed: true, criticals: 0, warnings: 1 } };

/** Ready to render: approved script, refs, panels, a clean QA report, and (with `bind`) a bound approval. */
const RENDERABLE = { ...APPROVED, ...panels(), 'qa-report.json': QA_CLEAN, 'script.json': script(THREE, 'approved') };
const ASSEMBLABLE = { ...RENDERABLE, ...clips(), 'qa-approved.json': LEGACY_APPROVAL };

/**
 * Each case: `root` files (project-relative), `episode` files (episode-dir
 * relative), `bind` (shot numbers to record a real per-shot approval for,
 * after the files are written), `after` (episode files written once the
 * approval is bound; `null` deletes), and the CLI args after `-p <dir>`.
 */
const CASES = [
  // storyboard-episode: script approval, then the --shots filter, then the reference preflight.
  { id: 'storyboard/unapproved', root: REFS, episode: { 'script.json': script(THREE) }, args: ['storyboard-episode', '-e', '1'] },
  { id: 'storyboard/skip-approval-refs-missing', episode: { 'script.json': script(THREE) }, args: ['storyboard-episode', '-e', '1', '--skip-approval'] },
  { id: 'storyboard/refs-missing-character', root: { 'locations/capsule/north.png': 'capsule' }, episode: { ...APPROVED, 'script.json': script(THREE) }, args: ['storyboard-episode', '-e', '1'] },
  {
    id: 'storyboard/refs-missing-mixed',
    root: { 'characters/mara/front.png': 'mara' },
    episode: { ...APPROVED, 'script.json': script([shot(1), shot(2, ['JUNO', 'Ghost', 'mara']), shot(3, ['MARA'], 'nowhere'), shot(4, [], 'capsule')]) },
    args: ['storyboard-episode', '-e', '1'],
  },
  { id: 'storyboard/approved-via-status-refs-missing', episode: { 'script.json': script(THREE, 'approved') }, args: ['storyboard-episode', '-e', '1'] },
  { id: 'storyboard/shots-match-none', episode: { ...APPROVED, 'script.json': script(THREE) }, args: ['storyboard-episode', '-e', '1', '--shots', '9'] },
  {
    id: 'storyboard/shots-filter-skips-unrelated-missing-refs',
    root: { 'characters/mara/front.png': 'mara', 'locations/capsule/north.png': 'capsule' },
    episode: { ...APPROVED, 'script.json': script([shot(1), shot(2, ['JUNO'])]) },
    args: ['storyboard-episode', '-e', '1', '--shots', '1,7'],
  },
  { id: 'storyboard/pass', root: REFS, episode: { ...APPROVED, 'script.json': script(THREE) }, args: ['storyboard-episode', '-e', '1'] },

  // qa-approve: report present, parseable, and free of criticals / unchecked shots.
  { id: 'qa-approve/no-report', root: REFS, episode: { ...APPROVED, ...panels(), 'script.json': script(THREE) }, args: ['qa-approve', '-e', '1'] },
  { id: 'qa-approve/criticals', root: REFS, episode: { ...APPROVED, ...panels(), 'script.json': script(THREE), 'qa-report.json': QA_CRITICAL }, args: ['qa-approve', '-e', '1'] },
  { id: 'qa-approve/unchecked', root: REFS, episode: { ...APPROVED, ...panels(), 'script.json': script(THREE), 'qa-report.json': QA_UNCHECKED }, args: ['qa-approve', '-e', '1'] },
  { id: 'qa-approve/unparseable', root: REFS, episode: { ...APPROVED, ...panels(), 'script.json': script(THREE), 'qa-report.json': '{not json' }, args: ['qa-approve', '-e', '1'] },
  { id: 'qa-approve/criticals-force', root: REFS, episode: { ...APPROVED, ...panels(2), 'script.json': script(THREE), 'qa-report.json': QA_CRITICAL }, args: ['qa-approve', '-e', '1', '--force'] },
  { id: 'qa-approve/no-summary', root: REFS, episode: { ...APPROVED, ...panels(), 'script.json': script(THREE), 'qa-report.json': {} }, args: ['qa-approve', '-e', '1'] },
  { id: 'qa-approve/clean', root: REFS, episode: { ...APPROVED, ...panels(), 'script.json': script(THREE), 'qa-report.json': QA_CLEAN }, args: ['qa-approve', '-e', '1'] },

  // generate-videos: approval present, parseable, and still bound to the panels on disk. Blocks before the API key.
  { id: 'generate-videos/no-approval', root: REFS, episode: RENDERABLE, args: ['generate-videos', '-e', '1'] },
  { id: 'generate-videos/unparseable', root: REFS, episode: { ...RENDERABLE, 'qa-approved.json': '{not json' }, args: ['generate-videos', '-e', '1'] },
  { id: 'generate-videos/legacy-unbound', root: REFS, episode: { ...RENDERABLE, 'qa-approved.json': LEGACY_APPROVAL }, args: ['generate-videos', '-e', '1'] },
  { id: 'generate-videos/panel-changed', root: REFS, episode: RENDERABLE, bind: [1, 2, 3], after: { 'scene-001/shot-002.png': 'retouched' }, args: ['generate-videos', '-e', '1'] },
  { id: 'generate-videos/panel-missing', root: REFS, episode: RENDERABLE, bind: [1, 2, 3], after: { 'scene-001/shot-003.png': null }, args: ['generate-videos', '-e', '1'] },
  {
    id: 'generate-videos/settings-changed', root: REFS, episode: RENDERABLE, bind: [1, 2, 3],
    after: { 'script.json': script([{ ...shot(1), description: 'Shot 1, rewritten.' }, shot(2), shot(3)], 'approved') },
    args: ['generate-videos', '-e', '1'],
  },
  {
    id: 'generate-videos/shot-added', root: REFS, episode: RENDERABLE, bind: [1, 2],
    after: { 'script.json': script([shot(1), shot(2), shot(3), shot(4)], 'approved') },
    args: ['generate-videos', '-e', '1'],
  },
  { id: 'generate-videos/pass', root: REFS, episode: RENDERABLE, bind: [1, 2, 3], args: ['generate-videos', '-e', '1'] },
  { id: 'generate-videos/skip-qa', root: REFS, episode: RENDERABLE, args: ['generate-videos', '-e', '1', '--skip-qa'] },

  // assemble-episode: a failing video-QA report blocks; a missing or unreadable one only warns.
  { id: 'assemble/no-clips', root: REFS, episode: { ...RENDERABLE, 'qa-approved.json': LEGACY_APPROVAL, 'video-qa-report.json': VQA_FAIL }, args: ['assemble-episode', '-e', '1'] },
  { id: 'assemble/video-qa-fail', root: REFS, episode: { ...ASSEMBLABLE, 'video-qa-report.json': VQA_FAIL }, args: ['assemble-episode', '-e', '1'] },
  { id: 'assemble/video-qa-fail-no-count', root: REFS, episode: { ...ASSEMBLABLE, 'video-qa-report.json': { summary: { passed: false } } }, args: ['assemble-episode', '-e', '1'] },
  { id: 'assemble/video-qa-fail-skip', root: REFS, episode: { ...ASSEMBLABLE, 'video-qa-report.json': VQA_FAIL }, args: ['assemble-episode', '-e', '1', '--skip-video-qa'] },
  { id: 'assemble/video-qa-missing', root: REFS, episode: ASSEMBLABLE, args: ['assemble-episode', '-e', '1'] },
  { id: 'assemble/video-qa-unparseable', root: REFS, episode: { ...ASSEMBLABLE, 'video-qa-report.json': '{not json' }, args: ['assemble-episode', '-e', '1'] },
  { id: 'assemble/video-qa-no-summary', root: REFS, episode: { ...ASSEMBLABLE, 'video-qa-report.json': {} }, args: ['assemble-episode', '-e', '1'] },
  { id: 'assemble/video-qa-pass', root: REFS, episode: { ...ASSEMBLABLE, 'video-qa-report.json': VQA_PASS }, args: ['assemble-episode', '-e', '1'] },
];

async function writeJsonOrText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFiles(base, files) {
  for (const [path, value] of Object.entries(files ?? {})) {
    if (value === null) await rm(join(base, path), { force: true });
    else await writeJsonOrText(join(base, path), value);
  }
}

async function buildProject(workspace, c) {
  const dir = join(workspace, c.id.replace('/', '--'));
  await writeJsonOrText(join(dir, 'series.json'), {
    name: 'Rocketship', slug: 'rocketship', concept: 'A signal', genre: 'sci-fi', setting: 'orbit',
    outputDir: dir, aesthetic: AESTHETIC, characters: [MARA, JUNO], locations: [CAPSULE],
    episodes: [{ number: 1, title: 'Pilot' }], videoDefaults: VIDEO_DEFAULTS,
  });
  await writeFiles(dir, c.root);
  const episodeDir = join(dir, 'episodes', 'episode-001');
  await mkdir(episodeDir, { recursive: true });
  await writeFiles(episodeDir, c.episode);
  if (c.bind) {
    // A real qa-approve binding (panel sha256 + settings digest), as the CLI records it.
    const series = await loadSeries(dir);
    const { shots } = await loadEpisodeScript(series, 1);
    const bound = {};
    for (const s of shots.filter(s => c.bind.includes(s.shotNumber))) bound[padded(s.shotNumber)] = approvalForShot(series, s, join(episodeDir, 'scene-001'));
    await writeJsonOrText(join(episodeDir, 'qa-approved.json'), { ...LEGACY_APPROVAL, shots: bound });
  }
  await writeFiles(episodeDir, c.after);
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

/**
 * Paths become <WORKSPACE>; the two strings that depend on the toolchain, not
 * the harness, are masked: a JSON.parse message (Node version) and ffprobe's
 * complaint about an empty clip (ffmpeg version, a pointer address).
 */
function normalizer(roots) {
  return text => {
    let out = roots.reduce((t, root) => t.split(root).join('<WORKSPACE>'), text);
    out = out.replace(/(could not be parsed \().*(\)\. Re-run)/g, '$1<parse error>$2');
    const ffprobe = out.indexOf('error: ffprobe failed:');
    if (ffprobe >= 0) out = `${out.slice(0, ffprobe)}error: ffprobe failed: <ffprobe output>\n`;
    return out;
  };
}

async function render() {
  const workspace = await mkdtemp(join(tmpdir(), 'venice-gate-golden-'));
  const configDir = await mkdtemp(join(tmpdir(), 'venice-gate-golden-config-'));
  const normalize = normalizer([workspace, await realpath(workspace)]);
  const out = {};
  await Promise.all(CASES.map(async c => {
    const dir = await buildProject(workspace, c);
    const [command, ...rest] = c.args;
    const result = await runCli([command, '-p', dir, ...rest], configDir);
    out[c.id] = { code: result.code, stdout: normalize(result.stdout), stderr: normalize(result.stderr) };
  }));
  return out;
}

test('gate output of storyboard-episode, qa-approve, generate-videos and assemble-episode is byte-identical to the golden capture', { timeout: 120_000 }, async () => {
  const actual = await render();
  if (update) {
    await writeFile(goldenPath, `${JSON.stringify(Object.fromEntries(CASES.map(c => [c.id, actual[c.id]])), null, 2)}\n`);
    return;
  }
  const golden = JSON.parse(await readFile(goldenPath, 'utf-8'));
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(golden).sort());
  for (const c of CASES) assert.deepEqual(actual[c.id], golden[c.id], `gate output changed for case "${c.id}"`);
});

test('no gate case reaches Venice: every passing case stops at the API key or at ffprobe', async () => {
  const golden = JSON.parse(await readFile(goldenPath, 'utf-8'));
  for (const [id, result] of Object.entries(golden)) {
    // qa-approve makes no Venice call at all; it passes by writing the artifact.
    const approved = id.startsWith('qa-approve/') && result.code === 0 && /QA approved for Episode 1/.test(result.stdout);
    if (approved) continue;
    assert.notEqual(result.code, 0, `${id} exited 0`);
    const blocked = /Blocked:|No video clips found/.test(result.stderr);
    const stopped = /Venice API key is required|error: ffprobe failed/.test(result.stderr);
    assert.ok(blocked || stopped, `${id}: neither blocked nor stopped before a paid call`);
  }
});
