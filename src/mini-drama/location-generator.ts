// ---------------------------------------------------------------------------
// Location Reference Generation (anchor → derive; compass plates 2026-10-05)
//
// Locations are first-class environment entities (see Location in
// packages/core/src/series/types.ts). Their reference images anchor the environment across
// storyboard panels, starting frames, and video generations — mirroring how
// character references anchor identity, and directly serving the
// lighting-consistency anti-pattern (AGENTS.md anti-pattern 7).
//
// THE PLATES ARE ONE COHERENT SPACE. Every location gets exactly four WIDE
// plates — `north.png`, `south.png`, `east.png`, `west.png` — one per
// wall/direction, giving 360 degrees of visual information. There are no
// medium or close-up plates. `north.png` is the ONLY from-scratch
// text-to-image generation — the hero establishing plate facing the north
// wall. Every other plate (`south`, `east`, `west`, and any custom coverage)
// is DERIVED by multi-editing `north.png` with the edit model
// (nano-banana-2-edit by default), the same anchor→derive pattern character
// references use. This is the fix for the old wide/medium/detail ladder,
// where each angle was an INDEPENDENT t2i call (same seed, different prompt)
// that produced three visibly different rooms — the video model was then
// handed three "same place" references that disagreed, and the environment
// drifted. Deriving from one plate guarantees every plate is the same
// physical space; the edit model preserves the 16:9 frame (no 1:1 crop
// distortion).
//
// Generated FACELESS with provenance hasFace:false, so they pass the Seedance
// pre-flight gate without laundering. Shared by the `add-location` CLI command
// and workshop-episode's auto-extraction so both paths produce identical
// assets. The plate list and every prompt come from core
// (`packages/core/src/mini-drama/location-plates.ts`); this file runs them.
// ---------------------------------------------------------------------------

import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import type { VeniceClient } from '../venice/client.js';
import type { Location, SeriesState } from 'venice-video-harness/core/series/types.js';
import { getLocationDir } from '../series/manager.js';
import { generateImage } from '../venice/generate.js';
import { multiEditImage, loadImageAsDataUri } from '../venice/multi-edit.js';
import {
  ensureRealPng,
  restoreAspectRatio,
  aspectRatioToDimensions,
  getImageDimensions,
} from '../venice/edit-post.js';
import { writeImageBytesSmart } from '../venice/image-bytes.js';
import { appendRecipePass } from '../venice/recipe.js';
import {
  DEFAULT_IMAGE_GENERATION_MODEL,
  DEFAULT_IMAGE_EDIT_MODEL,
} from 'venice-video-harness/core/series/types.js';
import type { MultiEditModel } from 'venice-video-harness/core/venice/types.js';
import {
  HERO_PLATE_DEFAULTS,
  HERO_PLATE_FILES,
  buildDerivedPlatePrompt,
  buildHeroPlatePrompt,
  isHeroAngle,
  planLocationAngles,
} from 'venice-video-harness/core/mini-drama/location-plates.js';

export {
  HERO_ANGLE,
  DERIVED_ANGLES,
  DEFAULT_LOCATION_ANGLES,
  LEGACY_LOCATION_ANGLES,
  LOCATION_ANGLES,
  sanitizeAngleName,
} from 'venice-video-harness/core/mini-drama/location-plates.js';
export type { LocationAngle } from 'venice-video-harness/core/mini-drama/location-plates.js';

export interface GenerateLocationReferencesOptions {
  /** Override the wide-plate (t2i) generation model (default nano-banana-2). */
  model?: string;
  /** Override the derived-angle edit model (default nano-banana-2-edit). */
  editModel?: string;
  /** cfg_scale for the wide plate (default 10). */
  cfgScale?: number;
  /** Regenerate angles that already exist on disk. */
  force?: boolean;
  /**
   * Only (re)generate this subset of plates. Default: the canonical compass
   * set (north + south/east/west). `north` is generated from scratch; every
   * other plate is DERIVED by multi-editing north.png. Names outside the known
   * set are CUSTOM angles — extra coverage of the same space
   * ("reverse-angle", "behind-the-desk", "night") — and require
   * `promptOverride` to describe the new view. Custom angles are saved as
   * `<name>.png` beside the canonical set and picked up automatically by the
   * reference-slot allocator as additional location slots. Deriving any plate
   * requires the hero plate (`north.png`, or legacy `wide.png`); it is
   * generated first automatically when missing.
   */
  angles?: string[];
  /**
   * Inline positive-prompt override. On `north` it REPLACES the whole t2i
   * prompt verbatim. On any derived plate it becomes the VIEW clause composed
   * into the same-room edit build (required for custom angles).
   */
  promptOverride?: string;
}

