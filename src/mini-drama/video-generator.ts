import { writeFile, mkdir, appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { measureLipSyncFidelity, type LipSyncFidelity } from './lip-sync-fidelity.js';
import type { VeniceClient } from '../venice/client.js';
import { VeniceRequestError } from '../venice/client.js';
import type {
  GenerationPlan,
  GenerationUnit,
  GenerationUnitSegment,
  SeriesState,
  ShotScript,
  VideoElement,
} from 'venice-video-harness/core/series/types.js';
import {
  MODELS_SUPPORTING_ELEMENTS,
  MODELS_SUPPORTING_REFERENCE_IMAGES,
  MODELS_SUPPORTING_SCENE_IMAGES,
  MODELS_SUPPORTING_AUDIO_INPUT,
  MODELS_SUPPORTING_REFERENCE_AUDIO,
  MODELS_LIP_SYNC_VIA_REFERENCE_AUDIO,
  MODELS_USING_IMAGE_TAGS,
  isSeedanceVideoModel,
  DEFAULT_CHARACTER_CONSISTENCY_MODEL,
  getMaxReferenceImages,
} from 'venice-video-harness/core/series/types.js';
import { generateSpeech } from '../venice/audio.js';
import { getCharacterDir, getLocationDir, getLocation } from '../series/manager.js';
import {
  buildMontagePrompt,
  buildMultiShotPrompt,
  buildVideoPrompt,
  resolveVideoModel,
  type MiniDramaVideoPrompt,
} from './prompt-builder.js';
import { cutMontageIntoShots } from './montage.js';
import { assertShotDurationsValid } from 'venice-video-harness/core/mini-drama/duration-preflight.js';
import {
  generateVoiceReference,
  resolveVoiceReferenceAbsPath,
} from './voice-reference.js';
import { mustRenderAsExactLipSync, parseShotDuration } from './generation-planner.js';
import { dialogueFileForShot, shotKey } from './shot-paths.js';
import { dialogueLines, isVoiceOverLine, onCameraDialogueLines } from 'venice-video-harness/core/series/dialogue.js';
import type { BitrateMode } from 'venice-video-harness/core/venice/models.js';
import type { CameraKeyframe } from 'venice-video-harness/core/venice/types.js';
import {
  nextVideoQueueAttempt,
  startVideoQueueAttempts,
  type VideoQueueLogLine,
} from 'venice-video-harness/core/venice/queue-handshake.js';
import { characterKindsFor, FacesOffModelError } from '../venice/seedance-preflight.js';
import { appendRecipePass } from '../venice/recipe.js';
import { VideoGenerationFailedError } from '../venice/video.js';
import { currentSignal, isAbortError, reportProgress } from '../venice/operation-context.js';
import { renderVideo } from 'venice-video-harness/core/mini-drama/render-video.js';
import { runGenerationUnits, type GenerationUnitRenderer } from 'venice-video-harness/core/mini-drama/generation-loop.js';
import { createCliClock } from '../ports/clock.js';
import { createCliLogger } from '../ports/logger.js';
import { createCliReferenceStore } from '../ports/reference-store.js';
import { createCliRenderMedia } from '../ports/render-media.js';
import { createCliVideoBackend } from '../ports/video-backend.js';
import type { VideoRefusal } from '../venice/refusal.js';

export { nextVideoQueueAttempt, startVideoQueueAttempts } from 'venice-video-harness/core/venice/queue-handshake.js';
export type {
  VideoQueueAttemptDecision,
  VideoQueueAttemptState,
  VideoQueueFailure,
  VideoQueueLogLine,
} from 'venice-video-harness/core/venice/queue-handshake.js';

const VIDEO_QUEUE_PATH = '/api/v1/video/queue';

function runCommand(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    const detail = stderr || stdout || `exit code ${result.status}`;
    throw new Error(`${command} failed: ${detail}`);
  }
  return typeof result.stdout === 'string' ? result.stdout : '';
}

interface QueueResponse {
  model: string;
  queue_id: string;
}

/**
 * Extract a frame near the end of a clip. `secondsFromEnd` (default 0) moves
 * the target earlier — stream mode uses it to step back through the previous
 * beat when the true last frame is rejected server-side as a start frame.
 */
export function extractLastFrame(videoPath: string, outputPath: string, secondsFromEnd = 0): void {
  // Probe the VIDEO stream duration, not the container: a longer audio track
  // puts the container end past the last decodable frame, and ffmpeg exits 0
  // having written nothing (loop-mode chaining hit this on MiniMax clips).
  const durationStr = runCommand('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=duration',
    '-of',
    'csv=p=0',
    videoPath,
  ]).trim();
  let duration = parseFloat(durationStr);
  if (!Number.isFinite(duration)) {
    // Some files carry no per-stream duration; fall back to the container's.
    const formatStr = runCommand('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      videoPath,
    ]).trim();
    duration = parseFloat(formatStr);
  }
  // Step back in widening offsets until a frame actually lands on disk.
  for (const back of [0.1, 0.3, 0.6, 1.0]) {
    const seekTo = Math.max(0, duration - secondsFromEnd - back);
    runCommand('ffmpeg', [
      '-y',
      '-ss',
      String(seekTo),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      outputPath,
    ]);
    if (existsSync(outputPath)) return;
  }
  throw new Error(`ffmpeg could not extract a frame from ${videoPath}`);
}

function extractFirstFrame(videoPath: string, outputPath: string): void {
  runCommand('ffmpeg', [
    '-y',
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    outputPath,
  ]);
}

function resolveDialogueShotId(shot: ShotScript): string | number {
  return shot.shotIdSuffix ? `${shot.shotNumber}${shot.shotIdSuffix}` : shot.shotNumber;
}

/**
 * Resolves the path to the dialogue MP3 for a shot, generating it inline
 * via Venice TTS if the shot has a locked voice and the file does not yet
 * exist. Returns undefined when the shot has no usable voice and no
 * pre-existing audio — the caller should fall back to letting the video model
 * synthesize audio from the prompt's dialogue block.
 */
async function ensureDialogueAudio(
  client: VeniceClient,
  series: SeriesState,
  shot: ShotScript,
  audioDir: string,
): Promise<string | undefined> {
  // One MP3 per shot drives the lip-sync, so it carries the first on-camera
  // speaker's line(s): a single-object dialogue is exactly that one line; a
  // list contributes every on-camera line by that same speaker, in order.
  const spoken = onCameraDialogueLines(shot);
  const lead = spoken[0];
  if (!lead) return undefined;
  const shotId = resolveDialogueShotId(shot);
  const target = dialogueFileForShot(audioDir, shotId);
  if (existsSync(target)) return target;

  const character = series.characters.find(
    c => c.name.toUpperCase() === lead.character.toUpperCase(),
  );
  if (!character?.voiceId) {
    console.warn(
      `  No locked voice for ${lead.character}; skipping inline TTS — the video model will synthesize from the prompt.`,
    );
    return undefined;
  }
  const text = spoken
    .filter(line => line.character.toUpperCase() === lead.character.toUpperCase())
    .map(line => line.line)
    .join(' ');

  await mkdir(audioDir, { recursive: true });
  console.log(
    `  Inline TTS: shot ${shotKey(shotId)} [${character.name}, voice=${character.voiceName ?? character.voiceId}]`,
  );
  try {
    await generateSpeech(
      client,
      {
        voiceId: character.voiceId,
        text,
        prompt: character.voiceDescription,
      },
      target,
    );
    return target;
  } catch (err) {
    console.warn(`  Inline TTS failed (${(err as Error).message}); falling back to model-synthesized audio.`);
    return undefined;
  }
}

interface SeedanceKeyframeArtifacts {
  keyframePngPath: string;
  stageAVideoPath: string;
  dialogueAudioPath?: string;
  referenceImagePaths: string[];
}

