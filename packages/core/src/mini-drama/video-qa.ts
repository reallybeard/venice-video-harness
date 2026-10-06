// ---------------------------------------------------------------------------
// Post-render video QA (`qa-videos`): the pure half.
//
// Report shapes and the vision rubrics. Frame extraction (ffmpeg), luma
// probing, file reads/writes and the vision call itself live in
// src/mini-drama/video-qa.ts; everything here is plain data in, plain data
// out, so a browser host can run the same checks over its own frames.
// ---------------------------------------------------------------------------

export type VideoQaVerdict = 'PASS' | 'FLAG-CRITICAL' | 'FLAG-MODERATE' | 'FLAG-LOW';

export interface UnitFrameSample {
  unitId: string;
  shotNumber: number;
  /** Seconds into the UNIT master where the frame was grabbed. */
  atSec: number;
  framePath: string;
}

export interface HeadGlitchFinding {
  unitId: string;
  /** 0-based frame index where the spike occurred. */
  frameIndex: number;
  /** Mean-luma delta that triggered the finding. */
  lumaDelta: number;
}

export interface BoundaryFinding {
  fromUnit: string;
  toUnit: string;
  lumaDelta: number;
  severity: 'warn' | 'fail';
}

export interface UnitIdentityResult {
  unitId: string;
  verdict: VideoQaVerdict;
  issues: string[];
  /** True when the vision call itself failed — the unit is UNCHECKED, not passed. */
  errored?: boolean;
}

export interface CrossUnitResult {
  verdict: VideoQaVerdict;
  issues: string[];
  /** Unit ids the model judged to not match the majority identity. */
  driftingUnits: string[];
  errored?: boolean;
}

export interface VideoQaReport {
  episode: number;
  model: string;
  analyzedAt: string;
  headGlitches: HeadGlitchFinding[];
  boundaries: BoundaryFinding[];
  unitIdentity: UnitIdentityResult[];
  crossUnit: CrossUnitResult;
  summary: {
    units: number;
    criticals: number;
    errored: number;
    passed: boolean;
  };
}

export const IDENTITY_SYSTEM_PROMPT = `You are a film-continuity QA analyst. You receive rendered VIDEO FRAMES from one generation unit of a film, followed by the official character reference sheet(s). Judge whether the character(s) in the frames match the reference: face/body design, hair or shell color and style, wardrobe, and signature accessories. Characters may be non-human (drones, machines, creatures) — the reference sheet defines what they look like; never flag a shot merely because no human is visible when the referenced character is not human. Rendered frames are mid-action, so allow motion blur, unusual angles, and partial occlusion — flag identity substance, not rendering softness. If the referenced character is not visible or too small/occluded to judge in every frame, use verdict FLAG-LOW with issue "character not clearly visible" — never FLAG-CRITICAL for absence alone (the frame may be a scripted insert or an empty beat).
Respond with JSON only: {"verdict": "PASS" | "FLAG-CRITICAL" | "FLAG-MODERATE" | "FLAG-LOW", "issues": string[], "notes": string}
FLAG-CRITICAL means a viewer would read a visible character as a different person/design (wrong hair color, different face, wrong shell/body design, missing signature wardrobe element).`;

export const CROSS_UNIT_SYSTEM_PROMPT = `You are a film-continuity QA analyst. Every image you receive is a rendered frame from a DIFFERENT generation unit of one film, in film order, and each SHOULD show the same protagonist. Your single question: across the frames where the protagonist is clearly visible, does the protagonist read as the same person — same face, same hair color and style, same wardrobe and signature accessories?
Frames where the protagonist is absent, heavily occluded, facing away, or too small to judge go in unclearFrames and MUST NOT be counted as drift. Only put a frame in driftingFrames when the protagonist is clearly visible and reads as a different person.
Respond with JSON only: {"verdict": "PASS" | "FLAG-CRITICAL" | "FLAG-MODERATE" | "FLAG-LOW", "issues": string[], "driftingFrames": number[], "unclearFrames": number[], "notes": string}
driftingFrames and unclearFrames list 1-based frame indexes. FLAG-CRITICAL means at least one clearly-visible frame reads as a different person.`;