/**
 * Absolute path to the location's hero plate. Prefers the compass `north`;
 * falls back to the legacy `wide` so pre-2026-10 projects still resolve.
 */
function resolveHeroPath(dir: string): string | undefined {
  return HERO_PLATE_FILES
    .map(f => join(dir, f))
    .find(p => existsSync(p));
}

/**
 * Generate the reference plates for a location. `north.png` is generated from
 * scratch (t2i); `south/east/west` (and any custom angles) are DERIVED by
 * multi-editing north.png so every plate is the same physical space. Writes
 * `locations/<slug>/<angle>.png` plus per-angle `.prompt.json` sidecars,
 * provenance (hasFace:false), and recipe passes. Returns the paths that were
 * (re)generated.
 */
export async function generateLocationReferences(
  client: VeniceClient,
  series: SeriesState,
  location: Location,
  options: GenerateLocationReferencesOptions = {},
): Promise<{ generated: string[]; skipped: string[] }> {
  if (!series.aesthetic) {
    throw new Error('Series aesthetic must be set before generating location references.');
  }
  const aesthetic = series.aesthetic;

  const dir = getLocationDir(series, location.slug);
  await mkdir(dir, { recursive: true });

  const genModel = options.model ?? location.referenceModel ?? DEFAULT_IMAGE_GENERATION_MODEL;
  const editModel = (options.editModel
    ?? series.videoDefaults?.imageDefaults?.editModel
    ?? DEFAULT_IMAGE_EDIT_MODEL) as MultiEditModel;
  const cfgScale = options.cfgScale ?? HERO_PLATE_DEFAULTS.cfgScale;
  const aspect = series.storyboardAspectRatio ?? '16:9';
  const seed = location.seed;

  const generated: string[] = [];
  const skipped: string[] = [];

  const plan = planLocationAngles(options.angles, {
    heroExists: Boolean(resolveHeroPath(dir)),
    promptOverride: options.promptOverride,
  });
  if (plan.heroAdded) {
    console.log('  north plate missing — generating it first so the other plates can derive from it.');
  }

  for (const angle of plan.angles) {
    const imgPath = join(dir, `${angle}.png`);
    if (existsSync(imgPath) && !options.force) {
      skipped.push(imgPath);
      continue;
    }
    // Archive existing when forcing (asset-safety: never destructive).
    if (existsSync(imgPath) && options.force) {
      const archive = imgPath.replace(/\.png$/, `-force-archive-${Date.now()}.png`);
      await rename(imgPath, archive);
    }

    const plateInput = {
      aesthetic, location, characters: series.characters, angle,
      promptOverride: options.promptOverride,
    };
    try {
      if (isHeroAngle(angle)) {
        await generateHeroPlate(client, {
          dir, imgPath, location, genModel, cfgScale, aspect, seed, angle,
          ...buildHeroPlatePrompt(plateInput),
        });
      } else {
        const heroPath = resolveHeroPath(dir);
        if (!heroPath) {
          console.warn(`  ${angle}: north plate not found — cannot derive this plate. Generate north first.`);
          continue;
        }
        await derivePlateFromHero(client, {
          dir, imgPath, angle, heroPath, editModel, aspect, location,
          prompt: buildDerivedPlatePrompt(plateInput),
        });
      }
      generated.push(imgPath);
    } catch (err) {
      console.warn(`  ${angle}: failed - ${(err as Error).message}`);
    }
  }

  return { generated, skipped };
}

// ---------------------------------------------------------------------------
// Hero plate (from-scratch t2i — the north wall)
// ---------------------------------------------------------------------------

