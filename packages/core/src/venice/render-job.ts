// ---------------------------------------------------------------------------
// The video render job lifecycle -- pure, over the `VideoBackend`, `Clock` and
// `Logger` ports. No timers, no IO of its own.
//
//   findPending ─┬─ handle ─▶ resume ─┐
//                └─ none ───▶ queue ──┴─▶ retrieve* ─▶ download ─▶ complete
//
// One run of `runVideoJob` is one render: it re-attaches to a recorded job when
// there is one (never re-submitting a render that may be in flight, rule 43),
// otherwise queues exactly once (never auto-retried: Venice bills at queue
// time), polls until the job is terminal, and stores the media.
//
// How it polls is a `VideoJobPolicy`. The CLI has two poll loops that disagree
// (`pollVideoResult` behind `generateVideo`, `pollRenderedVideo` behind
// `renderVideoFile`); each is a named preset here, and core's own default is a
// third, documented choice:
//
//                          DEFAULT     RENDER_FILE    GENERATE_VIDEO
//   pollIntervalMs         10 000      10 000         10 000
//   sleepBeforeFirstPoll   no          yes            no
//   deadline               60 min      60 min         180 polls
//                          waited      waited
//   maxConsecutiveErrors   6           6              0 (first error propagates)
//   requeueOnGone          once        once           once
//   clearOnFailed          yes         yes            yes
//   silentReject           100 KB      off            100 KB
//   clearOnSilentReject    yes         n/a            no
// ---------------------------------------------------------------------------

import type {
  Clock,
  Logger,
  MediaRef,
  VideoBackend,
  VideoDownloadResult,
  VideoJobHandle,
  VideoJobTarget,
  VideoRetrieveResult,
} from '../ports.js';
import type { VideoQueueRequest, VideoRetrieveStatus } from './types.js';
import { assertNotSilentRejectVideo } from './rejection.js';
import { VideoGenerationFailedError } from './video-errors.js';

/** How a render job polls, gives up, and treats the pending-job record. */
export interface VideoJobPolicy {
  /** Wait between `/video/retrieve` calls, via `Clock.sleep`. */
  pollIntervalMs: number;
  /**
   * Wait one interval before the first retrieve as well. `false` polls at
   * once, which answers a resumed job that finished while nobody watched
   * without a wasted wait.
   */
  sleepBeforeFirstPoll: boolean;
  /** Give up after this many retrieve calls. Unset: no cap. */
  maxPolls?: number;
  /**
   * Give up once this much time has been spent waiting between polls (the sum
   * of `Clock.sleep` intervals, checked before each wait). Unset: no cap.
   * Measured as time slept, not wall time, so it does not depend on how long
   * each retrieve took (the CLI client retries a retrieve internally).
   */
  maxWaitMs?: number;
  /**
   * Retrieve rejections in a row that end the job with `VideoJobPollError`;
   * a successful retrieve resets the count, and each tolerated one is logged
   * as a warning. `0` (or unset): the first rejection propagates unchanged.
   * Abort errors are never counted.
   */
  maxConsecutiveErrors?: number;
  /**
   * A resumed queue id Venice no longer knows (`gone`): clear the record and
   * queue the same request fresh, at most once per run. `false`: clear the
   * record and throw `VideoJobGoneError`.
   */
  requeueOnGone: boolean;
  /** Clear the pending record when the job reports a terminal failure, so the next run queues fresh. */
  clearOnFailed: boolean;
  /**
   * Check the ready bytes against the silent-reject threshold (Venice answers
   * a silent moderation reject with a tiny placeholder MP4) before storing
   * them. `false`: store whatever arrives. `thresholdBytes` defaults to
   * `SILENT_REJECT_THRESHOLD_VIDEO`.
   */
  silentReject: false | { thresholdBytes?: number };
  /**
   * Clear the pending record on a silent reject. The job is finished on
   * Venice's side, so leaving the record makes the next run re-attach and
   * fetch the same placeholder again until the record goes stale.
   */
  clearOnSilentReject: boolean;
  /** Appended to the timeout message, e.g. how to re-attach on this host. */
  timeoutHint?: string;
}

