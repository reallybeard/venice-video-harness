// ---------------------------------------------------------------------------
// Shot duration preflight -- pure. Plain data in, plain data out.
// ---------------------------------------------------------------------------

import type { GenerationPlan, ShotScript } from '../series/types.js';
import { getVideoModel, modelSupportsDuration } from '../venice/models.js';
import { parseShotDuration } from '../series/duration.js';

/**
 * Pre-flight check that every shot's requested duration is renderable on the
 * model it was routed to. Throws a single error listing all violations so the
 * operator can fix the script in one pass rather than fail-and-retry against
 * Venice (which returns HTTP 422 deep into the queue call with a generic
 * message).
 *
 * Examples this catches:
 *   - duration: "16s" routed to seedance-2-0-* (max 15s)
 *   - duration: "12s" routed to veo3.1-fast-image-to-video (max 8s)
 *   - duration: "8s" routed to wan-2-7-reference-to-video (max 10s, but step
 *     restriction — 8s not in [5s, 10s])
 */
export function assertShotDurationsValid(
  shots: ShotScript[],
  plan: GenerationPlan,
): void {
  type Violation = {
    shotNumber: number;
    duration: string;
    durationSec: number;
    model: string;
    maxSec: number;
    allowed: string[];
  };
  const violations: Violation[] = [];

  const shotById = new Map(shots.map(s => [s.shotNumber, s]));
  for (const unit of plan.units) {
    const model = unit.model;
    const modelSpec = getVideoModel(model);
    if (!modelSpec) {
      // Unknown model — registry may be stale. Don't block; the API will
      // surface the real error if the model is actually missing.
      continue;
    }
    // Montage units render as ONE generation: per-shot durations are beat
    // windows inside it, not renderable clips, so only the unit's total
    // duration is validated against the model ladder.
    if (unit.unitType === 'montage') {
      const unitSec = parseShotDuration(unit.duration);
      if (unitSec > modelSpec.maxDurationSec || !modelSpec.durations.includes(unit.duration)) {
        violations.push({
          shotNumber: unit.shotNumbers[0],
          duration: unit.duration,
          durationSec: unitSec,
          model,
          maxSec: modelSpec.maxDurationSec,
          allowed: modelSpec.durations,
        });
      }
      continue;
    }
    for (const shotNum of unit.shotNumbers) {
      const shot = shotById.get(shotNum);
      if (!shot) continue;
      const requestedSec = parseShotDuration(shot.duration);
      if (!Number.isFinite(requestedSec) || requestedSec <= 0) continue;
      if (requestedSec > modelSpec.maxDurationSec) {
        violations.push({
          shotNumber: shotNum,
          duration: shot.duration,
          durationSec: requestedSec,
          model,
          maxSec: modelSpec.maxDurationSec,
          allowed: modelSpec.durations,
        });
        continue;
      }
      // The model may have a stepped duration ladder (e.g. Wan 2.7 R2V only
      // accepts 5s/10s). Use modelSupportsDuration for the loose
      // (under-the-ceiling) check, then a strict membership check when the
      // model exposes an explicit ladder. Strict check catches 8s on Wan 2.7
      // R2V which modelSupportsDuration's lenient fallback would let through.
      const passesLenient = modelSupportsDuration(model, shot.duration);
      const passesStrict = modelSpec.durations.length === 0
        || modelSpec.durations.includes(shot.duration);
      if (!passesLenient || !passesStrict) {
        violations.push({
          shotNumber: shotNum,
          duration: shot.duration,
          durationSec: requestedSec,
          model,
          maxSec: modelSpec.maxDurationSec,
          allowed: modelSpec.durations,
        });
      }
    }
  }

  if (violations.length === 0) return;
  const lines = violations.map(v =>
    `  shot ${v.shotNumber}: duration "${v.duration}" (${v.durationSec}s) exceeds model "${v.model}" ceiling ${v.maxSec}s (allowed: ${v.allowed.join(', ') || '<none>'})`,
  );
  throw new Error(
    `Shot duration preflight failed for ${violations.length} shot(s):\n${lines.join('\n')}\n` +
    `Edit script.json and re-run, or update the model registry in packages/core/src/venice/models.ts if the ceiling has changed.`,
  );
}
