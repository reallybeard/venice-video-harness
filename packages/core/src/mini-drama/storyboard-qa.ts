// ---------------------------------------------------------------------------
// Storyboard panel QA (`qa-storyboard`): the pure half.
//
// The rubric, the per-shot result and report shapes, and the decisions taken
// over them. Reading panels and reference sheets, the vision call and its
// model fallback, and writing qa-report.json stay in the CLI command
// (src/mini-drama/cli.ts).
// ---------------------------------------------------------------------------

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
