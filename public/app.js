// Demo Visits dashboard. All event fields come from the public internet, so
// everything is escaped before it touches the page.
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { site: '', range: 7, data: null, open: new Set(), timer: null };
try { state.site = localStorage.getItem('dv-site') || ''; state.range = Number(localStorage.getItem('dv-range') ?? 7); } catch {}

const LIVE_MS = 5 * 60 * 1000;

// ---------- formatting ----------
const fmtTime = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function ago(t, now = Date.now()) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24); return d === 1 ? 'yesterday' : `${d} days ago`;
}
function dur(ms) {
  if (!ms) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
const hostOf = (u) => { try { return new URL(u).host; } catch { return 'another site'; } };
const place = (g = {}) => [g.city, g.region, g.country && g.country !== 'US' ? g.country : ''].filter(Boolean).join(', ') || 'Unknown location';
const deviceText = (d = {}) => [d.type === 'phone' ? 'Phone' : d.type === 'tablet' ? 'Tablet' : 'Computer', d.os, d.browser].filter((x) => x && x !== 'Other').join(' · ');
const pathName = (p = '/') => (p === '/' ? 'Home page' : p.replace(/^\/|\/$/g, '').replace(/-/g, ' ').replace(/\//g, ' › '));

function describe(e) {
  switch (e.type) {
    case 'view': return `Opened ${pathName(e.path)}${e.referrer ? ` (came from ${hostOf(e.referrer)})` : ''}`;
    case 'leave': return `Spent ${dur(e.ms)} on ${pathName(e.path)}`;
    case 'click':
      if (e.to === 'phone') return `Tapped the phone number “${e.label || 'Call'}”`;
      if (e.to === 'external') return `Clicked “${e.label}” (outside link)`;
      return `Clicked “${e.label || 'a button'}”${e.to && e.to !== e.path ? ` → ${pathName(e.to)}` : ''}`;
    case 'form': return 'Sent the service request form';
    case 'intro':
      return e.action === 'ok' ? 'Read the demo intro and clicked OK'
        : e.action === 'shown' ? 'Saw the demo intro popup'
        : 'Closed the demo intro';
    default: return e.type;
  }
}

// ---------- data shaping ----------
function inRange(events, days, now) {
  if (!days) return events;
  const from = now - days * 86400000;
  return events.filter((e) => e.t >= from);
}

function buildVisitors(events, links, now) {
  const by = new Map();
  for (const e of events) {
    const id = e.vid || `net:${e.net}`;
    let v = by.get(id);
    if (!v) { v = { id, events: [], sessions: new Set(), refs: new Set(), nets: new Set() }; by.set(id, v); }
    v.events.push(e);
    if (e.sid) v.sessions.add(e.sid);
    if (e.r) v.refs.add(e.r);
    if (e.net) v.nets.add(e.net);
  }
  // Names from tracked links; visitors on the same network as a named one get a hint.
  const netNames = new Map();
  for (const v of by.values()) {
    const code = [...v.refs][0];
    v.link = code ? links[code] || { code, label: `Link ${code}` } : null;
    if (v.link) for (const n of v.nets) netNames.set(n, v.link.label);
  }
  const out = [];
  for (const v of by.values()) {
    v.events.sort((a, b) => a.t - b.t);
    const first = v.events[0], last = v.events[v.events.length - 1];
    const latestGeo = [...v.events].reverse().find((e) => e.geo?.city || e.geo?.country)?.geo || {};
    const hint = !v.link ? [...v.nets].map((n) => netNames.get(n)).find(Boolean) : '';
    const views = v.events.filter((e) => e.type === 'view');
    const pages = new Set(views.map((e) => e.path));
    const intro = v.events.filter((e) => e.type === 'intro').map((e) => e.action);
    const clicks = v.events.filter((e) => e.type === 'click');
    out.push({
      ...v,
      name: v.link?.label || (hint ? `Possibly ${hint}` : latestGeo.city ? `Visitor from ${latestGeo.city}` : 'Unknown visitor'),
      named: !!v.link,
      hint: !!hint,
      first: first.t, last: last.t,
      live: now - last.t < LIVE_MS,
      geo: latestGeo,
      dev: last.dev || first.dev || {},
      views: views.length,
      pages: pages.size,
      time: v.events.filter((e) => e.type === 'leave').reduce((s, e) => s + (e.ms || 0), 0),
      introOk: intro.includes('ok'),
      introSkipped: !intro.includes('ok') && intro.some((x) => x === 'escape' || x === 'backdrop'),
      called: clicks.some((e) => e.to === 'phone'),
      chatted: clicks.some((e) => /ask pace|chat/i.test(e.label || '')),
      voice: clicks.some((e) => /ai call|live ai|call$/i.test(e.label || '') && e.to !== 'phone'),
      formSent: v.events.some((e) => e.type === 'form')
    });
  }
  return out.sort((a, b) => b.last - a.last);
}

// ---------- rendering ----------
function renderKpis(visitors, events) {
  const sessions = new Set(events.map((e) => e.sid).filter(Boolean)).size;
  const views = events.filter((e) => e.type === 'view').length;
  const time = events.filter((e) => e.type === 'leave').reduce((s, e) => s + (e.ms || 0), 0);
  const ok = visitors.filter((v) => v.introOk).length;
  const kpi = (n, label) => `<div class="kpi"><b>${esc(n)}</b><span>${esc(label)}</span></div>`;
  $('#kpis').innerHTML =
    kpi(visitors.length, visitors.length === 1 ? 'person (browser)' : 'people (browsers)') +
    kpi(sessions, sessions === 1 ? 'visit' : 'visits') +
    kpi(views, 'pages viewed') +
    kpi(sessions ? dur(time / sessions) : '0s', 'average time per visit') +
    kpi(visitors.length ? `${ok}/${visitors.length}` : '0', 'clicked OK on the intro');
}

function visitorTags(v) {
  const t = [];
  if (v.introOk) t.push('<span class="tag good">Read intro</span>');
  else if (v.introSkipped) t.push('<span class="tag">Closed intro</span>');
  if (v.formSent) t.push('<span class="tag warn">Sent request form</span>');
  if (v.called) t.push('<span class="tag">Tapped phone</span>');
  if (v.chatted) t.push('<span class="tag">Opened chat</span>');
  if (v.voice) t.push('<span class="tag">Tried AI call</span>');
  if (v.sessions.size > 1) t.push(`<span class="tag">${v.sessions.size} visits</span>`);
  return t.length ? `<div class="tags">${t.join('')}</div>` : '';
}

function renderVisitors(visitors, now) {
  if (!visitors.length) {
    $('#visitors').innerHTML = `<div class="empty">No visits in this period yet.<br><span class="small">Create a tracked link on the right and send it; visits appear here within seconds.</span></div>`;
    return;
  }
  $('#visitors').innerHTML = `<div class="vlist">${visitors.map((v) => `
    <div class="vrow" tabindex="0" role="button" aria-expanded="${state.open.has(v.id)}" data-id="${esc(v.id)}">
      <div>
        <div class="who"><i class="dot ${v.live ? 'live' : ''}" title="${v.live ? 'Active in the last 5 minutes' : ''}"></i><span>${esc(v.name)}</span></div>
        ${visitorTags(v)}
      </div>
      <div class="c2"><div>${esc(place(v.geo))}</div><div class="sub">${esc(deviceText(v.dev))}</div></div>
      <div class="c3"><div>${v.pages} page${v.pages === 1 ? '' : 's'}</div><div class="sub">${dur(v.time)} total</div></div>
      <div class="when" title="${esc(fmtTime(v.last))}">${v.live ? 'Active now' : esc(ago(v.last, now))}</div>
    </div>
    ${state.open.has(v.id) ? renderDetail(v) : ''}`).join('')}</div>`;
}

function renderDetail(v) {
  const facts = [
    `First seen ${fmtTime(v.first)}`,
    `Last seen ${fmtTime(v.last)}`,
    v.link ? `Link: ${v.link.code}${v.link.note ? ` (${v.link.note})` : ''}` : 'No tracked link',
    v.events.find((e) => e.screen)?.screen ? `Screen ${v.events.find((e) => e.screen).screen}` : '',
    v.events.find((e) => e.tz)?.tz || ''
  ].filter(Boolean);
  const steps = v.events.filter((e) => !(e.type === 'intro' && e.action === 'shown' && v.introOk)).slice(-60).reverse();
  return `<div class="detail">
    <div class="facts">${facts.map((f) => `<span>${esc(f)}</span>`).join('')}</div>
    <ul class="timeline">${steps.map((e) => `<li><time>${esc(fmtTime(e.t))}</time>${esc(describe(e))}</li>`).join('')}</ul>
  </div>`;
}

function renderPlaces(visitors) {
  const counts = new Map();
  for (const v of visitors) { const p = place(v.geo); counts.set(p, (counts.get(p) || 0) + 1); }
  const rows = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const max = rows[0]?.[1] || 1;
  $('#places').innerHTML = rows.length
    ? `<div class="places">${rows.map(([p, n]) => `<div class="place"><span>${esc(p)}</span><b>${n}</b><div class="bar"><i style="width:${Math.round((n / max) * 100)}%"></i></div></div>`).join('')}</div>`
    : '<p class="muted small">No locations yet.</p>';
}

function renderLinks(links, visitors) {
  const mine = Object.values(links).filter((l) => l.site === state.site).sort((a, b) => b.created - a.created);
  const opened = new Map();
  for (const v of visitors) if (v.link) opened.set(v.link.code, Math.max(opened.get(v.link.code) || 0, v.last));
  $('#links').innerHTML = mine.length
    ? `<div class="links">${mine.map((l) => `<div class="lrow">
        <b>${esc(l.label)}</b>${l.note ? `<span class="muted small">${esc(l.note)}</span>` : ''}
        <div class="url">${esc(l.url)}</div>
        <div class="row">
          <button class="link" data-copy="${esc(l.url)}">Copy link</button>
          <span class="muted">${opened.has(l.code) ? `Opened ${esc(ago(opened.get(l.code)))}` : 'Not opened yet'}</span>
          <button class="link danger" data-del="${esc(l.code)}">Delete</button>
        </div></div>`).join('')}</div>`
    : '<p class="muted small">No links for this demo yet.</p>';
}

function renderFeed(events, visitors) {
  const names = new Map(visitors.map((v) => [v.id, v.name]));
  const rows = events.filter((e) => !(e.type === 'intro' && e.action === 'shown')).slice(0, 40);
  $('#feed').innerHTML = rows.length
    ? `<ul class="feed">${rows.map((e) => `<li><time title="${esc(fmtTime(e.t))}">${esc(ago(e.t))}</time><span><span class="w">${esc(names.get(e.vid || `net:${e.net}`) || 'Visitor')}</span> · ${esc(describe(e))}</span><span class="where">${esc(place(e.geo))}</span></li>`).join('')}</ul>`
    : '<p class="muted small">Nothing yet.</p>';
}

function lastOrigin(events) {
  return events.find((e) => e.origin)?.origin || '';
}

function render() {
  const d = state.data;
  if (!d) return;
  const now = Date.now();
  const sel = $('#site');
  const sites = d.sites.length ? d.sites : [];
  sel.innerHTML = sites.length ? sites.map((s) => `<option value="${esc(s)}" ${s === d.site ? 'selected' : ''}>${esc(s)}</option>`).join('') : '<option value="">No demos yet</option>';
  document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', Number(b.dataset.range) === state.range));

  const events = inRange(d.events, state.range, now);
  const visitors = buildVisitors(events, d.links, now);
  renderKpis(visitors, events);
  renderVisitors(visitors, now);
  renderPlaces(visitors);
  renderLinks(d.links, buildVisitors(d.events, d.links, now));
  renderFeed(events, visitors);

  const origin = lastOrigin(d.events);
  const target = $('#link-form [name=target]');
  if (!target.value && origin) target.value = origin + '/';
  $('#notrack-link').innerHTML = origin ? `Your link: <a href="${esc(origin)}/?notrack=1" target="_blank" rel="noopener">${esc(origin)}/?notrack=1</a>` : '';
  $('#updated').textContent = `Updated ${new Date(d.now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  $('#mode').textContent = d.mode === 'memory' ? 'Test mode: no database connected, visits are not saved.' : `${d.events.length} events stored for this demo.`;
  const banner = $('#banner');
  banner.hidden = d.mode !== 'memory';
  banner.textContent = 'No database is connected, so visits are only kept until the server restarts. Connect Upstash for Redis in Vercel → Storage, then redeploy.';
}

// ---------- loading & auth ----------
async function load(fresh = false) {
  const params = new URLSearchParams();
  if (state.site) params.set('site', state.site);
  if (fresh) params.set('fresh', '1');
  const q = params.toString() ? `?${params}` : '';
  let res;
  try { res = await fetch(`/api/data${q}`, { credentials: 'same-origin' }); } catch { return; }
  if (res.status === 401) return show('login');
  const body = await res.json().catch(() => ({}));
  if (res.status === 503 && body.error === 'setup') { $('#setup-msg').textContent = body.message; return show('setup'); }
  if (!res.ok) { show('app'); const b = $('#banner'); b.hidden = false; b.textContent = body.message || 'Could not load visits.'; return; }
  state.data = body;
  if (!state.site && body.site) state.site = body.site;
  show('app');
  render();
}

function show(which) {
  for (const id of ['login', 'setup', 'app']) $(`#${id}`).hidden = id !== which;
  clearInterval(state.timer);
  if (which === 'app') state.timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, state.data?.mode === 'blob' ? 120000 : 30000);
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  const password = new FormData(e.target).get('password');
  const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { $('#login-error').textContent = body.error || 'Could not sign in.'; return; }
  e.target.reset();
  load();
});

$('#logout').addEventListener('click', async () => { await fetch('/api/login', { method: 'DELETE' }); state.data = null; show('login'); });
$('#refresh').addEventListener('click', () => load(true));
$('#site').addEventListener('change', (e) => { state.site = e.target.value; try { localStorage.setItem('dv-site', state.site); } catch {} state.open.clear(); $('#link-form [name=target]').value = ''; load(); });
document.querySelector('.seg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.range = Number(b.dataset.range); try { localStorage.setItem('dv-range', String(state.range)); } catch {}
  render();
});