/**
 * Stage A + Stage B of AGENTS.md rule 32: render a Seedance R2V identity-
 * lock pass (no audio, all character refs) and extract frame 1 as a PNG.
 * Returns paths for both the intermediate video and the keyframe so the
 * caller can wire them into the Wan 2.7 i2v stage and the saved metadata.
 *
 * Throws on any failure; the caller is responsible for falling back to
 * the panel-anchored single-pass render.
 */
async function renderSeedanceKeyframe(
  client: VeniceClient,
  series: SeriesState,
  shot: ShotScript,
  sceneDir: string,
  outputVideoPath: string,
  previousShot: ShotScript | undefined,
): Promise<SeedanceKeyframeArtifacts> {
  const stageAVideoPath = outputVideoPath.replace(/\.mp4$/, '-r2v-keyframe.mp4');
  const keyframePngPath = outputVideoPath.replace(/\.mp4$/, '-r2v-keyframe.png');

  if (existsSync(keyframePngPath) && existsSync(stageAVideoPath)) {
    console.log(`  Stage A: reusing existing keyframe ${keyframePngPath}`);
    const refs = collectReferenceImagePathsForShot(series, shot);
    return {
      keyframePngPath,
      stageAVideoPath,
      referenceImagePaths: refs,
    };
  }

  // Re-route the shot to Seedance R2V by cloning it with no dialogue and
  // forcing motion to 'high' (the planner skips Wan 2.7 routing on both
  // signals). This re-uses the entire prompt-builder pipeline including
  // the Seedance compatibility pre-flight and image-tag handling.
  const stageAShot: ShotScript = {
    ...shot,
    dialogue: null,
    motion: 'high',
    useReferenceImages: true,
  };
  const stageAPrompt = buildVideoPrompt(stageAShot, series, previousShot);
  // Wan 2.7's audio + R2V's audio metadata don't mix — force off explicitly.
  stageAPrompt.audio = false;

  if (!isSeedanceVideoModel(stageAPrompt.model)) {
    // Defensive: if the series's character consistency model isn't a Seedance
    // family member, we still skip lip-sync at this stage but warn the user
    // since the keyframe may inherit drift from the chosen model.
    console.warn(
      `  Stage A: characterConsistencyModel=${stageAPrompt.model} is not Seedance — keyframe will inherit that model's identity behavior.`,
    );
  }

  const panelPath = getShotPanelPath(sceneDir, resolveDialogueShotId(shot));
  const { elements, referenceImagePaths } = resolveCharacterElements(series, stageAShot, stageAPrompt);

  console.log(`  Stage A/3: ${stageAPrompt.model} keyframe render (identity lock, no audio)`);
  await renderVideoFile(client, {
    prompt: stageAPrompt,
    anchorImagePath: panelPath,
    outputPath: stageAVideoPath,
    elements,
    referenceImagePaths,
    aspectRatio: series.storyboardAspectRatio ?? '16:9',
    seedanceCompatibility: series.videoDefaults.seedanceCompatibility,
    characters: stageAShot.characters,
    characterKinds: characterKindsFor(series, stageAShot.characters),
    project: series.outputDir,
  });

  console.log(`  Stage B/3: extracting first frame -> ${keyframePngPath}`);
  extractFirstFrame(stageAVideoPath, keyframePngPath);
  if (!existsSync(keyframePngPath)) {
    throw new Error(`Stage B keyframe extraction produced no file at ${keyframePngPath}`);
  }
  await appendRecipePass(keyframePngPath, {
    kind: 'mechanical',
    role: 'mechanical',
    model: 'ffmpeg',
    label: 'keyframe extraction (frame 1 of Seedance R2V identity-lock pass)',
    anchorImagePath: stageAVideoPath,
  });

  return {
    keyframePngPath,
    stageAVideoPath,
    referenceImagePaths: referenceImagePaths ?? [],
  };
}

function collectReferenceImagePathsForShot(
  series: SeriesState,
  shot: ShotScript,
  modelId: string = DEFAULT_CHARACTER_CONSISTENCY_MODEL,
): string[] {
  const budget = getMaxReferenceImages(modelId);
  const resolved = shot.characters
    .map(name => series.characters.find(c => c.name.toUpperCase() === name.toUpperCase()))
    .filter(Boolean) as typeof series.characters;
  if (resolved.length === 0) return [];
  return resolved
    .slice(0, budget)
    .flatMap(c => {
      const dir = getCharacterDir(series, c.name);
      return ['front.png', 'three-quarter.png']
        .map(f => join(dir, f))
        .filter(p => existsSync(p));
    })
    .slice(0, budget);
}

/**
 * Resolve the best location reference image for a shot. Closer shot types
 * (close-up / reaction / insert) prefer the medium ref; everything else
 * prefers the wide establishing ref. Falls back through the other angles.
 * Returns undefined when the shot has no location or no ref images exist.
 */
function getLocationRefPath(series: SeriesState, shot: ShotScript): string | undefined {
  if (!shot.location) return undefined;
  const loc = getLocation(series, shot.location);
  if (!loc) return undefined;
  const dir = getLocationDir(series, loc.slug);
  // North (hero plate) first, then the derived same-room plates, then legacy
  // names for pre-2026-10-05 projects.
  const order = ['north.png', 'south.png', 'east.png', 'west.png', 'wide.png', 'angle-2.png', 'angle-3.png', 'angle-4.png', 'medium.png', 'detail.png'];
  for (const f of order) {
    const p = join(dir, f);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Fold a location reference into the character reference_image_urls for a
 * Seedance / HappyHorse R2V shot. Characters come first (one ref per
 * character to keep the @ImageN mapping aligned with the prompt's
 * characterElements), then the location takes the last free slot within the
 * per-model budget (9 on Seedance R2V / HappyHorse 1.1 R2V).
 *
 * LEGACY fallback: shots whose prompt carries a full `referenceSlots` plan
 * (the normal path on @Image-tag models) never reach this — the slot plan
 * already interleaves characters, storyboard plates, and location angles.
 */
function foldLocationIntoReferences(
  series: SeriesState,
  shot: ShotScript,
  prompt: MiniDramaVideoPrompt,
  locationRefPath: string,
  existingCharRefs: string[] | undefined,
): string[] {
  const budget = getMaxReferenceImages(prompt.model);
  // One image per character, ordered to match the prompt's @Image1..@ImageN.
  const slotNames = (prompt.characterElements && prompt.characterElements.length > 0)
    ? prompt.characterElements.map(s => s.characterName)
    : shot.characters;
  const charRefs = slotNames
    .map(name => {
      const dir = getCharacterDir(series, name);
      return ['front.png', 'three-quarter.png']
        .map(f => join(dir, f))
        .find(p => existsSync(p));
    })
    .filter((p): p is string => Boolean(p));

  if (charRefs.length >= budget) {
    console.warn(`  ⚠ Location ref for "${shot.location}" dropped: character refs already fill the ${budget}-image budget.`);
    return existingCharRefs ?? charRefs.slice(0, budget);
  }
  console.log(`  Location ref -> reference_image_urls slot @Image${charRefs.length + 1} (${shot.location})`);
  return [...charRefs, locationRefPath].slice(0, budget);
}

async function persistCharacterJson(series: SeriesState, character: SeriesState['characters'][number]): Promise<void> {
  const dir = getCharacterDir(series, character.name);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'character.json'), JSON.stringify(character, null, 2), 'utf-8');
}

/**
 * Ensure the dialogue speaker for a shot has a voice-donor reference clip when
 * the shot routes to a reference-audio-capable model and voice references
 * aren't disabled. Auto-generates one via seed-audio-1-0 (mirrors the inline
 * TTS pattern in ensureDialogueAudio) and persists it to character.json so the
 * prompt builder picks it up. Best-effort — a failure just skips the ref.
 */
