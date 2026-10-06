// ---------------------------------------------------------------------------
// ReferenceStore over the project directory.
//
// `referenceSet` is `referenceSetFromDisk` (the CLI's only reference probing);
// refs are file paths. `url` builds the same `data:image/png;base64,…` URI the
// render path sends today (`fileToDataUri` in video-generator.ts labels every
// image PNG), so a request body assembled through this port is byte-identical
// to one assembled by `renderVideoFile`. `read` reports the sniffed format.
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import type { ReferenceStore } from 'venice-video-harness/core/ports.js';
import { referenceSetFromDisk } from '../mini-drama/reference-set-from-disk.js';
import { sniffImageFormat } from '../venice/image-bytes.js';
import { withSignal } from './signal.js';

/** The MIME type the CLI's render path puts on every image data URI. */
export const CLI_IMAGE_DATA_URI_MIME = 'image/png';

export function createCliReferenceStore(): ReferenceStore {
  return {
    async referenceSet(series, shot, options = {}) {
      return withSignal(options.signal, async () =>
        referenceSetFromDisk(series, shot, { characterNames: options.characterNames }));
    },

    async read(ref, options = {}) {
      return withSignal(options.signal, async () => {
        const bytes = new Uint8Array(await readFile(ref));
        return { bytes, mimeType: sniffImageFormat(bytes).mime };
      });
    },

    async url(ref, options = {}) {
      return withSignal(options.signal, async () => {
        const bytes = await readFile(ref);
        return `data:${CLI_IMAGE_DATA_URI_MIME};base64,${bytes.toString('base64')}`;
      });
    },
  };
}
