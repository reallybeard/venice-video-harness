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

import type {
  EpisodeScript,
  GenerationPlan,
  GenerationUnit,
  MontageBeat,
  SeriesState,
  ShotScript,
  VideoModelDefaults,
} from '../series/types.js';
import {
  resolveMontageMaxDurationSec,
  resolveMontageMinDurationSec,
  resolveMontageModel,
} from '../series/types.js';
import { parseShotDuration } from '../series/duration.js';
import { mustRenderAsExactLipSync } from './generation-planner.js';

// ---------------------------------------------------------------------------
// Scene grouping
// ---------------------------------------------------------------------------

/** A scene: consecutive shots sharing a location (or all untagged). */
export interface SceneGroup {
  sceneNumber: number;
  location?: string;
  shots: ShotScript[];
}

/**
 * Group an episode's shots into scenes. A scene is a maximal run of
 * consecutive shots with the same `location` tag. Untagged shots inherit the
 * running scene when they sit between same-location shots (a close-up the
 * script LLM forgot to tag), but an untagged shot after a location change
 * starts a new scene. This keeps the montage's single reference stack honest:
 * one blocking plate + one location's angles per generation (rule 21b).
 */
export function groupShotsIntoScenes(shots: ShotScript[]): SceneGroup[] {
  const scenes: SceneGroup[] = [];
  let current: SceneGroup | null = null;

  for (const shot of shots) {
    const loc = shot.location;
    const startsNewScene = !current
      || (loc !== undefined && current.location !== undefined && loc !== current.location)
      || (loc !== undefined && current.location === undefined);

    if (startsNewScene) {
      current = { sceneNumber: scenes.length + 1, location: loc, shots: [shot] };
      scenes.push(current);
      continue;
    }
    // Same location, or untagged shot continuing the current scene.
    if (current!.location === undefined && loc !== undefined) current!.location = loc;
    current!.shots.push(shot);
  }

  return scenes;
}

// ---------------------------------------------------------------------------
// Beat timing
// ---------------------------------------------------------------------------

/**
 * Lay a window of shots onto a montage timeline. Planned shot durations are
 * kept verbatim when they fit; when the window total exceeds the ceiling the
 * caller should have split it (see planMontageUnits) — this function only
 * rounds and enforces a 1s beat floor.
 */
export function layoutMontageBeats(shots: ShotScript[]): MontageBeat[] {
  const beats: MontageBeat[] = [];
  let cursor = 0;
  for (const shot of shots) {
    const dur = Math.max(1, parseShotDuration(shot.duration));
    beats.push({
      shotNumber: shot.shotNumber,
      startSec: cursor,
      endSec: cursor + dur,
    });
    cursor += dur;
  }
  return beats;
}

/** Format seconds as the vault pack's `M:SS` timestamp. */
export function formatBeatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Montage planning
// ---------------------------------------------------------------------------

function padShot(n: number): string {
  return String(n).padStart(3, '0');
}

/**
 * A shot the montage lane must NOT swallow: title cards / inserts render as
 * their own singles (they need exact framing, not montage energy), and
 * exact-lip-sync dialogue shots keep their dedicated pipeline. Everything
 * else — establishing, action, dialogue-on-native, reaction, close-up —
 * rides the montage.
 */
function shotBlocksMontage(shot: ShotScript, videoDefaults?: VideoModelDefaults): boolean {
  if (shot.mustStaySingle) return true;
  if (shot.type === 'insert') return true;
  if (/title card/i.test(shot.description)) return true;
  // Exact-lip-sync dialogue keeps its dedicated single-clip pipeline —
  // bundling it into a montage would drop the lip-sync entirely.
  if (mustRenderAsExactLipSync(shot, videoDefaults)) return true;
  return false;
}

/**
 * Split a scene's shots into montage windows under the duration ceiling.
 * Greedy fill: keep appending beats while the window total stays <= max.
 * A single shot longer than the ceiling is clamped to it with a warning
 * (Seedance 2.5 tops out at 30s).
 */
