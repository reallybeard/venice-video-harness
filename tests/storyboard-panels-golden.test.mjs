// `storyboard-episode` end to end, pinned byte for byte: pass 1 drafting
// (reference-drafted on a location plate, t2i draft + identity composite,
// t2i for faceless shots; the text-only character branch is unreachable, the
// reference preflight blocks first), pass 2 refinement (identity refine through fixPanel, style
// match against the location plate or the episode style anchor) and pass 3
// scene-ref injection. The CLI is spawned with tests/support/fake-venice-images.mjs
// answering /image/generate and /image/multi-edit with a distinct PNG per
// request (no network), and each sent image is labelled by the project files
// with its bytes. Each case records every request body, the files in the
// scene dir, the recipe and provenance sidecars minus timestamps, stdout,
// stderr and the exit status, against tests/fixtures/storyboard-panels-golden.json.
//
// The golden was captured before the panel request building moved into core.
// Regenerate it ONLY for an intended output change:
//   UPDATE_STORYBOARD_PANELS_GOLDEN=1 node --test tests/storyboard-panels-golden.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const goldenPath = join(repoRoot, 'tests', 'fixtures', 'storyboard-panels-golden.json');
const update = process.env.UPDATE_STORYBOARD_PANELS_GOLDEN === '1';
const cli = join(repoRoot, 'dist', 'mini-drama', 'cli.js');
const fakeImages = join(repoRoot, 'tests', 'support', 'fake-venice-images.mjs');

const AESTHETIC = { style: 'Cinematic photography', palette: 'warm amber palette', lighting: 'low-key practical lighting', lensCharacteristics: 'anamorphic', filmStock: 'fine grain', seed: 77 };
const CHARACTERS = [
  { name: 'MARA', gender: 'female', age: '40s', description: 'a weathered bush pilot with a sun-creased face and cropped grey hair, always squinting', fullDescription: 'Mara, 40s, a weathered bush pilot', wardrobe: 'oil-stained leather flight jacket', locked: true, seed: 1 },
  { name: 'JUNO', gender: 'female', age: '20s', description: 'an engineer', fullDescription: 'Juno, 20s, an engineer', wardrobe: 'grease-stained overalls', baseTraits: 'wiry young woman, shaved head', locked: true, seed: 2 },
  { name: 'TOMAS', gender: 'male', age: 'mid 20s', description: 'a nervous radio operator', fullDescription: 'Tomas, a nervous radio operator', wardrobe: 'wool sweater', locked: true, seed: 3 },
];
const LOCATIONS = [
  { name: 'Capsule', slug: 'capsule', description: 'a cramped cockpit capsule', lightingNotes: 'amber instrument glow', spatialAnchors: 'pilot seat facing the forward window; hatch behind it', seed: 4 },
];
const REF_FILES = [
  'characters/mara/front.png', 'characters/mara/three-quarter.png', 'characters/mara/profile.png',
  'characters/juno/anchor.png', 'characters/juno/front.png',
  'characters/tomas/front.png',
  'locations/capsule/north.png', 'locations/capsule/south.png',
  'props/logo.png',
];

function shot(shotNumber, characters, location, extra = {}) {
  return {
    shotNumber, type: 'medium', environment: 'NIGHT_INTERIOR', ...(location ? { location } : {}), duration: '15s',
    videoModel: 'character', description: `Shot ${shotNumber} action.`, characters, dialogue: null, sfx: null,
    cameraMovement: 'static', transition: 'CUT', ...extra,
  };
}

const FRESH = [
  shot(1, ['MARA'], 'capsule', { blocking: 'Mara in the pilot seat, screen left, facing the forward window.', episodeWardrobe: { MARA: 'orange flight suit' } }),
  shot(2, ['MARA'], undefined, { type: 'close-up', environment: 'DAY_EXTERIOR' }),
  shot(3, ['MARA', 'JUNO'], 'capsule', { blocking: 'Juno crouches by the hatch behind Mara.' }),
  shot(4, ['MARA', 'JUNO', 'TOMAS'], 'capsule'),
  shot(5, [], 'capsule', { type: 'wide', videoModel: 'atmosphere' }),
  shot(6, [], undefined, { type: 'insert', videoModel: 'atmosphere', environment: 'DAY_EXTERIOR' }),
  shot(7, [], undefined, { type: 'wide', videoModel: 'atmosphere', skipRefine: true }),
  shot(9, ['MARA'], 'capsule', { sceneImagePaths: ['<dir>/props/logo.png', '<dir>/props/missing.png'], sceneRefDescription: 'Paint the logo onto the console.' }),
  shot(10, [], undefined, { videoModel: 'atmosphere', sceneImagePaths: ['<dir>/props/logo.png'] }),
];

const EXISTING = [
  shot(1, ['MARA'], 'capsule'),
  shot(2, ['MARA'], undefined),
  shot(3, ['MARA', 'JUNO'], 'capsule', { episodeWardrobe: { JUNO: 'white lab coat' } }),
  shot(4, ['JUNO'], 'capsule', { environment: 'DAY_INTERIOR' }),
  shot(5, ['TOMAS'], undefined),
  shot(6, [], 'capsule', { videoModel: 'atmosphere' }),
  shot(7, [], undefined, { videoModel: 'atmosphere' }),
  shot(8, [], undefined, { videoModel: 'atmosphere' }),
];
const panel = n => `episodes/episode-001/scene-001/shot-${String(n).padStart(3, '0')}.png`;

