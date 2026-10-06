// ---------------------------------------------------------------------------
// One video render, end to end, over the ports -- the body of the CLI's
// `renderVideoFile`, with every file, ffmpeg and network touch behind an
// interface:
//
//   faces-off decision ─▶ request plan ─▶ media (only what the plan sends)
//     ─▶ buildVideoQueueRequest ─▶ runVideoJob (re-attach or queue, poll,
//     store, complete) ─▶ "Video saved" ─▶ recipe pass
//
// Two seams, by what the IO is:
//
//   ports (HarnessPorts subset)  references.url for every image, the video
//                                backend / clock / logger for the job.
//   RenderVideoMedia             what has no port: whether a ref exists, the
//                                `hasFace` provenance read, audio URLs, audio
//                                probing and padding (ffmpeg in the CLI), and
//                                the recipe sidecar write. Injected callbacks
//                                rather than new port methods: they are the
//                                render path's needs, not a general store.
//
// Pure: no timers (Clock), no IO of its own, no Node APIs.
// ---------------------------------------------------------------------------

import type { Logger, MediaRef, PortCallOptions, ReferenceStore } from '../ports.js';
import type { VideoElement } from '../series/types.js';
import type { BitrateMode } from '../venice/models.js';
import { isFacesOffModel } from '../venice/models.js';
import type {
  CameraKeyframe,
  VideoElement as WireVideoElement,
  VideoQueueRequest,
  VideoRetrieveStatus,
} from '../venice/types.js';
import { decideFacesOff, FacesOffModelError, type FacesOffImage } from '../venice/faces-off.js';
import {
  MAX_VOICE_REFERENCE_CLIPS,
  buildVideoQueueRequest,
  planLipSyncReferenceAudio,
  planVideoQueueRequest,
  videoQueueReferenceImages,
  voiceReferenceClipIssue,
} from '../venice/request-builder.js';
import {
  RENDER_FILE_VIDEO_JOB_POLICY,
  VideoJobGoneError,
  runVideoJob,
  type VideoJobPolicy,
  type VideoJobPorts,
  type VideoJobResult,
} from '../venice/render-job.js';
import type { MiniDramaVideoPrompt } from './prompt-builder.js';

/** What one render sends. Image and audio fields are refs (CLI: paths) unless they already are `data:` URIs. */
export interface RenderVideoRequest {
  prompt: Pick<MiniDramaVideoPrompt, 'model' | 'prompt' | 'duration' | 'audio' | 'referenceSlots' | 'characterElements'>;
  /** Where the clip goes; also the pending-job key. */
  outputKey: MediaRef;
  /** Start frame. Omitted (or ignored) in pure reference mode. */
  anchorImage?: MediaRef;
  endFrameImage?: MediaRef;
  elements?: VideoElement[];
  /** In @ImageN slot order. */
  referenceImages?: MediaRef[];
  sceneImages?: MediaRef[];
  negativePrompt?: string;
  /** A ready `audio_url` value, used when no `dialogueAudio` is given or it cannot be prepared. */
  audioUrl?: string;
  /** Dialogue clip: padded to the model minimum for `audio_url`, or sent as lip-sync reference audio. */
  dialogueAudio?: MediaRef;
  videoUrl?: string;
  aspectRatio?: string;
  bitrateMode?: BitrateMode;
  /** Characters on screen; feeds the faces-off decision. */
  characters?: string[];
  characterKinds?: Record<string, 'person' | 'object'>;
  /** Voice-donor clips in @AudioN order. */
  voiceReferences?: MediaRef[];
  project?: string;
  episode?: number;
  resolution?: string;
  cameraTrajectory?: CameraKeyframe[];
}

/** An audio clip after the model's minimum-length pre-flight. */
export interface PreparedAudio {
  ref: MediaRef;
  /** True when silence was appended (the ref is then a new file). */
  padded: boolean;
  durationSec: number;
}

