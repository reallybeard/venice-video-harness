// `qa-storyboard` and `qa-videos` end to end, pinned byte for byte.
//
// Each case builds a scratch project (fixture panels and reference sheets,
// tiny ffmpeg-generated unit clips), runs the real CLI command with
// tests/fixtures/qa-loops/stub-venice.mjs preloaded (scripted vision replies,
// `fetch` blocked, so nothing reaches Venice), and records:
//   - exit status, stdout, stderr
//   - the report the command wrote (qa-report.json / video-qa-report.json)
//   - every /chat/completions body sent, images replaced by labels
// and compares the lot against tests/fixtures/qa-loops-golden.json.
//
// The golden was captured from the QA loops before they moved into core.
// Regenerate it ONLY for an intended output change:
//   UPDATE_QA_LOOPS_GOLDEN=1 node --test tests/qa-loops-golden.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repoRoot, 'dist', 'mini-drama', 'cli.js');
const stub = join(repoRoot, 'tests', 'fixtures', 'qa-loops', 'stub-venice.mjs');
const goldenPath = join(repoRoot, 'tests', 'fixtures', 'qa-loops-golden.json');
const update = process.env.UPDATE_QA_LOOPS_GOLDEN === '1';
const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { encoding: 'utf-8' }).status === 0;

const root = realpathSync(mkdtempSync(join(tmpdir(), 'qa-loops-golden-')));

// ---- Fixtures ------------------------------------------------------------

const fixture = text => Buffer.from(`FIXTURE:${text}`, 'utf-8');

const CHARACTERS = [
  { name: 'MARA', gender: 'female', age: '40s', description: 'a weathered pilot', fullDescription: 'A pilot.', wardrobe: 'grey flight jacket', locked: true, seed: 1 },
  { name: 'JUNO', gender: 'female', age: '20s', description: 'a young engineer', fullDescription: 'An engineer.', wardrobe: 'orange overalls', locked: true, seed: 2 },
  { name: 'KAI', gender: 'male', age: '30s', description: 'a courier', fullDescription: 'A courier.', wardrobe: 'black coat', locked: true, seed: 3 },
];
const LOCATIONS = [
  { name: 'Capsule', slug: 'capsule', description: 'a cramped cockpit', lightingNotes: 'amber', seed: 4, spatialAnchors: 'console along the front wall; hatch behind the seats; porthole left of the console' },
  { name: 'Street', slug: 'street', description: 'a wet night street', lightingNotes: 'neon', seed: 5 },
];

const base = { duration: '5s', videoModel: 'character', environment: 'DAY_INTERIOR', dialogue: null, sfx: null, transition: 'CUT' };
const STORYBOARD_SHOTS = [
  { ...base, shotNumber: 1, type: 'medium', cameraMovement: 'static', location: 'capsule', characters: ['MARA'], description: 'MARA checks the console.', blocking: 'MARA seated at the console, screen left, facing right.' },
  { ...base, shotNumber: 2, type: 'wide', cameraMovement: 'slow push', location: 'capsule', characters: [], description: 'The empty cockpit hums.', videoModel: 'atmosphere' },
  { ...base, shotNumber: 3, type: 'two-shot', cameraMovement: 'static', location: 'capsule', characters: ['MARA', 'JUNO'], description: 'JUNO climbs through the hatch.', blocking: 'MARA screen left at the console; JUNO screen right at the hatch.', episodeWardrobe: { JUNO: 'sealed flight suit' } },
  { ...base, shotNumber: 4, type: 'close-up', cameraMovement: 'handheld', location: 'street', characters: ['KAI'], description: 'KAI waits under a neon sign.' },
  { ...base, shotNumber: 5, type: 'medium', cameraMovement: 'tracking', location: 'street', characters: ['MARA'], description: 'MARA walks past.', blocking: 'MARA enters screen right, crossing left.' },
  { ...base, shotNumber: 6, type: 'insert', cameraMovement: 'static', characters: ['JUNO'], description: 'JUNO turns a wrench.', panelDescription: 'Close on JUNO\'s gloved hands on a wrench.' },
];