export async function ensureVoiceReferenceForShot(
  client: VeniceClient,
  series: SeriesState,
  shot: ShotScript,
  previousShot: ShotScript | undefined,
): Promise<void> {
  if (series.videoDefaults.voiceReferenceForDialogue === false) return;
  const speakers = Array.from(new Set(onCameraDialogueLines(shot).map(line => line.character.toUpperCase())));
  if (speakers.length === 0) return;

  const resolution = resolveVideoModel(shot, series, previousShot);
  if (!MODELS_SUPPORTING_REFERENCE_AUDIO.has(resolution.modelId)) return;

  // One clip per distinct on-camera speaker (a single-object dialogue has one).
  for (const speaker of speakers) {
    const character = series.characters.find(c => c.name.toUpperCase() === speaker);
    if (!character) continue;

    const abs = resolveVoiceReferenceAbsPath(series, character);
    if (character.voiceReferencePath && abs && existsSync(abs)) continue; // already present

    try {
      const { relPath, model } = await generateVoiceReference(client, series, character);
      character.voiceReferencePath = relPath;
      character.voiceReferenceModel = model;
      await persistCharacterJson(series, character);
    } catch (err) {
      console.warn(`  ⚠ Voice reference generation failed for ${character.name} (${(err as Error).message}); shot will fall back to the [Char, voiceDesc] text.`);
    }
  }
}

function resolveVoiceReferencePaths(
  series: SeriesState,
  prompt: MiniDramaVideoPrompt,
): string[] {
  if (!prompt.voiceReferenceSlots || prompt.voiceReferenceSlots.length === 0) return [];
  return [...prompt.voiceReferenceSlots]
    .sort((a, b) => a.audioIndex - b.audioIndex)
    .map(slot => {
      const char = series.characters.find(
        c => c.name.toUpperCase() === slot.characterName.toUpperCase(),
      );
      const abs = char ? resolveVoiceReferenceAbsPath(series, char) : undefined;
      return abs && existsSync(abs) ? abs : undefined;
    })
    .filter((p): p is string => Boolean(p));
}

function getVideoDuration(path: string): number {
  const out = runCommand('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    path,
  ]).trim();
  return parseFloat(out);
}

function archiveExisting(outputPath: string): void {
  if (!existsSync(outputPath)) return;

  let version = 1;
  let archivePath = outputPath.replace(/\.mp4$/, `-v${version}.mp4`);
  while (existsSync(archivePath)) {
    version += 1;
    archivePath = outputPath.replace(/\.mp4$/, `-v${version}.mp4`);
  }

  renameSync(outputPath, archivePath);
  console.log(`  Archived previous: ${archivePath}`);
}

function saveJson(path: string, data: unknown): Promise<void> {
  return writeFile(path, JSON.stringify(data, null, 2), 'utf-8');
}

async function logFailedRequest(
  outputPath: string,
  body: Record<string, unknown>,
  error: unknown,
): Promise<void> {
  const logDir = dirname(outputPath);
  const logFile = join(logDir, 'failed-requests.log');
  const timestamp = new Date().toISOString();

  const sanitizedBody = { ...body };
  if (sanitizedBody.image_url && typeof sanitizedBody.image_url === 'string' && sanitizedBody.image_url.length > 200) {
    sanitizedBody.image_url = `${(sanitizedBody.image_url as string).slice(0, 80)}...[${(sanitizedBody.image_url as string).length} chars]`;
  }
  if (sanitizedBody.end_image_url && typeof sanitizedBody.end_image_url === 'string' && sanitizedBody.end_image_url.length > 200) {
    sanitizedBody.end_image_url = `${(sanitizedBody.end_image_url as string).slice(0, 80)}...[${(sanitizedBody.end_image_url as string).length} chars]`;
  }

  let errorDetail: Record<string, unknown>;
  if (error instanceof VeniceRequestError) {
    errorDetail = { status: error.status, message: error.message, body: error.body };
  } else if (error instanceof Error) {
    errorDetail = { message: error.message };
  } else {
    errorDetail = { raw: String(error) };
  }

  const entry = {
    timestamp,
    targetOutput: outputPath,
    promptLength: (body.prompt as string)?.length,
    request: sanitizedBody,
    error: errorDetail,
  };

  await appendFile(logFile, JSON.stringify(entry, null, 2) + '\n---\n', 'utf-8');
  console.warn(`  Failed request logged to: ${logFile}`);
}

export interface RenderVideoOptions {
  prompt: MiniDramaVideoPrompt;
  /** Start-frame image. Omitted in pure reference mode (slot-plan renders). */
  anchorImagePath?: string;
  outputPath: string;
  endFrameImagePath?: string;
  elements?: VideoElement[];
  referenceImagePaths?: string[];
  sceneImagePaths?: string[];
  negativePrompt?: string;
  /**
   * Pre-encoded data URL for `audio_url`. Used by callers that already
   * encoded the audio themselves. Prefer `audioPath` for new callsites —
   * it runs the Wan 2.7 audio pre-flight pad.
   */
  audioUrl?: string;
  /**
   * Path to a dialogue audio file for `audio_url`.
   * When supplied, the audio is probed against the model's
   * `minAudioInputSec` and padded with trailing silence if needed.
   * The resolved path is then encoded as a data URL into `audio_url`.
   */
  audioPath?: string;
  videoUrl?: string;
  aspectRatio?: string;
  /**
   * Output encoding bitrate mode. Only attached for models that accept it
   * (Seedance 2.x); Seedance 2.5 defaults to `'high'` for a large fidelity
   * gain at no extra cost. Pass `'standard'` to opt back into smaller files.
   */
  bitrateMode?: BitrateMode;
  /** Seedance compatibility strategy when images aren't seedream-originated. */
  seedanceCompatibility?: 'prompt' | 'fallback' | 'launder';
  /**
   * Characters the shot (or unit) places on screen. Feeds the faces-off
   * preflight: a shot with people must not go to a `-basic` Seedance id.
   */
  characters?: string[];
  /**
   * `Character.kind` per name in `characters` (see `characterKindsFor`). An
   * object-only shot has no face, so it may stay on a faces-off id.
   */
  characterKinds?: Record<string, 'person' | 'object'>;
  /**
   * Voice-donor reference clips (on-disk paths), ordered to match the prompt's
   * @Audio1, @Audio2, … bindings. Sent as `reference_audio_urls` only when the
   * effective model supports reference audio AND at least one reference image
   * is present (Venice rejects audio-only reference audio).
   */
  voiceReferencePaths?: string[];
  /** Project directory, recorded on the pending job for `venice-video queue`. */
  project?: string;
  episode?: number;
  /**
   * Ignore any recorded in-flight queue id for this output and generate fresh.
   * Set automatically when a resumed job turns out to be gone on Venice's side.
   */
  forceRequeue?: boolean;
  /**
   * Explicit output resolution override. Honored ONLY when the effective model
   * actually lists it (so a bad value can't 400), otherwise the model-family
   * default below applies. The loop-preview engine passes `480P` here to render
   * MiniMax H3 Max Turbo drafts on the cheap tier, which the auto-pin never
   * selects (it forces `768P` for every `minimax-h3-max*` id).
   */
  resolution?: string;
  /**
   * Camera-orbit keyframes for MiniMax H3 Max Multi-Angle. Attached as
   * `camera_trajectory` only when the effective model supports it; validated
   * before the request goes out. Build with `buildOrbitTrajectory` /
   * `buildStartEndTrajectory` from `../venice/models.js`.
   */
  cameraTrajectory?: CameraKeyframe[];
}

