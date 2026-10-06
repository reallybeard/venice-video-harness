// `ShotTake` / `ApprovalBinding`: per-take history and the one approval
// binding, as optional additions to `ShotScript` (plan-schema-additions.md
// §1–§2). Type-only on this branch: nothing in the CLI writes `takes[]` yet.
//
// Three things to hold: (1) the shapes compile exactly as the spec writes
// them, and `ShotApproval` in panel-approval.ts is the same type as core's
// `ApprovalBinding`; (2) a script with `takes` / `currentTakeId` /
// `panelReview` round-trips through saveEpisodeScript / loadEpisodeScript
// and a series around it through saveSeries / loadSeries, byte-for-byte on
// those fields; (3) a script without them is untouched (no key is invented).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { saveSeries, loadSeries, saveEpisodeScript, loadEpisodeScript } from '../dist/series/manager.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- Fixtures --------------------------------------------------------------

function makeSeries(outputDir) {
  return {
    name: 'Takes', slug: 'takes', concept: 'c', genre: 'drama', setting: 's', outputDir,
    aesthetic: { style: 'Cinematic photography', palette: 'warm amber', lighting: 'natural', lensCharacteristics: 'shallow', filmStock: 'digital' },
    storyboardAspectRatio: '16:9',
    videoDefaults: { actionModel: 'seedance-2-5-reference-to-video', atmosphereModel: 'seedance-2-5-reference-to-video' },
    characters: [],
    locations: [],
    episodes: [{ number: 1, title: 'Takes', status: 'scripted' }],
    createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z',
  };
}

const BINDING = { panelSha256: 'a'.repeat(64), settingsDigest: 'b'.repeat(64) };

const TAKE_RENDERED = {
  id: 'take-1',
  createdAt: '2026-10-05T01:00:00.000Z',
  recipe: {
    prompt: 'ARIA walks in. @Image1 is ARIA.',
    negativePrompt: 'blurry',
    duration: '5s',
    resolution: '720p',
    aspectRatio: '16:9',
    audio: false,
    referenceImages: ['characters/aria/front.png', 'locations/street/north.png'],
    referenceAudio: ['characters/aria/voice-reference.mp3'],
    sceneImages: [],
  },
  model: 'seedance-2-5-reference-to-video',
  seed: 42,
  outputPath: 'episodes/episode-001/scene-001/shot-001.mp4',
  queueId: 'q-123',
  costUsd: 0.42,
  status: 'rendered',
  qa: { score: 0.9, passed: true, issues: [], summary: 'Clean.', model: 'qwen3-vl-235b' },
  review: { status: 'approved', at: '2026-10-05T02:00:00.000Z', note: 'ship it', settingsDigest: BINDING.settingsDigest },
};

const TAKE_FAILED = {
  id: 'take-0',
  createdAt: '2026-10-05T00:30:00.000Z',
  model: 'seedance-2-5-reference-to-video',
  status: 'failed',
  failure: { kind: 'content-policy', status: '422', detail: 'provider_content_policy', refunded: true },
};

const PANEL_REVIEW = {
  binding: BINDING,
  verdict: 'passed',
  reviewer: 'qwen3-vl-235b',
  summary: 'Matches the description.',
  approvedBy: 'chris',
  approvalReason: 'looks right',
  approvedAt: '2026-10-05T00:45:00.000Z',
  reviewedAt: '2026-10-05T00:40:00.000Z',
};

const BASE_SHOT = {
  shotNumber: 1, type: 'action', duration: '5s', videoModel: 'action', environment: 'DAY_EXTERIOR',
  description: 'ARIA walks in.', characters: ['ARIA'], dialogue: null, sfx: null, cameraMovement: 'static', transition: 'CUT',
};

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'takes-approval-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---- Shapes compile as written -------------------------------------------

