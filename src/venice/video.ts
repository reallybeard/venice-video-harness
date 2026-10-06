// ---------------------------------------------------------------------------
// Venice Video API -- queue, retrieve, quote, complete
//
// Async workflow: queue a job, poll for completion, download the MP4.
// ---------------------------------------------------------------------------

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import type { VeniceClient } from './client.js';
import { VeniceRequestError } from './client.js';
import { clearPendingJob, findPendingJob, recordPendingJob, touchPendingJob } from './job-store.js';
import { abortableSleep, reportProgress, throwIfAborted } from './operation-context.js';
import type {
  VideoQueueRequest,
  VideoQueueResponse,
  VideoRetrieveStatus,
  VideoQuoteRequest,
  VideoQuoteResponse,
} from 'venice-video-harness/core/venice/types.js';
import {
  validateVideoRequest,
  type VideoRequestIssue,
} from 'venice-video-harness/core/venice/models.js';
import { assertNotSilentRejectVideo } from 'venice-video-harness/core/venice/rejection.js';
import { classifyVideoRetrieveStatus } from 'venice-video-harness/core/venice/retrieve-status.js';
import {
  buildRegistryVideoQueueRequest,
  snapVideoRequest,
  type RegistryVideoQueueRequestOptions,
} from 'venice-video-harness/core/venice/request-builder.js';

const VIDEO_QUEUE_PATH = '/api/v1/video/queue';
const VIDEO_RETRIEVE_PATH = '/api/v1/video/retrieve';
const VIDEO_COMPLETE_PATH = '/api/v1/video/complete';
const VIDEO_QUOTE_PATH = '/api/v1/video/quote';

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 180;

/**
 * True when Venice no longer recognises a queue id -- the job finished and was
 * reaped, or it never existed. A resumed job that hits this is unrecoverable, so
 * the caller drops the stale record and queues fresh.
 */
function isQueueGoneError(error: unknown): boolean {
  return error instanceof VeniceRequestError
    && (error.status === 400 || error.status === 404 || error.status === 410);
}

// ---- Retrieve status classification ----------------------------------------

/**
 * Thrown when `/video/retrieve` reports that the job ended without a video.
 * Distinct from the poll timeout so callers (and humans reading logs) can tell
 * "Venice gave up on this job" from "we gave up waiting".
 */
export class VideoGenerationFailedError extends Error {
  public readonly model: string;
  public readonly queueId: string;
  public readonly status: string;
  public readonly body: unknown;

  constructor(model: string, queueId: string, status: string, body: unknown, detail?: string) {
    super(
      `Video generation ${status} for ${model} (${queueId})`
      + (detail ? `: ${detail}` : ''),
    );
    this.name = 'VideoGenerationFailedError';
    this.model = model;
    this.queueId = queueId;
    this.status = status;
    this.body = body;
  }
}

export {
  classifyVideoRetrieveStatus,
  type VideoRetrieveVerdict,
} from 'venice-video-harness/core/venice/retrieve-status.js';

// ---- Quote ----------------------------------------------------------------

/**
 * Thrown before any HTTP call when a request names a duration or resolution
 * the model does not list. Carries the structured issues so a CLI or UI can
 * show the valid list and the suggestion ("try 10s") rather than a bare 400.
 */
export class VideoRequestValidationError extends VeniceRequestError {
  public readonly issues: VideoRequestIssue[];

  constructor(modelId: string, issues: VideoRequestIssue[]) {
    super(
      `Invalid video request for ${modelId}: ${issues.map(i => i.message).join('; ')}`,
      0,
      { model: modelId, issues },
    );
    this.name = 'VideoRequestValidationError';
    this.issues = issues;
  }
}

/**
 * Validate duration/resolution against the registry and throw before the paid
 * call. Unknown models pass through (the registry cannot vouch either way;
 * Venice will validate).
 */
export function assertValidVideoRequest(
  modelId: string,
  opts: { duration?: string; resolution?: string },
): void {
  const issues = validateVideoRequest(modelId, opts);
  if (issues.length > 0) throw new VideoRequestValidationError(modelId, issues);
}

