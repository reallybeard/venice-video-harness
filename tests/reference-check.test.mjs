// `referenceCheck` on Character / Location (plan-schema-additions §6).
//
// 1. The field round-trips through loadSeries / saveSeries unchanged, and a
//    series.json without it is left without it.
// 2. `checkCharacterReference` builds a vision call from the locked sheet +
//    description and normalises the model's JSON — exercised with a stubbed
//    client, no network.
// 3. `lock-character --check-reference` is informational: no sheet → skip,
//    no API key → warn, and the lock goes through either way. The CLI is
//    spawned with an isolated VENICE_VIDEO_CONFIG_DIR and VENICE_API_KEY
//    removed from the environment.

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadSeries, saveSeries } from '../dist/series/manager.js';
import {
  checkCharacterReference,
  resolveReferenceCheckTarget,
  formatReferenceCheck,
} from '../dist/mini-drama/reference-check.js';

const cli = new URL('../dist/mini-drama/cli.js', import.meta.url).pathname;

function baseSeries(outputDir, extra = {}) {
  return {
    name: 'Ref Check', slug: 'ref-check', concept: 'c', genre: 'g', setting: 's',
    aesthetic: null,
    characters: [{
      name: 'MARA', gender: 'female', age: '30s',
      description: 'A wiry mechanic with cropped grey hair and a burn scar on her left forearm.',
      fullDescription: 'A wiry mechanic in her thirties, cropped grey hair, a burn scar on her left forearm.',
      wardrobe: 'oil-stained coveralls', voiceDescription: 'low, dry',
      locked: false, seed: 42,
      ...extra.character,
    }],
    locations: [{
      name: 'Sietch Workshop', slug: 'sietch-workshop',
      description: 'A cramped underground workshop lit by sodium lamps.',
      seed: 7,
      ...extra.location,
    }],
    episodes: [],
    videoDefaults: { actionModel: 'a', atmosphereModel: 'b' },
    intelligence: { model: 'text-model', visionModel: 'vision-model' },
    outputDir,
    createdAt: '2026-10-05T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z',
  };
}

const stripUpdatedAt = ({ updatedAt: _u, ...rest }) => rest;

test('referenceCheck round-trips through saveSeries / loadSeries', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ref-check-rt-'));
  const check = {
    ref: 'characters/mara/front.png', pass: false,
    issues: ['hair is shoulder-length, description says cropped'],
    summary: 'Mostly matches but the hair is wrong.',
  };
  const locCheck = { ref: 'locations/sietch-workshop/north.png', pass: true, issues: [], summary: 'Matches.' };
  const series = baseSeries(outputDir, { character: { referenceCheck: check }, location: { referenceCheck: locCheck } });

  await saveSeries(series);
  const loaded = await loadSeries(outputDir);
  assert.ok(loaded);
  assert.deepEqual(loaded.characters[0].referenceCheck, check);
  assert.deepEqual(loaded.locations[0].referenceCheck, locCheck);
  assert.deepEqual(stripUpdatedAt(loaded), stripUpdatedAt(series));

  // A second save/load leaves it byte-stable apart from updatedAt.
  await saveSeries(loaded);
  const again = await loadSeries(outputDir);
  assert.deepEqual(stripUpdatedAt(again), stripUpdatedAt(loaded));
});

test('a series.json without referenceCheck stays without it', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ref-check-none-'));
  const series = baseSeries(outputDir);
  writeFileSync(join(outputDir, 'series.json'), JSON.stringify(series, null, 2));

  const loaded = await loadSeries(outputDir);
  assert.ok(loaded);
  assert.equal('referenceCheck' in loaded.characters[0], false);
  assert.equal('referenceCheck' in loaded.locations[0], false);

  await saveSeries(loaded);
  const raw = readFileSync(join(outputDir, 'series.json'), 'utf-8');
  assert.doesNotMatch(raw, /referenceCheck/);
  assert.deepEqual(stripUpdatedAt(JSON.parse(raw)), stripUpdatedAt(series));
});

test('checkCharacterReference: no sheet on disk → undefined, no call', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ref-check-nosheet-'));
  const series = baseSeries(outputDir);
  let calls = 0;
  const client = { chatJson: async () => { calls++; return { pass: true, issues: [], summary: 'x' }; } };
  assert.equal(resolveReferenceCheckTarget(series, series.characters[0]), undefined);
  assert.equal(await checkCharacterReference(client, 'vision-model', series, series.characters[0]), undefined);
  assert.equal(calls, 0);
});

