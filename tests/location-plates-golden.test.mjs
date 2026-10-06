// `generateLocationReferences` end to end, pinned byte for byte.
//
// Each case builds a scratch project, runs the real generator against a fake
// Venice client (it answers /image/generate and /image/multi-edit with a tiny
// real PNG), and records:
//   - every request body sent, the base image replaced by the file it came from
//   - each plate's `.prompt.json` sidecar, minus its timestamp
//   - which plates were generated and skipped, or the error thrown
// and compares the lot against tests/fixtures/location-plates-golden.json.
//
// The golden was captured from the generator before its prompt building moved
// into core. Regenerate it ONLY for an intended output change:
//   UPDATE_LOCATION_PLATES_GOLDEN=1 node --test tests/location-plates-golden.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { generateLocationReferences } from '../dist/mini-drama/location-generator.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const goldenPath = join(repoRoot, 'tests', 'fixtures', 'location-plates-golden.json');
const update = process.env.UPDATE_LOCATION_PLATES_GOLDEN === '1';

const AESTHETIC = {
  style: 'Cinematic photography',
  palette: 'warm amber palette',
  lighting: 'low-key practical lighting',
  lensCharacteristics: 'anamorphic lens characteristics',
};

const LOCATIONS = {
  plain: { name: 'Back Alley', slug: 'back-alley', description: 'a narrow wet alley behind a noodle bar', seed: 41 },
  full: {
    name: 'The Study', slug: 'the-study', seed: 7,
    description: 'a cluttered professor\'s study lined with bookshelves',
    lightingNotes: 'late-afternoon sun through tall west windows',
    spatialAnchors: 'oak desk along the north wall; door in the south wall; window on the west wall',
  },
};

const OBJECT_CAST = [
  { name: 'THE LEDGER', baseTraits: 'inanimate object, a leather-bound ledger', gender: 'n/a', age: 'n/a', description: 'a ledger', fullDescription: '', wardrobe: '', locked: true, seed: 3 },
  { name: 'MARA', baseTraits: 'a weathered pilot', gender: 'female', age: '40s', description: 'a pilot', fullDescription: '', wardrobe: '', locked: true, seed: 4 },
];

const CASES = [
  { name: 'default compass set, plain location', location: 'plain' },
  { name: 'default compass set, lighting + anchors + film stock', location: 'full', aesthetic: { ...AESTHETIC, filmStock: 'Kodak Vision3 500T' } },
  { name: 'object cast gets a clean-plate clause and negatives', location: 'full', characters: OBJECT_CAST },
  {
    name: 'a kind: object prop without baseTraits is kept out of the plate', location: 'plain', options: { angles: ['north', 'south'] },
    characters: [{ name: 'THE LANTERN', kind: 'object', gender: 'other', age: 'n/a', description: 'a brass lantern', fullDescription: '', wardrobe: '', locked: true, seed: 5 }],
  },
  { name: 'derived only, hero missing: north generated first', location: 'plain', options: { angles: ['east', 'south'] } },
  { name: 'derived only, hero on disk', location: 'plain', existing: ['north'], options: { angles: ['west'] } },
  { name: 'legacy wide hero on disk satisfies a derive', location: 'plain', existing: ['wide'], options: { angles: ['south'] } },
  { name: 'existing plates are skipped', location: 'plain', existing: ['north', 'south'] },
  { name: 'force regenerates existing plates', location: 'plain', existing: ['north', 'south'], options: { angles: ['north', 'south'], force: true } },
  { name: 'north prompt override replaces the whole prompt', location: 'full', options: { angles: ['north'], promptOverride: 'An exact hand-written hero prompt.' } },
  { name: 'custom angle uses the override as its view clause', location: 'full', existing: ['north'], options: { angles: ['Behind the Desk!'], promptOverride: 'Camera behind the desk looking at the door' } },
  { name: 'custom angle without a prompt throws', location: 'full', options: { angles: ['night'] } },
  { name: 'legacy ladder names still build', location: 'plain', options: { angles: ['wide', 'angle-2', 'angle-3', 'angle-4', 'medium', 'detail'] } },
  { name: 'model, edit model and cfg overrides', location: 'plain', options: { model: 'gpt-image-2', editModel: 'qwen-image-2-edit', cfgScale: 7 } },
  { name: 'series edit model, location reference model, portrait aspect', location: 'plain', aspect: '9:16', editModel: 'seedream-v5-lite-edit', referenceModel: 'flux-2-pro', options: { angles: ['north', 'east'] } },
];

