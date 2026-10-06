// ---------------------------------------------------------------------------
// Per-act music cues with ffmpeg crossfades.
//
// Replaces the assembler's single-static-bed model with an ordered list of
// cues, each anchored to a shot id. Cues crossfade at their configured fade
// points so beats can change with the story: bed → ominous → bed → climactic.
//
// Per-shot musicHold (sustain / swell / drop / stinger) layers automation on
// top of the cue: volume ramps, sidechain ducks, transient stingers.
//
// This module is pure orchestration — it shells ffmpeg via execFile but does
// not know how to call Venice. Cue audio is either supplied via
// `cue.audioPath` or rendered separately and the path threaded in by the
// caller (see the music-cue reference scripts). Cue placement and the
// `volume=` expressions live in core (`venice-video-harness/core/
// mini-drama/music-cues.js`) and are re-exported here.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { MusicCueSpec } from 'venice-video-harness/core/series/types.js';
import {
  DEFAULT_GAIN_DB,
  DEFAULT_FADE_IN,
  DEFAULT_FADE_OUT,
  buildGainStopsExpr,
  resolveCueWindow,
  shotIdKey,
  type PlacementMap,
  type ResolvedMusicCue,
} from 'venice-video-harness/core/mini-drama/music-cues.js';

export {
  shotIdKey,
  resolveCueWindow,
  buildGainStopsExpr,
  buildMusicHoldExpr,
} from 'venice-video-harness/core/mini-drama/music-cues.js';
export type { PlacementMap, ResolvedMusicCue } from 'venice-video-harness/core/mini-drama/music-cues.js';

const execFileAsync = promisify(execFile);

/**
 * Assemble a list of resolved cues into a single MP3 track with crossfades.
 *
 * For each cue:
 *   - trim/pad to the resolved window length,
 *   - apply gain and fade-in / fade-out,
 *   - acrossfade with the previous track at the trailing fade point.
 *
 * The output sample rate is fixed at 48000 Hz / stereo for compatibility
 * with the assembler's final aac encode.
 */
export async function renderMusicCuesTrack(opts: {
  cues: ResolvedMusicCue[];
  outputPath: string;
  totalDurationSec: number;
  /**
   * Placement map used to resolve `gainStops[].atShot`. Optional — when
   * omitted, gain stops are skipped (cues still honour the base `gain`).
   */
  placementMap?: PlacementMap;
}): Promise<string> {
  if (opts.cues.length === 0) {
    throw new Error('renderMusicCuesTrack: at least one cue is required');
  }
  await mkdir(dirname(opts.outputPath), { recursive: true });

  // For a single cue, just gain + fade + write.
  if (opts.cues.length === 1) {
    const cue = opts.cues[0];
    const dur = cue.endSec - cue.startSec;
    const gain = cue.spec.gain ?? DEFAULT_GAIN_DB;
    const fadeIn = cue.spec.fadeIn ?? DEFAULT_FADE_IN;
    const fadeOut = cue.spec.fadeOut ?? DEFAULT_FADE_OUT;
    // gainStops[] runs in cue-local time, so build the expression then offset
    // its `t` by the cue's start. Easier: render the base bed without
    // gainStops, then apply the expression on the final track (which is
    // already in timeline time).
    const filter = [
      `volume=${gain}dB`,
      `afade=t=in:st=0:d=${fadeIn}`,
      `afade=t=out:st=${Math.max(0, dur - fadeOut)}:d=${fadeOut}`,
    ].join(',');
    await execFileAsync('ffmpeg', [
      '-y',
      '-i', cue.audioPath,
      '-af', filter,
      '-t', String(dur),
      '-ar', '48000',
      '-ac', '2',
      opts.outputPath,
    ]);
    // gainStops: the expression evaluates against timeline t. By convention
    // cue 1 begins at timeline t=0 (the music bed aligns to the first shot),
    // so the rendered mp3's local time axis matches the timeline. For
    // single-cue renderings that begin later, callers should pre-pad the
    // bed (out of scope here).
    if (opts.placementMap) {
      const stopsExpr = buildGainStopsExpr(cue, opts.placementMap);
      if (stopsExpr) {
        const tmp = opts.outputPath.replace(/\.mp3$/, '-gainstops.mp3');
        await execFileAsync('ffmpeg', [
          '-y',
          '-i', opts.outputPath,
          '-af', `volume='${stopsExpr}':eval=frame`,
          '-ar', '48000',
          '-ac', '2',
          tmp,
        ]);
        const { rename } = await import('node:fs/promises');
        await rename(tmp, opts.outputPath);
      }
    }
    return opts.outputPath;
  }

  // Multi-cue path: build a concat-with-crossfade filter graph.
  const inputs: string[] = [];
  for (const cue of opts.cues) {
    inputs.push('-i', cue.audioPath);
  }

  // Build per-input filter chains, then chain acrossfade between them.
  const filterParts: string[] = [];
  for (let i = 0; i < opts.cues.length; i++) {
    const cue = opts.cues[i];
    const dur = cue.endSec - cue.startSec;
    const gain = cue.spec.gain ?? DEFAULT_GAIN_DB;
    const fadeIn = cue.spec.fadeIn ?? DEFAULT_FADE_IN;
    // Trim/pad to window length, apply gain. Inner fade-in only — the
    // crossfade handles outgoing edges. The very first cue gets a fade-in,
    // the very last cue gets a fade-out.
    const chain: string[] = [`atrim=0:${dur}`, `asetpts=N/SR/TB`, `volume=${gain}dB`];
    if (i === 0) chain.push(`afade=t=in:st=0:d=${fadeIn}`);
    if (i === opts.cues.length - 1) {
      const fadeOut = cue.spec.fadeOut ?? DEFAULT_FADE_OUT;
      chain.push(`afade=t=out:st=${Math.max(0, dur - fadeOut)}:d=${fadeOut}`);
    }
    filterParts.push(`[${i}:a]${chain.join(',')}[a${i}]`);
  }

  // Chain acrossfade: [a0][a1]acrossfade=d=X[ax1]; [ax1][a2]acrossfade=d=Y[ax2]; ...
  let prevLabel = '[a0]';
  for (let i = 1; i < opts.cues.length; i++) {
    // Crossfade duration is the min of the trailing fadeOut on the previous
    // cue and the leading fadeIn on the next cue — this is the overlap region
    // both cues already attenuate.
    const prev = opts.cues[i - 1].spec;
    const next = opts.cues[i].spec;
    const xfade = Math.min(
      prev.fadeOut ?? DEFAULT_FADE_OUT,
      next.fadeIn ?? DEFAULT_FADE_IN,
    );
    const outLabel = i === opts.cues.length - 1 ? '[aout]' : `[ax${i}]`;
    filterParts.push(`${prevLabel}[a${i}]acrossfade=d=${xfade.toFixed(3)}:c1=tri:c2=tri${outLabel}`);
    prevLabel = outLabel;
  }

  await execFileAsync('ffmpeg', [
    '-y',
    ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[aout]',
    '-ar', '48000',
    '-ac', '2',
    opts.outputPath,
  ]);
  // Apply per-cue gainStops on the assembled bed. The expression evaluates
  // against timeline t, which matches the assembled mp3's local time axis as
  // long as cue 1 starts at timeline t=0 (the standard layout).
  if (opts.placementMap) {
    const exprs: string[] = [];
    for (const cue of opts.cues) {
      const e = buildGainStopsExpr(cue, opts.placementMap);
      if (e) exprs.push(e);
    }
    if (exprs.length > 0) {
      const filters = exprs.map(e => `volume='${e}':eval=frame`).join(',');
      const tmp = opts.outputPath.replace(/\.mp3$/, '-gainstops.mp3');
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', opts.outputPath,
        '-af', filters,
        '-ar', '48000',
        '-ac', '2',
        tmp,
      ]);
      const { rename } = await import('node:fs/promises');
      await rename(tmp, opts.outputPath);
    }
  }
  return opts.outputPath;
}

