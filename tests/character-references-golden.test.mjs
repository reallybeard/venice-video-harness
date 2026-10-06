// Character reference sheets end to end, pinned byte for byte, along both
// paths that render them:
//   - `generateCharacterReferences` (workshop approval, stream), against a
//     fake client that answers /image/generate with a real noise PNG
//   - the `add-character` CLI, spawned with tests/support/fake-venice-images.mjs
//     answering /image/generate the same way (no network)
// Each case records every request body, each angle's `.prompt.json` sidecar
// and recipe minus timestamps, the files on disk, and (CLI) the saved
// character and the exit status. Compared against
// tests/fixtures/character-references-golden.json.
//
// The golden was captured before the request building moved into core.
// Regenerate it ONLY for an intended output change:
//   UPDATE_CHARACTER_REFERENCES_GOLDEN=1 node --test tests/character-references-golden.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { generateCharacterReferences } from '../dist/mini-drama/character-reference-generator.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const goldenPath = join(repoRoot, 'tests', 'fixtures', 'character-references-golden.json');
const update = process.env.UPDATE_CHARACTER_REFERENCES_GOLDEN === '1';
const cli = join(repoRoot, 'dist', 'mini-drama', 'cli.js');
const fakeImages = join(repoRoot, 'tests', 'support', 'fake-venice-images.mjs');

const AESTHETIC = {
  style: 'Cinematic photography',
  palette: 'warm amber palette',
  lighting: 'low-key practical lighting',
  lensCharacteristics: 'anamorphic lens characteristics',
};
const LONG_AESTHETIC = {
  style: 'Hand-painted gouache storybook illustration with thick visible brush strokes, chalky matte pigments, soft deckled paper texture, naive folk-art proportions, flattened perspective and decorative borders',
  palette: 'muted ochre, faded teal, brick red and bone white',
  lighting: 'flat diffuse daylight with no hard shadows',
};

const CHARACTERS = {
  mara: { name: 'MARA', gender: 'female', age: '40s', description: 'a weathered bush pilot', fullDescription: 'Mara, 40s, a weathered bush pilot with a sun-creased face and cropped grey hair', wardrobe: 'oil-stained leather flight jacket', voiceDescription: 'dry, low', locked: false, seed: 4242 },
  tomas: { name: 'TOMAS', gender: 'male', age: 'mid 20s', description: 'a nervous radio operator', fullDescription: 'Tomas, mid 20s, a nervous radio operator', wardrobe: 'n/a', voiceDescription: 'quick', baseTraits: 'lanky young man, freckles, wire glasses', locked: false, seed: 17 },
  ledger: { name: 'THE LEDGER', gender: 'other', age: 'n/a', description: 'a ledger', fullDescription: 'a leather-bound ledger with brass corners', wardrobe: 'none', voiceDescription: '', baseTraits: 'inanimate object, a leather-bound ledger', locked: false, seed: 3 },
  lantern: { name: 'THE LANTERN', kind: 'object', gender: 'other', age: 'n/a', description: 'a brass lantern', fullDescription: 'a dented brass storm lantern', wardrobe: 'n/a', voiceDescription: '', locked: false, seed: 5 },
};

const MODULE_CASES = [
  { name: 'all four angles, female default traits', character: 'mara' },
  { name: 'custom base traits, placeholder wardrobe dropped', character: 'tomas' },
  { name: 'object cast by baseTraits gets product-plate angles', character: 'ledger' },
  { name: 'a kind: object prop without baseTraits', character: 'lantern', options: { angles: ['front'] } },
  { name: 'angle subset keeps the requested order', character: 'mara', options: { angles: ['profile', 'front'] } },
  { name: 'skipExisting leaves an existing angle alone', character: 'mara', existing: ['front'], options: { skipExisting: true, angles: ['front', 'three-quarter'] } },
  { name: 'an existing angle is archived, not overwritten', character: 'mara', existing: ['profile'], options: { angles: ['profile'] } },
  { name: 'prompt, model, cfg, aspect and resolution overrides', character: 'tomas', options: { angles: ['front', 'full-body'], promptOverride: 'An exact hand-written prompt.', model: 'gpt-image-2', cfgScale: 7, aspectRatio: '2:3', resolution: '2K' } },
  { name: 'long aesthetic on a short-cap model keeps the subject', character: 'mara', aesthetic: LONG_AESTHETIC, options: { angles: ['front'], model: 'seedream-v5-lite' } },
  { name: 'negative prompt strategy none', character: 'mara', imageDefaults: { negativePromptStrategy: 'none' }, options: { angles: ['front'] } },
  { name: 'photoreal negative prompt strategy', character: 'mara', aesthetic: LONG_AESTHETIC, imageDefaults: { negativePromptStrategy: 'photoreal' }, options: { angles: ['three-quarter'] } },
  { name: 'no aesthetic throws', character: 'mara', aesthetic: null },
];