// Seeded noise: replies under 50 KB (generate) / 30 KB (edit) read as Venice's silent-reject stub.
const noise = Buffer.alloc(320 * 180 * 3);
for (let i = 0, s = 1; i < noise.length; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; noise[i] = (s >>> 16) & 0xff; }
const png = await sharp(noise, { raw: { width: 320, height: 180, channels: 3 } }).png().toBuffer();
const pngDataUri = `data:image/png;base64,${png.toString('base64')}`;

function fakeClient(calls, dirOf) {
  const label = body => {
    const out = { ...body };
    if (typeof out.image === 'string') out.image = labelImage(out.image);
    if (typeof out.baseImage === 'string') out.baseImage = labelImage(out.baseImage);
    if (Array.isArray(out.images)) out.images = out.images.map(i => (typeof i === 'string' ? labelImage(i) : i));
    return out;
  };
  const labelImage = uri => {
    if (!uri.startsWith('data:')) return uri;
    // A forced plate's archive holds the same fake bytes as the new plate, so live files are matched first.
    const files = readdirSync(dirOf()).filter(f => /\.(png|webp)$/.test(f)).sort((a, b) => a.includes('-force-archive-') - b.includes('-force-archive-'));
    const match = files.find(f => `data:image/png;base64,${readFileSync(join(dirOf(), f)).toString('base64')}` === uri);
    return `<image ${match ?? (uri === pngDataUri ? 'fake.png' : 'unknown')}>`;
  };
  return {
    async post(path, body) {
      calls.push({ path, body: label(body) });
      return { images: [png.toString('base64')] };
    },
    async postBinary(path, body) {
      calls.push({ path, body: label(body) });
      return png;
    },
  };
}

async function runCase(c) {
  const dir = mkdtempSync(join(tmpdir(), 'location-plates-golden-'));
  try {
    const location = { ...LOCATIONS[c.location], ...(c.referenceModel ? { referenceModel: c.referenceModel } : {}) };
    const series = {
      name: 'Golden', slug: 'golden', concept: '', genre: '', setting: '',
      aesthetic: c.aesthetic ?? AESTHETIC,
      characters: c.characters ?? [],
      locations: [location],
      episodes: [],
      videoDefaults: { actionModel: 'x', atmosphereModel: 'x', ...(c.editModel ? { imageDefaults: { editModel: c.editModel } } : {}) },
      ...(c.aspect ? { storyboardAspectRatio: c.aspect } : {}),
      outputDir: dir, createdAt: '', updatedAt: '',
    };
    const locDir = join(dir, 'locations', location.slug);
    mkdirSync(locDir, { recursive: true });
    for (const name of c.existing ?? []) writeFileSync(join(locDir, `${name}.png`), png);

    const calls = [];
    const log = console.log;
    const warn = console.warn;
    const lines = [];
    console.log = (...a) => lines.push(a.join(' '));
    console.warn = (...a) => lines.push(`WARN ${a.join(' ')}`);
    let result;
    try {
      result = await generateLocationReferences(fakeClient(calls, () => locDir), series, location, c.options ?? {});
    } catch (err) {
      result = { error: err.message };
    } finally {
      console.log = log;
      console.warn = warn;
    }

    const sidecars = {};
    if (existsSync(locDir)) {
      for (const f of readdirSync(locDir).filter(f => f.endsWith('.prompt.json')).sort()) {
        const { generatedAt: _, ...rest } = JSON.parse(readFileSync(join(locDir, f), 'utf-8'));
        sidecars[f] = rest;
      }
    }
    const files = (existsSync(locDir) ? readdirSync(locDir) : [])
      .map(f => f.replace(/-force-archive-\d+\.png$/, '-force-archive-<ts>.png'))
      .sort();
    return {
      result: result.error ? result : { generated: result.generated.map(p => basename(p)), skipped: result.skipped.map(p => basename(p)) },
      calls,
      sidecars,
      files,
      log: lines,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('location plate generation matches the golden', async () => {
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
