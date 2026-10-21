// Tracked links: one per person you send the demo to, so visits show who opened it.
import { randomBytes } from 'node:crypto';
import { send, readJson, isAuthed, cleanSite, text } from '../lib/http.mjs';
import { getLinks, saveLink, deleteLink } from '../lib/store.mjs';

const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 14);

export function makeCode(label, existing) {
  const base = slug(label) || 'link';
  for (let i = 0; i < 20; i++) {
    const code = `${base}-${randomBytes(2).toString('hex').slice(0, 3)}`;
    if (!existing[code]) return code;
  }
  return `${base}-${randomBytes(4).toString('hex')}`;
}

export function linkUrl(target, code) {
  const u = new URL(target);
  u.searchParams.set('r', code);
  return u.toString();
}

export default async function handler(req, res) {
  if (!isAuthed(req)) return send(res, 401, { error: 'sign in' });
  if (req.method === 'DELETE') {
    const code = text(new URL(req.url, 'http://x').searchParams.get('code'), 40);
    if (!code) return send(res, 400, { error: 'code required' });
    await deleteLink(code);
    return send(res, 200, { ok: true });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'POST or DELETE' });
  const b = await readJson(req, 4096);
  const label = text(b?.label, 60);
  const site = cleanSite(b?.site);
  const note = text(b?.note, 200);
  let target = text(b?.target, 300);
  if (!label || !site) return send(res, 400, { error: 'Give the link a name and pick a demo.' });
  try {
    const u = new URL(target);
    if (!/^https?:$/.test(u.protocol)) throw new Error();
    target = u.origin + u.pathname;
  } catch {
    return send(res, 400, { error: 'The demo address must start with https://' });
  }
  const existing = await getLinks();
  const code = makeCode(label, existing);
  const link = { code, label, site, note, target, url: linkUrl(target, code), created: Date.now() };
  await saveLink(link);
  return send(res, 200, link);
}
