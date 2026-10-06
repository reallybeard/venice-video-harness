// ---------------------------------------------------------------------------
// ReferenceSet from the project directory (CLI side).
//
// The @ImageN slot planner (reference-slots.ts) takes a `ReferenceSet` as
// data. This module is the ONLY place the CLI probes disk for reference
// images, and it does so with exactly the file rules the planner used before
// it took a set — same file-name lists, same order, same existsSync /
// readdirSync logic — so CLI behaviour is unchanged by construction:
//
//   character primary  anchor.png > front.png > three-quarter.png
//   character angles   three-quarter.png, profile.png, full-body.png
//                      (excluding whichever file is the primary)
//   location plates    north, south, east, west, then the legacy names
//                      (wide, angle-2..4, medium, detail), then any custom
//                      *.png in the location dir in stable name order
//                      (archives and `-pre-` strays excluded)
//   storyboard         storyboards/<storyboardRef>.png, if it exists
//
// `hasFace` is read from the image's provenance sidecar when one exists
// (`<image>.provenance.json`, the same bit `assertFacesOffCompatible` reads).
// ---------------------------------------------------------------------------

import { join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { SeriesState, ShotScript } from 'venice-video-harness/core/series/types.js';
import type {
  ReferenceImage,
  ReferenceSet,
  CharacterReferences,
  LocationReferences,
  CharacterAngleReference,
  LocationPlateReference,
} from 'venice-video-harness/core/series/references.js';
import {
  getCharacterDir,
  getLocationDir,
  getLocation,
  getStoryboardRefPath,
} from '../series/manager.js';

/** Primary identity candidates, in preference order. */
export const CHARACTER_PRIMARY_FILES = ['anchor.png', 'front.png', 'three-quarter.png'] as const;
/** Second-angle candidates, in preference order (the primary is excluded at build time). */
export const CHARACTER_ANGLE_FILES = ['three-quarter.png', 'profile.png', 'full-body.png'] as const;
/**
 * Canonical location plates: north (the hero plate) first, then the derived
 * same-wall plates (south/east/west), then the legacy names (only present on
 * pre-2026-10-05 projects). Custom `*.png` plates queue after these.
 */
export const LOCATION_PLATE_FILES = [
  'north.png', 'south.png', 'east.png', 'west.png',
  'wide.png', 'angle-2.png', 'angle-3.png', 'angle-4.png', 'medium.png', 'detail.png',
] as const;

export interface ReferenceSetFromDiskOptions {
  /**
   * Character names to build references for. Defaults to `shot.characters`.
   * Mirrors `buildReferenceSlotPlan`'s `characterNames` option so a caller
   * that overrides the shot's character list gets a set for the same names.
   */
  characterNames?: string[];
}

/** Sidecar path for an image (mirrors `src/venice/provenance.ts`). */
function sidecarPath(imagePath: string): string {
  return imagePath.replace(/\.(png|jpg|jpeg|webp)$/i, '.provenance.json');
}

/**
 * Read the rule-41 `hasFace` bit from an image's provenance sidecar.
 * Returns `undefined` when there is no sidecar, it is unreadable, or the
 * field is absent — the same "undecided" the faces-off preflight treats
 * defensively.
 */
export function readHasFaceSync(imagePath: string): boolean | undefined {
  const sidecar = sidecarPath(imagePath);
  if (!existsSync(sidecar)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(sidecar, 'utf-8')) as { hasFace?: unknown };
    return typeof parsed.hasFace === 'boolean' ? parsed.hasFace : undefined;
  } catch {
    return undefined;
  }
}

function imageAt(path: string): ReferenceImage {
  const hasFace = readHasFaceSync(path);
  return hasFace === undefined ? { ref: path } : { ref: path, hasFace };
}

function stem(file: string): string {
  return file.replace(/\.png$/i, '');
}

/**
 * Build the `ReferenceSet` for a shot by probing the project directory with
 * the CLI's file rules. Pure w.r.t. Venice; reads disk only.
 *
 * Characters that resolve to nothing on disk still get an entry (empty
 * `angles`, no `primary`) so the set reflects the shot; the planner skips
 * them. Locations that do not resolve in `series.locations` get no entry.
 */
export function referenceSetFromDisk(
  series: SeriesState,
  shot: ShotScript,
  options: ReferenceSetFromDiskOptions = {},
): ReferenceSet {
  const charNames = options.characterNames ?? shot.characters;
  const resolvedChars = charNames
    .map(name => series.characters.find(c => c.name.toUpperCase() === name.toUpperCase()))
    .filter((c): c is SeriesState['characters'][number] => Boolean(c));

  // --- Characters: primary + second angles ---
  const characters: CharacterReferences[] = [];
  for (const char of resolvedChars) {
    const dir = getCharacterDir(series, char.name);
    const primaryPath = CHARACTER_PRIMARY_FILES
      .map(f => join(dir, f))
      .find(p => existsSync(p));
    const angles: CharacterAngleReference[] = [];
    for (const f of CHARACTER_ANGLE_FILES) {
      const p = join(dir, f);
      if (!existsSync(p) || p === primaryPath) continue;
      angles.push({ ...imageAt(p), view: stem(f) });
    }
    characters.push({
      name: char.name,
      ...(primaryPath ? { primary: imageAt(primaryPath) } : {}),
      angles,
    });
  }

  // --- Storyboard blocking plate ---
  let storyboard: ReferenceImage | undefined;
  if (shot.storyboardRef) {
    const sbPath = getStoryboardRefPath(series, shot.storyboardRef);
    if (sbPath && existsSync(sbPath)) storyboard = imageAt(sbPath);
  }

  // --- Location plates ---
  const locations: LocationReferences[] = [];
  if (shot.location) {
    const loc = getLocation(series, shot.location);
    if (loc) {
      const dir = getLocationDir(series, loc.slug);
      // Custom angles (operator-generated extra coverage beyond the canonical
      // set, e.g. reverse-angle.png) queue after the canonical plates, in
      // stable name order. Archives and sidecar-less strays are excluded by
      // pattern.
      const canonical = new Set<string>(LOCATION_PLATE_FILES);
      let customAngles: string[] = [];
      try {
        customAngles = readdirSync(dir)
          .filter(f =>
            /\.png$/i.test(f)
            && !canonical.has(f)
            && !f.includes('archive')
            && !f.includes('-pre-'))
          .sort();
      } catch {
        // No location dir — canonical loop below reports nothing either.
      }

      const plates: LocationPlateReference[] = [];
      for (const f of [...LOCATION_PLATE_FILES, ...customAngles]) {
        const p = join(dir, f);
        if (!existsSync(p)) continue;
        plates.push({ ...imageAt(p), wall: stem(f) });
      }
      locations.push({ slug: loc.slug, plates });
    }
  }

  return {
    characters,
    locations,
    ...(storyboard ? { storyboard } : {}),
  };
}
