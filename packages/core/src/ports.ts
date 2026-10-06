// ---------------------------------------------------------------------------
// Ports: what core asks of its host.
//
// Core is plain data in, plain data out. The production loop still has to read
// reference images, probe clips, ask a vision model for a verdict and drive
// Venice's queue-then-poll video API. Each of those goes through an interface
// declared here; the host implements it in its own world:
//
//   CLI      fs + ffmpeg/ffprobe + VeniceClient   (`src/ports/`, createCliPorts)
//   browser  OPFS + canvas/WebCodecs + fetch      (the web app)
//
// Interfaces only, no implementation. Nothing here names a Node type: bytes
// are `Uint8Array`, media is an opaque `MediaRef` string, cancellation is the
// web-standard `AbortSignal`.
//
// Every method is async, including ones the CLI could answer synchronously:
// a browser host cannot (OPFS, image decode and fetch are all async).
// ---------------------------------------------------------------------------

// ---- Clock and Logger --------------------------------------------------------

/** A progress update for a long operation (mirrors the CLI shell's status line). */
export interface ProgressUpdate {
  /** Coarse stage, e.g. `'queue'`, `'poll'`, `'download'`. */
  phase: string;
  /** Human-readable detail, e.g. `'shot 3/12 PROCESSING 41s'`. */
  detail?: string;
  current?: number;
  total?: number;
}

export interface Logger {
  debug(message: string, ...details: unknown[]): void;
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
  progress?(update: ProgressUpdate): void;
}
