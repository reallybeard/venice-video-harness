// ---------------------------------------------------------------------------
// Reference slot allocator (@Image1..@ImageN)
//
// Central bookkeeping for the flat reference_image_urls array on @Image-tag
// models (Seedance 2.0 R2V family, HappyHorse 1.1 R2V). The @ImageN index in
// the prompt MUST match the push order of reference_image_urls in the queue
// body, so both the prompt builder and the video generator consume the SAME
// ordered slot list built here.
//
// Slot order (within the per-model budget, default 9 on Seedance R2V):
//   1. One primary angle per character (front.png)      — identity
//   2. Storyboard blocking plate(s) for the shot's beat — PROTECTED
//   3. Location angles (wide, then medium, then detail) — environment
//   4. Second character angles (three-quarter.png)      — extra identity
//
// Overflow policy (user decision 2026-07-30): drop second character angles
// first, then extra location angles; storyboard plates are protected and
// dropped only if characters + plates alone exceed the budget.
// ---------------------------------------------------------------------------

import type { SeriesState, ShotScript } from '../series/types.js';
import { getMaxReferenceImages } from '../series/types.js';
import type { ReferenceSet } from '../series/references.js';
import { getLocation } from '../series/locations.js';

export type ReferenceSlotKind =
  | 'character-primary'
  | 'character-angle'
  | 'storyboard'
  | 'location';

export interface ReferenceSlot {
  /** 1-based index — @Image<imageIndex> in the prompt. */
  imageIndex: number;
  kind: ReferenceSlotKind;
  /**
   * The image, as the host names it: an absolute path on the CLI, an asset
   * id in a browser (`ReferenceImage.ref`). The planner never opens it.
   */
  ref: string;
  /** @deprecated Alias of `ref` (always a path on the CLI). Removed next major. */
  path: string;
  /** Character name (character slots), location slug, or storyboard slug. */
  label: string;
  /** Prompt role clause emitted verbatim (without the @ImageN prefix). */
  roleClause: string;
}

export interface ReferenceSlotPlan {
  slots: ReferenceSlot[];
  /** Character name -> primary slot imageIndex (for @ImageN name substitution). */
  characterSlotByName: Map<string, number>;
  /** Human-readable notes about what was dropped due to budget. */
  dropped: string[];
}

interface CandidateSlot {
  kind: ReferenceSlotKind;
  ref: string;
  label: string;
  roleClause: string;
}

export interface ReferenceSlotPlanOptions {
  characterNames?: string[];
}

// North (the hero plate) first, then the derived same-wall plates
// (south/east/west), then the legacy names (only present on pre-2026-10-05
// projects). The derived plates are all multi-edits of the north plate, so
// they depict ONE coherent space — safe to send together as "same place,
// different wall". The ORDER now lives in the ReferenceSet (the CLI builds it
// in reference-set-from-disk.ts with this same list); here the names only
// pick the role clause for a plate's `wall`.

/**
 * Build the ordered reference slot plan for a shot on an @Image-tag model.
 *
 * The returned slots array is the exact push order of reference_image_urls;
 * @ImageN in the prompt = slots[N-1]. Characters always occupy the first
 * slots (one primary angle each) so drop decisions never renumber them.
 *
 * `refs` is the shot's `ReferenceSet` — the images as data (paths on the
 * CLI, asset ids in a browser). The planner never touches disk; the CLI
 * builds the set with `referenceSetFromDisk`.
 */
