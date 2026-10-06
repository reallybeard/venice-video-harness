// Music-cue planning moved into core so a host can place cues and build the
// `volume=` automation without ffmpeg; src/mini-drama/music-cues.ts keeps the
// renderer and re-exports the planning names so its importers are unchanged.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as core from '../packages/core/dist/mini-drama/music-cues.js';
import * as barrel from '../packages/core/dist/index.js';
import * as cli from '../dist/mini-drama/music-cues.js';

const MOVED = ['shotIdKey', 'resolveCueWindow', 'buildGainStopsExpr', 'buildMusicHoldExpr'];

test('the CLI module and the core barrel re-export the core functions themselves', () => {
  for (const name of MOVED) {
    assert.equal(typeof core[name], 'function', name);
    assert.equal(cli[name], core[name], `cli ${name}`);
    assert.equal(barrel[name], core[name], `barrel ${name}`);
  }
  assert.equal(typeof cli.renderMusicCuesTrack, 'function');
  assert.equal(typeof cli.applyMusicHoldAutomation, 'function');
  assert.equal(typeof cli.resolveMusicCues, 'function');
  assert.equal(core.renderMusicCuesTrack, undefined);
  assert.equal(core.resolveMusicCues, undefined);
});

test('shotIdKey pads numeric ids and keeps insert suffixes', () => {
  assert.equal(core.shotIdKey(3), '003');
  assert.equal(core.shotIdKey('3b'), '003b');
  assert.equal(core.shotIdKey('012'), '012');
  assert.equal(core.shotIdKey('intro'), 'intro');
});

const placement = {
  '001': { startSec: 0, endSec: 5 },
  '002': { startSec: 5, endSec: 12 },
  '002b': { startSec: 12, endSec: 15 },
  '003': { startSec: 15, endSec: 20 },
};

test('resolveCueWindow spans the start shot start to the end shot end, null when either is missing', () => {
  assert.deepEqual(core.resolveCueWindow({ startShot: 1, endShot: '2b' }, placement), { startSec: 0, endSec: 15 });
  assert.equal(core.resolveCueWindow({ startShot: 1, endShot: 9 }, placement), null);
});

test('buildMusicHoldExpr nests stinger / swell / drop windows over unity, null when all sustain', () => {
  assert.equal(core.buildMusicHoldExpr([{ shotNumber: 1, musicHold: 'sustain' }, { shotNumber: 2 }], placement), null);
  assert.equal(
    core.buildMusicHoldExpr([
      { shotNumber: 1, musicHold: 'stinger' },
      { shotNumber: 2, musicHold: 'swell' },
      { shotNumber: 3, musicHold: 'drop' },
      { shotNumber: 9, musicHold: 'drop' },
    ], placement),
    'if(between(t,0.000,0.400),2.0,'
      + 'if(between(t,5.000,12.000),1.0+(0.58*(t-5.000)/7.000),'
      + 'if(between(t,15.000,20.000),0.001,'
      + '1)))',
  );
});

test('the cue defaults are exported from core', () => {
  assert.equal(core.DEFAULT_GAIN_DB, -22);
  assert.equal(core.DEFAULT_FADE_IN, 1.0);
  assert.equal(core.DEFAULT_FADE_OUT, 1.5);
});
