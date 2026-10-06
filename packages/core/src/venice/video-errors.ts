// ---------------------------------------------------------------------------
// Video job errors -- pure. Plain data in, plain data out.
// ---------------------------------------------------------------------------

/**
 * Thrown when `/video/retrieve` reports that the job ended without a video.
 * Distinct from the poll timeout so callers (and humans reading logs) can tell
 * "Venice gave up on this job" from "we gave up waiting".
 */
export class VideoGenerationFailedError extends Error {
  public readonly model: string;
  public readonly queueId: string;
  public readonly status: string;
  public readonly body: unknown;

  constructor(model: string, queueId: string, status: string, body: unknown, detail?: string) {
    super(
      `Video generation ${status} for ${model} (${queueId})`
      + (detail ? `: ${detail}` : ''),
    );
    this.name = 'VideoGenerationFailedError';
    this.model = model;
    this.queueId = queueId;
    this.status = status;
    this.body = body;
  }
}