/**
 * Core's default. Polls at once (a re-attached job may already be done),
 * tolerates transient retrieve failures (retrieve is free and idempotent, so
 * one 5xx must not abandon a paid render), waits up to an hour, requeues a
 * gone id once, and treats both a reported failure and a silent reject as
 * terminal: record cleared, error thrown, nothing stored.
 */
export const DEFAULT_VIDEO_JOB_POLICY: Readonly<VideoJobPolicy> = Object.freeze({
  pollIntervalMs: 10_000,
  sleepBeforeFirstPoll: false,
  maxPolls: undefined,
  maxWaitMs: 60 * 60 * 1000,
  maxConsecutiveErrors: 6,
  requeueOnGone: true,
  clearOnFailed: true,
  silentReject: Object.freeze({}),
  clearOnSilentReject: true,
  timeoutHint: 'The job is still recorded; running the same render again re-attaches to it.',
});

/**
 * What `pollRenderedVideo` (`renderVideoFile`, the mini-drama render path)
 * does today: sleep first, 60 minutes of waiting, 6 consecutive retrieve
 * errors, no silent-reject check.
 */
export const RENDER_FILE_VIDEO_JOB_POLICY: Readonly<VideoJobPolicy> = Object.freeze({
  pollIntervalMs: 10_000,
  sleepBeforeFirstPoll: true,
  maxPolls: undefined,
  maxWaitMs: 60 * 60 * 1000,
  maxConsecutiveErrors: 6,
  requeueOnGone: true,
  clearOnFailed: true,
  silentReject: false,
  clearOnSilentReject: false,
  timeoutHint: 'The job is still recorded — re-run to re-attach, or drop it with `venice-video queue clear`.',
});

/**
 * What `pollVideoResult` (`generateVideo`) does today: poll at once, 180
 * polls, the first retrieve error propagates, silent-reject check on, and the
 * record is left in place after a silent reject.
 */
export const GENERATE_VIDEO_JOB_POLICY: Readonly<VideoJobPolicy> = Object.freeze({
  pollIntervalMs: 10_000,
  sleepBeforeFirstPoll: false,
  maxPolls: 180,
  maxWaitMs: undefined,
  maxConsecutiveErrors: 0,
  requeueOnGone: true,
  clearOnFailed: true,
  silentReject: Object.freeze({}),
  clearOnSilentReject: false,
  timeoutHint: undefined,
});

/** Thrown when the policy's deadline passes with the job still processing. The record is left in place. */
export class VideoJobTimeoutError extends Error {
  readonly model: string;
  readonly queueId: string;
  readonly reason: 'max-polls' | 'max-wait';
  readonly polls: number;
  readonly waitedMs: number;

  constructor(info: {
    model: string;
    queueId: string;
    reason: 'max-polls' | 'max-wait';
    polls: number;
    waitedMs: number;
    /** The policy's `maxWaitMs`; the message names the limit, not the time actually slept. */
    maxWaitMs?: number;
    hint?: string;
  }) {
    const base = info.reason === 'max-wait'
      ? `Timed out after ${Math.round((info.maxWaitMs ?? info.waitedMs) / 60_000)} min waiting for ${info.model} (${info.queueId}).`
      : `Timed out waiting for video generation: ${info.model} (${info.queueId})`;
    super(info.hint ? `${base}${info.reason === 'max-wait' ? '' : '.'} ${info.hint}` : base);
    this.name = 'VideoJobTimeoutError';
    this.model = info.model;
    this.queueId = info.queueId;
    this.reason = info.reason;
    this.polls = info.polls;
    this.waitedMs = info.waitedMs;
  }
}

/** Thrown when retrieve failed `maxConsecutiveErrors` times in a row. The record is left in place. */
export class VideoJobPollError extends Error {
  readonly model: string;
  readonly queueId: string;
  readonly attempts: number;
  readonly lastError: unknown;

