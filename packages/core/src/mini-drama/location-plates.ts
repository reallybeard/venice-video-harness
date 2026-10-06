// ---------------------------------------------------------------------------
// Location reference plates: the pure half (compass plates 2026-10-05)
//
// THE PLATES ARE ONE COHERENT SPACE. Every location gets exactly four WIDE
// plates — `north`, `south`, `east`, `west` — one per wall/direction, giving
// 360 degrees of visual information. There are no medium or close-up plates.
// `north` is the ONLY from-scratch text-to-image generation — the hero
// establishing plate facing the north wall. Every other plate (`south`,
// `east`, `west`, and any custom coverage) is DERIVED by multi-editing the
// north plate with the edit model, the same anchor→derive pattern character
// references use. This is the fix for the old wide/medium/detail ladder,
// where each angle was an INDEPENDENT t2i call (same seed, different prompt)
// that produced three visibly different rooms — the video model was then
// handed three "same place" references that disagreed, and the environment
// drifted. Deriving from one plate guarantees every plate is the same
// physical space.
//
// This module builds the plate list and every prompt. The CLI's
// `src/mini-drama/location-generator.ts` runs them against Venice and disk;
// a browser host runs the same prompts through its own ports.
// ---------------------------------------------------------------------------

import type { AestheticProfile, Character, Location } from '../series/types.js';

/**
 * The one from-scratch plate: a wide shot facing the north wall.
 * Every other plate is derived from it.
 */
export const HERO_ANGLE = 'north';

/** Derived walls of the SAME location: south (reverse), east (right), west (left). */
export const DERIVED_ANGLES = ['south', 'east', 'west'] as const;

/**
 * The default plate set generated per location: north, south, east, west —
 * one wide plate per wall/direction for 360 degrees of visual information.
 * All four plates are wide shots; there is no medium or close-up plate.
 */
export const DEFAULT_LOCATION_ANGLES = [HERO_ANGLE, ...DERIVED_ANGLES] as const;

/**
 * Pre-compass plate names. Still recognized so an old project can regenerate
 * them, and still read by the reference-slot allocator when present on disk —
 * but no longer part of the default set. `wide` was the hero plate (now
 * `north`); `angle-2/3/4` were the derived angles (now `south`/`east`/`west`);
 * `medium`/`detail` were the retired distance ladder.
 */
export const LEGACY_LOCATION_ANGLES = ['wide', 'angle-2', 'angle-3', 'angle-4', 'medium', 'detail'] as const;

/** @deprecated Back-compat alias — the default compass plate set. */
export const LOCATION_ANGLES = DEFAULT_LOCATION_ANGLES;
export type LocationAngle = (typeof DEFAULT_LOCATION_ANGLES)[number];

/** The hero plate's `/image/generate` settings (cfg is overridable per call). */
export const HERO_PLATE_DEFAULTS = { cfgScale: 10, steps: 30, resolution: '1K' } as const;

/** Hero plate file names in lookup order: compass `north`, then legacy `wide`. */
export const HERO_PLATE_FILES = ['north.png', 'north.webp', 'wide.png', 'wide.webp'] as const;

const HERO_VIEW =
  'wide establishing shot facing the north wall of the location, the full north wall and environment visible, cinematic widescreen framing';

/**
 * Default re-framings for the derived compass plates. Room-agnostic and
 * grounded in the north base image the editor sees. Each LEADS with the new
 * foreground: a ">90° turn away from X" instruction phrased as a negative
 * ("window behind camera") tends to revert the edit to the master framing —
 * describing the wall that should FILL the new frame holds far better.
 * Every plate is a wide shot — no medium or close-up framings.
 */