const CLI_CASES = [
  { name: 'male defaults', args: ['--name', 'Rook', '--gender', 'male'] },
  { name: 'female with description, wardrobe and voice', args: ['--name', 'Ines Vale', '--gender', 'female', '--age', 'late 30s', '--description', 'tall, sharp cheekbones, shaved head', '--wardrobe', 'grey wool coat', '--voice-desc', 'husky alto'] },
  { name: 'object via base traits', args: ['--name', 'The Key', '--gender', 'other', '--base-traits', 'inanimate object, an iron skeleton key'] },
  { name: 'angle subset with an inline prompt', args: ['--name', 'Rook', '--gender', 'male', '--angles', 'profile,front', '--prompt', 'A hand-written prompt for every angle.'] },
  { name: 'override file: per-angle prompts and shared settings', args: ['--name', 'Rook', '--gender', 'male', '--angles', 'front,three-quarter'], override: { angles: { front: { positive: 'Override front.', negative: 'override negative' }, 'three-quarter': { negative: 'only the negative' } }, shared: { model: 'seedream-v5-lite', cfg_scale: 9, aspect_ratio: '3:4', resolution: '2K', seed: 42 } } },
  { name: 'unreadable override file falls back to defaults', args: ['--name', 'Rook', '--gender', 'male', '--angles', 'front', '--override-prompt', 'missing.json'] },
  { name: 'invalid angle exits 2', args: ['--name', 'Rook', '--gender', 'male', '--angles', 'front,back'] },
  { name: 'skip images makes no request', args: ['--name', 'Rook', '--gender', 'male', '--skip-images'] },
  { name: 'existing angle is archived', args: ['--name', 'Rook', '--gender', 'male', '--angles', 'front'], existing: { dir: 'rook', angles: ['front'] } },
  { name: 'series negative strategy and long aesthetic', args: ['--name', 'Rook', '--gender', 'male', '--angles', 'front'], aesthetic: LONG_AESTHETIC, imageDefaults: { negativePromptStrategy: 'photoreal' } },
];

// Seeded noise: replies under 50 KB read as Venice's silent-reject stub.
const noise = Buffer.alloc(320 * 180 * 3);
for (let i = 0, s = 1; i < noise.length; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; noise[i] = (s >>> 16) & 0xff; }
const png = await sharp(noise, { raw: { width: 320, height: 180, channels: 3 } }).png().toBuffer();

function makeSeries(dir, c, characters = []) {
  const series = {
    name: 'Golden', slug: 'golden', concept: '', genre: '', setting: '',
    aesthetic: c.aesthetic === undefined ? AESTHETIC : c.aesthetic,
    characters, locations: [], episodes: [],
    videoDefaults: { actionModel: 'x', atmosphereModel: 'x', ...(c.imageDefaults ? { imageDefaults: c.imageDefaults } : {}) },
    outputDir: dir, createdAt: '', updatedAt: '',
  };
  writeFileSync(join(dir, 'series.json'), JSON.stringify(series, null, 2));
  return series;
}

