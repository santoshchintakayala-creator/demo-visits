// Storage: Upstash Redis over its REST API (no client library needed).
// Works with the variable names Vercel's Upstash integration creates
// (KV_REST_API_URL / KV_REST_API_TOKEN) and Upstash's own
// (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
// Without Redis, Vercel Blob (BLOB_READ_WRITE_TOKEN, private store) is used:
// each beacon is one small file, and reading the dashboard folds new files into
// one log file per demo. With neither set it falls back to memory (local use).
import * as blob from '@vercel/blob';

export const MAX_EVENTS_PER_SITE = 50000;

const memory = { lists: new Map(), hashes: new Map(), sets: new Map(), counters: new Map() };

function config() {
  const env = process.env;
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || '';
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || '';
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

export function mode() {
  return config() ? 'redis' : process.env.BLOB_READ_WRITE_TOKEN ? 'blob' : 'memory';
}

async function pipeline(commands) {
  const cfg = config();
  if (!cfg) return commands.map(runMemory);
  const res = await fetch(`${cfg.url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!res.ok) throw new Error(`Redis ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const out = await res.json();
  return out.map((r) => {
    if (r.error) throw new Error(`Redis: ${r.error}`);
    return r.result;
  });
}

function runMemory([cmd, key, ...args]) {
  const c = cmd.toUpperCase();
  const list = () => { if (!memory.lists.has(key)) memory.lists.set(key, []); return memory.lists.get(key); };
  const hash = () => { if (!memory.hashes.has(key)) memory.hashes.set(key, new Map()); return memory.hashes.get(key); };
  const set = () => { if (!memory.sets.has(key)) memory.sets.set(key, new Set()); return memory.sets.get(key); };
  switch (c) {
    case 'LPUSH': { const l = list(); for (const v of args) l.unshift(v); return l.length; }
    case 'LTRIM': { const l = list(); const [s, e] = args.map(Number); memory.lists.set(key, l.slice(s, e + 1)); return 'OK'; }
    case 'LRANGE': { const l = list(); const [s, e] = args.map(Number); return l.slice(s, e === -1 ? undefined : e + 1); }
    case 'LLEN': return list().length;
    case 'DEL': { let n = 0; for (const k of [key, ...args]) for (const m of Object.values(memory)) if (m.delete(k)) n++; return n; }
    case 'HSET': { const h = hash(); for (let i = 0; i < args.length; i += 2) h.set(args[i], args[i + 1]); return 1; }
    case 'HDEL': { const h = hash(); let n = 0; for (const f of args) if (h.delete(f)) n++; return n; }
    case 'HGETALL': { const h = hash(); return [...h].flat(); }
    case 'SADD': { const s = set(); for (const v of args) s.add(v); return 1; }
    case 'SMEMBERS': return [...set()];
    case 'INCR': { const v = (memory.counters.get(key) || 0) + 1; memory.counters.set(key, v); return v; }
    case 'EXPIRE': return 1;
    default: throw new Error(`memory store: ${c} not supported`);
  }
}

const k = {
  events: (site) => `dv:ev:${site}`,
  sites: 'dv:sites',
  links: 'dv:links',
  rate: (bucket) => `dv:rl:${bucket}`
};

async function redis_addEvent(site, event) {
  const list = Array.isArray(event) ? event : [event];
  await pipeline([
    ['LPUSH', k.events(site), ...list.map((e) => JSON.stringify(e))],
    ['LTRIM', k.events(site), '0', String(MAX_EVENTS_PER_SITE - 1)],
    ['SADD', k.sites, site]
  ]);
}

async function redis_getEvents(site, limit = 10000) {
  const [rows] = await pipeline([['LRANGE', k.events(site), '0', String(limit - 1)]]);
  return (rows || []).map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}

async function redis_clearEvents(site) {
  await pipeline([['DEL', k.events(site)]]);
}

async function redis_getSites() {
  const [sites] = await pipeline([['SMEMBERS', k.sites]]);
  return (sites || []).sort();
}

async function redis_getLinks() {
  const [flat] = await pipeline([['HGETALL', k.links]]);
  const out = {};
  const arr = Array.isArray(flat) ? flat : Object.entries(flat || {}).flat();
  for (let i = 0; i < arr.length; i += 2) { try { out[arr[i]] = JSON.parse(arr[i + 1]); } catch {} }
  return out;
}

async function redis_saveLink(link) {
  await pipeline([['HSET', k.links, link.code, JSON.stringify(link)], ['SADD', k.sites, link.site]]);
}

async function redis_deleteLink(code) {
  await pipeline([['HDEL', k.links, code]]);
}

// Fixed-window counter; returns true while under the limit.
async function redis_underLimit(bucket, limit, windowSec) {
  const win = Math.floor(Date.now() / 1000 / windowSec);
  const key = k.rate(`${bucket}:${win}`);
  const [count] = await pipeline([['INCR', key], ['EXPIRE', key, String(windowSec * 2)]]);
  return Number(count) <= limit;
}

// ---------------- Vercel Blob backend ----------------
const B = {
  log: (site) => `dv/log/${site}.json`,
  ev: (site) => `dv/ev/${site}/`,
  links: 'dv/links.json'
};

async function bRead(path) {
  let r;
  try { r = await blob.get(path, { access: 'private', useCache: false }); }
  catch (e) { if (e instanceof blob.BlobNotFoundError) return null; throw e; }
  if (!r || r.statusCode !== 200) return null;
  try { return JSON.parse(await new Response(r.stream).text()); } catch { return null; }
}

async function bWrite(path, value) {
  await blob.put(path, JSON.stringify(value), {
    access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60
  });
}

async function bListAll(prefix, max = 4000) {
  const out = [];
  let cursor;
  do {
    const page = await blob.list({ prefix, cursor, limit: 1000 });
    out.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor && out.length < max);
  return out;
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

const eventKey = (e) => e.id || `${e.t}|${e.pid}|${e.type}|${e.label || ''}|${e.ms || ''}`;

// One file per batch (a page's worth of events) to stay well inside Blob's
// free-plan write allowance.
async function blob_addEvent(site, event) {
  const list = Array.isArray(event) ? event : [event];
  const name = `${B.ev(site)}${list[0].t}-${Math.random().toString(36).slice(2, 10)}.json`;
  await blob.put(name, JSON.stringify(list), { access: 'private', addRandomSuffix: false, contentType: 'application/json' });
}

async function blob_getEvents(site, limit = 10000) {
  const [log, pending] = await Promise.all([bRead(B.log(site)), bListAll(B.ev(site))]);
  let events = Array.isArray(log) ? log : [];
  if (pending.length) {
    const fresh = (await mapLimit(pending, 16, (b) => bRead(b.pathname).catch(() => null))).flat().filter(Boolean);
    const seen = new Set(events.map(eventKey));
    for (const e of fresh) { const k = eventKey(e); if (!seen.has(k)) { seen.add(k); events.push(e); } }
    events.sort((a, b) => b.t - a.t);
    events = events.slice(0, MAX_EVENTS_PER_SITE);
    await bWrite(B.log(site), events);
    for (let i = 0; i < pending.length; i += 500) await blob.del(pending.slice(i, i + 500).map((b) => b.url));
  }
  return events.slice(0, limit);
}

async function blob_clearEvents(site) {
  const pending = await bListAll(B.ev(site), 100000);
  for (let i = 0; i < pending.length; i += 500) await blob.del(pending.slice(i, i + 500).map((b) => b.url));
  await blob.del(B.log(site)).catch(() => {});
}

async function blob_getSites() {
  const [logs, folders] = await Promise.all([
    bListAll('dv/log/'),
    blob.list({ prefix: 'dv/ev/', mode: 'folded', limit: 1000 }).then((r) => r.folders || [])
  ]);
  const names = new Set(logs.map((b) => b.pathname.replace(/^dv\/log\//, '').replace(/\.json$/, '')));
  for (const f of folders) names.add(f.replace(/^dv\/ev\//, '').replace(/\/$/, ''));
  const links = (await bRead(B.links)) || {};
  for (const l of Object.values(links)) if (l?.site) names.add(l.site);
  return [...names].filter(Boolean).sort();
}

async function blob_getLinks() { return (await bRead(B.links)) || {}; }
async function blob_saveLink(link) { const all = await blob_getLinks(); all[link.code] = link; await bWrite(B.links, all); }
async function blob_deleteLink(code) { const all = await blob_getLinks(); delete all[code]; await bWrite(B.links, all); }

// Best-effort limiter kept in each function instance (Blob has no counters).
const localCounts = new Map();
async function local_underLimit(bucket, limit, windowSec) {
  const key = `${bucket}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  const n = (localCounts.get(key) || 0) + 1;
  localCounts.set(key, n);
  if (localCounts.size > 5000) localCounts.clear();
  return n <= limit;
}

// ---------------- dispatch ----------------
const pick = (r, b) => (...args) => (mode() === 'blob' ? b(...args) : r(...args));
export const addEvent = pick(redis_addEvent, blob_addEvent);
export const getEvents = pick(redis_getEvents, blob_getEvents);
export const clearEvents = pick(redis_clearEvents, blob_clearEvents);
export const getSites = pick(redis_getSites, blob_getSites);
export const getLinks = pick(redis_getLinks, blob_getLinks);
export const saveLink = pick(redis_saveLink, blob_saveLink);
export const deleteLink = pick(redis_deleteLink, blob_deleteLink);
export const underLimit = pick(redis_underLimit, local_underLimit);
