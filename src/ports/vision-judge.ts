// ---------------------------------------------------------------------------
// VisionJudge over `VeniceClient.chatJson`.
//
// Image refs are file paths, read into `data:image/png;base64,…` URIs exactly
// as the QA modules do today (`toDataUri` in video-qa.ts, the panel reads in
// `qa-storyboard`). chatJson keeps its own policy: fence stripping, one retry
// on an empty reply, one corrective re-ask on a parse error.
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import type { VisionJudge } from 'venice-video-harness/core/ports.js';
import type { VeniceClient } from '../venice/client.js';
import { CLI_IMAGE_DATA_URI_MIME } from './reference-store.js';
import { withSignal } from './signal.js';

export function createCliVisionJudge(client: () => VeniceClient): VisionJudge {
  return {
    async judge<T>(request: Parameters<VisionJudge['judge']>[0]): Promise<T> {
      const { signal, images, ...rest } = request;
      return withSignal(signal, async () => {
        const uris = await Promise.all(images.map(async ref =>
          `data:${CLI_IMAGE_DATA_URI_MIME};base64,${(await readFile(ref)).toString('base64')}`));
        return client().chatJson<T>({ ...rest, images: uris });
      });
    },
  };
}
