// ---------------------------------------------------------------------------
// Generation steps: the decisions an episode render makes per unit, each a
// pure function a host calls while it walks the plan its own way.
//
//   resolveUnitShots        which shots each unit renders (cursor first)
//   generationUnitContext   what a unit knows about its neighbours
//   unitFrameTargets        chain or panel at the start, next panel or natural at the end
//   renderFailureDisposition  whether a failed render may be retried, and at what cost
//
// The walk itself (unit order, dispatch, concurrency, progress, how long to
// wait between multi-shot attempts) is each host's control flow. The CLI's is
// `generateEpisodeVideos` in src/mini-drama/video-generator.ts: units one
// after another, a multi-shot unit retried every `MULTISHOT_RETRY_DELAY_MS`
// until it lands or its failure is final. Each unit ends in core's
// `renderVideo`.
//
// Pure: no timers, no IO, no Node APIs.
// ---------------------------------------------------------------------------

import type { MediaRef } from '../ports.js';
import type { GenerationPlan, GenerationUnit, ShotScript } from '../series/types.js';
import { FacesOffModelError } from '../venice/faces-off.js';
import type { VideoRefusal } from '../venice/refusal.js';
import { VideoJobGoneError, VideoJobPollError, VideoJobTimeoutError } from '../venice/render-job.js';
import { VideoGenerationFailedError } from '../venice/video-errors.js';

/** The CLI's wait between multi-shot attempts. */
export const MULTISHOT_RETRY_DELAY_MS = 15_000;

/**
 * The shots of each unit, in plan order. Suffixed inserts ("13b") share
 * their base shotNumber, so a lookup by number would hand "13" the insert's
 * shot; the plan is built from `shots` in order with each shot in exactly one
 * unit, so shots are taken with a sequential cursor, and a number lookup is
 * only the fallback for hand-edited plans. Unknown numbers are dropped.
 */
export function resolveUnitShots(shots: ReadonlyArray<ShotScript>, plan: GenerationPlan): ShotScript[][] {
  const byNumber = new Map(shots.map(shot => [shot.shotNumber, shot]));
  let cursor = 0;
  return plan.units.map(unit => unit.shotNumbers
    .map(shotNumber => {
      const candidate = shots[cursor];
      if (candidate && candidate.shotNumber === shotNumber) {
        cursor += 1;
        return candidate;
      }
      return byNumber.get(shotNumber);
    })
    .filter((shot): shot is ShotScript => Boolean(shot)));
}

/** What a unit knows about its neighbours. It feeds the start and end frames, so the request body. */
export interface GenerationUnitContext {
  /** The last clip an earlier unit rendered in this run (a chained start frame comes from it). */
  previousRenderedShot?: MediaRef;
  /** The last shot of the nearest earlier unit that has shots, rendered or not. */
  previousShot?: ShotScript;
  /** The next unit's first shot number (an end-frame target). */
  nextShotNumber?: number;
}

/**
 * The context of unit `index`. `unitShots` is `resolveUnitShots(shots, plan)`;
 * `renderedSoFar` is every clip the run has saved before this unit, in
 * timeline order (state only the host has: a unit that was skipped or saved
 * nothing adds none).
 */
export function generationUnitContext(
  plan: GenerationPlan,
  unitShots: ReadonlyArray<ReadonlyArray<ShotScript>>,
  index: number,
  renderedSoFar: ReadonlyArray<MediaRef>,
): GenerationUnitContext {
  let previousShot: ShotScript | undefined;
  for (let i = index - 1; i >= 0 && !previousShot; i--) {
    const shots = unitShots[i] ?? [];
    previousShot = shots[shots.length - 1];
  }
  return {
    previousRenderedShot: renderedSoFar[renderedSoFar.length - 1],
    previousShot,
    nextShotNumber: plan.units[index + 1]?.shotNumbers[0],
  };
}

export interface UnitFrameTargets {
  /**
   * `chain`: the last frame of `context.previousRenderedShot` is the start
   * image. `panel`: the unit's first storyboard panel is (a unit with a
   * reference-slot plan sends none; that choice is the request plan's).
   */
  start: 'chain' | 'panel';
  /** `next-panel`: the next unit's first panel is the end image. `natural`: no end image. */
  end: 'next-panel' | 'natural';
  /** Set when `end` is `next-panel`. */
  nextShotNumber?: number;
  /** The unit asked for the next panel as its end target, but the host has no such panel. */
  endFallback?: 'next-panel-missing';
}

/**
 * The start and end images a unit renders against. A unit chains only when
 * the planner chose `previous-last-frame` (a chain transition, no scene
 * boundary, no new characters) and an earlier unit of this run rendered a
 * clip that still exists. It targets the next panel only when the planner
 * chose `next-panel-target`, a next unit exists and the host has its panel.
 */
