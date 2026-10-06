// ---------------------------------------------------------------------------
// QA steps (`qa-storyboard`, `qa-videos`), one unit of work each, over the
// ports.
//
// Storyboard QA: `storyboardQaInput` says what one panel's check sends (the
// images to attach, the prompts, the request parameters); the host resolves
// the images, and `checkStoryboardPanel` walks the model chain for that one
// panel: the chosen reader, then the paired vision companion, then UNCHECKED
// (rule 55). Video QA: the free programmatic probes (head-glitch luma scan,
// boundary luma jumps) over `ImageProbe`, mid-beat frame sampling, per-unit
// identity and the one cross-unit identity call over `VisionJudge` (rule 52).
//
// No loops over a plan here: which shots or units to check, in what order,
// progress, and writing the report are each host's control flow. The CLI's
// loops are `runStoryboardQa` / `runVideoQa` in src/mini-drama/qa-loops.ts.
// ---------------------------------------------------------------------------

import type { ImageProbe, MediaRef, VisionJudge } from '../ports.js';
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
  type ShotQaResult,
  type StoryboardQaReply,
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
  type VideoQaVerdict,
} from './video-qa.js';

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The host's view of a character's reference sheet (`characters/<slug>/front.png` on the CLI). */
export type CharacterSheetLookup = (name: string) => Promise<MediaRef | undefined>;

// ---- Storyboard QA ---------------------------------------------------------

/** One image a panel check wants, in send order. The host resolves each to a `MediaRef`. */
export type StoryboardQaImage =
  /** The shot's own panel. Always first; without it the shot is MISSING. */
  | { kind: 'panel'; shot: ShotScript }
  /** A character's reference sheet (the first two characters of the shot). Left out when the host has none. */
  | { kind: 'sheet'; character: string }
  /** The nearest earlier panel in the same location, for spatial continuity. Always last; left out when the host has none. */
  | { kind: 'prior-panel'; shot: ShotScript };

/** Everything one panel's QA request carries apart from the image bytes. Pure data. */
export interface StoryboardQaInput {
  shot: ShotScript;
  images: StoryboardQaImage[];
  systemPrompt: string;
  /** The user prompt when every listed image is attached (it describes the prior panel when one is listed). */
  userPrompt: string;
  /** The user prompt when the prior panel is listed but the host has none. Equal to `userPrompt` when none is listed. */
  userPromptWithoutPriorPanel: string;
  maxTokens: number;
  temperature: number;
  /** The request's label (`shot NNN QA`). */
  label: string;
}

/**
 * What one storyboard panel's QA sends: the panel, up to two character sheets
 * and the nearest prior panel from the same location (looked up in the whole
 * script, `shots`, not just the shots being checked), the rubric, and the
 * request parameters.
 */
export function storyboardQaInput(
  shot: ShotScript,
  shots: ReadonlyArray<ShotScript>,
  series: SeriesState,
): StoryboardQaInput {
  const images: StoryboardQaImage[] = [{ kind: 'panel', shot }];
  for (const character of shot.characters.slice(0, 2)) images.push({ kind: 'sheet', character });
  const prior = priorShotInLocation(shots, shot);
  if (prior) images.push({ kind: 'prior-panel', shot: prior });

  const location = shot.location ? getLocation(series, shot.location) : undefined;
  const prompt = (note: string) => buildStoryboardQaUserPrompt({
    shot, characters: series.characters, location, priorPanelNote: note,
  });
  const withoutPrior = prompt('');
  return {
    shot,
    images,
    systemPrompt: STORYBOARD_QA_SYSTEM_PROMPT,
    userPrompt: prior ? prompt(priorPanelNote(prior)) : withoutPrior,
    userPromptWithoutPriorPanel: withoutPrior,
    maxTokens: 4000,
    temperature: 0.3,
    label: `shot ${String(shot.shotNumber).padStart(3, '0')} QA`,
  };
}

