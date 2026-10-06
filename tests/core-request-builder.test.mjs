// The /video/queue body is decided in core: a host passes every image and
// audio input as a URL / data: URI string and gets the exact body back. No
// files, no ffmpeg, no Venice -- these build bodies from in-memory strings.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as core from '../packages/core/dist/venice/request-builder.js';
import * as barrel from '../packages/core/dist/index.js';
import * as cliVideo from '../dist/venice/video.js';
import * as cliRefusal from '../dist/venice/refusal.js';
import * as cliPreflight from '../dist/venice/seedance-preflight.js';
import * as cliVoice from '../dist/mini-drama/voice-reference.js';
import * as cliGenerator from '../dist/mini-drama/video-generator.js';

const IMG = n => `data:image/png;base64,IMG${n}`;
const AUD = n => `data:audio/mpeg;base64,AUD${n}`;

function silentLogger() {
  const lines = [];
  return {
    lines,
    logger: {
      info: m => lines.push(`info:${m}`),
      warn: m => lines.push(`warn:${m}`),
    },
  };
}

function build(input) {
  const { lines, logger } = silentLogger();
  const body = core.buildVideoQueueRequest(input, { logger });
  return { body, lines };
}

test('the barrel and the CLI modules share core\'s functions', () => {
  for (const name of ['buildVideoQueueRequest', 'buildRegistryVideoQueueRequest', 'planVideoQueueRequest',
    'withSeedanceFaceConsent', 'isNeedsConsentError', 'planLipSyncReferenceAudio', 'voiceReferenceClipIssue']) {
    assert.equal(typeof core[name], 'function', name);
    assert.equal(barrel[name], core[name], `barrel ${name}`);
  }
  assert.equal(cliVoice.VOICE_REF_MIN_SEC, core.VOICE_REF_MIN_SEC);
  assert.equal(cliVoice.VOICE_REF_MAX_SEC, core.VOICE_REF_MAX_SEC);
  assert.equal(cliRefusal.classifyVideoQueueRefusal, barrel.classifyVideoQueueRefusal);
  assert.equal(cliVideo.classifyVideoRetrieveStatus, barrel.classifyVideoRetrieveStatus);
  assert.equal(cliPreflight.FacesOffModelError, barrel.FacesOffModelError);
  assert.equal(cliPreflight.characterKindsFor, barrel.characterKindsFor);
  assert.equal(cliGenerator.assertShotDurationsValid, barrel.assertShotDurationsValid);
});

test('Seedance R2V with a slot plan renders in pure reference mode', () => {
  const { body, lines } = build({
    model: 'seedance-2-5-reference-to-video',
    prompt: '@Image1 walks to @Image2.',
    duration: '10s',
    audio: true,
    referenceSlotCount: 2,
    startImageUrl: IMG('start'),
    referenceImageUrls: [IMG(1), IMG(2)],
    referenceAudioUrls: [AUD('voice')],
  });
  assert.deepEqual(Object.keys(body), [
    'model', 'prompt', 'duration', 'audio', 'resolution', 'bitrate_mode', 'aspect_ratio',
    'reference_image_urls', 'reference_audio_urls',
  ]);
  assert.equal(body.image_url, undefined, 'no start frame in pure reference mode');
  assert.equal(body.resolution, '720p');
  assert.equal(body.bitrate_mode, 'high');
  assert.equal(body.aspect_ratio, '16:9');
  assert.deepEqual(body.reference_image_urls, [IMG(1), IMG(2)]);
  assert.deepEqual(body.reference_audio_urls, [AUD('voice')]);
  assert.ok(lines.includes('info:  Start frame: none (pure reference mode — refs carry consistency)'));
});

test('without a slot plan the start frame is sent', () => {
  const { body } = build({
    model: 'seedance-2-5-reference-to-video', prompt: 'p', duration: '5s', audio: true,
    startImageUrl: IMG('start'), referenceImageUrls: [IMG(1)],
  });
  assert.equal(body.image_url, IMG('start'));
});

