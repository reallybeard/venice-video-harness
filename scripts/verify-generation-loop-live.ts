// Live check of the core generation loop (task 21e): render ONE cheap unit
// through the new path (generateEpisodeVideos → core runGenerationUnits →
// core renderVideo) on a scratch project, and compare the /video/queue body
// it sends against the body the old path (a build of the pre-21e code) sends
// for the same project.
//
// Two phases:
//   1. dry (always, no network): both paths run against a capture stub that
//      records the queue body and refuses to go further. The bodies must be
//      byte-identical, or the script stops before anything is billed.
//   2. live (only with --live): the new path renders the unit for real. The
//      body Venice received is captured on the way out and compared again.
//
// COSTS MONEY with --live: one 5s MiniMax H3 Max Turbo image-to-video render
// at 768P (the generator pins 768P for every minimax-h3-max* id). Quoted at
// $0.012/s at 768P (AGENTS.md, 2026-09-03) → ~$0.06. For scale, the stream
// table's quoted 480P figure for the same lane is $0.11 per 15s. Billed at
// queue time. The script prints its estimate before queueing.
//
// The old path needs a built checkout of `main` before this change, outside this tree:
//   OLD=$(mktemp -d) && git archive origin/main | tar -x -C "$OLD" \
//     && cp -R node_modules "$OLD"/ && (cd "$OLD" && npm run build)
//
// Usage (from the harness root, after `npm run build`):
//   VENICE_VIDEO_CONFIG_DIR=$(mktemp -d) VENICE_API_KEY= \
//     node --import tsx scripts/verify-generation-loop-live.ts --old-repo "$OLD"
//   VENICE_VIDEO_CONFIG_DIR=$(mktemp -d) VENICE_API_KEY=<key> \
//     node --import tsx scripts/verify-generation-loop-live.ts --old-repo "$OLD" --live
//
// Writes <scratch>/old-body.json, new-body.json and report.json: both bodies' sha256, whether they match, and
// (live) the queue id, the saved clip and its size.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'minimax-h3-max-turbo-image-to-video';
const DURATION_SEC = 5;
const USD_PER_SEC_768P = 0.012;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const live = process.argv.includes('--live');
const oldRepo = arg('old-repo') ? resolve(arg('old-repo')!) : undefined;
if (!oldRepo || !existsSync(join(oldRepo, 'dist/mini-drama/video-generator.js'))) {
  console.error('usage: verify-generation-loop-live.ts --old-repo <built pre-21e checkout> [--live]');
  process.exit(2);
}
if (!process.env.VENICE_VIDEO_CONFIG_DIR) {
  console.error('Set VENICE_VIDEO_CONFIG_DIR to a scratch directory (the pending-job registry lives there).');
  process.exit(2);
}
const apiKey = process.env.VENICE_API_KEY?.trim();
if (live && !apiKey) {
  console.error('--live needs VENICE_API_KEY in the environment.');
  process.exit(2);
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const WORK = mkdtempSync(join(tmpdir(), 'verify-generation-loop-'));

// A faceless 16:9 panel: a real PNG (Venice decodes it), no people.
const PANEL = join(WORK, 'panel.png');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
  'gradients=s=1280x720:c0=0x1e3a5f:c1=0xf2b880:x0=0:y0=720:x1=0:y1=0:seed=1',
  '-frames:v', '1', PANEL], { stdio: 'pipe' });

const SHOT = {
  shotNumber: 1,
  type: 'establishing',
  environment: 'DAY_EXTERIOR',
  duration: `${DURATION_SEC}s`,
  videoModel: 'atmosphere',
  description: 'A calm sea at dawn, the horizon glowing amber, slow waves rolling in. No people.',
  characters: [],
  dialogue: null,
  sfx: null,
  cameraMovement: 'slow push in',
  transition: 'CUT',
};

interface Harness {
  generateEpisodeVideos: (...args: any[]) => Promise<{ videoPaths: string[] }>;
  buildGenerationPlan: (script: any, series: any) => any;
  createSeries: (...args: any[]) => any;
}

async function load(repo: string): Promise<Harness> {
  const gen = await import(join(repo, 'dist/mini-drama/video-generator.js'));
  const planner = await import(join(repo, 'dist/mini-drama/generation-planner.js'));
  const manager = await import(join(repo, 'dist/series/manager.js'));
  return { generateEpisodeVideos: gen.generateEpisodeVideos, buildGenerationPlan: planner.buildGenerationPlan, createSeries: manager.createSeries };
}

function scratchProject(h: Harness, label: string) {
  const series = h.createSeries('Verify', 'one unit', 'drama', 'sea', { workspace: join(WORK, label) });
  series.aesthetic = { style: 'naturalistic', palette: 'amber and slate', lighting: 'soft dawn', lensCharacteristics: 'wide', filmStock: '', seed: 11 };
  series.characters = [];
  series.locations = [];
  series.episodes = [{ number: 1, title: 'Verify' }];
  series.storyboardAspectRatio = '16:9';
  series.videoDefaults = { ...series.videoDefaults, montageMode: false, atmosphereModel: MODEL, actionModel: MODEL };
  const sceneDir = join(series.outputDir, 'episodes', 'episode-001', 'scene-001');
  mkdirSync(sceneDir, { recursive: true });
  writeFileSync(join(sceneDir, 'shot-001.png'), readFileSync(PANEL));
  writeFileSync(join(sceneDir, 'shot-001.provenance.json'), JSON.stringify({ generationModel: 'ffmpeg', hasFace: false }));
  writeFileSync(join(series.outputDir, 'series.json'), JSON.stringify(series, null, 2));
  const script = { episode: 1, title: 'Verify', seriesName: 'Verify', status: 'approved', shots: [structuredClone(SHOT)] };
  return { series, script, sceneDir, root: series.outputDir as string };
}

