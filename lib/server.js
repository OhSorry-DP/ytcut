import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const files = new Map([
  ['/renderer/index.html', ['renderer/index.html', 'text/html']],
  ['/renderer/style.css', ['renderer/style.css', 'text/css']],
  ['/renderer/player.js', ['renderer/player.js', 'text/javascript']],
  ['/renderer/local-player.js', ['renderer/local-player.js', 'text/javascript']],
  ['/renderer/timeline-view.js', ['renderer/timeline-view.js', 'text/javascript']],
  ['/renderer/app.js', ['renderer/app.js', 'text/javascript']],
  ['/lib/time.js', ['lib/time.js', 'text/javascript']],
  ['/lib/timeline.js', ['lib/timeline.js', 'text/javascript']],
  ['/lib/tool-errors.js', ['lib/tool-errors.js', 'text/javascript']],
]);

function startServer(appRoot, { preview } = {}) {
  const root = path.resolve(appRoot);
  let port;
  const server = http.createServer((req, res) => {
    const headers = {
      'Content-Security-Policy': "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; frame-src https://www.youtube.com; style-src 'self'; img-src 'self' data: https://i.ytimg.com; media-src 'self' blob:; connect-src 'self' https://www.youtube.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'Referrer-Policy': req.url === '/' ? 'no-referrer' : 'strict-origin-when-cross-origin',
      'X-Content-Type-Options': 'nosniff',
    };
    const send = (status, body = '', extra = {}) => {
      res.writeHead(status, { ...headers, ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
    };

    if (req.headers.host !== `127.0.0.1:${port}`) return send(403);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, '', { Allow: 'GET, HEAD' });
    let pathname, requestUrl;
    try {
      requestUrl = new URL(req.url, 'http://127.0.0.1');
      pathname = requestUrl.pathname;
      if (requestUrl.origin !== 'http://127.0.0.1' && requestUrl.origin !== 'http://127.0.0.1:' + port) return send(404);
    } catch {
      return send(404);
    }
    if (pathname.startsWith('/preview/')) {
      const match = /^\/preview\/([0-9a-f]{32})\.mp4$/.exec(pathname);
      if (!match || !preview) return send(404);
      const starts = requestUrl.searchParams.getAll('start');
      if (starts.length > 1) return send(400);
      return preview.serve(req, res, match[1], starts[0] ?? '0', headers);
    }
    if (pathname === '/') pathname = '/renderer/index.html';
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return send(404);
    }
    const entry = files.get(decoded);
    if (!entry) return send(404);
    const target = path.join(root, ...entry[0].split('/'));
    fs.readFile(target, (error, data) => {
      if (error) return send(404);
      send(200, data, { 'Content-Type': entry[1] });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      port = server.address().port;
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => new Promise((done, fail) => server.close(error => error ? fail(error) : done())) });
    });
  });
}

export { startServer };
