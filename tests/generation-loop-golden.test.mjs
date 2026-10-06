// Golden: the per-unit video generation loop, end to end, against a scripted
// fake Venice client. Pins what `generateEpisodeVideos` (and `renderVideoFile`
// under it) does for every unit lane, so moving the loop into core can be
// checked byte for byte:
//
//   - every request sent (path + body; data: URIs labelled by the project
//     file whose bytes they carry), in order, interleaved with
//   - every console line, every stdout write (the `\r  Polling…` line) and
//     every timer wait the loop asked for;
//   - the pending-job registry after the run;
//   - every file the run left in the project (JSON sidecars normalised,
//     media identified by content: the served clip, a fixture, or a derived
//     file with its rounded duration);
//   - the outcome (the resolved video paths and unit segments, or the error).
//
// Lanes: single R2V, i2v with a start frame chained from the previous shot
// and an end-frame target, native multi-shot (split), montage (cut + media
// library), rule-32 keyframe pre-pass, inline TTS, voice-donor refs,
// faces-off twin swap and refusal, re-attach (ready / gone → requeue),
// FAILED, poll errors, existing clip skip, missing panel skip, multi-shot
// retry after a queue 5xx, 409 consent, unrefunded refusal, an unwritable
// output directory.
//
// No network: the client is a stub, `fetch` throws, the pending-job registry
// lives in a temp VENICE_VIDEO_CONFIG_DIR set before anything reads it.
// Timers: `setTimeout` is swapped for a 0 ms one during each run and every
// requested wait is recorded, so the cadence is pinned without sleeping.
//
// UPDATE_GENERATION_GOLDEN=1 rewrites tests/fixtures/generation-loop-golden.json.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.VENICE_VIDEO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'gen-loop-golden-config-'));
process.env.VENICE_API_KEY = '';
const CFG = realpathSync(process.env.VENICE_VIDEO_CONFIG_DIR);
globalThis.fetch = async () => { throw new Error('generation-loop golden: network is forbidden'); };

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const goldenPath = join(repoRoot, 'tests', 'fixtures', 'generation-loop-golden.json');
const update = process.env.UPDATE_GENERATION_GOLDEN === '1';

const { generateEpisodeVideos, renderVideoFile } = await import('../dist/mini-drama/video-generator.js');
const { buildGenerationPlan } = await import('../dist/mini-drama/generation-planner.js');
const { createSeries } = await import('../dist/series/manager.js');
const { VeniceRequestError } = await import('../dist/venice/client.js');
const { recordPendingJob, getJobStorePath } = await import('../dist/venice/job-store.js');
const { runInOperation } = await import('../dist/venice/operation-context.js');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// ---- fixtures -----------------------------------------------------------------

const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'gen-loop-golden-')));
const FIX = join(WORK, 'fixtures');
mkdirSync(FIX, { recursive: true });

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'pipe' });
}
function makeClip(name, sec) {
  const out = join(FIX, name);
  ffmpeg([
    '-f', 'lavfi', '-i', `testsrc=size=64x36:rate=24:duration=${sec}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${sec}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    '-map_metadata', '-1', '-fflags', '+bitexact', out,
  ]);
  return readFileSync(out);
}
function makeTone(name, sec, freq) {
  const out = join(FIX, name);
  ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${sec}`, '-ac', '1', '-ar', '44100',
    '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', out]);
  return readFileSync(out);
}
const CLIPS = { 'clip-6s': makeClip('clip-6s.mp4', 6) };
const TONES = {
  'dialogue-2s.mp3': makeTone('dialogue-2s.mp3', 2, 600),
  'voice-4s.mp3': makeTone('voice-4s.mp3', 4, 330),
  'tts-3s.mp3': makeTone('tts-3s.mp3', 3, 500),
};
const clipBySha = new Map(Object.entries(CLIPS).map(([name, buf]) => [sha(buf), name]));
const toneBySha = new Map(Object.entries(TONES).map(([name, buf]) => [sha(buf), name]));

/** A fake PNG: the signature plus the name, so every image has distinct, stable bytes. */
const png = (name) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from(name)]);