function toggleRow(row) {
  const id = row.dataset.id;
  state.open.has(id) ? state.open.delete(id) : state.open.add(id);
  render();
  document.querySelector(`.vrow[data-id="${CSS.escape(id)}"]`)?.focus();
}
$('#visitors').addEventListener('click', (e) => { const row = e.target.closest('.vrow'); if (row) toggleRow(row); });
$('#visitors').addEventListener('keydown', (e) => { const row = e.target.closest('.vrow'); if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleRow(row); } });

$('#link-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#link-error').textContent = '';
  const f = new FormData(e.target);
  if (!state.site) { $('#link-error').textContent = 'No demo has reported a visit yet. Open the demo once, then refresh.'; return; }
  const res = await fetch('/api/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: f.get('label'), note: f.get('note'), target: f.get('target'), site: state.site }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { $('#link-error').textContent = body.error || 'Could not create the link.'; return; }
  e.target.querySelector('[name=label]').value = '';
  e.target.querySelector('[name=note]').value = '';
  try { await navigator.clipboard.writeText(body.url); $('#link-error').textContent = 'Link created and copied.'; } catch {}
  load();
});

$('#links').addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) { try { await navigator.clipboard.writeText(copy.dataset.copy); copy.textContent = 'Copied'; setTimeout(() => (copy.textContent = 'Copy link'), 1500); } catch {} return; }
  const del = e.target.closest('[data-del]');
  if (del && confirm('Delete this link? Visits already recorded stay, but will no longer show the name.')) {
    await fetch(`/api/links?code=${encodeURIComponent(del.dataset.del)}`, { method: 'DELETE' });
    load();
  }
});

$('#clear').addEventListener('click', async () => {
  if (!state.site) return;
  const typed = prompt(`This permanently deletes every recorded visit for "${state.site}". Type the demo name to confirm:`);
  if (typed !== state.site) return;
  await fetch(`/api/data?site=${encodeURIComponent(state.site)}&confirm=${encodeURIComponent(state.site)}`, { method: 'DELETE' });
  load();
});

load();