/**
 * Thrown when `/video/queue` refused the request and no retry is warranted.
 * `refusal.kind` tells a face-screening refusal (an image problem: nothing
 * queued or charged, the same images fail every time) from a provider
 * content-policy refusal (carries `credits_refunded` / `recommended_model`).
 */
export class VideoRefusalError extends VeniceRequestError {
  public readonly refusal: VideoRefusal;

  constructor(refusal: VideoRefusal, status: number, body: unknown) {
    super(refusal.message, status, body);
    this.name = 'VideoRefusalError';
    this.refusal = refusal;
  }
}

function printQueueLog(lines: VideoQueueLogLine[]): void {
  for (const { level, message } of lines) {
    if (level === 'info') console.log(message);
    else if (level === 'warn') console.warn(message);
    else console.error(message);
  }
}

/**
 * POST the queue body once, with the two Venice handshakes layered on top:
 *
 *  - 409 `needs_consent` (Seedance face media): non-charging; resubmit the
 *    identical body with `consents.seedance` attesting the policy text.
 *    https://docs.venice.ai/guides/media/seedance-face-consent
 *  - Refusals (`src/venice/refusal.ts`): a refunded `provider_content_policy`
 *    is retried exactly once; a second refusal, an unrefunded one, or a
 *    face-screening 422 throws `VideoRefusalError` with a message that says
 *    what actually went wrong (and names `recommended_model` when given).
 *
 * The queue call itself is never auto-retried for 5xx (see `PostOptions.retry`).
 */
export async function submitVideoQueue(
  client: VeniceClient,
  model: string,
  body: Record<string, unknown>,
  outputPath: string,
): Promise<QueueResponse> {
  let state = startVideoQueueAttempts(model, body);

  while (true) {
    try {
      // retry:false — a 5xx can arrive after Venice already queued and billed
      // the job; a blind retry would pay for the shot twice (see PostOptions).
      return await client.post<QueueResponse>(VIDEO_QUEUE_PATH, state.body, { retry: false });
    } catch (err) {
      if (!(err instanceof VeniceRequestError)) {
        await logFailedRequest(outputPath, state.body, err);
        throw err;
      }

      const decision = nextVideoQueueAttempt(state, { status: err.status, message: err.message, body: err.body });
      printQueueLog(decision.log);
      if (decision.kind === 'resubmit') {
        state = decision.state;
        continue;
      }
      await logFailedRequest(outputPath, state.body, err);
      if (decision.kind === 'refused') throw new VideoRefusalError(decision.refusal, err.status, err.body);
      throw err;
    }
  }
}

/**
 * Render one clip to `outputPath`: core's `renderVideo` over the CLI ports
 * (fs references, the pending-job registry, Venice) and the CLI render media
 * (ffmpeg, provenance and recipe sidecars). Re-attaches to a recorded job for
 * the same output instead of paying for it again (rule 43).
 */
export async function renderVideoFile(
  client: VeniceClient,
  options: RenderVideoOptions,
): Promise<string> {
  await mkdir(dirname(options.outputPath), { recursive: true });

  // Core's own poll progress is replaced by the CLI's `Polling...` line
  // (onProgress), which reports Venice's execution time rather than ours.
  const { progress: _progress, ...logger } = createCliLogger();
  const ports = {
    references: createCliReferenceStore(),
    video: createCliVideoBackend(() => client, logger, { validateRequests: false }),
    clock: createCliClock(),
    logger,
  };

  try {
    await renderVideo(ports, createCliRenderMedia(), {
      prompt: options.prompt,
      outputKey: options.outputPath,
      anchorImage: options.anchorImagePath,
      endFrameImage: options.endFrameImagePath,
      elements: options.elements,
      referenceImages: options.referenceImagePaths,
      sceneImages: options.sceneImagePaths,
      negativePrompt: options.negativePrompt,
      audioUrl: options.audioUrl,
      dialogueAudio: options.audioPath,
      videoUrl: options.videoUrl,
      aspectRatio: options.aspectRatio,
      bitrateMode: options.bitrateMode,
      characters: options.characters,
      characterKinds: options.characterKinds,
      voiceReferences: options.voiceReferencePaths,
      project: options.project,
      episode: options.episode,
      resolution: options.resolution,
      cameraTrajectory: options.cameraTrajectory,
    }, {
      signal: currentSignal(),
      forceRequeue: options.forceRequeue,
      onProgress: status => {
        const pct = status.execution_duration
          ? `${(status.execution_duration / 1000).toFixed(0)}s elapsed`
          : '';
        reportProgress({ phase: 'poll', detail: `${status.status} ${pct}`.trim() });
        process.stdout.write(`\r  Polling... ${status.status} ${pct}   `);
      },
    });
  } catch (err) {
    // End the `\r  Polling...` line before the failure is reported.
    if (err instanceof VideoGenerationFailedError) process.stdout.write('\n');
    throw err;
  }
  return options.outputPath;
}

function resolveCharacterElements(
  series: SeriesState,
  shot: ShotScript,
  prompt: MiniDramaVideoPrompt,
): { elements?: VideoElement[]; referenceImagePaths?: string[] } {
  // @Image-tag models with a slot plan: the plan IS the reference array.
  // Push in exactly the slot order so the prompt's @ImageN bindings match
  // (characters, storyboard blocking plate, location angles, extra angles).
  if (prompt.referenceSlots && prompt.referenceSlots.length > 0
    && MODELS_SUPPORTING_REFERENCE_IMAGES.has(prompt.model)) {
    const paths = prompt.referenceSlots
      .map(slot => slot.ref)
      .filter(p => existsSync(p));
    if (paths.length !== prompt.referenceSlots.length) {
      console.warn('  ⚠ Reference slot images missing on disk — @ImageN bindings may misalign; regenerate refs.');
    }
    return { referenceImagePaths: paths.length > 0 ? paths : undefined };
  }

  if (!shot.characters || shot.characters.length === 0) return {};

  const resolvedChars = shot.characters
    .map(name => series.characters.find(c => c.name.toUpperCase() === name.toUpperCase()))
    .filter(Boolean) as typeof series.characters;

  if (resolvedChars.length === 0) return {};

  const charDirFn = (name: string) => getCharacterDir(series, name);

  const autoElements = prompt.modelResolution?.autoUseElements ?? false;
  const autoRefs = prompt.modelResolution?.autoUseReferenceImages ?? false;

  if ((prompt.characterElements && prompt.characterElements.length > 0 || autoElements)
    && MODELS_SUPPORTING_ELEMENTS.has(prompt.model)) {
    const slots = prompt.characterElements && prompt.characterElements.length > 0
      ? prompt.characterElements
      : resolvedChars.slice(0, 2).map((char, index) => ({
        characterName: char.name,
        elementIndex: index + 1,
      }));

    const elements: VideoElement[] = slots.map(slot => {
      const dir = charDirFn(slot.characterName);
      const frontal = join(dir, 'front.png');
      const refs = ['three-quarter.png', 'profile.png', 'back.png']
        .map(f => join(dir, f))
        .filter(p => existsSync(p))
        .slice(0, 3);

      return {
        frontalImageUrl: existsSync(frontal) ? frontal : undefined,
        referenceImageUrls: refs.length > 0 ? refs : undefined,
      };
    });
    return { elements };
  }

  if ((shot.useReferenceImages || autoRefs)
    && MODELS_SUPPORTING_REFERENCE_IMAGES.has(prompt.model)) {
    const budget = getMaxReferenceImages(prompt.model);
    // anchor.png (harvest-anchor, or an operator-locked frame) leads, as it
    // does in the slot planner (rule 53).
    const paths = resolvedChars
      .slice(0, budget)
      .flatMap(c => {
        const dir = charDirFn(c.name);
        return ['anchor.png', 'front.png', 'three-quarter.png']
          .map(f => join(dir, f))
          .filter(p => existsSync(p));
      })
      .slice(0, budget);
    return { referenceImagePaths: paths.length > 0 ? paths : undefined };
  }

  return {};
}