export function buildReferenceSlotPlan(
  series: SeriesState,
  shot: ShotScript,
  modelId: string,
  refs: ReferenceSet,
  options: ReferenceSlotPlanOptions = {},
): ReferenceSlotPlan {
  const budget = getMaxReferenceImages(modelId);
  const dropped: string[] = [];

  const charNames = options.characterNames ?? shot.characters;
  const resolvedChars = charNames
    .map(name => series.characters.find(c => c.name.toUpperCase() === name.toUpperCase()))
    .filter((c): c is SeriesState['characters'][number] => Boolean(c));

  // --- Tier 1: one primary angle per character ---
  // anchor.png outranks the generated sheets: it is a frame harvested from an
  // APPROVED render (harvest-anchor), so it shows the exact rendered identity
  // later units must match — the strongest anti-drift reference available.
  const primary: CandidateSlot[] = [];
  for (const char of resolvedChars) {
    const ref = refs.characters
      .find(c => c.name.toUpperCase() === char.name.toUpperCase())
      ?.primary?.ref;
    if (!ref) continue;
    primary.push({
      kind: 'character-primary',
      ref,
      label: char.name,
      roleClause: `is ${char.name} — use this reference for ${char.name}'s face, hair, and wardrobe`,
    });
  }

  // --- Tier 2: storyboard blocking plate (PROTECTED) ---
  const storyboard: CandidateSlot[] = [];
  if (shot.storyboardRef) {
    if (refs.storyboard) {
      storyboard.push({
        kind: 'storyboard',
        ref: refs.storyboard.ref,
        label: shot.storyboardRef,
        roleClause:
          'is the storyboard blocking reference — it shows where the characters are ' +
          'positioned in the location and in relation to each other; use it ONLY for ' +
          'composition, blocking, and spatial relationships. Take each character\'s ' +
          'appearance from their own reference image, and the environment from the ' +
          'location references. It is not a character and not a style reference.',
      });
    } else {
      dropped.push(`storyboard ref "${shot.storyboardRef}" (not found on disk)`);
    }
  }

  // --- Tier 3: location angles ---
  const location: CandidateSlot[] = [];
  if (shot.location) {
    const loc = getLocation(series, shot.location);
    if (loc) {
      const plates = refs.locations.find(l => l.slug === loc.slug)?.plates ?? [];
      const angleRole: Record<string, string> = {
        'north.png': 'a wide establishing plate of the location, facing the north wall',
        'south.png': 'the south wall of the same location',
        'east.png': 'the east wall of the same location',
        'west.png': 'the west wall of the same location',
        'wide.png': 'a wide establishing angle of the location',
        'angle-2.png': 'another angle of the same location',
        'angle-3.png': 'another angle of the same location',
        'angle-4.png': 'another angle of the same location',
        'medium.png': 'a second angle of the same location',
        'detail.png': 'a third angle of the same location (detail)',
      };
      // Custom angles (operator-generated extra coverage beyond the canonical
      // set, e.g. reverse-angle.png) arrive in the set after the canonical
      // plates, in stable name order (reference-set-from-disk.ts).
      const canonical = new Set([
        'north.png', 'south.png', 'east.png', 'west.png',
        'wide.png', 'angle-2.png', 'angle-3.png', 'angle-4.png', 'medium.png', 'detail.png',
      ]);

      let angleCount = 0;
      for (const plate of plates) {
        const f = `${plate.wall}.png`;
        angleCount += 1;
        const customName = canonical.has(f) ? null : f.replace(/\.png$/i, '').replace(/-/g, ' ');
        const anglePhrase = angleCount === 1
          ? `is the location environment reference (${loc.name}) — match its setting, architecture, and lighting; it is not a character`
          : customName
            ? `is another angle of the same location (${loc.name}: ${customName}) — same place, different angle; keep the environment consistent with it`
            : `is ${angleRole[f] ?? 'another angle of the same location'} (${loc.name}) — same place, different angle; keep the environment consistent with it`;
        location.push({
          kind: 'location',
          ref: plate.ref,
          label: loc.slug,
          roleClause: anglePhrase,
        });
      }
    }
  }

  // --- Tier 4: second character angles ---
  const charAngles: CandidateSlot[] = [];
  for (const char of resolvedChars) {
    // The set's angles already exclude the primary and are in preference
    // order (three-quarter, profile, full-body on the CLI); take the first.
    const primaryRef = primary.find(s => s.label === char.name)?.ref;
    const ref = refs.characters
      .find(c => c.name.toUpperCase() === char.name.toUpperCase())
      ?.angles.find(a => a.ref !== primaryRef)?.ref;
    if (!ref) continue;
    charAngles.push({
      kind: 'character-angle',
      ref,
      label: char.name,
      roleClause: `is a second angle of ${char.name} — same person as ${char.name}'s primary reference`,
    });
  }

  // --- Budget allocation ---
  // Priority: primaries > storyboard (protected) > location angles (first
  // angle prioritized over char angles; extra angles below char angles is
  // NOT the chosen policy — user chose: drop char angles first, then extra
  // location angles, storyboard protected. So the fill order is:
  //   primaries, storyboard, location[0], charAngles, location[1..]
  // and the DROP order (reverse fill) is: location[1..] last-in-first-out,
  // then charAngles, then location[0], then storyboard.
  // To express "drop second character angles first, then extra location
  // angles" we fill in this order:
  //   primaries, storyboard, ALL location angles, charAngles
  // so charAngles overflow first, then trailing location angles.
  const fillOrder: CandidateSlot[] = [
    ...primary,
    ...storyboard,
    ...location,
    ...charAngles,
  ];

  const slots: ReferenceSlot[] = [];
  for (const candidate of fillOrder) {
    if (slots.length >= budget) {
      dropped.push(`${candidate.kind} "${candidate.label}" (over ${budget}-image budget for ${modelId})`);
      continue;
    }
    slots.push({
      imageIndex: slots.length + 1,
      ...candidate,
      path: candidate.ref,
    });
  }

  const characterSlotByName = new Map<string, number>();
  for (const slot of slots) {
    if (slot.kind === 'character-primary') {
      characterSlotByName.set(slot.label.toUpperCase(), slot.imageIndex);
    }
  }

  return { slots, characterSlotByName, dropped };
}