/** Sidecars (minus timestamps) and file names of every character dir under `dir`. */
function snapshotCharacters(dir) {
  const root = join(dir, 'characters');
  const out = {};
  if (!existsSync(root)) return out;
  for (const slug of readdirSync(root).sort()) {
    const charDir = join(root, slug);
    const files = readdirSync(charDir).sort();
    const json = {};
    for (const f of files.filter(f => f.endsWith('.json'))) {
      const data = JSON.parse(readFileSync(join(charDir, f), 'utf-8'));
      json[f] = stripTimes(data);
    }
    out[slug] = { files: files.map(f => f.replace(/-force-archive-\d+\.png$/, '-force-archive-<ts>.png')), json };
  }
  return out;
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

async function runModuleCase(c) {
  const dir = mkdtempSync(join(tmpdir(), 'character-refs-golden-'));
  try {
    const character = CHARACTERS[c.character];
    const series = makeSeries(dir, c, [character]);
    const charDir = join(dir, 'characters', character.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
    mkdirSync(charDir, { recursive: true });
    for (const angle of c.existing ?? []) writeFileSync(join(charDir, `${angle}.png`), png);

    const calls = [];
    const client = {
      async post(path, body) { calls.push({ path, body }); return { images: [png.toString('base64')] }; },
    };
    const lines = [];
    const log = console.log;
    const warn = console.warn;
    console.log = (...a) => lines.push(a.join(' '));
    console.warn = (...a) => lines.push(`WARN ${a.join(' ')}`);
    let result;
    try {
      const r = await generateCharacterReferences(client, series, character, c.options ?? {});
      result = { generated: r.generated.map(p => basename(p)), skipped: r.skipped.map(p => basename(p)) };
    } catch (err) {
      result = { error: err.message };
    } finally {
      console.log = log;
      console.warn = warn;
    }
    return { result, calls, characters: snapshotCharacters(dir), log: lines };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCliCase(c) {
  const dir = mkdtempSync(join(tmpdir(), 'add-character-golden-'));
  const configDir = mkdtempSync(join(tmpdir(), 'add-character-config-'));
  try {
    const project = join(dir, 'project');
    mkdirSync(project);
    makeSeries(project, c);
    if (c.existing) {
      const charDir = join(project, 'characters', c.existing.dir);
      mkdirSync(charDir, { recursive: true });
      for (const angle of c.existing.angles) writeFileSync(join(charDir, `${angle}.png`), png);
    }
    const args = [...c.args];
    if (c.override) {
      writeFileSync(join(dir, 'override.json'), JSON.stringify(c.override));
      args.push('--override-prompt', 'override.json');
    }
    const logFile = join(dir, 'requests.jsonl');
    const run = spawnSync(process.execPath, [cli, 'add-character', '-p', project, ...args], {
      cwd: dir,
      encoding: 'utf-8',
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${fakeImages}`.trim(),
        FAKE_VENICE_IMAGE_LOG: logFile,
        VENICE_API_KEY: 'test-key',
        VENICE_VIDEO_CONFIG_DIR: configDir,
      },
    });
    const calls = existsSync(logFile)
      ? readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : [];
    const saved = JSON.parse(readFileSync(join(project, 'series.json'), 'utf-8'));
    return {
      status: run.status,
      calls,
      seriesCharacters: saved.characters,
      characters: snapshotCharacters(project),
      stdout: run.stdout.split('\n').filter(Boolean).map(l => l.replaceAll(dir, '<dir>')),
      stderr: run.stderr.split('\n').filter(Boolean).map(l => l.replaceAll(dir, '<dir>')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
}

test('character reference generation matches the golden', async () => {
  const actual = { module: {}, cli: {} };
  for (const c of MODULE_CASES) actual.module[c.name] = await runModuleCase(c);
  for (const c of CLI_CASES) actual.cli[c.name] = runCliCase(c);
  if (update) {
    writeFileSync(goldenPath, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  const golden = JSON.parse(readFileSync(goldenPath, 'utf-8'));
  for (const section of ['module', 'cli']) {
    assert.deepEqual(Object.keys(actual[section]), Object.keys(golden[section]), section);
    for (const name of Object.keys(golden[section])) assert.deepEqual(actual[section][name], golden[section][name], `${section}: ${name}`);
  }
});
