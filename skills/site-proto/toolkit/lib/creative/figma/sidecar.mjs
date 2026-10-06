// Byte I/O for the Figma plugin bridge. Plugin code runs in Figma's sandbox and its answers travel as MCP
// text, but its `fetch` may reach http://localhost:9223-9232 (the Desktop Bridge manifest), so photos and
// the plugin helpers come from here and PNG / scene files go back here:
//   GET  /in/<path>   -> bytes of a file under <io>/in
//   POST /out/<name>  -> writes the body to <io>/out/<name> (ASCII names, subfolders allowed)
//   GET  /sp/info     -> { io } so sp finds the files this sidecar writes
//   POST /sp/quit     -> stops the sidecar (sp figma down)
// Everything else answers 404 (including /health, so the Desktop Bridge port scanner skips this port).
// Listens on loopback only: 127.0.0.1, and ::1 when it can.
//
//   node sidecar.mjs --io <dir> [--port 9232]
import http from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIDECAR_PORT = 9232;
const MAX_BODY = 512 * 1024 * 1024;
const TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.mp4': 'video/mp4',
};
const CORS = {
  'Access-Control-Allow-Origin': '*', // the plugin sandbox fetch runs with a null origin
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Private-Network': 'true', // Chromium local network access preflight
  'Access-Control-Max-Age': '600',
};
export const OUT_NAME = /^[\w.\-]+(\/[\w.\-]+)*$/;

export function createSidecar({ io, log = () => {}, onQuit = () => {} }) {
  const root = path.resolve(io);
  const inRoot = path.join(root, 'in');
  const outRoot = path.join(root, 'out');
  const send = (res, code, body) => {
    res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  return http.createServer(async (req, res) => {
    try {
      const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
      if (req.method === 'GET' && rel === '/sp/info') return send(res, 200, { io: root.replaceAll('\\', '/') });
      if (req.method === 'POST' && rel === '/sp/quit') { send(res, 200, { stopping: true }); return onQuit(); }
      if (req.method === 'GET' && rel.startsWith('/in/')) {
        const file = path.resolve(inRoot, '.' + rel.slice(3));
        if (!file.startsWith(inRoot + path.sep)) return send(res, 400, { error: 'path escapes in/' });
        const st = await fs.stat(file).catch(() => null);
        if (!st?.isFile()) return send(res, 404, { error: 'not found', path: rel });
        res.writeHead(200, { ...CORS, 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': st.size });
        return createReadStream(file).pipe(res);
      }
      if (req.method === 'POST' && rel.startsWith('/out/')) {
        const name = rel.slice(5);
        if (!OUT_NAME.test(name) || name.split('/').some((p) => p === '..')) return send(res, 400, { error: 'bad name', name });
        const file = path.resolve(outRoot, name);
        if (!file.startsWith(outRoot + path.sep)) return send(res, 400, { error: 'path escapes out/' });
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > MAX_BODY) return send(res, 413, { error: 'body too large' });
          chunks.push(c);
        }
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(`${file}.part`, Buffer.concat(chunks));
        await fs.rename(`${file}.part`, file);
        log(`wrote ${file} (${size} bytes)`);
        return send(res, 200, { ok: true, path: file.replaceAll('\\', '/'), bytes: size });
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 500, { error: String(e) });
    }
  });
}

// 127.0.0.1 is required (the plugin fetches IPv4 localhost); ::1 is best-effort. port 0 picks a free port.
export async function listenLoopback(makeServer, port) {
  const servers = [];
  for (const host of ['127.0.0.1', '::1']) {
    const s = makeServer();
    const ok = await new Promise((resolve) => {
      s.once('error', (e) => resolve(e));
      s.listen(port, host, () => resolve(true));
    });
    if (ok === true) { servers.push(s); if (!port) port = s.address().port; }
    else if (host === '127.0.0.1') throw ok;
  }
  return { servers, port };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
  const io = arg('io');
  if (!io) { console.error('usage: node sidecar.mjs --io <dir> [--port 9232]'); process.exit(2); }
  await fs.mkdir(path.join(io, 'in'), { recursive: true });
  await fs.mkdir(path.join(io, 'out'), { recursive: true });
  const stamp = () => new Date().toISOString().slice(11, 19);
  const quit = () => setTimeout(() => process.exit(0), 100);
  const { port } = await listenLoopback(() => createSidecar({ io, log: (m) => console.log(stamp(), m), onQuit: quit }), Number(arg('port', SIDECAR_PORT)));
  console.log(stamp(), `sidecar http://localhost:${port} io=${path.resolve(io)}`);
}
