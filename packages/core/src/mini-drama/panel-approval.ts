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

import type { ApprovalBinding, Location, SeriesState, ShotScript } from '../series/types.js';
import { DEFAULT_IMAGE_EDIT_MODEL, DEFAULT_IMAGE_GENERATION_MODEL } from '../series/types.js';

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

/**
 * The settings digest: `hash` over the canonical JSON. The CLI passes
 * sha256-hex; any host that records approvals must pass the same function or
 * its digests will not match the CLI's.
 */
export function settingsDigestWith(settings: PanelSettings, hash: (canonical: string) => string): string {
  return hash(canonicalJson(settings));
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

/**
 * Whether an approval counts toward the render gate: storyboard QA cleared
 * the shot (no critical flag, actually read), or the approval was forced past
 * QA. Freshness is `compareApproval`'s question, not this one.
 */
export function approvalCounts(binding: Pick<ApprovalBinding, 'force'> | undefined, qaCleared: boolean): boolean {
  if (!binding) return false;
  return qaCleared || binding.force === true;
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

/** The location sentence folded into the panel prompt, as `storyboard-episode` writes it. */
export function panelLocationNote(location: Location): string {
  return ` Location: ${location.description}`
    + (location.lightingNotes ? ` Lighting: ${location.lightingNotes}.` : '')
    + (location.spatialAnchors ? ` Fixed layout (never rearrange): ${location.spatialAnchors}.` : '');
}

/**
 * Shape a shot's `PanelSettings` from what the host has already resolved: the
 * image prompt (`buildImagePrompt`), the shot's location when it has one, and
 * the project-relative reference images that exist in its storage, in
 * `CHARACTER_REF_ORDER` / `LOCATION_REF_ORDER` precedence.
 */
export function panelSettingsFrom(input: {
  series: SeriesState;
  shot: ShotScript;
  imagePrompt: { prompt: string; negativePrompt?: string; seed?: number };
  location?: Location;
  referenceImages: string[];
}): PanelSettings {
  const { series, shot, imagePrompt, location, referenceImages } = input;
  const locationNote = location ? panelLocationNote(location) : '';
  return {
    prompt: imagePrompt.prompt + locationNote,
    negativePrompt: imagePrompt.negativePrompt,
    seed: imagePrompt.seed,
    generationModel: series.videoDefaults.imageDefaults?.generationModel ?? DEFAULT_IMAGE_GENERATION_MODEL,
    editModel: series.videoDefaults.imageDefaults?.editModel ?? DEFAULT_IMAGE_EDIT_MODEL,
    aspectRatio: series.storyboardAspectRatio ?? '16:9',
    referenceImages,
    sceneImagePaths: shot.sceneImagePaths,
    sceneRefDescription: shot.sceneRefDescription,
    skipRefine: shot.skipRefine,
  };
}

/**
 * Check every shot against the recorded approval, given each shot's current
 * panel hash and settings digest. Returns only the shots that do not match.
 * An artifact with no `shots` map (written before this binding existed)
 * reports every shot as `not-recorded`.
 */
export function checkApproval(
  artifact: ApprovalArtifact,
  current: ReadonlyArray<{ shotKey: string; shotNumber: number; panelSha256?: string; settingsDigest: string }>,
): ApprovalCheck[] {
  const out: ApprovalCheck[] = [];
  for (const shot of current) {
    const mismatches = compareApproval(artifact.shots?.[shot.shotKey], {
      panelSha256: shot.panelSha256,
      settingsDigest: shot.settingsDigest,
    });
    if (mismatches.length > 0) out.push({ shotKey: shot.shotKey, shotNumber: shot.shotNumber, mismatches });
  }
  return out;
}
