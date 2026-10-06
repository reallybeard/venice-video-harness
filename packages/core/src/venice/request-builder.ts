// ---------------------------------------------------------------------------
// `/video/queue` request bodies -- pure. Plain data in, plain data out.
//
// Every image and audio input is ALREADY a string Venice accepts (a `data:`
// URI or an https URL): the host resolves its references (the CLI reads files
// and pads audio with ffmpeg; a browser reads its asset store) and core decides
// what goes in the body. Two builders, matching the two CLI call paths:
//
//   buildVideoQueueRequest          the render path (`renderVideoFile`): pure
//                                   reference mode, per-family resolution pins,
//                                   aspect for R2V / t2v, `audio` omission,
//                                   reference budgets, voice-donor and
//                                   lip-sync reference audio.
//   buildRegistryVideoQueueRequest  `queueVideo`: capability flags straight
//                                   from the registry entry, aspect /
//                                   resolution / end image via buildModelParams.
//
// The two disagree in places (resolution pins, aspect defaults, which
// capability source gates refs); both are kept as they were. Call
// `planVideoQueueRequest` first to learn which inputs the body will use, so a
// host only resolves (and uploads) what is sent.
// ---------------------------------------------------------------------------

import type { CameraKeyframe, VideoElement, VideoQueueConsents, VideoQueueRequest, SeedanceFaceConsent } from './types.js';
import {
  buildModelParams,
  getVideoModel,
  resolveBitrateMode,
  validateCameraTrajectory,
  type BitrateMode,
  type VideoRequestIssue,
} from './models.js';
import {
  LIP_SYNC_REFERENCE_AUDIO_MAX_SEC,
  MODELS_LIP_SYNC_VIA_REFERENCE_AUDIO,
  MODELS_SUPPORTING_AUDIO_INPUT,
  MODELS_SUPPORTING_ELEMENTS,
  MODELS_SUPPORTING_END_IMAGE,
  MODELS_SUPPORTING_PER_REFERENCE_AUDIO,
  MODELS_SUPPORTING_REFERENCE_AUDIO,
  MODELS_SUPPORTING_REFERENCE_IMAGES,
  MODELS_SUPPORTING_SCENE_IMAGES,
  MODELS_USING_IMAGE_TAGS,
  getMaxReferenceImages,
} from '../series/types.js';
import type { Logger } from '../ports.js';

/** Where the builders write their notes. Defaults to `console.log` / `console.warn`. */
export type RequestLogger = Pick<Logger, 'info' | 'warn'>;

const consoleLogger: RequestLogger = {
  info: message => console.log(message),
  warn: message => console.warn(message),
};

// ---- Voice-donor and lip-sync reference audio rules ------------------------

/** Each voice-donor clip must be 2-15s; the clips together at most 15s. */
export const VOICE_REF_MIN_SEC = 2;
export const VOICE_REF_MAX_SEC = 15;
/** At most this many voice-donor clips per request. */
export const MAX_VOICE_REFERENCE_CLIPS = 3;

/**
 * Why a voice-donor clip of `durationSec` cannot join a request that already
 * carries `aggregateSec` of accepted clips, as the warning line to print, or
 * `undefined` when it fits. `label` names the clip in the message (a path).
 * The ≤3-clip cap is the caller's loop condition (`MAX_VOICE_REFERENCE_CLIPS`).
 */
export function voiceReferenceClipIssue(label: string, durationSec: number, aggregateSec: number): string | undefined {
  if (durationSec < VOICE_REF_MIN_SEC || durationSec > VOICE_REF_MAX_SEC) {
    return `  ⚠ Voice reference ${label} is ${durationSec.toFixed(2)}s (must be ${VOICE_REF_MIN_SEC}-${VOICE_REF_MAX_SEC}s); skipping.`;
  }
  if (aggregateSec + durationSec > VOICE_REF_MAX_SEC) {
    return `  ⚠ Voice reference aggregate would exceed ${VOICE_REF_MAX_SEC}s; skipping ${label}.`;
  }
  return undefined;
}