/** The render path's IO that no port covers. */
export interface RenderVideoMedia {
  /** Whether a ref resolves to stored media. A missing image is sent as its raw ref (the CLI's behaviour). */
  exists(ref: MediaRef): Promise<boolean>;
  /** The image's provenance `hasFace`; `undefined` when unrecorded. Only read on faces-off models. */
  hasFace(ref: MediaRef): Promise<boolean | undefined>;
  /** A Venice-accepted URL for an audio ref with this MIME type; `undefined` when the ref is missing. */
  audioUrl(ref: MediaRef, mimeType: string): Promise<string | undefined>;
  /** Clip length in seconds. Rejects when the clip cannot be probed. */
  audioDurationSec(ref: MediaRef): Promise<number>;
  /** Pad a dialogue clip to the model's `minAudioInputSec` (mp3). Rejects on failure. */
  padAudioForModel(model: string, ref: MediaRef): Promise<PreparedAudio>;
  /** Pad/trim a lip-sync clip to exactly `targetSec` as mono 44.1 kHz WAV; returns the new ref. Rejects on failure. */
  padLipSyncAudio(ref: MediaRef, targetSec: number): Promise<MediaRef>;
  /** Append the render's recipe pass to the clip's sidecar. Omitted: no recipe is written. */
  appendRecipe?(outputKey: MediaRef, pass: VideoRenderRecipePass): Promise<void>;
}

/** The ports one render needs. `HarnessPorts` satisfies it. */
export interface RenderVideoPorts extends VideoJobPorts {
  references: Pick<ReferenceStore, 'url'>;
}

export interface RenderVideoRunOptions extends PortCallOptions {
  /** Ignore a recorded in-flight job for this output and queue fresh. */
  forceRequeue?: boolean;
  /** Each `processing` answer, in order (the CLI prints its `Polling...` line here). */
  onProgress?: (status: VideoRetrieveStatus) => void;
  /**
   * How the job polls. Default `RENDER_FILE_VIDEO_JOB_POLICY`. `requeueOnGone`
   * is ignored: a gone re-attached job is re-rendered from the top (media
   * prepared again), once.
   */
  policy?: Partial<VideoJobPolicy>;
}

/**
 * The recipe entry for a video render (`kind: 'video-generate'`): the call
 * with stable refs, never `data:` URIs. The host's sidecar adds `pass` / `at`.
 */
export interface VideoRenderRecipePass {
  kind: 'video-generate';
  role: 'identity' | 'content';
  model: string;
  label: string;
  prompt: string;
  negativePrompt?: string;
  duration: string;
  aspectRatio?: string;
  resolution?: string;
  anchorImagePath?: string;
  endImagePath?: string;
  audioPath?: string;
  referenceImagePaths?: string[];
  extra: Record<string, unknown>;
}

export interface RenderVideoResult {
  /** The request that was queued (or would have been, for a re-attached job). */
  request: VideoQueueRequest;
  job: VideoJobResult;
  recipe: VideoRenderRecipePass;
}

const isDataUri = (ref: string): boolean => ref.startsWith('data:');
const isStableRef = (ref?: string): ref is string => !!ref && !isDataUri(ref);
const isLocalRef = (ref: string): boolean => Boolean(ref) && !isDataUri(ref) && !/^https?:\/\//i.test(ref);
const errorMessage = (err: unknown): string => (err as Error)?.message;

/**
 * Throw `FacesOffModelError` when the request would send an image of a person
 * to a faces-off (`-basic`) model. Reads `hasFace` only for local refs, once
 * each, and only on a faces-off model.
 */
export async function assertFacesOffRequest(
  media: Pick<RenderVideoMedia, 'hasFace'>,
  request: Pick<RenderVideoRequest, 'prompt' | 'anchorImage' | 'endFrameImage' | 'referenceImages' | 'sceneImages' | 'elements' | 'characters' | 'characterKinds'>,
): Promise<void> {
  const model = request.prompt.model;
  if (!isFacesOffModel(model)) return;
  const refs = [
    request.anchorImage,
    request.endFrameImage,
    ...(request.referenceImages ?? []),
    ...(request.sceneImages ?? []),
    ...(request.elements ?? []).flatMap(el => [el.frontalImageUrl, ...(el.referenceImageUrls ?? [])]),
  ].filter((ref): ref is string => Boolean(ref));
  const local = Array.from(new Set(refs.filter(isLocalRef)));
  if (local.length === 0) return;
  const images: FacesOffImage[] = [];
  for (const ref of local) images.push({ ref, hasFace: await media.hasFace(ref) });
  const violation = decideFacesOff({
    model,
    images,
    characters: request.characters,
    characterKinds: request.characterKinds,
  });
  if (violation) throw new FacesOffModelError(violation);
}

