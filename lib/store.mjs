// Storage: Upstash Redis over its REST API (no client library needed).
// Works with the variable names Vercel's Upstash integration creates
// (KV_REST_API_URL / KV_REST_API_TOKEN) and Upstash's own
// (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
// With neither set it falls back to memory, for local development only.

export const MAX_EVENTS_PER_SITE = 50000;

const memory = { lists: new Map(), hashes: new Map(), sets: new Map(), counters: new Map() };

function config() {
  const env = process.env;
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || '';
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || '';
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

export function mode() {
  return config() ? 'redis' : 'memory';
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

export async function addEvent(site, event) {
  await pipeline([
    ['LPUSH', k.events(site), JSON.stringify(event)],
    ['LTRIM', k.events(site), '0', String(MAX_EVENTS_PER_SITE - 1)],
    ['SADD', k.sites, site]
  ]);
}

export async function getEvents(site, limit = 10000) {
  const [rows] = await pipeline([['LRANGE', k.events(site), '0', String(limit - 1)]]);
  return (rows || []).map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}

export async function clearEvents(site) {
  await pipeline([['DEL', k.events(site)]]);
}

export async function getSites() {
  const [sites] = await pipeline([['SMEMBERS', k.sites]]);
  return (sites || []).sort();
}

export async function getLinks() {
  const [flat] = await pipeline([['HGETALL', k.links]]);
  const out = {};
  const arr = Array.isArray(flat) ? flat : Object.entries(flat || {}).flat();
  for (let i = 0; i < arr.length; i += 2) { try { out[arr[i]] = JSON.parse(arr[i + 1]); } catch {} }
  return out;
}

export async function saveLink(link) {
  await pipeline([['HSET', k.links, link.code, JSON.stringify(link)], ['SADD', k.sites, link.site]]);
}

export async function deleteLink(code) {
  await pipeline([['HDEL', k.links, code]]);
}

// Fixed-window counter; returns true while under the limit.
export async function underLimit(bucket, limit, windowSec) {
  const win = Math.floor(Date.now() / 1000 / windowSec);
  const key = k.rate(`${bucket}:${win}`);
  const [count] = await pipeline([['INCR', key], ['EXPIRE', key, String(windowSec * 2)]]);
  return Number(count) <= limit;
}
