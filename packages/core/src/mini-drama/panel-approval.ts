// ---------------------------------------------------------------------------
// Panel approval binding: the pure half.
//
// The approval artifact's shapes, the canonical serialisation the settings
// digest is taken over, and the comparison of a recorded binding against the
// current one. Hashing is the host's job: core takes no `node:crypto`, so the
// digest helpers here take a `hash` function, and `compareApproval` takes
// digests the host has already computed. src/mini-drama/panel-approval.ts
// supplies sha256 and the disk reads.
// ---------------------------------------------------------------------------

import type { ApprovalBinding, ShotScript } from '../series/types.js';

// ---- Shapes ----------------------------------------------------------------

/** The inputs a panel is a function of. Hashed into `settingsDigest`. */
export interface PanelSettings {
  prompt: string;
  negativePrompt?: string;
  seed?: number;
  generationModel: string;
  editModel: string;
  aspectRatio: string;
  /** Project-relative paths of the character / location references the panel would use. */
  referenceImages: string[];
  /** Extra per-shot inputs that change the panel without changing the prompt. */
  sceneImagePaths?: string[];
  sceneRefDescription?: string;
  skipRefine?: boolean;
}

/**
 * The per-shot binding stored in `qa-approved.json`. Same shape as
 * `ApprovalBinding` (shared with the take review); kept under the name #40
 * introduced so call sites and `qa-approved.json` readers are unchanged.
 */
export type ShotApproval = ApprovalBinding;

export interface ApprovalArtifact {
  episode: number;
  approvedAt: string;
  notes: string;
  /** Approver, when known (`$USER`), for the audit trail. */
  by?: string;
  /** Per-shot binding keyed by `shotKey` ("003", "003b"). Absent on artifacts written before this binding existed. */
  shots?: Record<string, ShotApproval>;
}

export type ApprovalMismatch =
  | { kind: 'panel-missing' }
  | { kind: 'panel-changed' }
  | { kind: 'settings-changed' }
  | { kind: 'not-recorded' };

export interface ApprovalCheck {
  shotKey: string;
  shotNumber: number;
  mismatches: ApprovalMismatch[];
}

// ---- Pure --------------------------------------------------------------------

/** Stable JSON: keys sorted, so two equal settings objects always hash alike. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Compare a recorded approval against the current panel hash + settings. Pure. */
export function compareApproval(
  recorded: ShotApproval | undefined,
  current: { panelSha256?: string; settingsDigest: string },
): ApprovalMismatch[] {
  if (!recorded) return [{ kind: 'not-recorded' }];
  const out: ApprovalMismatch[] = [];
  if (!current.panelSha256) out.push({ kind: 'panel-missing' });
  else if (current.panelSha256 !== recorded.panelSha256) out.push({ kind: 'panel-changed' });
  if (current.settingsDigest !== recorded.settingsDigest) out.push({ kind: 'settings-changed' });
  return out;
}

export const CHARACTER_REF_ORDER = ['anchor.png', 'front.png', 'three-quarter.png'];
export const LOCATION_REF_ORDER = ['north.png', 'south.png', 'east.png', 'west.png', 'wide.png', 'angle-2.png', 'angle-3.png', 'angle-4.png', 'medium.png', 'detail.png'];

export function shotIdOf(shot: ShotScript): string {
  return `${shot.shotNumber}${shot.shotIdSuffix ?? ''}`;
}

export function describeMismatch(m: ApprovalMismatch): string {
  switch (m.kind) {
    case 'panel-missing': return 'panel file is missing';
    case 'panel-changed': return 'panel was regenerated or edited after approval';
    case 'settings-changed': return 'prompt, references or image model changed after approval';
    case 'not-recorded': return 'approval predates per-shot binding (or shot was added after approval)';
  }
}
