// Keeps one figma-console-mcp server (stdio MCP) alive and relays tool calls from short-lived sp commands
// over a loopback HTTP port, so Claude Code drives Figma without `claude mcp add` and a restart. The server
// is spawned with node directly (no shell) and its stdin is closed on exit, which avoids the orphaned
// local.js of figma-console-mcp#116. FIGMA_WS_HOST=127.0.0.1 is forced: on Windows `localhost` binds ::1
// only and the Desktop Bridge plugin, which dials IPv4, never connects.
//
//   node daemon.mjs [--server <figma-console-mcp/dist/local.js>] [--port 9240]
//   POST /call  {"name": "<tool>", "arguments": {...}, "timeoutMs"}  -> MCP tools/call result
//   GET  /tools                                                       -> tool names
//   POST /quit                                                        -> stop server and daemon
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const SERVER = arg('server', path.join(os.homedir(), '.elt-design', 'figma-bridge', 'node_modules', 'figma-console-mcp', 'dist', 'local.js'));
const PORT = Number(arg('port', 9240));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FIGMA_WS_HOST: '127.0.0.1' }, windowsHide: true });
let buf = '';
let nextId = 0;
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
child.stderr.on('data', (d) => process.stderr.write(d));
child.on('exit', (code) => { log('server exited', code); process.exit(code ?? 1); });

const rpc = (method, params, timeoutMs = 120000) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const t = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
  pending.set(id, (m) => { clearTimeout(t); resolve(m); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

function stop() {
  try { child.stdin.end(); } catch {}
  setTimeout(() => { try { child.kill(); } catch {} process.exit(0); }, 500);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'elt-design-daemon', version: '0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const tools = (await rpc('tools/list', {})).result?.tools ?? [];
log('server', JSON.stringify(init.result?.serverInfo), 'tools', tools.length);

const body = (req) => new Promise((resolve) => { let s = ''; req.on('data', (d) => (s += d)); req.on('end', () => resolve(s)); });
http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  try {
    if (req.method === 'GET' && req.url === '/tools') return send(200, tools.map((t) => ({ name: t.name, input: Object.keys(t.inputSchema?.properties || {}) })));
    if (req.method === 'POST' && req.url === '/quit') { send(200, { stopping: true }); return stop(); }
    if (req.method === 'POST' && req.url === '/call') {
      const { name, arguments: args, timeoutMs } = JSON.parse(await body(req));
      const t0 = Date.now();
      const m = await rpc('tools/call', { name, arguments: args || {} }, timeoutMs || 120000);
      log('call', name, `${Date.now() - t0} ms`, m.error ? 'ERROR' : m.result?.isError ? 'isError' : 'ok');
      return send(200, { ms: Date.now() - t0, ...(m.error ? { error: m.error } : { result: m.result }) });
    }
    send(404, { error: 'not found' });
  } catch (e) {
    send(500, { error: String(e?.message || e) });
  }
}).listen(PORT, '127.0.0.1', () => log(`daemon on http://127.0.0.1:${PORT}`));
