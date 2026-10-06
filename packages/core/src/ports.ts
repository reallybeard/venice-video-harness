// ---------------------------------------------------------------------------
// Ports: what core asks of its host.
//
// Core is plain data in, plain data out. The production loop still has to read
// reference images, probe clips, ask a vision model for a verdict and drive
// Venice's queue-then-poll video API. Each of those goes through an interface
// declared here; the host implements it in its own world:
//
//   CLI      fs + ffmpeg/ffprobe + VeniceClient   (`src/ports/`, createCliPorts)
//   browser  OPFS + canvas/WebCodecs + fetch      (the web app)
//
// Interfaces only, no implementation. Nothing here names a Node type: bytes
// are `Uint8Array`, media is an opaque `MediaRef` string, cancellation is the
// web-standard `AbortSignal`.
//
// Every method is async, including ones the CLI could answer synchronously:
// a browser host cannot (OPFS, image decode and fetch are all async).
// ---------------------------------------------------------------------------

import type { SeriesState, ShotScript } from './series/types.js';
import type { ReferenceSet } from './series/references.js';
import type {
  VideoQueueRequest,
  VideoQuoteRequest,
  VideoQuoteResponse,
  VideoRetrieveStatus,
} from './venice/types.js';

/**
 * A piece of media the host can open: a path on the CLI, an asset id in a
 * browser. Opaque to core, exactly like `ReferenceImage.ref`; core passes it
 * back to the port that produced it and never opens it.
 */
export type MediaRef = string;

/** Options every port call accepts. */
export interface PortCallOptions {
  /**
   * Cancels the call. A cancelled call rejects; it does not resolve with a
   * partial result. Cancelling a video poll stops *waiting*, not the render:
   * Venice still finishes and bills it (rule 43).
   */
  signal?: AbortSignal;
}

// ---- ReferenceStore --------------------------------------------------------

/** Bytes of one reference image, with the format they actually are. */
export interface ReferenceBytes {
  bytes: Uint8Array;
  /** Sniffed from the bytes (`image/png`, `image/webp`, …); `application/octet-stream` when unknown. */
  mimeType: string;
}

/** Which images exist for a shot's characters, locations and storyboard plate, and how to send them. */
export interface ReferenceStore {
  /**
   * The shot's `ReferenceSet`, in the planner's preference order (CLI rules:
   * `src/mini-drama/reference-set-from-disk.ts`). `characterNames` overrides
   * `shot.characters`, as `buildReferenceSlotPlan`'s option of the same name does.
   */
  referenceSet(
    series: SeriesState,
    shot: ShotScript,
    options?: PortCallOptions & { characterNames?: string[] },
  ): Promise<ReferenceSet>;
  /** The image's bytes. Rejects when the ref does not resolve. */
  read(ref: MediaRef, options?: PortCallOptions): Promise<ReferenceBytes>;
  /**
   * A URL a Venice request body can carry for this image (`data:` URI on the
   * CLI, matching what its render path sends today; a browser may return a
   * `data:` URI or an https URL). Rejects when the ref does not resolve.
   */
  url(ref: MediaRef, options?: PortCallOptions): Promise<string>;
}

// ---- ImageProbe --------------------------------------------------------------

export interface ImageInfo {
  width: number;
  height: number;
}

/** Where in a clip to take a frame. */
export type FramePosition =
  | { atSec: number }
  /**
   * Seconds before the end of the video stream (0 = the last decodable
   * frame). The CLI steps back further on its own when the exact end does not
   * decode (anti-pattern 31), so this always lands on a real frame.
   */
  | { fromEndSec: number };

/** A run of consecutive frames. */
export interface LumaWindow {
  /** Seconds into the clip where the window starts. Default 0 (the head). */
  startSec?: number;
  /** How many consecutive frames to measure. */
  frames: number;
}

