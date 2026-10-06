// ---------------------------------------------------------------------------
// Montage-first generation (Seedance 2.5 branch, 2026-08-07)
//
// Seedance 2.5 renders up to 30 seconds in a single pass with up to 30 image
// references, which flips the harness default: instead of one generation per
// shot (or a 15s multi-shot bundle), a whole SCENE of consecutive beats
// renders as ONE "montage" generation prompted with a timestamped SEQUENCE
// beat list — the grammar demonstrated in the vault's "Make a full trailer
// with Seedance 2.5" prompt pack:
//
//   SHOT: "<scene intent>" — a 30-second fast-cut montage, cut it yourself
//   in the edit.
//   REFERENCES: @Image1 = THE DRIVER (wardrobe locked) ...
//   SEQUENCE:
//   [0:00-0:03] extreme wide, high and still — ...
//   [0:03-0:05] macro on the ignition — ...
//   STYLE: <one style token, pasted identical into every prompt>
//
// The four rules baked into every montage prompt (per the vault pack):
//   1. No music — diegetic sound only, described per beat; music is added
//      in the edit.
//   2. "Face stable throughout, no deformation." in every prompt.
//   3. @Image discipline — every reference is a named role; never cite an
//      image that is not attached.
//   4. Negative prompts stay short.
//
// After the render, `cutMontageIntoShots` slices the clip at the SAME beat
// timestamps that were written into the prompt (a single source of truth on
// GenerationUnit.montageBeats), producing per-shot clips that are:
//   - written next to the panels as canonical `shot-NNN.mp4` files, AND
//   - organized into the episode's media library at
//     `media-library/scene-NN/shot-NNN.mp4` (plus the uncut master),
// so a human or the Venice Video Creator can cut by hand when
// `videoDefaults.autoEdit` is off, while `assemble-episode` picks the same
// canonical files up automatically when auto-edit is on.
// ---------------------------------------------------------------------------

import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type {
  GenerationUnit,
  GenerationUnitSegment,
  ShotScript,
} from 'venice-video-harness/core/series/types.js';
import { shotKey } from './shot-paths.js';

// Scene grouping, beat timing and montage planning are pure and live in core;
// this module keeps the post-render cutter and re-exports the rest.
export {
  formatBeatTimestamp,
  groupShotsIntoScenes,
  layoutMontageBeats,
  planMontageUnits,
} from 'venice-video-harness/core/mini-drama/montage.js';
export type { SceneGroup } from 'venice-video-harness/core/mini-drama/montage.js';

// ---------------------------------------------------------------------------
// Post-render cutting + media library
// ---------------------------------------------------------------------------

function ffprobeDuration(path: string): number {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path,
  ], { encoding: 'utf-8' });
  const v = parseFloat((r.stdout || '').trim());
  return Number.isFinite(v) ? v : 0;
}