async function generateHeroPlate(
  client: VeniceClient,
  args: {
    dir: string; imgPath: string; location: Location; genModel: string;
    cfgScale: number; aspect: string; seed: number; angle: string;
    prompt: string; negativePrompt: string;
  },
): Promise<void> {
  const {
    dir, imgPath, location, genModel, cfgScale, aspect, seed, angle,
    prompt, negativePrompt,
  } = args;
  const { steps, resolution } = HERO_PLATE_DEFAULTS;

  const response = await generateImage(client, {
    model: genModel,
    prompt,
    negative_prompt: negativePrompt,
    resolution,
    aspect_ratio: aspect,
    steps,
    cfg_scale: cfgScale,
    seed,
    safe_mode: false,
    hide_watermark: true,
  });
  if (!response.images?.[0]) {
    throw new Error('no image returned');
  }
  const imgBuffer = Buffer.from(response.images[0].b64_json, 'base64');
  const finalPath = await writeImageBytesSmart(imgBuffer, imgPath);
  console.log(`  ${angle}: saved -> ${basename(finalPath)} (hero plate)`);

  const returnedSeed = (response.images[0] as { seed?: number }).seed;
  await writeFile(join(dir, `${angle}.prompt.json`), JSON.stringify({
    location: location.name,
    slug: location.slug,
    angle,
    kind: 'generate',
    model: genModel,
    prompt,
    negative_prompt: negativePrompt,
    cfg_scale: cfgScale,
    aspect_ratio: aspect,
    resolution,
    seed,
    returnedSeed,
    generatedAt: new Date().toISOString(),
  }, null, 2), 'utf-8');

  await appendRecipePass(finalPath, {
    kind: 'generate',
    role: 'content',
    model: genModel,
    label: `location reference (${location.name}, ${angle} hero plate)`,
    prompt,
    negativePrompt,
    seed,
    cfgScale,
    aspectRatio: aspect,
    resolution,
  }, { provenance: 'generate', hasFace: false });
}

// ---------------------------------------------------------------------------
// Derived plate (multi-edit of the north hero plate — same room, new wall)
// ---------------------------------------------------------------------------

async function derivePlateFromHero(
  client: VeniceClient,
  args: {
    dir: string; imgPath: string; angle: string; heroPath: string;
    editModel: MultiEditModel; aspect: string; location: Location;
    prompt: string;
  },
): Promise<void> {
  const {
    dir, imgPath, angle, heroPath, editModel, aspect, location, prompt,
  } = args;

  const baseUri = await loadImageAsDataUri(heroPath);
  const resultBuffer = await multiEditImage(client, {
    model: editModel,
    prompt,
    baseImage: baseUri,
    // NO reference layers — a pure single-image re-angle of the north plate.
  });

  await writeFile(imgPath, resultBuffer);
  await ensureRealPng(imgPath);
  // Match the derived plate to the north plate's EXACT dimensions (not the
  // theoretical ratio) so a same-size edit is a true no-op. nano-banana-2-edit
  // preserves the input frame; seedream-*-edit returns 1:1 and gets crop-fit
  // to the north's shape here. Fall back to the series ratio if the north's
  // dims can't be read.
  const targetDims = getImageDimensions(heroPath) ?? aspectRatioToDimensions(aspect);
  if (targetDims) await restoreAspectRatio(imgPath, targetDims[0], targetDims[1]);

  console.log(`  ${angle}: saved -> ${basename(imgPath)} (derived from north via ${editModel})`);

  await writeFile(join(dir, `${angle}.prompt.json`), JSON.stringify({
    location: location.name,
    slug: location.slug,
    angle,
    kind: 'multi-edit',
    model: editModel,
    base: basename(heroPath),
    prompt,
    aspect_ratio: aspect,
    generatedAt: new Date().toISOString(),
  }, null, 2), 'utf-8');

  await appendRecipePass(imgPath, {
    kind: 'multi-edit',
    role: 'content',
    model: editModel,
    label: `location reference (${location.name}, ${angle}) derived from north`,
    prompt,
    referenceImagePaths: [heroPath],
    aspectRatio: aspect,
  }, { provenance: 'edit', hasFace: false });
}
