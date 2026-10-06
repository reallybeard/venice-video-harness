// Preload for tests that spawn the CLI through an image path. Answers
// POST /image/generate with one seeded-noise PNG and POST /image/multi-edit
// with the same PNG as raw bytes (both large enough to pass the silent-reject
// check), and appends each request body, as one JSON line, to
// $FAKE_VENICE_IMAGE_LOG. Any other Venice path falls through to the
// no-venice-network guard, which fails the process.
//
// Opt-in, for tests that send images back:
//   FAKE_VENICE_IMAGE_VARY=1   every reply is a different seeded PNG, so each
//                              written file has its own bytes
//   FAKE_VENICE_IMAGE_ROOT=dir each data: image in a logged body is replaced by
//                              `<image a.png = b.png>`, the files under `dir`
//                              (relative, sorted) with exactly those bytes

import { appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import sharp from 'sharp';

const log = process.env.FAKE_VENICE_IMAGE_LOG;
const vary = process.env.FAKE_VENICE_IMAGE_VARY === '1';
const root = process.env.FAKE_VENICE_IMAGE_ROOT;

async function noisePng(seed) {
  const noise = Buffer.alloc(320 * 180 * 3);
  for (let i = 0, s = seed; i < noise.length; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; noise[i] = (s >>> 16) & 0xff; }
  return sharp(noise, { raw: { width: 320, height: 180, channels: 3 } }).png().toBuffer();
}

const fixed = await noisePng(1);
let replies = 0;
const nextPng = async () => (vary ? noisePng(1000 + ++replies) : fixed);

function filesUnder(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : /\.(png|webp|jpe?g)$/i.test(name) ? [path] : [];
  });
}

function labelImage(uri) {
  if (!root || typeof uri !== 'string' || !uri.startsWith('data:')) return uri;
  const data = uri.slice(uri.indexOf(',') + 1);
  const matches = filesUnder(root)
    .filter(path => readFileSync(path).toString('base64') === data)
    .map(path => relative(root, path))
    .sort();
  return `<image ${matches.length ? matches.join(' = ') : 'unknown'}>`;
}

function record(path, body) {
  if (!log) return;
  const labeled = Array.isArray(body.images) ? { ...body, images: body.images.map(labelImage) } : body;
  appendFileSync(log, `${JSON.stringify({ path, body: labeled })}\n`);
}

const guarded = globalThis.fetch;
globalThis.fetch = async function fakeVeniceImages(input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (/(^|\.)venice\.ai$/i.test(url.hostname) && url.pathname.endsWith('/image/generate')) {
    record(url.pathname, JSON.parse(String(init?.body ?? '{}')));
    const png = await nextPng();
    return new Response(JSON.stringify({ images: [png.toString('base64')] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (/(^|\.)venice\.ai$/i.test(url.hostname) && url.pathname.endsWith('/image/multi-edit')) {
    record(url.pathname, JSON.parse(String(init?.body ?? '{}')));
    const png = await nextPng();
    return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
  }
  return guarded(input, init);
};
