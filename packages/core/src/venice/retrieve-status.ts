// ---------------------------------------------------------------------------
// `/video/retrieve` status classification -- pure. Plain data in, plain data out.
// ---------------------------------------------------------------------------

export type VideoRetrieveVerdict =
  | { kind: 'processing' }
  | { kind: 'failed'; status: string; detail?: string };

/**
 * Decide what a JSON `/video/retrieve` body means for the poll loop.
 *
 * Only `PROCESSING` keeps polling. Anything else is terminal: `FAILED`, an
 * `ERROR`, a status we have never seen. Before this, both poll loops
 * special-cased `PROCESSING` and otherwise just slept again, so a job that
 * failed on poll 2 was reported as a timeout 30 minutes later -- and the
 * pending-job record kept pointing at a dead queue id.
 *
 * A JSON `COMPLETED` is also terminal here: a finished job is delivered as
 * `video/mp4` bytes, so a JSON body claiming completion with no video is a
 * server-side anomaly we cannot recover from by polling again.
 */
export function classifyVideoRetrieveStatus(body: unknown): VideoRetrieveVerdict {
  const status = typeof (body as { status?: unknown } | null)?.status === 'string'
    ? ((body as { status: string }).status).toUpperCase()
    : '';
  if (status === 'PROCESSING') return { kind: 'processing' };

  const b = body as { error?: unknown; message?: unknown } | null | undefined;
  let detail: string | undefined;
  if (typeof b?.error === 'string') detail = b.error;
  else if (typeof (b?.error as { message?: unknown } | undefined)?.message === 'string') {
    detail = (b!.error as { message: string }).message;
  } else if (typeof b?.message === 'string') detail = b.message;

  return { kind: 'failed', status: status || 'UNKNOWN', detail };
}
