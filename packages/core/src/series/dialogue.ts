// ---------------------------------------------------------------------------
// Dialogue lines.
//
// `ShotScript.dialogue` is `DialogueLine | DialogueLine[] | null`. Every
// consumer reads it through `dialogueLines(shot)` so a legacy single object,
// a list, and `null` all look the same downstream, and decides voice-over
// through `isVoiceOverLine(line)` so the NARRATOR / V.O. naming convention
// lives in exactly one place.
// ---------------------------------------------------------------------------

import type { DialogueLine } from './types.js';

/** Anything that carries a `dialogue` field in the ShotScript shape (a shot, a stream beat, a parsed script row). */
export type HasDialogue = { dialogue?: DialogueLine | DialogueLine[] | null };

/** Speaker names that mean voice-over when `voiceOver` is not set. */
export const VOICE_OVER_SPEAKERS: ReadonlySet<string> = new Set(['NARRATOR', 'V.O.', 'VO']);

/**
 * The shot's dialogue as a list: an object becomes a one-element list, `null`
 * (or a missing field) becomes `[]`, a list is returned as-is. Never mutates
 * the shot.
 */
export function dialogueLines(
  shot: HasDialogue,
): DialogueLine[] {
  const d = shot.dialogue;
  if (!d) return [];
  return Array.isArray(d) ? d : [d];
}

/**
 * The first line on the shot, or `undefined` when it has none. For a single
 * object this is that object; for a list it is element 0. Convenience for
 * callers that only ever want "the" line (subtitle timing, log labels).
 */
export function firstDialogueLine(
  shot: HasDialogue,
): DialogueLine | undefined {
  return dialogueLines(shot)[0];
}

/**
 * True when this line is voice-over: no on-camera speaker, so the line must
 * never reach the video prompt. An explicit `voiceOver` wins; otherwise the
 * speaker name decides (`NARRATOR`, `V.O.`, `VO`, case-insensitive).
 */
export function isVoiceOverLine(line: DialogueLine): boolean {
  if (typeof line.voiceOver === 'boolean') return line.voiceOver;
  return VOICE_OVER_SPEAKERS.has(String(line.character ?? '').toUpperCase());
}

/** The shot's lines that are spoken on camera (not voice-over), in order. */
export function onCameraDialogueLines(
  shot: HasDialogue,
): DialogueLine[] {
  return dialogueLines(shot).filter(line => !isVoiceOverLine(line));
}
