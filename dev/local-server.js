// Local preview only (npm run dev). On Vercel the pages in public/ are served as static
// files and api/index.js runs as a function; this file imitates both on your own machine.
// State is kept in .local-data/state.json unless Redis env vars are set.

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { handle } from '../lib/app.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveApi(req, res, url) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const headers = {};
  for (const name of ['content-type', 'cookie']) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  const response = await handle(
    new Request(url, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined }),
  );
  const out = Object.fromEntries(response.headers);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) out['set-cookie'] = cookies; // the login cookie
  res.writeHead(response.status, out);
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '') || 'index.html';
  if (!path.extname(rel)) rel += '.html'; // same as "cleanUrls" on Vercel
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api') await serveApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Server error');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. If the app is already running, open http://localhost:${PORT} - or start on another port: set PORT=3001`);
  } else {
    console.error(err.message);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((net) => net && net.family === 'IPv4' && !net.internal)
    .map((net) => `http://${net.address}:${PORT}`);
  console.log('\nEvent Arrivals (local preview)\n');
  console.log(`  Home            http://localhost:${PORT}`);
  console.log(`  Check-in desk   http://localhost:${PORT}/checkin`);
  console.log(`  Arrivals board  http://localhost:${PORT}/board`);
  if (lan.length) console.log(`  Same Wi-Fi      ${lan.join('   ')}`);
  console.log('\nPress Ctrl+C to stop.\n');

  // "npm start" / the .bat file pass --open to bring the home page up in the default browser.
  if (process.argv.includes('--open')) {
    const url = `http://localhost:${PORT}`;
    const command = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(command, () => {});
  }
});