const KNOWN_ANGLE_VIEWS: Record<string, string> = {
  south:
    'Reverse angle of the SAME room: place the camera on the opposite side and look back toward where the establishing shot was taken, so the south wall now fills the background. Wide shot, the full south wall visible.',
  west:
    'Turn the camera to face the LEFT-hand wall of the SAME room — the wall running along the left edge of the reference image (the west wall) now fills the frame, seen close to straight on. Wide shot, the full west wall visible.',
  east:
    'Turn the camera to face the RIGHT-hand wall of the SAME room — the wall running along the right edge of the reference image (the east wall) now fills the frame, seen close to straight on. Wide shot, the full east wall visible.',
  // Legacy names, kept so `--angles wide,angle-2,...` still works on old projects.
  'wide':
    'wide establishing shot facing the north wall of the location, the full north wall and environment visible, cinematic widescreen framing',
  'angle-2':
    'Reverse angle of the SAME room: place the camera on the opposite side and look back toward where the establishing shot was taken, so the far wall of the establishing view now fills the background. Wide shot, full wall visible.',
  'angle-3':
    'Turn the camera to face the LEFT-hand wall of the SAME room — the wall running along the left edge of the reference image now fills the frame, seen close to straight on. Wide shot, full wall visible.',
  'angle-4':
    'Turn the camera to face the RIGHT-hand wall of the SAME room — the wall running along the right edge of the reference image now fills the frame, seen close to straight on. Wide shot, full wall visible.',
  'medium':
    'a tighter medium view of the SAME room from roughly the establishing position, mid-distance framing of its key features',
  'detail':
    'a close detail view within the SAME room of one distinctive feature — texture and material detail, identical lighting',
};

/** Names that carry their own default view clause (no `--prompt` required). */
const KNOWN_ANGLE_NAMES = new Set<string>([
  HERO_ANGLE,
  ...DERIVED_ANGLES,
  ...LEGACY_LOCATION_ANGLES,
]);

export function isKnownLocationAngle(angle: string): boolean {
  return KNOWN_ANGLE_NAMES.has(angle);
}

/** The from-scratch plate: compass `north`, or legacy `wide`. */
export function isHeroAngle(angle: string): boolean {
  return angle === HERO_ANGLE || angle === 'wide';
}

