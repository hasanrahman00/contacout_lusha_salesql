/**
 * Mini Router — zero-dependency HTTP router for Node.js
 * Supports: GET, POST, DELETE, SSE, static files, JSON body, multipart upload
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

class Router {
  constructor() {
    this.routes = [];
    this.staticDir = null;
  }

  get(p, fn) { this.routes.push({ method: 'GET', path: p, fn }); }
  post(p, fn) { this.routes.push({ method: 'POST', path: p, fn }); }
  delete(p, fn) { this.routes.push({ method: 'DELETE', path: p, fn }); }

  static(dir) { this.staticDir = dir; }

  _match(routePath, reqPath) {
    const rParts = routePath.split('/');
    const qParts = reqPath.split('/');
    if (rParts.length !== qParts.length) return null;
    const params = {};
    for (let i = 0; i < rParts.length; i++) {
      if (rParts[i].startsWith(':')) {
        params[rParts[i].slice(1)] = decodeURIComponent(qParts[i]);
      } else if (rParts[i] !== qParts[i]) {
        return null;
      }
    }
    return params;
  }

  async _parseBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  _parseMultipart(buf, boundary) {
    const parts = [];
    const sep = `--${boundary}`;
    const str = buf.toString('binary');
    const segments = str.split(sep).slice(1, -1);
    for (const seg of segments) {
      const headerEnd = seg.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const headers = seg.slice(0, headerEnd);
      const body = seg.slice(headerEnd + 4, seg.length - 2);
      const nameMatch = headers.match(/name="([^"]+)"/);
      const fileMatch = headers.match(/filename="([^"]+)"/);
      parts.push({
        name: nameMatch?.[1] || '',
        filename: fileMatch?.[1] || null,
        data: Buffer.from(body, 'binary'),
      });
    }
    return parts;
  }

  listen(port, cb) {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const pathname = url.pathname;

      // CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      // Helper methods
      res.json = (data, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      res.error = (msg, status = 400) => res.json({ error: msg }, status);
      res.sse = () => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        return {
          send: (event, data) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          },
          close: () => res.end(),
        };
      };

      req.query = Object.fromEntries(url.searchParams);

      // Match route
      for (const route of this.routes) {
        if (route.method !== req.method) continue;
        const params = this._match(route.path, pathname);
        if (params === null) continue;

        req.params = params;

        // Parse body for POST
        if (req.method === 'POST') {
          const raw = await this._parseBody(req);
          const ct = req.headers['content-type'] || '';
          if (ct.includes('application/json')) {
            try { req.body = JSON.parse(raw.toString()); } catch { req.body = {}; }
          } else if (ct.includes('multipart/form-data')) {
            const boundary = ct.split('boundary=')[1];
            req.parts = this._parseMultipart(raw, boundary);
            req.body = {};
            for (const p of req.parts) {
              if (!p.filename) req.body[p.name] = p.data.toString();
            }
          } else {
            req.body = {};
          }
        }

        try {
          await route.fn(req, res);
        } catch (e) {
          console.error('Route error:', e);
          if (!res.headersSent) res.error(e.message, 500);
        }
        return;
      }

      // Static files
      if (this.staticDir && req.method === 'GET') {
        let filePath = pathname === '/' ? '/index.html' : pathname;
        filePath = path.join(this.staticDir, filePath);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath);
          const mime = MIME[ext] || 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': mime });
          fs.createReadStream(filePath).pipe(res);
          return;
        }
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    server.listen(port, cb);
    return server;
  }
}

module.exports = { Router };
