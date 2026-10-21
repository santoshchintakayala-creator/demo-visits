import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function send(res, status, body, headers = {}) {
  const isJson = body !== null && typeof body === 'object';
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(isJson ? JSON.stringify(body) : body ?? '');
}

export async function readBody(req, max = 16 * 1024) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return req.body.slice(0, max);
    if (Buffer.isBuffer(req.body)) return req.body.toString('utf8').slice(0, max);
    return JSON.stringify(req.body).slice(0, max);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJson(req, max) {
  try { return JSON.parse(await readBody(req, max) || '{}'); } catch { return null; }
}

export function header(req, name) {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v || '';
}

export function clientIp(req) {
  return header(req, 'x-real-ip') || header(req, 'x-forwarded-for').split(',')[0].trim() || req.socket?.remoteAddress || '';
}

// Approximate location from Vercel's edge network headers. No outside lookup service.
export function geo(req) {
  const dec = (v) => { try { return decodeURIComponent(v); } catch { return v; } };
  const num = (v) => (v === '' || isNaN(Number(v)) ? null : Number(v));
  return {
    city: dec(header(req, 'x-vercel-ip-city')),
    region: header(req, 'x-vercel-ip-country-region'),
    country: header(req, 'x-vercel-ip-country'),
    lat: num(header(req, 'x-vercel-ip-latitude')),
    lon: num(header(req, 'x-vercel-ip-longitude')),
    tz: header(req, 'x-vercel-ip-timezone')
  };
}

// Stable, non-reversible network id so repeat visits from one place can be grouped
// without storing the raw IP address.
export function networkId(ip) {
  const salt = process.env.IP_SALT || process.env.ADMIN_PASSWORD || 'demo-visits';
  return createHash('sha256').update(`${salt}|${ip}`).digest('hex').slice(0, 12);
}

const BOT = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|whatsapp|python|curl|wget|httpclient|monitor|uptime|vercel-screenshot/i;
export const isBot = (ua) => !ua || BOT.test(ua);

export function device(ua = '') {
  const os =
    /iPhone/.test(ua) ? 'iPhone' :
    /iPad/.test(ua) ? 'iPad' :
    /Android/.test(ua) ? 'Android' :
    /Windows/.test(ua) ? 'Windows' :
    /Mac OS X|Macintosh/.test(ua) ? 'Mac' :
    /CrOS/.test(ua) ? 'Chromebook' :
    /Linux/.test(ua) ? 'Linux' : 'Other';
  const browser =
    /Edg\//.test(ua) ? 'Edge' :
    /OPR\/|Opera/.test(ua) ? 'Opera' :
    /SamsungBrowser/.test(ua) ? 'Samsung Internet' :
    /CriOS|Chrome\//.test(ua) ? 'Chrome' :
    /FxiOS|Firefox\//.test(ua) ? 'Firefox' :
    /Safari\//.test(ua) ? 'Safari' : 'Other';
  const type = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? 'tablet' : /Mobi|iPhone|Android/.test(ua) ? 'phone' : 'computer';
  return { type, os, browser };
}

// ---- Dashboard sign-in: an HMAC-signed cookie keyed by ADMIN_PASSWORD ----
const COOKIE = 'dv_auth';
const DAY = 86400;

function sign(value) {
  return createHmac('sha256', `dv|${process.env.ADMIN_PASSWORD || ''}`).update(value).digest('base64url');
}

export function passwordMatches(input) {
  const real = process.env.ADMIN_PASSWORD || '';
  if (!real) return false;
  const a = createHash('sha256').update(String(input)).digest();
  const b = createHash('sha256').update(real).digest();
  return timingSafeEqual(a, b);
}

export function authCookie(days = 30) {
  const exp = String(Math.floor(Date.now() / 1000) + days * DAY);
  const token = `${exp}.${sign(exp)}`;
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${days * DAY}`;
}

export const clearCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function isAuthed(req) {
  if (!process.env.ADMIN_PASSWORD) return false;
  const raw = header(req, 'cookie').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return false;
  const [exp, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  const good = sign(exp);
  return good.length === sig.length && timingSafeEqual(Buffer.from(good), Buffer.from(sig));
}

export const cleanSite = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9.-]/g, '').slice(0, 64);
export const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');