export interface ShotReferenceInputs {
  elements?: VideoElement[];
  referenceImagePaths?: string[];
  sceneImagePaths?: string[];
  voiceReferencePaths: string[];
  /** True when an @Image slot plan resolved to ≥1 on-disk reference. */
  hasSlotPlan: boolean;
}

/**
 * Resolve every reference-bearing input for a shot's render — character
 * elements / `reference_image_urls`, scene images, the location environment
 * fold, and voice-donor clips — from the already-built video prompt. Extracted
 * from `renderSingleShotUnit` so other callers (the loop-preview engine's
 * create mode) resolve the SAME reference stack the real pipeline does, instead
 * of a divergent copy. Pure w.r.t. Venice (reads disk only); voice-donor
 * GENERATION stays in `ensureVoiceReferenceForShot`, called before this.
 */
export function resolveShotReferenceInputs(
  series: SeriesState,
  shot: ShotScript,
  videoPrompt: MiniDramaVideoPrompt,
): ShotReferenceInputs {
  const resolved = resolveCharacterElements(series, shot, videoPrompt);
  const elements = resolved.elements;
  let referenceImagePaths = resolved.referenceImagePaths;
  let sceneImagePaths = shot.sceneImagePaths?.filter(p => existsSync(p));
  const hasSlotPlan = (videoPrompt.referenceSlots?.length ?? 0) > 0
    && (referenceImagePaths?.length ?? 0) > 0;

  // Location environment references. The slot plan already interleaves location
  // angles for @Image-tag models; this legacy fold only runs when no plan
  // exists. Kling O3 R2V takes environment refs via scene_image_urls; hand-set
  // sceneImagePaths always win.
  const locationRefPath = getLocationRefPath(series, shot);
  if (locationRefPath) {
    if (MODELS_SUPPORTING_SCENE_IMAGES.has(videoPrompt.model)) {
      if (!sceneImagePaths || sceneImagePaths.length === 0) {
        sceneImagePaths = [locationRefPath];
        console.log(`  Location ref -> scene_image_urls (${shot.location})`);
      }
    } else if (!hasSlotPlan && videoPrompt.locationEnvSlot) {
      referenceImagePaths = foldLocationIntoReferences(
        series, shot, videoPrompt, locationRefPath, referenceImagePaths,
      );
    }
  }

  // Voice-donor clips in the exact order the prompt's @AudioN slots expect.
  const voiceReferencePaths = resolveVoiceReferencePaths(series, videoPrompt);

  return { elements, referenceImagePaths, sceneImagePaths, voiceReferencePaths, hasSlotPlan };
}

function getShotPanelPath(sceneDir: string, shotId: number | string): string {
  return join(sceneDir, `shot-${shotKey(shotId)}.png`);
}

function getShotVideoPath(sceneDir: string, shotId: number | string): string {
  return join(sceneDir, `shot-${shotKey(shotId)}.mp4`);
}

function chooseAnchorImagePath(
  unit: GenerationUnit,
  sceneDir: string,
  unitOutputPath: string,
  previousRenderedShotPath?: string,
  explicitPanelPath?: string,
): string {
  const firstShotNumber = unit.shotNumbers[0];
  const panelPath = explicitPanelPath ?? getShotPanelPath(sceneDir, firstShotNumber);

  if (unit.startFrameStrategy === 'previous-last-frame'
    && previousRenderedShotPath
    && existsSync(previousRenderedShotPath)) {
    const lastFramePath = unitOutputPath.replace(/\.mp4$/, '-lastframe.png');
    extractLastFrame(previousRenderedShotPath, lastFramePath);
    console.log('  Start frame: chained from previous rendered shot');
    return lastFramePath;
  }

  console.log('  Start frame: panel image');
  return panelPath;
}

function chooseEndFrameImagePath(
  unit: GenerationUnit,
  sceneDir: string,
  nextShotNumber?: number,
): string | undefined {
  if (unit.endFrameStrategy !== 'next-panel-target' || nextShotNumber === undefined) {
    console.log('  End frame: natural');
    return undefined;
  }

  const nextPanelPath = getShotPanelPath(sceneDir, nextShotNumber);
  if (!existsSync(nextPanelPath)) {
    console.log('  End frame: natural (next panel missing)');
    return undefined;
  }

  console.log(`  End frame: targeting shot-${String(nextShotNumber).padStart(3, '0')}`);
  return nextPanelPath;
}

async function saveSingleShotMetadata(
  series: SeriesState,
  shot: ShotScript,
  videoPath: string,
  videoPrompt: MiniDramaVideoPrompt,
  extraMetadata: Record<string, unknown> = {},
): Promise<void> {
  const videoJsonPath = videoPath.replace(/\.mp4$/, '.video.json');
  await saveJson(videoJsonPath, {
    panelId: `E${series.episodes.length}-S${shot.shotNumber}`,
    shotNumber: shot.shotNumber,
    video: {
      model: videoPrompt.model,
      prompt: videoPrompt.prompt,
      duration: videoPrompt.duration,
      audio: videoPrompt.audio,
    },
    metadata: {
      characters: shot.characters,
      dialogue: shot.dialogue,
      sfx: shot.sfx,
      transition: shot.transition,
      cameraMovement: shot.cameraMovement,
      ...extraMetadata,
    },
  });
}

function splitRenderedUnitIntoShots(
  unitOutputPath: string,
  unit: GenerationUnit,
  shotsByNumber: Map<number, ShotScript>,
  sceneDir: string,
): GenerationUnitSegment[] {
  const renderedDuration = getVideoDuration(unitOutputPath);
  const plannedTotal = unit.shotNumbers.reduce((sum, shotNumber) => {
    const shot = shotsByNumber.get(shotNumber);
    return sum + (shot ? parseShotDuration(shot.duration) : 0);
  }, 0);

  let offset = 0;
  const segments: GenerationUnitSegment[] = [];

  for (let index = 0; index < unit.shotNumbers.length; index++) {
    const shotNumber = unit.shotNumbers[index];
    const shot = shotsByNumber.get(shotNumber);
    if (!shot) continue;

    const outputPath = getShotVideoPath(sceneDir, shotNumber);
    const isLast = index === unit.shotNumbers.length - 1;
    const durationSec = isLast
      ? Math.max(0.1, renderedDuration - offset)
      : Math.max(0.1, renderedDuration * (parseShotDuration(shot.duration) / plannedTotal));

    archiveExisting(outputPath);
    runCommand('ffmpeg', [
      '-y',
      '-ss',
      String(offset),
      '-i',
      unitOutputPath,
      '-t',
      String(durationSec),
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '18',
      '-c:a',
      'aac',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-b:a',
      '192k',
      outputPath,
    ]);

    segments.push({
      shotNumber,
      startOffsetSec: Number(offset.toFixed(3)),
      durationSec: Number(durationSec.toFixed(3)),
      outputFile: `shot-${String(shotNumber).padStart(3, '0')}.mp4`,
    });

    offset += durationSec;
  }

  return segments;
}

