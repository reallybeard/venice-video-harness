// ---------------------------------------------------------------------------
// Per-act music cues: the planning half.
//
// Cue placement against a shot placement map, and the ffmpeg `volume=`
// expressions for gainStops[] and per-shot musicHold automation. Plain data
// in, strings out; nothing here runs ffmpeg or touches the filesystem. The
// renderer (`renderMusicCuesTrack`, `applyMusicHoldAutomation`) and the
// on-disk cue resolution (`resolveMusicCues`) stay in
// `src/mini-drama/music-cues.ts`.
// ---------------------------------------------------------------------------

import type { MusicCueSpec, ShotScript } from '../series/types.js';

export const DEFAULT_GAIN_DB = -22;
export const DEFAULT_FADE_IN = 1.0;
export const DEFAULT_FADE_OUT = 1.5;

/** A cue annotated with its resolved timeline window. */
export interface ResolvedMusicCue {
  spec: MusicCueSpec;
  /** Source audio file, after generation / passthrough. */
  audioPath: string;
  startSec: number;
  endSec: number;
}

export interface PlacementMap {
  /** Shot id (string, zero-padded for numeric shots like "003" / "003b"). */
  [shotId: string]: { startSec: number; endSec: number };
}

/** Normalize a shot id (number or string) to a string key. */
export function shotIdKey(id: number | string): string {
  if (typeof id === 'number') return String(id).padStart(3, '0');
  // Suffixed forms like "3b" -> "003b". Suffix letters preserved as-is.
  const match = id.match(/^(\d+)([a-zA-Z]*)$/);
  if (match) return String(match[1]).padStart(3, '0') + match[2];
  return id;
}

/**
 * Resolve a cue's timeline window from the placement map.
 * Returns null when the start or end shot can't be found — callers should
 * warn and skip the cue rather than emit a misaligned cue.
 */
export function resolveCueWindow(
  cue: MusicCueSpec,
  placementMap: PlacementMap,
): { startSec: number; endSec: number } | null {
  const startKey = shotIdKey(cue.startShot);
  const endKey = shotIdKey(cue.endShot);
  const start = placementMap[startKey];
  const end = placementMap[endKey];
  if (!start || !end) return null;
  return { startSec: start.startSec, endSec: end.endSec };
}

/**
 * Build a single ffmpeg `volume=` expression that ramps gain through a cue's
 * `gainStops[]`. Stops are ordered along the timeline and produce a smooth
 * piecewise-linear curve.
 *
 * The expression evaluates `t` (timeline seconds) and returns a linear gain
 * multiplier. Callers should pass the result with `volume=<expr>:eval=frame`.
 *
 * Returns null when the cue has no stops or none of them resolve to the
 * placement map.
 */
export function buildGainStopsExpr(
  cue: ResolvedMusicCue,
  placementMap: PlacementMap,
): string | null {
  const stops = cue.spec.gainStops;
  if (!stops || stops.length === 0) return null;
  const baseDb = cue.spec.gain ?? DEFAULT_GAIN_DB;
  const baseGain = Math.pow(10, baseDb / 20);
  type Stop = { t: number; gain: number; rampSec: number };
  const resolved: Stop[] = [];
  for (const s of stops) {
    const placement = placementMap[shotIdKey(s.atShot)];
    if (!placement) {
      console.warn(`  music-cue: gain stop atShot=${s.atShot} not in placement map; skipping`);
      continue;
    }
    if (placement.startSec < cue.startSec || placement.startSec > cue.endSec) {
      console.warn(`  music-cue: gain stop atShot=${s.atShot} is outside cue window; skipping`);
      continue;
    }
    resolved.push({
      t: placement.startSec,
      gain: Math.pow(10, s.gainDb / 20),
      rampSec: s.rampSec ?? 2.0,
    });
  }
  if (resolved.length === 0) return null;
  resolved.sort((a, b) => a.t - b.t);

  // Build a nested piecewise expression:
  //   t < t1 - r1/2          -> baseGain
  //   t1-r1/2 .. t1+r1/2     -> linear ramp baseGain -> g1
  //   t1+r1/2 .. t2-r2/2     -> g1
  //   t2-r2/2 .. t2+r2/2     -> linear ramp g1 -> g2
  //   ...                    -> gN
  let prevGain = baseGain;
  let expr = `${baseGain.toFixed(6)}`;
  for (const s of resolved) {
    const rampStart = (s.t - s.rampSec / 2).toFixed(3);
    const rampEnd = (s.t + s.rampSec / 2).toFixed(3);
    const ramp = `(${prevGain.toFixed(6)}+(${s.gain.toFixed(6)}-${prevGain.toFixed(6)})*(t-${rampStart})/${s.rampSec.toFixed(3)})`;
    expr = `if(lt(t,${rampStart}),${expr},if(lt(t,${rampEnd}),${ramp},${s.gain.toFixed(6)}))`;
    prevGain = s.gain;
  }
  return expr;
}

/**
 * derive a per-shot volume curve for music automation.
 *
 * Combines `shot.musicHold` with the containing cue's `musicHold` and
 * returns an ffmpeg `volume=` expression suitable for layering over the
 * already-rendered cues track. Returns `null` when no automation is needed
 * (everything is sustain).
 *
 * The expression evaluates `t` (timeline seconds) and produces a multiplier
 * in [0, 4] — 1.0 is unity, sub-1 ducks, super-1 swells.
 *
 *   stinger: 0.4s pulse +6 dB at the start of the shot, return to 1.0
 *   swell:   linear ramp from 1.0 to 1.58 (+4 dB) across the shot
 *   drop:    constant 0.001 (≈ -60 dB) for the shot's duration
 *   sustain: no change
 */
export function buildMusicHoldExpr(
  shots: ShotScript[],
  placementMap: PlacementMap,
): string | null {
  const pieces: string[] = [];
  for (const shot of shots) {
    const hold = shot.musicHold;
    if (!hold || hold === 'sustain') continue;
    const placement = placementMap[shotIdKey(shot.shotNumber)];
    if (!placement) continue;
    const { startSec, endSec } = placement;
    if (hold === 'stinger') {
      pieces.push(`if(between(t,${startSec.toFixed(3)},${(startSec + 0.4).toFixed(3)}),2.0,`);
      pieces.push(')'); // close the if — placeholder; we wrap below.
    } else if (hold === 'swell') {
      // 1.0 -> 1.58 across the shot
      pieces.push(
        `if(between(t,${startSec.toFixed(3)},${endSec.toFixed(3)}),` +
        `1.0+(0.58*(t-${startSec.toFixed(3)})/${(endSec - startSec).toFixed(3)}),`,
      );
      pieces.push(')');
    } else if (hold === 'drop') {
      pieces.push(`if(between(t,${startSec.toFixed(3)},${endSec.toFixed(3)}),0.001,`);
      pieces.push(')');
    }
  }
  if (pieces.length === 0) return null;
  // Nest the if-expressions with `1` (sustain) as the innermost else.
  const opens = pieces.filter(p => p !== ')');
  const closes = pieces.filter(p => p === ')').length;
  return opens.join('') + '1' + ')'.repeat(closes);
}
