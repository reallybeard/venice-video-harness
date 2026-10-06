// ---------------------------------------------------------------------------
// Character reference sheets: the pure half
//
// A character's sheet is four angles — front, three-quarter, profile,
// full-body — each its own text-to-image generation from
// `buildCharacterReferencePromptParts`, all sharing the character's seed and
// a high cfg so the angles hold one identity. This module owns the angle list,
// the seed, the negatives and the `/image/generate` body for one angle. The
// CLI (`add-character`, `src/mini-drama/character-reference-generator.ts`)
// sends the bodies and writes the files and sidecars; a browser host sends the
// same bodies through its own ports.
// ---------------------------------------------------------------------------

import type { AestheticProfile, Character } from '../series/types.js';
import { DEFAULT_IMAGE_GENERATION_MODEL } from '../series/types.js';
import { buildCharacterReferencePromptParts } from './prompt-builder.js';

export const CHARACTER_ANGLES = ['front', 'three-quarter', 'profile', 'full-body'] as const;
export type CharacterAngle = (typeof CHARACTER_ANGLES)[number];

/** `/image/generate` settings every angle renders with unless overridden. */
export const CHARACTER_REFERENCE_DEFAULTS = { cfgScale: 10, steps: 30, aspectRatio: '1:1', resolution: '1K' } as const;

/** Negatives on every angle, ahead of the prompt builder's style-reminder additions. */
export const CHARACTER_REFERENCE_NEGATIVES = [
  'deformed', 'blurry', 'bad anatomy', 'low quality',
  'multiple people', 'watermark',
  'character reference sheet', 'comic panels', 'panel borders',
] as const;

/** Deterministic seed from a name: the seed `add-character` gives a new character. */
export function characterSeedFromName(name: string): number {
  return Math.abs([...name].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)) % 999_999_999;
}

/** Whether a character's references show a face (the provenance `hasFace` flag). */
export function characterReferenceHasFace(character: Pick<Character, 'kind'>): boolean {
  return (character.kind ?? 'person') !== 'object';
}

/**
 * Parses a comma-separated angle list. Valid names come back in canonical
 * order; unknown names come back in `invalid` for the caller to report.
 */
export function parseCharacterAngles(list: string): { angles: CharacterAngle[]; invalid: string[] } {
  const requested = list.split(',').map(a => a.trim()).filter(Boolean);
  const known = new Set<string>(CHARACTER_ANGLES);
  return {
    angles: CHARACTER_ANGLES.filter(a => requested.includes(a)),
    invalid: requested.filter(a => !known.has(a)),
  };
}

export interface CharacterReferenceRequestOptions {
  model?: string;
  cfgScale?: number;
  aspectRatio?: string;
  resolution?: string;
  /** Default: the character's own seed. */
  seed?: number;
  /** The series' `imageDefaults.negativePromptStrategy`. Default `'auto'`. */
  negativePromptStrategy?: 'auto' | 'stylized' | 'photoreal' | 'none';
  /** Replaces the built positive prompt verbatim. */
  prompt?: string;
  /** Replaces the whole negative prompt verbatim. */
  negativePrompt?: string;
}

/** The `/image/generate` body for one reference angle. */
export interface CharacterReferenceRequest {
  model: string;
  prompt: string;
  negative_prompt: string;
  resolution: string;
  aspect_ratio: string;
  steps: number;
  cfg_scale: number;
  seed: number;
  safe_mode: false;
  hide_watermark: true;
}

export function buildCharacterReferenceRequest(
  character: Character,
  aesthetic: AestheticProfile,
  angle: CharacterAngle,
  options: CharacterReferenceRequestOptions = {},
): CharacterReferenceRequest {
  const model = options.model ?? DEFAULT_IMAGE_GENERATION_MODEL;
  const { positive, negativeAdditions } = buildCharacterReferencePromptParts(character, aesthetic, angle, {
    model,
    negativePromptStrategy: options.negativePromptStrategy ?? 'auto',
  });
  return {
    model,
    prompt: options.prompt ?? positive,
    negative_prompt: options.negativePrompt ?? [...CHARACTER_REFERENCE_NEGATIVES, ...negativeAdditions].join(', '),
    resolution: options.resolution ?? CHARACTER_REFERENCE_DEFAULTS.resolution,
    aspect_ratio: options.aspectRatio ?? CHARACTER_REFERENCE_DEFAULTS.aspectRatio,
    steps: CHARACTER_REFERENCE_DEFAULTS.steps,
    cfg_scale: options.cfgScale ?? CHARACTER_REFERENCE_DEFAULTS.cfgScale,
    seed: options.seed ?? character.seed,
    safe_mode: false,
    hide_watermark: true,
  };
}