test('the §1–§2 types compile exactly as specified, and ShotApproval is ApprovalBinding', () => {
  const s = scratch();
  try {
    // A fixture that assigns every spec field with its spec type, plus a
    // mutual-assignability check between ShotApproval and ApprovalBinding.
    // Any renamed / missing / retyped field is a compile error here.
    const fixture = `
import type {
  ShotTake, TakeRecipe, TakeQA, TakeReview, ApprovalBinding, PanelReview, ShotScript,
} from '${join(repoRoot, 'packages/core/dist/index.js').replace(/\\/g, '/')}';
import type { ShotApproval } from '${join(repoRoot, 'dist/mini-drama/panel-approval.js').replace(/\\/g, '/')}';

const binding: ApprovalBinding = { panelSha256: 'p', settingsDigest: 's' };
const asShotApproval: ShotApproval = binding;
const backToBinding: ApprovalBinding = asShotApproval;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same: Same<ShotApproval, ApprovalBinding> = true;

const recipe: TakeRecipe = {
  prompt: 'p', negativePrompt: 'n', duration: '5s', resolution: '720p', aspectRatio: '16:9', audio: true,
  referenceImages: ['a'], startFrame: 'sf', endFrame: 'ef', audioUrl: 'au', referenceAudio: ['ra'],
  elements: [{ frontal: 'f', angles: ['a1'] }], sceneImages: ['si'],
};
const qa: TakeQA = { score: 1, passed: true, issues: [], summary: 's', model: 'm' };
const review: TakeReview = { status: 'approved', at: 't', note: 'n', settingsDigest: 'd' };
const failure: ShotTake['failure'] = { kind: 'k', status: '422', detail: 'd', refunded: true };
const statuses: Array<ShotTake['status']> = ['queued', 'rendered', 'failed', 'rejected'];
const take: ShotTake = {
  id: 'i', createdAt: 't', recipe, model: 'm', seed: 1, outputPath: 'o', queueId: 'q', costUsd: 0.1,
  status: 'rendered', failure, qa, review,
};
const minimalTake: ShotTake = { id: 'i', createdAt: 't', model: 'm', status: 'queued' };
const verdicts: Array<PanelReview['verdict']> = ['passed', 'failed', 'unchecked', 'error'];
const panelReview: PanelReview = {
  binding, verdict: 'passed', reviewer: 'r', summary: 's', approvedBy: 'a', approvalReason: 'ar', approvedAt: 't', reviewedAt: 't',
};
const minimalPanelReview: PanelReview = { binding, verdict: 'unchecked', reviewer: 'r', summary: 's', reviewedAt: 't' };
const shotFields: Pick<ShotScript, 'takes' | 'currentTakeId' | 'panelReview'> = {
  takes: [take, minimalTake], currentTakeId: take.id, panelReview,
};
const shotWithout: Pick<ShotScript, 'takes' | 'currentTakeId' | 'panelReview'> = {};

// Negative checks: these must NOT compile, so they are wrapped in @ts-expect-error.
// @ts-expect-error review status is only 'approved'
const badReview: TakeReview = { status: 'rejected', at: 't', settingsDigest: 'd' };
// @ts-expect-error status ladder is closed
const badTake: ShotTake = { id: 'i', createdAt: 't', model: 'm', status: 'done' };
// @ts-expect-error createdAt is an ISO string, not reference seconds
const badTime: ShotTake = { id: 'i', createdAt: 123, model: 'm', status: 'queued' };

void [backToBinding, same, statuses, verdicts, minimalPanelReview, shotFields, shotWithout, badReview, badTake, badTime];
`;
    writeFileSync(join(s.dir, 'fixture.ts'), fixture);
    const tsc = join(repoRoot, 'node_modules', '.bin', 'tsc');
    const r = spawnSync(tsc, [
      '--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022',
      '--skipLibCheck', '--types', 'node', '--typeRoots', join(repoRoot, 'node_modules', '@types'),
      join(s.dir, 'fixture.ts'),
    ], { encoding: 'utf-8', cwd: s.dir });
    assert.equal(r.status, 0, `tsc failed:\n${r.stdout}\n${r.stderr}`);
  } finally {
    s.cleanup();
  }
});

