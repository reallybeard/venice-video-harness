// Preload for tests/qa-loops-golden.test.mjs: replaces VeniceClient's HTTP
// with scripted replies so `qa-storyboard` / `qa-videos` run end to end with
// no network. `fetch` is blocked outright, so nothing can reach Venice even if
// a code path bypasses `post`.
//
//   QA_STUB_SCRIPT  JSON: [{ when: { model?, text? }, reply: string | { error, status? } }]
//                   first unconsumed rule whose model equals the request's and
//                   whose `text` occurs in the last user message wins.
//   QA_STUB_LOG     JSONL: one line per request (model, max_tokens,
//                   temperature, messages with images replaced by labels).
//
// Image labels: fixture files start with `FIXTURE:` and are labelled by their
// text; anything else is decoded with sharp and labelled by the nearest
// palette colour, so frames ffmpeg extracts from the test clips are named by
// the clip they came from, independent of encoder byte details.

import { appendFileSync, readFileSync } from 'node:fs';
import sharp from 'sharp';
import { VeniceClient, VeniceRequestError } from '../../../dist/venice/client.js';

globalThis.fetch = async () => { throw new Error('network blocked by the QA golden stub'); };

const rules = JSON.parse(readFileSync(process.env.QA_STUB_SCRIPT, 'utf-8')).map(r => ({ ...r, used: false }));
const logPath = process.env.QA_STUB_LOG;

const PALETTE = {
  dark: [0x20, 0x20, 0x20],
  mid: [0x58, 0x58, 0x58],
  gray: [0x60, 0x60, 0x60],
  red: [0xa0, 0x40, 0x40],
  blue: [0x40, 0x70, 0xa0],
  light: [0xe0, 0xe0, 0xe0],
};

async function labelImage(url) {
  const bytes = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  const prefix = url.slice(0, url.indexOf(','));
  const text = bytes.subarray(0, 8).toString('latin1');
  if (text === 'FIXTURE:') return `${prefix}|${bytes.toString('utf-8')}`;
  const { channels } = await sharp(bytes).stats();
  const mean = channels.slice(0, 3).map(c => c.mean);
  let best = 'unknown';
  let bestDist = Infinity;
  for (const [name, rgb] of Object.entries(PALETTE)) {
    const d = rgb.reduce((acc, v, i) => acc + (v - mean[i]) ** 2, 0);
    if (d < bestDist) { bestDist = d; best = name; }
  }
  return `${prefix}|frame:${best}`;
}

async function normalizeMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      const content = [];
      for (const part of m.content) {
        if (part.type === 'image_url') content.push({ type: 'image_url', image: await labelImage(part.image_url.url) });
        else content.push(part);
      }
      out.push({ role: m.role, content });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function lastUserText(messages) {
  const user = [...messages].reverse().find(m => m.role === 'user');
  if (!user) return '';
  if (typeof user.content === 'string') return user.content;
  return user.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
}

VeniceClient.prototype.post = async function stubPost(path, body) {
  if (path !== '/api/v1/chat/completions') throw new Error(`QA golden stub: unexpected POST ${path}`);
  const snapshot = JSON.parse(JSON.stringify(body));
  const { messages, ...rest } = snapshot;
  appendFileSync(logPath, `${JSON.stringify({ path, ...rest, messages: await normalizeMessages(messages) })}\n`);

  // Match against the FIRST user message (the QA prompt), so a corrective
  // re-ask is matched by the rule for the call it corrects.
  const firstUser = snapshot.messages.find(m => m.role === 'user');
  const text = lastUserText([firstUser]);
  const rule = rules.find(r => !r.used
    && (r.when.model === undefined || r.when.model === snapshot.model)
    && (r.when.text === undefined || text.includes(r.when.text)));
  if (!rule) throw new Error(`QA golden stub: no scripted reply for ${snapshot.model}: ${text.slice(0, 80)}`);
  rule.used = true;
  if (typeof rule.reply === 'object' && rule.reply !== null && 'error' in rule.reply) {
    throw new VeniceRequestError(rule.reply.error, rule.reply.status ?? 500, { error: rule.reply.error });
  }
  return { choices: [{ message: { content: rule.reply } }] };
};

process.env.VENICE_API_KEY = 'qa-golden-stub-key';