function ffmpegCut(sourcePath: string, startSec: number, durationSec: number, outputPath: string): void {
  // Re-encode (not stream copy) so every cut is frame-accurate at the beat
  // boundary — a montage's whole point is that cuts land exactly where the
  // SEQUENCE block said they would. Same codec settings as the multi-shot
  // splitter so downstream concat never hits a mismatch.
  const r = spawnSync('ffmpeg', [
    '-y',
    '-ss', String(startSec),
    '-i', sourcePath,
    '-t', String(durationSec),
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k',
    outputPath,
  ], { encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(`ffmpeg cut failed for ${outputPath}: ${r.stderr?.slice(-400)}`);
  }
}

export interface MontageCutResult {
  /** Canonical per-shot clips (`<sceneDir>/shot-NNN.mp4`), for the assembler. */
  shotPaths: string[];
  /** Media-library copies (`media-library/scene-NN/shot-NNN.mp4`). */
  libraryPaths: string[];
  segments: GenerationUnitSegment[];
}

/**
 * Cut a rendered montage at its planned beat boundaries.
 *
 * The beat map is scaled to the ACTUAL rendered duration (Seedance can come
 * back a hair short or long of the requested window) so the last beat never
 * runs off the end and the proportions the prompt asked for are preserved.
 *
 * Every shot is written twice:
 *   1. `<sceneDir>/shot-NNN.mp4` — the canonical path every downstream step
 *      (assemble-episode, subtitles, QA) already reads.
 *   2. `<episodeDir>/media-library/scene-NN/shot-NNN.mp4` — the organized
 *      library for hand editing / the Venice Video Creator, alongside the
 *      uncut montage master and a `manifest.json` describing each cut.
 */
export function cutMontageIntoShots(options: {
  montagePath: string;
  unit: GenerationUnit;
  shotsByNumber: Map<number, ShotScript>;
  sceneDir: string;
  episodeDir: string;
  archiveExisting: (path: string) => void;
}): MontageCutResult {
  const { montagePath, unit, shotsByNumber, sceneDir, episodeDir, archiveExisting } = options;
  const beats = unit.montageBeats ?? [];
  if (beats.length === 0) {
    throw new Error(`Montage unit ${unit.unitId} has no beat map — cannot cut.`);
  }

  const renderedSec = ffprobeDuration(montagePath);
  const plannedSec = beats[beats.length - 1].endSec;
  const scale = plannedSec > 0 && renderedSec > 0 ? renderedSec / plannedSec : 1;
  if (Math.abs(scale - 1) > 0.05) {
    console.warn(`  ⚠ ${unit.unitId}: rendered ${renderedSec.toFixed(2)}s vs planned ${plannedSec}s — scaling beat map by ${scale.toFixed(3)}.`);
  }

  const sceneNumber = unit.sceneNumber ?? 1;
  const libraryDir = join(episodeDir, 'media-library', `scene-${String(sceneNumber).padStart(2, '0')}`);
  mkdirSync(libraryDir, { recursive: true });

  const shotPaths: string[] = [];
  const libraryPaths: string[] = [];
  const segments: GenerationUnitSegment[] = [];

  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    const isLast = i === beats.length - 1;
    const start = beat.startSec * scale;
    const end = isLast ? renderedSec : beat.endSec * scale;
    const dur = Math.max(0.1, end - start);
    const key = shotKey(beat.shotNumber);

    const canonicalPath = join(sceneDir, `shot-${key}.mp4`);
    archiveExisting(canonicalPath);
    ffmpegCut(montagePath, start, dur, canonicalPath);
    shotPaths.push(canonicalPath);

    const libraryPath = join(libraryDir, `shot-${key}.mp4`);
    copyFileSync(canonicalPath, libraryPath);
    libraryPaths.push(libraryPath);

    segments.push({
      shotNumber: beat.shotNumber,
      startOffsetSec: Number(start.toFixed(3)),
      durationSec: Number(dur.toFixed(3)),
      outputFile: `shot-${key}.mp4`,
    });
  }

  // The uncut master rides along in the library so an editor can pull
  // alternate frames around the planned cut points.
  const masterLibraryPath = join(libraryDir, unit.outputFile);
  copyFileSync(montagePath, masterLibraryPath);

  const manifest = {
    unitId: unit.unitId,
    scene: sceneNumber,
    model: unit.model,
    master: unit.outputFile,
    renderedDurationSec: Number(renderedSec.toFixed(3)),
    plannedDurationSec: plannedSec,
    beatScale: Number(scale.toFixed(4)),
    cuts: segments.map(seg => {
      const shot = shotsByNumber.get(seg.shotNumber);
      return {
        shot: shotKey(seg.shotNumber),
        file: seg.outputFile,
        startSec: seg.startOffsetSec,
        durationSec: seg.durationSec,
        type: shot?.type,
        description: shot?.description,
      };
    }),
  };
  writeFileSync(join(libraryDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  return { shotPaths, libraryPaths, segments };
}