// ---- Programmatic checks over measured numbers ---------------------------

export const HEAD_GLITCH_WINDOW_FRAMES = 12;
export const HEAD_GLITCH_LUMA_THRESHOLD = 28;
/** Boundary mean-luma jump that fails the join. */
export const BOUNDARY_LUMA_FAIL = 60;
/** Boundary mean-luma jump that warns. */
export const BOUNDARY_LUMA_WARN = 35;

/**
 * Detect the Seedance head-flash in a unit's head-frame lumas: within the
 * first `windowFrames` frames, a frame whose luma jumps by more than
 * `threshold` from its neighbour and reverts within 3 frames. A hard scene
 * change holds its new level; a glitch flash does not.
 */
export function findHeadGlitch(
  lumas: number[],
  unitId: string,
  options: { windowFrames?: number; threshold?: number } = {},
): HeadGlitchFinding | undefined {
  const windowFrames = options.windowFrames ?? HEAD_GLITCH_WINDOW_FRAMES;
  const threshold = options.threshold ?? HEAD_GLITCH_LUMA_THRESHOLD;
  for (let i = 1; i < Math.min(lumas.length, windowFrames); i++) {
    const jump = Math.abs(lumas[i] - lumas[i - 1]);
    if (jump < threshold) continue;
    // Does it revert toward the pre-jump level within 3 frames?
    const base = lumas[i - 1];
    for (let j = i + 1; j <= Math.min(i + 3, lumas.length - 1); j++) {
      if (Math.abs(lumas[j] - base) < threshold / 2) {
        return { unitId, frameIndex: i, lumaDelta: Number(jump.toFixed(1)) };
      }
    }
  }
  return undefined;
}

/** Classify the luma jump across one unit join. `undefined` when it is within tolerance. */
export function classifyBoundary(
  fromUnit: string,
  toUnit: string,
  prevLuma: number,
  nextLuma: number,
): BoundaryFinding | undefined {
  const delta = Math.abs(nextLuma - prevLuma);
  if (delta > BOUNDARY_LUMA_FAIL) return { fromUnit, toUnit, lumaDelta: Number(delta.toFixed(1)), severity: 'fail' };
  if (delta > BOUNDARY_LUMA_WARN) return { fromUnit, toUnit, lumaDelta: Number(delta.toFixed(1)), severity: 'warn' };
  return undefined;
}

/** Where to grab a segment's mid-beat frame, clamped inside the unit master. */
export function midBeatSampleSec(
  segment: { startOffsetSec: number; durationSec: number },
  unitDurationSec: number,
): number {
  return Math.min(segment.startOffsetSec + segment.durationSec / 2, Math.max(unitDurationSec - 0.1, 0));
}

// ---- Vision prompts and replies -------------------------------------------

/** How many rendered frames / reference sheets one identity call carries. */
export const IDENTITY_MAX_FRAMES = 3;
export const IDENTITY_MAX_REFERENCES = 2;

/** What the identity rubric asks the model to return. */
export interface UnitIdentityReply {
  verdict: VideoQaVerdict;
  issues: string[];
  notes: string;
}

/** What the cross-unit rubric asks the model to return. */
export interface CrossUnitReply {
  verdict: VideoQaVerdict;
  issues: string[];
  driftingFrames?: number[];
  unclearFrames?: number[];
  notes: string;
}

export function buildUnitIdentityUserPrompt(unitId: string, frameCount: number, referenceNames: string[]): string {
  return `The first ${Math.min(frameCount, IDENTITY_MAX_FRAMES)} image(s) are rendered frames from unit ${unitId}. The remaining image(s) are the official reference sheet(s) for: ${referenceNames.join(', ')}. Do the rendered characters match their references?`;
}

export function unitIdentityFromReply(unitId: string, reply: UnitIdentityReply): UnitIdentityResult {
  return { unitId, verdict: reply.verdict, issues: reply.issues ?? [] };
}

/** A unit whose identity call failed: UNCHECKED, not passed. */
export function unitIdentityFailure(unitId: string, message: string): UnitIdentityResult {
  return { unitId, verdict: 'FLAG-LOW', issues: [`identity QA failed: ${message}`], errored: true };
}

