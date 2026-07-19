/** Tiny static server over the repo root for the UI harness (Playwright MCP blocks file://). */
'use strict';
const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const abs = path.resolve(ROOT, rel);
      if (!abs.startsWith(ROOT)) {
        res.writeHead(403).end();
        return;
      }
      const body = await readFile(abs);
      res.writeHead(200, { 'content-type': MIME[path.extname(abs)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  })
  .listen(8793, '127.0.0.1', () => console.log('harness server on http://127.0.0.1:8793/'));
