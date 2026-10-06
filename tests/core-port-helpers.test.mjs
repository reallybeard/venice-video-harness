// The pure helpers a host needs to implement the ports (packages/core):
// chatJson's reply policy, the /video/queue handshakes, the pending-job
// record and image-format sniffing. Each is checked over the core barrel,
// and against the CLI module that re-exports or drives it, so the two hosts
// cannot drift.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_JSON_DEFAULT_MAX_TOKENS,
  CHAT_JSON_DEFAULT_TEMPERATURE,
  CHAT_JSON_MAX_ATTEMPTS,
  chatJsonBody,
  chatJsonMessages,
  chatJsonStep,
  nextVideoQueueAttempt,
  startVideoQueueAttempts,
  SEEDANCE_FACE_CONSENT,
  FACE_SCREENING_MESSAGE,
  PENDING_JOB_PROMPT_MAX_CHARS,
  PENDING_JOB_STALE_AFTER_MS,
  isStalePendingJob,
  pendingJobPrompt,
  sniffImageFormat,
} from 'venice-video-harness/core';

const { VeniceClient } = await import('../dist/venice/client.js');
const cliImageBytes = await import('../dist/venice/image-bytes.js');
const cliJobStore = await import('../dist/venice/job-store.js');
const cliVideoGenerator = await import('../dist/mini-drama/video-generator.js');

// ---- chatJson reply policy ------------------------------------------------------

const TEXT = { model: 'm', systemPrompt: 'sys', userPrompt: 'user' };
const VISION = { ...TEXT, images: ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB'], label: 'panel QA' };

test('chatJsonMessages: system then user; images go ahead of the prompt text', () => {
  assert.deepEqual(chatJsonMessages(TEXT), [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'user' },
  ]);
  assert.deepEqual(chatJsonMessages(VISION)[1].content, [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
    { type: 'text', text: 'user' },
  ]);
});

test('chatJsonBody: defaults, key order, and venice_parameters only with disableThinking', () => {
  const messages = chatJsonMessages(TEXT);
  assert.equal(CHAT_JSON_DEFAULT_MAX_TOKENS, 8000);
  assert.equal(CHAT_JSON_DEFAULT_TEMPERATURE, 0.65);
  assert.equal(
    JSON.stringify(chatJsonBody(TEXT, messages)),
    JSON.stringify({ model: 'm', messages, max_tokens: 8000, temperature: 0.65 }),
  );
  assert.equal(
    JSON.stringify(chatJsonBody({ ...TEXT, maxTokens: 50, temperature: 0, disableThinking: true }, messages)),
    JSON.stringify({
      model: 'm', messages, max_tokens: 50, temperature: 0,
      venice_parameters: { disable_thinking: true, strip_thinking_response: true },
    }),
  );
});

test('chatJsonStep: a fenced reply parses', () => {
  const step = chatJsonStep(TEXT, 0, chatJsonMessages(TEXT), 'Here you go:\n```json\n{"pass": true}\n```');
  assert.deepEqual(step, { kind: 'ok', value: { pass: true } });
});

test('chatJsonStep: an empty first reply retries with the same messages', () => {
  const messages = chatJsonMessages(VISION);
  const step = chatJsonStep(VISION, 0, messages, '  \n');
  assert.equal(step.kind, 'retry');
  assert.equal(step.messages, messages);
  assert.match(step.error.message, /m returned no content for the panel QA\. Either the model cannot read images/);
});

test('chatJsonStep: an unparseable first reply retries with the output and the parser complaint appended', () => {
  const messages = chatJsonMessages(TEXT);
  const step = chatJsonStep(TEXT, 0, messages, '{"a": 1');
  assert.equal(step.kind, 'retry');
  assert.equal(step.messages.length, 4);
  assert.deepEqual(step.messages.slice(0, 2), messages);
  assert.deepEqual(step.messages[2], { role: 'assistant', content: '{"a": 1' });
  assert.equal(
    step.messages[3].content,
    `That did not parse as JSON: ${step.error.message}. Return the same content again as one valid JSON document. No prose, no markdown fences.`,
  );
  assert.equal(messages.length, 2, 'the previous attempt\'s messages are not mutated');
});

