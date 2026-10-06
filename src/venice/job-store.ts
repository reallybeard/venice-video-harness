// ---------------------------------------------------------------------------
// Pending-job registry -- makes paid Venice generations survive a crash.
//
// Venice video/audio generation is queue-then-poll: POST /queue returns a
// queue_id, then /retrieve is polled for up to ~30 minutes until the media
// comes back. The queue_id used to live only in a local variable, so anything
// that ended the process mid-poll (Ctrl-C, a crash, closing the terminal) threw
// away the only handle to a job Venice had already charged for and was still
// rendering.
//
// Every queue_id is now written here before the first poll and removed once the
// media lands, so an interrupted job can be re-attached instead of re-billed.
// ---------------------------------------------------------------------------

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getConfigDir } from '../user-config.js';
import {
  isStalePendingJob,
  pendingJobPrompt,
  type PendingJob,
} from 'venice-video-harness/core/venice/pending-job.js';

export {
  isStalePendingJob,
  PENDING_JOB_PROMPT_MAX_CHARS,
  PENDING_JOB_STALE_AFTER_MS,
  pendingJobPrompt,
} from 'venice-video-harness/core/venice/pending-job.js';
export type { PendingJob, PendingJobKind, PendingJobRecord } from 'venice-video-harness/core/venice/pending-job.js';

interface JobRegistry {
  version: 1;
  jobs: PendingJob[];
}

const EMPTY: JobRegistry = { version: 1, jobs: [] };

export function getJobStorePath(): string {
  return join(getConfigDir(), 'pending-jobs.json');
}

// All writes funnel through this chain. Within a process (notably the shell,
// which can run several generations concurrently) that turns read-modify-write
// into a serial queue. Cross-process races remain possible but are unlikely
// for a single-operator CLI, and the cost of losing an entry is one orphaned
// job rather than corrupted project state.
let writeChain: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => undefined);
  return run;
}

async function readRegistry(): Promise<JobRegistry> {
  try {
    const raw = await readFile(getJobStorePath(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as JobRegistry).jobs)) {
      return { ...EMPTY };
    }
    return parsed as JobRegistry;
  } catch {
    // A missing or unreadable registry is not worth failing a generation over.
    return { ...EMPTY };
  }
}

async function writeRegistry(registry: JobRegistry): Promise<void> {
  const path = getJobStorePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function mutate(fn: (jobs: PendingJob[]) => PendingJob[]): Promise<void> {
  await serialize(async () => {
    const registry = await readRegistry();
    await writeRegistry({ version: 1, jobs: fn(registry.jobs) });
  });
}

/**
 * Record a freshly queued job. Call this after /queue returns and before the
 * first /retrieve poll -- that gap is exactly where money gets lost.
 */
export async function recordPendingJob(
  job: Omit<PendingJob, 'createdAt' | 'updatedAt' | 'pid'>,
): Promise<void> {
  const now = new Date().toISOString();
  const entry: PendingJob = {
    ...job,
    prompt: pendingJobPrompt(job.prompt),
    createdAt: now,
    updatedAt: now,
    pid: process.pid,
  };
  await mutate(jobs => [...jobs.filter(j => j.outputPath !== entry.outputPath), entry]);
}

/** Refresh a job's heartbeat so age reflects the last successful poll. */
export async function touchPendingJob(outputPath: string): Promise<void> {
  const now = new Date().toISOString();
  await mutate(jobs =>
    jobs.map(j => (j.outputPath === outputPath ? { ...j, updatedAt: now } : j)),
  );
}

/** Drop a job once its media is on disk (or it has definitively failed). */
export async function clearPendingJob(outputPath: string): Promise<void> {
  await mutate(jobs => jobs.filter(j => j.outputPath !== outputPath));
}

export async function listPendingJobs(): Promise<PendingJob[]> {
  const { jobs } = await readRegistry();
  return jobs;
}

/**
 * Look up a resumable job for an output path. Returns nothing when the entry is
 * older than the queue TTL, since /retrieve would only 404.
 */
export async function findPendingJob(outputPath: string): Promise<PendingJob | undefined> {
  const jobs = await listPendingJobs();
  const match = jobs.find(j => j.outputPath === outputPath);
  if (!match) return undefined;
  if (isStale(match)) return undefined;
  return match;
}

export function isStale(job: PendingJob, now = Date.now()): boolean {
  return isStalePendingJob(job, now);
}

/** Remove entries too old for Venice to still be holding. Returns the count. */
export async function prunePendingJobs(): Promise<number> {
  const before = await listPendingJobs();
  const keep = before.filter(job => !isStale(job));
  if (keep.length !== before.length) {
    await mutate(() => keep);
  }
  return before.length - keep.length;
}