test('resolution pins: H3 Max is 768P, base H3 is 2K, an override wins only when listed', () => {
  assert.equal(core.resolveRequestResolution('minimax-h3-max-text-to-video'), '768P');
  assert.equal(core.resolveRequestResolution('minimax-h3-reference-to-video'), '2K');
  assert.equal(core.resolveRequestResolution('minimax-h3-max-text-to-video', '480P'), '480P');
  assert.equal(core.resolveRequestResolution('minimax-h3-max-text-to-video', '2K'), '768P');
  const { body, lines } = build({
    model: 'minimax-h3-max-text-to-video', prompt: 'p', duration: '5s', audio: false, resolution: '2K',
  });
  assert.equal(body.resolution, '768P');
  assert.ok(lines.some(l => l.startsWith('warn:  ⚠ Resolution override 2K not valid')));
});

test('audio is omitted for models whose audio is not configurable', () => {
  for (const model of ['happyhorse-1-1-reference-to-video', 'minimax-h3-max-text-to-video']) {
    const { body } = build({ model, prompt: 'p', duration: '5s', audio: false });
    assert.equal('audio' in body, false, model);
  }
  const { body } = build({ model: 'seedance-2-5-reference-to-video', prompt: 'p', duration: '5s', audio: false });
  assert.equal(body.audio, false);
});

test('text-to-video and R2V carry aspect_ratio; image-to-video inherits it', () => {
  assert.equal(build({ model: 'minimax-h3-max-text-to-video', prompt: 'p', duration: '5s', audio: true, aspectRatio: '9:16' }).body.aspect_ratio, '9:16');
  assert.equal(build({ model: 'minimax-h3-reference-to-video', prompt: 'p', duration: '5s', audio: true }).body.aspect_ratio, '16:9');
  assert.equal(build({ model: 'kling-v3-pro-image-to-video', prompt: 'p', duration: '5s', audio: true, startImageUrl: IMG(0) }).body.aspect_ratio, undefined);
});

test('reference images are cut to the model budget; voice audio needs a reference image', () => {
  const urls = Array.from({ length: 12 }, (_, i) => IMG(i));
  const { body, lines } = build({ model: 'minimax-h3-reference-to-video', prompt: 'p', duration: '5s', audio: true, referenceImageUrls: urls });
  assert.equal(body.reference_image_urls.length, 9);
  assert.ok(lines.some(l => l.includes('exceed minimax-h3-reference-to-video\'s 9-image budget')));
  assert.equal(core.videoQueueReferenceImages('minimax-h3-reference-to-video', urls).length, 9);
  assert.equal(core.videoQueueReferenceImages('kling-v3-pro-image-to-video', urls), undefined);

  const noRefs = build({ model: 'seedance-2-5-reference-to-video', prompt: 'p', duration: '5s', audio: true, referenceAudioUrls: [AUD(1)] });
  assert.equal(noRefs.body.reference_audio_urls, undefined);
  assert.ok(noRefs.lines.some(l => l.includes('Voice references present but no reference image')));
});

test('the plan says which media a host needs to prepare', () => {
  const plan = core.planVideoQueueRequest({ model: 'seedance-2-5-reference-to-video', referenceSlotCount: 3, hasReferenceImages: true });
  assert.equal(plan.referencesOnly, true);
  assert.equal(plan.acceptsReferenceImages, true);
  assert.equal(plan.referenceImageBudget, 30);
  assert.equal(plan.acceptsReferenceAudio, true);
  assert.equal(plan.sendsAudioField, true);
  const kling = core.planVideoQueueRequest({ model: 'kling-o3-standard-reference-to-video' });
  assert.equal(kling.acceptsElements, true);
  assert.equal(kling.acceptsSceneImages, true);
  assert.equal(kling.sceneImageBudget, 4);
  const wan3 = core.planVideoQueueRequest({ model: 'wan-3-0-reference-to-video', hasReferenceImages: true, hasDialogueAudio: true });
  assert.equal(wan3.lipSyncViaReferenceAudio, true);
  assert.equal(wan3.referencesOnly, true);
});

test('an invalid camera trajectory throws before anything is built', () => {
  assert.throws(
    () => core.planVideoQueueRequest({ model: 'minimax-h3-max-multi-angle', cameraTrajectory: [{ time: 0.5, azimuth: 0, elevation: 0, distance: 1 }] }),
    /Invalid camera_trajectory for minimax-h3-max-multi-angle/,
  );
});

