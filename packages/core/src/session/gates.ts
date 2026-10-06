// ---------------------------------------------------------------------------
// Pipeline gates -- whether a stage may run, and what clears it when not.
//
// Four commands refuse to run until a condition holds: storyboard-episode
// (an approved script, rule 45, and a reference image for every scripted
// character and location, rule 54), qa-approve (a readable QA report with no
// criticals or unchecked shots, rule 55), generate-videos (a QA approval still
// bound to the panels on disk, rule 63) and assemble-episode (no failing video
// QA report, rule 52). `gateFor` is that decision, once: the commands call it
// to decide whether to block, and `classifyEpisode` calls it to decide what to
// suggest, so `status` can no longer point at a command that refuses to run.
//
// Facts in, decision out. The host reads the artifacts (the CLI from disk:
// `src/session/gates.ts`); a fact the host did not supply is not a reason to
// block, so a host that cannot read one gets the status it had before.
// ---------------------------------------------------------------------------

import { PIPELINE_STAGES } from '../agent/pipeline.js';
import { approvalCounts, type ApprovalCheck } from '../mini-drama/panel-approval.js';
import type { ApprovalBinding } from '../series/types.js';
import { storyboardApprovalBlock } from '../mini-drama/storyboard-qa.js';
import { videoQaBlocksAssembly } from '../mini-drama/video-qa.js';
import { getLocation } from '../series/locations.js';
import type { SeriesState, ShotScript } from '../series/types.js';
import type { EpisodeFacts, EpisodeStageId } from './status.js';

/**
 * The script-approval gate. `storyboard-episode` accepts either marker:
 * `approve-script` writes the artifact, `workshop --approve` only sets the
 * script's status (rule 45 — checking only the file told every
 * workshop-driven project to re-approve a script it had already shot).
 */
export function scriptApproved(facts: Pick<EpisodeFacts, 'scriptApprovalArtifact' | 'scriptStatusApproved'>): boolean {
  return facts.scriptApprovalArtifact || facts.scriptStatusApproved;
}

// ---- Facts -------------------------------------------------------------------

/** A scripted character with no reference sheet on disk. */
export interface MissingCharacterReference {
  /** The scripted name, upper-cased: the key the preflight dedupes on. */
  name: string;
  /** The cast entry it resolves to, when the series has one. */
  cast?: { name: string; gender?: string; age?: string };
}

/** What the rule-54 reference preflight found missing, in script order. */
export interface MissingReferences {
  characters: MissingCharacterReference[];
  /** Location slugs with no reference plate. Slugs the series does not define are skipped (a script problem). */
  locations: string[];
}

/** Why an artifact the host tried to read could not be used. */
export interface ArtifactParseError {
  parseError: string;
}

/**
 * Gate facts beyond the existence markers. Each is optional: absent means
 * "not checked", and an unchecked condition never blocks.
 */
export interface EpisodeGateFacts {
  /** Rule 54: scripted characters / locations with no reference image. */
  missingReferences?: MissingReferences;
  /** qa-report.json, when it exists: its summary and the shots flagged critical, or why it would not parse. */
  qaReport?: { summary?: { flagCritical?: number; errored?: number }; criticalShots?: number[] } | ArtifactParseError;
  /** qa-approved.json, when it exists, checked against the panels on disk (rule 63): the shots that no longer match. */
  approval?: { approvedAt?: string; stale: ApprovalCheck[] } | ArtifactParseError;
  /** video-qa-report.json, when it exists: its summary, or why it would not parse. */
  videoQaReport?: { summary?: { passed?: boolean; criticals?: number } } | ArtifactParseError;
  /**
   * Render, per approved shot: whether storyboard QA cleared it, and its
   * binding. A host that approves panel by panel supplies it, and a shot
   * counts only when QA cleared it or its approval was forced
   * (`approvalCounts`). The CLI leaves it out: its `qa-approve` gates the
   * whole report before it writes any binding. Absent: not checked.
   */
  approvedShots?: ReadonlyArray<{ shotKey: string; qaCleared: boolean; binding: Pick<ApprovalBinding, 'force'> }>;
}

/**
 * What `gateFor` reads. The episode number fills the remedy command; an
 * existence marker the host leaves out reads as absent (false).
 */
export type GateFacts = Pick<EpisodeFacts, 'episode'>
  & Partial<Pick<EpisodeFacts, 'scriptApprovalArtifact' | 'scriptStatusApproved' | 'qaReported' | 'qaApproved' | 'videoQaReported'>>
  & EpisodeGateFacts;