export interface LipSyncReferenceAudioPlan {
  /** Pad (with trailing silence) or cut the clip to exactly this many seconds before sending. */
  targetSec: number;
  /** Warning lines to print. */
  warnings: string[];
}

/**
 * Length to send a lip-sync dialogue clip at on a reference-audio lip-sync
 * model (Wan 3.0 R2V, `MODELS_LIP_SYNC_VIA_REFERENCE_AUDIO`). Unpadded tails
 * get invented speech, so the clip is padded with silence to the render
 * length (capped at `LIP_SYNC_REFERENCE_AUDIO_MAX_SEC`). Throws when the clip
 * itself is over the cap: nothing should be queued. `label` names the clip.
 * The CLI sends the result as PCM WAV: an MP3's encoder delay decodes ~50ms
 * long on the provider side, which tips a 15.0s clip over the cap.
 */
export function planLipSyncReferenceAudio(input: {
  model: string;
  audioSec: number;
  /** The render duration (`'10s'`). */
  duration: string;
  label: string;
}): LipSyncReferenceAudioPlan {
  const { model, audioSec, label } = input;
  // An MP3's probed length includes encoder padding (~20-50ms, varies by
  // encoder build); the clip is re-cut to at most the cap below, so only
  // refuse a line that is really over it.
  if (audioSec > LIP_SYNC_REFERENCE_AUDIO_MAX_SEC + 0.05) {
    throw new Error(
      `Lip-sync audio ${label} is ${audioSec.toFixed(2)}s; ${model} accepts at most ` +
      `${LIP_SYNC_REFERENCE_AUDIO_MAX_SEC}s of reference audio per render (split the line). Not queued.`,
    );
  }
  const warnings: string[] = [];
  const renderSec = parseInt(String(input.duration), 10);
  let targetSec = audioSec;
  if (Number.isFinite(renderSec)) {
    if (audioSec > renderSec + 0.05) {
      // Wan re-performs the reference instead of following it when the
      // clip outruns the render, so the mouth no longer matches the file.
      warnings.push(`  ⚠ Lip-sync audio is ${audioSec.toFixed(2)}s but the render is ${renderSec}s; Wan will re-perform it rather than follow it.`);
    } else {
      targetSec = Math.min(renderSec, LIP_SYNC_REFERENCE_AUDIO_MAX_SEC);
      if (renderSec > LIP_SYNC_REFERENCE_AUDIO_MAX_SEC) {
        warnings.push(`  ⚠ Render is ${renderSec}s but reference audio caps at ${LIP_SYNC_REFERENCE_AUDIO_MAX_SEC}s; the model may invent speech after it.`);
      }
    }
  }
  return { targetSec, warnings };
}

// ---- Seedance face consent -------------------------------------------------

/** The attestation the CLI attaches after a 409 `needs_consent`. */
export const SEEDANCE_FACE_CONSENT: SeedanceFaceConsent = {
  confirmed_terms_and_privacy: true,
  confirmed_legal_right: true,
  confirmed_screening_acknowledged: true,
};

/** True for Venice's non-charging 409 asking for the Seedance face-media attestation. */
export function isNeedsConsentError(status: number, body: unknown): boolean {
  return status === 409
    && (body as { error?: { code?: string } } | undefined)?.error?.code === 'needs_consent';
}

/** The same body with `consents.seedance` attesting the face-media policy (added last). */
export function withSeedanceFaceConsent<T extends object>(request: T): T & { consents: VideoQueueConsents } {
  return {
    ...request,
    consents: {
      seedance: { ...SEEDANCE_FACE_CONSENT },
    },
  };
}

// ---- Render-path builder ----------------------------------------------------

