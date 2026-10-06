// ---------------------------------------------------------------------------
// The episode generation loop: walk a GenerationPlan's units in order, hand
// each to the host's renderer for its lane, and carry the chaining state
// (the last clip rendered, the previous unit's last shot, the next unit's
// first shot) from one unit to the next.
//
//   duration preflight ─▶ for each unit: resolve its shots ─▶ progress
//     ─▶ single | montage | multishot (retried until it lands) ─▶ collect
//
// The lanes themselves -- panels, keyframe pre-pass, TTS, splitting and
// cutting, metadata -- are disk layout and ffmpeg, so they stay with the host
// as a `GenerationUnitRenderer`; each one ends in core's `renderVideo`.
//
// Pure: no timers (Clock), no IO of its own, no Node APIs.
// ---------------------------------------------------------------------------

import type { Clock, Logger, MediaRef, PortCallOptions } from '../ports.js';
import type { GenerationPlan, GenerationUnit, ShotScript } from '../series/types.js';
import { assertShotDurationsValid } from './duration-preflight.js';

/** Wait between multi-shot attempts. */
export const MULTISHOT_RETRY_DELAY_MS = 15_000;

/** What a unit knows about its neighbours. */
export interface GenerationUnitContext {
  /** The last clip an earlier unit rendered (a chained start frame comes from it). */
  previousRenderedShot?: MediaRef;
  /** The previous unit's last shot, rendered or not. */
  previousShot?: ShotScript;
  /** The next unit's first shot number (an end-frame target). */
  nextShotNumber?: number;
}

/** The host's lanes. Each resolves with the per-shot clips it saved, in shot order (empty when it skipped). */
export interface GenerationUnitRenderer {
  single(shot: ShotScript, unit: GenerationUnit, context: GenerationUnitContext): Promise<MediaRef[]>;
  multishot(shots: ShotScript[], unit: GenerationUnit, context: GenerationUnitContext): Promise<MediaRef[]>;
  montage(shots: ShotScript[], unit: GenerationUnit, context: GenerationUnitContext): Promise<MediaRef[]>;
  /**
   * Errors the multi-shot retry rethrows instead of retrying: a cancelled
   * operation, and a classified refusal (the same request fails the same way,
   * and a refunded one has already had its retry).
   */
  isFinalError(err: unknown): boolean;
  /** Status and body of an HTTP error, for the retry warning. `undefined` for anything else. */
  describeHttpError?(err: unknown): { status: number; message: string; body: unknown } | undefined;
}

export interface GenerationLoopOptions extends PortCallOptions {
  /** Default `MULTISHOT_RETRY_DELAY_MS`. */
  multiShotRetryDelayMs?: number;
}

export interface GenerationLoopResult {
  /** Every clip saved, in timeline order. */
  videoPaths: MediaRef[];
  plan: GenerationPlan;
}

/**
 * The shots of each unit, in plan order. Suffixed inserts ("13b") share
 * their base shotNumber, so a lookup by number would hand "13" the insert's
 * shot; the plan is built from `shots` in order with each shot in exactly one
 * unit, so shots are taken with a sequential cursor, and a number lookup is
 * only the fallback for hand-edited plans. Unknown numbers are dropped.
 */
export function resolveUnitShots(shots: ShotScript[], plan: GenerationPlan): ShotScript[][] {
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

/**
 * Render a multi-shot unit, retrying until it lands. A failed attempt keeps
 * the multi-shot strategy (splitting the unit would trade the identity a
 * single generation holds for separate renders that drift). Only
 * `isFinalError` errors end it. The queue call itself is never retried
 * inside an attempt, and a recorded job is re-attached, so a retry does not
 * pay twice for a render that was queued.
 */
export async function renderMultiShotUntilSuccess(
  ports: { logger: Logger; clock: Clock },
  renderer: GenerationUnitRenderer,
  shots: ShotScript[],
  unit: GenerationUnit,
  context: GenerationUnitContext,
  options: GenerationLoopOptions = {},
): Promise<MediaRef[]> {
  const { logger, clock } = ports;
  const delayMs = options.multiShotRetryDelayMs ?? MULTISHOT_RETRY_DELAY_MS;
  let attempt = 1;

  for (;;) {
    try {
      if (attempt > 1) logger.info(`  ${unit.unitId}: retrying multi-shot render (attempt ${attempt})`);
      return await renderer.multishot(shots, unit, context);
    } catch (err) {
      if (renderer.isFinalError(err)) throw err;
      const http = renderer.describeHttpError?.(err);
      if (http) {
        logger.warn(`  ${unit.unitId}: multi-shot attempt ${attempt} failed (HTTP ${http.status}): ${http.message}`);
        logger.warn(`  Error body: ${JSON.stringify(http.body, null, 2)}`);
      } else {
        logger.warn(`  ${unit.unitId}: multi-shot attempt ${attempt} failed - ${err}`);
      }
      logger.warn(`  ${unit.unitId}: keeping multi-shot strategy, retrying in ${(delayMs / 1000).toFixed(0)}s`);
      attempt += 1;
      await clock.sleep(delayMs, options.signal);
    }
  }
}

/**
 * Render every unit of `plan`, in order. Fails fast on a duration the unit's
 * model cannot render, before any unit runs. A unit error ends the loop
 * (clips already saved stay on disk; re-running skips them).
 */
export async function runGenerationUnits(
  ports: { logger: Logger; clock: Clock },
  renderer: GenerationUnitRenderer,
  shots: ShotScript[],
  plan: GenerationPlan,
  options: GenerationLoopOptions = {},
): Promise<GenerationLoopResult> {
  assertShotDurationsValid(shots, plan);

  const { logger } = ports;
  const unitShots = resolveUnitShots(shots, plan);
  const videoPaths: MediaRef[] = [];
  let previousRenderedShot: MediaRef | undefined;
  let previousShot: ShotScript | undefined;

  for (let unitIndex = 0; unitIndex < plan.units.length; unitIndex++) {
    const unit = plan.units[unitIndex];
    const unitShotList = unitShots[unitIndex];
    if (unitShotList.length === 0) continue;
    const context: GenerationUnitContext = {
      previousRenderedShot,
      previousShot,
      nextShotNumber: plan.units[unitIndex + 1]?.shotNumbers[0],
    };

    logger.progress?.({
      phase: 'render',
      current: unitIndex + 1,
      total: plan.units.length,
      detail: `unit ${unitIndex + 1}/${plan.units.length} · shot ${unitShotList[0].shotNumber}`,
    });

    const saved = unit.unitType === 'single'
      ? await renderer.single(unitShotList[0], unit, context)
      : unit.unitType === 'montage'
        ? await renderer.montage(unitShotList, unit, context)
        : await renderMultiShotUntilSuccess(ports, renderer, unitShotList, unit, context, options);

    if (saved.length > 0) {
      videoPaths.push(...saved);
      previousRenderedShot = saved[saved.length - 1];
    }
    previousShot = unitShotList[unitShotList.length - 1];
    logger.info('');
  }

  return { videoPaths, plan };
}