/**
 * Resolve the media the plan sends and build the `/video/queue` body, logging
 * the notes `renderVideoFile` always printed. No queue call.
 */
export async function prepareVideoRequest(
  ports: { references: Pick<ReferenceStore, 'url'>; logger: Logger },
  media: RenderVideoMedia,
  request: RenderVideoRequest,
  options: PortCallOptions = {},
): Promise<VideoQueueRequest> {
  const { prompt, anchorImage, endFrameImage, elements, referenceImages, sceneImages, dialogueAudio, voiceReferences } = request;
  const { logger } = ports;
  const model = prompt.model;
  const call = { signal: options.signal };

  await assertFacesOffRequest(media, request);

  const imageUrl = async (ref: MediaRef): Promise<string | undefined> =>
    (await media.exists(ref)) ? ports.references.url(ref, call) : undefined;
  const imageUrlOrRef = async (ref: MediaRef): Promise<string> =>
    isDataUri(ref) ? ref : ((await imageUrl(ref)) ?? ref);

  const plan = planVideoQueueRequest({
    model,
    referenceSlotCount: prompt.referenceSlots?.length,
    hasReferenceImages: Boolean(referenceImages && referenceImages.length > 0),
    hasDialogueAudio: Boolean(dialogueAudio),
    cameraTrajectory: request.cameraTrajectory,
  });

  const startImageUrl = !plan.referencesOnly && anchorImage ? await imageUrl(anchorImage) : undefined;
  const endImageUrl = endFrameImage && plan.acceptsEndImage ? await imageUrl(endFrameImage) : undefined;

  let requestAudioUrl = request.audioUrl;
  if (plan.acceptsAudioUrl && dialogueAudio) {
    try {
      const result = await media.padAudioForModel(model, dialogueAudio);
      if (result.padded) {
        logger.info(`  Padded ${dialogueAudio} -> ${result.ref} (${result.durationSec.toFixed(2)}s) for ${model}.`);
      }
      requestAudioUrl = (await media.audioUrl(result.ref, 'audio/mpeg')) ?? request.audioUrl;
    } catch (err) {
      logger.warn(`  Wan audio pre-flight failed (${errorMessage(err)}). Falling back to raw audioUrl.`);
    }
  }

  let wireElements: WireVideoElement[] | undefined;
  if (elements && elements.length > 0 && plan.acceptsElements) {
    wireElements = await Promise.all(elements.map(async el => {
      const out: WireVideoElement = {};
      if (el.frontalImageUrl) out.frontal_image_url = await imageUrlOrRef(el.frontalImageUrl);
      if (el.referenceImageUrls && el.referenceImageUrls.length > 0) {
        out.reference_image_urls = await Promise.all(el.referenceImageUrls.map(imageUrlOrRef));
      }
      if (el.videoUrl) out.video_url = el.videoUrl;
      if (plan.acceptsPerElementAudio) {
        if (el.audioPath) {
          try {
            const result = await media.padAudioForModel(model, el.audioPath);
            if (result.padded) {
              logger.info(`  [per-ref] Padded ${el.audioPath} -> ${result.ref} for ${model}.`);
            }
            const uri = await media.audioUrl(result.ref, 'audio/mpeg');
            if (uri) out.audio_url = uri;
            else if (el.audioUrl) out.audio_url = el.audioUrl;
          } catch (err) {
            logger.warn(`  [per-ref] audio pre-flight failed (${errorMessage(err)}); using raw audioUrl.`);
            if (el.audioUrl) out.audio_url = el.audioUrl;
          }
        } else if (el.audioUrl) {
          out.audio_url = el.audioUrl;
        }
      }
      return out;
    }));
  }

  // Past the model's budget the builder drops references (and says so), so
  // only the ones it keeps are read.
  const referenceImageUrls = await Promise.all((referenceImages ?? []).map((ref, i) =>
    i < plan.referenceImageBudget ? imageUrlOrRef(ref) : ref,
  ));

  const sceneImageUrls = plan.acceptsSceneImages && sceneImages
    ? await Promise.all(sceneImages.slice(0, plan.sceneImageBudget).map(imageUrlOrRef))
    : undefined;

  let lipSyncReferenceAudioUrl: string | undefined;
  if (plan.lipSyncViaReferenceAudio && dialogueAudio) {
    if (!(await media.exists(dialogueAudio))) {
      logger.warn(`  ⚠ Lip-sync audio missing on disk, rendering without it: ${dialogueAudio}`);
    } else {
      const audioSec = await media.audioDurationSec(dialogueAudio);
      const { targetSec, warnings } = planLipSyncReferenceAudio({
        model,
        audioSec,
        duration: prompt.duration,
        label: dialogueAudio,
      });
      for (const warning of warnings) logger.warn(warning);
      const sendRef = await media.padLipSyncAudio(dialogueAudio, targetSec);
      lipSyncReferenceAudioUrl = await media.audioUrl(sendRef, 'audio/wav');
      if (lipSyncReferenceAudioUrl) {
        logger.info(`  Lip-sync audio (reference_audio_urls): ${audioSec.toFixed(2)}s, sent as ${targetSec.toFixed(2)}s WAV`);
      }
    }
  }

  // Voice-donor reference audio (@Audio1, @Audio2, …). Prepared only when the
  // body will carry a reference image (Venice rejects audio-only). Each clip
  // must be 2-15s with an aggregate ≤15s across ≤3 clips; out-of-budget clips
  // are dropped with a warning so the render still proceeds.
  const voiceReferenceUrls: string[] = [];
  const bodyHasReferenceImage = (videoQueueReferenceImages(model, referenceImageUrls)?.length ?? 0) > 0;
  if (voiceReferences && voiceReferences.length > 0 && plan.acceptsReferenceAudio && bodyHasReferenceImage) {
    let aggregateSec = 0;
    for (const ref of voiceReferences) {
      if (voiceReferenceUrls.length >= MAX_VOICE_REFERENCE_CLIPS) {
        logger.warn(`  ⚠ Voice reference budget: >3 clips, dropping extras.`);
        break;
      }
      if (isDataUri(ref)) { voiceReferenceUrls.push(ref); continue; }
      if (!(await media.exists(ref))) { logger.warn(`  ⚠ Voice reference missing on disk, skipping: ${ref}`); continue; }
      let durSec: number;
      try {
        durSec = await media.audioDurationSec(ref);
      } catch (err) {
        logger.warn(`  ⚠ Could not probe voice reference (${errorMessage(err)}); skipping ${ref}`);
        continue;
      }
      const issue = voiceReferenceClipIssue(ref, durSec, aggregateSec);
      if (issue) {
        logger.warn(issue);
        continue;
      }
      const mime = ref.toLowerCase().endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';
      const uri = await media.audioUrl(ref, mime);
      if (uri) { voiceReferenceUrls.push(uri); aggregateSec += durSec; }
    }
    if (voiceReferenceUrls.length > 0) {
      logger.info(`  Reference audio (@Audio1..@Audio${voiceReferenceUrls.length}): ${voiceReferenceUrls.length} voice clip(s), ${aggregateSec.toFixed(2)}s total`);
    }
  }

  return buildVideoQueueRequest({
    model,
    prompt: prompt.prompt,
    duration: prompt.duration,
    audio: prompt.audio,
    negativePrompt: request.negativePrompt,
    aspectRatio: request.aspectRatio,
    resolution: request.resolution,
    bitrateMode: request.bitrateMode,
    referenceSlotCount: prompt.referenceSlots?.length,
    hasCharacterElements: Boolean(prompt.characterElements && prompt.characterElements.length > 0),
    startImageUrl,
    startImageLabel: anchorImage,
    endImageUrl,
    referenceImageUrls,
    sceneImageUrls,
    elements: wireElements,
    audioUrl: requestAudioUrl,
    hasDialogueAudio: Boolean(dialogueAudio),
    lipSyncReferenceAudioUrl,
    referenceAudioUrls: voiceReferenceUrls,
    voiceReferenceCount: voiceReferences?.length,
    videoUrl: request.videoUrl,
    cameraTrajectory: request.cameraTrajectory,
  }, { logger });
}

