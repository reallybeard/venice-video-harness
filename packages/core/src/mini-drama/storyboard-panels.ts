// ---------------------------------------------------------------------------
// Storyboard panels: the pure half of `storyboard-episode`
//
// A panel is drafted, refined, then given its scene references:
//
//   pass 1  draft     character shots go through /image/multi-edit with the
//                     real reference bytes: composed INTO the location plate
//                     when the shot has one, otherwise a t2i scene draft that
//                     the characters are then composited onto. Faceless shots
//                     are an edit of the location plate, or plain t2i.
//   pass 2  refine    a character shot that was not reference-drafted gets an
//                     identity refine (the panel fixer); a faceless shot is
//                     style-matched against its location plate, else the
//                     episode's style anchor (the first character shot's
//                     panel, copied before refinement).
//   pass 3  scene     shots with `sceneImagePaths` get those images edited in.
//
// This module owns those decisions and every request body and prompt. The
// CLI probes disk, sends the requests and writes the files and sidecars; a
// browser host sends the same requests through its own ports, naming images
// by asset id where the CLI has paths.
// ---------------------------------------------------------------------------

import type { AestheticProfile, Character, Location, SeriesState, ShotEnvironment, ShotScript } from '../series/types.js';
import {
  DAYTIME_ENVIRONMENTS, DEFAULT_IMAGE_EDIT_MODEL, DEFAULT_IMAGE_GENERATION_MODEL, FEMALE_BASE_TRAITS, MALE_BASE_TRAITS,
} from '../series/types.js';
import { getLocation } from '../series/locations.js';
import { panelLocationNote } from './panel-approval.js';
import { buildImagePrompt } from './prompt-builder.js';

/** `/image/generate` settings every drafted panel renders with. */
export const PANEL_DRAFT_DEFAULTS = { cfgScale: 10, steps: 30, resolution: '1K', aspectRatio: '16:9' } as const;

/** `/image/multi-edit` takes a base plus at most this many reference layers. */
export const MULTI_EDIT_MAX_LAYERS = 2;

/** Scene-ref injection sends at most this many of a shot's `sceneImagePaths`. */
export const SCENE_REF_MAX_IMAGES = 2;

// ── Reference-draft prompt ──────────────────────────────────────────────

/** A character composited from real reference bytes. */
export interface ReferenceDraftLayer {
  name: string;
  /** Short identity line: description + wardrobe. */
  identityLine: string;
}

export interface ReferenceDraftPromptOptions {
  /** `location`: characters are placed INTO the plate. `scene-draft`: corrected in place. */
  baseKind: 'location' | 'scene-draft';
  /** The layers, in image order (image 2, image 3). */
  characters: readonly ReferenceDraftLayer[];
  /** Scene text: action, framing, and blocking for the shot. */
  sceneDescription: string;
  /** Explicit spatial blocking, injected verbatim when present. */
  blocking?: string;
  /** Aesthetic string appended as a style clause. */
  aesthetic?: string;
}

/**
 * The composition prompt. Image numbering follows the multi-edit array
 * order: image 1 = base, images 2..N = character layers.
 */
export function buildReferenceDraftPrompt(options: ReferenceDraftPromptOptions): string {
  const { baseKind, characters, sceneDescription, blocking, aesthetic } = options;
  const parts: string[] = [];

  if (baseKind === 'location') {
    parts.push(
      'Image 1 is the scene location — keep its architecture, layout, landmarks, and lighting exactly as shown; do not rearrange or mirror it.',
    );
  } else {
    parts.push(
      'Image 1 is the scene draft — keep its composition, framing, and environment.',
    );
  }

  characters.forEach((char, i) => {
    const imgNum = i + 2;
    if (baseKind === 'location') {
      parts.push(
        `Place the person from image ${imgNum} (${char.name}: ${char.identityLine}) into the scene — reproduce their exact face, hair, and body from image ${imgNum}, not from this text.`,
      );
    } else {
      parts.push(
        `Make the character ${char.name} in the scene match the person in image ${imgNum} exactly — face, hair, and body from image ${imgNum}, not from text. (${char.identityLine}.)`,
      );
    }
  });

  parts.push(sceneDescription);
  if (blocking) parts.push(`BLOCKING: ${blocking}`);

  parts.push(
    'Render as a single continuous cinematic frame. Do NOT copy the reference images\u2019 poses, backgrounds, or layout — only the identities. ' +
    'No text, no labels, no inset panels, no multi-view composition, no speech bubbles.',
  );
  if (aesthetic) parts.push(`STYLE: ${aesthetic}.`);

  return parts.join(' ');
}

