// ---------------------------------------------------------------------------
// Image-format byte sniffing.
//
// Seedream sometimes returns WebP bytes when callers asked for PNG. The
// harness used to write them with a `.png` extension anyway, which confuses
// downstream consumers (older ffmpeg, macOS Preview, image-tag thumbnailers,
// and the silent-reject heuristic that uses byte-size thresholds calibrated
// for PNG at 1K).
//
// `sniffImageFormat` inspects the leading magic bytes and returns the real
// MIME type plus a canonical file extension. `writeImageBytesSmart` writes
// the buffer to disk using the sniffed extension; if a `forceExt` is
// provided, the buffer is written under the requested name AND a sibling
// file with the sniffed extension is written too — so callers that hardcode
// `front.png` get the file at `front.png` AND know the real format via
// `front.webp` if a transcode is needed.
// ---------------------------------------------------------------------------

import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { extname, join, dirname, basename } from 'node:path';

import { sniffImageFormat } from 'venice-video-harness/core/venice/image-format.js';

export { sniffImageFormat };
export type { ImageFormat, SniffResult } from 'venice-video-harness/core/venice/image-format.js';

/**
 * Write image bytes to disk, using the sniffed extension instead of the
 * caller-supplied extension when they disagree.
 *
 * Returns the final on-disk path. When `requestedPath` says `.png` but the
 * buffer is actually WebP, the true-format bytes are written as
 * `<base>.webp` AND the file is transcoded to the requested `.png` via
 * ffmpeg — because the reference-path resolvers (`reference-slots.ts`,
 * `panel-fixer.ts`, the storyboard refiner) all resolve fixed `.png` names
 * and silently lose the asset otherwise (the 2026-08-10 montage E2E failure:
 * every character-refine pass errored with "Reference image not found:
 * …/front.png" while `front.webp` sat next to it). If ffmpeg is missing or
 * the transcode fails, we fall back to the old behavior (sniffed-ext file
 * only, with a louder warning). Pass `forceExt: true` to keep the caller's
 * extension without any transcode (the format on disk will be a lie).
 */
export async function writeImageBytesSmart(
  buf: Buffer,
  requestedPath: string,
  opts?: { forceExt?: boolean },
): Promise<string> {
  const sniff = sniffImageFormat(buf);
  const requestedExt = extname(requestedPath).toLowerCase();
  const expected = sniff.ext.toLowerCase();
  if (sniff.format === 'unknown' || opts?.forceExt || requestedExt === expected) {
    await writeFile(requestedPath, buf);
    return requestedPath;
  }
  const dir = dirname(requestedPath);
  const base = basename(requestedPath, requestedExt);
  const correctedPath = join(dir, `${base}${sniff.ext}`);
  await writeFile(correctedPath, buf);

  // Transcode to the requested extension so fixed-name resolvers still work.
  const r = spawnSync('ffmpeg', ['-y', '-i', correctedPath, requestedPath], { encoding: 'utf-8' });
  if (r.status === 0 && existsSync(requestedPath)) {
    console.warn(
      `  image-bytes: requested ${requestedPath} (${requestedExt || '<no ext>'}) but bytes are ${sniff.format}; kept ${basename(correctedPath)} and transcoded to ${basename(requestedPath)}.`,
    );
    return requestedPath;
  }
  console.warn(
    `  image-bytes: requested ${requestedPath} (${requestedExt || '<no ext>'}) but bytes are ${sniff.format}; wrote ${correctedPath} instead — ffmpeg transcode to ${requestedExt} FAILED; downstream resolvers expecting ${basename(requestedPath)} will not find it.`,
  );
  return correctedPath;
}
