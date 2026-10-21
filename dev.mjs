// Local preview: node dev.mjs, then open http://localhost:4300
// Uses the in-memory store unless KV/Upstash variables are set.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

process.env.ADMIN_PASSWORD ||= 'dev';
const routes = {
  '/api/collect': (await import('./api/collect.js')).default,
  '/api/login': (await import('./api/login.js')).default,
  '/api/data': (await import('./api/data.js')).default,
  '/api/links': (await import('./api/links.js')).default
};
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const port = Number(process.env.PORT || 4300);

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (routes[path]) {
    try { return await routes[path](req, res); } catch (e) { console.error(e); res.writeHead(500); return res.end('error'); }
  }
  const file = normalize(join('public', path === '/' ? 'index.html' : path));
  if (!file.startsWith('public')) { res.writeHead(403); return res.end(); }
  try { const body = await readFile(file); res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end('not found'); }
}).listen(port, () => console.log(`Demo Visits dev server: http://localhost:${port} (password: ${process.env.ADMIN_PASSWORD})`));