/** The characters that fit the multi-edit layer budget, and the ones that do not. */
export function referenceDraftLayers<T>(characters: readonly T[]): { layers: T[]; dropped: T[] } {
  return { layers: characters.slice(0, MULTI_EDIT_MAX_LAYERS), dropped: characters.slice(MULTI_EDIT_MAX_LAYERS) };
}

// ── Pass 1: draft ───────────────────────────────────────────────────────

/** The `/image/generate` body for a drafted panel. */
export interface PanelGenerateRequest {
  model: string;
  prompt: string;
  negative_prompt: string;
  resolution: string;
  aspect_ratio: string;
  steps: number;
  cfg_scale: number;
  seed?: number;
  safe_mode: false;
  hide_watermark: true;
}

/** A character of the shot and its primary identity reference (anchor > front > three-quarter), when it has one. */
export interface PanelCharacterReference<Ref = string> {
  character: Character;
  primary?: Ref;
}

/** A layer of a reference-drafted panel: the identity text plus the image it comes from. */
export interface PanelDraftLayer<Ref = string> extends ReferenceDraftLayer {
  ref: Ref;
}

/** A `/image/multi-edit` composition: the base image plus the character layers, before the layer budget. */
export interface PanelCompose<Ref = string> {
  baseKind: 'location' | 'scene-draft';
  /** The location plate (`baseKind: 'location'`); a scene draft is the panel just generated. */
  base?: Ref;
  characters: PanelDraftLayer<Ref>[];
  sceneDescription: string;
  blocking?: string;
  aesthetic?: string;
  model: string;
  recipeLabel: string;
}

export interface PanelDraftPlan<Ref = string> {
  /** `buildImagePrompt` plus the location note: the panel's scene text. */
  prompt: string;
  negativePrompt: string;
  seed?: number;
  aspectRatio: string;
  cfgScale: number;
  /** Sent first when present: the whole panel, or the scene draft `compose` edits. */
  generate?: PanelGenerateRequest;
  /** Recipe label for the `generate` pass. */
  generateLabel?: string;
  /** Provenance `hasFace` for the `generate` pass. */
  generateHasFace: boolean;
  /** The reference-drafting edit, when the panel has a plate or a character with a reference. */
  compose?: PanelCompose<Ref>;
  /** Characters of the shot with no reference image: identity from text only. */
  missingReferences: string[];
}

export interface PanelDraftInput<Ref = string> {
  series: SeriesState;
  shot: ShotScript;
  /** The shot's characters that resolve in the series, in shot order. */
  characters: readonly PanelCharacterReference<Ref>[];
  /** The location's first plate (north first, then the rest of `LOCATION_REF_ORDER`). */
  locationPlate?: Ref;
  cfgScale?: number;
}

/** The aesthetic clause of a reference draft: style, palette and lighting, empty parts skipped. */
export function panelAestheticLine(aesthetic: AestheticProfile | null | undefined): string | undefined {
  return aesthetic ? [aesthetic.style, aesthetic.palette, aesthetic.lighting].filter(Boolean).join(', ') : undefined;
}

/** The identity line a reference draft gives a character: its description (120 chars) and this shot's wardrobe. */
export function panelIdentityLine(shot: ShotScript, character: Character): string {
  const wardrobe = shot.episodeWardrobe?.[character.name.toUpperCase()] ?? character.wardrobe;
  return `${character.description.slice(0, 120)}, wearing ${wardrobe}`;
}

/** The image models a storyboard drafts with: the series' `imageDefaults`, else the harness defaults. */
export function panelImageModels(series: SeriesState): { generationModel: string; editModel: string } {
  return {
    generationModel: series.videoDefaults.imageDefaults?.generationModel ?? DEFAULT_IMAGE_GENERATION_MODEL,
    editModel: series.videoDefaults.imageDefaults?.editModel ?? DEFAULT_IMAGE_EDIT_MODEL,
  };
}

/** The location a shot is tagged with, when it resolves. */
export function panelLocation(series: SeriesState, shot: ShotScript): Location | undefined {
  return shot.location ? getLocation(series, shot.location) : undefined;
}

