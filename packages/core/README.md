# @reallybeard/venice-video-harness-core

The pure core of [venice-video-harness](https://github.com/jordanurbs/venice-video-harness), published from the `reallybeard` fork's integration line so a browser app can depend on it without installing the CLI (sharp, commander, ffmpeg wrappers).

Everything here is plain data in, plain data out: the model registry and capability sets, the series schema, prompt and reference-slot builders, `/video/queue` request bodies, generation and music-cue planners, pipeline stages and gates, QA rubrics and verdict parsing, approval bindings, the port contracts a host implements, and the per-unit steps (`renderVideo`, `runVideoJob`, `resumeVideoJob`, storyboard and video QA steps). No Node APIs, no network, no filesystem; `tests/core-purity.test.mjs` in the harness repo enforces that.

```ts
import { buildVideoQueueRequest, classifyEpisode, gateFor } from '@reallybeard/venice-video-harness-core';
import type { HarnessPorts } from '@reallybeard/venice-video-harness-core/ports.js';
import { buildCapabilitiesManifest } from '@reallybeard/venice-video-harness-core/venice/capabilities-manifest.js';
```

This is an interim package. Versions are `<harness version>-web.<n>` and track the fork's `main`. When upstream publishes core under its own name, switch the import specifier and drop this.

MIT, as the harness.