export function unitFrameTargets(
  unit: Pick<GenerationUnit, 'startFrameStrategy' | 'endFrameStrategy'>,
  context: Pick<GenerationUnitContext, 'previousRenderedShot' | 'nextShotNumber'>,
  facts: {
    /** Whether the host has the next unit's first panel. */
    hasNextPanel: boolean;
    /** Whether `context.previousRenderedShot` can still be read. Default: true when it is set. */
    hasPreviousClip?: boolean;
  },
): UnitFrameTargets {
  const chain = unit.startFrameStrategy === 'previous-last-frame'
    && context.previousRenderedShot !== undefined
    && (facts.hasPreviousClip ?? true);
  const start = chain ? 'chain' : 'panel';

  if (unit.endFrameStrategy !== 'next-panel-target' || context.nextShotNumber === undefined) {
    return { start, end: 'natural' };
  }
  if (!facts.hasNextPanel) {
    return { start, end: 'natural', endFallback: 'next-panel-missing' };
  }
  return { start, end: 'next-panel', nextShotNumber: context.nextShotNumber };
}

/**
 * Errors no multi-shot retry can fix. A FAILED render
 * (`VideoGenerationFailedError`) has already cleared its pending-job record,
 * so a retry re-queues and re-bills the same body. A faces-off refusal
 * (`FacesOffModelError`) is thrown before the queue call, on the same images
 * every time. `renderFailureDisposition(err).final` is true for both.
 */
export function isFinalMultiShotError(err: unknown): boolean {
  return err instanceof VideoGenerationFailedError || err instanceof FacesOffModelError;
}

export interface RenderFailureDisposition {
  kind: 'cancelled' | 'failed' | 'refused' | 'faces-off' | 'timed-out' | 'poll-failed' | 'gone' | 'other';
  /** No automatic retry may follow: the same request fails the same way, re-bills, or the operator cancelled. */
  final: boolean;
  /** The render's pending-job record is left in place, so running it again re-attaches instead of queueing. */
  recordKept: boolean;
  /** A provider content-policy refusal (Venice's `provider_content_policy`). */
  providerRefusal: boolean;
  /**
   * Whether trying again pays again for a render that was already charged.
   * `unknown` for an error core cannot classify: a queue call that failed
   * with a 5xx or a transport error may still have queued and billed.
   */
  retryRebills: 'yes' | 'no' | 'unknown';
}

const ABORT_ERROR_NAMES = new Set(['AbortError', 'TimeoutError', 'OperationAbortedError']);

function refusalOf(err: unknown): VideoRefusal | undefined {
  const refusal = (err as { refusal?: Partial<VideoRefusal> } | null | undefined)?.refusal;
  return refusal && (refusal.kind === 'face-screening' || refusal.kind === 'provider-content-policy')
    ? refusal as VideoRefusal
    : undefined;
}

/**
 * What a failed render means for a retry. A host's automatic retry (the CLI's
 * multi-shot loop) stops on `final`; a manual retry button can warn when
 * `retryRebills` is not `no`.
 *
 * - The host's abort (`AbortError`, `TimeoutError`, `OperationAbortedError`):
 *   final; a queued job stays recorded and re-attaches next run.
 * - A classified refusal (any error carrying a `VideoRefusal` as `.refusal`,
 *   like the CLI's `VideoRefusalError`): final. A face-screening refusal was
 *   never charged; a provider refusal re-bills unless its credits were
 *   refunded (and a refunded one has already had its one retry in the queue
 *   handshake).
 * - `VideoGenerationFailedError`: final; the record is cleared, so a retry
 *   queues and pays again.
 * - `FacesOffModelError`: final; thrown before any queue call.
 * - `VideoJobTimeoutError` / `VideoJobPollError`: not final; the record is
 *   kept, so a retry re-attaches without paying.
 * - `VideoJobGoneError`: not final; the record is cleared and a retry queues
 *   a fresh, paid render.
 * - Anything else: not final, and whether the attempt billed is unknown.
 */
export function renderFailureDisposition(err: unknown): RenderFailureDisposition {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  if (typeof name === 'string' && ABORT_ERROR_NAMES.has(name)) {
    return { kind: 'cancelled', final: true, recordKept: true, providerRefusal: false, retryRebills: 'no' };
  }
  const refusal = refusalOf(err);
  if (refusal) {
    const providerRefusal = refusal.kind === 'provider-content-policy';
    return {
      kind: 'refused',
      final: true,
      recordKept: false,
      providerRefusal,
      retryRebills: providerRefusal && refusal.refusal?.creditsRefunded !== true ? 'yes' : 'no',
    };
  }
  if (err instanceof VideoGenerationFailedError) {
    return { kind: 'failed', final: true, recordKept: false, providerRefusal: false, retryRebills: 'yes' };
  }
  if (err instanceof FacesOffModelError) {
    return { kind: 'faces-off', final: true, recordKept: false, providerRefusal: false, retryRebills: 'no' };
  }
  if (err instanceof VideoJobTimeoutError) {
    return { kind: 'timed-out', final: false, recordKept: true, providerRefusal: false, retryRebills: 'no' };
  }
  if (err instanceof VideoJobPollError) {
    return { kind: 'poll-failed', final: false, recordKept: true, providerRefusal: false, retryRebills: 'no' };
  }
  if (err instanceof VideoJobGoneError) {
    return { kind: 'gone', final: false, recordKept: false, providerRefusal: false, retryRebills: 'yes' };
  }
  return { kind: 'other', final: false, recordKept: false, providerRefusal: false, retryRebills: 'unknown' };
}
