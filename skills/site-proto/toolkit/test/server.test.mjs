import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createHandler } from '../lib/server.mjs';

let root, server, base;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-serve-'));
  fs.mkdirSync(path.join(root, 'hub', 'a-test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hub', 'a-test', 'index.html'), '<h1>A</h1>');
  fs.writeFileSync(path.join(root, 'hub', 'a-test', 'style.css'), 'h1{}');
  fs.writeFileSync(path.join(root, 'clip.mp4'), Buffer.alloc(1000, 7));
  fs.writeFileSync(path.join(os.tmpdir(), 'sp-serve-secret.txt'), 'secret');
  server = http.createServer(createHandler(root));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(path.join(os.tmpdir(), 'sp-serve-secret.txt'), { force: true });
});

test('a folder without the trailing slash redirects, keeping the query', async () => {
  const res = await fetch(`${base}/hub/a-test?capture`, { redirect: 'manual' });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/hub/a-test/?capture');
});

test('a folder serves its index.html, uncached', async () => {
  const res = await fetch(`${base}/hub/a-test/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(await res.text(), '<h1>A</h1>');
});

test('files get their media type', async () => {
  const res = await fetch(`${base}/hub/a-test/style.css`);
  assert.equal(res.headers.get('content-type'), 'text/css; charset=utf-8');
});

test('a folder without index.html lists its entries', async () => {
  const text = await (await fetch(`${base}/hub/`)).text();
  assert.match(text, /href="a-test\/"/);
});

test('byte ranges work for video', async () => {
  const res = await fetch(`${base}/clip.mp4`, { headers: { Range: 'bytes=10-19' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 10-19/1000');
  assert.equal((await res.arrayBuffer()).byteLength, 10);
});

test('nothing outside the run folder is served', async () => {
  // fetch() would normalise the dots away, so send the raw path
  const status = await new Promise((resolve, reject) => {
    http.get(`${base}/..%2Fsp-serve-secret.txt`, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);
});

test('missing files are 404', async () => {
  assert.equal((await fetch(`${base}/nope.html`)).status, 404);
});