async function renderSingleShotUnit(
  client: VeniceClient,
  series: SeriesState,
  shot: ShotScript,
  unit: GenerationUnit,
  sceneDir: string,
  previousRenderedShotPath: string | undefined,
  nextShotNumber: number | undefined,
  previousShot?: ShotScript,
  episodeAudioMix?: import('venice-video-harness/core/series/types.js').AudioMixDefaults,
): Promise<string[]> {
  // Suffixed inserts ("3b") must key their own panel/video files — using the
  // bare shotNumber here made every suffixed shot collide with its base shot
  // (path resolved to shot-003.*), so inserts were silently skipped as
  // "video exists".
  const shotId = resolveDialogueShotId(shot);
  const panelPath = getShotPanelPath(sceneDir, shotId);
  // A missing panel is only fatal for shots that will actually anchor on it.
  // Refs-only shots (Seedance R2V slot plan) don't send a start image, so the
  // decision to skip is deferred until after the prompt/references resolve.
  const panelExists = existsSync(panelPath);

  const videoPath = getShotVideoPath(sceneDir, shotId);
  if (existsSync(videoPath)) {
    console.log(`  Shot ${shotKey(shotId)}: video exists, skipping`);
    unit.renderedDurationSec = getVideoDuration(videoPath);
    unit.segments = [{
      shotNumber: shot.shotNumber,
      startOffsetSec: 0,
      durationSec: unit.renderedDurationSec,
      outputFile: `shot-${shotKey(shotId)}.mp4`,
    }];
    return [videoPath];
  }

  // Ensure the dialogue speaker has a voice-donor reference clip before the
  // prompt is built, so buildVideoPrompt can emit the @AudioN binding (A2/A3).
  await ensureVoiceReferenceForShot(client, series, shot, previousShot);

  const videoPrompt = buildVideoPrompt(shot, series, previousShot, episodeAudioMix);
  if (!videoPrompt.audio && dialogueLines(shot).length > 0) {
    const reason = shot.nativeAudio === 'mute'
      ? 'shot.nativeAudio=mute'
      : episodeAudioMix?.suppressModelNarration
        ? 'episode.audioMix.suppressModelNarration'
        : dialogueLines(shot).every(isVoiceOverLine)
          ? 'NARRATOR shot (auto)'
          : 'unknown';
    console.log(`  Audio: model-native disabled (${reason})`);
  }
  unit.model = videoPrompt.model;

  if (videoPrompt.modelResolution) {
    const res = videoPrompt.modelResolution;
    console.log(`  Model: ${res.modelId}${res.upgraded ? ` (upgraded: ${res.reason})` : ''}`);
    if (res.autoUseElements) console.log('  Auto-enabled: elements (character identity anchoring)');
    if (res.autoUseReferenceImages) console.log('  Auto-enabled: reference images');
  }

  const { elements, referenceImagePaths, sceneImagePaths, voiceReferencePaths, hasSlotPlan } =
    resolveShotReferenceInputs(series, shot, videoPrompt);

  // Refs-only shots (Seedance R2V slot plan) don't anchor on the panel, so a
  // missing panel is fine there. Everything else still requires it.
  if (!panelExists && !hasSlotPlan) {
    console.warn(`  Panel not found: ${panelPath}, skipping shot ${shotId}`);
    return [];
  }

  let anchorImagePath = chooseAnchorImagePath(unit, sceneDir, videoPath, previousRenderedShotPath, panelPath);
  const endFramePath = chooseEndFrameImagePath(unit, sceneDir, nextShotNumber);

  // --- AGENTS.md rule 32: Seedance R2V keyframe pipeline ---
  // Only for lip-sync models with no `reference_image_urls` lane (Wan 2.7
  // i2v), whose sole identity anchor is the single `image_url` keyframe. We
  // render a Seedance R2V identity-lock pass first, extract frame 1, and use
  // that frame as the keyframe. The planner skips this entirely when the
  // lip-sync model is itself an R2V lane.
  let keyframeArtifacts: SeedanceKeyframeArtifacts | undefined;
  let dialogueAudioPath: string | undefined;
  let stageAFailed = false;
  let stageAFailureReason: string | undefined;
  if (unit.useSeedanceKeyframe === true) {
    try {
      keyframeArtifacts = await renderSeedanceKeyframe(
        client,
        series,
        shot,
        sceneDir,
        videoPath,
        previousShot,
      );
      anchorImagePath = keyframeArtifacts.keyframePngPath;
    } catch (err) {
      stageAFailed = true;
      stageAFailureReason = err instanceof Error ? err.message : String(err);
      console.warn(
        `  ⚠ Seedance R2V keyframe pipeline failed (${stageAFailureReason}); falling back to panel-anchored single-pass render.`,
      );
      keyframeArtifacts = undefined;
      anchorImagePath = chooseAnchorImagePath(unit, sceneDir, videoPath, previousRenderedShotPath, panelPath);
    }
  }

  // Exact lip-sync: wire the dialogue MP3 into the model so it follows the
  // real recording instead of synthesizing a voice. This is the step that
  // actually produces the lip-sync, so it runs for every audio-driven route —
  // `audio_url` on the keyframed Wan 2.7 i2v path and the in-family R2V path
  // (Seedance 2.x, MiniMax H3), `reference_audio_urls` on Wan 3.0 R2V.
  if (!stageAFailed
    && mustRenderAsExactLipSync(shot, series.videoDefaults)
    && (MODELS_SUPPORTING_AUDIO_INPUT.has(videoPrompt.model)
      || MODELS_LIP_SYNC_VIA_REFERENCE_AUDIO.has(videoPrompt.model))) {
    const audioDir = join(dirname(sceneDir), 'audio');
    console.log(`  Locating dialogue audio for ${videoPrompt.model} lip-sync`);
    dialogueAudioPath = await ensureDialogueAudio(client, series, shot, audioDir);
  }

  const renderOptions: RenderVideoOptions = {
    prompt: videoPrompt,
    anchorImagePath,
    outputPath: videoPath,
    endFrameImagePath: endFramePath,
    elements,
    referenceImagePaths,
    sceneImagePaths,
    audioPath: dialogueAudioPath,
    voiceReferencePaths,
    aspectRatio: series.storyboardAspectRatio ?? '16:9',
    seedanceCompatibility: series.videoDefaults.seedanceCompatibility,
    characters: shot.characters,
    characterKinds: characterKindsFor(series, shot.characters),
    project: series.outputDir,
    resolution: series.videoDefaults.resolution,
  };
  let savedPath = await renderVideoFile(client, renderOptions);

  // Reference-audio lip-sync takes sometimes re-perform the line instead of
  // following the clip. Keep a take only when its audio matches the clip;
  // set rejected takes aside so a re-run renders just those shots.
  let lipSyncFidelity: LipSyncFidelity | undefined;
  if (dialogueAudioPath && MODELS_LIP_SYNC_VIA_REFERENCE_AUDIO.has(videoPrompt.model)) {
    const maxAttempts = Math.max(1, series.videoDefaults.lipSyncMaxAttempts ?? 1);
    for (let attempt = 1; ; attempt++) {
      lipSyncFidelity = measureLipSyncFidelity(savedPath, dialogueAudioPath);
      const summary = `corr ${lipSyncFidelity.corr}, worst 1s window ${lipSyncFidelity.minWindowCorr}`;
      if (lipSyncFidelity.ok) {
        console.log(`  Lip-sync check: follows the clip (${summary})`);
        break;
      }
      let k = 1;
      while (existsSync(savedPath.replace(/\.mp4$/, `.rejected-${k}.mp4`))) k++;
      const rejectedPath = savedPath.replace(/\.mp4$/, `.rejected-${k}.mp4`);
      renameSync(savedPath, rejectedPath);
      console.warn(`  ⚠ Lip-sync check: take re-performed the line (${summary}); set aside as ${rejectedPath.split('/').pop()}`);
      if (attempt >= maxAttempts) {
        console.warn(`  ⚠ Shot ${shotKey(shotId)} left unrendered after ${attempt} take(s); re-run generate-videos to try again.`);
        return [];
      }
      savedPath = await renderVideoFile(client, { ...renderOptions, forceRequeue: true });
    }
  }

  const durationSec = getVideoDuration(savedPath);
  unit.renderedDurationSec = durationSec;
  unit.segments = [{
    shotNumber: shot.shotNumber,
    startOffsetSec: 0,
    durationSec,
    outputFile: `shot-${shotKey(shotId)}.mp4`,
  }];

  const extraMetadata: Record<string, unknown> = { generationUnit: unit.unitId };
  if (lipSyncFidelity) extraMetadata.lipSyncFidelity = lipSyncFidelity;
  if (keyframeArtifacts) {
    extraMetadata.seedanceKeyframe = {
      stageAVideo: relativeForMetadata(savedPath, keyframeArtifacts.stageAVideoPath),
      keyframePng: relativeForMetadata(savedPath, keyframeArtifacts.keyframePngPath),
      keyframeModel: unit.keyframeModel,
      dialogueAudio: dialogueAudioPath
        ? relativeForMetadata(savedPath, dialogueAudioPath)
        : null,
    };
  } else if (unit.useSeedanceKeyframe === true && stageAFailed) {
    extraMetadata.seedanceKeyframe = {
      attempted: true,
      success: false,
      reason: stageAFailureReason,
    };
  }

  await saveSingleShotMetadata(series, shot, savedPath, videoPrompt, extraMetadata);
  return [savedPath];
}

