// ---------------------------------------------------------------------------
// ReferenceSet: the images a shot may reference, as data.
//
// The @ImageN slot planner (`src/mini-drama/reference-slots.ts`) used to probe
// the project directory for `characters/<slug>/{anchor,front,...}.png`,
// `locations/<slug>/{north,south,...}.png` and `storyboards/<slug>.png`. A
// browser host has the same images as asset ids, not files. The planner now
// takes a `ReferenceSet`; the CLI builds one from disk with the same file
// rules it used before (`src/mini-drama/reference-set-from-disk.ts`), so CLI
// behaviour is unchanged by construction, and a browser builds one from its
// own manifest.
//
// `ref` is opaque to core: a path on the CLI, an asset id in a browser. Core
// never opens it.
// ---------------------------------------------------------------------------

/** One image a shot may reference, with where it came from and what it shows. `ref` is opaque to core. */
export interface ReferenceImage {
  /** Path on the CLI, asset id in a browser. Core never opens it. */
  ref: string;
  /** Rule-41 provenance: `true` blocks faces-off models; `false` clears; absent = undecided. */
  hasFace?: boolean;
}

/** A location plate, labelled by the wall it faces so the role clause can name it. */
export type LocationPlateReference = ReferenceImage & {
  /**
   * `north` | `south` | `east` | `west` for the compass set; the legacy
   * names (`wide`, `angle-2`..`angle-4`, `medium`, `detail`) on older
   * projects; any other string for operator-added custom plates
   * (the file stem on the CLI, e.g. `reverse-angle`).
   */
  wall: 'north' | 'south' | 'east' | 'west' | string;
};

/** A character angle, labelled by view so the role clause can name it. */
export type CharacterAngleReference = ReferenceImage & {
  view: 'three-quarter' | 'profile' | 'full-body' | string;
};

export interface CharacterReferences {
  /** Character name as it appears in `SeriesState.characters[].name`. */
  name: string;
  /**
   * `anchor.png` > `front.png` > `three-quarter.png` on the CLI. Absent when
   * none of those exist; the planner then skips the identity slot for this
   * character but may still offer one of `angles` (matches the pre-ReferenceSet
   * probing, which did not require a primary to offer a second angle).
   */
  primary?: ReferenceImage;
  /** In preference order, never including `primary`; the planner takes the first. Keyed by view so the role clause can name it. */
  angles: CharacterAngleReference[];
}

export interface LocationReferences {
  /** `Location.slug`. */
  slug: string;
  /** In compass order (`north`, `south`, `east`, `west`, then the legacy names, then custom plates), each with its wall so the role clause can name it. */
  plates: LocationPlateReference[];
}

export interface ReferenceSet {
  characters: CharacterReferences[];
  locations: LocationReferences[];
  /** `ShotScript.storyboardRef` plate, when present. */
  storyboard?: ReferenceImage;
}

/** Structural check: is `value` a `ReferenceSet` (as opposed to an options bag)? */
export function isReferenceSet(value: unknown): value is ReferenceSet {
  return typeof value === 'object'
    && value !== null
    && Array.isArray((value as ReferenceSet).characters)
    && Array.isArray((value as ReferenceSet).locations);
}
