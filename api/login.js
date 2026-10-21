import { send, readJson, clientIp, networkId, passwordMatches, authCookie, clearCookie } from '../lib/http.mjs';
import { underLimit } from '../lib/store.mjs';

export default async function handler(req, res) {
  if (req.method === 'DELETE') return send(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (!process.env.ADMIN_PASSWORD) return send(res, 503, { error: 'ADMIN_PASSWORD is not set in Vercel yet.' });
  const net = networkId(clientIp(req));
  if (!(await underLimit(`login:${net}`, 10, 600))) return send(res, 429, { error: 'Too many attempts. Try again in 10 minutes.' });
  const body = await readJson(req, 2048);
  if (!body || !passwordMatches(body.password || '')) return send(res, 401, { error: 'Wrong password.' });
  return send(res, 200, { ok: true }, { 'Set-Cookie': authCookie() });
}
