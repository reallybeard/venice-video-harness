// ---------------------------------------------------------------------------
// RenderVideoMedia over the project directory: the render path's file,
// ffprobe/ffmpeg and sidecar IO that no port covers (see core
// `mini-drama/render-video.ts`).
//
//   exists            existsSync
//   hasFace           the image's provenance sidecar (`*.provenance.json`)
//   audioUrl          data: URI of the file's bytes, with the given MIME
//   audioDurationSec  probeAudioDurationSec (ffprobe)
//   padAudioForModel  padAudioForModel (ffmpeg apad, `padded/` next to it)
//   padLipSyncAudio   ffmpeg to `padded/<stem>.wav`, mono 44.1 kHz
//   appendRecipe      appendRecipePass (also updates provenance)
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { RenderVideoMedia } from 'venice-video-harness/core/mini-drama/render-video.js';
import { padAudioForModel, probeAudioDurationSec } from '../venice/audio-preflight.js';
import { readImageProvenance } from '../venice/provenance.js';
import { appendRecipePass } from '../venice/recipe.js';

export function createCliRenderMedia(): RenderVideoMedia {
  return {
    async exists(ref) {
      return Boolean(ref) && existsSync(ref);
    },

    async hasFace(ref) {
      return (await readImageProvenance(ref))?.hasFace;
    },

    async audioUrl(ref, mimeType) {
      if (!ref || !existsSync(ref)) return undefined;
      return `data:${mimeType};base64,${readFileSync(ref).toString('base64')}`;
    },

    audioDurationSec: probeAudioDurationSec,

    async padAudioForModel(model, ref) {
      const result = await padAudioForModel({ model, audioPath: ref });
      return { ref: result.outputPath, padded: result.padded, durationSec: result.durationSec };
    },

    async padLipSyncAudio(ref, targetSec) {
      const sendPath = join(dirname(ref), 'padded', basename(ref).replace(/\.[^.]+$/, '') + '.wav');
      await mkdir(dirname(sendPath), { recursive: true });
      const ff = spawnSync('ffmpeg', [
        '-y', '-v', 'error', '-i', ref,
        '-af', `apad=whole_dur=${targetSec.toFixed(3)}`, '-t', targetSec.toFixed(3),
        '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', sendPath,
      ]);
      if (ff.status !== 0) {
        throw new Error(`ffmpeg could not prepare lip-sync audio ${ref}: ${ff.stderr?.toString().trim()}`);
      }
      return sendPath;
    },

    async appendRecipe(outputKey, pass) {
      await appendRecipePass(outputKey, pass);
    },
  };
}