/** Filesystem-safe custom-angle name: kebab-case, no path tricks. */
export function sanitizeAngleName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function locationAestheticString(aesthetic: AestheticProfile): string {
  return [
    aesthetic.style,
    aesthetic.palette,
    aesthetic.lighting,
    aesthetic.lensCharacteristics,
    aesthetic.filmStock ? `shot on ${aesthetic.filmStock}` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

export interface LocationAnglePlan {
  /** Plates to build, hero first. */
  angles: string[];
  /** The hero was not requested and not on disk, so it was prepended. */
  heroAdded: boolean;
}

/**
 * Resolves the requested plate list: canonical names pass through; anything
 * else becomes a sanitized custom angle, which needs `promptOverride` to
 * describe it. Deriving any plate needs the hero, so a missing hero is
 * prepended, and the hero always comes first.
 */
export function planLocationAngles(
  requested: readonly string[] | undefined,
  context: { heroExists: boolean; promptOverride?: string },
): LocationAnglePlan {
  let angles: string[] = requested?.length
    ? requested.map(angle =>
        KNOWN_ANGLE_NAMES.has(angle) ? angle : sanitizeAngleName(angle),
      ).filter(Boolean)
    : [...DEFAULT_LOCATION_ANGLES];

  const customWithoutPrompt = angles.filter(
    angle => !KNOWN_ANGLE_NAMES.has(angle) && !context.promptOverride,
  );
  if (customWithoutPrompt.length > 0) {
    throw new Error(
      `Custom angle(s) ${customWithoutPrompt.join(', ')} need --prompt to describe the new view — ` +
      'the default build only knows north/south/east/west.',
    );
  }

  const needsHero = angles.some(a => !isHeroAngle(a));
  const heroAdded = needsHero && !context.heroExists && !angles.some(isHeroAngle);
  if (heroAdded) angles = [HERO_ANGLE, ...angles];
  angles = Array.from(new Set(angles)).sort((a, b) =>
    isHeroAngle(a) ? -1 : isHeroAngle(b) ? 1 : 0,
  );
  return { angles, heroAdded };
}

/**
 * Object cast members (recurring hero props) must NOT be baked into location
 * plates — a plate that paints its own THE LEDGER becomes a duplicate
 * look-alike when the real reference is composited per shot. Locations are
 * empty stages; hero props enter per shot via their own references. A prop is
 * `kind: 'object'`, or (projects from before `kind`) `baseTraits` opening
 * with "inanimate object".
 */
export function locationObjectCastNouns(characters: readonly Character[] | undefined): string[] {
  return (characters ?? [])
    .filter(c => c.kind === 'object' || /^\s*inanimate object/i.test(c.baseTraits ?? ''))
    .map(c => c.name.replace(/^THE\s+/i, '').toLowerCase().trim())
    .filter(Boolean);
}

function cleanPlateClause(objectCastNouns: readonly string[]): string {
  return objectCastNouns.length > 0
    ? `Clean plate: the hero props (${objectCastNouns.join(', ')}) are NOT present — surfaces are clear of them; they are photographed separately.`
    : '';
}

export interface LocationPlateInput {
  aesthetic: AestheticProfile;
  location: Location;
  /** The series cast; object members are kept out of the plate. */
  characters?: readonly Character[];
  angle: string;
  /**
   * On the hero it REPLACES the whole t2i prompt verbatim. On a custom
   * derived plate it is the view clause.
   */
  promptOverride?: string;
}

/** The hero plate's `/image/generate` prompt and negative prompt. */
export function buildHeroPlatePrompt(input: LocationPlateInput): { prompt: string; negativePrompt: string } {
  const { aesthetic, location, angle, promptOverride } = input;
  const aestheticStr = locationAestheticString(aesthetic);
  const objectCastNouns = locationObjectCastNouns(input.characters);

  // Front-load STYLE (rule 11) so the environment holds the series look.
  const promptParts = [
    `STYLE: ${aestheticStr}.`,
    `${KNOWN_ANGLE_VIEWS[angle] ?? HERO_VIEW}.`,
    `${location.description}.`,
    location.lightingNotes ? `Lighting: ${location.lightingNotes}.` : '',
    // Locked geography (rule 49): bake the named landmarks and their fixed
    // relative positions into the wide plate so the derived angles inherit
    // one coherent space.
    location.spatialAnchors ? `Layout: ${location.spatialAnchors}.` : '',
    'Empty environment, no people present, no human figures, uninhabited scene.',
    cleanPlateClause(objectCastNouns),
    `STYLE REMINDER: ${aestheticStr}.`,
  ].filter(Boolean);
  const prompt = promptOverride ? promptOverride : promptParts.join(' ');

  const negativePrompt = [
    'people', 'person', 'human', 'figure', 'silhouette', 'crowd',
    'deformed', 'blurry', 'low quality', 'watermark', 'text', 'signature',
    'comic panels', 'panel borders', 'multiple frames',
    ...objectCastNouns,
  ].join(', ');

  return { prompt, negativePrompt };
}

/** A derived plate's `/image/multi-edit` prompt; the hero plate is the only image. */
export function buildDerivedPlatePrompt(input: LocationPlateInput): string {
  const { aesthetic, location, angle, promptOverride } = input;
  const aestheticStr = locationAestheticString(aesthetic);
  const viewClause = KNOWN_ANGLE_NAMES.has(angle)
    ? (KNOWN_ANGLE_VIEWS[angle] ?? promptOverride!)
    : promptOverride!;

  return [
    `STYLE: ${aestheticStr}.`,
    `${viewClause}.`,
    // Same-room contract: keep everything but the camera fixed. This is what
    // makes the angle set ONE coherent space instead of a fresh imagining.
    'This is the SAME room shown in the reference image — keep every surface, ' +
    'material, colour, architectural feature, and the exact lighting identical; ' +
    'only the camera position changes. Do not add, remove, or rearrange ' +
    'furniture; do not redecorate; do not change the architecture.',
    location.spatialAnchors ? `Known layout (do not rearrange): ${location.spatialAnchors}.` : '',
    cleanPlateClause(locationObjectCastNouns(input.characters)),
    'Empty environment, no people, no human figures.',
    'Render as a single continuous cinematic frame — no panels, no split ' +
    'screen, no inset views, no text, no labels.',
    `STYLE REMINDER: ${aestheticStr}.`,
  ].filter(Boolean).join(' ');
}
