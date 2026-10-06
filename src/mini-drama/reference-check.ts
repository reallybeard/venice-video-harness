// ---------------------------------------------------------------------------
// Reference check (`lock-character`)
//
// A single vision call that asks: "does the locked reference sheet show what
// the character's description says?" Panels and every shot copy the
// reference, so a wrong one is cheapest to catch here, once, at lock time.
//
// The result is stored on `Character.referenceCheck` (see
// `core/series/types.ts`) and is INFORMATIONAL: `lock-character` prints it
// and moves on. It never gates the lock, and a failed vision call leaves the
// field untouched rather than recording a false verdict.
//
// The call shape mirrors `video-qa.ts` (`client.chatJson` with data-URI
// images) so the two read-back paths stay on the same intelligence layer.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { VeniceClient } from '../venice/client.js';
import type { Character, ReferenceCheck, SeriesState } from 'venice-video-harness/core/series/types.js';
import { getCharacterDir } from '../series/manager.js';

/** The slice of `VeniceClient` the check needs; tests pass a stub. */
export type ReferenceCheckClient = Pick<VeniceClient, 'chatJson'>;

/**
 * Primary reference angle, in slot precedence (`anchor.png` outranks
 * `front.png` -- same order as `panel-approval.ts` and the video slots).
 */
export const REFERENCE_CHECK_CANDIDATES = ['anchor.png', 'front.png', 'three-quarter.png'] as const;

const SYSTEM_PROMPT = `You are a casting continuity checker for a film production.
You will be shown ONE reference image of a character and the character's locked written description.
Decide whether the image depicts what the description says: gender presentation, apparent age, build, hair, skin, distinguishing features, and wardrobe where the description specifies it.
Ignore art style, framing, lighting, and background. Do not nitpick details the description does not mention.
Respond with JSON only: {"pass": boolean, "issues": string[], "summary": string}
"issues" lists each concrete mismatch (empty when pass is true). "summary" is one or two plain sentences.`;

const toDataUri = (p: string) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;

/**
 * Resolve the reference image the check will read, or `undefined` when the
 * character has no generated sheet yet (lock-character runs before
 * generate-character-references in some flows -- nothing to check).
 */
export function resolveReferenceCheckTarget(
  series: SeriesState,
  character: Pick<Character, 'name'>,
): { absPath: string; ref: string } | undefined {
  const charDir = getCharacterDir(series, character.name);
  for (const file of REFERENCE_CHECK_CANDIDATES) {
    const absPath = join(charDir, file);
    if (existsSync(absPath)) {
      return { absPath, ref: relative(series.outputDir, absPath).split('\\').join('/') };
    }
  }
  return undefined;
}

/**
 * Run the check. Returns `undefined` when there is no reference on disk;
 * throws when the vision call fails (the caller decides whether that is
 * worth more than a warning -- `lock-character` treats it as one).
 */
export async function checkCharacterReference(
  client: ReferenceCheckClient,
  model: string,
  series: SeriesState,
  character: Character,
): Promise<ReferenceCheck | undefined> {
  const target = resolveReferenceCheckTarget(series, character);
  if (!target) return undefined;

  const description = [
    character.fullDescription || character.description,
    character.wardrobe ? `Wardrobe: ${character.wardrobe}` : '',
    character.age ? `Age: ${character.age}` : '',
    character.gender ? `Gender: ${character.gender}` : '',
  ].filter(Boolean).join('\n');

  const parsed = await client.chatJson<{ pass?: unknown; issues?: unknown; summary?: unknown }>({
    model,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `Character: ${character.name}\n\nLocked description:\n${description}\n\nDoes the image show this character?`,
    images: [toDataUri(target.absPath)],
    maxTokens: 1000,
    temperature: 0.2,
    label: `${character.name} reference check`,
  });

  const issues = Array.isArray(parsed.issues)
    ? parsed.issues.filter((i): i is string => typeof i === 'string')
    : [];
  return {
    ref: target.ref,
    pass: parsed.pass === true,
    issues,
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
  };
}

/** One-line rendering for the CLI. */
export function formatReferenceCheck(check: ReferenceCheck): string {
  const head = `  Reference check (${check.ref}): ${check.pass ? 'PASS' : 'MISMATCH'} — ${check.summary}`;
  if (check.issues.length === 0) return head;
  return `${head}\n${check.issues.map(i => `    - ${i}`).join('\n')}`;
}
