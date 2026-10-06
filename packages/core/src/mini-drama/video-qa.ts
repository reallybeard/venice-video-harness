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
