import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

process.env.ADMIN_PASSWORD = 'test-pass';
delete process.env.KV_REST_API_URL; delete process.env.UPSTASH_REDIS_REST_URL;

const { device, isBot, geo, authCookie, isAuthed, passwordMatches, networkId } = await import('../lib/http.mjs');
const collect = (await import('../api/collect.js')).default;
const data = (await import('../api/data.js')).default;
const links = (await import('../api/links.js')).default;
const { makeCode, linkUrl } = await import('../api/links.js');

function req(method, url, body, headers = {}) {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(r, { method, url, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), socket: { remoteAddress: '1.2.3.4' } });
  return r;
}
function res() {
  const out = { status: 0, headers: {}, body: '' };
  out.writeHead = (s, h) => { out.status = s; out.headers = h; };
  out.end = (b) => { out.body = b ? String(b) : ''; };
  out.json = () => JSON.parse(out.body);
  return out;
}
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

test('device and bot detection', () => {
  assert.deepEqual(device(UA), { type: 'phone', os: 'iPhone', browser: 'Safari' });
  assert.equal(device('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36').os, 'Windows');
  assert.equal(isBot('Googlebot/2.1'), true);
  assert.equal(isBot('facebookexternalhit/1.1'), true);
  assert.equal(isBot(''), true);
  assert.equal(isBot(UA), false);
});

test('geo reads and decodes Vercel headers', () => {
  const g = geo({ headers: { 'x-vercel-ip-city': 'San%20Antonio', 'x-vercel-ip-country-region': 'TX', 'x-vercel-ip-country': 'US', 'x-vercel-ip-latitude': '29.4' } });
  assert.equal(g.city, 'San Antonio'); assert.equal(g.region, 'TX'); assert.equal(g.lat, 29.4); assert.equal(g.lon, null);
});

test('network id hides the raw ip', () => {
  const id = networkId('203.0.113.9');
  assert.equal(id.length, 12); assert.ok(!id.includes('203'));
  assert.equal(id, networkId('203.0.113.9'));
});

test('auth cookie round-trip and password check', () => {
  const cookie = authCookie().split(';')[0];
  assert.equal(isAuthed({ headers: { cookie } }), true);
  assert.equal(isAuthed({ headers: { cookie: cookie.slice(0, -2) + 'xx' } }), false);
  assert.equal(isAuthed({ headers: {} }), false);
  assert.equal(passwordMatches('test-pass'), true);
  assert.equal(passwordMatches('nope'), false);
});

test('collect stores a sanitized event with geo and device; data requires sign-in', async () => {
  const r = res();
  await collect(req('POST', '/api/collect', { site: 'Pace-Plumbing-Houston', type: 'view', vid: 'v1', sid: 's1', r: 'jon-abc', path: '/', title: '<script>x</script>', w: 390, h: 844, secret: 'drop me' },
    { 'user-agent': UA, origin: 'https://pace.example', 'x-vercel-ip-city': 'Houston', 'x-vercel-ip-country-region': 'TX', 'x-vercel-ip-country': 'US', 'x-forwarded-for': '198.51.100.7' }), r);
  assert.equal(r.status, 204);
  assert.equal(r.headers['Access-Control-Allow-Origin'], 'https://pace.example');

  const noAuth = res();
  await data(req('GET', '/api/data?site=pace-plumbing-houston'), noAuth);
  assert.equal(noAuth.status, 401);

  const cookie = authCookie().split(';')[0];
  const ok = res();
  await data(req('GET', '/api/data?site=pace-plumbing-houston', undefined, { cookie }), ok);
  const body = ok.json();
  assert.deepEqual(body.sites, ['pace-plumbing-houston']);
  const e = body.events[0];
  assert.equal(e.geo.city, 'Houston'); assert.equal(e.dev.os, 'iPhone'); assert.equal(e.r, 'jon-abc'); assert.equal(e.screen, '390x844');
  assert.equal(e.secret, undefined); assert.equal(e.net.length, 12); assert.ok(!JSON.stringify(e).includes('198.51.100.7'));
});

test('collect rejects bots, unknown types and other origins when restricted', async () => {
  const bot = res(); await collect(req('POST', '/api/collect', { site: 'x', type: 'view' }, { 'user-agent': 'Googlebot' }), bot);
  assert.equal(bot.status, 204);
  const bad = res(); await collect(req('POST', '/api/collect', { site: 'x', type: 'hack' }, { 'user-agent': UA }), bad);
  assert.equal(bad.status, 400);
  process.env.ALLOWED_ORIGINS = 'https://ok.example';
  const blocked = res(); await collect(req('POST', '/api/collect', { site: 'x', type: 'view' }, { 'user-agent': UA, origin: 'https://evil.example' }), blocked);
  assert.equal(blocked.status, 403);
  delete process.env.ALLOWED_ORIGINS;
});

test('tracked links: readable codes, url carries ?r=, needs sign-in', async () => {
  const code = makeCode('Jonathan Pace', {});
  assert.match(code, /^jonathan-pace-[0-9a-f]{3}$/);
  assert.equal(linkUrl('https://demo.example/', 'abc'), 'https://demo.example/?r=abc');
  const denied = res(); await links(req('POST', '/api/links', { label: 'x' }), denied);
  assert.equal(denied.status, 401);
  const cookie = authCookie().split(';')[0];
  const made = res(); await links(req('POST', '/api/links', { label: 'Office manager', site: 'pace-plumbing-houston', target: 'https://pace.example/about/?x=1' }, { cookie }), made);
  const link = made.json();
  assert.equal(made.status, 200);
  assert.equal(link.url, `https://pace.example/about/?r=${link.code}`);
  const badTarget = res(); await links(req('POST', '/api/links', { label: 'x', site: 's', target: 'javascript:alert(1)' }, { cookie }), badTarget);
  assert.equal(badTarget.status, 400);
});

test('a batch of events from one page is stored together with shared location', async () => {
  const cookie = authCookie().split(';')[0];
  const site = 'batch-site';
  const r = res();
  await collect(req('POST', '/api/collect', { batch: [
    { site, type: 'view', vid: 'b1', sid: 's', path: '/', ts: Date.now() - 3000 },
    { site, type: 'click', vid: 'b1', sid: 's', path: '/', label: 'Ask Pace', to: '', ts: Date.now() - 2000 },
    { site, type: 'leave', vid: 'b1', sid: 's', path: '/', ms: 2500, ts: Date.now() - 1000 },
    { site: 'other-site', type: 'view' }
  ] }, { 'user-agent': UA, 'x-vercel-ip-city': 'Katy', 'x-forwarded-for': '192.0.2.4' }), r);
  assert.equal(r.status, 204);
  const out = res();
  await data(req('GET', `/api/data?site=${site}`, undefined, { cookie }), out);
  const ev = out.json().events;
  assert.equal(ev.length, 3);
  assert.deepEqual(ev.map((e) => e.type).sort(), ['click', 'leave', 'view']);
  assert.ok(ev.every((e) => e.geo.city === 'Katy' && e.id));
});