/** How one panel is drafted: which requests, in which order, with which images. */
export function planPanelDraft<Ref = string>(input: PanelDraftInput<Ref>): PanelDraftPlan<Ref> {
  const { series, shot, characters, locationPlate } = input;
  const cfgScale = input.cfgScale ?? PANEL_DRAFT_DEFAULTS.cfgScale;
  const imagePrompt = buildImagePrompt(shot, series);
  const location = panelLocation(series, shot);
  const prompt = imagePrompt.prompt + (location ? panelLocationNote(location) : '');
  const aspectRatio = series.storyboardAspectRatio ?? PANEL_DRAFT_DEFAULTS.aspectRatio;
  const { generationModel, editModel } = panelImageModels(series);
  const hasChars = shot.characters.length > 0;

  const generate: PanelGenerateRequest = {
    model: generationModel,
    prompt,
    negative_prompt: imagePrompt.negativePrompt,
    resolution: PANEL_DRAFT_DEFAULTS.resolution,
    aspect_ratio: aspectRatio,
    steps: PANEL_DRAFT_DEFAULTS.steps,
    cfg_scale: cfgScale,
    seed: imagePrompt.seed,
    safe_mode: false,
    hide_watermark: true,
  };
  const base = { prompt, negativePrompt: imagePrompt.negativePrompt, seed: imagePrompt.seed, aspectRatio, cfgScale };
  const compose = (baseKind: PanelCompose['baseKind'], layers: PanelDraftLayer<Ref>[], recipeLabel: string, plate?: Ref): PanelCompose<Ref> => ({
    baseKind,
    ...(plate !== undefined ? { base: plate } : {}),
    characters: layers,
    sceneDescription: prompt,
    blocking: shot.blocking,
    aesthetic: panelAestheticLine(series.aesthetic),
    model: editModel,
    recipeLabel,
  });

  if (!hasChars) {
    if (locationPlate !== undefined) {
      return { ...base, generateHasFace: false, compose: compose('location', [], 'reference-drafted establishing panel (location base)', locationPlate), missingReferences: [] };
    }
    return { ...base, generate, generateLabel: 'base panel', generateHasFace: false, missingReferences: [] };
  }

  const layers: PanelDraftLayer<Ref>[] = [];
  const missingReferences: string[] = [];
  for (const { character, primary } of characters) {
    if (primary === undefined) { missingReferences.push(character.name); continue; }
    layers.push({ name: character.name, identityLine: panelIdentityLine(shot, character), ref: primary });
  }
  if (layers.length > 0 && locationPlate !== undefined) {
    return { ...base, generateHasFace: true, compose: compose('location', layers, 'reference-drafted panel (location base)', locationPlate), missingReferences };
  }
  if (layers.length > 0) {
    return {
      ...base, generate, generateLabel: 'scene draft (pre-identity)', generateHasFace: true,
      compose: compose('scene-draft', layers, 'reference-drafted panel (identity composite)'), missingReferences,
    };
  }
  return { ...base, generate, generateLabel: 'base panel', generateHasFace: true, missingReferences };
}

// ── Pass 2: refine ──────────────────────────────────────────────────────

/** The shot whose drafted panel is the episode's style anchor: the first with characters. */
export function styleAnchorShot(shots: readonly ShotScript[]): ShotScript | undefined {
  return shots.find(s => s.characters.length > 0);
}

/** Refinement order: every character shot, then every faceless shot, each in script order. */
export function panelRefineOrder<S extends Pick<ShotScript, 'characters'>>(shots: readonly S[]): S[] {
  return [...shots.filter(s => s.characters.length > 0), ...shots.filter(s => s.characters.length === 0)];
}

export type PanelRefineStep<Ref = string> =
  | { kind: 'skip'; reason: 'skip-refine' | 'reference-drafted' | 'no-anchor' }
  | { kind: 'identity' }
  | { kind: 'style'; anchor: Ref; locationAnchor: boolean };

/**
 * What pass 2 does to one panel. `referenceDrafted`: pass 1 composited this
 * panel's identity from real reference bytes this run. `styleAnchor`: the
 * episode's style anchor, when the host has one. A panel the host has
 * already refined on an earlier run is the host's to skip.
 */
export function panelRefineStep<Ref = string>(
  shot: ShotScript,
  context: { referenceDrafted: boolean; locationPlate?: Ref; styleAnchor?: Ref },
): PanelRefineStep<Ref> {
  if (shot.skipRefine) return { kind: 'skip', reason: 'skip-refine' };
  if (shot.characters.length > 0) {
    return context.referenceDrafted ? { kind: 'skip', reason: 'reference-drafted' } : { kind: 'identity' };
  }
  if (context.locationPlate !== undefined) return { kind: 'style', anchor: context.locationPlate, locationAnchor: true };
  if (context.styleAnchor !== undefined) return { kind: 'style', anchor: context.styleAnchor, locationAnchor: false };
  return { kind: 'skip', reason: 'no-anchor' };
}