function relativeForMetadata(anchorPath: string, target: string): string {
  // Both anchorPath and target live in the same scene dir; return the
  // basename for compactness while preserving uniqueness within the dir.
  if (dirname(anchorPath) === dirname(target)) {
    return target.slice(dirname(target).length + 1);
  }
  return target;
}

async function renderMultiShotUnit(
  client: VeniceClient,
  series: SeriesState,
  shots: ShotScript[],
  unit: GenerationUnit,
  sceneDir: string,
  previousRenderedShotPath: string | undefined,
  nextShotNumber: number | undefined,
): Promise<string[]> {
  const shotOutputPaths = shots.map(shot => getShotVideoPath(sceneDir, shot.shotNumber));
  if (shotOutputPaths.every(path => existsSync(path))) {
    console.log(`  ${unit.unitId}: shot outputs exist, skipping`);
    let offset = 0;
    unit.segments = shotOutputPaths.map((path, index) => {
      const durationSec = getVideoDuration(path);
      const segment: GenerationUnitSegment = {
        shotNumber: shots[index].shotNumber,
        startOffsetSec: Number(offset.toFixed(3)),
        durationSec: Number(durationSec.toFixed(3)),
        outputFile: `shot-${String(shots[index].shotNumber).padStart(3, '0')}.mp4`,
      };
      offset += durationSec;
      return segment;
    });
    unit.renderedDurationSec = offset;
    return shotOutputPaths;
  }

  const unitOutputPath = join(sceneDir, unit.outputFile);
  const prompt = buildMultiShotPrompt(shots, unit, series);
  unit.model = prompt.model;

  // Reference-first multi-shot (Seedance R2V default): pure reference mode.
  // The slot plan carries all consistency; no panel anchor is needed or sent
  // (renderVideoFile omits image_url when a slot plan is present on an
  // @Image-tag model). Legacy i2v overrides still anchor on the first panel.
  const hasSlotPlan = (prompt.referenceSlots?.length ?? 0) > 0
    && MODELS_USING_IMAGE_TAGS.has(prompt.model);

  const firstPanelPath = getShotPanelPath(sceneDir, shots[0].shotNumber);
  if (!existsSync(firstPanelPath) && !hasSlotPlan) {
    console.warn(`  Panel not found: ${firstPanelPath}, skipping unit ${unit.unitId}`);
    return [];
  }

  const anchorImagePath = hasSlotPlan
    ? undefined
    : chooseAnchorImagePath(unit, sceneDir, unitOutputPath, previousRenderedShotPath);
  const endFramePath = hasSlotPlan
    ? undefined
    : chooseEndFrameImagePath(unit, sceneDir, nextShotNumber);

  if (prompt.modelResolution) {
    console.log(`  Model: ${prompt.model} (${prompt.modelResolution.reason})`);
  }

  // Resolve elements and references for multi-shot — same identity anchoring as single shots
  const allCharNames = Array.from(new Set(shots.flatMap(s => s.characters)));
  const resolvedChars = allCharNames
    .map(name => series.characters.find(c => c.name.toUpperCase() === name.toUpperCase()))
    .filter(Boolean) as typeof series.characters;

  const charDirFn2 = (name: string) => getCharacterDir(series, name);

  let elements: VideoElement[] | undefined;
  let referenceImagePaths: string[] | undefined;

  if (hasSlotPlan) {
    // Push reference_image_urls in EXACTLY the slot-plan order so the
    // prompt's @ImageN bindings match the request array (same invariant as
    // resolveCharacterElements on the single-shot path).
    const paths = prompt.referenceSlots!
      .map(slot => slot.ref)
      .filter(p => existsSync(p));
    if (paths.length !== prompt.referenceSlots!.length) {
      console.warn('  ⚠ Multi-shot reference slot images missing on disk — @ImageN bindings may misalign; regenerate refs.');
    }
    referenceImagePaths = paths.length > 0 ? paths : undefined;
    if (referenceImagePaths) {
      console.log(`  Multi-shot slot plan: ${referenceImagePaths.length} reference(s) (pure reference mode)`);
    }
  } else if (prompt.characterElements && prompt.characterElements.length > 0
    && MODELS_SUPPORTING_ELEMENTS.has(prompt.model)) {
    elements = prompt.characterElements.map(slot => {
      const dir = charDirFn2(slot.characterName);
      const frontal = join(dir, 'front.png');
      const refs = ['three-quarter.png', 'profile.png', 'back.png']
        .map(f => join(dir, f))
        .filter(p => existsSync(p))
        .slice(0, 3);
      return {
        frontalImageUrl: existsSync(frontal) ? frontal : undefined,
        referenceImageUrls: refs.length > 0 ? refs : undefined,
      };
    });
    console.log(`  ${unit.unitId}: elements enabled for ${prompt.characterElements.map(s => s.characterName).join(', ')}`);
  } else if (MODELS_SUPPORTING_REFERENCE_IMAGES.has(prompt.model) && resolvedChars.length > 0) {
    referenceImagePaths = resolvedChars
      .flatMap(c => {
        const dir = charDirFn2(c.name);
        return ['front.png', 'three-quarter.png']
          .map(f => join(dir, f))
          .filter(p => existsSync(p));
      })
      .slice(0, 4);
    if (referenceImagePaths.length === 0) referenceImagePaths = undefined;
  }

  // Voice-donor clips for the unit's dialogue speakers, in @AudioN order
  // (only used by reference-audio-capable models with ≥1 reference image).
  const voiceReferencePaths = resolveVoiceReferencePaths(series, prompt);

  const savedUnitPath = await renderVideoFile(client, {
    prompt,
    anchorImagePath,
    outputPath: unitOutputPath,
    endFrameImagePath: endFramePath,
    elements,
    referenceImagePaths,
    voiceReferencePaths: voiceReferencePaths.length > 0 ? voiceReferencePaths : undefined,
    aspectRatio: series.storyboardAspectRatio ?? '16:9',
    seedanceCompatibility: series.videoDefaults.seedanceCompatibility,
    characters: Array.from(new Set(shots.flatMap(shot => shot.characters))),
    characterKinds: characterKindsFor(series, shots.flatMap(shot => shot.characters)),
    project: series.outputDir,
  });

  const segments = splitRenderedUnitIntoShots(savedUnitPath, unit, new Map(shots.map(shot => [shot.shotNumber, shot])), sceneDir);
  const shotPaths: string[] = [];

  for (const segment of segments) {
    const shot = shots.find(item => item.shotNumber === segment.shotNumber);
    if (!shot) continue;
    const shotPath = join(sceneDir, segment.outputFile);
    shotPaths.push(shotPath);

    await saveSingleShotMetadata(series, shot, shotPath, {
      ...prompt,
      duration: shot.duration,
    }, {
      generationUnit: unit.unitId,
      generatedFromUnit: unit.outputFile,
      unitStartOffsetSec: segment.startOffsetSec,
      unitDurationSec: segment.durationSec,
    });
  }

  unit.renderedDurationSec = Number(getVideoDuration(savedUnitPath).toFixed(3));
  unit.segments = segments;
  await saveJson(savedUnitPath.replace(/\.mp4$/, '.video.json'), {
    unitId: unit.unitId,
    shotNumbers: unit.shotNumbers,
    video: prompt,
    metadata: {
      unitType: unit.unitType,
      segments,
      decisionReasons: unit.decisionReasons,
    },
  });

  return shotPaths;
}

