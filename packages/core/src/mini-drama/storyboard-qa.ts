// ---------------------------------------------------------------------------
// Storyboard panel QA (`qa-storyboard`): the pure half.
//
// The rubric, the per-shot result and report shapes, and the decisions taken
// over them. Reading panels and reference sheets, the vision call and its
// model fallback, and writing qa-report.json stay in the CLI command
// (src/mini-drama/cli.ts).
// ---------------------------------------------------------------------------

import type { Character, Location, ShotScript } from '../series/types.js';

export type QaVerdict = 'PASS' | 'FLAG-CRITICAL' | 'FLAG-MODERATE' | 'FLAG-LOW';

export interface ShotQaResult {
  shotNumber: number;
  type: string;
  characters: string[];
  verdict: QaVerdict;
  issues: string[];
  notes: string;
  /** The vision call itself failed, so this shot was never actually read. */
  errored?: boolean;
}

export const STORYBOARD_QA_SYSTEM_PROMPT = `You are a visual QA analyst for an animated mini-drama series. Your job is to compare storyboard panels against character reference images, the series aesthetic, and adjacent panels to check for consistency issues.

For each panel, evaluate:
1. CHARACTER CONSISTENCY: Do characters match their reference images? Check hair color/style, facial features, body type, wardrobe, skin tone.
2. SETTING CONTINUITY: Does the environment match the shot description? Time of day, weather, location details.
3. COMPOSITION: Does the framing match the intended shot type and camera description?
4. SPATIAL CONTINUITY: Does the panel match the shot's stated blocking — is each character/object on the stated frame side, at the stated depth, facing the stated direction, positioned correctly relative to the named location landmarks? When a previous panel from the same location is provided, verify characters keep their screen sides and relative positions, eyelines/screen direction are preserved (180-degree rule), and landmarks have not moved, mirrored, or rearranged.

Respond ONLY in this exact JSON format (no markdown, no code fences):
{"verdict":"PASS|FLAG-CRITICAL|FLAG-MODERATE|FLAG-LOW","issues":["issue 1","issue 2"],"notes":"brief overall assessment"}

Verdict rules:
- PASS: Panel matches references, description, blocking, and spatial continuity well
- FLAG-CRITICAL: Major character identity mismatch (wrong hair color, wrong gender presentation, missing character) OR a spatial flip that breaks the scene (characters swapped sides, geography mirrored/rearranged vs the previous panel)
- FLAG-MODERATE: Noticeable wardrobe or feature deviation, wrong composition, character on the wrong side of frame vs the stated blocking, moved/relocated landmark
- FLAG-LOW: Minor stylistic drift or small placement deviation, acceptable for production`;

/** What the rubric asks the model to return. */
export interface StoryboardQaReply {
  verdict: QaVerdict;
  issues: string[];
  notes: string;
}

export interface StoryboardQaSummary {
  total: number;
  pass: number;
  flagCritical: number;
  flagModerate: number;
  flagLow: number;
  /** Shots whose vision call failed: unchecked, not low-severity (rule 46). */
  errored: number;
}

export interface StoryboardQaReport {
  episode: number;
  model: string;
  analyzedAt: string;
  summary: StoryboardQaSummary;
  results: ShotQaResult[];
}

/** Parse `--shots` ("3,5,7", "3-7", "1,4-6") into shot numbers. */
export function parseShotSelection(spec: string): Set<number> {
  const nums = new Set<number>();
  for (const part of spec.split(',')) {
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      for (let i = a; i <= b; i++) nums.add(i);
    } else {
      nums.add(Number(part));
    }
  }
  return nums;
}

/**
 * The vision models to try, in order: the chosen one, then the project's
 * paired vision companion (same privacy tier by construction) when it
 * differs. The companion rescues intermittent empties; it never replaces an
 * explicit `--model`.
 */
export function storyboardQaModelChain(qaModel: string, fallbackModel: string): string[] {
  return [qaModel, ...(fallbackModel !== qaModel ? [fallbackModel] : [])];
}

/** The nearest PRIOR shot in the same location, whose panel is attached for spatial continuity. */
export function priorShotInLocation(shots: ReadonlyArray<ShotScript>, shot: ShotScript): ShotScript | undefined {
  if (!shot.location) return undefined;
  return [...shots]
    .filter(s => s.location === shot.location && s.shotNumber < shot.shotNumber)
    .sort((a, b) => b.shotNumber - a.shotNumber)[0];
}