/** Style, palette and lighting for a style match, joined as given (empty parts kept). */
export function styleMatchAesthetic(aesthetic: Pick<AestheticProfile, 'style' | 'palette' | 'lighting'>): string {
  return [aesthetic.style, aesthetic.palette, aesthetic.lighting].join(', ');
}

/** The style-match edit prompt: the panel is image 1, the anchor image 2. */
export function buildStyleMatchPrompt(aesthetic: string, environment?: ShotEnvironment): string {
  const isDaytime = environment && DAYTIME_ENVIRONMENTS.has(environment);
  return (
    `Match the visual style of the reference image: same rendering style, color palette, line weight, and lighting treatment. ` +
    `Style: ${aesthetic}. ` +
    (isDaytime
      ? `IMPORTANT: This is a BRIGHT DAYTIME scene. Keep bright warm lighting. Do NOT add rain, dark skies, or wet surfaces. `
      : '') +
    `CRITICAL: Keep the scene composition and content unchanged. Only harmonize the visual style. ` +
    `Do NOT add characters, people, text, labels, or inset panels. Do NOT change the scene's subject matter.`
  );
}

// ── Identity refine (the panel fixer) ───────────────────────────────────

const baseTraitsOf = (char: Character): string =>
  char.baseTraits ?? (char.gender === 'female' ? FEMALE_BASE_TRAITS : MALE_BASE_TRAITS);

/** The single-character fix prompt: images 2 and 3 are that character's references. */
export function buildCharacterFixPrompt(
  char: Character,
  wardrobeOverride?: string,
  environment?: ShotEnvironment,
): string {
  const traits = baseTraitsOf(char);
  const wardrobe = wardrobeOverride ?? char.wardrobe;
  const isDaytime = environment && DAYTIME_ENVIRONMENTS.has(environment);

  // Derive subject noun from description/age instead of just gender
  const descLower = (char.description + ' ' + char.age).toLowerCase();
  let subjectNoun: string;
  if (/cat|tabby|feline|kitten/.test(descLower)) {
    subjectNoun = 'cat';
  } else if (/child|boy|girl|\d+\s*year\s*old/.test(descLower)) {
    subjectNoun = char.gender === 'female' ? 'girl' : 'boy';
  } else {
    subjectNoun = char.gender === 'female' ? 'woman' : 'man';
  }

  return (
    `Make the ${subjectNoun} in the scene match the reference images' FACE AND BODY PROPORTIONS ONLY. ` +
    `Image 2 is the front-facing reference, Image 3 (if present) is the three-quarter reference — use both to accurately reconstruct the face, hair, and jaw. ` +
    `Character: ${char.name}. ${traits}. ${char.fullDescription}. ` +
    `Wearing: ${wardrobe}. ` +
    (wardrobeOverride
      ? `IMPORTANT: The character's CLOTHING must be exactly as described above (${wardrobe}), NOT the outfit in the reference image. Match the face and body only. `
      : '') +
    (isDaytime
      ? `IMPORTANT: This is a BRIGHT DAYTIME scene. Do NOT darken the image, do NOT add rain, wet surfaces, or dark skies. Keep the bright warm lighting. `
      : '') +
    `CRITICAL: Keep the scene as a single continuous image. Do NOT copy the reference image's layout. ` +
    `Do NOT add text labels, annotations, inset panels, detail callouts, or multi-view compositions. ` +
    `Keep the scene composition, background, and other characters unchanged. ` +
    `Only modify this character's face, hair, body, and clothing to match the description.`
  );
}

