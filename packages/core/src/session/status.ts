// ---------------------------------------------------------------------------
// Pipeline status -- classify an episode's state and say what comes next.
//
// The production pipeline encodes its state as artifacts: script.json,
// script-approved.json, qa-report.json, qa-approved.json, panels, clips, then
// episode-NNN-final.mp4. A host reads those into plain facts (the CLI from
// disk: `collectProjectFacts` in `src/session/status.ts`; a browser from its
// store) and this module turns the facts into the stage, the gate and the
// literal next command.
//
// The stage order, the gates and the commands come from `PIPELINE_STAGES`
// (`agent/pipeline.ts`), so `status` and `pipeline` cannot drift apart
// (AGENTS.md rules 45 and 48). A stage the classifier can name but the table
// lacks throws, and `tests/core-stages.test.mjs` checks both directions.
// ---------------------------------------------------------------------------

import { PIPELINE_BRANCHES, PIPELINE_STAGES } from '../agent/pipeline.js';
import { scriptApproved } from './gates.js';

export { scriptApproved };

/**
 * What the classifier reads about one episode. Exactly the markers the CLI
 * checks on disk; nothing is inferred from file contents.
 */
export interface EpisodeFacts {
  episode: number;
  title?: string;
  /** script.json exists. */
  hasScript: boolean;
  /** script.shots.length (0 without a script). */
  shotCount: number;
  /** script-approved.json exists (written by `approve-script`). */
  scriptApprovalArtifact: boolean;
  /** script.status === 'approved' (set by `workshop --approve`). */
  scriptStatusApproved: boolean;
  /** qa-report.json exists. */
  qaReported: boolean;
  /** qa-approved.json exists. */
  qaApproved: boolean;
  /** video-qa-report.json exists. */
  videoQaReported: boolean;
  /** scene-001/shot-NNN.png files (archived `-vN` copies excluded). */
  panelCount: number;
  /** scene-001/shot-NNN.mp4 files (archived `-vN` copies excluded). */
  videoCount: number;
  /** audio/music.mp3 exists. */
  hasMusic: boolean;
  /** audio/dialogue-shot-NNN.mp3 files. */
  dialogueCount: number;
  /** episode-NNN-final.mp4 exists. */
  hasFinalCut: boolean;
}

/** What the classifier reads about a project: its prerequisites and episodes. */
export interface ProjectFacts {
  projectDir: string;
  name: string;
  slug: string;
  aestheticSet: boolean;
  characterCount: number;
  lockedVoiceCount: number;
  locationCount: number;
  /** In `series.episodes` order. */
  episodes: EpisodeFacts[];
}

/** Episode-scope `PipelineStage` ids, in pipeline order. */
export type EpisodeStageId =
  | 'script'
  | 'approve-script'
  | 'storyboard'
  | 'qa-storyboard'
  | 'qa-approve'
  | 'render'
  | 'qa-videos'
  | 'assemble';

/** Project-scope `PipelineStage` ids, in pipeline order. */
export type ProjectStageId = 'aesthetic' | 'cast' | 'episode';

export interface EpisodeClassification {
  /** Short human stage name, e.g. 'at QA gate', 'rendering (2/5 clips)'. */
  stage: string;
  /** The pipeline stage that advances the episode; undefined when complete. */
  nextStageId?: EpisodeStageId;
  /** That stage's command in shell form (`-e <n>` filled, no `-p`). */
  nextCommand?: string;
  /** That stage's gate text from the pipeline table, when it is gated. */
  gate?: string;
  /** A shot script exists, so the gate-skipping loop branch is available. */
  loopAvailable: boolean;
}

export interface ProjectClassification {
  episodes: EpisodeClassification[];
  /** The project prerequisite or episode stage to run next; undefined when all done. */
  nextStageId?: ProjectStageId | EpisodeStageId;
  /** The episode `nextStageId` belongs to, for an episode-scope stage. */
  nextEpisode?: number;
  nextCommand?: string;
  gate?: string;
  /** The `loop` command for the first episode with a shot script, if any. */
  loopCommand?: string;
}

