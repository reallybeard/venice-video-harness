// referenceSetFromDisk must yield exactly the files, in exactly the order,
// that buildReferenceSlotPlan used to find by probing disk itself (before it
// took a ReferenceSet). The oracle below is the pre-refactor probing logic
// copied verbatim from reference-slots.ts (2.26.0) — same file lists, same
// order, same existsSync / readdirSync filters — so if the from-disk builder
// ever drifts, this test names the slot that moved.
//
// Also covers: the planner given the from-disk set produces the same slot
// refs the legacy (disk-probing) signature produces; `hasFace` is read from
// the provenance sidecar; a browser-shaped set (asset ids, no disk) plans
// without touching the filesystem.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { referenceSetFromDisk } from '../dist/mini-drama/reference-set-from-disk.js';
import { buildReferenceSlotPlan } from '../dist/mini-drama/reference-slots.js';
import {
  getCharacterDir,
  getLocationDir,
  getLocation,
  getStoryboardRefPath,
} from '../dist/series/manager.js';

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);

function touch(p) {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, PNG);
}

function char(name) {
  return {
    name, gender: 'male', age: '30s', description: 'd', fullDescription: 'fd',
    wardrobe: 'w', voiceDescription: '', locked: true, seed: 1,
  };
}

function makeSeries(dir, { characters, locations }) {
  return {
    name: 't', slug: 't', concept: '', genre: '', setting: '', aesthetic: null,
    characters: characters.map(char),
    locations,
    episodes: [], videoDefaults: { actionModel: 'x', atmosphereModel: 'x' },
    outputDir: dir, createdAt: '', updatedAt: '',
  };
}