const VIDEO_SHOTS = [
  { ...base, shotNumber: 1, type: 'medium', cameraMovement: 'static', characters: ['MARA'], description: 'MARA at the console.' },
  { ...base, shotNumber: 2, type: 'wide', cameraMovement: 'static', characters: [], description: 'Empty cockpit.' },
  { ...base, shotNumber: 3, type: 'two-shot', cameraMovement: 'static', characters: ['MARA', 'JUNO'], description: 'They argue.' },
  { ...base, shotNumber: 4, type: 'medium', cameraMovement: 'static', characters: ['MARA'], description: 'MARA alone.' },
  { ...base, shotNumber: 5, type: 'medium', cameraMovement: 'static', characters: ['KAI'], description: 'KAI waits.' },
  { ...base, shotNumber: 6, type: 'medium', cameraMovement: 'static', characters: ['JUNO'], description: 'JUNO works.' },
];

const UNITS = [
  { unitId: 'u1', outputFile: 'u1.mp4', shotNumbers: [1, 2], segments: [{ shotNumber: 1, startOffsetSec: 0, durationSec: 1 }, { shotNumber: 2, startOffsetSec: 1, durationSec: 1 }] },
  { unitId: 'u2', outputFile: 'u2.mp4', shotNumbers: [3] },
  { unitId: 'u3', outputFile: 'u3.mp4', shotNumbers: [4, 5], segments: [{ shotNumber: 4, startOffsetSec: 0, durationSec: 1 }, { shotNumber: 5, startOffsetSec: 1, durationSec: 1 }] },
  { unitId: 'u4', outputFile: 'u4.mp4', shotNumbers: [6] },
];

const COLORS = { dark: '0x202020', mid: '0x585858', gray: '0x606060', red: '0xA04040', blue: '0x4070A0', light: '0xE0E0E0' };
const clipDir = join(root, 'clips');

/** A 2s 24fps clip of one colour; `glitch` adds a 2-frame white flash at frames 4-5. */
function clip(color, glitch = false) {
  const path = join(clipDir, `${color}${glitch ? '-glitch' : ''}.mp4`);
  if (existsSync(path)) return path;
  mkdirSync(clipDir, { recursive: true });
  const r = spawnSync('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${COLORS[color]}:s=160x90:d=2:r=24`,
    ...(glitch ? ['-vf', "geq=lum='if(between(N,4,5),235,lum(X,Y))':cb=128:cr=128"] : []),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path,
  ], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  return path;
}

function makeProject(name, { shots, sheets = ['MARA', 'JUNO'], panels = [], clips = {} }) {
  const projectDir = join(root, name);
  mkdirSync(projectDir, { recursive: true });
  const series = {
    name: 'Rocketship', slug: 'rocketship', concept: 'c', genre: 'drama', setting: 's', outputDir: projectDir,
    aesthetic: { style: 'documentary', palette: 'cold blue', lighting: 'hard', lensCharacteristics: 'large format', filmStock: 'fine grain' },
    storyboardAspectRatio: '16:9',
    intelligence: { model: 'text-a', visionModel: 'vision-b' },
    characters: CHARACTERS, locations: LOCATIONS,
    episodes: [{ number: 1, title: 'One', status: 'approved' }],
    createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z',
  };
  writeFileSync(join(projectDir, 'series.json'), JSON.stringify(series, null, 2));
  for (const c of sheets) {
    const dir = join(projectDir, 'characters', c.toLowerCase());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'front.png'), fixture(`sheet:${c}`));
  }
  const episodeDir = join(projectDir, 'episodes', 'episode-001');
  const sceneDir = join(episodeDir, 'scene-001');
  mkdirSync(sceneDir, { recursive: true });
  writeFileSync(join(episodeDir, 'script.json'), JSON.stringify({
    episode: 1, title: 'One', seriesName: 'Rocketship', totalDuration: '30s', status: 'approved', locations: [], shots,
  }, null, 2));
  for (const n of panels) {
    writeFileSync(join(sceneDir, `shot-${String(n).padStart(3, '0')}.png`), fixture(`panel:${n}`));
  }
  if (Object.keys(clips).length > 0) {
    writeFileSync(join(episodeDir, 'generation-plan.json'), JSON.stringify({ episode: 1, units: UNITS }, null, 2));
    for (const [file, src] of Object.entries(clips)) {
      writeFileSync(join(sceneDir, file), readFileSync(src));
    }
  }
  return { projectDir, episodeDir };
}

