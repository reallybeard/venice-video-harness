// ---------------------------------------------------------------------------
// Seedance pre-flight
//
// Two generations of this module:
//
// 1. (2026-03 → 2026-07, NEUTRALIZED) Seedance 2.0 used to reject face-bearing
//    input images that weren't produced by `seedream-v5-lite` / `-edit`. The
//    provenance gate that rerouted or "laundered" those images is a no-op
//    since Venice dropped the cross-family restriction. `ensureSeedanceCompatibility`
//    is kept so the remaining one-off scripts compile.
//
// 2. (2026-10) Faces-off twins. Venice lists each Seedance lane twice: the
//    plain id (face-capable: 409 `needs_consent` handshake, face screening)
//    and a `-basic` twin that runs WITHOUT face handling and refuses any input
//    image that shows a person (422 `provider_content_policy`, credits
//    refunded). Routing a shot with characters to a `-basic` id fails nearly
//    every time -- 31 of 32 takes in one project -- and the error text blames
//    the prompt, so operators rewrite prompts that were never the problem.
//    `assertFacesOffCompatible` blocks that combination before the paid call
//    and names the face-capable twin as the fix. The decision itself is core's
//    `decideFacesOff`; this module reads the `hasFace` sidecars it decides on.
//
// NOTE: the Seedance face *consent* attestation (HTTP 409 `needs_consent`) is a
// SEPARATE mechanism handled at queue time in `video-generator.ts`.
// ---------------------------------------------------------------------------

import type { VeniceClient } from './client.js';
import { isFacesOffModel } from 'venice-video-harness/core/venice/models.js';
import {
  decideFacesOff,
  FacesOffModelError,
  type FacesOffImage,
  type FacesOffViolation,
} from 'venice-video-harness/core/venice/faces-off.js';
import { readImageProvenance } from './provenance.js';

export {
  characterKindsFor,
  FacesOffModelError,
  type FacesOffViolation,
} from 'venice-video-harness/core/venice/faces-off.js';

// ---- Types ----------------------------------------------------------------

/** All image-path fields on the request body that Seedance inspects. */
export interface SeedanceInputImagePaths {
  imageUrl?: string;
  endImageUrl?: string;
  referenceImagePaths?: string[];
  sceneImagePaths?: string[];
  elementsFrontalPaths?: string[];
  elementsReferencePaths?: string[];
}

export interface PreflightOptions {
  /** @deprecated The provenance gate is neutralized; this option is ignored. */
  mode?: import('venice-video-harness/core/series/types.js').SeedanceCompatibilityMode;
  /** @deprecated The provenance gate is neutralized; this option is ignored. */
  nonInteractive?: boolean;
}

export type PreflightAction =
  | { type: 'proceed'; model: string; imagePaths: SeedanceInputImagePaths }
  | { type: 'fallback'; newModel: string; reason: string; imagePaths: SeedanceInputImagePaths }
  | { type: 'laundered'; model: string; imagePaths: SeedanceInputImagePaths; lauderedPaths: string[] };

// ---- Provenance gate (no-op) ----------------------------------------------

/**
 * No-op Seedance provenance pre-flight. Always returns `proceed` with the
 * original model and image paths. Retained only so existing callers keep
 * compiling -- Venice removed the seedream-only face restriction that this
 * gate used to enforce.
 */
export async function ensureSeedanceCompatibility(
  _client: VeniceClient,
  targetModel: string,
  images: SeedanceInputImagePaths,
  _options: PreflightOptions = {},
): Promise<PreflightAction> {
  return { type: 'proceed', model: targetModel, imagePaths: images };
}

// ---- Faces-off gate -------------------------------------------------------

export interface FacesOffCheckInput {
  /** The model the request would be sent to. */
  model: string;
  /**
   * Every on-disk image the request would send (start frame, end frame,
   * reference images, scene images, element frontals/refs). `data:`/`http`
   * URLs are skipped: nothing to read a sidecar from.
   */
  imagePaths: string[];
  /**
   * Character names the shot places on screen, if the caller knows them.
   * A shot with characters is treated as showing people even when no image
   * sidecar says so -- the panel and character sheets will.
   */
  characters?: string[];
  /**
   * Kind of each name in `characters`, when the caller knows it (the series'
   * `Character.kind`, default `'person'`). When every character on screen is
   * an `'object'` (a hero prop riding the character system), nothing in the
   * shot has a face, so undecided sidecars are treated as `hasFace: false`
   * the same way they are for a shot with no characters at all. An explicit
   * `hasFace: true` still blocks. A name missing from the map is a person.
   */
  characterKinds?: Record<string, 'person' | 'object' | undefined>;
}

function isLocalPath(p: string): boolean {
  return Boolean(p) && !p.startsWith('data:') && !/^https?:\/\//i.test(p);
}

/**
 * Decide whether a request to `model` with these inputs would be refused for
 * showing a person on a faces-off id (`decideFacesOff` in core), reading each
 * on-disk image's `hasFace` from its provenance sidecar. Returns `undefined`
 * when the request is fine.
 */
export async function checkFacesOffCompatible(
  input: FacesOffCheckInput,
): Promise<FacesOffViolation | undefined> {
  if (!isFacesOffModel(input.model)) return undefined;
  const localPaths = Array.from(new Set(input.imagePaths.filter(isLocalPath)));
  if (localPaths.length === 0) return undefined;

  const images: FacesOffImage[] = [];
  for (const path of localPaths) {
    const prov = await readImageProvenance(path);
    images.push({ ref: path, hasFace: prov?.hasFace });
  }
  return decideFacesOff({
    model: input.model,
    images,
    characters: input.characters,
    characterKinds: input.characterKinds,
  });
}

/** Throw `FacesOffModelError` when `checkFacesOffCompatible` finds a violation. */
export async function assertFacesOffCompatible(input: FacesOffCheckInput): Promise<void> {
  const violation = await checkFacesOffCompatible(input);
  if (violation) throw new FacesOffModelError(violation);
}
