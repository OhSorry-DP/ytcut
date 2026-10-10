import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../lib/server.js';

function request(origin, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const req = http.request({ hostname: url.hostname, port: url.port, path: options.path || '/', method: options.method || 'GET', headers: options.headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves the allowlisted HTML with security and content headers', async t => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ytcut-server-'));
  fs.mkdirSync(path.join(appRoot, 'renderer'));
  fs.writeFileSync(path.join(appRoot, 'renderer/index.html'), '<main>ok</main>');
  fs.writeFileSync(path.join(appRoot, 'renderer/local-player.js'), 'export {};');
  const server = await startServer(appRoot);
  t.after(async () => { await server.close(); fs.rmSync(appRoot, { recursive: true, force: true }); });
  const response = await fetch(`${server.origin}/`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<main>ok</main>');
  assert.equal(response.headers.get('content-type'), 'text/html');
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(response.headers.get('content-security-policy'), /media-src 'self' blob:;/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const localPlayer = await fetch(`${server.origin}/renderer/local-player.js`);
  assert.equal(localPlayer.status, 200);
  assert.equal(localPlayer.headers.get('content-type'), 'text/javascript');
  assert.equal(await localPlayer.text(), 'export {};');
});

test('HEAD has the GET headers and no response body', async t => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ytcut-server-'));
  fs.mkdirSync(path.join(appRoot, 'renderer'));
  fs.writeFileSync(path.join(appRoot, 'renderer/index.html'), 'hello');
  const server = await startServer(appRoot);
  t.after(async () => { await server.close(); fs.rmSync(appRoot, { recursive: true, force: true }); });
  const response = await fetch(`${server.origin}/renderer/index.html`, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html');
  assert.equal(await response.text(), '');
});

test('traversal, encoded traversal, and non allowlisted paths return 404', async t => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ytcut-server-'));
  const server = await startServer(appRoot);
  t.after(async () => { await server.close(); fs.rmSync(appRoot, { recursive: true, force: true }); });
  for (const pathname of ['/../.git/config', '/%2e%2e/.git/config', '/%2e%2e/main.js', '/.git/config', '/main.js']) {
    const response = await fetch(`${server.origin}${pathname}`, { redirect: 'manual' });
    assert.equal(response.status, 404, pathname);
  }
});

test('rejects a wrong Host and unsupported methods', async t => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ytcut-server-'));
  const server = await startServer(appRoot);
  t.after(async () => { await server.close(); fs.rmSync(appRoot, { recursive: true, force: true }); });
  const port = new URL(server.origin).port;
  const wrongHost = await request(server.origin, { headers: { Host: `localhost:${port}` } });
  assert.equal(wrongHost.status, 403);
  const post = await request(server.origin, { method: 'POST' });
  assert.equal(post.status, 405);
});

test('binds an ephemeral loopback port and close stops accepting connections', async () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ytcut-server-'));
  const server = await startServer(appRoot);
  assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  await server.close();
  await assert.rejects(fetch(server.origin));
  fs.rmSync(appRoot, { recursive: true, force: true });
});
