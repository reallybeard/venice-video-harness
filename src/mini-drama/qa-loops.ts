// ---------------------------------------------------------------------------
// The CLI's QA loops (`qa-storyboard`, `qa-videos`), composed from core's QA
// steps (`venice-video-harness/core/mini-drama/qa-steps.js`).
//
// Storyboard QA walks the selected shots and checks each panel with
// `checkStoryboardPanel`. Video QA runs the free programmatic checks over
// every unit and join, then frame sampling, per-unit identity and the one
// cross-unit identity call (rule 52). Every decision (what each request
// sends, the model chain, each verdict, the summary) is core's; the walk,
// the order and the progress events are this host's.
//
// Plain inputs, ports, a report out. Which files exist (panels, sheets, unit
// masters), where sampled frames go, printing and writing the report stay
// with the caller; progress arrives as events the caller renders.
// ---------------------------------------------------------------------------

import type { HarnessPorts, MediaRef } from 'venice-video-harness/core/ports.js';
import type { SeriesState, ShotScript } from 'venice-video-harness/core/series/types.js';
import {
  summarizeStoryboardQa,
  type ShotQaResult,
  type StoryboardQaReport,
} from 'venice-video-harness/core/mini-drama/storyboard-qa.js';
import {
  emptyCrossUnitResult,
  pickHeroFrames,
  pickProtagonist,
  summarizeVideoQa,
  type BoundaryFinding,
  type CrossUnitResult,
  type HeadGlitchFinding,
  type UnitIdentityResult,
  type VideoQaReport,
} from 'venice-video-harness/core/mini-drama/video-qa.js';
import {
  checkStoryboardPanel,
  judgeCrossUnitIdentity,
  judgeUnitIdentity,
  probeBoundary,
  probeHeadGlitch,
  probeUnitFrames,
  storyboardQaInput,
  unitCharacterNames,
  type CharacterSheetLookup,
  type VideoQaUnit,
} from './qa-steps.js';

// ---- Storyboard QA ---------------------------------------------------------

export type StoryboardQaEvent =
  /** No panel for the shot: recorded FLAG-CRITICAL without a vision call. */
  | { type: 'missing'; index: number; total: number; shot: ShotScript; result: ShotQaResult }
  /** A model in the chain read the panel. `viaFallback` when it was the companion. */
  | { type: 'checked'; index: number; total: number; shot: ShotScript; result: ShotQaResult; model: string; viaFallback: boolean }
  /** `model` failed (`reason`); the chain moves on to `nextModel`. */
  | { type: 'retry'; index: number; total: number; shot: ShotScript; model: string; nextModel: string; reason: string }
  /** Every model in the chain failed: the shot is UNCHECKED (`result.errored`). */
  | { type: 'unchecked'; index: number; total: number; shot: ShotScript; result: ShotQaResult; reason: string };

export interface StoryboardQaRun {
  episode: number;
  /** Characters (for the prompt) and locations (for landmark lines). */
  series: SeriesState;
  /** The whole script, in order: the prior same-location panel is looked up here, not in `check`. */
  shots: ReadonlyArray<ShotScript>;
  /** The shots to QA, in order. Default: every shot. */
  check?: ReadonlyArray<ShotScript>;
  /** The panel reader: an explicit `--model`, else the project's vision model. Recorded as the report's model. */
  model: string;
  /** The project's paired vision companion (same privacy tier); tried after `model` when it differs. */
  companionModel: string;
  /** The shot's storyboard panel, or `undefined` when there is none. */
  panel(shot: ShotScript): Promise<MediaRef | undefined>;
  characterSheet: CharacterSheetLookup;
  /**
   * Progress, awaited. A handler that throws on `checked` counts as a failed
   * attempt for that model (the CLI's progress line throws on a reply with no
   * `issues`, and that behaviour is kept).
   */
  onEvent?(event: StoryboardQaEvent): void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * QA one panel through core's steps. Results are pushed onto `results` (a
 * reply whose progress event throws is pushed and then retried, so a shot can
 * contribute more than one result; see `StoryboardQaRun.onEvent`).
 */
async function checkStoryboardShot(
  vision: HarnessPorts['vision'],
  run: StoryboardQaRun,
  shot: ShotScript,
  index: number,
  total: number,
  results: ShotQaResult[],
): Promise<void> {
  const emit = async (event: StoryboardQaEvent) => { await run.onEvent?.(event); };
  const input = storyboardQaInput(shot, run.shots, run.series);

  // Resolve the wanted images in order; no panel means MISSING, so stop there.
  const refs: Array<MediaRef | undefined> = [];
  for (const image of input.images) {
    const ref = image.kind === 'sheet' ? await run.characterSheet(image.character) : await run.panel(image.shot);
    refs.push(ref);
    if (image.kind === 'panel' && ref === undefined) break;
  }

  const outcome = await checkStoryboardPanel(vision, {
    input,
    refs,
    model: run.model,
    companionModel: run.companionModel,
    signal: run.signal,
    onReply: async (result, model, viaFallback) => {
      results.push(result);
      await emit({ type: 'checked', index, total, shot, result, model, viaFallback });
    },
    onRetry: (model, nextModel, reason) => emit({ type: 'retry', index, total, shot, model, nextModel, reason }),
  });
  if (outcome.status === 'missing') {
    results.push(outcome.result);
    await emit({ type: 'missing', index, total, shot, result: outcome.result });
  } else if (outcome.status === 'unchecked') {
    results.push(outcome.result);
    await emit({ type: 'unchecked', index, total, shot, result: outcome.result, reason: outcome.reason });
  }
}

