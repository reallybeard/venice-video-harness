// Preload for tests that spawn the CLI through an image-generation path.
// Answers POST /image/generate with one seeded-noise PNG (large enough to pass
// the silent-reject check) and appends each request body, as one JSON line, to
// $FAKE_VENICE_IMAGE_LOG. Any other Venice path falls through to the
// no-venice-network guard, which fails the process.

import { appendFileSync } from 'node:fs';
import sharp from 'sharp';

const log = process.env.FAKE_VENICE_IMAGE_LOG;
const noise = Buffer.alloc(320 * 180 * 3);
for (let i = 0, s = 1; i < noise.length; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; noise[i] = (s >>> 16) & 0xff; }
const png = (await sharp(noise, { raw: { width: 320, height: 180, channels: 3 } }).png().toBuffer()).toString('base64');

const guarded = globalThis.fetch;
globalThis.fetch = async function fakeVeniceImages(input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (/(^|\.)venice\.ai$/i.test(url.hostname) && url.pathname.endsWith('/image/generate')) {
    if (log) appendFileSync(log, `${JSON.stringify({ path: url.pathname, body: JSON.parse(String(init?.body ?? '{}')) })}\n`);
    return new Response(JSON.stringify({ images: [png] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return guarded(input, init);
};
