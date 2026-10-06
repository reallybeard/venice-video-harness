// ---------------------------------------------------------------------------
// Pipeline gates -- the CLI's half: read the gate facts from disk, and print a
// block or an advisory the way each command always has.
//
// The decision (`gateFor`) is pure and lives in core (`venice-video-harness/
// core/session/gates.js`). The commands and `collectProjectFacts` both read
// their facts through the readers here, so `status` sees exactly what the
// command it suggests will see.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SeriesState, ShotScript } from 'venice-video-harness/core/series/types.js';
import {
  GATE_REMEDY_COMMANDS,
  addCharacterValues,
  fillCommand,
  missingReferences,
  stageCommandTemplate,
  type EpisodeGateFacts,
  type GateBlock,
  type GatePass,
  type MissingReferences,
} from 'venice-video-harness/core/session/gates.js';
import { describeMismatch, verifyApproval, type ApprovalArtifact } from '../mini-drama/panel-approval.js';
import { getCharacterDir, getLocationDir } from '../series/manager.js';

export type {
  ArtifactParseError,
  EpisodeGateFacts,
  GateBlock,
  GateBlockKind,
  GateBlockReason,
  GateFacts,
  GateOptions,
  GatePass,
  GateRemedy,
  GateRemedyAction,
  GateResult,
  MissingCharacterReference,
  MissingReferences,
  ReferenceProbe,
} from 'venice-video-harness/core/session/gates.js';
export {
  GATED_STAGES,
  GATE_REMEDY_COMMANDS,
  STORYBOARD_CHARACTER_SHEETS,
  STORYBOARD_LOCATION_PLATES,
  addCharacterValues,
  fillCommand,
  gateFor,
  missingReferences,
  scriptApproved,
  stageCommandTemplate,
} from 'venice-video-harness/core/session/gates.js';

// ---- Facts from disk ---------------------------------------------------------

