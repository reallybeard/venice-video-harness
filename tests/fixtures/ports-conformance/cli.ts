// Type-level conformance: the CLI adapters satisfy core's port interfaces.
// Compiled (never run) by tests/core-ports-conformance.test.mjs.

import type {
  Clock,
  HarnessPorts,
  ImageProbe,
  Logger,
  ReferenceStore,
  VideoBackend,
  VisionJudge,
} from 'venice-video-harness/core/ports.js';
import type { HarnessPorts as BarrelHarnessPorts } from 'venice-video-harness/core';
import {
  createCliClock,
  createCliImageProbe,
  createCliLogger,
  createCliPorts,
  createCliReferenceStore,
  createCliVideoBackend,
  createCliVisionJudge,
} from '../../../dist/ports/index.js';
import { createCliPorts as rootCreateCliPorts } from '../../../dist/index.js';
import type { VeniceClient } from '../../../dist/venice/client.js';

declare const client: () => VeniceClient;
const logger = createCliLogger();

export const ports: HarnessPorts = createCliPorts();
export const viaBarrel: BarrelHarnessPorts = rootCreateCliPorts();
export const references = createCliReferenceStore() satisfies ReferenceStore;
export const images = createCliImageProbe() satisfies ImageProbe;
export const vision = createCliVisionJudge(client) satisfies VisionJudge;
export const video = createCliVideoBackend(client, logger) satisfies VideoBackend;
export const clock = createCliClock() satisfies Clock;
export const log = logger satisfies Logger;