export interface StoryboardPanelCheck {
  input: StoryboardQaInput;
  /**
   * The host's ref for each of `input.images`, same order. `undefined` means
   * the host has none: a missing panel makes the shot MISSING (no call), a
   * missing sheet or prior panel is left out of the request.
   */
  refs: ReadonlyArray<MediaRef | undefined>;
  /** The panel reader: an explicit `--model`, else the project's vision model. */
  model: string;
  /** The project's paired vision companion (same privacy tier); tried after `model` when it differs. */
  companionModel: string;
  /**
   * Awaited after each reply is parsed, inside the attempt: a throw counts as
   * a failed attempt for that model and the chain moves on. The CLI's
   * progress line throws on a reply with no `issues`, and that behaviour is
   * kept, so a shot can produce a reply and then still be retried.
   */
  onReply?(result: ShotQaResult, model: string, viaFallback: boolean): void | Promise<void>;
  /** Awaited when `model` failed and the chain moves on to `nextModel`. */
  onRetry?(model: string, nextModel: string, reason: string): void | Promise<void>;
  signal?: AbortSignal;
}

export type StoryboardPanelOutcome =
  /** No panel: FLAG-CRITICAL without a vision call. */
  | { status: 'missing'; result: ShotQaResult; model?: undefined; viaFallback: false }
  /** A model in the chain read the panel. `viaFallback` when it was the companion. */
  | { status: 'checked'; result: ShotQaResult; model: string; viaFallback: boolean }
  /** Every model in the chain failed: UNCHECKED (`result.errored`), never a pass (rules 46, 55). */
  | { status: 'unchecked'; result: ShotQaResult; model: string; viaFallback: boolean; reason: string };

/**
 * QA one panel: attach what the host has, then walk the model chain (the
 * chosen reader, then the paired vision companion; kimi-k3 dropped 5 of 14
 * vision reads on canopy-run, 2026-08-10, so the companion rescues
 * intermittent empties, never substitutes for an explicit `--model`).
 */