/** Rule 54 over the files on disk: the characters / locations of `shots` with no reference image. */
export function missingReferencesOnDisk(series: SeriesState, shots: ReadonlyArray<Pick<ShotScript, 'characters' | 'location'>>): MissingReferences {
  return missingReferences(series, shots, (entity, files) => {
    const dir = entity.kind === 'character' ? getCharacterDir(series, entity.name) : getLocationDir(series, entity.slug);
    return files.some(f => existsSync(join(dir, f)));
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * qa-report.json's gate facts. A file that does not parse (or parses to
 * something without fields) is a `parseError`; a filesystem error is thrown,
 * as `qa-approve` has always let it be.
 */
export function readQaReportFacts(path: string): EpisodeGateFacts['qaReport'] {
  try {
    const report = JSON.parse(readFileSync(path, 'utf-8')) as {
      summary?: { flagCritical?: number; errored?: number };
      results?: unknown;
    };
    return { summary: report.summary, criticalShots: criticalShots(report.results) };
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in (err as NodeJS.ErrnoException)) throw err;
    return { parseError: errorMessage(err) };
  }
}

function criticalShots(results: unknown): number[] {
  if (!Array.isArray(results)) return [];
  return results
    .filter((r): r is { shotNumber: number } => Boolean(r) && r.verdict === 'FLAG-CRITICAL' && typeof r.shotNumber === 'number')
    .map(r => r.shotNumber);
}

/**
 * qa-approved.json's gate facts: the shots whose panel or settings no longer
 * match the approval (rule 63), or a `parseError` when it does not read.
 * Hashes every panel; throws what `verifyApproval` throws.
 */
export function readApprovalFacts(path: string, series: SeriesState, shots: ShotScript[], panelDir: string): EpisodeGateFacts['approval'] {
  let artifact: ApprovalArtifact;
  try {
    artifact = JSON.parse(readFileSync(path, 'utf-8')) as ApprovalArtifact;
  } catch (err) {
    return { parseError: errorMessage(err) };
  }
  const stale = verifyApproval(artifact, series, shots, panelDir);
  return { approvedAt: artifact.approvedAt, stale };
}

/** video-qa-report.json's gate facts; any read or parse failure is a `parseError` (treated as missing). */
export function readVideoQaFacts(path: string): EpisodeGateFacts['videoQaReport'] {
  try {
    const report = JSON.parse(readFileSync(path, 'utf-8')) as { summary?: { passed?: boolean; criticals?: number } } | null;
    return { summary: report?.summary };
  } catch (err) {
    return { parseError: errorMessage(err) };
  }
}

// ---- What the commands print -------------------------------------------------

export interface GateMessageContext {
  /** `series.outputDir`, as the commands print it. */
  project: string;
  episode: number;
  episodeDir: string;
}

/** The stderr lines a command prints when its gate blocks. */
export function gateBlockLines(block: GateBlock, ctx: GateMessageContext): string[] {
  const stage = (id: string) => fillCommand(stageCommandTemplate(id), { project: ctx.project, episode: ctx.episode });
  const reason = block.reason;
  switch (reason.kind) {
    case 'script-not-approved':
      return [
        'Blocked: the script has not been approved, and approval is a human decision.',
        `  Clear it with:  ${stage('approve-script')}`,
        '  --skip-approval only bypasses this check; it does not approve the script and is not the fix.',
      ];
    case 'references-missing':
      return [
        'Blocked: reference images are missing. Storyboarding without them wastes a full render pass.',
        ...reason.characters.flatMap(c => [
          `  Character ${c.name}: no reference sheet. Generate with:`,
          `    ${fillCommand(GATE_REMEDY_COMMANDS['add-character'], { project: ctx.project, values: addCharacterValues(c) })}`,
        ]),
        ...reason.locations.flatMap(slug => [
          `  Location ${slug}: no reference angles. Generate with:`,
          `    ${fillCommand(GATE_REMEDY_COMMANDS['generate-location-references'], { project: ctx.project, values: { slug } })}`,
        ]),
        '  Then re-run this command.',
      ];
    case 'qa-report-missing':
      return [
        'Blocked: no qa-report.json — run qa-storyboard before qa-approve.',
        `  Run:  ${stage('qa-storyboard')}`,
      ];
    case 'qa-report-unreadable':
      return [`Blocked: qa-report.json could not be parsed (${reason.error}). Re-run qa-storyboard.`];
    case 'qa-issues':
      return [
        `Blocked: the latest QA report has ${reason.criticalCount} critical issue(s) and ${reason.uncheckedCount} unchecked shot(s).`,
        '  Approving unread or failing panels renders money into known defects.',
        '  Fix panels (fix-panel) or re-run QA (qa-storyboard), then approve.',
        '  If you have reviewed the panels yourself and accept them, re-run with --force.',
      ];
    case 'qa-not-approved':
      return [
        'Blocked: rendering is billed at queue time and the QA gate has not been cleared by a human.',
        `  Review:  ${stage('qa-storyboard')}`,
        `  Clear it with:  ${stage('qa-approve')}`,
        '  --skip-qa only bypasses this check; it does not clear QA and is not the fix.',
      ];
    case 'approval-unreadable':
      return [`Blocked: ${join(ctx.episodeDir, 'qa-approved.json')} could not be parsed. Re-run qa-approve.`];
    case 'approval-stale':
      return [
        `Blocked: ${reason.stale.length} shot(s) changed after QA approval (${reason.approvedAt}); a human has not reviewed what would be billed.`,
        ...reason.stale.map(s => `  shot ${s.shotKey}: ${s.mismatches.map(describeMismatch).join('; ')}`),
        `  Review the panels, then re-approve:  ${stage('qa-approve')}`,
        '  --skip-qa bypasses this check; it does not clear QA and is not the fix.',
      ];
    case 'video-qa-failed':
      return [
        `Blocked: video QA found ${reason.criticals ?? '?'} critical issue(s) in the rendered units.`,
        '  Assembling drifted or glitched units bakes the defects into the master.',
        `  Review: ${join(ctx.episodeDir, 'video-qa-report.json')}`,
        '  Fix the flagged units (or harvest-anchor + re-render), re-run qa-videos, then assemble.',
        '  If you have reviewed the footage yourself and accept it, re-run with --skip-video-qa.',
      ];
  }
}

/** The warning lines for a gate that passes with an advisory. */
export function gateAdvisoryLines(pass: GatePass, ctx: GateMessageContext): string[] {
  switch (pass.advisory) {
    case 'video-qa-missing':
      return [
        '⚠ No video-qa-report.json — the rendered units have not been checked for cross-unit',
        `  identity drift or head glitches. Recommended: ${fillCommand(stageCommandTemplate('qa-videos'), { project: ctx.project, episode: ctx.episode })}`,
        '  Assembling anyway (a missing report only warns; a failing one blocks).',
      ];
    case 'video-qa-unreadable':
      return ['⚠ video-qa-report.json could not be parsed — treating as missing.'];
    default:
      return [];
  }
}

/** Print a block to stderr and exit 1, as every gated command does. */
export function exitBlocked(block: GateBlock, ctx: GateMessageContext): never {
  for (const line of gateBlockLines(block, ctx)) console.error(line);
  process.exit(1);
}