function parseFailed(value: object): value is ArtifactParseError {
  return 'parseError' in value;
}

// ---- Rule 54: the reference preflight ---------------------------------------

/**
 * The files `storyboard-episode` accepts as a character's reference sheet.
 * Not `anchor.png`, although AGENTS.md rule 54 says it should count: the gate
 * and the rule disagree, and the gate's behaviour is kept until that is decided.
 */
export const STORYBOARD_CHARACTER_SHEETS: readonly string[] = ['front.png', 'three-quarter.png'];

/** The files it accepts as a location's reference plate (the compass set, then the legacy names). */
export const STORYBOARD_LOCATION_PLATES: readonly string[] = [
  'north.png', 'south.png', 'east.png', 'west.png', 'wide.png', 'angle-2.png', 'angle-3.png', 'angle-4.png', 'medium.png', 'detail.png',
];

export type ReferenceProbe =
  | { kind: 'character'; name: string }
  | { kind: 'location'; slug: string };

/**
 * Which scripted characters and locations have no reference image (rule 54).
 * `hasAny(entity, files)` is the host's storage probe: true when any of
 * `files` exists for the entity (the CLI: under `getCharacterDir(series,
 * name)` / `getLocationDir(series, slug)`). Characters are probed by their
 * upper-cased scripted name, locations by the series slug.
 */
export function missingReferences(
  series: Pick<SeriesState, 'characters' | 'locations'>,
  shots: ReadonlyArray<Pick<ShotScript, 'characters' | 'location'>>,
  hasAny: (entity: ReferenceProbe, files: readonly string[]) => boolean,
): MissingReferences {
  const scriptedChars = [...new Set(shots.flatMap(s => s.characters.map(c => c.toUpperCase())))];
  const characters: MissingCharacterReference[] = [];
  for (const name of scriptedChars) {
    if (hasAny({ kind: 'character', name }, STORYBOARD_CHARACTER_SHEETS)) continue;
    const char = series.characters.find(c => c.name.toUpperCase() === name);
    characters.push(char ? { name, cast: { name: char.name, gender: char.gender, age: char.age } } : { name });
  }
  const scriptedLocs = [...new Set(shots.map(s => s.location).filter((l): l is string => Boolean(l)))];
  const locations = scriptedLocs.filter(slug => {
    const loc = getLocation(series as SeriesState, slug);
    if (!loc) return false;
    return !hasAny({ kind: 'location', slug: loc.slug }, STORYBOARD_LOCATION_PLATES);
  });
  return { characters, locations };
}

// ---- Remedies ----------------------------------------------------------------

/** Remedies that are not pipeline stages. Not in `PIPELINE_STAGES`, so `pipeline` does not list them. */
export type GateRemedyAction = 'add-character' | 'generate-location-references' | 'fix-panel' | 'harvest-anchor';

/** Their commands, in the pipeline table's notation: `-p <project>`, `-e <n>`, `<...>` to fill. */
export const GATE_REMEDY_COMMANDS: Readonly<Record<GateRemedyAction, string>> = {
  'add-character': 'add-character -p <project> --name "<NAME>" --gender <gender> --age "<age>" --description "..." --wardrobe "..."',
  'generate-location-references': 'generate-location-references -p <project> -l "<slug>"',
  'fix-panel': 'fix-panel -p <project> -e <n> -s <shot>',
  'harvest-anchor': 'harvest-anchor -p <project> -c <CHARACTER> --video <unit-master> --at <sec>',
};

/**
 * Fill a command template. With `project`, `<project>` takes it verbatim;
 * without, ` -p <project>` is dropped (the shell form `status` suggests).
 * `-e <n>` takes the episode; each `values` key replaces its `<key>`
 * placeholder, in one pass, so a filled value is never re-read as a
 * placeholder. Unfilled placeholders stay, as in the pipeline table.
 */