// ---- Cases ---------------------------------------------------------------

const ok = (verdict, issues = [], notes = 'ok') => JSON.stringify({ verdict, issues, notes });

const STORYBOARD_CASES = [
  {
    name: 'storyboard-all-pass',
    project: { panels: [1, 2, 3, 4, 5, 6] },
    args: [],
    replies: [1, 2, 3, 4, 5, 6].map(n => ({ when: { model: 'vision-b', text: `for shot ${n}.` }, reply: ok('PASS') })),
  },
  {
    name: 'storyboard-criticals-and-selection',
    project: { panels: [1, 2, 3, 4, 5, 6] },
    args: ['--model', 'qa-x', '--shots', '1,3-5'],
    replies: [
      { when: { model: 'qa-x', text: 'for shot 1.' }, reply: ok('FLAG-CRITICAL', ['MARA has blonde hair; reference is black', 'console on the wrong wall'], 'identity break') },
      { when: { model: 'qa-x', text: 'for shot 3.' }, reply: ok('FLAG-MODERATE', ['JUNO wardrobe is overalls, not the flight suit']) },
      { when: { model: 'qa-x', text: 'for shot 4.' }, reply: ok('FLAG-LOW', ['slight colour drift']) },
      { when: { model: 'qa-x', text: 'for shot 5.' }, reply: ok('FLAG-CRITICAL', ['MARA crosses right, blocking says left']) },
    ],
  },
  {
    name: 'storyboard-companion-rescue',
    project: { panels: [1, 2, 3] },
    args: ['--model', 'qa-x', '--shots', '1-3'],
    replies: [
      { when: { model: 'qa-x', text: 'for shot 1.' }, reply: ok('PASS') },
      { when: { model: 'qa-x', text: 'for shot 2.' }, reply: '' },
      { when: { model: 'qa-x', text: 'for shot 2.' }, reply: '   ' },
      { when: { model: 'vision-b', text: 'for shot 2.' }, reply: ok('PASS', [], 'rescued') },
      { when: { model: 'qa-x', text: 'for shot 3.' }, reply: { error: 'Venice API error 500: upstream exploded', status: 500 } },
      { when: { model: 'vision-b', text: 'for shot 3.' }, reply: `\`\`\`json\n${ok('FLAG-LOW', ['hatch slightly too far right'])}\n\`\`\`` },
    ],
  },
  {
    name: 'storyboard-unchecked-and-missing',
    // shot 3's panel is missing: shot 3 reports MISSING and shot 4... is in
    // another location; shot 5's prior (4) is present. JUNO has no sheet.
    project: { panels: [1, 2, 4, 5, 6], sheets: ['MARA'] },
    args: ['--model', 'qa-x'],
    replies: [
      { when: { model: 'qa-x', text: 'for shot 1.' }, reply: '' },
      { when: { model: 'qa-x', text: 'for shot 1.' }, reply: '' },
      { when: { model: 'vision-b', text: 'for shot 1.' }, reply: 'not json at all' },
      { when: { model: 'vision-b', text: 'for shot 1.' }, reply: 'still not json' },
      { when: { model: 'qa-x', text: 'for shot 2.' }, reply: ok('PASS') },
      { when: { model: 'qa-x', text: 'for shot 4.' }, reply: ok('PASS') },
      { when: { model: 'qa-x', text: 'for shot 5.' }, reply: ok('PASS') },
      { when: { model: 'qa-x', text: 'for shot 6.' }, reply: { error: 'Venice API error 400: Image content is not supported by this model', status: 400 } },
      { when: { model: 'vision-b', text: 'for shot 6.' }, reply: { error: 'Venice API error 503: overloaded', status: 503 } },
    ],
  },
  {
    name: 'storyboard-prior-panel-missing-and-single-model-failure',
    // No --model: the chain is just the project vision model, so a failure
    // goes straight to UNCHECKED with no retry line. Shot 2's prior panel (1)
    // is missing on disk, so nothing is attached (no fallback to an older one).
    project: { panels: [2, 3] },
    args: ['--shots', '2,3'],
    replies: [
      { when: { model: 'vision-b', text: 'for shot 2.' }, reply: { error: 'Venice API error 500: boom', status: 500 } },
      { when: { model: 'vision-b', text: 'for shot 3.' }, reply: ok('PASS') },
    ],
  },
  {
    name: 'storyboard-reply-without-issues',
    // A reply that parses but has no `issues` array. Pins current behaviour:
    // the result is pushed, then the progress line throws reading
    // `issues.length`, which the chain treats as a failed attempt.
    project: { panels: [1, 2] },
    args: ['--model', 'qa-x', '--shots', '1-2'],
    replies: [
      { when: { model: 'qa-x', text: 'for shot 1.' }, reply: JSON.stringify({ verdict: 'PASS', notes: 'no issues key' }) },
      { when: { model: 'vision-b', text: 'for shot 1.' }, reply: ok('PASS') },
      { when: { model: 'qa-x', text: 'for shot 2.' }, reply: JSON.stringify({ verdict: 'FLAG-LOW' }) },
      { when: { model: 'vision-b', text: 'for shot 2.' }, reply: JSON.stringify({ verdict: 'FLAG-LOW' }) },
    ],
  },
];

