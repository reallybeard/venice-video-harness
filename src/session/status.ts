// ---------------------------------------------------------------------------
// Pipeline status -- read the on-disk state machine and say what comes next.
//
// The production pipeline already encodes its own state as files: script.json,
// script-approved.json, qa-report.json, qa-approved.json, panels, clips, then
// episode-NNN-final.mp4. Nothing surfaced that, so knowing where an episode
// stood meant listing directories by hand and remembering the gate order.
//
// This reads those markers into plain facts, plus the gate facts from inside
// the artifacts (through the same readers the gated commands use,
// `./gates.ts`); the classification (stage, gate,
// next command) is pure and lives in core (`venice-video-harness/core/session/
// status.js`), so a browser host classifies its own store the same way.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getEpisodeDir, loadEpisodeScript, loadSeries } from '../series/manager.js';
import type { EpisodeScript, SeriesState } from 'venice-video-harness/core/series/types.js';
import type { EpisodeGateFacts } from 'venice-video-harness/core/session/gates.js';
import { missingReferencesOnDisk, readApprovalFacts, readQaReportFacts, readVideoQaFacts } from './gates.js';
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

/** A gate fact, or nothing when reading it throws: an unread fact never blocks, and status must not crash. */
function readSafely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * The gate facts, read the way the gated commands read them (same readers,
 * whole script): references for storyboard-episode, the QA report for
 * qa-approve, the approval check for generate-videos (hashes every panel),
 * the video-QA report for assemble-episode.
 */
function collectGateFacts(
  series: SeriesState,
  script: EpisodeScript | null,
  episodeDir: string,
  markers: Pick<EpisodeFacts, 'qaReported' | 'qaApproved' | 'videoQaReported'>,
): EpisodeGateFacts {
  const facts: EpisodeGateFacts = {};
  if (script) {
    const missing = readSafely(() => missingReferencesOnDisk(series, script.shots));
    if (missing) facts.missingReferences = missing;
  }
  if (markers.qaReported) {
    const qaReport = readSafely(() => readQaReportFacts(join(episodeDir, 'qa-report.json')));
    if (qaReport) facts.qaReport = qaReport;
  }
  if (markers.qaApproved && script) {
    const approval = readSafely(() => readApprovalFacts(join(episodeDir, 'qa-approved.json'), series, script.shots, join(episodeDir, 'scene-001')));
    if (approval) facts.approval = approval;
  }
  if (markers.videoQaReported) {
    const videoQaReport = readSafely(() => readVideoQaFacts(join(episodeDir, 'video-qa-report.json')));
    if (videoQaReport) facts.videoQaReport = videoQaReport;
  }
  return facts;
}

/** The markers the classifier reads for one episode, from disk, plus its gate facts. */
function collectEpisodeFacts(
  series: SeriesState,
  episode: number,
  script: EpisodeScript | null,
  episodeDir: string,
): EpisodeFacts {
  const sceneDir = join(episodeDir, 'scene-001');
  const audioDir = join(episodeDir, 'audio');
  const padded = String(episode).padStart(3, '0');
  const markers = {
    qaReported: existsSync(join(episodeDir, 'qa-report.json')),
    qaApproved: existsSync(join(episodeDir, 'qa-approved.json')),
    videoQaReported: existsSync(join(episodeDir, 'video-qa-report.json')),
  };

  return {
    episode,
    title: series.episodes.find(e => e.number === episode)?.title,
    hasScript: Boolean(script),
    shotCount: script?.shots?.length ?? 0,
    scriptApprovalArtifact: existsSync(join(episodeDir, 'script-approved.json')),
    scriptStatusApproved: script?.status === 'approved',
    ...markers,
    panelCount: countMatching(sceneDir, /^shot-\d+\.png$/),
    videoCount: countMatching(sceneDir, /^shot-\d+\.mp4$/),
    hasMusic: existsSync(join(audioDir, 'music.mp3')),
    dialogueCount: countMatching(audioDir, /^dialogue-shot-\d+\.mp3$/),
    hasFinalCut: existsSync(join(episodeDir, `episode-${padded}-final.mp4`)),
    ...collectGateFacts(series, script, episodeDir, markers),
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
