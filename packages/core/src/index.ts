// ---------------------------------------------------------------------------
// @venice-video-harness/core -- the pure half of the harness.
//
// Plain data in, plain data out. Nothing in this package touches the
// filesystem, the network, `process.env`, `Buffer`, ffmpeg or `sharp`;
// `tests/core-purity.test.mjs` enforces that. It runs in Node and in a
// browser bundler with no polyfills. The CLI imports from here; a browser app
// imports the same code via the `venice-video-harness/core` subpath.
//
// Subpath entries (`@venice-video-harness/core/venice/models` etc.) keep the
// original module boundaries for callers that want them; this barrel is the
// flat surface.
// ---------------------------------------------------------------------------

// Model registry: specs, capability predicates, request validation, prompt budgets.
export * from './venice/models.js';

// Venice wire types. `VideoElement` here is the snake_case request shape;
// the camelCase series-side shape of the same name is exported from
// series/types below, so the wire one is aliased in the barrel.
export type {
  InitImageMode,
  ImageGenerateRequest,
  GeneratedImage,
  ImageGenerateResponse,
  ImageEditRequest,
  ImageEditResponse,
  MultiEditModel,
  MultiEditRequest,
  ImageUpscaleRequest,
  BackgroundRemoveRequest,
  VideoQueueRequest,
  VideoQueueResponse,
  VideoRetrieveRequest,
  VideoRetrieveStatus,
  VideoQuoteRequest,
  VideoQuoteResponse,
  VideoCompleteRequest,
  SpeechRequest,
  AudioQueueRequest,
  AudioQueueResponse,
  AudioRetrieveRequest,
  AudioRetrieveStatus,
  CharacterReference,
  GenerateWithReferencesOptions,
  GenerateWithReferencesResult,
  VeniceApiError,
  SeedanceFaceConsent,
  VideoQueueConsents,
  VideoElement as VideoElementRequest,
} from './venice/types.js';

// /video/queue: request-body builders (every input already a URL / data: URI),
// the faces-off decision, refusal classification and retrieve-status verdicts.
export * from './venice/request-builder.js';
export * from './venice/faces-off.js';
export * from './venice/refusal.js';
export * from './venice/retrieve-status.js';

// Text / intelligence model catalogue.
export * from './venice/text-models.js';

// Silent-reject detection (byte-size thresholds by resolution).
export * from './venice/rejection.js';

// JSON extraction from chat replies (the pure half of chatJson).
export * from './venice/json-block.js';

// Capabilities manifest for downstream apps (version passed in by the host).
export * from './venice/capabilities-manifest.js';

// The series schema: SeriesState, EpisodeScript, ShotScript, defaults, capability sets.
export * from './series/types.js';
// ReferenceSet: the images a shot may reference, as data (CLI: paths; browser: asset ids).
export * from './series/references.js';
export * from './series/duration.js';
export * from './series/dialogue.js';
export * from './series/project-language.js';

// Agent-facing pipeline description and guide text.
export * from './agent/pipeline.js';
export * from './agent/guide.js';

// Wizard / stream choice tables.
export * from './mini-drama/choices.js';
export * from './mini-drama/stream-choices.js';

// Generation planning: units, multi-shot grouping, montage scenes and beats.
export * from './mini-drama/generation-planner.js';
export * from './mini-drama/montage.js';
export * from './mini-drama/duration-preflight.js';
export * from './mini-drama/shot-paths.js';
// Music-cue placement and volume-automation expressions (rendering stays in the CLI).
export * from './mini-drama/music-cues.js';
// QA: storyboard panel rubric + report, post-render video QA rubrics +
// report, and the panel approval binding (hash supplied by the host).
export * from './mini-drama/storyboard-qa.js';
export * from './mini-drama/video-qa.js';
export * from './mini-drama/panel-approval.js';
// Prompt building: the @ImageN reference slot planner and the image / video /
// multi-shot / montage prompt builders. The ones that cite references take the
// shot's ReferenceSet (or a function building one); the CLI builds it from disk.
export * from './series/locations.js';
export * from './mini-drama/reference-slots.js';
export * from './mini-drama/prompt-builder.js';
// Ports: the host interfaces core's loop runs over (CLI: src/ports/createCliPorts).
export * from './ports.js';
// Pipeline status: the report shapes, the pasteable-command helper, the text rendering.
export * from './session/status.js';
// The video render job lifecycle over the VideoBackend / Clock / Logger ports:
// re-attach or queue once, poll by policy, store, complete (rule 43).
export * from './venice/video-errors.js';
export * from './venice/render-job.js';