test('lip-sync and voice-donor clip rules', () => {
  assert.deepEqual(core.planLipSyncReferenceAudio({ model: 'wan-3-0-reference-to-video', audioSec: 3, duration: '8s', label: 'a.mp3' }), { targetSec: 8, warnings: [] });
  assert.equal(core.planLipSyncReferenceAudio({ model: 'wan-3-0-reference-to-video', audioSec: 6, duration: '4s', label: 'a.mp3' }).warnings.length, 1);
  assert.throws(
    () => core.planLipSyncReferenceAudio({ model: 'wan-3-0-reference-to-video', audioSec: 16, duration: '20s', label: 'a.mp3' }),
    /accepts at most 15s of reference audio per render/,
  );
  assert.equal(core.voiceReferenceClipIssue('v.mp3', 8, 0), undefined);
  assert.match(core.voiceReferenceClipIssue('v.mp3', 1, 0), /must be 2-15s/);
  assert.match(core.voiceReferenceClipIssue('v.mp3', 8, 10), /aggregate would exceed 15s/);
});

test('Seedance face consent is added last, after a 409 needs_consent', () => {
  const body = { model: 'seedance-2-5-reference-to-video', prompt: 'p', duration: '5s' };
  assert.equal(core.isNeedsConsentError(409, { error: { code: 'needs_consent' } }), true);
  assert.equal(core.isNeedsConsentError(409, { error: { code: 'other' } }), false);
  assert.equal(core.isNeedsConsentError(400, { error: { code: 'needs_consent' } }), false);
  const consented = core.withSeedanceFaceConsent(body);
  assert.deepEqual(Object.keys(consented), ['model', 'prompt', 'duration', 'consents']);
  assert.deepEqual(consented.consents.seedance, core.SEEDANCE_FACE_CONSENT);
  assert.equal(body.consents, undefined, 'the input is not mutated');
});

test('the registry builder (queueVideo) gates on registry flags', () => {
  const { lines, logger } = silentLogger();
  const body = core.buildRegistryVideoQueueRequest({
    model: 'kling-v3-pro-image-to-video', prompt: 'p', duration: '5s',
    imageUrl: IMG(0), referenceImageUrls: [IMG(1)], referenceAudioUrls: [AUD(1)],
  }, { logger });
  assert.equal(body.image_url, IMG(0));
  assert.equal(body.reference_image_urls, undefined);
  assert.ok(lines.some(l => l.includes('does not support reference_audio_urls')));

  const snapped = core.snapVideoRequest({ duration: '7s' }, [{ field: 'duration', message: 'bad', suggestion: '8s' }], { logger });
  assert.equal(snapped.duration, '8s');
});

test('faces-off decision runs on in-memory provenance', () => {
  assert.equal(barrel.decideFacesOff({ model: 'seedance-2-5-reference-to-video', images: [{ ref: 'a', hasFace: true }] }), undefined);
  const violation = barrel.decideFacesOff({
    model: 'seedance-2-0-reference-to-video-basic',
    images: [{ ref: 'sheet', hasFace: true }, { ref: 'plate', hasFace: false }],
  });
  assert.equal(violation.faceCapableModel, 'seedance-2-0-reference-to-video');
  assert.deepEqual(violation.faceImages, ['sheet']);
  assert.equal(barrel.decideFacesOff({ model: 'seedance-2-0-reference-to-video-basic', images: [{ ref: 'plate', hasFace: false }], characters: ['BOB'] }), undefined);
});

test('refusals and retrieve verdicts classify plain bodies', () => {
  const refusal = barrel.classifyVideoQueueRefusal({
    status: 422, message: 'refused', model: 'seedance-2-5-reference-to-video', requestBody: {},
    body: { error: { type: 'provider_content_policy', credits_refunded: true, message: 'no' } },
  });
  assert.equal(refusal.kind, 'provider-content-policy');
  assert.equal(refusal.retryable, true);
  assert.deepEqual(barrel.classifyVideoRetrieveStatus({ status: 'PROCESSING' }), { kind: 'processing' });
  assert.equal(barrel.classifyVideoRetrieveStatus({ status: 'FAILED', error: 'x' }).detail, 'x');
});
