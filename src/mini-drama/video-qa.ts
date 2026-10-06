// ---------------------------------------------------------------------------
// Post-render video QA (`qa-videos`)
//
// Born from the canopy-run failure (2026-08-10): storyboard QA passed, every
// montage unit rendered fine in isolation, and the assembled film still had
// three different protagonists — because each generation unit re-interprets
// the character references independently, and NOTHING compared the rendered
// units to each other. Panel QA cannot catch cross-unit drift by definition:
// it runs before any video exists.
//
// This module closes that hole with two layers:
//
//   1. PROGRAMMATIC (free, always on):
//      - head-glitch scan: per-frame mean-luma deltas over each unit's first
//        second; a spike-and-revert inside the first ~10 frames is the
//        Seedance transition-junk flash that survived the beat cut.
//      - boundary luma jump: mean-luma delta across every unit join in
//        assembly order (matches cut-qa's lighting-discontinuity check).
//
//   2. VISION (per-unit sampled frames, same intelligence layer as panel QA):
//      - identity: one mid-beat frame per character-bearing shot, sent WITH
//        the character reference sheets — verdict per unit.
//      - cross-unit: the per-unit hero frames sent TOGETHER in one call —
//        "is this the same person in every frame?" This is the check that
//        would have caught canopy-run's three Wrens.
//
// The report lands next to qa-report.json as video-qa-report.json, and
// assemble-episode refuses (without --skip-video-qa) to stitch units that
// have a FLAG-CRITICAL cross-unit verdict.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { VeniceClient } from '../venice/client.js';
import type { SeriesState, EpisodeScript } from 'venice-video-harness/core/series/types.js';
import { getCharacterDir } from '../series/manager.js';
import { createCliVisionJudge } from '../ports/vision-judge.js';
import {
  HEAD_GLITCH_WINDOW_FRAMES,
  findHeadGlitch,
  midBeatSampleSec,
  type CrossUnitResult,
  type HeadGlitchFinding,
  type UnitFrameSample,
  type UnitIdentityResult,
  type VideoQaReport,
} from 'venice-video-harness/core/mini-drama/video-qa.js';
import { judgeCrossUnitIdentity, judgeUnitIdentity } from 'venice-video-harness/core/mini-drama/qa-steps.js';

export type {
  BoundaryFinding,
  CrossUnitReply,
  CrossUnitResult,
  HeadGlitchFinding,
  UnitFrameSample,
  UnitIdentityReply,
  UnitIdentityResult,
  VideoQaReport,
  VideoQaVerdict,
} from 'venice-video-harness/core/mini-drama/video-qa.js';
export {
  BOUNDARY_LUMA_FAIL,
  BOUNDARY_LUMA_WARN,
  CROSS_UNIT_SYSTEM_PROMPT,
  HEAD_GLITCH_LUMA_THRESHOLD,
  HEAD_GLITCH_WINDOW_FRAMES,
  IDENTITY_MAX_FRAMES,
  IDENTITY_MAX_REFERENCES,
  IDENTITY_SYSTEM_PROMPT,
  buildCrossUnitUserPrompt,
  buildUnitIdentityUserPrompt,
  classifyBoundary,
  crossUnitFailure,
  crossUnitFromReply,
  emptyCrossUnitResult,
  findHeadGlitch,
  midBeatSampleSec,
  pickHeroFrames,
  pickProtagonist,
  summarizeVideoQa,
  unitIdentityFailure,
  unitIdentityFromReply,
  videoQaBlocksAssembly,
} from 'venice-video-harness/core/mini-drama/video-qa.js';

// ---------------------------------------------------------------------------
// ffmpeg/ffprobe primitives
// ---------------------------------------------------------------------------

export function ffprobeDurationSec(path: string): number {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path,
  ], { encoding: 'utf-8' });
  const v = parseFloat((r.stdout || '').trim());
  return Number.isFinite(v) ? v : 0;
}

export function extractFrame(videoPath: string, atSec: number, outPath: string): boolean {
  const r = spawnSync('ffmpeg', [
    '-y', '-v', 'error', '-ss', String(atSec), '-i', videoPath,
    '-frames:v', '1', outPath,
  ], { encoding: 'utf-8' });
  return r.status === 0 && existsSync(outPath);
}

/**
 * Mean luma (YUV Y-plane average, 0-255) for each of the first `count`
 * frames of a video, via ffmpeg's signalstats filter. Returns [] on failure
 * rather than throwing — a QA scan must never kill the pipeline.
 */