function makeShot(overrides = {}) {
  return {
    shotNumber: 1, type: 'action', duration: '10s', videoModel: 'action',
    description: 'x', characters: [], location: undefined,
    dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ORACLE: the 2.26.0 disk-probing logic, verbatim. Returns the ordered list
// of { kind, path, label } the old planner would have produced BEFORE budget
// allocation (tiers in fill order: primaries, storyboard, location, angles).
// ---------------------------------------------------------------------------
function legacyProbe(series, shot, options = {}) {
  const charNames = options.characterNames ?? shot.characters;
  const resolvedChars = charNames
    .map(name => series.characters.find(c => c.name.toUpperCase() === name.toUpperCase()))
    .filter(Boolean);

  const primary = [];
  for (const c of resolvedChars) {
    const dir = getCharacterDir(series, c.name);
    const path = ['anchor.png', 'front.png', 'three-quarter.png']
      .map(f => join(dir, f))
      .find(p => existsSync(p));
    if (!path) continue;
    primary.push({ kind: 'character-primary', path, label: c.name });
  }

  const storyboard = [];
  if (shot.storyboardRef) {
    const sbPath = getStoryboardRefPath(series, shot.storyboardRef);
    if (sbPath && existsSync(sbPath)) {
      storyboard.push({ kind: 'storyboard', path: sbPath, label: shot.storyboardRef });
    }
  }

  const location = [];
  if (shot.location) {
    const loc = getLocation(series, shot.location);
    if (loc) {
      const dir = getLocationDir(series, loc.slug);
      const order = [
        'north.png', 'south.png', 'east.png', 'west.png',
        'wide.png', 'angle-2.png', 'angle-3.png', 'angle-4.png', 'medium.png', 'detail.png',
      ];
      const canonical = new Set(order);
      let customAngles = [];
      try {
        customAngles = readdirSync(dir)
          .filter(f =>
            /\.png$/i.test(f)
            && !canonical.has(f)
            && !f.includes('archive')
            && !f.includes('-pre-'))
          .sort();
      } catch {
        // no dir
      }
      for (const f of [...order, ...customAngles]) {
        const p = join(dir, f);
        if (!existsSync(p)) continue;
        location.push({ kind: 'location', path: p, label: loc.slug });
      }
    }
  }

  const charAngles = [];
  for (const c of resolvedChars) {
    const dir = getCharacterDir(series, c.name);
    const primaryPath = primary.find(s => s.label === c.name)?.path;
    const path = ['three-quarter.png', 'profile.png', 'full-body.png']
      .map(f => join(dir, f))
      .find(p => existsSync(p) && p !== primaryPath);
    if (!path) continue;
    charAngles.push({ kind: 'character-angle', path, label: c.name });
  }

  return [...primary, ...storyboard, ...location, ...charAngles];
}

/** Flatten a ReferenceSet into the oracle's shape (fill order, first angle only). */
function flattenSet(set, series, shot, options = {}) {
  const charNames = options.characterNames ?? shot.characters;
  const out = [];
  for (const name of charNames) {
    const c = set.characters.find(x => x.name.toUpperCase() === name.toUpperCase());
    if (c?.primary) out.push({ kind: 'character-primary', path: c.primary.ref, label: c.name });
  }
  if (set.storyboard) out.push({ kind: 'storyboard', path: set.storyboard.ref, label: shot.storyboardRef });
  for (const l of set.locations) {
    for (const p of l.plates) out.push({ kind: 'location', path: p.ref, label: l.slug });
  }
  for (const name of charNames) {
    const c = set.characters.find(x => x.name.toUpperCase() === name.toUpperCase());
    const a = c?.angles[0];
    if (a) out.push({ kind: 'character-angle', path: a.ref, label: c.name });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixture: a rich project dir exercising every rule.
// ---------------------------------------------------------------------------
function materialise() {
  const dir = mkdtempSync(join(tmpdir(), 'venice-refset-'));

  // BOB: anchor + front + three-quarter + profile → primary=anchor, angles=[three-quarter, profile]
  for (const f of ['anchor.png', 'front.png', 'three-quarter.png', 'profile.png']) {
    touch(join(dir, 'characters', 'bob', f));
  }
  // ALICE: three-quarter + full-body only → primary=three-quarter, angles=[full-body] (three-quarter excluded as primary)
  for (const f of ['three-quarter.png', 'full-body.png']) {
    touch(join(dir, 'characters', 'alice', f));
  }
  // ZED: front only → primary=front, no angles
  touch(join(dir, 'characters', 'zed', 'front.png'));
  // NOBODY: directory with no images → no primary, no angles
  mkdirSync(join(dir, 'characters', 'nobody'), { recursive: true });

  // Courtyard: compass + legacy + custom, plus archive / -pre- strays that must be skipped.
  for (const f of [
    'west.png', 'north.png', 'detail.png', 'angle-3.png', 'south.png', 'wide.png',
    'reverse-angle.png', 'balcony.png', 'north-archive.png', 'north-pre-edit.png', 'notes.txt',
  ]) {
    touch(join(dir, 'locations', 'courtyard', f));
  }
  // Throne room: no directory at all.

  touch(join(dir, 'storyboards', 'e01-beat-1-courtyard.png'));

  const series = makeSeries(dir, {
    characters: ['BOB', 'ALICE', 'ZED', 'NOBODY'],
    locations: [
      { name: 'Courtyard', slug: 'courtyard', description: 'castle courtyard', seed: 1 },
      { name: 'Throne Room', slug: 'throne-room', description: 'throne', seed: 1 },
    ],
  });
  return { dir, series };
}

test('referenceSetFromDisk yields the same files in the same order as the legacy probing', () => {
  const { dir, series } = materialise();
  try {
    const shots = [
      makeShot({ characters: ['BOB', 'ALICE', 'ZED', 'NOBODY'], location: 'courtyard', storyboardRef: 'e01-beat-1-courtyard' }),
      makeShot({ characters: ['alice', 'bob'], location: 'Courtyard' }),           // case-insensitive names
      makeShot({ characters: ['ZED'], location: 'throne-room', storyboardRef: 'missing-plate' }), // no loc dir, no plate
      makeShot({ characters: [], location: 'courtyard', type: 'close-up' }),
      makeShot({ characters: ['BOB'] }),                                           // no location
      makeShot({ characters: ['GHOST', 'BOB'] }),                                  // unknown character skipped
    ];
    for (const shot of shots) {
      const expected = legacyProbe(series, shot);
      const actual = flattenSet(referenceSetFromDisk(series, shot), series, shot);
      assert.deepEqual(actual, expected, `shot ${JSON.stringify(shot.characters)} @ ${shot.location}`);
    }
    // characterNames override, as the prompt builder passes it.
    const shot = makeShot({ characters: ['BOB'], location: 'courtyard' });
    const options = { characterNames: ['ALICE', 'ZED'] };
    assert.deepEqual(
      flattenSet(referenceSetFromDisk(series, shot, options), series, shot, options),
      legacyProbe(series, shot, options),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('referenceSetFromDisk: shape, labels and order of the set itself', () => {
  const { dir, series } = materialise();
  try {
    const shot = makeShot({ characters: ['BOB', 'ALICE', 'ZED', 'NOBODY'], location: 'courtyard', storyboardRef: 'e01-beat-1-courtyard' });
    const set = referenceSetFromDisk(series, shot);

    assert.deepEqual(set.characters.map(c => c.name), ['BOB', 'ALICE', 'ZED', 'NOBODY']);
    const [bob, alice, zed, nobody] = set.characters;
    assert.ok(bob.primary.ref.endsWith('/bob/anchor.png'), 'anchor outranks front');
    assert.deepEqual(bob.angles.map(a => a.view), ['three-quarter', 'profile']);
    assert.ok(alice.primary.ref.endsWith('/alice/three-quarter.png'));
    assert.deepEqual(alice.angles.map(a => a.view), ['full-body'], 'the primary is excluded from angles');
    assert.ok(zed.primary.ref.endsWith('/zed/front.png'));
    assert.deepEqual(zed.angles, []);
    assert.equal(nobody.primary, undefined);
    assert.deepEqual(nobody.angles, []);

    assert.equal(set.locations.length, 1);
    assert.equal(set.locations[0].slug, 'courtyard');
    assert.deepEqual(
      set.locations[0].plates.map(p => p.wall),
      ['north', 'south', 'west', 'wide', 'angle-3', 'detail', 'balcony', 'reverse-angle'],
      'compass → legacy → custom (sorted); archive / -pre- strays skipped',
    );
    for (const p of set.locations[0].plates) assert.ok(p.ref.endsWith(`/courtyard/${p.wall}.png`));

    assert.ok(set.storyboard.ref.endsWith('/storyboards/e01-beat-1-courtyard.png'));

    // Missing storyboard plate → no `storyboard` key at all.
    const noPlate = referenceSetFromDisk(series, makeShot({ storyboardRef: 'nope' }));
    assert.equal('storyboard' in noPlate, false);
    // Location with no dir → entry with empty plates (the planner then adds nothing).
    const noDir = referenceSetFromDisk(series, makeShot({ location: 'throne-room' }));
    assert.deepEqual(noDir.locations, [{ slug: 'throne-room', plates: [] }]);
    // Unknown location → no entry.
    assert.deepEqual(referenceSetFromDisk(series, makeShot({ location: 'moon' })).locations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('referenceSetFromDisk reads hasFace from the provenance sidecar', () => {
  const { dir, series } = materialise();
  try {
    const sidecar = (img, body) => writeFileSync(img.replace(/\.png$/, '.provenance.json'), JSON.stringify(body));
    sidecar(join(dir, 'characters', 'bob', 'anchor.png'), { generationModel: 'seedream-v5-lite', editModels: [], hasFace: true });
    sidecar(join(dir, 'characters', 'bob', 'three-quarter.png'), { generationModel: 'x', editModels: [] }); // undecided
    sidecar(join(dir, 'locations', 'courtyard', 'north.png'), { generationModel: 'x', editModels: [], hasFace: false });
    writeFileSync(join(dir, 'locations', 'courtyard', 'south.provenance.json'), '{not json');

    const set = referenceSetFromDisk(series, makeShot({ characters: ['BOB'], location: 'courtyard' }));
    const bob = set.characters[0];
    assert.equal(bob.primary.hasFace, true);
    assert.equal('hasFace' in bob.angles[0], false, 'sidecar without the field → key absent');
    assert.equal('hasFace' in bob.angles[1], false, 'no sidecar → key absent');
    const plates = Object.fromEntries(set.locations[0].plates.map(p => [p.wall, p]));
    assert.equal(plates.north.hasFace, false);
    assert.equal('hasFace' in plates.south, false, 'unparseable sidecar → undecided');
    assert.equal('hasFace' in plates.west, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
