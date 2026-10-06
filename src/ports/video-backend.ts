// ---------------------------------------------------------------------------
// VideoBackend over the Venice video endpoints and the pending-job registry.
//
//   quote         quoteVideo                       (venice/video.ts)
//   queue         assertValidVideoRequest + submitVideoQueue (video-generator.ts:
//                 the render path's 409-consent / refunded-refusal handshakes,
//                 never a blind retry) + recordPendingJob, BEFORE resolving
//   findPending   findPendingJob                   (venice/job-store.ts)
//   resume        touchPendingJob
//   retrieve      one POST /video/retrieve + classifyVideoRetrieveStatus;
//                 isQueueGoneError on a resumed handle -> { kind: 'gone' }
//   download      archive-first write + clearPendingJob
//   complete      completeVideo (best-effort)
//   clearPending  clearPendingJob
//
// Output keys are normalized to absolute paths, the registry's key, so a job
// queued here and one queued by `renderVideoFile` / `generateVideo` for the
// same file are the same record: either path re-attaches to the other's job.
// ---------------------------------------------------------------------------

import { existsSync, renameSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve as resolvePath } from 'node:path';
import type { Logger, VideoBackend, VideoJobHandle } from 'venice-video-harness/core/ports.js';
import type { VideoRetrieveStatus } from 'venice-video-harness/core/venice/types.js';
import type { VeniceClient } from '../venice/client.js';
import {
  assertValidVideoRequest,
  classifyVideoRetrieveStatus,
  completeVideo,
  isQueueGoneError,
  quoteVideo,
} from '../venice/video.js';
import { clearPendingJob, findPendingJob, recordPendingJob, touchPendingJob } from '../venice/job-store.js';
import { submitVideoQueue } from '../mini-drama/video-generator.js';
import { isAbortError } from '../venice/operation-context.js';
import { withSignal } from './signal.js';

const VIDEO_RETRIEVE_PATH = '/api/v1/video/retrieve';

/** Move an existing file aside as `<stem>-vN<ext>` (first free N), the shot-asset-safety naming. */
function archiveExistingFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const ext = extname(path);
  const stem = path.slice(0, path.length - ext.length);
  let version = 1;
  while (existsSync(`${stem}-v${version}${ext}`)) version += 1;
  const archived = `${stem}-v${version}${ext}`;
  renameSync(path, archived);
  return archived;
}

export function createCliVideoBackend(client: () => VeniceClient, logger: Logger): VideoBackend {
  const key = (outputKey: string) => resolvePath(outputKey);

  return {
    async quote(request, options = {}) {
      return withSignal(options.signal, () => quoteVideo(client(), request));
    },

    async findPending(outputKey, options = {}) {
      return withSignal(options.signal, async () => {
        const job = await findPendingJob(key(outputKey));
        if (!job || job.kind !== 'video') return undefined;
        const handle: VideoJobHandle = {
          outputKey: job.outputPath,
          model: job.model,
          queueId: job.queueId,
          queuedAt: job.createdAt,
          resumed: true,
        };
        return handle;
      });
    },

    async resume(handle, options = {}) {
      return withSignal(options.signal, async () => {
        await touchPendingJob(key(handle.outputKey));
        logger.info(`  Re-attaching to in-flight job ${handle.queueId} (${handle.model}) — not re-queueing.`);
        return { ...handle, outputKey: key(handle.outputKey), resumed: true };
      });
    },

    async queue(request, target, options = {}) {
      return withSignal(options.signal, async () => {
        assertValidVideoRequest(request.model, { duration: request.duration, resolution: request.resolution });
        const outputPath = key(target.outputKey);
        await mkdir(dirname(outputPath), { recursive: true });
        const { queue_id, model } = await submitVideoQueue(
          client(),
          request.model,
          request as unknown as Record<string, unknown>,
          outputPath,
        );
        await recordPendingJob({
          kind: 'video',
          model,
          queueId: queue_id,
          outputPath,
          project: target.project,
          episode: target.episode,
          prompt: request.prompt,
        });
        logger.info(`  Queue ID: ${queue_id}`);
        return { outputKey: outputPath, model, queueId: queue_id, queuedAt: new Date().toISOString(), resumed: false };
      });
    },

    async retrieve(handle, options = {}) {
      return withSignal(options.signal, async () => {
        const outputPath = key(handle.outputKey);
        let response: { contentType: string; value: VideoRetrieveStatus | Uint8Array };
        try {
          response = await client().postBinaryOrJson<VideoRetrieveStatus>(
            VIDEO_RETRIEVE_PATH,
            { model: handle.model, queue_id: handle.queueId },
          );
        } catch (err) {
          if (isAbortError(err)) throw err;
          if (handle.resumed && isQueueGoneError(err)) {
            return { kind: 'gone' as const, status: (err as { status: number }).status };
          }
          throw err;
        }

        if (response.value instanceof Uint8Array) {
          return { kind: 'ready' as const, bytes: response.value, contentType: response.contentType };
        }
        const status = response.value;
        const verdict = classifyVideoRetrieveStatus(status);
        if (verdict.kind === 'failed') {
          return { kind: 'failed' as const, status: verdict.status, detail: verdict.detail, body: status };
        }
        await touchPendingJob(outputPath);
        return { kind: 'processing' as const, status };
      });
    },

    async download(handle, media, options = {}) {
      return withSignal(options.signal, async () => {
        const outputPath = key(handle.outputKey);
        await mkdir(dirname(outputPath), { recursive: true });
        const archivedRef = archiveExistingFile(outputPath);
        if (archivedRef) logger.info(`  Archived previous: ${archivedRef}`);
        await writeFile(outputPath, media.bytes);
        await clearPendingJob(outputPath);
        return { ref: outputPath, sizeBytes: media.bytes.length, ...(archivedRef ? { archivedRef } : {}) };
      });
    },

    async complete(handle, options = {}) {
      try {
        await withSignal(options.signal, () => completeVideo(client(), handle.model, handle.queueId));
      } catch {
        // Cleanup is optional; never fail the pipeline over it.
      }
    },

    async clearPending(outputKey, options = {}) {
      return withSignal(options.signal, () => clearPendingJob(key(outputKey)));
    },
  };
}