test('chatJsonStep: the last attempt errors (empty: the no-vision / budget message; unparseable: after a retry)', () => {
  const last = CHAT_JSON_MAX_ATTEMPTS - 1;
  assert.equal(CHAT_JSON_MAX_ATTEMPTS, 2);
  const emptyText = chatJsonStep({ ...TEXT, maxTokens: 300 }, last, chatJsonMessages(TEXT), '');
  assert.equal(emptyText.kind, 'error');
  assert.equal(emptyText.error.message, 'm returned no content for the response. It may have spent the whole 300-token budget reasoning.');
  const emptyVision = chatJsonStep(VISION, last, chatJsonMessages(VISION), '');
  assert.match(emptyVision.error.message, /retried once before giving up\.$/);
  const bad = chatJsonStep(TEXT, last, chatJsonMessages(TEXT), 'not json at all');
  assert.equal(bad.kind, 'error');
  assert.match(bad.error.message, /^m did not return valid JSON for the response after a retry: /);
});

test('VeniceClient.chatJson sends exactly the bodies the core policy builds', async () => {
  const client = new VeniceClient('test-key');
  const sent = [];
  const replies = ['', '{"broken": '];
  client.post = async (path, body) => {
    sent.push([path, JSON.stringify(body)]);
    return { choices: [{ message: { content: replies.shift() } }] };
  };
  // empty -> retry as is; then unparseable on the last attempt -> error.
  await assert.rejects(client.chatJson(VISION), /did not return valid JSON for the panel QA after a retry/);
  const first = chatJsonMessages(VISION);
  assert.deepEqual(sent, [
    ['/api/v1/chat/completions', JSON.stringify(chatJsonBody(VISION, first))],
    ['/api/v1/chat/completions', JSON.stringify(chatJsonBody(VISION, first))],
  ]);

  sent.length = 0;
  replies.push('{"broken": ', '{"ok": 1}');
  assert.deepEqual(await client.chatJson(TEXT), { ok: 1 });
  const retry = chatJsonStep(TEXT, 0, chatJsonMessages(TEXT), '{"broken": ');
  assert.equal(sent[1][1], JSON.stringify(chatJsonBody(TEXT, retry.messages)));
});

// ---- /video/queue handshakes ------------------------------------------------------

const SEEDANCE = 'seedance-2-5-reference-to-video';
const BODY = { model: SEEDANCE, prompt: 'p', duration: '5s', reference_image_urls: ['data:image/png;base64,AAAA'] };
const NEEDS_CONSENT = { status: 409, message: 'consent required', body: { error: { code: 'needs_consent' } } };
const refusal = (refunded) => ({
  status: 422,
  message: 'Your prompt violates the content policy',
  body: { error: { type: 'provider_content_policy', message: 'Your prompt violates the content policy', credits_refunded: refunded, recommended_model: 'wan-3-0-reference-to-video' } },
});

test('the CLI re-exports the core handshake functions', () => {
  assert.equal(cliVideoGenerator.nextVideoQueueAttempt, nextVideoQueueAttempt);
  assert.equal(cliVideoGenerator.startVideoQueueAttempts, startVideoQueueAttempts);
});

test('409 needs_consent: resubmit once with the attestation, then the next 409 fails "after consent"', () => {
  const start = startVideoQueueAttempts(SEEDANCE, BODY);
  assert.deepEqual(start, { model: SEEDANCE, body: BODY, consented: false, refusals: 0 });

  const first = nextVideoQueueAttempt(start, NEEDS_CONSENT);
  assert.equal(first.kind, 'resubmit');
  assert.equal(first.reason, 'needs-consent');
  assert.deepEqual(first.state.body, { ...BODY, consents: { seedance: { ...SEEDANCE_FACE_CONSENT } } });
  assert.equal(Object.keys(first.state.body).at(-1), 'consents', 'consents goes last, as the CLI sends it');
  assert.equal(first.state.consented, true);
  assert.deepEqual(first.log, [{ level: 'info', message: '  Seedance face consent requested (409 needs_consent) — resubmitting with attestation.' }]);
  assert.deepEqual(start.body, BODY, 'the previous state is not mutated');

  const second = nextVideoQueueAttempt(first.state, NEEDS_CONSENT);
  assert.equal(second.kind, 'fail');
  assert.deepEqual(second.log.map(l => l.level), ['error', 'error']);
  assert.equal(second.log[0].message, '  Venice queue error after consent (HTTP 409): consent required');
  assert.equal(second.log[1].message, `  Error body: ${JSON.stringify(NEEDS_CONSENT.body, null, 2)}`);
});