/**
 * The project-level `status` suggestion for the aesthetic stage. It is the
 * one command whose shell form is not the pipeline command with `-p` dropped:
 * the pipeline names `--style <n>`, which only makes sense after the explore
 * step has printed the options.
 */
const AESTHETIC_STATUS_COMMAND = 'explore-aesthetic   # then: set-aesthetic';

/**
 * A pipeline command in the shell form `status` suggests: `-p <project>`
 * dropped (the shell defaults it; `qualifyCommand` restores it elsewhere) and
 * `-e <n>` filled with the episode. Throws for an id the table lacks, so a
 * renamed stage fails loudly instead of suggesting nothing.
 */
export function stageCommand(stageId: ProjectStageId | EpisodeStageId, episode?: number): string {
  if (stageId === 'aesthetic') return AESTHETIC_STATUS_COMMAND;
  const stage = PIPELINE_STAGES.find(s => s.id === stageId);
  if (!stage) throw new Error(`pipeline stage "${stageId}" is not in PIPELINE_STAGES`);
  return shellForm(stage.command, episode);
}

function stageGate(stageId: ProjectStageId | EpisodeStageId): string | undefined {
  return PIPELINE_STAGES.find(s => s.id === stageId)?.gate;
}

function shellForm(command: string, episode?: number): string {
  const withoutProject = command.split(' -p <project>').join('');
  return episode === undefined ? withoutProject : withoutProject.split('-e <n>').join(`-e ${episode}`);
}

/**
 * Determine an episode's stage and the stage that advances it.
 * Mirrors the real gate order: script → approve → storyboard → QA → qa-approve
 * → videos → video QA → assemble.
 */
export function classifyEpisode(facts: EpisodeFacts): EpisodeClassification {
  const { stage, nextStageId } = episodeStage(facts);
  const classification: EpisodeClassification = {
    stage,
    // A shot script is loop mode's only precondition (gates are skipped).
    loopAvailable: facts.shotCount > 0,
  };
  if (nextStageId) {
    classification.nextStageId = nextStageId;
    classification.nextCommand = stageCommand(nextStageId, facts.episode);
    const gate = stageGate(nextStageId);
    if (gate) classification.gate = gate;
  }
  return classification;
}

function episodeStage(facts: EpisodeFacts): { stage: string; nextStageId?: EpisodeStageId } {
  if (!facts.hasScript) return { stage: 'no script', nextStageId: 'script' };
  if (!scriptApproved(facts)) return { stage: 'script drafted', nextStageId: 'approve-script' };
  if (facts.panelCount < facts.shotCount) {
    return {
      stage: facts.panelCount === 0
        ? 'ready to storyboard'
        : `storyboarding (${facts.panelCount}/${facts.shotCount} panels)`,
      nextStageId: 'storyboard',
    };
  }
  if (!facts.qaReported) return { stage: 'panels complete', nextStageId: 'qa-storyboard' };
  if (!facts.qaApproved) return { stage: 'at QA gate', nextStageId: 'qa-approve' };
  if (facts.videoCount < facts.shotCount) {
    return {
      stage: facts.videoCount === 0
        ? 'ready to render'
        : `rendering (${facts.videoCount}/${facts.shotCount} clips)`,
      nextStageId: 'render',
    };
  }
  if (!facts.videoQaReported && !facts.hasFinalCut) {
    return { stage: 'clips complete, unverified', nextStageId: 'qa-videos' };
  }
  if (!facts.hasFinalCut) return { stage: 'clips verified', nextStageId: 'assemble' };
  return { stage: 'complete' };
}

/**
 * Project prerequisites gate everything downstream, so they take precedence
 * over any individual episode's next step; otherwise the first unfinished
 * episode's step is next.
 */