function ffprobeSec(path) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { encoding: 'utf-8' });
    const v = parseFloat(out.trim());
    return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
  } catch {
    return null;
  }
}

// ---- the project -----------------------------------------------------------------

const MARA = { name: 'MARA', gender: 'female', age: '40s', description: 'pilot', fullDescription: 'A pilot in a pressure suit.', wardrobe: 'orange pressure suit', locked: true, voiceId: 'af_sky', voiceName: 'Sky', seed: 1 };
const JUNO = { name: 'JUNO', gender: 'female', age: '20s', description: 'engineer', fullDescription: 'An engineer.', wardrobe: 'grey overalls', locked: true, seed: 2 };
const CAPSULE = { name: 'Capsule', slug: 'capsule', description: 'a cramped cockpit', lightingNotes: 'amber instrument glow', seed: 3, spatialAnchors: 'console ahead; hatch behind' };
const AESTHETIC = { style: 'documentary realism', palette: 'cold blue', lighting: 'hard', lensCharacteristics: 'large format', filmStock: 'fine grain', seed: 7 };

function shot(n, over = {}) {
  return {
    shotNumber: n, type: 'action', environment: 'DAY_INTERIOR', location: 'capsule', duration: '5s',
    videoModel: 'action', description: `Shot ${n}: MARA checks the console.`, characters: ['MARA'],
    dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT', ...over,
  };
}

/** Files every project starts with: reference sheets, location plates, panels (with face sidecars). */
function baseFiles(shots) {
  const files = {
    'characters/mara/front.png': png('mara-front'),
    'characters/mara/three-quarter.png': png('mara-3q'),
    'characters/juno/front.png': png('juno-front'),
    'locations/capsule/north.png': png('capsule-north'),
    'locations/capsule/south.png': png('capsule-south'),
    'locations/capsule/north.provenance.json': JSON.stringify({ generationModel: 'nano-banana-2', hasFace: false }),
    'locations/capsule/south.provenance.json': JSON.stringify({ generationModel: 'nano-banana-2', hasFace: false }),
  };
  for (const s of shots) {
    const key = String(s.shotNumber).padStart(3, '0');
    files[`episodes/episode-001/scene-001/shot-${key}.png`] = png(`panel-${key}`);
    files[`episodes/episode-001/scene-001/shot-${key}.provenance.json`] = JSON.stringify({
      generationModel: 'nano-banana-2', hasFace: s.characters.length > 0,
    });
  }
  return files;
}

function buildProject(id, { videoDefaults = {}, shots, files = {}, omit = [], characters = [MARA, JUNO], audioMix } = {}) {
  const series = createSeries('Golden', 'A signal from orbit', 'sci-fi', 'orbit', { workspace: join(WORK, id) });
  series.aesthetic = AESTHETIC;
  series.characters = structuredClone(characters);
  series.locations = [structuredClone(CAPSULE)];
  series.episodes = [{ number: 1, title: 'Pilot' }];
  series.storyboardAspectRatio = '16:9';
  series.videoDefaults = { ...series.videoDefaults, ...videoDefaults };
  const all = { ...baseFiles(shots), ...files };
  for (const p of omit) delete all[p];
  for (const [rel, value] of Object.entries(all)) {
    const abs = join(series.outputDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, value);
  }
  writeFileSync(join(series.outputDir, 'series.json'), JSON.stringify(series, null, 2));
  const script = { episode: 1, title: 'Pilot', seriesName: 'Golden', status: 'approved', shots, ...(audioMix ? { audioMix } : {}) };
  return { series, script, sceneDir: join(series.outputDir, 'episodes', 'episode-001', 'scene-001') };
}

// ---- the stub client ---------------------------------------------------------------

const P = { status: 'PROCESSING', average_execution_time: 1000, execution_duration: 20_000 };
const F = { status: 'FAILED', error: 'Content policy' };
const R = 'ready';
const E = 'error';
const GONE = 'gone';

