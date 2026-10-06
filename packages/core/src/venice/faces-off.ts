// ---------------------------------------------------------------------------
// Faces-off preflight decision (rule 62) -- pure. Plain data in, plain data out.
//
// Venice lists each Seedance lane twice: the plain id (face-capable: 409
// `needs_consent` handshake, face screening) and a `-basic` twin that runs
// WITHOUT face handling and refuses any input image that shows a person (422
// `provider_content_policy`, credits refunded). Routing a shot with characters
// to a `-basic` id fails nearly every time -- 31 of 32 takes in one project --
// and the error text blames the prompt, so operators rewrite prompts that were
// never the problem.
//
// `decideFacesOff` takes each image's `hasFace` as data; the host reads it
// (the CLI from the `*.provenance.json` sidecars, `src/venice/seedance-preflight.ts`;
// a browser app from its asset store) and throws `FacesOffModelError` on a
// violation, before the paid call.
// ---------------------------------------------------------------------------

import { faceCapableTwinId, getVideoModel, isFacesOffModel } from './models.js';

/** One image the request would send, with what its provenance says about faces. */
export interface FacesOffImage {
  /** Path, asset id or URL: only used to name the image in the violation. */
  ref: string;
  /** `true` / `false` from provenance; `undefined` when there is no record or it is undecided. */
  hasFace?: boolean;
}

export interface FacesOffDecisionInput {
  /** The model the request would be sent to. */
  model: string;
  /**
   * Every image the request would send that has (or lacks) a provenance
   * record: start frame, end frame, reference images, scene images, element
   * frontals/refs. Leave out inline images the host cannot vouch for either
   * way (the CLI skips `data:` / `http` URLs: nothing to read a sidecar from).
   * Duplicate refs count once.
   */
  images: FacesOffImage[];
  /**
   * Character names the shot places on screen, if the caller knows them.
   * A shot with characters is treated as showing people even when no image
   * record says so -- the panel and character sheets will.
   */
  characters?: string[];
  /**
   * Kind of each name in `characters`, when the caller knows it (the series'
   * `Character.kind`, default `'person'`). When every character on screen is
   * an `'object'` (a hero prop riding the character system), nothing in the
   * shot has a face, so undecided images are treated as `hasFace: false`
   * the same way they are for a shot with no characters at all. An explicit
   * `hasFace: true` still blocks. A name missing from the map is a person.
   */
  characterKinds?: Record<string, 'person' | 'object' | undefined>;
}

export interface FacesOffViolation {
  model: string;
  /** The face-capable id to switch to. */
  faceCapableModel: string;
  /** Images whose provenance says (or does not deny) a face. */
  faceImages: string[];
  /** Characters the shot shows, when supplied. */
  characters: string[];
  message: string;
}

/**
 * Thrown by `assertFacesOffCompatible`. Carries the structured violation so a
 * CLI or UI can offer the one-click fix (switch to `faceCapableModel`).
 */
export class FacesOffModelError extends Error {
  public readonly violation: FacesOffViolation;

  constructor(violation: FacesOffViolation) {
    super(violation.message);
    this.name = 'FacesOffModelError';
    this.violation = violation;
  }
}

/**
 * Build the `characterKinds` map for a preflight call from the series' cast.
 * Names are keyed as given AND upper-cased; unknown names are omitted (the
 * check treats them as people).
 */
export function characterKindsFor(
  series: { characters: Array<{ name: string; kind?: 'person' | 'object' }> },
  names: string[],
): Record<string, 'person' | 'object'> {
  const out: Record<string, 'person' | 'object'> = {};
  for (const name of names) {
    const char = series.characters.find(c => c.name.toUpperCase() === name.toUpperCase());
    if (!char) continue;
    const kind = char.kind ?? 'person';
    out[name] = kind;
    out[name.toUpperCase()] = kind;
  }
  return out;
}

/**
 * Decide whether a request to `model` with these inputs would be refused for
 * showing a person on a faces-off id. Returns `undefined` when the request is
 * fine (not a faces-off model, no images, or every image is known faceless).
 *
 * An image counts as showing a face when its provenance says
 * `hasFace: true`, OR when the record is missing / undecided
 * (`hasFace` absent) and the shot has a person on screen. Only an explicit
 * `hasFace: false` clears an image. Location plates and other faceless
 * references are written with `hasFace:false` (rule 41), so a shot with no
 * people and only location refs passes. Object cast members
 * (`characterKinds[name] === 'object'`) are not people: a shot whose every
 * character is an object treats undecided records as faceless too.
 */
export function decideFacesOff(input: FacesOffDecisionInput): FacesOffViolation | undefined {
  if (!isFacesOffModel(input.model)) return undefined;
  const seen = new Set<string>();
  const images = input.images.filter(image => (seen.has(image.ref) ? false : (seen.add(image.ref), true)));
  if (images.length === 0) return undefined;

  const characters = input.characters ?? [];
  const kinds = input.characterKinds ?? {};
  const people = characters.filter(name => (kinds[name] ?? kinds[name.toUpperCase()] ?? 'person') === 'person');
  const hasPeople = people.length > 0;
  const faceImages: string[] = [];
  for (const image of images) {
    const hasFace = image.hasFace;
    if (hasFace === true) faceImages.push(image.ref);
    else if (hasFace === undefined && hasPeople) faceImages.push(image.ref);
  }
  if (faceImages.length === 0) return undefined;

  const faceCapableModel = faceCapableTwinId(input.model);
  const twinKnown = Boolean(getVideoModel(faceCapableModel));
  const who = hasPeople
    ? `shows ${people.length === 1 ? people[0] : `${people.length} characters`}`
    : `sends ${faceImages.length === 1 ? 'an image' : `${faceImages.length} images`} with a face`;
  const message =
    `This shot ${who}, and ${input.model} runs without Seedance's face handling, `
    + `so Venice refuses images of people on it (422 provider_content_policy). `
    + `Use ${faceCapableModel}${twinKnown ? '' : ' (the same model with face handling)'} instead. `
    + `No request was submitted.`;

  return { model: input.model, faceCapableModel, faceImages, characters, message };
}
