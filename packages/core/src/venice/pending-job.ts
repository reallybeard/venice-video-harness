// ---------------------------------------------------------------------------
// The pending-job record (rule 43) -- pure. What a queued render records so an
// interrupted run re-attaches instead of paying again, and when a record is
// too old to re-attach to. Storing records is the host's (the CLI:
// src/venice/job-store.ts, pending-jobs.json in the config dir).
// ---------------------------------------------------------------------------

export type PendingJobKind = 'video' | 'audio';

/** What every host records for a queued job; the key it is stored under is the host's. */
export interface PendingJobRecord {
  kind: PendingJobKind;
  /** Venice model that owns the queue entry -- /retrieve needs it alongside the id. */
  model: string;
  queueId: string;
  /** Project directory, when the job belongs to a series. */
  project?: string;
  episode?: number;
  /** Truncated prompt, purely so `queue` output is recognisable. */
  prompt?: string;
  createdAt: string;
  /** Bumped on each successful poll so stale entries are identifiable. */
  updatedAt: string;
}

/** The CLI's record in `pending-jobs.json`. */
export interface PendingJob extends PendingJobRecord {
  /** Absolute path the media will be written to. Doubles as the registry key. */
  outputPath: string;
  /** PID that queued the job; a different live PID means someone else owns it. */
  pid: number;
}

/** Jobs older than this are assumed dead -- Venice's own queue TTL is shorter. */
export const PENDING_JOB_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** How much of the prompt a record keeps. */
export const PENDING_JOB_PROMPT_MAX_CHARS = 240;

/** The prompt as a record keeps it: its first 240 characters, or nothing for an empty one. */
export function pendingJobPrompt(prompt: string | undefined): string | undefined {
  return prompt ? prompt.slice(0, PENDING_JOB_PROMPT_MAX_CHARS) : undefined;
}

/** True when the record's heartbeat is older than the queue TTL at `now` (epoch ms). */
export function isStalePendingJob(job: Pick<PendingJobRecord, 'updatedAt'>, now: number): boolean {
  return now - Date.parse(job.updatedAt) > PENDING_JOB_STALE_AFTER_MS;
}