const err = {
  e500: () => new VeniceRequestError('Venice API error 500 on /api/v1/video/queue: upstream', 500, { error: 'upstream' }),
  consent: () => new VeniceRequestError('needs consent', 409, { error: { code: 'needs_consent' } }),
  unrefunded: () => new VeniceRequestError('policy', 422, { error: { type: 'provider_content_policy', message: 'policy', credits_refunded: false } }),
};

/**
 * `queue`: one entry per /video/queue call (an error factory, or undefined for success).
 * `retrieve`: queue id → answers (the last one repeats).
 */
function stubClient(events, labeler, { queue = [], retrieve = {}, clip = 'clip-6s' } = {}) {
  let queued = 0;
  const perQueue = new Map();
  const answer = (a) => {
    if (a === R) return { contentType: 'video/mp4', value: Buffer.from(CLIPS[clip]) };
    if (a === E) throw new VeniceRequestError('Venice API error 503 on /api/v1/video/retrieve: upstream', 503, {});
    if (a === GONE) throw new VeniceRequestError('Venice API error 404 on /api/v1/video/retrieve: not found', 404, {});
    return { contentType: 'application/json', value: structuredClone(a) };
  };
  return {
    async post(path, body) {
      events.push(`POST ${path} ${labeler(body)}`);
      if (path === '/api/v1/video/queue') {
        const step = queue[queued];
        queued += 1;
        if (step) throw step();
        const n = [...perQueue.keys()].length + 1;
        const queueId = `q-${n}`;
        perQueue.set(queueId, 0);
        return { queue_id: queueId, model: body.model };
      }
      if (path === '/api/v1/video/complete') return {};
      throw new Error(`stub: unexpected POST ${path}`);
    },
    async postBinaryOrJson(path, body) {
      events.push(`POST ${path} ${labeler(body)}`);
      if (path !== '/api/v1/video/retrieve') throw new Error(`stub: unexpected POST ${path}`);
      const n = perQueue.get(body.queue_id) ?? 0;
      perQueue.set(body.queue_id, n + 1);
      const script = retrieve[body.queue_id] ?? retrieve['*'] ?? [P, R];
      return answer(script[Math.min(n, script.length - 1)]);
    },
    async postBinary(path, body) {
      events.push(`POST ${path} ${labeler(body)}`);
      if (path === '/api/v1/audio/speech') return Buffer.from(TONES['tts-3s.mp3']);
      throw new Error(`stub: unexpected POST ${path}`);
    },
  };
}

// ---- capture -------------------------------------------------------------------

