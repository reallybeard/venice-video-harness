// ---------------------------------------------------------------------------
// The /video/queue handshakes -- pure. Given a failed queue answer, decide
// whether to resubmit (409 needs_consent with the Seedance face-media
// attestation; a refunded provider refusal, once), give up as refused, or let
// the error stand -- and what to print. The POST stays with the host (the CLI:
// `submitVideoQueue` in src/mini-drama/video-generator.ts).
// ---------------------------------------------------------------------------

import { isNeedsConsentError, withSeedanceFaceConsent } from './request-builder.js';
import { classifyVideoQueueRefusal, type VideoRefusal } from './refusal.js';

/** Where a run of `/video/queue` attempts stands: the body to send next and the handshakes spent. */
export interface VideoQueueAttemptState<T extends object = Record<string, unknown>> {
  /** The model the request names. */
  model: string;
  body: T;
  /** The 409 `needs_consent` resubmit has been made. */
  consented: boolean;
  /** Refusals so far; a refunded one is retried only while this is 0. */
  refusals: number;
}

/** A failed `/video/queue` answer. */
export interface VideoQueueFailure {
  status: number;
  /** The human-readable reason extracted from the body. */
  message: string;
  body: unknown;
}

/** A line to print, at the level to print it. */
export interface VideoQueueLogLine {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export type VideoQueueAttemptDecision<T extends object = Record<string, unknown>> =
  /**
   * Send `state.body`: with the face-media consent attached (`needs-consent`),
   * or the same body again after a refunded refusal.
   */
  | { kind: 'resubmit'; reason: 'needs-consent' | 'refunded-refusal'; state: VideoQueueAttemptState<T>; refusal?: VideoRefusal; log: VideoQueueLogLine[] }
  /** Refused, and no retry is warranted. */
  | { kind: 'refused'; refusal: VideoRefusal; log: VideoQueueLogLine[] }
  /** Not a handshake: the error stands as it is. */
  | { kind: 'fail'; log: VideoQueueLogLine[] };

/** The state before the first attempt. */
export function startVideoQueueAttempts<T extends object>(model: string, body: T): VideoQueueAttemptState<T> {
  return { model, body, consented: false, refusals: 0 };
}

/**
 * What to do after `/video/queue` refused `state.body` with `failure`.
 *
 *  - 409 `needs_consent` (Seedance face media): non-charging; resubmit the
 *    identical body with `consents.seedance` attesting the policy text, once.
 *  - Refusals (`classifyVideoQueueRefusal`): a refunded
 *    `provider_content_policy` is resubmitted exactly once; a second
 *    refusal, an unrefunded one, or a face-screening 422 is `refused`.
 *  - Anything else is `fail`. A 5xx is never resubmitted: Venice may have
 *    queued and billed the job before the error reached the caller.
 *
 * `log` is what the CLI prints for the decision, in order.
 */
export function nextVideoQueueAttempt<T extends object>(
  state: VideoQueueAttemptState<T>,
  failure: VideoQueueFailure,
): VideoQueueAttemptDecision<T> {
  if (isNeedsConsentError(failure.status, failure.body) && !state.consented) {
    return {
      kind: 'resubmit',
      reason: 'needs-consent',
      state: { ...state, body: withSeedanceFaceConsent(state.body), consented: true },
      log: [{ level: 'info', message: '  Seedance face consent requested (409 needs_consent) — resubmitting with attestation.' }],
    };
  }

  const refusal = classifyVideoQueueRefusal({
    status: failure.status,
    message: failure.message,
    body: failure.body,
    model: state.model,
    requestBody: state.body as unknown as Record<string, unknown>,
    priorRefusals: state.refusals,
  });
  if (refusal) {
    if (refusal.retryable) {
      return {
        kind: 'resubmit',
        reason: 'refunded-refusal',
        state: { ...state, refusals: state.refusals + 1 },
        refusal,
        log: [{ level: 'warn', message: `  ⚠ ${refusal.message}` }],
      };
    }
    return { kind: 'refused', refusal, log: [{ level: 'error', message: `  ✖ ${refusal.message}` }] };
  }

  return {
    kind: 'fail',
    log: [
      { level: 'error', message: `  Venice queue error${state.consented ? ' after consent' : ''} (HTTP ${failure.status}): ${failure.message}` },
      { level: 'error', message: `  Error body: ${JSON.stringify(failure.body, null, 2)}` },
    ],
  };
}