const CASES = [
  { name: 'fresh storyboard, refine on', shots: FRESH },
  {
    name: 'no refine, model, cfg and aspect overrides', shots: [FRESH[0], FRESH[1], FRESH[5]],
    series: { storyboardAspectRatio: '9:16', imageDefaults: { generationModel: 'gpt-image-2', editModel: 'qwen-image-2-edit' } },
    args: ['--no-refine', '--cfg-scale', '7'],
  },
  {
    name: 'existing panels: identity refine and style match, already-refined skips', shots: EXISTING,
    existing: [panel(1), panel(2), panel(3), panel(4), panel(5), panel(6), panel(7), panel(8), 'episodes/episode-001/scene-001/shot-007-pre-style.png', 'episodes/episode-001/scene-001/shot-005-pre-fix.png'],
    args: ['--edit-model', 'seedream-v5-lite-edit'],
  },
  { name: '--shots rebuilds the listed shots only', shots: EXISTING.slice(0, 3), existing: [panel(1), panel(2), panel(3)], args: ['--shots', '2,9'] },
];

async function noisePng(seed) {
  const noise = Buffer.alloc(320 * 180 * 3);
  for (let i = 0, s = seed; i < noise.length; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; noise[i] = (s >>> 16) & 0xff; }
  return sharp(noise, { raw: { width: 320, height: 180, channels: 3 } }).png().toBuffer();
}

function stripTimes(value) {
  if (Array.isArray(value)) return value.map(stripTimes);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (['generatedAt', 'createdAt', 'updatedAt', 'at', 'timestamp'].includes(k)) continue;
      out[k] = stripTimes(v);
    }
    return out;
  }
  return value;
}

const maskTimes = line => line
  .replace(/\(\d+(?:\.\d+)?s/g, '(<t>s')
  .replace(/ETA ~\d+min/g, 'ETA ~<n>min')
  .replace(/-force-archive-\d+/g, '-force-archive-<ts>');

async function runCase(c) {
  const dir = mkdtempSync(join(tmpdir(), 'storyboard-panels-golden-'));
  const configDir = mkdtempSync(join(tmpdir(), 'storyboard-panels-config-'));
  // macOS tmpdir is a symlink into /private, and Node error messages print the resolved path.
  const real = realpathSync(dir);
  const hideDir = text => maskTimes(text.replaceAll(real, '<dir>').replaceAll(dir, '<dir>'));
  try {
    const project = join(dir, 'project');
    const series = {
      name: 'Golden', slug: 'golden', concept: '', genre: '', setting: '',
      aesthetic: AESTHETIC, aestheticSeed: 99, characters: CHARACTERS, locations: LOCATIONS,
      episodes: [{ number: 1, title: 'Pilot', status: 'scripted' }],
      videoDefaults: { actionModel: 'x', atmosphereModel: 'x', ...(c.series?.imageDefaults ? { imageDefaults: c.series.imageDefaults } : {}) },
      ...(c.series?.storyboardAspectRatio ? { storyboardAspectRatio: c.series.storyboardAspectRatio } : {}),
      outputDir: project, createdAt: '', updatedAt: '',
    };
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'series.json'), JSON.stringify(series, null, 2));
    let seed = 1;
    for (const rel of [...REF_FILES, ...(c.existing ?? [])]) {
      mkdirSync(dirname(join(project, rel)), { recursive: true });
      writeFileSync(join(project, rel), await noisePng(++seed));
    }
    const episodeDir = join(project, 'episodes', 'episode-001');
    mkdirSync(episodeDir, { recursive: true });
    const shots = JSON.parse(JSON.stringify(c.shots).replaceAll('<dir>', project));
    writeFileSync(join(episodeDir, 'script.json'), JSON.stringify({ episode: 1, title: 'Pilot', seriesName: 'Golden', totalDuration: '0s', status: 'approved', locations: [], shots }, null, 2));

    const logFile = join(dir, 'requests.jsonl');
    const run = spawnSync(process.execPath, [cli, 'storyboard-episode', '-p', project, '-e', '1', ...(c.args ?? [])], {
      cwd: dir,
      encoding: 'utf-8',
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${fakeImages}`.trim(),
        FAKE_VENICE_IMAGE_LOG: logFile,
        FAKE_VENICE_IMAGE_VARY: '1',
        FAKE_VENICE_IMAGE_ROOT: project,
        VENICE_API_KEY: 'test-key',
        VENICE_VIDEO_CONFIG_DIR: configDir,
        NO_COLOR: '1',
      },
    });
    const calls = existsSync(logFile)
      ? readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(hideDir(l)))
      : [];
    const sceneDir = join(episodeDir, 'scene-001');
    const files = existsSync(sceneDir) ? readdirSync(sceneDir).sort() : [];
    const sidecars = {};
    for (const f of files.filter(f => f.endsWith('.json'))) {
      sidecars[maskTimes(f)] = stripTimes(JSON.parse(hideDir(readFileSync(join(sceneDir, f), 'utf-8'))));
    }
    const saved = JSON.parse(readFileSync(join(project, 'series.json'), 'utf-8'));
    return {
      status: run.status,
      calls,
      files: files.map(maskTimes),
      sidecars,
      episodeStatus: saved.episodes[0].status,
      stdout: run.stdout.split('\n').filter(Boolean).map(hideDir),
      stderr: run.stderr.split('\n').filter(Boolean).map(hideDir),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
}

test('storyboard-episode panel requests match the golden', { timeout: 180_000 }, async () => {
  const actual = {};
  for (const c of CASES) actual[c.name] = await runCase(c);
  if (update) {
    writeFileSync(goldenPath, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  const golden = JSON.parse(readFileSync(goldenPath, 'utf-8'));
  assert.deepEqual(Object.keys(actual), Object.keys(golden));
  for (const name of Object.keys(golden)) assert.deepEqual(actual[name], golden[name], name);
});