const identityText = unit => `rendered frames from unit ${unit}.`;
const CROSS = 'one per generation unit';

const VIDEO_CASES = [
  {
    name: 'video-all-pass',
    clips: { 'u1.mp4': ['gray'], 'u2.mp4': ['red'], 'u3.mp4': ['blue'] },
    args: [],
    replies: [
      { when: { model: 'vision-b', text: identityText('u1') }, reply: ok('PASS') },
      { when: { model: 'vision-b', text: identityText('u2') }, reply: ok('PASS') },
      { when: { model: 'vision-b', text: identityText('u3') }, reply: ok('PASS') },
      { when: { model: 'vision-b', text: CROSS }, reply: JSON.stringify({ verdict: 'PASS', issues: [], driftingFrames: [], unclearFrames: [], notes: 'same' }) },
    ],
  },
  {
    name: 'video-head-glitch-and-boundaries',
    clips: { 'u1.mp4': ['dark', true], 'u2.mp4': ['mid'], 'u3.mp4': ['light'] },
    args: ['--skip-vision'],
    replies: [],
  },
  {
    name: 'video-identity-drift',
    clips: { 'u1.mp4': ['gray'], 'u2.mp4': ['red'], 'u3.mp4': ['blue'] },
    args: [],
    replies: [
      { when: { model: 'vision-b', text: identityText('u1') }, reply: ok('PASS') },
      { when: { model: 'vision-b', text: identityText('u2') }, reply: ok('FLAG-CRITICAL', ['MARA reads as a different woman', 'jacket is red']) },
      { when: { model: 'vision-b', text: identityText('u3') }, reply: JSON.stringify({ verdict: 'FLAG-LOW', notes: 'issues omitted' }) },
      { when: { model: 'vision-b', text: CROSS }, reply: JSON.stringify({ verdict: 'FLAG-CRITICAL', issues: ['frame 2 protagonist has a different face'], driftingFrames: [2, 9], unclearFrames: [3], notes: 'drift' }) },
    ],
  },
  {
    name: 'video-vision-errors',
    clips: { 'u1.mp4': ['gray'], 'u2.mp4': ['red'], 'u3.mp4': ['blue'] },
    args: ['--model', 'vqa-x'],
    replies: [
      { when: { model: 'vqa-x', text: identityText('u1') }, reply: { error: 'Venice API error 500: boom', status: 500 } },
      { when: { model: 'vqa-x', text: identityText('u2') }, reply: '' },
      { when: { model: 'vqa-x', text: identityText('u2') }, reply: '' },
      { when: { model: 'vqa-x', text: identityText('u3') }, reply: 'nope' },
      { when: { model: 'vqa-x', text: identityText('u3') }, reply: ok('FLAG-MODERATE', ['KAI coat is brown']) },
      { when: { model: 'vqa-x', text: CROSS }, reply: '' },
      { when: { model: 'vqa-x', text: CROSS }, reply: '' },
    ],
  },
  {
    name: 'video-no-sheets-no-protagonist-frames',
    // No reference sheets on disk: every identity check passes without a call.
    // Only u3 rendered, so the cross-unit check has one hero frame and is skipped.
    clips: { 'u3.mp4': ['blue'] },
    sheets: [],
    args: [],
    replies: [],
  },
];

