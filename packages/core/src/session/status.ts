// ---------------------------------------------------------------------------
// Pipeline status -- the report shapes and their text rendering.
//
// The on-disk reader stays in `src/session/status.ts` (`collectProjectStatus`);
// what it returns, how a suggestion is made pasteable, and how the report
// prints are pure and live here, so a browser host renders the same status.
// ---------------------------------------------------------------------------

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
