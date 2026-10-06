// ---------------------------------------------------------------------------
// Mini-drama prompt builders, CLI side.
//
// The builders are pure and live in core
// (`venice-video-harness/core/mini-drama/prompt-builder.js`). The ones that
// cite reference images as @ImageN take the shot's `ReferenceSet` there; this
// module keeps the CLI's signatures and supplies the set from disk
// (`referenceSetFromDisk`), so every caller is unchanged.
// ---------------------------------------------------------------------------

import type {
  AudioMixDefaults,
  GenerationUnit,
  SeriesState,
  ShotScript,
} from 'venice-video-harness/core/series/types.js';
import {
  buildMontagePrompt as buildMontagePromptFromRefs,
  buildMultiShotPrompt as buildMultiShotPromptFromRefs,
  buildVideoPrompt as buildVideoPromptFromRefs,
  type MiniDramaVideoPrompt,
  type ReferenceSetSource,
} from 'venice-video-harness/core/mini-drama/prompt-builder.js';
import { referenceSetFromDisk } from './reference-set-from-disk.js';

export {
  resolveVideoModel,
  buildImagePrompt,
  buildKlingMultiShotPrompt,
  buildCharacterReferencePrompt,
  buildCharacterReferencePromptParts,
} from 'venice-video-harness/core/mini-drama/prompt-builder.js';
export type {
  MiniDramaImagePrompt,
  CharacterElementSlot,
  VoiceReferenceSlot,
  MiniDramaVideoPrompt,
  ModelResolution,
} from 'venice-video-harness/core/mini-drama/prompt-builder.js';

/** References from the project directory, built only when a prompt needs them. */
function referencesFromDisk(series: SeriesState): ReferenceSetSource {
  return (shot, options) => referenceSetFromDisk(series, shot, options);
}

export function buildVideoPrompt(
  shot: ShotScript,
  series: SeriesState,
  previousShot?: ShotScript,
  episodeAudioMix?: AudioMixDefaults,
): MiniDramaVideoPrompt {
  return buildVideoPromptFromRefs(shot, series, referencesFromDisk(series), previousShot, episodeAudioMix);
}

export function buildMultiShotPrompt(
  shots: ShotScript[],
  unit: GenerationUnit,
  series: SeriesState,
): MiniDramaVideoPrompt {
  return buildMultiShotPromptFromRefs(shots, unit, series, referencesFromDisk(series));
}

export function buildMontagePrompt(
  shots: ShotScript[],
  unit: GenerationUnit,
  series: SeriesState,
): MiniDramaVideoPrompt {
  return buildMontagePromptFromRefs(shots, unit, series, referencesFromDisk(series));
}