export function headFrameLumas(videoPath: string, count = 24): number[] {
  const r = spawnSync('ffmpeg', [
    '-v', 'info', '-i', videoPath,
    '-vf', `select='lt(n\\,${count})',signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
    '-f', 'null', '-',
  ], { encoding: 'utf-8' });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const lumas: number[] = [];
  for (const m of out.matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)) {
    lumas.push(parseFloat(m[1]));
  }
  return lumas;
}

/**
 * Detect the Seedance head-flash in a unit master: probe the head-frame lumas
 * and classify them (`findHeadGlitch` in core).
 */
export function detectHeadGlitch(
  videoPath: string,
  unitId: string,
  options: { windowFrames?: number; threshold?: number } = {},
): HeadGlitchFinding | undefined {
  const windowFrames = options.windowFrames ?? HEAD_GLITCH_WINDOW_FRAMES;
  return findHeadGlitch(headFrameLumas(videoPath, windowFrames + 4), unitId, options);
}

/** Mean luma of a single frame image (used for boundary comparison). */
export function frameLuma(videoPath: string, atSec: number): number | undefined {
  const r = spawnSync('ffmpeg', [
    '-v', 'info', '-ss', String(atSec), '-i', videoPath,
    '-frames:v', '1',
    '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG',
    '-f', 'null', '-',
  ], { encoding: 'utf-8' });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const m = out.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
  return m ? parseFloat(m[1]) : undefined;
}

// ---------------------------------------------------------------------------
// Vision layer
// ---------------------------------------------------------------------------

/** A character's front reference sheet on disk, the image both QA layers compare against. */
export function characterFrontSheet(series: SeriesState, name: string): string | undefined {
  const front = join(getCharacterDir(series, name), 'front.png');
  return existsSync(front) ? front : undefined;
}

interface PlanUnitLike {
  unitId: string;
  outputFile: string;
  shotNumbers: number[];
  segments?: Array<{ shotNumber: number; startOffsetSec: number; durationSec: number }>;
}

/**
 * Sample one mid-beat frame per character-bearing shot of each unit.
 * Frames land in a temp dir; callers get the manifest. Synchronous ffmpeg;
 * `qa-videos` samples through core's `probeUnitFrames` over the ImageProbe
 * port instead, with the same rules.
 */
export function sampleUnitFrames(
  units: PlanUnitLike[],
  sceneDir: string,
  script: EpisodeScript,
  options: { framesDir?: string } = {},
): UnitFrameSample[] {
  const framesDir = options.framesDir ?? join(tmpdir(), `video-qa-${Date.now()}`);
  mkdirSync(framesDir, { recursive: true });
  const samples: UnitFrameSample[] = [];
  for (const unit of units) {
    const masterPath = join(sceneDir, unit.outputFile);
    if (!existsSync(masterPath)) continue;
    const duration = ffprobeDurationSec(masterPath);
    const segments = unit.segments && unit.segments.length > 0
      ? unit.segments
      : [{ shotNumber: unit.shotNumbers[0], startOffsetSec: 0, durationSec: duration }];
    for (const seg of segments) {
      const shot = script.shots.find(s => s.shotNumber === seg.shotNumber);
      if (!shot || shot.characters.length === 0) continue;
      const atSec = midBeatSampleSec(seg, duration);
      const framePath = join(framesDir, `${unit.unitId}-shot-${String(seg.shotNumber).padStart(3, '0')}.png`);
      if (extractFrame(masterPath, atSec, framePath)) {
        samples.push({ unitId: unit.unitId, shotNumber: seg.shotNumber, atSec, framePath });
      }
    }
  }
  return samples;
}

/**
 * Per-unit identity check: hero frame(s) of a unit vs the character sheets
 * (`judgeUnitIdentity` over the CLI vision judge).
 */
export async function checkUnitIdentity(
  client: VeniceClient,
  model: string,
  series: SeriesState,
  unitId: string,
  frames: UnitFrameSample[],
  characterNames: string[],
): Promise<UnitIdentityResult> {
  return judgeUnitIdentity(createCliVisionJudge(() => client), {
    model, unitId, frames, characterNames,
    characterSheet: async name => characterFrontSheet(series, name),
  });
}

/**
 * The cross-unit check — the one that would have caught canopy-run's three
 * Wrens. One hero frame per unit, all in one vision call, in film order
 * (`judgeCrossUnitIdentity` over the CLI vision judge).
 */
export async function checkCrossUnitIdentity(
  client: VeniceClient,
  model: string,
  heroFrames: UnitFrameSample[],
  protagonistName: string,
): Promise<CrossUnitResult> {
  return judgeCrossUnitIdentity(createCliVisionJudge(() => client), {
    model, heroFrames, protagonist: protagonistName,
  });
}

/** Persist the report next to qa-report.json. */
export async function saveVideoQaReport(episodeDir: string, report: VideoQaReport): Promise<string> {
  const reportPath = join(episodeDir, 'video-qa-report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  return reportPath;
}