export interface VideoQueuePlanInput {
  model: string;
  /** Slots in the prompt's @Image plan (`MiniDramaVideoPrompt.referenceSlots.length`). */
  referenceSlotCount?: number;
  /** Whether the caller has any reference image for the request. */
  hasReferenceImages?: boolean;
  /** Whether the caller has a dialogue clip for `audio_url` / lip-sync reference audio. */
  hasDialogueAudio?: boolean;
  /** Validated here when the model takes one, so a bad orbit fails before any media is prepared. */
  cameraTrajectory?: CameraKeyframe[];
}

/** Which inputs `buildVideoQueueRequest` will put in the body for a model. */
export interface VideoQueuePlan {
  model: string;
  /**
   * Pure reference mode: no `image_url`. On @Image-tag R2V models with a slot
   * plan, the references carry all consistency (a start frame would fight the
   * blocking plate for composition); also for reference-audio lip-sync.
   */
  referencesOnly: boolean;
  /** Reference-audio lip-sync (Wan 3.0 R2V): the dialogue clip goes out as `reference_audio_urls`. */
  lipSyncViaReferenceAudio: boolean;
  /** False for `audioConfigurable: false` models (HappyHorse, MiniMax H3 / H3 Max): the field must be absent. */
  sendsAudioField: boolean;
  acceptsEndImage: boolean;
  acceptsAudioUrl: boolean;
  acceptsElements: boolean;
  /** Each element may carry its own `audio_url` (Wan 2.7 R2V `per_reference_audio`). */
  acceptsPerElementAudio: boolean;
  acceptsReferenceImages: boolean;
  /** `reference_image_urls` is cut to this many (the model's @Image budget). */
  referenceImageBudget: number;
  acceptsSceneImages: boolean;
  /** `scene_image_urls` is cut to this many. */
  sceneImageBudget: number;
  /** Voice-donor clips (@AudioN); sent only alongside at least one reference image. */
  acceptsReferenceAudio: boolean;
  /** The model lip-syncs to a dialogue clip sent as reference audio. */
  acceptsLipSyncReferenceAudio: boolean;
  acceptsCameraTrajectory: boolean;
}

const SCENE_IMAGE_BUDGET = 4;

/**
 * Decide which inputs a request to `model` will use. Pure; logs nothing.
 * Throws when `cameraTrajectory` is given, the model takes one, and it is
 * invalid.
 */
export function planVideoQueueRequest(input: VideoQueuePlanInput): VideoQueuePlan {
  const { model } = input;
  const spec = getVideoModel(model);
  const hasSlotPlan = (input.referenceSlotCount ?? 0) > 0;
  const hasReferenceImages = Boolean(input.hasReferenceImages);
  const lipSyncViaReferenceAudio = MODELS_LIP_SYNC_VIA_REFERENCE_AUDIO.has(model)
    && Boolean(input.hasDialogueAudio)
    && hasReferenceImages;
  const referencesOnly = lipSyncViaReferenceAudio
    || (hasSlotPlan && MODELS_USING_IMAGE_TAGS.has(model) && hasReferenceImages);
  const acceptsCameraTrajectory = spec?.supportsCameraTrajectory === true;
  if (acceptsCameraTrajectory && input.cameraTrajectory && input.cameraTrajectory.length > 0) {
    const { ok, errors } = validateCameraTrajectory(input.cameraTrajectory);
    if (!ok) throw new Error(`Invalid camera_trajectory for ${model}: ${errors.join('; ')}`);
  }
  const acceptsReferenceImages = MODELS_SUPPORTING_REFERENCE_IMAGES.has(model);
  const acceptsSceneImages = MODELS_SUPPORTING_SCENE_IMAGES.has(model);
  return {
    model,
    referencesOnly,
    lipSyncViaReferenceAudio,
    sendsAudioField: !(spec && spec.audioConfigurable === false),
    acceptsEndImage: MODELS_SUPPORTING_END_IMAGE.has(model),
    acceptsAudioUrl: MODELS_SUPPORTING_AUDIO_INPUT.has(model),
    acceptsElements: MODELS_SUPPORTING_ELEMENTS.has(model),
    acceptsPerElementAudio: MODELS_SUPPORTING_PER_REFERENCE_AUDIO.has(model),
    acceptsReferenceImages,
    referenceImageBudget: acceptsReferenceImages ? getMaxReferenceImages(model) : 0,
    acceptsSceneImages,
    sceneImageBudget: acceptsSceneImages ? SCENE_IMAGE_BUDGET : 0,
    acceptsReferenceAudio: MODELS_SUPPORTING_REFERENCE_AUDIO.has(model),
    acceptsLipSyncReferenceAudio: MODELS_LIP_SYNC_VIA_REFERENCE_AUDIO.has(model),
    acceptsCameraTrajectory,
  };
}

