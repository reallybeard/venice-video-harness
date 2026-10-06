// ---------------------------------------------------------------------------
// Panel approval binding.
//
// `qa-approve` used to write `{ episode, approvedAt, notes }` and
// `generate-videos` checked only that the file existed. Nothing tied the
// approval to the panels a human actually looked at: regenerate a panel
// (storyboard-episode --force, fix-panel, a hand edit), change the shot's
// description or the image model, and the stale approval still unblocked a
// billed render of something nobody reviewed.
//
// Now the approval records, per shot, (a) a sha256 of the panel file's bytes
// and (b) a digest of the settings the panel depends on: the image prompt the
// shot would produce today, the reference images it would use, and the image
// models. `generate-videos` recomputes both and refuses any shot that no
// longer matches, naming what changed and the command to re-approve.
//
// The pure half (shapes, canonical JSON, `compareApproval`, `checkApproval`,
// `panelSettingsFrom`) lives in core (`venice-video-harness/core/mini-drama/
// panel-approval.js`) so a browser host can reuse it with its own storage and
// hash. This module supplies sha256 and the disk reads, behind the same
// exports as before (`settingsDigest`, `approvalForShot`, `verifyApproval`).
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApprovalBinding, SeriesState, ShotScript } from 'venice-video-harness/core/series/types.js';
import { getCharacterDir, getLocation, getLocationDir } from '../series/manager.js';
import { buildImagePrompt } from './prompt-builder.js';
import { panelFileForShot, shotKey } from './shot-paths.js';
import {
  CHARACTER_REF_ORDER,
  LOCATION_REF_ORDER,
  checkApproval,
  panelSettingsFrom,
  settingsDigestWith,
  shotIdOf,
  type ApprovalArtifact,
  type ApprovalCheck,
  type PanelSettings,
  type ShotApproval,
} from 'venice-video-harness/core/mini-drama/panel-approval.js';

export type {
  ApprovalArtifact,
  ApprovalCheck,
  ApprovalMismatch,
  PanelSettings,
  ShotApproval,
} from 'venice-video-harness/core/mini-drama/panel-approval.js';
export type { ApprovalBinding };
export {
  CHARACTER_REF_ORDER,
  LOCATION_REF_ORDER,
  canonicalJson,
  checkApproval,
  compareApproval,
  describeMismatch,
  panelLocationNote,
  panelSettingsFrom,
  settingsDigestWith,
  shotIdOf,
} from 'venice-video-harness/core/mini-drama/panel-approval.js';

// ---- Pure --------------------------------------------------------------------

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function settingsDigest(settings: PanelSettings): string {
  return settingsDigestWith(settings, sha256Hex);
}

// ---- Disk-backed -------------------------------------------------------------

function relativeTo(root: string, path: string): string {
  return path.startsWith(root) ? path.slice(root.length).replace(/^[/\\]/, '') : path;
}

/**
 * The settings a shot's panel depends on, computed from the live script and
 * series. Mirrors what `storyboard-episode` feeds the image call: the image
 * prompt (aesthetic, description, blocking, wardrobe, environment), the
 * location note, the character / location references that exist on disk, and
 * the image models.
 */
export function panelSettingsForShot(series: SeriesState, shot: ShotScript): PanelSettings {
  const referenceImages: string[] = [];
  for (const name of shot.characters) {
    const char = series.characters.find(c => c.name.toUpperCase() === name.toUpperCase());
    if (!char) continue;
    const dir = getCharacterDir(series, char.name);
    const ref = CHARACTER_REF_ORDER.map(f => join(dir, f)).find(p => existsSync(p));
    if (ref) referenceImages.push(relativeTo(series.outputDir, ref));
  }
  const location = shot.location ? getLocation(series, shot.location) : undefined;
  if (location) {
    const dir = getLocationDir(series, location.slug);
    const ref = LOCATION_REF_ORDER.map(f => join(dir, f)).find(p => existsSync(p));
    if (ref) referenceImages.push(relativeTo(series.outputDir, ref));
  }

  return panelSettingsFrom({ series, shot, imagePrompt: buildImagePrompt(shot, series), location, referenceImages });
}

export function panelSha256(panelPath: string): string | undefined {
  if (!existsSync(panelPath)) return undefined;
  return sha256Hex(readFileSync(panelPath));
}

/** The binding to record for one shot at approval time. `undefined` when the panel is missing. */
export function approvalForShot(series: SeriesState, shot: ShotScript, panelDir: string): ShotApproval | undefined {
  const hash = panelSha256(panelFileForShot(panelDir, shotIdOf(shot)));
  if (!hash) return undefined;
  return { panelSha256: hash, settingsDigest: settingsDigest(panelSettingsForShot(series, shot)) };
}

/**
 * Check every shot against the recorded approval. Returns only the shots that
 * do not match. An artifact with no `shots` map (written before this binding
 * existed) reports every shot as `not-recorded`.
 */
export function verifyApproval(
  artifact: ApprovalArtifact,
  series: SeriesState,
  shots: ShotScript[],
  panelDir: string,
): ApprovalCheck[] {
  return checkApproval(artifact, shots.map(shot => ({
    shotKey: shotKey(shotIdOf(shot)),
    shotNumber: shot.shotNumber,
    panelSha256: panelSha256(panelFileForShot(panelDir, shotIdOf(shot))),
    settingsDigest: settingsDigest(panelSettingsForShot(series, shot)),
  })));
}