/**
 * The recipe pass for a finished render: stable refs only, `identity` when
 * the render was anchored on references or elements, else `content`.
 */
export function videoRenderRecipePass(request: RenderVideoRequest, body: VideoQueueRequest): VideoRenderRecipePass {
  const { prompt, elements, referenceImages, sceneImages, voiceReferences } = request;
  const wire = body as unknown as Record<string, unknown>;
  return {
    kind: 'video-generate',
    role: (prompt.characterElements && prompt.characterElements.length > 0)
      || (referenceImages && referenceImages.length > 0)
      || (elements && elements.length > 0)
      ? 'identity' : 'content',
    model: body.model,
    label: body.model !== prompt.model ? `video render (fallback from ${prompt.model})` : 'video render',
    prompt: prompt.prompt,
    negativePrompt: request.negativePrompt,
    duration: prompt.duration,
    aspectRatio: (wire.aspect_ratio as string | undefined) ?? request.aspectRatio,
    resolution: wire.resolution as string | undefined,
    anchorImagePath: isStableRef(request.anchorImage) ? request.anchorImage : undefined,
    endImagePath: isStableRef(request.endFrameImage) ? request.endFrameImage : undefined,
    audioPath: isStableRef(request.dialogueAudio) ? request.dialogueAudio : undefined,
    referenceImagePaths: referenceImages?.filter(isStableRef),
    extra: {
      audio: prompt.audio,
      ...(wire.bitrate_mode ? { bitrateMode: wire.bitrate_mode } : {}),
      ...(voiceReferences && voiceReferences.length > 0
        ? { voiceReferencePaths: voiceReferences.filter(isStableRef) } : {}),
      ...(sceneImages && sceneImages.length > 0
        ? { sceneImagePaths: sceneImages.filter(isStableRef) } : {}),
      ...(elements && elements.length > 0
        ? {
          elements: elements.map(el => ({
            frontalImageUrl: isStableRef(el.frontalImageUrl) ? el.frontalImageUrl : undefined,
            referenceImageUrls: el.referenceImageUrls?.filter(isStableRef),
            audioPath: isStableRef(el.audioPath) ? el.audioPath : undefined,
          })),
        } : {}),
    },
  };
}