/** The two-character fix prompt: image 2 is the first character's reference, image 3 the second's. */
export function buildTwoCharacterFixPrompt(
  char1: Character,
  char2: Character,
  wardrobeOverrides?: Record<string, string>,
  environment?: ShotEnvironment,
): string {
  const traits1 = baseTraitsOf(char1);
  const traits2 = baseTraitsOf(char2);
  const wardrobe1 = wardrobeOverrides?.[char1.name.toUpperCase()] ?? char1.wardrobe;
  const wardrobe2 = wardrobeOverrides?.[char2.name.toUpperCase()] ?? char2.wardrobe;
  const hasOverride = wardrobeOverrides && Object.keys(wardrobeOverrides).length > 0;
  const isDaytime = environment && DAYTIME_ENVIRONMENTS.has(environment);
  return (
    `Make both characters match their reference images' FACE AND BODY PROPORTIONS ONLY. ` +
    `Image 2 is the reference for ${char1.name} (${traits1}, ${char1.fullDescription}, wearing ${wardrobe1}). ` +
    `Image 3 is the reference for ${char2.name} (${traits2}, ${char2.fullDescription}, wearing ${wardrobe2}). ` +
    (hasOverride
      ? `IMPORTANT: Characters' CLOTHING must match the descriptions above, NOT the outfits in the reference images. Match faces and bodies only. `
      : '') +
    (isDaytime
      ? `IMPORTANT: This is a BRIGHT DAYTIME scene. Do NOT darken the image, do NOT add rain, wet surfaces, or dark skies. Keep the bright warm lighting. `
      : '') +
    `CRITICAL: Keep the scene as a single continuous image. Do NOT copy the reference images' layout. ` +
    `Do NOT add text labels, annotations, inset panels, detail callouts, or multi-view compositions. ` +
    `Keep the scene composition and background unchanged. Fix character appearance only.`
  );
}

/** The references of a character an identity refine anchors. */
export interface CharacterFixReference<Ref = string> {
  /** anchor > front > three-quarter. */
  primary: Ref;
  /** The first of three-quarter, profile, full-body that is not the primary. */
  secondAngle?: Ref;
}

export interface CharacterFixPlan<Ref = string> {
  prompt: string;
  /** The layers after the panel: character references, then the location plate when it fits. */
  references: Ref[];
  /** Characters whose reference is a layer (the first two). */
  anchored: string[];
  /** Characters past the layer budget: identity from the panel and text only. */
  textOnly: string[];
  /** The location plate wanted a layer and got none (2+ characters). */
  locationDropped: boolean;
}

/**
 * The identity refine for a panel: which references fill the two layers and
 * the prompt that names them. Characters first; a location plate takes the
 * last free layer; a lone character with no plate gets a second angle.
 * `referencesOf` is called for the characters that get a layer, in order.
 */
export function planCharacterFix<Ref = string>(input: {
  /** The shot's characters that resolve in the series, in shot order (at least one). */
  characters: readonly Character[];
  referencesOf: (character: Character) => CharacterFixReference<Ref>;
  environmentRef?: Ref;
  customPrompt?: string;
  episodeWardrobe?: Record<string, string>;
  environment?: ShotEnvironment;
}): CharacterFixPlan<Ref> {
  const { characters, referencesOf, environmentRef, customPrompt, episodeWardrobe, environment } = input;
  const anchoredChars = characters.slice(0, MULTI_EDIT_MAX_LAYERS);
  const wantLocationRef = environmentRef !== undefined;
  const references: Ref[] = [];
  for (const c of anchoredChars) {
    const refs = referencesOf(c);
    references.push(refs.primary);
    if (characters.length === 1 && !wantLocationRef && refs.secondAngle !== undefined) references.push(refs.secondAngle);
  }
  let includedLocationRef = false;
  let locationDropped = false;
  if (wantLocationRef) {
    if (references.length < MULTI_EDIT_MAX_LAYERS) {
      references.push(environmentRef);
      includedLocationRef = true;
    } else {
      locationDropped = true;
    }
  }

  let prompt: string;
  if (customPrompt) {
    prompt = customPrompt;
  } else if (characters.length === 1) {
    prompt = buildCharacterFixPrompt(characters[0], episodeWardrobe?.[characters[0].name.toUpperCase()], environment);
  } else {
    prompt = buildTwoCharacterFixPrompt(characters[0], characters[1], episodeWardrobe, environment);
  }
  if (includedLocationRef) {
    prompt += ` The final reference image is the location environment — match its setting, architecture, and lighting; it is not a character.`;
  }

  return {
    prompt,
    references,
    anchored: anchoredChars.map(c => c.name),
    textOnly: characters.slice(MULTI_EDIT_MAX_LAYERS).map(c => c.name),
    locationDropped,
  };
}

// ── Pass 3: scene references ────────────────────────────────────────────

/** The scene-ref injection prompt: the panel is image 1, the scene references after it. */
export function buildSceneRefPrompt(sceneRefDescription?: string): string {
  return sceneRefDescription
    ? `${sceneRefDescription} Preserve the scene composition, characters, lighting, and cinematic framing exactly. Do not add text, speech bubbles, or panel borders.`
    : `Integrate the visual elements from the reference image(s) into this scene. ` +
      `Preserve the scene composition, characters, lighting, and cinematic framing exactly. ` +
      `Do not change the overall image. Do not add text, speech bubbles, or panel borders.`;
}