/**
 * The `reference_image_urls` a request to `model` will carry for these
 * references: cut to the model's budget, empty strings dropped, `undefined`
 * when the model takes none or none were given. A host deciding whether to
 * prepare voice-donor clips (they need a reference image) asks this.
 */
export function videoQueueReferenceImages(model: string, urls: readonly string[] | undefined): string[] | undefined {
  if (!urls || urls.length === 0 || !MODELS_SUPPORTING_REFERENCE_IMAGES.has(model)) return undefined;
  return urls.slice(0, getMaxReferenceImages(model)).filter(Boolean);
}

/**
 * The resolution `buildVideoQueueRequest` sends: an explicit override the
 * model lists, else the family pin, else none (the model default).
 * `minimax-h3-max` is matched BEFORE `minimax-h3`: H3 Max rejects 2K and the
 * substring would otherwise pin it there.
 */
export function resolveRequestResolution(model: string, override?: string): string | undefined {
  if (override && getVideoModel(model)?.resolutions.includes(override)) return override;
  if (model.includes('seedance')) return '720p';
  // H3 Max / Max Turbo top out at 768P and reject 2K outright. 480P exists
  // as a draft tier but is not auto-selected; 768P is the finish resolution.
  if (model.includes('minimax-h3-max')) return '768P';
  // 2K is H3's only resolution — anything else is a hard 400.
  if (model.includes('minimax-h3')) return '2K';
  if (model.includes('veo')) return '720p';
  if (model.includes('wan-2.6') || model.includes('wan-2.5')) return '1080p';
  if (model.includes('ltx-2')) return '1080p';
  if (model.includes('sora-2-pro')) return '1080p';
  if (model.includes('sora-2')) return '720p';
  return undefined;
}

/**
 * Whether the request carries `aspect_ratio`. Image-to-video inherits aspect
 * from the start image; reference-to-video and text-to-video take it
 * explicitly (MiniMax H3 / H3 Max t2v return HTTP 400 "aspect_ratio:
 * Required" without it), and so does every non-i2v Seedance id.
 */
export function requestTakesAspectRatio(model: string): boolean {
  return model.includes('reference-to-video')
    || model.includes('text-to-video')
    || (model.includes('seedance') && !model.includes('image-to-video'));
}

