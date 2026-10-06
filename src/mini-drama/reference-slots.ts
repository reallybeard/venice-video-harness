// ---------------------------------------------------------------------------
// Reference slot allocator (@Image1..@ImageN), CLI side.
//
// The planner itself is pure and lives in core
// (`venice-video-harness/core/mini-drama/reference-slots.js`); it takes the
// shot's `ReferenceSet` as data. This module keeps the CLI's signature: when
// no set is passed it builds one from disk (`referenceSetFromDisk`) and
// delegates.
// ---------------------------------------------------------------------------

import type { SeriesState, ShotScript } from 'venice-video-harness/core/series/types.js';
import type { ReferenceSet } from 'venice-video-harness/core/series/references.js';
import { isReferenceSet } from 'venice-video-harness/core/series/references.js';
import {
  buildReferenceSlotPlan as planFromReferenceSet,
  type ReferenceSlotPlan,
  type ReferenceSlotPlanOptions,
} from 'venice-video-harness/core/mini-drama/reference-slots.js';
import { referenceSetFromDisk } from './reference-set-from-disk.js';

export type {
  ReferenceSlotKind,
  ReferenceSlot,
  ReferenceSlotPlan,
  ReferenceSlotPlanOptions,
} from 'venice-video-harness/core/mini-drama/reference-slots.js';

/**
 * Build the ordered reference slot plan for a shot on an @Image-tag model.
 * See core's `buildReferenceSlotPlan` for the slot order and budget policy.
 */
export function buildReferenceSlotPlan(
  series: SeriesState,
  shot: ShotScript,
  modelId: string,
  refs: ReferenceSet,
  options?: ReferenceSlotPlanOptions,
): ReferenceSlotPlan;
/**
 * @deprecated Legacy CLI signature: probes the project directory via
 * `referenceSetFromDisk(series, shot, options)` and plans from that. Pass a
 * `ReferenceSet` instead (or call core's planner directly).
 */
export function buildReferenceSlotPlan(
  series: SeriesState,
  shot: ShotScript,
  modelId: string,
  options?: ReferenceSlotPlanOptions,
): ReferenceSlotPlan;
export function buildReferenceSlotPlan(
  series: SeriesState,
  shot: ShotScript,
  modelId: string,
  refsOrOptions?: ReferenceSet | ReferenceSlotPlanOptions,
  maybeOptions?: ReferenceSlotPlanOptions,
): ReferenceSlotPlan {
  if (!isReferenceSet(refsOrOptions)) {
    const legacyOptions = refsOrOptions ?? {};
    return planFromReferenceSet(
      series, shot, modelId,
      referenceSetFromDisk(series, shot, legacyOptions),
      legacyOptions,
    );
  }
  return planFromReferenceSet(series, shot, modelId, refsOrOptions, maybeOptions);
}