/**
 * Render a montage unit: ONE single-pass generation (Seedance 2.5, up to 30s)
 * prompted with the timestamped SEQUENCE beat list, then cut at the same
 * timestamps into per-shot clips — canonical `shot-NNN.mp4` files for the
 * assembler AND organized copies in `media-library/scene-NN/` (with the
 * uncut master and a manifest) for hand editing / the Venice Video Creator.
 */
async function renderMontageUnit(
  client: VeniceClient,
  series: SeriesState,
  shots: ShotScript[],
  unit: GenerationUnit,
  sceneDir: string,
): Promise<string[]> {
  const shotOutputPaths = shots.map(shot => getShotVideoPath(sceneDir, shot.shotNumber));
  const episodeDir = dirname(sceneDir);
  const unitOutputPath = join(sceneDir, unit.outputFile);

  if (existsSync(unitOutputPath) && shotOutputPaths.every(path => existsSync(path))) {
    console.log(`  ${unit.unitId}: montage master and shot cuts exist, skipping`);
    let offset = 0;
    unit.segments = shotOutputPaths.map((path, index) => {
      const durationSec = getVideoDuration(path);
      const segment: GenerationUnitSegment = {
        shotNumber: shots[index].shotNumber,
        startOffsetSec: Number(offset.toFixed(3)),
        durationSec: Number(durationSec.toFixed(3)),
        outputFile: `shot-${shotKey(shots[index].shotNumber)}.mp4`,
      };
      offset += durationSec;
      return segment;
    });
    unit.renderedDurationSec = Number(getVideoDuration(unitOutputPath).toFixed(3));
    return shotOutputPaths;
  }

  const prompt = buildMontagePrompt(shots, unit, series);
  unit.model = prompt.model;

  if (prompt.modelResolution) {
    console.log(`  Model: ${prompt.model} (${prompt.modelResolution.reason})`);
  }

  // Pure reference mode — same invariant as the multi-shot lane: push
  // reference_image_urls in EXACTLY the slot-plan order so @ImageN bindings
  // match the request array.
  let referenceImagePaths: string[] | undefined;
  if ((prompt.referenceSlots?.length ?? 0) > 0) {
    const paths = prompt.referenceSlots!
      .map(slot => slot.ref)
      .filter(p => existsSync(p));
    if (paths.length !== prompt.referenceSlots!.length) {
      console.warn('  ⚠ Montage reference slot images missing on disk — @ImageN bindings may misalign; regenerate refs.');
    }
    referenceImagePaths = paths.length > 0 ? paths : undefined;
    if (referenceImagePaths) {
      console.log(`  Montage slot plan: ${referenceImagePaths.length} reference(s) (pure reference mode, ${getMaxReferenceImages(prompt.model)}-image budget)`);
    }
  }

  const voiceReferencePaths = resolveVoiceReferencePaths(series, prompt);

  const savedUnitPath = await renderVideoFile(client, {
    prompt,
    anchorImagePath: undefined,
    outputPath: unitOutputPath,
    referenceImagePaths,
    voiceReferencePaths: voiceReferencePaths.length > 0 ? voiceReferencePaths : undefined,
    aspectRatio: series.storyboardAspectRatio ?? '16:9',
    seedanceCompatibility: series.videoDefaults.seedanceCompatibility,
    characters: Array.from(new Set(shots.flatMap(shot => shot.characters))),
    characterKinds: characterKindsFor(series, shots.flatMap(shot => shot.characters)),
    project: series.outputDir,
  });

  // Cut at the planned beat boundaries — the same timestamps the prompt's
  // SEQUENCE block declared.
  const { shotPaths, libraryPaths, segments } = cutMontageIntoShots({
    montagePath: savedUnitPath,
    unit,
    shotsByNumber: new Map(shots.map(shot => [shot.shotNumber, shot])),
    sceneDir,
    episodeDir,
    archiveExisting,
  });
  console.log(`  Media library: ${libraryPaths.length} cut(s) + master → ${join(episodeDir, 'media-library', `scene-${String(unit.sceneNumber ?? 1).padStart(2, '0')}`)}`);

  for (const segment of segments) {
    const shot = shots.find(item => item.shotNumber === segment.shotNumber);
    if (!shot) continue;
    await saveSingleShotMetadata(series, shot, join(sceneDir, segment.outputFile), {
      ...prompt,
      duration: shot.duration,
    }, {
      generationUnit: unit.unitId,
      generatedFromUnit: unit.outputFile,
      unitStartOffsetSec: segment.startOffsetSec,
      unitDurationSec: segment.durationSec,
      montageScene: unit.sceneNumber,
    });
  }

  unit.renderedDurationSec = Number(getVideoDuration(savedUnitPath).toFixed(3));
  unit.segments = segments;
  await saveJson(savedUnitPath.replace(/\.mp4$/, '.video.json'), {
    unitId: unit.unitId,
    shotNumbers: unit.shotNumbers,
    video: prompt,
    metadata: {
      unitType: unit.unitType,
      sceneNumber: unit.sceneNumber,
      montageBeats: unit.montageBeats,
      segments,
      decisionReasons: unit.decisionReasons,
    },
  });

  return shotPaths;
}

export interface GenerateEpisodeVideosResult {
  videoPaths: string[];
  plan: GenerationPlan;
}

export { assertShotDurationsValid };

export async function generateEpisodeVideos(
  client: VeniceClient,
  series: SeriesState,
  shots: ShotScript[],
  sceneDir: string,
  plan: GenerationPlan,
  episodeAudioMix?: import('venice-video-harness/core/series/types.js').AudioMixDefaults,
): Promise<GenerateEpisodeVideosResult> {
  const renderer: GenerationUnitRenderer = {
    single: (shot, unit, context) => renderSingleShotUnit(
      client,
      series,
      shot,
      unit,
      sceneDir,
      context.previousRenderedShot,
      context.nextShotNumber,
      context.previousShot,
      episodeAudioMix,
    ),
    montage: (unitShots, unit) => renderMontageUnit(client, series, unitShots, unit, sceneDir),
    multishot: (unitShots, unit, context) => renderMultiShotUnit(
      client,
      series,
      unitShots,
      unit,
      sceneDir,
      context.previousRenderedShot,
      context.nextShotNumber,
    ),
    // A classified refusal is final: a face-screening refusal fails on the
    // same images every time, and a provider refusal has already had its one
    // refunded retry inside submitVideoQueue (anti-pattern 27b). A FAILED
    // render is final too: its pending-job record is already cleared, so a
    // retry re-queues and re-bills the same body. A faces-off refusal is
    // thrown before the queue call on the same images every time.
    isFinalError: err => isAbortError(err)
      || err instanceof VideoRefusalError
      || err instanceof VideoGenerationFailedError
      || err instanceof FacesOffModelError,
    describeHttpError: err => (err instanceof VeniceRequestError
      ? { status: err.status, message: err.message, body: err.body }
      : undefined),
  };
  return runGenerationUnits(
    { logger: createCliLogger(), clock: createCliClock() },
    renderer,
    shots,
    plan,
    { signal: currentSignal() },
  );
}