export function classifyProject(facts: ProjectFacts): ProjectClassification {
  const episodes = facts.episodes.map(classifyEpisode);
  const classification: ProjectClassification = { episodes };

  let next: { id: ProjectStageId | EpisodeStageId; episode?: number } | undefined;
  if (!facts.aestheticSet) next = { id: 'aesthetic' };
  else if (facts.characterCount === 0) next = { id: 'cast' };
  else if (episodes.length === 0) next = { id: 'episode' };
  else {
    const index = episodes.findIndex(e => e.nextStageId);
    if (index >= 0) next = { id: episodes[index].nextStageId!, episode: facts.episodes[index].episode };
  }
  if (next) {
    classification.nextStageId = next.id;
    if (next.episode !== undefined) classification.nextEpisode = next.episode;
    classification.nextCommand = stageCommand(next.id, next.episode);
    const gate = stageGate(next.id);
    if (gate) classification.gate = gate;
  }

  // Surface loop mode (the gate-skipping alternate path) whenever a shot script
  // exists, pointed at the first episode that has one.
  const loopable = episodes.findIndex(e => e.loopAvailable);
  if (loopable >= 0) classification.loopCommand = loopCommand(facts.episodes[loopable].episode);
  return classification;
}

function loopCommand(episode: number): string {
  const branch = PIPELINE_BRANCHES.find(b => b.id === 'loop');
  if (!branch) throw new Error('pipeline branch "loop" is not in PIPELINE_BRANCHES');
  return shellForm(branch.command, episode);
}

/** The `EpisodeStatus` report for one episode's facts. */
export function episodeStatusFromFacts(
  facts: EpisodeFacts,
  classification: EpisodeClassification = classifyEpisode(facts),
): EpisodeStatus {
  // Key order is the report's JSON order (`status --json`); keep it.
  const status: EpisodeStatus = {
    episode: facts.episode,
    title: facts.title,
    hasScript: facts.hasScript,
    shotCount: facts.shotCount,
    scriptApproved: scriptApproved(facts),
    qaReported: facts.qaReported,
    qaApproved: facts.qaApproved,
    videoQaReported: facts.videoQaReported,
    panelCount: facts.panelCount,
    videoCount: facts.videoCount,
    hasMusic: facts.hasMusic,
    dialogueCount: facts.dialogueCount,
    hasFinalCut: facts.hasFinalCut,
    stage: classification.stage,
    loopAvailable: classification.loopAvailable,
  };
  if (classification.nextCommand !== undefined) status.nextCommand = classification.nextCommand;
  return status;
}

/** The `ProjectStatus` report `venice-video status` prints, from facts alone. */
export function projectStatusFromFacts(facts: ProjectFacts): ProjectStatus {
  const classification = classifyProject(facts);
  const status: ProjectStatus = {
    projectDir: facts.projectDir,
    name: facts.name,
    slug: facts.slug,
    aestheticSet: facts.aestheticSet,
    characterCount: facts.characterCount,
    lockedVoiceCount: facts.lockedVoiceCount,
    locationCount: facts.locationCount,
    episodes: facts.episodes.map((e, i) => episodeStatusFromFacts(e, classification.episodes[i])),
    nextCommand: classification.nextCommand,
  };
  if (classification.loopCommand !== undefined) status.loopCommand = classification.loopCommand;
  return status;
}