function splitSceneIntoWindows(shots: ShotScript[], maxSec: number): ShotScript[][] {
  const windows: ShotScript[][] = [];
  let window: ShotScript[] = [];
  let total = 0;
  for (const shot of shots) {
    const dur = Math.max(1, parseShotDuration(shot.duration));
    if (window.length > 0 && total + dur > maxSec) {
      windows.push(window);
      window = [];
      total = 0;
    }
    window.push(shot);
    total += dur;
  }
  if (window.length > 0) windows.push(window);
  return windows;
}

/**
 * Build a montage-first generation plan: each scene's consecutive
 * montage-eligible beats become ONE `montage` unit (up to the model ceiling,
 * default 30s on Seedance 2.5), carrying the timestamped beat map that both
 * the prompt's SEQUENCE block and the post-render cutter consume. Shots that
 * block the montage (inserts, title cards, forced singles) fall through as
 * `single` units via the fallback builder supplied by the caller.
 */
export function planMontageUnits(
  script: EpisodeScript,
  series: Pick<SeriesState, 'videoDefaults'>,
  buildSingleFallback: (shot: ShotScript, prev?: ShotScript, next?: ShotScript) => GenerationUnit,
): GenerationPlan {
  const videoDefaults: VideoModelDefaults | undefined = series.videoDefaults;
  const maxSec = resolveMontageMaxDurationSec(videoDefaults);
  const minSec = resolveMontageMinDurationSec(videoDefaults);
  const model = resolveMontageModel(videoDefaults);
  const units: GenerationUnit[] = [];
  const scenes = groupShotsIntoScenes(script.shots);

  for (const scene of scenes) {
    // Partition the scene into montage runs and blocking singles, keeping
    // script order.
    let run: ShotScript[] = [];

    const flushRun = () => {
      if (run.length === 0) return;
      for (const window of splitSceneIntoWindows(run, maxSec)) {
        const beats = layoutMontageBeats(window);
        const totalSec = beats[beats.length - 1].endSec;
        if (window.length === 1 && totalSec < minSec) {
          // Too short for the montage ladder — plain single.
          const shot = window[0];
          units.push(buildSingleFallback(shot));
          continue;
        }
        const clampedSec = Math.min(totalSec, maxSec);
        if (clampedSec !== totalSec) {
          console.warn(`  ⚠ Montage window exceeds ${maxSec}s; clamping to the model ceiling.`);
        }
        const first = window[0];
        const last = window[window.length - 1];
        units.push({
          unitId: `montage-s${String(scene.sceneNumber).padStart(2, '0')}-${padShot(first.shotNumber)}-${padShot(last.shotNumber)}`,
          unitType: 'montage',
          shotNumbers: window.map(s => s.shotNumber),
          outputFile: `montage-s${String(scene.sceneNumber).padStart(2, '0')}-${padShot(first.shotNumber)}-${padShot(last.shotNumber)}.mp4`,
          model,
          duration: `${Math.max(minSec, Math.round(clampedSec))}s`,
          startFrameStrategy: 'panel',
          endFrameStrategy: 'natural',
          decisionReasons: [
            `scene ${scene.sceneNumber}${scene.location ? ` (${scene.location})` : ''}: ${window.length}-beat single-pass montage on ${model}`,
            'timestamped SEQUENCE prompt (vault Seedance 2.5 trailer grammar); cut per-beat after render',
          ],
          fallbackToSingles: false,
          montageBeats: beats,
          sceneNumber: scene.sceneNumber,
        });
      }
      run = [];
    };

    for (const shot of scene.shots) {
      if (shotBlocksMontage(shot, videoDefaults)) {
        flushRun();
        units.push(buildSingleFallback(shot));
        continue;
      }
      run.push(shot);
    }
    flushRun();
  }

  return {
    episode: script.episode,
    generatedAt: new Date().toISOString(),
    units,
  };
}