export async function checkStoryboardPanel(
  vision: VisionJudge,
  check: StoryboardPanelCheck,
): Promise<StoryboardPanelOutcome> {
  const { input, refs } = check;
  const { shot } = input;
  if (refs[0] === undefined) {
    return { status: 'missing', result: missingPanelResult(shot), viaFallback: false };
  }

  const images: MediaRef[] = [];
  let priorAttached = false;
  input.images.forEach((image, i) => {
    const ref = refs[i];
    if (ref === undefined) return;
    images.push(ref);
    if (image.kind === 'prior-panel') priorAttached = true;
  });
  const listsPrior = input.images.some(image => image.kind === 'prior-panel');
  const userPrompt = listsPrior && !priorAttached ? input.userPromptWithoutPriorPanel : input.userPrompt;

  const modelChain = storyboardQaModelChain(check.model, check.companionModel);
  let lastReason = '';
  for (const [chainIndex, model] of modelChain.entries()) {
    try {
      const reply = await vision.judge<StoryboardQaReply>({
        model,
        systemPrompt: input.systemPrompt,
        userPrompt,
        images,
        maxTokens: input.maxTokens,
        temperature: input.temperature,
        label: input.label,
        signal: check.signal,
      });
      const result = shotQaFromReply(shot, reply);
      await check.onReply?.(result, model, chainIndex > 0);
      return { status: 'checked', result, model, viaFallback: chainIndex > 0 };
    } catch (err) {
      lastReason = errorMessage(err);
      if (chainIndex < modelChain.length - 1) {
        await check.onRetry?.(model, modelChain[chainIndex + 1], lastReason);
      }
    }
  }
  return {
    status: 'unchecked',
    result: shotQaFailure(shot, lastReason),
    model: modelChain[modelChain.length - 1],
    viaFallback: modelChain.length > 1,
    reason: lastReason,
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

/** The characters a unit's identity check compares against: every character of its shots, first seen first. */
export function unitCharacterNames(
  unit: Pick<VideoQaUnit, 'shotNumbers'>,
  shots: ReadonlyArray<Pick<ShotScript, 'shotNumber' | 'characters'>>,
): string[] {
  return [...new Set(unit.shotNumbers
    .flatMap(n => shots.find(s => s.shotNumber === n)?.characters ?? []))];
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

// ---- One unit's verdict out of a report -------------------------------------

/** One unit's share of a `VideoQaReport`. */
export type VideoQaUnitVerdict =
  | {
    unitId: string;
    status: 'checked';
    /** The worst of its own findings (below), on the report's scale. */
    verdict: VideoQaVerdict;
    issues: string[];
    /** Which checks ran on the unit and what each said, one line each. */
    notes: string[];
    /** Its identity result, when the report has one. */
    identity?: UnitIdentityResult;
    headGlitch?: HeadGlitchFinding;
    /** The join into this unit (the boundary whose `toUnit` it is), when it was flagged. */
    boundaryIn?: BoundaryFinding;
    /** The cross-unit check named this unit as drifting from the protagonist's majority identity. */
    drifting: boolean;
  }
  | {
    unitId: string;
    /** A vision call this unit's verdict depends on failed: UNCHECKED, never a pass (rules 46, 52). */
    status: 'unchecked';
    reason: string;
    issues: string[];
  };

const VERDICT_RANK: Record<VideoQaVerdict, number> = {
  PASS: 0, 'FLAG-LOW': 1, 'FLAG-MODERATE': 2, 'FLAG-CRITICAL': 3,
};
const worse = (a: VideoQaVerdict, b: VideoQaVerdict): VideoQaVerdict => (VERDICT_RANK[b] > VERDICT_RANK[a] ? b : a);

/**
 * One unit's verdict, read out of a whole report with the same weights as
 * `summarizeVideoQa`: a head glitch on the unit and a failing join into it
 * are FLAG-CRITICAL, a warning join is FLAG-LOW, its identity verdict counts
 * as given, and drifting in the cross-unit check takes that check's verdict.
 * So a report that passes has no unit worse than FLAG-MODERATE, and every
 * FLAG-CRITICAL unit is counted in the report's `criticals`. (A cross-unit
 * FLAG-CRITICAL that names no drifting unit fails the report without marking
 * any one unit.)
 *
 * UNCHECKED when the unit's identity call failed or the cross-unit call
 * failed: the unit was never fully read.
 */
export function videoQaUnitVerdict(report: VideoQaReport, unitId: string): VideoQaUnitVerdict {
  const identity = report.unitIdentity.find(u => u.unitId === unitId);
  const failed = [
    ...(identity?.errored ? identity.issues : []),
    ...(report.crossUnit.errored ? report.crossUnit.issues : []),
  ];
  if (identity?.errored || report.crossUnit.errored) {
    return {
      unitId,
      status: 'unchecked',
      reason: failed.join('; ') || 'A vision check failed.',
      issues: failed,
    };
  }

  const issues: string[] = [];
  const notes: string[] = [];
  let verdict: VideoQaVerdict = 'PASS';

  if (identity) {
    verdict = worse(verdict, identity.verdict);
    issues.push(...identity.issues);
    notes.push(`identity: ${identity.verdict}`);
  } else {
    notes.push(report.model === 'programmatic-only'
      ? 'identity: not run (programmatic checks only)'
      : 'identity: not run (no frame with a character)');
  }

  const headGlitch = report.headGlitches.find(g => g.unitId === unitId);
  if (headGlitch) {
    verdict = worse(verdict, 'FLAG-CRITICAL');
    issues.push(`head glitch at frame ${headGlitch.frameIndex} (luma jump ${headGlitch.lumaDelta.toFixed(1)})`);
  }
  notes.push(headGlitch ? 'head glitch: found' : 'head glitch: none');

  const boundaryIn = report.boundaries.find(b => b.toUnit === unitId);
  if (boundaryIn) {
    verdict = worse(verdict, boundaryIn.severity === 'fail' ? 'FLAG-CRITICAL' : 'FLAG-LOW');
    issues.push(`luma jump ${boundaryIn.lumaDelta.toFixed(1)} at the cut from ${boundaryIn.fromUnit} (${boundaryIn.severity})`);
    notes.push(`join from ${boundaryIn.fromUnit}: ${boundaryIn.severity}`);
  }

  const drifting = report.crossUnit.driftingUnits.includes(unitId);
  if (drifting) {
    verdict = worse(verdict, report.crossUnit.verdict);
    issues.push(...report.crossUnit.issues);
    notes.push(`cross-unit: drifting (${report.crossUnit.verdict})`);
  }

  return {
    unitId,
    status: 'checked',
    verdict,
    issues,
    notes,
    ...(identity ? { identity } : {}),
    ...(headGlitch ? { headGlitch } : {}),
    ...(boundaryIn ? { boundaryIn } : {}),
    drifting,
  };
}