function makeNormalizer(root) {
  const forms = [...new Set([root, realpathSync(root)])].sort((a, b) => b.length - a.length);
  const cfgForms = [...new Set([CFG, process.env.VENICE_VIDEO_CONFIG_DIR])];
  return (s) => {
    let out = String(s);
    for (const f of forms) out = out.replaceAll(f, '<P>');
    for (const f of cfgForms) out = out.replaceAll(f, '<CFG>');
    out = out.replaceAll(FIX, '<FIX>').replaceAll(WORK, '<WORK>');
    return out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<T>');
  };
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Labels a data: URI by the project file whose bytes it carries. */
function makeLabeler(root, norm) {
  const index = () => {
    const map = new Map();
    for (const f of walk(root)) map.set(sha(readFileSync(f)), relative(root, f));
    return map;
  };
  return (body) => JSON.stringify(body, (_k, v) => {
    if (typeof v !== 'string' || !v.startsWith('data:')) return typeof v === 'string' ? norm(v) : v;
    const comma = v.indexOf(',');
    const head = v.slice(0, comma);
    const bytes = Buffer.from(v.slice(comma + 1), 'base64');
    const h = sha(bytes);
    const label = index().get(h) ?? (clipBySha.get(h) && `clip:${clipBySha.get(h)}`)
      ?? (toneBySha.get(h) && `fixture:${toneBySha.get(h)}`) ?? `unmatched(${bytes.length})`;
    return `${head},<${label}>`;
  });
}

function roundSecs(value) {
  return JSON.parse(JSON.stringify(value), (k, v) => (typeof v === 'number' && /sec$/i.test(k) ? Math.round(v * 10) / 10 : v));
}

function snapshotFiles(root, norm, before) {
  const out = {};
  for (const abs of walk(root).sort()) {
    const rel = relative(root, abs);
    const buf = readFileSync(abs);
    if (before.get(rel) === sha(buf)) continue; // untouched input
    let entry;
    if (rel.endsWith('.json')) {
      try { entry = roundSecs(JSON.parse(norm(buf.toString('utf-8')))); } catch { entry = norm(buf.toString('utf-8')); }
    } else if (rel.endsWith('.log')) {
      entry = norm(buf.toString('utf-8')).replace(/"[A-Za-z0-9+/=]{200,}"/g, '"<b64>"');
    } else {
      const h = sha(buf);
      if (clipBySha.has(h)) entry = `clip:${clipBySha.get(h)}`;
      else if (toneBySha.has(h)) entry = `fixture:${toneBySha.get(h)}`;
      else if (/\.(mp4|mp3|wav)$/.test(rel)) entry = `media ~${ffprobeSec(abs)}s`;
      else entry = `bytes(${buf.length > 0 ? 'non-empty' : 'empty'})`;
    }
    out[rel] = entry;
  }
  return out;
}

function pendingJobs(norm) {
  const path = getJobStorePath();
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  for (const job of raw.jobs ?? []) job.pid = job.pid === process.pid ? '<this pid>' : '<other pid>';
  return JSON.parse(norm(JSON.stringify(raw)));
}

/** Run `fn` with console, stdout writes and timers captured into `events`. */
async function capture(events, norm, fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error, write: process.stdout.write, setTimeout: globalThis.setTimeout };
  for (const k of ['log', 'warn', 'error']) console[k] = (...a) => events.push(`${k}: ${norm(a.map(String).join(' '))}`);
  process.stdout.write = function (chunk, ...rest) {
    if (typeof chunk === 'string') { events.push(`stdout: ${JSON.stringify(norm(chunk))}`); return true; }
    return saved.write.call(this, chunk, ...rest);
  };
  globalThis.setTimeout = (cb, ms, ...args) => {
    if (typeof ms === 'number' && ms >= 1000) events.push(`sleep ${ms}`);
    return saved.setTimeout(cb, 0, ...args);
  };
  try {
    return await fn();
  } finally {
    Object.assign(console, { log: saved.log, warn: saved.warn, error: saved.error });
    process.stdout.write = saved.write;
    globalThis.setTimeout = saved.setTimeout;
  }
}

async function runCase(c) {
  writeFileSync(getJobStorePath(), JSON.stringify({ version: 1, jobs: [] }));
  const project = buildProject(c.id, c.project);
  const root = project.series.outputDir;
  const norm = makeNormalizer(root);
  const labeler = makeLabeler(root, norm);
  const before = new Map(walk(root).map(f => [relative(root, f), sha(readFileSync(f))]));
  const events = [];
  const client = stubClient(events, labeler, c.client);
  if (c.setup) await c.setup(project);
  let outcome;
  try {
    const value = await capture(events, norm, () => c.run(client, project));
    outcome = { ok: JSON.parse(norm(JSON.stringify(value ?? null))) };
  } catch (e) {
    outcome = { error: `${e?.name}: ${norm(e?.message ?? e)}` };
  } finally {
    if (c.teardown) c.teardown(project);
  }
  return {
    events,
    outcome: roundSecs(outcome),
    pendingJobs: pendingJobs(norm),
    files: snapshotFiles(root, norm, before),
  };
}

const runEpisode = (client, { series, script, sceneDir }) => {
  const plan = buildGenerationPlan(script, series);
  return generateEpisodeVideos(client, series, script.shots, sceneDir, plan, script.audioMix).then(({ videoPaths, plan: p }) => ({
    videoPaths,
    units: p.units.map(u => ({ unitId: u.unitId, unitType: u.unitType, model: u.model, renderedDurationSec: u.renderedDurationSec, segments: u.segments })),
  }));
};