export function fillCommand(
  template: string,
  fill: { project?: string; episode?: number; values?: Readonly<Record<string, string>> } = {},
): string {
  let out = fill.project === undefined ? template.split(' -p <project>').join('') : template;
  if (fill.episode !== undefined) out = out.split('-e <n>').join(`-e ${fill.episode}`);
  const values: Record<string, string> = { ...fill.values };
  if (fill.project !== undefined) values.project = fill.project;
  return out.replace(/<([^<>]+)>/g, (placeholder, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : placeholder);
}

/** A pipeline stage's command template (`-p <project>` form). Throws for an id the table lacks. */
export function stageCommandTemplate(stageId: string): string {
  const stage = PIPELINE_STAGES.find(s => s.id === stageId);
  if (!stage) throw new Error(`pipeline stage "${stageId}" is not in PIPELINE_STAGES`);
  return stage.command;
}

/** The fill values of the `add-character` remedy for a missing character. */
export function addCharacterValues(missing: MissingCharacterReference): Record<string, string> {
  return { NAME: missing.cast?.name ?? missing.name, gender: missing.cast?.gender ?? '<gender>', age: missing.cast?.age ?? '<age>' };
}

// ---- The gate ----------------------------------------------------------------

export type GateBlockReason =
  | { kind: 'script-not-approved' }
  | ({ kind: 'references-missing' } & MissingReferences)
  | { kind: 'qa-report-missing' }
  | { kind: 'qa-report-unreadable'; error: string }
  | { kind: 'qa-issues'; criticalCount: number; uncheckedCount: number; criticalShots: number[] }
  | { kind: 'qa-not-approved' }
  | { kind: 'approval-unreadable'; error: string }
  | { kind: 'approval-stale'; approvedAt?: string; stale: ApprovalCheck[] }
  /** Approved shots that QA did not clear and whose approval was not forced (shot keys). */
  | { kind: 'approval-not-cleared'; shots: string[] }
  | { kind: 'video-qa-failed'; criticals?: number };

export type GateBlockKind = GateBlockReason['kind'];

/** What clears a block: a pipeline stage to re-run, or a remedy action, as a shell-form command (`-e` filled, no `-p`). */
export interface GateRemedy {
  stageId?: EpisodeStageId;
  action?: GateRemedyAction;
  command: string;
}

/** A gate that passes. `advisory` is a condition worth a warning that does not block. */
export interface GatePass {
  blocked: false;
  advisory?: 'video-qa-missing' | 'video-qa-unreadable';
}

export interface GateBlock {
  blocked: true;
  reason: GateBlockReason;
  /** Short human summary, e.g. '2 critical, 0 unchecked'. */
  summary: string;
  remedy: GateRemedy;
}

export type GateResult = GatePass | GateBlock;

export interface GateOptions {
  /**
   * Block kinds the operator has waived (a `--skip-*` / `--force` flag). The
   * flag waives the check; it does not make the condition true, so `status`
   * never passes any.
   */
  bypass?: readonly GateBlockKind[];
}

/** The stages a gate guards. Every other stage passes. */
export const GATED_STAGES: readonly EpisodeStageId[] = ['storyboard', 'qa-approve', 'render', 'assemble'];

/**
 * Whether `stageId` may run for the episode the facts describe, and if not,
 * the first reason (in the order the command checks them) and its remedy.
 */
export function gateFor(stageId: EpisodeStageId, facts: GateFacts, options: GateOptions = {}): GateResult {
  const bypass = new Set(options.bypass ?? []);
  for (const reason of blockReasons(stageId, facts)) {
    if (!bypass.has(reason.kind)) return block(reason, facts.episode);
  }
  return stageId === 'assemble' && !bypass.has('video-qa-failed') ? videoQaAdvisory(facts) : { blocked: false };
}

function blockReasons(stageId: EpisodeStageId, facts: GateFacts): GateBlockReason[] {
  const reasons: GateBlockReason[] = [];
  switch (stageId) {
    case 'storyboard': {
      if (!scriptApproved({ scriptApprovalArtifact: Boolean(facts.scriptApprovalArtifact), scriptStatusApproved: Boolean(facts.scriptStatusApproved) })) {
        reasons.push({ kind: 'script-not-approved' });
      }
      const missing = facts.missingReferences;
      if (missing && (missing.characters.length > 0 || missing.locations.length > 0)) {
        reasons.push({ kind: 'references-missing', characters: missing.characters, locations: missing.locations });
      }
      break;
    }
    case 'qa-approve': {
      const report = facts.qaReport;
      if (!facts.qaReported) reasons.push({ kind: 'qa-report-missing' });
      else if (report && parseFailed(report)) reasons.push({ kind: 'qa-report-unreadable', error: report.parseError });
      else if (report) {
        const { blocked, criticalCount, uncheckedCount } = storyboardApprovalBlock(report.summary);
        if (blocked) reasons.push({ kind: 'qa-issues', criticalCount, uncheckedCount, criticalShots: report.criticalShots ?? [] });
      }
      break;
    }
    case 'render': {
      const approval = facts.approval;
      if (!facts.qaApproved) reasons.push({ kind: 'qa-not-approved' });
      else if (approval && parseFailed(approval)) reasons.push({ kind: 'approval-unreadable', error: approval.parseError });
      else if (approval && approval.stale.length > 0) {
        reasons.push({ kind: 'approval-stale', approvedAt: approval.approvedAt, stale: approval.stale });
      }
      const notCleared = (facts.approvedShots ?? [])
        .filter(shot => !approvalCounts(shot.binding, shot.qaCleared))
        .map(shot => shot.shotKey);
      if (facts.qaApproved && notCleared.length > 0) reasons.push({ kind: 'approval-not-cleared', shots: notCleared });
      break;
    }
    case 'assemble': {
      const report = facts.videoQaReport;
      if (facts.videoQaReported && report && !parseFailed(report) && videoQaBlocksAssembly(report)) {
        reasons.push({ kind: 'video-qa-failed', criticals: report.summary?.criticals });
      }
      break;
    }
    default:
      break;
  }
  return reasons;
}

/** A missing video-QA report only warns (rule 52); an unreadable one is treated as missing. */
function videoQaAdvisory(facts: GateFacts): GatePass {
  if (!facts.videoQaReported) return { blocked: false, advisory: 'video-qa-missing' };
  if (facts.videoQaReport && parseFailed(facts.videoQaReport)) return { blocked: false, advisory: 'video-qa-unreadable' };
  return { blocked: false };
}

function block(reason: GateBlockReason, episode: number): GateBlock {
  return { blocked: true, reason, summary: blockSummary(reason), remedy: remedyFor(reason, episode) };
}

function blockSummary(reason: GateBlockReason): string {
  switch (reason.kind) {
    case 'script-not-approved': return 'script not approved';
    case 'references-missing':
      return `references missing for ${[...reason.characters.map(c => c.name), ...reason.locations.map(l => `location ${l}`)].join(', ')}`;
    case 'qa-report-missing': return 'no QA report';
    case 'qa-report-unreadable': return 'qa-report.json unreadable';
    case 'qa-issues': return `${reason.criticalCount} critical, ${reason.uncheckedCount} unchecked`;
    case 'qa-not-approved': return 'QA not approved';
    case 'approval-unreadable': return 'qa-approved.json unreadable';
    case 'approval-stale': return `${reason.stale.length} shot(s) changed after QA approval`;
    case 'approval-not-cleared': return `${reason.shots.length} shot(s) approved without a QA pass or force`;
    case 'video-qa-failed': return `video QA found ${reason.criticals ?? '?'} critical issue(s)`;
  }
}

function stageRemedy(stageId: EpisodeStageId, episode: number): GateRemedy {
  return { stageId, command: fillCommand(stageCommandTemplate(stageId), { episode }) };
}

function actionRemedy(action: GateRemedyAction, episode: number, values?: Record<string, string>): GateRemedy {
  return { action, command: fillCommand(GATE_REMEDY_COMMANDS[action], { episode, values }) };
}

function remedyFor(reason: GateBlockReason, episode: number): GateRemedy {
  switch (reason.kind) {
    case 'script-not-approved': return stageRemedy('approve-script', episode);
    case 'references-missing':
      // One entity at a time: the next `status` names the next one.
      return reason.characters.length > 0
        ? actionRemedy('add-character', episode, addCharacterValues(reason.characters[0]))
        : actionRemedy('generate-location-references', episode, { slug: reason.locations[0] });
    case 'qa-report-missing':
    case 'qa-report-unreadable':
      return stageRemedy('qa-storyboard', episode);
    case 'qa-issues':
      // Criticals need a panel fixed; unchecked shots only need QA to read them.
      return reason.criticalCount > 0
        ? actionRemedy('fix-panel', episode, reason.criticalShots.length > 0 ? { shot: String(reason.criticalShots[0]) } : undefined)
        : stageRemedy('qa-storyboard', episode);
    case 'qa-not-approved':
    case 'approval-unreadable':
    case 'approval-stale':
    case 'approval-not-cleared':
      return stageRemedy('qa-approve', episode);
    case 'video-qa-failed': return actionRemedy('harvest-anchor', episode);
  }
}