export interface EpisodeStatus {
  episode: number;
  title?: string;
  hasScript: boolean;
  shotCount: number;
  scriptApproved: boolean;
  qaReported: boolean;
  qaApproved: boolean;
  /** video-qa-report.json exists (post-render QA on the rendered units). */
  videoQaReported: boolean;
  panelCount: number;
  videoCount: number;
  hasMusic: boolean;
  dialogueCount: number;
  hasFinalCut: boolean;
  /** Short stage name, e.g. 'storyboard', 'qa gate', 'rendering'. */
  stage: string;
  /** Literal command to run next, or undefined when the episode is done. */
  nextCommand?: string;
  /**
   * Loop mode is a gate-skipping alternate path (see PIPELINE_BRANCHES): the
   * moment a shot script exists, `venice-video loop` can render + watch/gather
   * takes without the storyboard/QA gates. `status` surfaces it so an agent
   * following "next command" learns the branch exists.
   */
  loopAvailable: boolean;
}

export interface ProjectStatus {
  projectDir: string;
  name: string;
  slug: string;
  aestheticSet: boolean;
  characterCount: number;
  lockedVoiceCount: number;
  locationCount: number;
  episodes: EpisodeStatus[];
  /** Command to run next at the project level (aesthetic, cast) if any. */
  nextCommand?: string;
  /**
   * The `loop` command for the first episode with a shot script, if any. An
   * alternate path to the linear `nextCommand`, not a replacement for it.
   */
  loopCommand?: string;
}

/**
 * Turn a shell-form suggestion (`qa-storyboard -e 3`) into one that also works
 * pasted into a plain terminal (`qa-storyboard -p "<dir>" -e 3`).
 *
 * Inside the shell `-p` defaults to the selection, so the short form is what
 * gets suggested there. Anywhere the project is not implied -- the treatment
 * page, a log someone reads tomorrow -- the command needs the directory or it
 * fails on a missing required option. A trailing `# comment` stays trailing.
 */
export function qualifyCommand(command: string, projectDir: string): string {
  if (/(^|\s)(-p|--project)(\s|=)/.test(command)) return command;
  const [body, ...comment] = command.split('#');
  const tokens = body.trimEnd().split(/\s+/);
  const head = tokens.shift() ?? command;
  const rest = tokens.length > 0 ? ` ${tokens.join(' ')}` : '';
  const suffix = comment.length > 0 ? `   #${comment.join('#')}` : '';
  return `${head} -p "${projectDir}"${rest}${suffix}`;
}

export function formatProjectStatus(status: ProjectStatus, selectedEpisode?: number): string {
  const lines: string[] = [];
  lines.push(`${status.name}  (${status.slug})`);
  lines.push(`  ${status.projectDir}`);
  lines.push('');
  lines.push(`  aesthetic  ${status.aestheticSet ? 'set' : 'NOT SET'}`);
  lines.push(
    `  cast       ${status.characterCount} character(s), ${status.lockedVoiceCount} with a locked voice`,
  );
  lines.push(`  locations  ${status.locationCount}`);

  if (status.episodes.length === 0) {
    lines.push('  episodes   none yet');
  } else {
    lines.push('');
    lines.push('  episodes');
    for (const ep of status.episodes) {
      const marker = ep.episode === selectedEpisode ? '▸' : ' ';
      const title = ep.title ? ` ${ep.title}` : '';
      lines.push(`   ${marker} ${String(ep.episode).padStart(2, '0')}${title} — ${ep.stage}`);
      if (ep.shotCount > 0) {
        lines.push(
          `        ${ep.shotCount} shots · ${ep.panelCount} panels · ${ep.videoCount} clips`
          + `${ep.dialogueCount > 0 ? ` · ${ep.dialogueCount} dialogue` : ''}`
          + `${ep.hasMusic ? ' · music' : ''}`
          + `${ep.hasFinalCut ? ' · FINAL CUT' : ''}`,
        );
      }
    }
  }

  if (status.nextCommand) {
    lines.push('');
    lines.push(`  next  ${status.nextCommand}`);
  } else {
    lines.push('');
    lines.push('  next  nothing pending — every episode is assembled.');
  }

  if (status.loopCommand) {
    lines.push(`  also  ${status.loopCommand}   # watch/gather takes off the shot script (skips the QA gate)`);
  }

  return lines.join('\n');
}