/** The user-prompt line describing the attached prior panel (it is the FINAL image). */
export function priorPanelNote(prior: ShotScript): string {
  return `The FINAL image is the previous panel in the same location (shot ${prior.shotNumber}`
    + (prior.blocking ? `, blocking: ${prior.blocking}` : '')
    + '). Check spatial continuity against it: same screen sides, preserved eyelines, unmoved landmarks.';
}

/**
 * The per-panel user prompt. The panel is image 1, the character reference
 * sheets follow it, and the prior same-location panel (when attached) is last.
 */
export function buildStoryboardQaUserPrompt(input: {
  shot: ShotScript;
  characters: ReadonlyArray<Character>;
  location?: Location;
  /** `priorPanelNote(prior)` when the prior panel image is attached, else ''. */
  priorPanelNote?: string;
}): string {
  const { shot, characters, location } = input;
  const charDescs = shot.characters.map(name => {
    const char = characters.find(c => c.name.toUpperCase() === name.toUpperCase());
    return char ? `${char.name}: ${char.description}, wearing ${shot.episodeWardrobe?.[name.toUpperCase()] ?? char.wardrobe}` : name;
  });

  return [
    `Analyze this storyboard panel (image 1) for shot ${shot.shotNumber}.`,
    `Shot type: ${shot.type}. Camera: ${shot.cameraMovement}.`,
    `Description: ${shot.panelDescription ?? shot.description}`,
    shot.blocking ? `Stated blocking: ${shot.blocking}` : '',
    location?.spatialAnchors ? `Location landmarks (fixed layout): ${location.spatialAnchors}` : '',
    shot.characters.length > 0
      ? `Characters in shot: ${charDescs.join('; ')}. Reference images follow the panel.`
      : 'No characters expected in this shot. Verify the scene is empty of people.',
    input.priorPanelNote ?? '',
  ].filter(Boolean).join('\n');
}

/** A shot with no panel on disk: critical, the panel was never generated. */
export function missingPanelResult(shot: ShotScript): ShotQaResult {
  return {
    shotNumber: shot.shotNumber, type: shot.type, characters: shot.characters,
    verdict: 'FLAG-CRITICAL', issues: ['Panel file missing'], notes: 'No panel generated',
  };
}

export function shotQaFromReply(shot: ShotScript, reply: StoryboardQaReply): ShotQaResult {
  return {
    shotNumber: shot.shotNumber, type: shot.type, characters: shot.characters,
    ...reply,
  };
}

/**
 * A shot no model in the chain managed to read. It is UNCHECKED (`errored`),
 * carried as FLAG-LOW for the verdict field only; the summary counts it
 * separately so it can never read as a clean pass.
 */
export function shotQaFailure(shot: ShotScript, reason: string): ShotQaResult {
  return {
    shotNumber: shot.shotNumber, type: shot.type, characters: shot.characters,
    verdict: 'FLAG-LOW', issues: [`QA analysis failed: ${reason}`], notes: 'Vision API error',
    errored: true,
  };
}

export function summarizeStoryboardQa(results: ReadonlyArray<ShotQaResult>): StoryboardQaSummary {
  return {
    total: results.length,
    pass: results.filter(r => r.verdict === 'PASS').length,
    flagCritical: results.filter(r => r.verdict === 'FLAG-CRITICAL').length,
    flagModerate: results.filter(r => r.verdict === 'FLAG-MODERATE').length,
    flagLow: results.filter(r => r.verdict === 'FLAG-LOW').length,
    errored: results.filter(r => r.errored).length,
  };
}

/** Suggest `qa-approve` only when nothing is critical AND every shot was read. */
export function storyboardQaClean(summary: Pick<StoryboardQaSummary, 'flagCritical' | 'errored'>): boolean {
  return summary.flagCritical === 0 && summary.errored === 0;
}

/**
 * The `qa-approve` gate (rule 55): a report with criticals or unchecked shots
 * blocks approval unless the operator forces it. Reads a possibly partial
 * on-disk summary.
 */
export function storyboardApprovalBlock(
  summary: { flagCritical?: number; errored?: number } | undefined,
): { blocked: boolean; criticalCount: number; uncheckedCount: number } {
  const criticalCount = summary?.flagCritical ?? 0;
  const uncheckedCount = summary?.errored ?? 0;
  return { blocked: criticalCount > 0 || uncheckedCount > 0, criticalCount, uncheckedCount };
}
