// ---------------------------------------------------------------------------
// Logger over the console, the way the CLI already reports: info to stdout,
// warnings and errors to stderr, progress to the ambient operation's sink
// (the shell's status line). `debug` prints only under VENICE_VIDEO_DEBUG=1,
// the flag the CLI already uses for stack traces.
// ---------------------------------------------------------------------------

import type { Logger } from 'venice-video-harness/core/ports.js';
import { reportProgress } from '../venice/operation-context.js';

export interface CliLoggerOptions {
  /** Print `debug` lines. Default: `process.env.VENICE_VIDEO_DEBUG === '1'`. */
  debug?: boolean;
  /** Where lines go. Default: `console`. */
  console?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export function createCliLogger(options: CliLoggerOptions = {}): Logger {
  const out = options.console ?? console;
  const debug = options.debug ?? process.env.VENICE_VIDEO_DEBUG === '1';
  return {
    debug: (message, ...details) => { if (debug) out.log(message, ...details); },
    info: (message, ...details) => out.log(message, ...details),
    warn: (message, ...details) => out.warn(message, ...details),
    error: (message, ...details) => out.error(message, ...details),
    progress: update => reportProgress(update),
  };
}