/**
 * Render one clip: prepare the request, run the job (re-attaching to a
 * recorded one rather than paying twice, rule 43), report it, record the
 * recipe. A re-attached job Venice has reaped is rendered again from the top,
 * once, with the record cleared.
 *
 * Rejects with what `runVideoJob` rejects with (the record is kept unless the
 * job is known dead), `FacesOffModelError` before any request, or a media
 * preparation error.
 */
export async function renderVideo(
  ports: RenderVideoPorts,
  media: RenderVideoMedia,
  request: RenderVideoRequest,
  options: RenderVideoRunOptions = {},
): Promise<RenderVideoResult> {
  const body = await prepareVideoRequest(ports, media, request, options);
  ports.logger.info(
    `  Queueing video: model=${body.model}, duration=${request.prompt.duration}, `
    + `aspect=${(body as unknown as Record<string, unknown>).aspect_ratio ?? 'default'}, prompt=${request.prompt.prompt.length} chars`,
  );

  let job: VideoJobResult;
  try {
    job = await runVideoJob(
      ports,
      body,
      { outputKey: request.outputKey, project: request.project, episode: request.episode },
      { ...RENDER_FILE_VIDEO_JOB_POLICY, ...options.policy, requeueOnGone: false },
      { signal: options.signal, forceRequeue: options.forceRequeue, onProgress: options.onProgress },
    );
  } catch (err) {
    if (!(err instanceof VideoJobGoneError) || options.forceRequeue) throw err;
    ports.logger.warn(`\n  ⚠ Recorded job ${err.queueId} is gone on Venice's side; queueing a fresh generation.`);
    return renderVideo(ports, media, request, { ...options, forceRequeue: true });
  }

  ports.logger.info(
    `  Video saved: ${request.outputKey} (${(job.download.sizeBytes / 1024 / 1024).toFixed(1)} MB, ${(job.waitedMs / 1000).toFixed(0)}s)`,
  );
  const recipe = videoRenderRecipePass(request, body);
  await media.appendRecipe?.(request.outputKey, recipe);
  return { request: body, job, recipe };
}