/** Image and clip measurements. Pure reads; nothing is billed. */
export interface ImageProbe {
  /** Dimensions, or `undefined` when the image does not decode. */
  imageInfo(image: MediaRef, options?: PortCallOptions): Promise<ImageInfo | undefined>;
  /** Clip duration in seconds; 0 when it cannot be read (the CLI's ffprobe behaviour). */
  clipDuration(clip: MediaRef, options?: PortCallOptions): Promise<number>;
  /**
   * Extract one frame as an image and return its ref. `outputRef` asks for a
   * specific destination (a path on the CLI); without it the host picks a
   * scratch location. Rejects when no frame could be extracted.
   */
  extractFrame(
    clip: MediaRef,
    position: FramePosition,
    options?: PortCallOptions & { outputRef?: MediaRef },
  ): Promise<MediaRef>;
  /**
   * Per-frame mean luma over a window: the Y-plane average, 0-255, BT.601,
   * i.e. ffmpeg `signalstats` YAVG. Core's `findHeadGlitch` and
   * `classifyBoundary` consume these numbers directly. May return fewer
   * values than asked (short clip) and returns `[]` on failure rather than
   * rejecting: a QA scan must never kill the pipeline.
   */
  frameLumas(clip: MediaRef, window: LumaWindow, options?: PortCallOptions): Promise<number[]>;
}

// ---- VisionJudge -------------------------------------------------------------

/**
 * One vision verdict. The shape of the three QA calls core makes (storyboard
 * panel, unit identity, cross-unit identity): a rubric, a prompt, images,
 * and a JSON reply.
 */
export interface VisionJudgeRequest extends PortCallOptions {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** Images, in the order the prompt refers to them. The host turns them into whatever the chat API takes. */
  images: MediaRef[];
  maxTokens?: number;
  temperature?: number;
  /** What is being judged, for error messages, e.g. `'unit u3 identity QA'`. */
  label?: string;
}

export interface VisionJudge {
  /**
   * Resolve with the model's reply parsed as JSON. Rejects when the call
   * fails, the model returns nothing, or the reply will not parse (the CLI
   * retries once quoting the parse error before rejecting). Core turns a
   * rejection into an `errored` result; it never treats one as a pass.
   */
  judge<T>(request: VisionJudgeRequest): Promise<T>;
}

// ---- VideoBackend ------------------------------------------------------------

/**
 * Where a render's media will land. `outputKey` identifies the render: it is
 * the key the pending job is recorded under and the destination `download`
 * writes to (an output path on the CLI, an asset key in a browser).
 */
export interface VideoJobTarget {
  outputKey: MediaRef;
  /** Bookkeeping recorded with the pending job, so a queue listing is recognisable. */
  project?: string;
  episode?: number;
}

/**
 * A queued render. The only two ways to get one are `queue` (a fresh, billed
 * job) and `findPending` + `resume` (re-attach to a job already paid for).
 */
export interface VideoJobHandle {
  outputKey: MediaRef;
  /** The model Venice echoed back from `/queue`; `/retrieve` keys on it. */
  model: string;
  queueId: string;
  /** ISO time the job was queued. */
  queuedAt: string;
  /** True when this handle came from the pending-job record, not a fresh queue. */
  resumed: boolean;
}

/** What one `/video/retrieve` call said. */
export type VideoRetrieveResult =
  | { kind: 'processing'; status: VideoRetrieveStatus }
  | { kind: 'ready'; bytes: Uint8Array; contentType: string }
  /** Terminal: the job ended without a video. The record is NOT cleared; the caller decides. */
  | { kind: 'failed'; status: string; detail?: string; body: unknown }
  /**
   * A resumed queue id Venice no longer knows (reaped, or never existed).
   * Unrecoverable: clear the record and queue fresh. Only reported for
   * `resumed` handles; on a fresh handle the same HTTP error rejects.
   */
  | { kind: 'gone'; status: number };

export interface VideoDownloadResult {
  /** Where the media now lives (equals the handle's `outputKey` on the CLI). */
  ref: MediaRef;
  sizeBytes: number;
  /** The prior media at `outputKey`, when there was one; it is archived, never overwritten (rule 5). */
  archivedRef?: MediaRef;
}

