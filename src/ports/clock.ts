import type { Clock } from 'venice-video-harness/core/ports.js';
import { abortableSleep } from '../venice/operation-context.js';

/** Wall clock. `sleep` is the poll loops' `abortableSleep`: it defaults to the ambient operation's signal. */
export function createCliClock(): Clock {
  return {
    now: () => new Date(),
    sleep: (ms, signal) => abortableSleep(ms, signal),
  };
}
