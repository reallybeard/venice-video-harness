// ---------------------------------------------------------------------------
// Pipeline status -- read the on-disk state machine and say what comes next.
//
// The production pipeline already encodes its own state as files: script.json,
// script-approved.json, qa-report.json, qa-approved.json, panels, clips, then
// episode-NNN-final.mp4. Nothing surfaced that, so knowing where an episode
// stood meant listing directories by hand and remembering the gate order.
//
// This reads those markers into plain facts; the classification (stage, gate,
// next command) is pure and lives in core (`venice-video-harness/core/session/
// status.js`), so a browser host classifies its own store the same way.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getEpisodeDir, loadEpisodeScript, loadSeries } from '../series/manager.js';
import type { EpisodeScript, SeriesState } from 'venice-video-harness/core/series/types.js';
import {
  projectStatusFromFacts,
  type EpisodeFacts,
  type ProjectFacts,
  type ProjectStatus,
} from 'venice-video-harness/core/session/status.js';

export type {
  EpisodeClassification,
  EpisodeFacts,
  EpisodeStageId,
  EpisodeStatus,
  ProjectClassification,
  ProjectFacts,
  ProjectStageId,
  ProjectStatus,
} from 'venice-video-harness/core/session/status.js';
export {
  classifyEpisode,
  classifyProject,
  episodeStatusFromFacts,
  formatProjectStatus,
  projectStatusFromFacts,
  qualifyCommand,
  scriptApproved,
  stageCommand,
} from 'venice-video-harness/core/session/status.js';

function countMatching(dir: string, pattern: RegExp): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter(name => pattern.test(name)).length;
  } catch {
    return 0;
  }
}

/** The markers the classifier reads for one episode, from disk. */
function collectEpisodeFacts(
  series: SeriesState,
  episode: number,
  script: EpisodeScript | null,
  episodeDir: string,
): EpisodeFacts {
  const sceneDir = join(episodeDir, 'scene-001');
  const audioDir = join(episodeDir, 'audio');
  const padded = String(episode).padStart(3, '0');

  return {
    episode,
    title: series.episodes.find(e => e.number === episode)?.title,
    hasScript: Boolean(script),
    shotCount: script?.shots?.length ?? 0,
    scriptApprovalArtifact: existsSync(join(episodeDir, 'script-approved.json')),
    scriptStatusApproved: script?.status === 'approved',
    qaReported: existsSync(join(episodeDir, 'qa-report.json')),
    qaApproved: existsSync(join(episodeDir, 'qa-approved.json')),
    videoQaReported: existsSync(join(episodeDir, 'video-qa-report.json')),
    panelCount: countMatching(sceneDir, /^shot-\d+\.png$/),
    videoCount: countMatching(sceneDir, /^shot-\d+\.mp4$/),
    hasMusic: existsSync(join(audioDir, 'music.mp3')),
    dialogueCount: countMatching(audioDir, /^dialogue-shot-\d+\.mp3$/),
    hasFinalCut: existsSync(join(episodeDir, `episode-${padded}-final.mp4`)),
  };
}

/** Everything `projectStatusFromFacts` needs, read from a project directory. */
export async function collectProjectFacts(projectDir: string): Promise<ProjectFacts | null> {
  const series = await loadSeries(projectDir);
  if (!series) return null;

  const episodes: EpisodeFacts[] = [];
  for (const meta of series.episodes) {
    const episodeDir = getEpisodeDir(series, meta.number);
    const script = await loadEpisodeScript(series, meta.number);
    episodes.push(collectEpisodeFacts(series, meta.number, script, episodeDir));
  }

  const characters = series.characters ?? [];
  return {
    projectDir,
    name: series.name,
    slug: series.slug,
    aestheticSet: Boolean(series.aesthetic),
    characterCount: characters.length,
    lockedVoiceCount: characters.filter(c => Boolean(c.voiceId)).length,
    locationCount: (series.locations ?? []).length,
    episodes,
  };
}

export async function collectProjectStatus(projectDir: string): Promise<ProjectStatus | null> {
  const facts = await collectProjectFacts(projectDir);
  return facts ? projectStatusFromFacts(facts) : null;
}