// ---- Runner --------------------------------------------------------------

function runCli(args, { scriptPath, logPath, configDir }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', stub, cli, ...args], {
      env: {
        ...process.env,
        VENICE_API_KEY: '',
        VENICE_VIDEO_CONFIG_DIR: configDir,
        QA_STUB_SCRIPT: scriptPath,
        QA_STUB_LOG: logPath,
        NO_COLOR: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

function normalize(text, projectDir) {
  return text.split(projectDir).join('<PROJECT>');
}

async function runCase(kind, c) {
  const clipPaths = Object.fromEntries(Object.entries(c.clips ?? {}).map(([f, [color, glitch]]) => [f, clip(color, glitch)]));
  const project = kind === 'storyboard'
    ? makeProject(c.name, { shots: STORYBOARD_SHOTS, ...c.project })
    : makeProject(c.name, { shots: VIDEO_SHOTS, sheets: c.sheets ?? ['MARA', 'JUNO'], clips: clipPaths });
  const scriptPath = join(root, `${c.name}.replies.json`);
  const logPath = join(root, `${c.name}.requests.jsonl`);
  writeFileSync(scriptPath, JSON.stringify(c.replies));
  writeFileSync(logPath, '');
  const command = kind === 'storyboard' ? 'qa-storyboard' : 'qa-videos';
  const args = [command, '-p', project.projectDir, '-e', '1', ...c.args];
  const { status, stdout, stderr } = await runCli(args, { scriptPath, logPath, configDir: join(root, `${c.name}.config`) });

  const reportFile = join(project.episodeDir, kind === 'storyboard' ? 'qa-report.json' : 'video-qa-report.json');
  let report = null;
  if (existsSync(reportFile)) {
    const raw = readFileSync(reportFile, 'utf-8');
    report = { raw: normalize(raw, project.projectDir).replace(/"analyzedAt": "[^"]+"/, '"analyzedAt": "<TIME>"') };
  }
  const requests = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  return {
    args: [command, '-p', '<PROJECT>', '-e', '1', ...c.args],
    status,
    stdout: normalize(stdout, project.projectDir),
    stderr: normalize(stderr, project.projectDir),
    report,
    requests,
  };
}

test('qa-storyboard / qa-videos output, reports and vision requests match the golden', { skip: !ffmpegAvailable }, async () => {
  const actual = {};
  for (const c of STORYBOARD_CASES) actual[c.name] = await runCase('storyboard', c);
  for (const c of VIDEO_CASES) actual[c.name] = await runCase('video', c);

  if (update) {
    writeFileSync(goldenPath, `${JSON.stringify(actual, null, 2)}\n`);
  }
  const golden = JSON.parse(readFileSync(goldenPath, 'utf-8'));
  assert.deepEqual(Object.keys(actual), Object.keys(golden));
  for (const name of Object.keys(golden)) {
    assert.deepEqual(actual[name], golden[name], `case ${name}`);
  }
});

test.after(() => rmSync(root, { recursive: true, force: true }));
