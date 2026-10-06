// ---------------------------------------------------------------------------
// ImageProbe over ffmpeg / ffprobe.
//
// Wraps the helpers the CLI already uses, unchanged:
//   imageInfo      getImageDimensions   (venice/edit-post.ts, ffprobe)
//   clipDuration   ffprobeDurationSec   (mini-drama/video-qa.ts)
//   extractFrame   extractFrame         (video-qa.ts) for { atSec },
//                  extractLastFrame     (video-generator.ts) for { fromEndSec }
//   frameLumas     headFrameLumas / frameLuma (video-qa.ts); a window that
//                  starts mid-clip uses the same signalstats filter after a seek
//
// ffmpeg runs synchronously, so a signal is checked before each call but
// cannot interrupt one in progress.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ImageProbe } from 'venice-video-harness/core/ports.js';
import { getImageDimensions } from '../venice/edit-post.js';
import { extractFrame, ffprobeDurationSec, frameLuma, headFrameLumas } from '../mini-drama/video-qa.js';
import { extractLastFrame } from '../mini-drama/video-generator.js';
import { withSignal } from './signal.js';

export interface CliImageProbeOptions {
  /** Where `extractFrame` writes when the caller gives no `outputRef`. Default: a per-process dir under the OS temp dir. */
  framesDir?: string;
}

/** Per-frame YAVG for `frames` frames starting `startSec` into the clip. `[]` on failure. */
function seekedFrameLumas(clip: string, startSec: number, frames: number): number[] {
  const r = spawnSync('ffmpeg', [
    '-v', 'info', '-ss', String(startSec), '-i', clip,
    '-vf', `select='lt(n\\,${frames})',signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
    '-f', 'null', '-',
  ], { encoding: 'utf-8' });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const lumas: number[] = [];
  for (const m of out.matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)) {
    lumas.push(parseFloat(m[1]));
  }
  return lumas;
}

export function createCliImageProbe(options: CliImageProbeOptions = {}): ImageProbe {
  const framesDir = options.framesDir ?? join(tmpdir(), `venice-video-frames-${process.pid}`);
  let counter = 0;

  const scratchPath = (clip: string, tag: string): string => {
    mkdirSync(framesDir, { recursive: true });
    counter += 1;
    const stem = basename(clip, extname(clip));
    return join(framesDir, `${stem}-${tag}-${Date.now()}-${counter}.png`);
  };

  return {
    async imageInfo(image, opts = {}) {
      return withSignal(opts.signal, async () => {
        try {
          const dims = getImageDimensions(image);
          return dims ? { width: dims[0], height: dims[1] } : undefined;
        } catch {
          return undefined;
        }
      });
    },

    async clipDuration(clip, opts = {}) {
      return withSignal(opts.signal, async () => ffprobeDurationSec(clip));
    },

    async extractFrame(clip, position, opts = {}) {
      return withSignal(opts.signal, async () => {
        if ('fromEndSec' in position) {
          const out = opts.outputRef ?? scratchPath(clip, `end${position.fromEndSec}`);
          extractLastFrame(clip, out, position.fromEndSec);
          return out;
        }
        const out = opts.outputRef ?? scratchPath(clip, `at${position.atSec}`);
        if (!extractFrame(clip, position.atSec, out)) {
          throw new Error(`ffmpeg could not extract a frame at ${position.atSec}s from ${clip}`);
        }
        return out;
      });
    },

    async frameLumas(clip, window, opts = {}) {
      return withSignal(opts.signal, async () => {
        const start = window.startSec ?? 0;
        if (window.frames <= 0) return [];
        if (start <= 0) return headFrameLumas(clip, window.frames);
        if (window.frames === 1) {
          const v = frameLuma(clip, start);
          return v === undefined ? [] : [v];
        }
        return seekedFrameLumas(clip, start, window.frames);
      });
    },
  };
}