export function buildCrossUnitUserPrompt(frameCount: number, protagonistName: string): string {
  return `${frameCount} frames, one per generation unit, in film order. The protagonist is ${protagonistName}. Across the frames where ${protagonistName} is clearly visible, is this the same person?`;
}

/**
 * Map the cross-unit reply's 1-based frame indexes back to unit ids. Unclear
 * frames become an issue line, never drift.
 */
export function crossUnitFromReply(reply: CrossUnitReply, frameUnitIds: string[]): CrossUnitResult {
  const drifting = (reply.driftingFrames ?? [])
    .map(index => frameUnitIds[index - 1])
    .filter((id): id is string => Boolean(id));
  const issues = [...(reply.issues ?? [])];
  const unclear = (reply.unclearFrames ?? [])
    .map(index => frameUnitIds[index - 1])
    .filter((id): id is string => Boolean(id));
  if (unclear.length > 0) {
    issues.push(`protagonist not clearly visible in: ${unclear.join(', ')} (not counted as drift)`);
  }
  return { verdict: reply.verdict, issues, driftingUnits: drifting };
}

/** A cross-unit call that failed: UNCHECKED, not passed. */
export function crossUnitFailure(message: string): CrossUnitResult {
  return { verdict: 'FLAG-LOW', issues: [`cross-unit QA failed: ${message}`], driftingUnits: [], errored: true };
}

/** The cross-unit result before (or without) a vision call. */
export function emptyCrossUnitResult(): CrossUnitResult {
  return { verdict: 'PASS', issues: [], driftingUnits: [] };
}

// ---- Protagonist and hero frames -----------------------------------------

/** The character appearing in the most shots; ties go to the first seen. */
export function pickProtagonist(shots: ReadonlyArray<{ characters: string[] }>): string | undefined {
  const charCounts = new Map<string, number>();
  for (const shot of shots) for (const c of shot.characters) {
    charCounts.set(c, (charCounts.get(c) ?? 0) + 1);
  }
  return [...charCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** One frame per unit, in unit order, from a shot the protagonist is in. */
export function pickHeroFrames(
  unitIds: string[],
  samples: UnitFrameSample[],
  shots: ReadonlyArray<{ shotNumber: number; characters: string[] }>,
  protagonist: string,
): UnitFrameSample[] {
  return unitIds
    .map(unitId => samples.find(s => s.unitId === unitId
      && (shots.find(sh => sh.shotNumber === s.shotNumber)?.characters ?? [])
        .some(c => c.toUpperCase() === protagonist.toUpperCase())))
    .filter((s): s is UnitFrameSample => Boolean(s));
}

// ---- Summary and gate -----------------------------------------------------

/**
 * Count criticals and unchecked results. A vision call that failed is
 * unchecked, never a pass and never a low-severity finding, and an unchecked
 * report does not pass (rule 46 / 52).
 */
export function summarizeVideoQa(input: {
  units: number;
  headGlitches: HeadGlitchFinding[];
  boundaries: BoundaryFinding[];
  unitIdentity: UnitIdentityResult[];
  crossUnit: CrossUnitResult;
}): VideoQaReport['summary'] {
  const { headGlitches, boundaries, unitIdentity, crossUnit } = input;
  const errored = unitIdentity.filter(r => r.errored).length + (crossUnit.errored ? 1 : 0);
  const criticals = headGlitches.length
    + boundaries.filter(b => b.severity === 'fail').length
    + unitIdentity.filter(r => !r.errored && r.verdict === 'FLAG-CRITICAL').length
    + (!crossUnit.errored && crossUnit.verdict === 'FLAG-CRITICAL' ? 1 : 0);
  return { units: input.units, criticals, errored, passed: criticals === 0 && errored === 0 };
}

/**
 * Does a video-qa report block `assemble-episode`? Only an explicit
 * `passed: false` does; a report without a summary is treated as missing.
 */
export function videoQaBlocksAssembly(report: { summary?: { passed?: boolean } } | undefined): boolean {
  return Boolean(report?.summary && report.summary.passed === false);
}
