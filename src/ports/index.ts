// ---------------------------------------------------------------------------
// The CLI's implementation of core's ports (`venice-video-harness/core/ports.js`):
// fs for references, ffmpeg/ffprobe for probing, VeniceClient for the vision
// judge and the video backend, the pending-job registry for re-attach.
//
// The Venice client is created on first use, so building the ports needs no
// API key; only a vision or video call does.
// ---------------------------------------------------------------------------

import type { HarnessPorts, Logger } from 'venice-video-harness/core/ports.js';
import { VeniceClient } from '../venice/client.js';
import { createCliClock } from './clock.js';
import { createCliImageProbe } from './image-probe.js';
import { createCliLogger, type CliLoggerOptions } from './logger.js';
import { createCliReferenceStore } from './reference-store.js';
import { createCliVideoBackend } from './video-backend.js';
import { createCliVisionJudge } from './vision-judge.js';

export interface CliPortsOptions {
  /** Use this client. Otherwise one is created on first use from `apiKey` / `VENICE_API_KEY`. */
  client?: VeniceClient;
  apiKey?: string;
  baseUrl?: string;
  /** Scratch dir for extracted frames when the caller names no destination. */
  framesDir?: string;
  /** Replace the console logger entirely. */
  logger?: Logger;
  /** Options for the default console logger. */
  logging?: CliLoggerOptions;
}

export function createCliPorts(options: CliPortsOptions = {}): HarnessPorts {
  let client = options.client;
  const getClient = (): VeniceClient => {
    client ??= new VeniceClient(options.apiKey, options.baseUrl);
    return client;
  };
  const logger = options.logger ?? createCliLogger(options.logging);

  return {
    references: createCliReferenceStore(),
    images: createCliImageProbe({ framesDir: options.framesDir }),
    vision: createCliVisionJudge(getClient),
    video: createCliVideoBackend(getClient, logger),
    clock: createCliClock(),
    logger,
  };
}

export { createCliClock } from './clock.js';
export { createCliImageProbe, type CliImageProbeOptions } from './image-probe.js';
export { createCliLogger, type CliLoggerOptions } from './logger.js';
export { createCliReferenceStore, CLI_IMAGE_DATA_URI_MIME } from './reference-store.js';
export { createCliVideoBackend } from './video-backend.js';
export { createCliVisionJudge } from './vision-judge.js';
export { withSignal } from './signal.js';