export interface VideoQueueRequestInput {
  model: string;
  prompt: string;
  duration: string;
  /** The prompt's audio flag; omitted from the body on models whose audio is not configurable. */
  audio: boolean;
  negativePrompt?: string;
  /** Sent on R2V / t2v / non-i2v Seedance; defaults to `'16:9'` there. */
  aspectRatio?: string;
  /** Explicit resolution; honoured only when the model lists it, else the family pin applies. */
  resolution?: string;
  bitrateMode?: BitrateMode;
  /** `MiniDramaVideoPrompt.referenceSlots.length` (pure reference mode needs a slot plan). */
  referenceSlotCount?: number;
  /** The prompt maps characters to elements (`characterElements`); only feeds a drift warning on non-R2V models. */
  hasCharacterElements?: boolean;
  /** Start frame. Ignored in pure reference mode. */
  startImageUrl?: string;
  /** Names the start frame in the "no start image" warning (the CLI passes the path it looked for). */
  startImageLabel?: string;
  endImageUrl?: string;
  /** In @ImageN slot order (`referenceSlots[i].ref` → URL). Cut to the model's budget. */
  referenceImageUrls?: string[];
  /** Cut to 4. */
  sceneImageUrls?: string[];
  /** Wire elements, images (and per-element `audio_url`) already resolved. */
  elements?: VideoElement[];
  /** `audio_url`, already padded to the model minimum. */
  audioUrl?: string;
  /**
   * The caller has a dialogue clip (the CLI: `audioPath` was given). Gates
   * reference-audio lip-sync mode even when the clip could not be prepared.
   */
  hasDialogueAudio?: boolean;
  /** Reference-audio lip-sync clip (Wan 3.0 R2V), already padded/trimmed (`planLipSyncReferenceAudio`). */
  lipSyncReferenceAudioUrl?: string;
  /**
   * Voice-donor clips, in @AudioN order, already within the clip budget
   * (`voiceReferenceClipIssue`, `MAX_VOICE_REFERENCE_CLIPS`).
   */
  referenceAudioUrls?: string[];
  /**
   * How many voice references the caller started with, when it filtered
   * some out (missing, out of budget). Only the "does not support" / "no
   * reference image" warnings read it; defaults to `referenceAudioUrls.length`.
   */
  voiceReferenceCount?: number;
  videoUrl?: string;
  cameraTrajectory?: CameraKeyframe[];
  /** Face-media attestation; normally added only after a 409 (`withSeedanceFaceConsent`). */
  consents?: VideoQueueConsents;
}

export interface BuildRequestOptions {
  logger?: RequestLogger;
}

/**
 * Build the `/video/queue` body the render path sends. Pure; writes the same
 * notes the CLI always printed to `options.logger` (console by default).
 * Throws on an invalid `cameraTrajectory` for a model that takes one.
 *
 * Key order is part of the contract (the CLI's bodies are byte-identical to
 * what it sent before this moved into core).
 */