test('a refunded refusal is resubmitted once; the second is refused naming the recommended model', () => {
  const first = nextVideoQueueAttempt(startVideoQueueAttempts(SEEDANCE, BODY), refusal(true));
  assert.equal(first.kind, 'resubmit');
  assert.equal(first.reason, 'refunded-refusal');
  assert.equal(first.state.refusals, 1);
  assert.equal(first.state.body, BODY);
  assert.equal(first.log[0].level, 'warn');
  assert.match(first.log[0].message, /^ {2}⚠ .*Credits were refunded; retrying once\.$/);

  const second = nextVideoQueueAttempt(first.state, refusal(true));
  assert.equal(second.kind, 'refused');
  assert.equal(second.refusal.kind, 'provider-content-policy');
  assert.equal(second.refusal.retryable, false);
  assert.match(second.log[0].message, /^ {2}✖ .*Venice recommends wan-3-0-reference-to-video/);
});

test('an unrefunded refusal and a face-screening 422 are refused at once', () => {
  const unrefunded = nextVideoQueueAttempt(startVideoQueueAttempts(SEEDANCE, BODY), refusal(false));
  assert.equal(unrefunded.kind, 'refused');
  assert.match(unrefunded.refusal.message, /Credits were NOT refunded/);

  const face = nextVideoQueueAttempt(startVideoQueueAttempts(SEEDANCE, BODY), {
    status: 422, message: 'Your prompt violates the content policy', body: { error: 'Your prompt violates the content policy' },
  });
  assert.equal(face.kind, 'refused');
  assert.equal(face.refusal.kind, 'face-screening');
  assert.deepEqual(face.log, [{ level: 'error', message: `  ✖ ${FACE_SCREENING_MESSAGE}` }]);
});

test('anything else fails as it is: a 5xx is never resubmitted (it may have billed)', () => {
  const decision = nextVideoQueueAttempt(startVideoQueueAttempts(SEEDANCE, BODY), { status: 502, message: 'Bad gateway', body: undefined });
  assert.equal(decision.kind, 'fail');
  assert.deepEqual(decision.log, [
    { level: 'error', message: '  Venice queue error (HTTP 502): Bad gateway' },
    { level: 'error', message: '  Error body: undefined' },
  ]);
});

// ---- pending-job record --------------------------------------------------------------

test('isStalePendingJob: stale only once the heartbeat is more than 6 h old', () => {
  assert.equal(PENDING_JOB_STALE_AFTER_MS, 6 * 60 * 60 * 1000);
  const updatedAt = '2026-10-06T00:00:00.000Z';
  const at = Date.parse(updatedAt);
  assert.equal(isStalePendingJob({ updatedAt }, at + PENDING_JOB_STALE_AFTER_MS), false);
  assert.equal(isStalePendingJob({ updatedAt }, at + PENDING_JOB_STALE_AFTER_MS + 1), true);
  const job = { kind: 'video', model: 'm', queueId: 'q', outputPath: '/x.mp4', createdAt: updatedAt, updatedAt, pid: 1 };
  assert.equal(cliJobStore.isStale(job, at + PENDING_JOB_STALE_AFTER_MS + 1), true);
  assert.equal(cliJobStore.isStale(job, at), false);
  assert.equal(cliJobStore.isStalePendingJob, isStalePendingJob);
});

test('pendingJobPrompt keeps the first 240 characters and drops an empty prompt', () => {
  assert.equal(PENDING_JOB_PROMPT_MAX_CHARS, 240);
  assert.equal(pendingJobPrompt('x'.repeat(300)), 'x'.repeat(240));
  assert.equal(pendingJobPrompt('short'), 'short');
  assert.equal(pendingJobPrompt(''), undefined);
  assert.equal(pendingJobPrompt(undefined), undefined);
});

// ---- image-format sniffing ---------------------------------------------------------------

const bytes = (...b) => new Uint8Array([...b, ...new Array(16).fill(0)]);

test('sniffImageFormat reads magic bytes from a plain Uint8Array (the CLI re-exports the same function)', () => {
  assert.equal(cliImageBytes.sniffImageFormat, sniffImageFormat);
  const cases = [
    [bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'png', 'image/png', '.png'],
    [bytes(0xff, 0xd8, 0xff), 'jpeg', 'image/jpeg', '.jpg'],
    [bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50), 'webp', 'image/webp', '.webp'],
    [bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61), 'gif', 'image/gif', '.gif'],
    [bytes(0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66), 'avif', 'image/avif', '.avif'],
    [bytes(0x00, 0x01, 0x02), 'unknown', 'application/octet-stream', '.bin'],
    [new Uint8Array(), 'unknown', 'application/octet-stream', '.bin'],
  ];
  for (const [input, format, mime, ext] of cases) {
    assert.deepEqual(sniffImageFormat(input), { format, mime, ext });
  }
});