const STANDARD = { montageMode: false };
const recordJob = (queueId, file = 'shot-001.mp4') => async ({ series, sceneDir }) => {
  await recordPendingJob({ kind: 'video', model: 'seedance-2-5-reference-to-video', queueId, outputPath: join(sceneDir, file), project: series.outputDir, prompt: 'earlier' });
};

const CASES = [
  { id: 'single-r2v', project: { videoDefaults: STANDARD, shots: [shot(1)] }, run: runEpisode },
  {
    id: 'i2v-chain-and-end-target',
    project: {
      videoDefaults: {
        ...STANDARD,
        actionModel: 'kling-v3-pro-image-to-video',
        atmosphereModel: 'kling-v3-pro-image-to-video',
        characterConsistencyModel: 'kling-v3-pro-image-to-video',
      },
      shots: [
        shot(1, { mustStaySingle: true, location: undefined, description: 'MARA floats to the window.', transition: 'DISSOLVE' }),
        shot(2, { mustStaySingle: true, location: undefined, description: 'MARA watches Earth rise.' }),
      ],
    },
    run: runEpisode,
  },
  {
    id: 'multishot-split',
    project: { videoDefaults: STANDARD, shots: [shot(1), shot(2, { description: 'Shot 2: MARA flips a switch.' })] },
    run: runEpisode,
  },
  {
    id: 'montage-cut',
    project: { shots: [shot(1), shot(2, { description: 'Shot 2: MARA flips a switch.', characters: ['MARA', 'JUNO'] })] },
    run: runEpisode,
  },
  {
    id: 'lipsync-keyframe-prepass',
    project: {
      videoDefaults: { ...STANDARD, audioStrategy: 'lip-sync', lipSyncModel: 'wan-2-7-image-to-video' },
      shots: [shot(1, { type: 'dialogue', motion: 'low', dialogue: { character: 'MARA', line: 'Capsule, do you copy?' } })],
      files: { 'episodes/episode-001/audio/dialogue-shot-001.mp3': TONES['dialogue-2s.mp3'] },
    },
    run: runEpisode,
  },
  {
    id: 'lipsync-inline-tts',
    project: {
      videoDefaults: { ...STANDARD, audioStrategy: 'lip-sync', lipSyncModel: 'wan-2-7-image-to-video', seedanceKeyframeForWan: false },
      shots: [shot(1, { type: 'dialogue', motion: 'low', dialogue: { character: 'MARA', line: 'Capsule, do you copy?' } })],
    },
    run: runEpisode,
  },
  {
    id: 'voice-reference',
    project: {
      videoDefaults: STANDARD,
      characters: [{ ...MARA, voiceReferencePath: 'characters/mara/voice-reference.mp3' }, JUNO],
      shots: [shot(1, { type: 'dialogue', dialogue: { character: 'MARA', line: 'Capsule, do you copy?' } })],
      files: { 'characters/mara/voice-reference.mp3': TONES['voice-4s.mp3'] },
    },
    run: runEpisode,
  },
  {
    id: 'faces-off-twin-swap',
    project: { videoDefaults: { ...STANDARD, characterConsistencyModel: 'seedance-2-0-reference-to-video-basic', actionModel: 'seedance-2-0-reference-to-video-basic' }, shots: [shot(1)] },
    run: runEpisode,
  },
  {
    id: 'faces-off-refused',
    project: {
      videoDefaults: { ...STANDARD, atmosphereModel: 'seedance-2-0-image-to-video-basic', actionModel: 'seedance-2-0-image-to-video-basic' },
      shots: [shot(1, { characters: [], location: undefined, type: 'establishing', videoModel: 'atmosphere', description: 'A face on a poster.' })],
      files: { 'episodes/episode-001/scene-001/shot-001.provenance.json': JSON.stringify({ generationModel: 'nano-banana-2', hasFace: true }) },
    },
    run: runEpisode,
  },
  {
    id: 'reattach-ready',
    project: { videoDefaults: STANDARD, shots: [shot(1)] },
    setup: recordJob('q-recorded'),
    client: { retrieve: { 'q-recorded': [R] } },
    run: runEpisode,
  },
  {
    id: 'reattach-gone-requeue',
    project: { videoDefaults: STANDARD, shots: [shot(1)] },
    setup: recordJob('q-recorded'),
    client: { retrieve: { 'q-recorded': [GONE], '*': [P, R] } },
    run: runEpisode,
  },
  {
    id: 'failed',
    project: { videoDefaults: STANDARD, shots: [shot(1)] },
    client: { retrieve: { '*': [P, F] } },
    run: runEpisode,
  },
  {
    id: 'poll-errors-then-ready',
    project: { videoDefaults: STANDARD, shots: [shot(1)] },
    client: { retrieve: { '*': [E, E, P, R] } },
    run: runEpisode,
  },
  {
    id: 'existing-clip-skip',
    project: { videoDefaults: STANDARD, shots: [shot(1)], files: { 'episodes/episode-001/scene-001/shot-001.mp4': CLIPS['clip-6s'] } },
    run: runEpisode,
  },
  {
    id: 'missing-panel-skip',
    project: {
      videoDefaults: { ...STANDARD, atmosphereModel: 'kling-v3-pro-image-to-video' },
      shots: [shot(1, { characters: [], location: undefined, type: 'establishing', videoModel: 'atmosphere', description: 'Empty corridor.' })],
      omit: ['episodes/episode-001/scene-001/shot-001.png'],
    },
    run: runEpisode,
  },
  {
    id: 'multishot-retry-after-queue-5xx',
    project: { videoDefaults: STANDARD, shots: [shot(1), shot(2, { description: 'Shot 2: MARA flips a switch.' })] },
    client: { queue: [err.e500] },
    run: runEpisode,
  },
  (() => {
    // Ctrl-C lands while the first multi-shot attempt is failing: the unit
    // must stop, not retry the cancelled operation every 15s.
    const controller = new AbortController();
    return {
      id: 'multishot-cancel-during-retry',
      project: { videoDefaults: STANDARD, shots: [shot(1), shot(2, { description: 'Shot 2: MARA flips a switch.' })] },
      client: { queue: [() => { controller.abort(); return err.e500(); }] },
      run: (client, project) => runInOperation({ signal: controller.signal }, () => runEpisode(client, project)),
    };
  })(),
  {
    id: 'consent-409',
    project: { videoDefaults: STANDARD, shots: [shot(1)] },
    client: { queue: [err.consent] },
    run: runEpisode,
  },
  {
    id: 'refusal-unrefunded',
    project: { videoDefaults: STANDARD, shots: [shot(1)] },
    client: { queue: [err.unrefunded] },
    run: runEpisode,
  },
  {
    id: 'render-file-unwritable-output',
    project: { videoDefaults: STANDARD, shots: [shot(1)] },
    setup: ({ series }) => {
      const dir = join(series.outputDir, 'locked');
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o555);
    },
    teardown: ({ series }) => chmodSync(join(series.outputDir, 'locked'), 0o755),
    run: (client, { series }) => renderVideoFile(client, {
      prompt: { model: 'seedance-2-5-text-to-video', prompt: 'a lighthouse at dusk', duration: '5s', audio: true },
      outputPath: join(series.outputDir, 'locked', 'out.mp4'),
      aspectRatio: '16:9',
      project: series.outputDir,
    }),
  },
];

test('generation loop golden: every lane, byte for byte', async () => {
  const actual = {};
  for (const c of CASES) actual[c.id] = await runCase(c);
  if (update) {
    mkdirSync(dirname(goldenPath), { recursive: true });
    writeFileSync(goldenPath, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  const golden = JSON.parse(readFileSync(goldenPath, 'utf-8'));
  assert.deepEqual(Object.keys(actual), Object.keys(golden), 'case list');
  for (const id of Object.keys(golden)) {
    assert.deepEqual(actual[id], golden[id], `case ${id}`);
  }
});

test('generation loop golden: no case reached the network or a real key', () => {
  assert.equal(process.env.VENICE_API_KEY, '');
  assert.ok(statSync(CFG).isDirectory());
});