test('checkCharacterReference: sends the sheet + description, normalises the verdict', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ref-check-stub-'));
  const series = baseSeries(outputDir);
  const charDir = join(outputDir, 'characters', 'mara');
  mkdirSync(charDir, { recursive: true });
  writeFileSync(join(charDir, 'front.png'), Buffer.from('not-really-a-png'));

  const seen = [];
  const client = {
    chatJson: async (opts) => {
      seen.push(opts);
      return { pass: false, issues: ['hair is shoulder-length', 42, null], summary: 'Hair mismatch.' };
    },
  };
  const result = await checkCharacterReference(client, 'vision-model', series, series.characters[0]);

  assert.deepEqual(result, {
    ref: 'characters/mara/front.png',
    pass: false,
    issues: ['hair is shoulder-length'],
    summary: 'Hair mismatch.',
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, 'vision-model');
  assert.equal(seen[0].images.length, 1);
  assert.match(seen[0].images[0], /^data:image\/png;base64,/);
  assert.match(seen[0].userPrompt, /MARA/);
  assert.match(seen[0].userPrompt, /burn scar on her left forearm/);
  assert.match(seen[0].userPrompt, /Wardrobe: oil-stained coveralls/);
  assert.match(seen[0].systemPrompt, /JSON only/);

  // anchor.png outranks front.png, same precedence as the reference slots.
  writeFileSync(join(charDir, 'anchor.png'), Buffer.from('anchor'));
  assert.equal(resolveReferenceCheckTarget(series, series.characters[0]).ref, 'characters/mara/anchor.png');

  // A malformed verdict never reads as a pass.
  const sloppy = { chatJson: async () => ({ pass: 'yes', summary: 7 }) };
  const normalised = await checkCharacterReference(sloppy, 'vision-model', series, series.characters[0]);
  assert.deepEqual(normalised, { ref: 'characters/mara/anchor.png', pass: false, issues: [], summary: '' });

  assert.match(formatReferenceCheck(result), /MISMATCH — Hair mismatch\.\n    - hair is shoulder-length/);
  assert.match(formatReferenceCheck({ ...result, pass: true, issues: [] }), /PASS/);
});

// ---------------------------------------------------------------------------
// CLI: informational, never a gate.
// ---------------------------------------------------------------------------

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'ref-check-cli-'));
  const projectDir = join(root, 'project');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'series.json'), JSON.stringify(baseSeries(projectDir), null, 2));
  return { root, projectDir, configDir: join(root, 'config') };
}

function runCli(args, configDir) {
  const env = { ...process.env, VENICE_VIDEO_CONFIG_DIR: configDir };
  delete env.VENICE_API_KEY;
  delete env.VENICE_VIDEO_WORKSPACE;
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8', env });
}

test('lock-character without --check-reference does not touch referenceCheck', () => {
  const { projectDir, configDir } = makeProject();
  const r = runCli(['lock-character', '-p', projectDir, '-c', 'MARA', '--voice-id', 'v1'], configDir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Character locked: MARA/);
  const saved = JSON.parse(readFileSync(join(projectDir, 'series.json'), 'utf-8'));
  assert.equal(saved.characters[0].locked, true);
  assert.equal('referenceCheck' in saved.characters[0], false);
  assert.equal(existsSync(join(configDir, 'config.json')), false, 'must not write a real user config');
});

test('lock-character --check-reference with no sheet skips the check and still locks', () => {
  const { projectDir, configDir } = makeProject();
  const r = runCli(['lock-character', '-p', projectDir, '-c', 'MARA', '--voice-id', 'v1', '--check-reference'], configDir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Reference check skipped: no reference sheet/);
  assert.match(r.stdout, /Character locked: MARA/);
  const saved = JSON.parse(readFileSync(join(projectDir, 'series.json'), 'utf-8'));
  assert.equal(saved.characters[0].locked, true);
  assert.equal('referenceCheck' in saved.characters[0], false);
});

test('lock-character --check-reference with a sheet but no API key warns and still locks', () => {
  const { projectDir, configDir } = makeProject();
  const charDir = join(projectDir, 'characters', 'mara');
  mkdirSync(charDir, { recursive: true });
  writeFileSync(join(charDir, 'front.png'), Buffer.from('png'));
  const r = runCli(['lock-character', '-p', projectDir, '-c', 'MARA', '--voice-id', 'v1', '--check-reference'], configDir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Reference check failed \(Venice API key is required/);
  assert.match(r.stderr, /lock continues/);
  assert.match(r.stdout, /Character locked: MARA/);
  const saved = JSON.parse(readFileSync(join(projectDir, 'series.json'), 'utf-8'));
  assert.equal(saved.characters[0].locked, true);
  assert.equal('referenceCheck' in saved.characters[0], false, 'a failed call must not record a verdict');
});
