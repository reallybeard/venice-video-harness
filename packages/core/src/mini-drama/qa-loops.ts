// ---------------------------------------------------------------------------
// The QA loops (`qa-storyboard`, `qa-videos`) over the ports.
//
// Storyboard QA: per shot, attach the panel, up to two character sheets and
// the nearest prior panel from the same location, ask the vision judge, and
// on an empty reply or an error retry once on the project's paired vision
// companion before marking the shot UNCHECKED (rule 55). Video QA: the free
// programmatic checks (head-glitch luma scan, boundary luma jumps) over
// `ImageProbe`, then mid-beat frame sampling, per-unit identity and the one
// cross-unit identity call over `VisionJudge` (rule 52).
//
// Plain inputs, ports, a report out. Which files exist (panels, sheets, unit
// masters), where sampled frames go, printing and writing the report stay
// with the host; progress arrives as events the host renders.
// ---------------------------------------------------------------------------

import type { HarnessPorts, ImageProbe, MediaRef, VisionJudge } from '../ports.js';
import type { SeriesState, ShotScript } from '../series/types.js';
import { getLocation } from '../series/locations.js';
import {
  STORYBOARD_QA_SYSTEM_PROMPT,
  buildStoryboardQaUserPrompt,
  missingPanelResult,
  priorPanelNote,
  priorShotInLocation,
  shotQaFailure,
  shotQaFromReply,
  storyboardQaModelChain,
  summarizeStoryboardQa,
  type ShotQaResult,
  type StoryboardQaReply,
  type StoryboardQaReport,
} from './storyboard-qa.js';
import {
  CROSS_UNIT_SYSTEM_PROMPT,
  HEAD_GLITCH_WINDOW_FRAMES,
  IDENTITY_MAX_FRAMES,
  IDENTITY_MAX_REFERENCES,
  IDENTITY_SYSTEM_PROMPT,
  buildCrossUnitUserPrompt,
  buildUnitIdentityUserPrompt,
  classifyBoundary,
  crossUnitFailure,
  crossUnitFromReply,
  emptyCrossUnitResult,
  findHeadGlitch,
  midBeatSampleSec,
  pickHeroFrames,
  pickProtagonist,
  summarizeVideoQa,
  unitIdentityFailure,
  unitIdentityFromReply,
  type BoundaryFinding,
  type CrossUnitReply,
  type CrossUnitResult,
  type HeadGlitchFinding,
  type UnitFrameSample,
  type UnitIdentityReply,
  type UnitIdentityResult,
  type VideoQaReport,
} from './video-qa.js';

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The host's view of a character's reference sheet (`characters/<slug>/front.png` on the CLI). */
export type CharacterSheetLookup = (name: string) => Promise<MediaRef | undefined>;

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
 * QA one panel: build the image list and prompt, then walk the model chain.
 * Results are pushed onto `results` (a reply whose progress event throws is
 * pushed and then retried, so a shot can contribute more than one result;
 * see `StoryboardQaRun.onEvent`).
 */