export function buildVideoQueueRequest(input: VideoQueueRequestInput, options: BuildRequestOptions = {}): VideoQueueRequest {
  const log = options.logger ?? consoleLogger;
  const { model } = input;
  const referenceImageUrls = input.referenceImageUrls ?? [];
  const hasDialogueAudio = input.hasDialogueAudio ?? Boolean(input.lipSyncReferenceAudioUrl);
  const plan = planVideoQueueRequest({
    model,
    referenceSlotCount: input.referenceSlotCount,
    hasReferenceImages: referenceImageUrls.length > 0,
    hasDialogueAudio,
    cameraTrajectory: input.cameraTrajectory,
  });

  const body: VideoQueueRequest = {
    model,
    prompt: input.prompt,
    duration: input.duration,
    audio: input.audio,
  };

  // Models with audioConfigurable:false (e.g. HappyHorse 1.1) return HTTP 400
  // when the `audio` field is present with a non-default value — probed
  // 2026-07-30 (`audio: false` 400'd on happyhorse-1-1-reference-to-video).
  // Omit the field entirely for those models.
  if (!plan.sendsAudioField) {
    if (input.audio === false) {
      log.warn(`  ⚠ ${model} does not support audio toggling; omitting audio:false (model output will include native audio).`);
    }
    delete body.audio;
  }

  if (plan.referencesOnly) {
    log.info('  Start frame: none (pure reference mode — refs carry consistency)');
  } else if (input.startImageUrl) {
    body.image_url = input.startImageUrl;
  } else if (!model.includes('text-to-video')) {
    log.warn(`  ⚠ No start image available (${input.startImageLabel ?? 'none'}) and not in reference mode — request may fail on i2v models.`);
  }

  if (input.negativePrompt) {
    body.negative_prompt = input.negativePrompt;
  }

  if (input.endImageUrl && plan.acceptsEndImage) {
    body.end_image_url = input.endImageUrl;
  }

  // camera_trajectory: MiniMax H3 Max Multi-Angle only (validated in the plan).
  const trajectory = input.cameraTrajectory;
  if (trajectory && trajectory.length > 0) {
    if (plan.acceptsCameraTrajectory) {
      body.camera_trajectory = trajectory;
      log.info(`  Camera trajectory: ${trajectory.length} keyframe(s), azimuth ${trajectory[0].azimuth}°→${trajectory[trajectory.length - 1].azimuth}°`);
    } else {
      log.warn(`  ⚠ Model ${model} does not support camera_trajectory; dropping it.`);
    }
  }

  if (input.resolution && !getVideoModel(model)?.resolutions.includes(input.resolution)) {
    log.warn(`  ⚠ Resolution override ${input.resolution} not valid for ${model}; using the model default.`);
  }
  const resolution = resolveRequestResolution(model, input.resolution);
  if (resolution !== undefined) body.resolution = resolution;

  // bitrate_mode: Seedance 2.5 encodes at 'high' by default — ~5-6x the
  // bitrate for a sharp, artifact-free file at no extra token cost. Other
  // families don't accept the field, so it's left off the body.
  const bitrateMode = resolveBitrateMode(model, input.bitrateMode);
  if (bitrateMode) body.bitrate_mode = bitrateMode;

  if (requestTakesAspectRatio(model)) {
    body.aspect_ratio = input.aspectRatio ?? '16:9';
  }

  // audio_url: models that take a global dialogue clip. Reference-audio
  // lip-sync models get it as reference_audio_urls below; per-reference-audio
  // R2V models (Wan 2.7) per element.
  if (plan.acceptsAudioUrl) {
    if (input.audioUrl) body.audio_url = input.audioUrl;
  } else if (plan.acceptsLipSyncReferenceAudio && hasDialogueAudio) {
    // Attached as reference_audio_urls after the reference images are set.
  } else if (hasDialogueAudio || input.audioUrl) {
    // Model doesn't accept audio_url — drop quietly rather than 400.
    if (!plan.acceptsPerElementAudio) {
      log.warn(`  Model ${model} does not accept audio_url; dropping audio attach.`);
    }
  }

  if (input.videoUrl) {
    body.video_url = input.videoUrl;
  }

  if (input.elements && input.elements.length > 0 && plan.acceptsElements) {
    body.elements = input.elements.map(el => {
      if (plan.acceptsPerElementAudio || el.audio_url === undefined) return el;
      const { audio_url: _dropped, ...rest } = el;
      return rest;
    });
    log.info(`  Elements: ${body.elements.length} character/object reference(s)`);
  }

  if (referenceImageUrls.length > 0 && plan.acceptsReferenceImages) {
    if (referenceImageUrls.length > plan.referenceImageBudget) {
      log.warn(`  ⚠ ${referenceImageUrls.length} reference images exceed ${model}'s ${plan.referenceImageBudget}-image budget; truncating (check the slot allocator).`);
    }
    body.reference_image_urls = videoQueueReferenceImages(model, referenceImageUrls);
    log.info(`  Reference images (@Image1..@Image${body.reference_image_urls!.length}): ${body.reference_image_urls!.length}`);
  }

  if (input.sceneImageUrls && input.sceneImageUrls.length > 0 && plan.acceptsSceneImages) {
    body.scene_image_urls = input.sceneImageUrls.slice(0, plan.sceneImageBudget).filter(Boolean);
    log.info(`  Scene images: ${body.scene_image_urls.length}`);
  }

  if (plan.acceptsLipSyncReferenceAudio && hasDialogueAudio) {
    if (!plan.lipSyncViaReferenceAudio) {
      log.warn('  ⚠ Lip-sync audio present but no reference image — dropping it (Venice rejects audio-only reference audio).');
    } else if (input.lipSyncReferenceAudioUrl) {
      body.reference_audio_urls = [input.lipSyncReferenceAudioUrl];
    }
  }

  // Voice-donor reference audio (@Audio1, @Audio2, …). Gated on model support
  // AND the presence of ≥1 reference image (Venice rejects audio-only).
  const voiceUrls = input.referenceAudioUrls ?? [];
  const voiceCount = input.voiceReferenceCount ?? voiceUrls.length;
  if (voiceCount > 0 && plan.acceptsReferenceAudio) {
    const hasReferenceImage = Array.isArray(body.reference_image_urls) && body.reference_image_urls.length > 0;
    if (!hasReferenceImage) {
      log.warn('  ⚠ Voice references present but no reference image — dropping (Venice rejects audio-only reference audio).');
    } else if (voiceUrls.length > 0) {
      body.reference_audio_urls = voiceUrls;
    }
  } else if (voiceCount > 0) {
    log.warn(`  ⚠ Model ${model} does not support reference_audio_urls; dropping ${voiceCount} voice reference(s).`);
  }

  if (input.aspectRatio && body.aspect_ratio && body.aspect_ratio !== input.aspectRatio) {
    log.warn(`  ⚠ Aspect ratio mismatch: sending ${body.aspect_ratio} but series expects ${input.aspectRatio}`);
  }

  if (input.hasCharacterElements && !model.includes('reference-to-video')) {
    log.warn(`  ⚠ Shot has characters but model ${model} is NOT R2V — character identity may drift`);
  }

  if (input.consents) body.consents = input.consents;

  return body;
}