/**
 * Venice's queue-then-poll video API, with the pending-job record that keeps a
 * paid render from being paid for twice (rule 43).
 *
 * The contract, in the order a loop uses it:
 *
 *  1. `findPending(outputKey)`. When it returns a handle, `resume` it and poll.
 *     Never `queue` an output that has a pending job: Venice bills at queue
 *     time, so a re-submit pays twice for one shot.
 *  2. Otherwise `queue`. It resolves only after the handle is durably recorded
 *     under `outputKey`, so a crash after it returns re-attaches next run. It
 *     is never retried automatically: a 5xx can arrive after Venice accepted
 *     and billed the job.
 *  3. `retrieve` until it is not `processing`. Each call is one request; the
 *     poll interval, deadline and error budget are the caller's (use
 *     `Clock.sleep`). A `processing` answer refreshes the record's heartbeat.
 *  4. `ready`: `download` (archive-first write, then clear the record), then
 *     `complete` (best-effort server cleanup).
 *     `failed` / `gone`: `clearPending(outputKey)`, then decide whether to queue fresh.
 *
 *  Cancellation stops waiting and leaves the record in place, so the next
 *  run re-attaches instead of re-queueing.
 */
export interface VideoBackend {
  /** Price estimate. Validates duration/resolution against the registry before any call. */
  quote(request: VideoQuoteRequest, options?: PortCallOptions): Promise<VideoQuoteResponse>;
  /** The recorded, still-live job for this output, if any. Stale records (past Venice's queue TTL) are not returned. */
  findPending(outputKey: MediaRef, options?: PortCallOptions): Promise<VideoJobHandle | undefined>;
  /** Re-attach to a recorded job: refreshes its heartbeat and returns it with `resumed: true`. Makes no billed call. */
  resume(handle: VideoJobHandle, options?: PortCallOptions): Promise<VideoJobHandle>;
  /**
   * Submit a request body (built by core) and record the job under
   * `target.outputKey` before resolving. Billed. Validates duration/resolution
   * first; the host layers its own handshakes (the CLI resubmits with Seedance
   * consent on 409 `needs_consent` and retries one refunded content-policy
   * refusal) but never a blind retry.
   */
  queue(request: VideoQueueRequest, target: VideoJobTarget, options?: PortCallOptions): Promise<VideoJobHandle>;
  /** One `/video/retrieve` call. */
  retrieve(handle: VideoJobHandle, options?: PortCallOptions): Promise<VideoRetrieveResult>;
  /** Store the media at the handle's `outputKey` (archiving any prior file), then clear the pending record. */
  download(
    handle: VideoJobHandle,
    media: { bytes: Uint8Array },
    options?: PortCallOptions,
  ): Promise<VideoDownloadResult>;
  /** Tell Venice the media is collected. Best-effort: never rejects. */
  complete(handle: VideoJobHandle, options?: PortCallOptions): Promise<void>;
  /** Drop the pending record for an output (terminal failure, or a gone id). */
  clearPending(outputKey: MediaRef, options?: PortCallOptions): Promise<void>;
}

// ---- Clock and Logger --------------------------------------------------------

export interface Clock {
  now(): Date;
  /** Wait `ms`. Rejects early when `signal` aborts, so a poll loop notices cancellation at once. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** A progress update for a long operation (mirrors the CLI shell's status line). */
export interface ProgressUpdate {
  /** Coarse stage, e.g. `'queue'`, `'poll'`, `'download'`. */
  phase: string;
  /** Human-readable detail, e.g. `'shot 3/12 PROCESSING 41s'`. */
  detail?: string;
  current?: number;
  total?: number;
}

export interface Logger {
  debug(message: string, ...details: unknown[]): void;
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
  progress?(update: ProgressUpdate): void;
}

// ---- Aggregate ---------------------------------------------------------------

/** Everything core's loop needs from its host. */
export interface HarnessPorts {
  references: ReferenceStore;
  images: ImageProbe;
  vision: VisionJudge;
  video: VideoBackend;
  clock: Clock;
  logger: Logger;
}