  constructor(model: string, queueId: string, attempts: number, lastError: unknown) {
    super(
      `Polling ${model} (${queueId}) failed ${attempts} times in a row; giving up. `
      + `Last error: ${(lastError as Error)?.message ?? lastError}`,
    );
    this.name = 'VideoJobPollError';
    this.model = model;
    this.queueId = queueId;
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/** Thrown when a resumed queue id is gone and the policy does not (or can no longer) requeue. The record is cleared. */
export class VideoJobGoneError extends Error {
  readonly model: string;
  readonly queueId: string;
  readonly status: number;

  constructor(model: string, queueId: string, status: number) {
    super(`Recorded job ${queueId} (${model}) is gone on Venice's side (HTTP ${status}).`);
    this.name = 'VideoJobGoneError';
    this.model = model;
    this.queueId = queueId;
    this.status = status;
  }
}

export interface RunVideoJobOptions {
  /**
   * Cancels the run: it stops waiting and rejects with the host's abort error
   * (the one `Clock.sleep` rejects with). The pending record is left in place
   * so the next run re-attaches. Venice still finishes and bills the render.
   */
  signal?: AbortSignal;
  /**
   * Ignore a recorded job and queue fresh. An explicit operator override (the
   * CLI's `--force-requeue`): a recorded job may still be in flight and paid
   * for, so never set this automatically.
   */
  forceRequeue?: boolean;
  /** Each `processing` answer, in order. */
  onProgress?: (status: VideoRetrieveStatus) => void;
}

export interface VideoJobResult {
  /** The handle whose media was stored: the re-attached one, or the fresh one after a requeue. */
  handle: VideoJobHandle;
  /** Where `download` put the media. */
  download: VideoDownloadResult;
  /** True when the media came from a re-attached job (no queue call this run). */
  resumed: boolean;
  /** True when a gone id was replaced by a fresh queue this run. */
  requeued: boolean;
  /** Retrieve calls made against the handle that produced the media. */
  polls: number;
  /** Time slept between those polls. */
  waitedMs: number;
}

/** The ports a render job needs. `HarnessPorts` satisfies it. */
export interface VideoJobPorts {
  video: VideoBackend;
  clock: Clock;
  logger: Logger;
}

type Settled =
  | { kind: 'ready'; bytes: Uint8Array; polls: number; waitedMs: number }
  | { kind: 'gone'; status: number };

const ABORT_ERROR_NAMES = new Set(['AbortError', 'TimeoutError', 'OperationAbortedError']);

function isAbortLike(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === 'string' && ABORT_ERROR_NAMES.has(name);
}

/**
 * Throw the host's abort error when `signal` has fired. `Clock.sleep` rejects
 * at once on an aborted signal, so the error the run surfaces is the one the
 * host's own waits raise (the CLI's `OperationAbortedError`, a browser's
 * `AbortError`) rather than one core invents.
 */
async function throwIfAborted(clock: Clock, signal: AbortSignal | undefined): Promise<void> {
  if (!signal?.aborted) return;
  await clock.sleep(0, signal);
  throw signal.reason ?? new Error('Operation cancelled.');
}

/**
 * Run one render to completion: re-attach or queue, poll, store, complete.
 *
 * Resolves with the stored media. Rejects with the queue error (the queue
 * call is never retried), `VideoGenerationFailedError` (job failed; record
 * cleared under `clearOnFailed`), `VeniceRejectionError` (silent reject),
 * `VideoJobTimeoutError` / `VideoJobPollError` (record kept, so the next run
 * re-attaches), `VideoJobGoneError`, the first retrieve error when the policy
 * tolerates none, a `download` error (record kept; the media is fetched again
 * next run), or the host's abort error (record kept).
 *
 * `policy` is spread over `DEFAULT_VIDEO_JOB_POLICY`, so a key present with
 * the value `undefined` removes the default (no cap, no hint). The presets
 * list every key, so passing one gets that CLI loop's behaviour exactly.
 */
export async function runVideoJob(
  ports: VideoJobPorts,
  request: VideoQueueRequest,
  target: VideoJobTarget,
  policy: Partial<VideoJobPolicy> = DEFAULT_VIDEO_JOB_POLICY,
  options: RunVideoJobOptions = {},
): Promise<VideoJobResult> {
  const p: VideoJobPolicy = { ...DEFAULT_VIDEO_JOB_POLICY, ...policy };
  const { video, clock, logger } = ports;
  const { signal } = options;
  const call = { signal };

  await throwIfAborted(clock, signal);

  let handle: VideoJobHandle;
  const pending = options.forceRequeue ? undefined : await video.findPending(target.outputKey, call);
  if (pending) {
    handle = await video.resume(pending, call);
  } else {
    await throwIfAborted(clock, signal);
    handle = await video.queue(request, target, call);
  }
  const resumed = handle.resumed;

  let requeued = false;
  let settled = await pollUntilSettled(ports, handle, request, p, options);
  while (settled.kind === 'gone') {
    await video.clearPending(target.outputKey, call);
    if (!p.requeueOnGone || requeued) {
      throw new VideoJobGoneError(handle.model, handle.queueId, settled.status);
    }
    logger.warn(`  ⚠ Recorded job ${handle.queueId} is gone on Venice's side; queueing a fresh generation.`);
    await throwIfAborted(clock, signal);
    handle = await video.queue(request, target, call);
    requeued = true;
    settled = await pollUntilSettled(ports, handle, request, p, options);
  }

  const download = await video.download(handle, { bytes: settled.bytes }, call);
  await video.complete(handle, call);

  return {
    handle,
    download,
    resumed: resumed && !requeued,
    requeued,
    polls: settled.polls,
    waitedMs: settled.waitedMs,
  };
}

async function pollUntilSettled(
  ports: VideoJobPorts,
  handle: VideoJobHandle,
  request: VideoQueueRequest,
  p: VideoJobPolicy,
  options: RunVideoJobOptions,
): Promise<Settled> {
  const { video, clock, logger } = ports;
  const { signal } = options;
  const outputKey: MediaRef = handle.outputKey;
  const budget = p.maxConsecutiveErrors ?? 0;

  let polls = 0;
  let waitedMs = 0;
  let consecutiveErrors = 0;

  for (;;) {
    await throwIfAborted(clock, signal);
    if (p.maxPolls !== undefined && polls >= p.maxPolls) {
      throw new VideoJobTimeoutError({
        model: handle.model, queueId: handle.queueId, reason: 'max-polls', polls, waitedMs, hint: p.timeoutHint,
      });
    }
    if (polls > 0 || p.sleepBeforeFirstPoll) {
      if (p.maxWaitMs !== undefined && waitedMs >= p.maxWaitMs) {
        throw new VideoJobTimeoutError({
          model: handle.model,
          queueId: handle.queueId,
          reason: 'max-wait',
          polls,
          waitedMs,
          maxWaitMs: p.maxWaitMs,
          hint: p.timeoutHint,
        });
      }
      await clock.sleep(p.pollIntervalMs, signal);
      waitedMs += p.pollIntervalMs;
    }

    polls += 1;
    let result: VideoRetrieveResult;
    try {
      result = await video.retrieve(handle, { signal });
    } catch (err) {
      if (isAbortLike(err, signal) || budget <= 0) throw err;
      consecutiveErrors += 1;
      if (consecutiveErrors >= budget) {
        throw new VideoJobPollError(handle.model, handle.queueId, consecutiveErrors, err);
      }
      logger.warn(`  Poll error ${consecutiveErrors}/${budget} (will retry): ${err}`);
      continue;
    }
    consecutiveErrors = 0;

    switch (result.kind) {
      case 'processing':
        logger.progress?.({ phase: 'poll', detail: `${result.status.status} ${Math.round(waitedMs / 1000)}s` });
        options.onProgress?.(result.status);
        continue;
      case 'failed':
        if (p.clearOnFailed) await video.clearPending(outputKey, { signal });
        throw new VideoGenerationFailedError(handle.model, handle.queueId, result.status, result.body, result.detail);
      case 'gone':
        return { kind: 'gone', status: result.status };
      case 'ready':
        if (p.silentReject) {
          try {
            assertNotSilentRejectVideo(result.bytes, {
              model: handle.model,
              prompt: request.prompt,
              threshold: p.silentReject.thresholdBytes,
            });
          } catch (err) {
            if (p.clearOnSilentReject) await video.clearPending(outputKey, { signal });
            throw err;
          }
        }
        return { kind: 'ready', bytes: result.bytes, polls, waitedMs };
    }
  }
}
