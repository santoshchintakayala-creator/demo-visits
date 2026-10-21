// Receives beacons from demo sites (navigator.sendBeacon, text/plain JSON).
import { randomUUID } from 'node:crypto';
import { send, readJson, header, clientIp, geo, networkId, isBot, device, cleanSite, text } from '../lib/http.mjs';
import { addEvent, underLimit } from '../lib/store.mjs';

const TYPES = new Set(['view', 'leave', 'click', 'form', 'intro']);

function corsHeaders(req) {
  const origin = header(req, 'origin');
  return origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
}

function originAllowed(req) {
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.length) return true;
  const origin = header(req, 'origin');
  return !origin || allowed.includes(origin);
}

function clean(event) {
  for (const key of Object.keys(event)) if (event[key] === undefined || event[key] === '') delete event[key];
  return event;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return send(res, 204, '', { ...corsHeaders(req), 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const cors = corsHeaders(req);
  if (!originAllowed(req)) return send(res, 403, { error: 'origin not allowed' }, cors);

  const ua = header(req, 'user-agent');
  if (isBot(ua)) return send(res, 204, '', cors);

  const body = await readJson(req, 64 * 1024);
  const items = Array.isArray(body?.batch) ? body.batch.slice(0, 60) : body ? [body] : [];
  const site = cleanSite(items[0]?.site);
  const valid = items.filter((b) => b && cleanSite(b.site) === site && TYPES.has(b.type));
  if (!site || !valid.length) return send(res, 400, { error: 'bad event' }, cors);

  const ip = clientIp(req);
  const net = networkId(ip);
  if (!(await underLimit(`c:${net}`, 240, 60))) return send(res, 429, { error: 'slow down' }, cors);

  const where = geo(req), dev = device(ua), now = Date.now();
  const events = valid.map((b, i) => clean({
    id: randomUUID().replace(/-/g, '').slice(0, 16),
    t: Number.isFinite(b.ts) && Math.abs(b.ts - now) < 6 * 3600 * 1000 ? Math.round(b.ts) : now + i,
    type: b.type,
    vid: text(b.vid, 32),
    sid: text(b.sid, 32),
    pid: text(b.pid, 32),
    r: text(b.r, 24),
    path: text(b.path, 200),
    title: text(b.title, 120),
    origin: text(b.origin, 120),
    referrer: text(b.referrer, 300),
    ms: Number.isFinite(b.ms) ? Math.max(0, Math.min(b.ms, 6 * 3600 * 1000)) : undefined,
    label: text(b.label, 48) || undefined,
    to: text(b.to, 200) || undefined,
    form: text(b.form, 48) || undefined,
    action: text(b.action, 24) || undefined,
    screen: Number.isFinite(b.w) && Number.isFinite(b.h) ? `${Math.round(b.w)}x${Math.round(b.h)}` : '',
    tz: text(b.tz, 48),
    lang: text(b.lang, 24),
    geo: where,
    dev,
    net
  }));

  try {
    await addEvent(site, events);
  } catch (err) {
    console.error('collect: store failed', err.message);
    return send(res, 503, { error: 'storage unavailable' }, cors);
  }
  return send(res, 204, '', cors);
}