// ---- Registry-path builder (`queueVideo`) ----------------------------------

export interface RegistryVideoQueueRequestOptions {
  model: string;
  prompt: string;
  duration: string;
  imageUrl?: string;
  endImageUrl?: string;
  negativePrompt?: string;
  aspectRatio?: string;
  resolution?: string;
  audio?: boolean;
  audioUrl?: string;
  videoUrl?: string;
  referenceImageUrls?: string[];
  elements?: Array<{
    frontal_image_url?: string;
    reference_image_urls?: string[];
    video_url?: string;
  }>;
  sceneImageUrls?: string[];
  /**
   * Voice-donor reference clips (data URLs or HTTP URLs), bound in-prompt as
   * @Audio1, @Audio2, …. Only sent to reference-audio-capable models and only
   * when at least one reference image is present (Venice rejects audio-only).
   */
  referenceAudioUrls?: string[];
  /**
   * Camera-orbit keyframes for MiniMax H3 Max Multi-Angle. Only sent to models
   * that accept `camera_trajectory` (`supportsCameraTrajectory`); validated in
   * `buildModelParams` before the request goes out. Build with
   * `buildOrbitTrajectory` / `buildStartEndTrajectory`.
   */
  cameraTrajectory?: CameraKeyframe[];
  /**
   * Output encoding bitrate mode. Only sent to models that accept it (Seedance
   * 2.x). When omitted, Seedance 2.5 defaults to `'high'` — a large fidelity
   * gain at no extra cost. Pass `'standard'` to opt back into smaller files.
   */
  bitrateMode?: BitrateMode;
}

/**
 * Apply `validateVideoRequest` issues as snaps: the duration becomes the
 * closest valid one, the resolution the suggestion (or the model default when
 * there is none), each with a warning. For callers that opted in to snapping
 * (`queueVideo({ snap: true })`); without it an issue should be an error.
 */
export function snapVideoRequest(
  values: { duration: string; resolution?: string },
  issues: VideoRequestIssue[],
  options: BuildRequestOptions = {},
): { duration: string; resolution?: string } {
  const log = options.logger ?? consoleLogger;
  let { duration, resolution } = values;
  for (const issue of issues) {
    log.warn(`  ${issue.message}. Snapping to ${issue.suggestion ?? '(model default)'}.`);
    if (issue.field === 'duration') duration = issue.suggestion ?? duration;
    if (issue.field === 'resolution') resolution = issue.suggestion;
  }
  return { duration, resolution };
}

/**
 * Build the `/video/queue` body `queueVideo` sends: capability flags straight
 * from the registry entry (an unknown model gets everything passed through),
 * aspect / resolution / end image / camera trajectory via `buildModelParams`.
 * Duration and resolution must already be validated (or snapped).
 */
