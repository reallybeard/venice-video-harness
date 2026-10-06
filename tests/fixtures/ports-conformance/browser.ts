// Type-level conformance: a host with only web APIs (no @types/node, lib
// ES2022 + DOM) can implement every port. If a port signature ever names a
// Node type (Buffer, NodeJS.*), this stops compiling.
// Compiled (never run) by tests/core-ports-conformance.test.mjs.

import type { HarnessPorts, VideoJobHandle } from 'venice-video-harness/core/ports.js';
import type { ReferenceSet } from 'venice-video-harness/core/series/references.js';

const assets = new Map<string, Blob>();
const pending = new Map<string, VideoJobHandle>();

async function blobBytes(ref: string): Promise<Uint8Array> {
  const blob = assets.get(ref);
  if (!blob) throw new Error(`no asset ${ref}`);
  return new Uint8Array(await blob.arrayBuffer());
}

export const browserPorts: HarnessPorts = {
  references: {
    async referenceSet(): Promise<ReferenceSet> {
      return { characters: [], locations: [] };
    },
    async read(ref) {
      const bytes = await blobBytes(ref);
      return { bytes, mimeType: assets.get(ref)?.type ?? 'application/octet-stream' };
    },
    async url(ref) {
      return URL.createObjectURL(assets.get(ref)!);
    },
  },
  images: {
    async imageInfo(ref) {
      const bitmap = await createImageBitmap(assets.get(ref)!);
      return { width: bitmap.width, height: bitmap.height };
    },
    async clipDuration() { return 0; },
    async extractFrame(clip, _position, options) { return options?.outputRef ?? `${clip}#frame`; },
    async frameLumas() { return []; },
  },
  vision: {
    async judge<T>(request: { model: string; signal?: AbortSignal }): Promise<T> {
      const res = await fetch('https://api.venice.ai/api/v1/chat/completions', {
        method: 'POST', body: JSON.stringify({ model: request.model }), signal: request.signal,
      });
      return (await res.json()) as T;
    },
  },
  video: {
    async quote() { return { quote: 0 }; },
    async findPending(outputKey) { return pending.get(outputKey); },
    async resume(handle) { return { ...handle, resumed: true }; },
    async queue(request, target) {
      const handle: VideoJobHandle = {
        outputKey: target.outputKey, model: request.model, queueId: 'q', queuedAt: new Date().toISOString(), resumed: false,
      };
      pending.set(target.outputKey, handle);
      return handle;
    },
    async retrieve() { return { kind: 'ready', bytes: new Uint8Array(0), contentType: 'video/mp4' }; },
    async download(handle, media) {
      assets.set(handle.outputKey, new Blob([media.bytes as Uint8Array<ArrayBuffer>], { type: 'video/mp4' }));
      pending.delete(handle.outputKey);
      return { ref: handle.outputKey, sizeBytes: media.bytes.byteLength };
    },
    async complete() {},
    async clearPending(outputKey) { pending.delete(outputKey); },
  },
  clock: {
    now: () => new Date(),
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
    }),
  },
  logger: {
    debug: (...a) => console.debug(...a),
    info: (...a) => console.info(...a),
    warn: (...a) => console.warn(...a),
    error: (...a) => console.error(...a),
  },
};