/**
 * Get a price estimate for a video generation before committing.
 *
 * Validates duration/resolution against the registry first: a quote for a
 * value the model will reject is misleading (Venice may price a snapped or
 * defaulted value), so fail here with the valid list instead.
 */
export async function quoteVideo(
  client: VeniceClient,
  request: VideoQuoteRequest,
): Promise<VideoQuoteResponse> {
  assertValidVideoRequest(request.model, {
    duration: request.duration,
    resolution: request.resolution,
  });
  return client.post<VideoQuoteResponse>(VIDEO_QUOTE_PATH, request as unknown as Record<string, unknown>);
}

// ---- Queue ----------------------------------------------------------------

export interface QueueVideoOptions extends RegistryVideoQueueRequestOptions {
  /**
   * Opt in to the old behaviour: an unsupported duration is snapped to the
   * closest valid one and an unsupported resolution falls back to the model
   * default, each with a warning. Off by default -- a mismatch throws
   * `VideoRequestValidationError` before any HTTP call, because a silent
   * snap changes the price and the output without the caller asking.
   */
  snap?: boolean;
}

/**
 * Queue a video generation job. Returns the queue_id for polling.
 *
 * Automatically applies model-specific parameter constraints:
 * - Skips aspect_ratio when not supported
 * - Skips end_image_url when not supported
 * - Validates duration and resolution against model capabilities and throws
 *   before the paid call (or snaps them, with `snap: true`)
 */
export async function queueVideo(
  client: VeniceClient,
  options: QueueVideoOptions,
): Promise<VideoQueueResponse> {
  let duration = options.duration;
  let resolution = options.resolution;
  const issues = validateVideoRequest(options.model, { duration, resolution });
  if (issues.length > 0) {
    if (!options.snap) throw new VideoRequestValidationError(options.model, issues);
    ({ duration, resolution } = snapVideoRequest({ duration, resolution }, issues));
  }

  const body = buildRegistryVideoQueueRequest({ ...options, duration, resolution }) as unknown as Record<string, unknown>;

  // Never auto-retry the queue call. Venice can accept and bill the job before
  // a 5xx or dropped connection reaches us; a blind retry would queue the same
  // shot twice. The error surfaces to the caller, who can re-queue deliberately
  // (and `venice-video queue` can re-attach to anything that did land).
  return client.post<VideoQueueResponse>(VIDEO_QUEUE_PATH, body, { retry: false });
}

// ---- Retrieve / Poll ------------------------------------------------------

export interface PollVideoOptions {
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  onProgress?: (status: VideoRetrieveStatus) => void;
  /** Prompt text passed to VeniceRejectionError for context. */
  prompt?: string;
  /** Override the default silent-reject byte threshold for this poll. */
  silentRejectThreshold?: number;
  /** Skip the silent-reject check (e.g. for low-resolution or short clips). */
  skipSilentRejectCheck?: boolean;
  /**
   * Output path this poll is feeding. Supplying it keeps the pending-job
   * heartbeat fresh so `venice-video queue` can distinguish a live poll from an
   * abandoned one.
   */
  heartbeatPath?: string;
}

/**
 * Poll for a video generation result until the MP4 is ready.
 * Returns the raw video buffer.
 */