// ---- Round trip with takes ------------------------------------------------

test('a shot with takes / currentTakeId / panelReview round-trips through saveEpisodeScript / loadEpisodeScript', async () => {
  const s = scratch();
  try {
    const series = makeSeries(s.dir);
    const shot = { ...BASE_SHOT, takes: [TAKE_FAILED, TAKE_RENDERED], currentTakeId: 'take-1', panelReview: PANEL_REVIEW };
    const script = { episode: 1, title: 'Takes', seriesName: 'Takes', totalDuration: '5s', status: 'approved', shots: [shot] };

    await saveSeries(series);
    const path = await saveEpisodeScript(series, script);

    const loadedSeries = await loadSeries(s.dir);
    assert.ok(loadedSeries);
    assert.equal(loadedSeries.slug, 'takes');

    const loaded = await loadEpisodeScript(loadedSeries, 1);
    assert.ok(loaded);
    assert.equal(loaded.shots.length, 1);
    assert.deepEqual(loaded.shots[0].takes, [TAKE_FAILED, TAKE_RENDERED]);
    assert.equal(loaded.shots[0].currentTakeId, 'take-1');
    assert.deepEqual(loaded.shots[0].panelReview, PANEL_REVIEW);
    // The panel review's binding is the same two facts qa-approved.json stores.
    assert.deepEqual(Object.keys(loaded.shots[0].panelReview.binding).sort(), ['panelSha256', 'settingsDigest']);
    // Order of takes is preserved (oldest first as written).
    assert.deepEqual(loaded.shots[0].takes.map(t => t.id), ['take-0', 'take-1']);

    // And the on-disk JSON holds the fields verbatim: no normalisation at the load point.
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    assert.deepEqual(raw.shots[0].takes, [TAKE_FAILED, TAKE_RENDERED]);
  } finally {
    s.cleanup();
  }
});

// ---- Round trip without takes ---------------------------------------------

test('a shot without takes round-trips unchanged: no takes / currentTakeId / panelReview key is invented', async () => {
  const s = scratch();
  try {
    const series = makeSeries(s.dir);
    const script = { episode: 1, title: 'Takes', seriesName: 'Takes', totalDuration: '5s', status: 'draft', shots: [{ ...BASE_SHOT }] };

    await saveSeries(series);
    const path = await saveEpisodeScript(series, script);
    const loaded = await loadEpisodeScript(await loadSeries(s.dir), 1);

    assert.ok(loaded);
    assert.deepEqual(loaded.shots[0], BASE_SHOT);
    assert.equal('takes' in loaded.shots[0], false);
    assert.equal('currentTakeId' in loaded.shots[0], false);
    assert.equal('panelReview' in loaded.shots[0], false);

    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    assert.deepEqual(Object.keys(raw.shots[0]).sort(), Object.keys(BASE_SHOT).sort());
  } finally {
    s.cleanup();
  }
});

// ---- Series doc survives a save/load cycle with takes on disk alongside ----

test('saveSeries / loadSeries round-trips a series whose episode holds takes, and the series doc itself is unchanged', async () => {
  const s = scratch();
  try {
    const series = makeSeries(s.dir);
    mkdirSync(join(s.dir, 'episodes', 'episode-001'), { recursive: true });
    await saveSeries(series);
    await saveEpisodeScript(series, { episode: 1, title: 'Takes', seriesName: 'Takes', totalDuration: '5s', shots: [{ ...BASE_SHOT, takes: [TAKE_RENDERED], currentTakeId: 'take-1' }] });

    const first = await loadSeries(s.dir);
    await saveSeries(first);
    const second = await loadSeries(s.dir);

    const { updatedAt: _a, ...firstRest } = first;
    const { updatedAt: _b, ...secondRest } = second;
    assert.deepEqual(secondRest, firstRest);
    // takes never leak into series.json: they belong to the episode script.
    assert.equal(JSON.stringify(second).includes('take-1'), false);
  } finally {
    s.cleanup();
  }
});