/**
 * Apply a `volume=` expression to an existing music track and emit a new file.
 * Use this AFTER `renderMusicCuesTrack` to layer `musicHold` automation
 * without re-rendering the full filter graph.
 */
export async function applyMusicHoldAutomation(opts: {
  inputPath: string;
  outputPath: string;
  volumeExpr: string;
}): Promise<string> {
  if (!existsSync(opts.inputPath)) {
    throw new Error(`applyMusicHoldAutomation: input not found at ${opts.inputPath}`);
  }
  await mkdir(dirname(opts.outputPath), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', opts.inputPath,
    '-af', `volume=${opts.volumeExpr}:eval=frame`,
    '-ar', '48000',
    '-ac', '2',
    opts.outputPath,
  ]);
  return opts.outputPath;
}

/**
 * Convenience: convert a flat list of cue specs into resolved cues by
 * looking up each in the placement map. Cues whose start or end shot
 * cannot be resolved are skipped (with a console.warn) — they were
 * scripted but the placement map doesn't have the shot yet, e.g. because
 * the shot is out of range or was removed.
 */
export function resolveMusicCues(
  specs: MusicCueSpec[],
  placementMap: PlacementMap,
  audioPathFor: (spec: MusicCueSpec) => string | undefined,
): ResolvedMusicCue[] {
  const out: ResolvedMusicCue[] = [];
  for (const spec of specs) {
    const window = resolveCueWindow(spec, placementMap);
    if (!window) {
      console.warn(`  music-cue: skipping cue ${shotIdKey(spec.startShot)}->${shotIdKey(spec.endShot)} — shot ids not in placement map`);
      continue;
    }
    const audioPath = spec.audioPath ?? audioPathFor(spec);
    if (!audioPath || !existsSync(audioPath)) {
      console.warn(`  music-cue: skipping cue ${shotIdKey(spec.startShot)}->${shotIdKey(spec.endShot)} — audio file missing`);
      continue;
    }
    out.push({ spec, audioPath, startSec: window.startSec, endSec: window.endSec });
  }
  return out;
}