export function buildRegistryVideoQueueRequest(
  options: RegistryVideoQueueRequestOptions,
  buildOptions: BuildRequestOptions = {},
): VideoQueueRequest {
  const log = buildOptions.logger ?? consoleLogger;
  const modelSpec = getVideoModel(options.model);

  const body: Record<string, unknown> = {
    model: options.model,
    prompt: options.prompt,
    duration: options.duration,
    audio: options.audio ?? true,
  };

  // Models with audioConfigurable:false (H3 Max family incl. Multi-Angle,
  // HappyHorse 1.1, …) return HTTP 400 "This model does not support audio
  // configuration" when the `audio` field is present. Omit it entirely — the
  // render still carries the model's native audio.
  if (modelSpec && modelSpec.audioConfigurable === false) {
    delete body.audio;
  }

  if (options.imageUrl) body.image_url = options.imageUrl;
  if (options.negativePrompt) body.negative_prompt = options.negativePrompt;
  if (options.audioUrl) body.audio_url = options.audioUrl;
  if (options.videoUrl) body.video_url = options.videoUrl;

  // R2V models require aspect_ratio — warn if not explicitly set
  if (modelSpec?.id.includes('reference-to-video') && !options.aspectRatio) {
    log.warn(`  ⚠ No aspect_ratio provided for R2V model ${options.model} — defaulting to 16:9. Set explicitly to avoid wrong orientation.`);
  }

  const modelParams = buildModelParams(options.model, {
    aspectRatio: options.aspectRatio,
    resolution: options.resolution,
    endImageUrl: options.endImageUrl,
    cameraTrajectory: options.cameraTrajectory,
  });
  Object.assign(body, modelParams);

  // bitrate_mode: Seedance 2.5 defaults to 'high' (sharper encode, no price
  // change); other models don't accept the field, so it's omitted for them.
  const bitrateMode = resolveBitrateMode(options.model, options.bitrateMode);
  if (bitrateMode) body.bitrate_mode = bitrateMode;

  if (options.elements && options.elements.length > 0) {
    if (!modelSpec || modelSpec.supportsElements) {
      body.elements = options.elements;
    }
  }

  if (options.referenceImageUrls && options.referenceImageUrls.length > 0) {
    if (!modelSpec || modelSpec.supportsReferenceImages) {
      body.reference_image_urls = options.referenceImageUrls;
    }
  }

  if (options.sceneImageUrls && options.sceneImageUrls.length > 0) {
    if (!modelSpec || modelSpec.supportsSceneImages) {
      body.scene_image_urls = options.sceneImageUrls;
    }
  }

  // Voice-donor reference audio (@Audio1, @Audio2, …). Gated on model support
  // AND on the presence of at least one reference image — Venice rejects
  // audio-only reference_audio_urls at validation.
  if (options.referenceAudioUrls && options.referenceAudioUrls.length > 0) {
    const supportsRefAudio = modelSpec
      ? modelSpec.supportsReferenceAudio === true
      : MODELS_SUPPORTING_REFERENCE_AUDIO.has(options.model);
    const hasReferenceImage = Array.isArray(body.reference_image_urls)
      && (body.reference_image_urls as string[]).length > 0;
    if (supportsRefAudio && hasReferenceImage) {
      // Enforce the aggregate ≤3-clip budget defensively.
      body.reference_audio_urls = options.referenceAudioUrls.slice(0, MAX_VOICE_REFERENCE_CLIPS);
    } else if (supportsRefAudio && !hasReferenceImage) {
      log.warn(`  ⚠ Dropping reference_audio_urls for ${options.model}: no reference image present (Venice rejects audio-only reference audio).`);
    } else {
      log.warn(`  ⚠ Model ${options.model} does not support reference_audio_urls; dropping.`);
    }
  }

  return body as unknown as VideoQueueRequest;
}