/**
 * Storyboard QA over the vision judge. A shot no model managed to read is
 * UNCHECKED and counted in `summary.errored`, never as a pass (rules 46, 55).
 */
export async function runStoryboardQa(
  ports: Pick<HarnessPorts, 'vision' | 'clock'>,
  run: StoryboardQaRun,
): Promise<StoryboardQaReport> {
  const check = run.check ?? run.shots;
  const results: ShotQaResult[] = [];
  for (let i = 0; i < check.length; i++) {
    await checkStoryboardShot(ports.vision, run, check[i], i, check.length, results);
  }
  return {
    episode: run.episode,
    model: run.model,
    analyzedAt: ports.clock.now().toISOString(),
    summary: summarizeStoryboardQa(results),
    results,
  };
}

// ---- Video QA --------------------------------------------------------------

export type VideoQaEvent =
  | { type: 'head-glitch'; finding: HeadGlitchFinding }
  /** Every unit's head was scanned. */
  | { type: 'head-glitch-scan-done'; findings: HeadGlitchFinding[] }
  | { type: 'boundary'; finding: BoundaryFinding; prevLuma: number; nextLuma: number }
  /** Every join was measured. */
  | { type: 'boundary-scan-done'; findings: BoundaryFinding[] }
  /** Before the first vision step (frame sampling). The CLI resolves its API key here. */
  | { type: 'vision-start'; model: string }
  | { type: 'unit-identity'; result: UnitIdentityResult }
  | { type: 'cross-unit'; protagonist: string; frames: number; result: CrossUnitResult };

export interface VideoQaRun {
  episode: number;
  /** The rendered units, in assembly order. Units with no master are the host's to leave out. */
  units: ReadonlyArray<VideoQaUnit>;
  /** The whole script: characters per shot, and the protagonist (most shots). */
  shots: ReadonlyArray<ShotScript>;
  /** The vision model. Recorded as the report's model unless `skipVision`. */
  model: string;
  /** Only the free programmatic checks; the report's model is `programmatic-only`. */
  skipVision?: boolean;
  characterSheet: CharacterSheetLookup;
  /** Where each sampled frame goes. */
  frameRef?(unitId: string, shotNumber: number): MediaRef | undefined;
  /** Progress, awaited; a throw aborts the run (no report). */
  onEvent?(event: VideoQaEvent): void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * Post-render video QA: head glitches and boundary jumps (free), then
 * per-unit and cross-unit identity. A failing report blocks
 * `assemble-episode` (`videoQaBlocksAssembly`, rule 52).
 */
export async function runVideoQa(
  ports: Pick<HarnessPorts, 'images' | 'vision' | 'clock'>,
  run: VideoQaRun,
): Promise<VideoQaReport> {
  const { images, vision } = ports;
  const { units, shots, signal } = run;
  const emit = async (event: VideoQaEvent) => { await run.onEvent?.(event); };

  // ---- Layer 1: programmatic (free) ----
  const headGlitches: HeadGlitchFinding[] = [];
  for (const unit of units) {
    const finding = await probeHeadGlitch(images, unit.clip, unit.unitId, { signal });
    if (finding) {
      headGlitches.push(finding);
      await emit({ type: 'head-glitch', finding });
    }
  }
  await emit({ type: 'head-glitch-scan-done', findings: headGlitches });

  const boundaries: BoundaryFinding[] = [];
  for (let i = 1; i < units.length; i++) {
    const measured = await probeBoundary(images, units[i - 1], units[i], { signal });
    if (measured?.finding) {
      boundaries.push(measured.finding);
      await emit({ type: 'boundary', finding: measured.finding, prevLuma: measured.prevLuma, nextLuma: measured.nextLuma });
    }
  }
  await emit({ type: 'boundary-scan-done', findings: boundaries });

  // ---- Layer 2: vision ----
  const unitIdentity: UnitIdentityResult[] = [];
  let crossUnit: CrossUnitResult = emptyCrossUnitResult();
  if (!run.skipVision) {
    await emit({ type: 'vision-start', model: run.model });
    const samples = await probeUnitFrames(images, units, shots, { frameRef: run.frameRef, signal });

    // Per-unit identity vs the reference sheets.
    for (const unit of units) {
      const unitFrames = samples.filter(s => s.unitId === unit.unitId);
      if (unitFrames.length === 0) continue;
      const characterNames = unitCharacterNames(unit, shots);
      const result = await judgeUnitIdentity(vision, {
        model: run.model, unitId: unit.unitId, frames: unitFrames, characterNames,
        characterSheet: run.characterSheet, signal,
      });
      unitIdentity.push(result);
      await emit({ type: 'unit-identity', result });
    }

    // Cross-unit identity: one hero frame per unit, one call. The protagonist
    // is the character appearing in the most shots.
    const protagonist = pickProtagonist(shots);
    if (protagonist) {
      const heroFrames = pickHeroFrames(units.map(u => u.unitId), samples, shots, protagonist);
      crossUnit = await judgeCrossUnitIdentity(vision, { model: run.model, heroFrames, protagonist, signal });
      await emit({ type: 'cross-unit', protagonist, frames: heroFrames.length, result: crossUnit });
    }
  }

  const summary = summarizeVideoQa({ units: units.length, headGlitches, boundaries, unitIdentity, crossUnit });
  return {
    episode: run.episode,
    model: run.skipVision ? 'programmatic-only' : run.model,
    analyzedAt: ports.clock.now().toISOString(),
    headGlitches, boundaries, unitIdentity, crossUnit,
    summary,
  };
}
