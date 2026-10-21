// Dashboard data: events for one site, plus tracked links and the site list.
import { send, isAuthed, cleanSite } from '../lib/http.mjs';
import { getEvents, getSites, getLinks, clearEvents, mode } from '../lib/store.mjs';

// Blob mode: reuse a dashboard read for a minute (each storage list counts
// against Blob's free-plan allowance). The refresh button bypasses it.
const cache = new Map();
let sitesCache = { at: 0, sites: [] };

export default async function handler(req, res) {
  if (!process.env.ADMIN_PASSWORD) return send(res, 503, { error: 'setup', message: 'ADMIN_PASSWORD is not set in Vercel yet.' });
  if (!isAuthed(req)) return send(res, 401, { error: 'sign in' });
  const url = new URL(req.url, 'http://x');
  try {
    if (mode() !== 'blob' || Date.now() - sitesCache.at > 300000 || url.searchParams.get('fresh') === '1') sitesCache = { at: Date.now(), sites: await getSites() };
    const sites = sitesCache.sites;
    const site = cleanSite(url.searchParams.get('site')) || sites[0] || '';
    if (req.method === 'DELETE') {
      if (!site || url.searchParams.get('confirm') !== site) return send(res, 400, { error: 'confirm with the site name' });
      await clearEvents(site);
      cache.delete(site);
      return send(res, 200, { ok: true });
    }
    const fresh = url.searchParams.get('fresh') === '1';
    const hit = cache.get(site);
    if (mode() === 'blob' && !fresh && hit && Date.now() - hit.at < 60000) {
      return send(res, 200, { mode: mode(), sites, site, events: hit.events, links: await getLinks(), now: hit.at, cached: true });
    }
    const [events, links] = await Promise.all([site ? getEvents(site) : [], getLinks()]);
    cache.set(site, { at: Date.now(), events });
    return send(res, 200, { mode: mode(), sites, site, events, links, now: Date.now() });
  } catch (err) {
    console.error('data:', err.message);
    return send(res, 503, { error: 'storage', message: 'Could not reach the database. Check the Upstash Redis connection in Vercel.' });
  }
}
