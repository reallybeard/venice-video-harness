// ---------------------------------------------------------------------------
// Port calls take an explicit AbortSignal; the CLI's Venice client and poll
// loops read the ambient one (`operation-context.ts`). This bridges the two:
// a call given a signal runs with it as the ambient signal, keeping the rest
// of the surrounding operation (label, progress sink).
// ---------------------------------------------------------------------------

import { currentOperation, runInOperation, throwIfAborted } from '../venice/operation-context.js';

export async function withSignal<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  if (!signal) return fn();
  return runInOperation({ ...currentOperation(), signal }, async () => {
    throwIfAborted();
    return fn();
  });
}
