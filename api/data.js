// Dashboard data: events for one site, plus tracked links and the site list.
import { send, isAuthed, cleanSite } from '../lib/http.mjs';
import { getEvents, getSites, getLinks, clearEvents, mode } from '../lib/store.mjs';

export default async function handler(req, res) {
  if (!process.env.ADMIN_PASSWORD) return send(res, 503, { error: 'setup', message: 'ADMIN_PASSWORD is not set in Vercel yet.' });
  if (!isAuthed(req)) return send(res, 401, { error: 'sign in' });
  const url = new URL(req.url, 'http://x');
  try {
    const sites = await getSites();
    const site = cleanSite(url.searchParams.get('site')) || sites[0] || '';
    if (req.method === 'DELETE') {
      if (!site || url.searchParams.get('confirm') !== site) return send(res, 400, { error: 'confirm with the site name' });
      await clearEvents(site);
      return send(res, 200, { ok: true });
    }
    const [events, links] = await Promise.all([site ? getEvents(site) : [], getLinks()]);
    return send(res, 200, { mode: mode(), sites, site, events, links, now: Date.now() });
  } catch (err) {
    console.error('data:', err.message);
    return send(res, 503, { error: 'storage', message: 'Could not reach the database. Check the Upstash Redis connection in Vercel.' });
  }
}
