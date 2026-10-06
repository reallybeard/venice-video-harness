// ---------------------------------------------------------------------------
// Canonical shot-id path builders.
//
// Failure mode this prevents: assembly scripts keyed file lookups by unpadded
// shot ids (`"3"`, `"3b"`, `"3c"`, `"4"`) while dialogue files on disk are
// zero-padded (`dialogue-shot-003.mp3`, `dialogue-shot-003b.mp3`). Every
// `existsSync` returned false silently, the for-loop continued past every
// iteration, and the master shipped with the relevant narration missing.
//
// Fix: every harness path that depends on a shot id goes through this
// module. Numeric ids are zero-padded to 3 digits; suffix letters
// ("b", "c") are preserved as-is.
//
// Anti-pattern: ad-hoc template literals like
//   `dialogue-shot-${id}.mp3`
// are forbidden in new code — they bypass the padding contract.
// ---------------------------------------------------------------------------

export type ShotId = number | string;

/**
 * A timeline placement map keyed by shot id. The string keys are the
 * zero-padded form produced by `shotKey()` — numeric portion padded to 3
 * digits, suffix letters preserved as-is.
 */
export type PlacementMap = Record<string, { startSec: number; endSec: number }>;

/**
 * canonical shot-id key. Numeric portions are zero-padded to 3
 * digits; suffix letters ("b", "c", ...) are preserved as-is.
 *
 *   shotKey(3)       -> "003"
 *   shotKey("3b")    -> "003b"
 *   shotKey("002c")  -> "002c"
 *   shotKey("intro") -> "intro"  (unrecognized — passed through)
 */
export function shotKey(id: ShotId): string {
  if (typeof id === 'number') return String(id).padStart(3, '0');
  const match = id.match(/^(\d+)([a-zA-Z]*)$/);
  if (match) return String(match[1]).padStart(3, '0') + match[2];
  return id;
}