export async function pollVideoResult(
  client: VeniceClient,
  model: string,
  queueId: string,
  options: PollVideoOptions = {},
): Promise<Buffer> {
  const {
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxPollAttempts = DEFAULT_MAX_POLL_ATTEMPTS,
    onProgress,
    prompt,
    silentRejectThreshold,
    skipSilentRejectCheck,
    heartbeatPath,
  } = options;

  for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
    throwIfAborted();
    if (attempt > 0) await abortableSleep(pollIntervalMs);

    const response = await client.postBinaryOrJson<VideoRetrieveStatus>(
      VIDEO_RETRIEVE_PATH,
      { model, queue_id: queueId },
    );

    if (Buffer.isBuffer(response.value)) {
      if (!skipSilentRejectCheck) {
        assertNotSilentRejectVideo(response.value, {
          model,
          prompt,
          threshold: silentRejectThreshold,
        });
      }
      return response.value;
    }

    const status = response.value as VideoRetrieveStatus;
    const verdict = classifyVideoRetrieveStatus(status);
    if (verdict.kind === 'failed') {
      // Terminal: fail now, not at the deadline. Drop the pending-job record
      // so the next run queues fresh instead of re-attaching to a dead id.
      if (heartbeatPath) await clearPendingJob(heartbeatPath);
      throw new VideoGenerationFailedError(model, queueId, verdict.status, status, verdict.detail);
    }

    if (heartbeatPath) await touchPendingJob(heartbeatPath);
    reportProgress({
      phase: 'poll',
      detail: `${status.status} ${Math.round((attempt * pollIntervalMs) / 1000)}s`,
    });
    onProgress?.(status);
  }

  throw new Error(`Timed out waiting for video generation: ${model} (${queueId})`);
}

// ---- Complete -------------------------------------------------------------

/**
 * Signal completion after downloading. Cleans up server-side storage.
 */
export async function completeVideo(
  client: VeniceClient,
  model: string,
  queueId: string,
): Promise<void> {
  try {
    await client.post(VIDEO_COMPLETE_PATH, { model, queue_id: queueId });
  } catch {
    // Cleanup is optional -- don't fail the pipeline
  }
}

// ---- High-level: generate and save ----------------------------------------

export interface GenerateVideoOptions extends QueueVideoOptions {
  outputPath: string;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  onProgress?: (status: VideoRetrieveStatus) => void;
  /** Project directory, recorded on the pending job for `venice-video queue`. */
  project?: string;
  episode?: number;
  /** Ignore any recorded in-flight job and queue a fresh generation. */
  forceRequeue?: boolean;
}

/**
 * Queue, poll, download, and save a video in one call.
 * Returns the saved file path and the raw buffer size.
 *
 * The queue id is persisted before the first poll, so a generation interrupted
 * mid-flight is re-attached on the next run rather than paid for twice.
 */
export async function generateVideo(
  client: VeniceClient,
  options: GenerateVideoOptions,
): Promise<{ path: string; sizeBytes: number; queueId: string; resumed: boolean }> {
  const {
    outputPath,
    pollIntervalMs,
    maxPollAttempts,
    onProgress,
    project,
    episode,
    forceRequeue,
    ...queueOpts
  } = options;

  await mkdir(dirname(outputPath), { recursive: true });
  const jobKey = resolvePath(outputPath);

  const existing = forceRequeue ? undefined : await findPendingJob(jobKey);
  let queueId: string;
  let model: string;
  let resumed = false;

  if (existing && existing.kind === 'video') {
    console.log(`  Re-attaching to in-flight job ${existing.queueId} (${existing.model}) — not re-queueing.`);
    queueId = existing.queueId;
    model = existing.model;
    resumed = true;
  } else {
    ({ queue_id: queueId, model } = await queueVideo(client, queueOpts));
    await recordPendingJob({
      kind: 'video',
      model,
      queueId,
      outputPath: jobKey,
      project,
      episode,
      prompt: options.prompt,
    });
  }

  let videoBuffer: Buffer;
  try {
    videoBuffer = await pollVideoResult(client, model, queueId, {
      pollIntervalMs,
      maxPollAttempts,
      onProgress,
      prompt: options.prompt,
      heartbeatPath: jobKey,
    });
  } catch (err) {
    // A resumed id Venice has already reaped is a dead end; drop the stale
    // record and generate fresh rather than failing the whole episode.
    if (resumed && isQueueGoneError(err)) {
      console.warn(`  ⚠ Recorded job ${queueId} is gone on Venice's side; queueing a fresh generation.`);
      await clearPendingJob(jobKey);
      return generateVideo(client, { ...options, forceRequeue: true });
    }
    throw err;
  }

  await writeFile(outputPath, videoBuffer);
  await clearPendingJob(jobKey);
  await completeVideo(client, model, queueId);

  return { path: outputPath, sizeBytes: videoBuffer.length, queueId, resumed };
}