async function checkStoryboardShot(
  vision: VisionJudge,
  run: StoryboardQaRun,
  shot: ShotScript,
  index: number,
  total: number,
  results: ShotQaResult[],
): Promise<void> {
  const emit = async (event: StoryboardQaEvent) => { await run.onEvent?.(event); };
  const shotNum = String(shot.shotNumber).padStart(3, '0');

  const panel = await run.panel(shot);
  if (panel === undefined) {
    const result = missingPanelResult(shot);
    results.push(result);
    await emit({ type: 'missing', index, total, shot, result });
    return;
  }

  const images: MediaRef[] = [panel];
  for (const charName of shot.characters.slice(0, 2)) {
    const sheet = await run.characterSheet(charName);
    if (sheet !== undefined) images.push(sheet);
  }

  // Spatial continuity: attach the nearest PRIOR panel from the same location
  // (when one exists) so the vision model can verify screen sides, eyelines
  // and landmark geography against actual coverage instead of prose alone.
  let prevPanelNote = '';
  const prior = priorShotInLocation(run.shots, shot);
  if (prior) {
    const priorPanel = await run.panel(prior);
    if (priorPanel !== undefined) {
      images.push(priorPanel);
      prevPanelNote = priorPanelNote(prior);
    }
  }

  const location = shot.location ? getLocation(run.series, shot.location) : undefined;
  const userPrompt = buildStoryboardQaUserPrompt({
    shot, characters: run.series.characters, location, priorPanelNote: prevPanelNote,
  });

  // The chosen model, then the paired vision companion. kimi-k3 dropped 5 of
  // 14 vision reads on canopy-run (2026-08-10); the companion is a rescue for
  // intermittent empties, never a substitute for an explicit --model.
  const modelChain = storyboardQaModelChain(run.model, run.companionModel);
  let lastReason = '';
  for (const [chainIndex, model] of modelChain.entries()) {
    try {
      const reply = await vision.judge<StoryboardQaReply>({
        model,
        systemPrompt: STORYBOARD_QA_SYSTEM_PROMPT,
        userPrompt,
        images,
        maxTokens: 4000,
        temperature: 0.3,
        label: `shot ${shotNum} QA`,
        signal: run.signal,
      });
      const result = shotQaFromReply(shot, reply);
      results.push(result);
      await emit({ type: 'checked', index, total, shot, result, model, viaFallback: chainIndex > 0 });
      return;
    } catch (err) {
      lastReason = errorMessage(err);
      if (chainIndex < modelChain.length - 1) {
        await emit({ type: 'retry', index, total, shot, model, nextModel: modelChain[chainIndex + 1], reason: lastReason });
      }
    }
  }
  const result = shotQaFailure(shot, lastReason);
  results.push(result);
  await emit({ type: 'unchecked', index, total, shot, result, reason: lastReason });
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

/** One rendered generation unit, as the host found it. */
export interface VideoQaUnit {
  unitId: string;
  /** The rendered unit master. */
  clip: MediaRef;
  shotNumbers: number[];
  /** Beat windows inside the master (montage units). Absent: one beat, the whole clip, `shotNumbers[0]`. */
  segments?: Array<{ shotNumber: number; startOffsetSec: number; durationSec: number }>;
}

/** The head-glitch scan for one unit master (`findHeadGlitch` over the probe's head lumas). */
export async function probeHeadGlitch(
  images: ImageProbe,
  clip: MediaRef,
  unitId: string,
  options: { windowFrames?: number; threshold?: number; signal?: AbortSignal } = {},
): Promise<HeadGlitchFinding | undefined> {
  const { signal, ...thresholds } = options;
  const windowFrames = thresholds.windowFrames ?? HEAD_GLITCH_WINDOW_FRAMES;
  const lumas = await images.frameLumas(clip, { frames: windowFrames + 4 }, { signal });
  return findHeadGlitch(lumas, unitId, thresholds);
}

/**
 * The luma jump across one unit join: the frame 0.2s before the end of
 * `from` against the frame 0.2s into `to`. `undefined` when either frame
 * could not be measured.
 */
export async function probeBoundary(
  images: ImageProbe,
  from: Pick<VideoQaUnit, 'unitId' | 'clip'>,
  to: Pick<VideoQaUnit, 'unitId' | 'clip'>,
  options: { signal?: AbortSignal } = {},
): Promise<{ prevLuma: number; nextLuma: number; finding?: BoundaryFinding } | undefined> {
  const { signal } = options;
  const prevDuration = await images.clipDuration(from.clip, { signal });
  const [prevLuma] = await images.frameLumas(from.clip, { startSec: Math.max(prevDuration - 0.2, 0), frames: 1 }, { signal });
  const [nextLuma] = await images.frameLumas(to.clip, { startSec: 0.2, frames: 1 }, { signal });
  if (prevLuma === undefined || nextLuma === undefined) return undefined;
  const finding = classifyBoundary(from.unitId, to.unitId, prevLuma, nextLuma);
  return finding ? { prevLuma, nextLuma, finding } : { prevLuma, nextLuma };
}

/**
 * One mid-beat frame per character-bearing shot of each unit, in unit order.
 * A frame the probe cannot extract is skipped. `frameRef` names where each
 * frame goes; without it (or when it returns `undefined`) the probe picks.
 */
export async function probeUnitFrames(
  images: ImageProbe,
  units: ReadonlyArray<VideoQaUnit>,
  shots: ReadonlyArray<ShotScript>,
  options: { frameRef?(unitId: string, shotNumber: number): MediaRef | undefined; signal?: AbortSignal } = {},
): Promise<UnitFrameSample[]> {
  const { signal } = options;
  const samples: UnitFrameSample[] = [];
  for (const unit of units) {
    const duration = await images.clipDuration(unit.clip, { signal });
    const segments = unit.segments && unit.segments.length > 0
      ? unit.segments
      : [{ shotNumber: unit.shotNumbers[0], startOffsetSec: 0, durationSec: duration }];
    for (const seg of segments) {
      const shot = shots.find(s => s.shotNumber === seg.shotNumber);
      if (!shot || shot.characters.length === 0) continue;
      const atSec = midBeatSampleSec(seg, duration);
      const outputRef = options.frameRef?.(unit.unitId, seg.shotNumber);
      try {
        const framePath = await images.extractFrame(unit.clip, { atSec }, { signal, ...(outputRef !== undefined ? { outputRef } : {}) });
        samples.push({ unitId: unit.unitId, shotNumber: seg.shotNumber, atSec, framePath });
      } catch {
        // No frame: the unit simply contributes fewer samples.
      }
    }
  }
  return samples;
}

/**
 * Per-unit identity: up to `IDENTITY_MAX_FRAMES` of the unit's frames, then
 * the sheets of its first `IDENTITY_MAX_REFERENCES` characters that have one.
 * No frames or no sheets: PASS without a call. A failed call is UNCHECKED.
 */
export async function judgeUnitIdentity(
  vision: VisionJudge,
  input: {
    model: string;
    unitId: string;
    frames: ReadonlyArray<UnitFrameSample>;
    characterNames: ReadonlyArray<string>;
    characterSheet: CharacterSheetLookup;
    signal?: AbortSignal;
  },
): Promise<UnitIdentityResult> {
  const { model, unitId, frames } = input;
  const images: MediaRef[] = frames.slice(0, IDENTITY_MAX_FRAMES).map(f => f.framePath);
  const refNames: string[] = [];
  for (const name of input.characterNames.slice(0, IDENTITY_MAX_REFERENCES)) {
    const sheet = await input.characterSheet(name);
    if (sheet !== undefined) {
      images.push(sheet);
      refNames.push(name);
    }
  }
  if (images.length === 0 || refNames.length === 0) {
    return { unitId, verdict: 'PASS', issues: [], errored: false };
  }
  try {
    const parsed = await vision.judge<UnitIdentityReply>({
      model,
      systemPrompt: IDENTITY_SYSTEM_PROMPT,
      userPrompt: buildUnitIdentityUserPrompt(unitId, frames.length, refNames),
      images,
      maxTokens: 2000,
      temperature: 0.2,
      label: `unit ${unitId} identity QA`,
      signal: input.signal,
    });
    return unitIdentityFromReply(unitId, parsed);
  } catch (err) {
    return unitIdentityFailure(unitId, errorMessage(err));
  }
}

/**
 * The cross-unit check: one hero frame per unit, all in ONE vision call, in
 * film order. Fewer than two frames: nothing to compare (PASS, no call).
 */
export async function judgeCrossUnitIdentity(
  vision: VisionJudge,
  input: {
    model: string;
    heroFrames: ReadonlyArray<UnitFrameSample>;
    protagonist: string;
    signal?: AbortSignal;
  },
): Promise<CrossUnitResult> {
  const { model, heroFrames, protagonist } = input;
  if (heroFrames.length < 2) {
    return emptyCrossUnitResult();
  }
  try {
    const parsed = await vision.judge<CrossUnitReply>({
      model,
      systemPrompt: CROSS_UNIT_SYSTEM_PROMPT,
      userPrompt: buildCrossUnitUserPrompt(heroFrames.length, protagonist),
      images: heroFrames.map(f => f.framePath),
      maxTokens: 2000,
      temperature: 0.2,
      label: 'cross-unit identity QA',
      signal: input.signal,
    });
    return crossUnitFromReply(parsed, heroFrames.map(f => f.unitId));
  } catch (err) {
    return crossUnitFailure(errorMessage(err));
  }
}

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
      const characterNames = [...new Set(unit.shotNumbers
        .flatMap(n => shots.find(s => s.shotNumber === n)?.characters ?? []))];
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