class Captured extends Error {
  constructor() { super('captured'); this.name = 'Captured'; }
}

/** A client that records the queue body and stops the render there. */
function captureClient(sink: { body?: unknown }) {
  return {
    async post(path: string, body: unknown) {
      if (path !== '/api/v1/video/queue') throw new Error(`dry: unexpected POST ${path}`);
      sink.body = body;
      throw new Captured();
    },
    async postBinaryOrJson(path: string) { throw new Error(`dry: unexpected POST ${path}`); },
    async postBinary(path: string) { throw new Error(`dry: unexpected POST ${path}`); },
  };
}

/** The body as compared: exact JSON, with the scratch project path neutralised. */
const canonical = (body: unknown, root: string) => JSON.stringify(body).replaceAll(root, '<P>');

async function dryBody(repo: string, label: string): Promise<{ text: string; model: string }> {
  const h = await load(repo);
  const project = scratchProject(h, label);
  const sink: { body?: any } = {};
  const plan = h.buildGenerationPlan(project.script, project.series);
  try {
    await h.generateEpisodeVideos(captureClient(sink), project.series, project.script.shots, project.sceneDir, plan);
  } catch (err) {
    if (!(err instanceof Error && err.name === 'Captured')) throw err;
  }
  if (!sink.body) throw new Error(`${label}: no queue body was sent (the unit was skipped?)`);
  return { text: canonical(sink.body, project.root), model: sink.body.model };
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('verify-generation-loop: network is off in the dry phase'); }) as typeof fetch;

const oldBody = await dryBody(oldRepo, 'old');
const newBody = await dryBody(HARNESS, 'new');
const report: Record<string, unknown> = {
  model: newBody.model,
  oldBodySha256: sha(oldBody.text),
  newBodySha256: sha(newBody.text),
  dryMatch: oldBody.text === newBody.text,
};
writeFileSync(join(WORK, 'old-body.json'), oldBody.text);
writeFileSync(join(WORK, 'new-body.json'), newBody.text);
console.log(`dry: old ${report.oldBodySha256}\n     new ${report.newBodySha256}\n     ${report.dryMatch ? 'MATCH' : 'DIFFER'}`);
if (!report.dryMatch) {
  writeFileSync(join(WORK, 'report.json'), JSON.stringify(report, null, 2));
  console.error(`Bodies differ; nothing was queued. See ${WORK}/old-body.json and new-body.json.`);
  process.exit(1);
}
if (newBody.model !== MODEL) {
  console.error(`The unit routed to ${newBody.model}, not ${MODEL}; the cost estimate does not apply. Stopping.`);
  process.exit(1);
}

if (!live) {
  writeFileSync(join(WORK, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Dry phase passed. Re-run with --live to render (estimated $${(DURATION_SEC * USD_PER_SEC_768P).toFixed(2)}). Report: ${WORK}/report.json`);
  process.exit(0);
}

globalThis.fetch = realFetch;
const { VeniceClient } = await import(join(HARNESS, 'dist/venice/client.js'));
const h = await load(HARNESS);
const project = scratchProject(h, 'live');
const client = new VeniceClient(apiKey);
let sentBody: unknown;
let queueId: string | undefined;
const recording = new Proxy(client, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (prop !== 'post' || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value;
    return async (path: string, body: unknown, ...rest: unknown[]) => {
      if (path === '/api/v1/video/queue') sentBody = body;
      const res = await value.call(target, path, body, ...rest);
      if (path === '/api/v1/video/queue') queueId = (res as { queue_id?: string })?.queue_id;
      return res;
    };
  },
});

console.log(`live: queueing ONE ${DURATION_SEC}s ${MODEL} render at 768P, estimated $${(DURATION_SEC * USD_PER_SEC_768P).toFixed(2)}.`);
const plan = h.buildGenerationPlan(project.script, project.series);
const { videoPaths } = await h.generateEpisodeVideos(recording, project.series, project.script.shots, project.sceneDir, plan);
const liveText = sentBody === undefined ? '' : canonical(sentBody, project.root);
Object.assign(report, {
  queueId,
  liveBodySha256: liveText ? sha(liveText) : null,
  liveMatch: liveText === oldBody.text,
  videoPaths,
  clipBytes: videoPaths[0] && existsSync(videoPaths[0]) ? statSync(videoPaths[0]).size : null,
});
writeFileSync(join(WORK, 'report.json'), JSON.stringify(report, null, 2));
console.log(`live: body ${report.liveMatch ? 'MATCHES' : 'DIFFERS FROM'} the old path; clip ${videoPaths[0] ?? '(none)'}. Report: ${WORK}/report.json`);
process.exit(report.liveMatch && videoPaths.length === 1 ? 0 : 1);
