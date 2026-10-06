// Drive the operator's Figma Desktop from sp: build creatives from the client's real frames and export them
// with Figma's own renderer. Three local pieces, all on loopback:
//   daemon  (daemon.mjs, :9240)  keeps figma-console-mcp alive; its WebSocket (:9223) is where the
//                                 Desktop Bridge plugin in Figma connects
//   sidecar (sidecar.mjs, :9232) bytes in and out of the plugin sandbox (photos, helpers, PNG, scene JSON)
//   plugin.js                     helpers evaluated inside the plugin once per plugin session
// A caller sees six operations: status, up, slots, make, compose, png. Everything else (starting processes,
// loading helpers, staging photos, collecting results) happens here.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpError, slash } from '../../out.mjs';
import { homePath } from '../../paths.mjs';
import { expandMap } from '../palette.mjs';
import { uncovered } from './coverage.mjs';
import { place, plan, rulesOf, specErrors } from './layout.mjs';
import { SIDECAR_PORT } from './sidecar.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DAEMON_PORT = 9240;
export const PLUGIN_FILE = path.join(HERE, 'plugin.js');
// figma-console-mcp caps one figma_execute at 30 s
const EXEC_MAX = 30000;
// how long an export may run on after that before sp gives up on it
const EXPORT_WAIT = 8 * 60000;
// Figma's createImage takes at most 4096 px per side
const IMAGE_MAX = 4096;
// glyphs outside their plate or pill beyond the reference's own share that make a warning
const COVER_SLACK = 0.01;
const COVER_REFERENCE_MAX = 0.05;
// padding between glyphs and the shape's edge the new text may lose against the reference, in frame px
// (or 30 % of the reference's padding, whichever is more)
const CLEARANCE_SLACK = 8;
const round3 = (v) => Math.round(v * 1000) / 1000;
const pct = (v) => `${Math.round(v * 1000) / 10}%`;
const PLUGIN_HINT = 'In Figma Desktop open the file, then Plugins > Development > Figma Desktop Bridge';

// JSON over loopback with node:http and no keep-alive agent: undici's pooled sockets made node abort in
// process.exit on Windows ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)", exit 127).
function request(method, url, { body, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, agent: false, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, json: null }); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} ${url} timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

export const pluginVersion = () => crypto.createHash('sha1').update(fs.readFileSync(PLUGIN_FILE)).digest('hex').slice(0, 12);
// sidecar names are ASCII; a frame name like "Кадр 33" becomes a hash-suffixed slug
export const asciiName = (s) => {
  const base = String(s).normalize('NFKD').replace(/[^\w.\-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${base || 'x'}-${crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 6)}`;
};

// SP_FIGMA_DAEMON_PORT / SP_FIGMA_SIDECAR_PORT move the ports (tests next to a live bridge)
export function bridge({
  daemonPort = Number(process.env.SP_FIGMA_DAEMON_PORT || DAEMON_PORT),
  sidecarPort = Number(process.env.SP_FIGMA_SIDECAR_PORT || SIDECAR_PORT),
  home = homePath('figma-bridge'),
} = {}) {
  const daemon = `http://127.0.0.1:${daemonPort}`;
  const sidecar = `http://127.0.0.1:${sidecarPort}`;

  const get = async (url) => {
    try {
      const r = await request('GET', url);
      return r.status === 200 ? r.json : { status: r.status };
    } catch {
      return null;
    }
  };

  async function call(name, args = {}, timeoutMs = 60000) {
    let r;
    try {
      r = (await request('POST', `${daemon}/call`, { body: { name, arguments: args, timeoutMs }, timeoutMs: timeoutMs + 5000 })).json;
    } catch (e) {
      if (/timed out/.test(e.message)) throw new SpError('figma', `${name}: no answer in ${timeoutMs} ms`);
      throw new SpError('figma', `the Figma bridge daemon is not running on ${daemonPort}`, { hint: 'sp figma up' });
    }
    if (!r) throw new SpError('figma', `${name}: the daemon answered with no JSON`);
    if (r.error) throw new SpError('figma', `${name}: ${r.error.message || r.error}`);
    const text = (r.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    let body;
    try { body = JSON.parse(text); } catch { body = { text }; }
    if (r.result?.isError) throw new SpError('figma', `${name}: ${body.error || text}`, { hint: /connect|plugin/i.test(text) ? PLUGIN_HINT : undefined });
    return body;
  }

  // run Plugin API code in the connected file; returns what the code returns
  async function exec(code, timeout = EXEC_MAX) {
    const body = await call('figma_execute', { code, timeout: Math.min(timeout, EXEC_MAX) }, Math.min(timeout, EXEC_MAX) + 15000);
    if (body.success === false) throw new SpError('figma', String(body.error || 'figma_execute failed'), { hint: /timed out/.test(body.error) ? 'split the work into smaller calls (30 s per call)' : undefined });
    return body.result;
  }

  async function status() {
    const tools = await get(`${daemon}/tools`);
    const info = await get(`${sidecar}/sp/info`);
    const out = {
      daemon: Array.isArray(tools) ? { port: daemonPort } : null,
      sidecar: info?.io ? { port: sidecarPort, io: info.io } : info ? { port: sidecarPort, foreign: true } : null,
      plugin: null,
    };
    if (out.daemon) {
      try {
        const s = await call('figma_get_status', { probe: true }, 15000);
        const ws = s.transport?.websocket;
        const file = ws?.connectedFile;
        out.plugin = s.setup?.probeResult?.success ? { connected: true, file: file?.fileName, fileKey: file?.fileKey, page: file?.currentPage, version: file?.pluginVersion } : { connected: false };
      } catch {
        out.plugin = { connected: false };
      }
    }
    out.ready = !!(out.daemon && out.sidecar?.io && out.plugin?.connected);
    return out;
  }

  const startDetached = (script, args, env, log) => {
    fs.mkdirSync(home, { recursive: true });
    const fd = fs.openSync(path.join(home, log), 'a');
    const child = spawn(process.execPath, [path.join(HERE, script), ...args], { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, ...env }, windowsHide: true });
    child.unref();
    fs.closeSync(fd);
    return child.pid;
  };

  // start whatever is missing, then wait for the plugin to connect
  async function up({ io, waitMs = 20000, server } = {}) {
    let s = await status();
    const started = [];
    if (s.sidecar?.foreign) throw new SpError('figma', `port ${sidecarPort} is taken by something that is not the sp sidecar`, { hint: `stop the process listening on ${sidecarPort}` });
    if (s.sidecar && io && path.resolve(s.sidecar.io) !== path.resolve(io)) {
      throw new SpError('figma', `the sidecar already serves ${s.sidecar.io}`, { hint: 'sp figma down, then sp figma up --io <dir>' });
    }
    if (!s.sidecar) {
      const dir = io || homePath('figma-io');
      started.push({ sidecar: startDetached('sidecar.mjs', ['--io', dir, '--port', String(sidecarPort)], {}, 'sidecar.log') });
    }
    if (!s.daemon) {
      const serverPath = server || path.join(home, 'node_modules', 'figma-console-mcp', 'dist', 'local.js');
      if (!fs.existsSync(serverPath)) throw new SpError('figma', `figma-console-mcp is not installed at ${slash(serverPath)}`, { hint: `npm install --prefix "${slash(home)}" figma-console-mcp@1.40.6` });
      started.push({ daemon: startDetached('daemon.mjs', ['--server', serverPath, '--port', String(daemonPort)], {}, 'daemon.log') });
    }
    const until = Date.now() + waitMs;
    do {
      s = await status();
      if (s.ready) break;
      await new Promise((r) => setTimeout(r, 1000));
    } while (Date.now() < until);
    return { ...s, started, ...(s.ready ? {} : { hint: PLUGIN_HINT }) };
  }

  async function down() {
    const stopped = [];
    const quit = async (name, url) => {
      try { if ((await request('POST', url)).status === 200) stopped.push(name); } catch {}
    };
    await quit('daemon', `${daemon}/quit`);
    await quit('sidecar', `${sidecar}/sp/quit`);
    let left = await status();
    for (const until = Date.now() + 3000; (left.daemon || left.sidecar) && Date.now() < until; left = await status()) await new Promise((r) => setTimeout(r, 300));
    return { stopped, ...(left.daemon || left.sidecar ? { stillRunning: { daemon: !!left.daemon, sidecar: !!left.sidecar }, hint: `stop the process on port ${left.daemon ? daemonPort : sidecarPort}` } : {}) };
  }

  const ioDir = async () => {
    const info = await get(`${sidecar}/sp/info`);
    if (!info?.io) throw new SpError('figma', `the sp sidecar is not running on ${sidecarPort}`, { hint: 'sp figma up' });
    return info.io;
  };

  // load plugin.js into the plugin unless this exact version is already there
  async function helpers() {
    const version = pluginVersion();
    if ((await exec('return globalThis.sp?.version ?? null')) === version) return version;
    const io = await ioDir();
    fs.mkdirSync(path.join(io, 'in'), { recursive: true });
    fs.copyFileSync(PLUGIN_FILE, path.join(io, 'in', 'sp-plugin.js'));
    const got = await exec(`eval(await (await fetch('http://localhost:${sidecarPort}/in/sp-plugin.js')).text()); sp.version = ${JSON.stringify(version)}; return sp.version`);
    if (got !== version) throw new SpError('figma', 'the plugin helpers did not load');
    return version;
  }

  const collect = (io, job, target) => {
    const from = path.join(io, 'out', job);
    if (!fs.existsSync(from)) throw new SpError('figma', `the plugin wrote no ${job}`);
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    fs.renameSync(from, target);
    return slash(path.resolve(target));
  };

  async function slots(ref) {
    await helpers();
    return exec(`return await sp.slots(${JSON.stringify(ref)})`);
  }

  // photo paths of a spec -> files staged in the sidecar's in/photos (downscaled to 4096 px when bigger)
  async function stagePhotos(images, baseDir, io) {
    const out = {};
    for (const [key, value] of Object.entries(images || {})) {
      const { src, ...opts } = typeof value === 'string' ? { src: value } : value;
      if (!src) throw new SpError('usage', `images.${key} needs a src`);
      const keep = (s) => (Object.keys(opts).length ? { src: s, ...opts } : s);
      if (/^(hash:|https?:)/.test(src)) { out[key] = keep(src); continue; }
      const file = path.resolve(baseDir, src);
      if (!fs.existsSync(file)) throw new SpError('missing', `no photo ${slash(file)} for slot ${key}`);
      const bytes = fs.readFileSync(file);
      const name = `${crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 12)}${path.extname(file).toLowerCase() || '.jpg'}`;
      const dest = path.join(io, 'in', 'photos', name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest)) {
        const { default: sharp } = await import('sharp');
        const meta = await sharp(bytes).metadata();
        if (Math.max(meta.width, meta.height) > IMAGE_MAX) await sharp(bytes).resize(IMAGE_MAX, IMAGE_MAX, { fit: 'inside' }).toFile(dest);
        else fs.writeFileSync(dest, bytes);
      }
      out[key] = keep(`photos/${name}`);
    }
    return out;
  }

  // Build one creative from a spec (see plugin.js `make`), then move its PNG and scene next to `outBase`.
  // spec.recolor may be a map or the string "palette" (the palette's map).
  async function make(spec, { baseDir = '.', outBase, palette } = {}) {
    if (!spec?.from) throw new SpError('usage', 'the spec needs "from": the id or unique name of the reference frame');
    for (const k of ['texts', 'images']) if (spec[k] != null && (typeof spec[k] !== 'object' || Array.isArray(spec[k]))) throw new SpError('usage', `spec.${k} must be an object of slot key -> value`);
    for (const k of ['hide', 'show', 'insert']) if (spec[k] != null && !Array.isArray(spec[k])) throw new SpError('usage', `spec.${k} must be an array`);
    let recolor = spec.recolor;
    if (recolor === 'palette') {
      if (!palette?.map) throw new SpError('usage', 'spec.recolor is "palette" but no palette with a map was given');
      recolor = palette.map;
    }
    await helpers();
    let recolorAdded;
    if (recolor && typeof recolor === 'object') ({ map: recolor, added: recolorAdded } = await shadesOf(recolor, spec.from));
    const io = await ioDir();
    const job = `jobs/${Date.now().toString(36)}-${asciiName(spec.name || spec.from)}`;
    const images = await stagePhotos(spec.images, baseDir, io);
    const { out: _ignored, ...rest } = spec;
    const r = await exec(`return await sp.make(${JSON.stringify({ ...rest, images, recolor })})`);
    const target = outBase || path.join(baseDir, asciiName(spec.name || spec.from));
    if (r.backed?.length) {
      r.coverage = await coverageOf(io, `${job}-cov`, r.backed);
      for (const c of r.coverage) {
        // a text already well outside its shape in the reference was not set on it by the designers
        if (c.reference > COVER_REFERENCE_MAX) continue;
        const lost = c.clearance != null && c.referenceClearance != null && c.referenceClearance - c.clearance > Math.max(CLEARANCE_SLACK, 0.3 * c.referenceClearance);
        if (c.outside - c.reference > COVER_SLACK || lost) {
          r.warnings.push(`${c.key}: glyphs come ${c.clearance} px from the edge of the shape behind them (reference ${c.referenceClearance} px), ${pct(c.outside)} of them outside it (reference ${pct(c.reference)}); shorten the line or pick a slot that fits`);
        }
      }
    }
    const files = await deliver(io, job, r.id, target, r.ms);
    return { ...r, ...(recolorAdded ? { recolorMap: recolor, recolorAdded } : {}), ...files };
  }

  // near shades of the mapped tokens in a frame move with them (palette.mjs)
  async function shadesOf(map, frameRef) {
    const colors = await exec(`return (await sp.slots(${JSON.stringify(frameRef)})).colors`);
    return expandMap(map, Object.keys(colors));
  }

  // Figma's PNG and the scene of a built frame, moved next to `target`; timings into ms
  async function deliver(io, job, id, target, ms) {
    const t0 = Date.now();
    await exported(io, `${job}.png`, `await sp.exportPng(${JSON.stringify(id)}, ${JSON.stringify(`${job}.png`)})`);
    ms.png = Date.now() - t0;
    await exported(io, `${job}.scene.json`, `await sp.saveScene(${JSON.stringify(id)}, ${JSON.stringify(`${job}.scene.json`)})`);
    ms.scene = Date.now() - t0 - ms.png;
    return { png: collect(io, `${job}.png`, `${target}.png`), scene: collect(io, `${job}.scene.json`, `${target}.scene.json`) };
  }

  // Compose a new story from elements of the client's frames (plugin.js composeBuild / composePlace, the
  // geometry in layout.mjs), recolour it, and move its PNG and scene next to `outBase`.
  async function compose(spec, { baseDir = '.', outBase, palette, rules } = {}) {
    const errs = specErrors(spec);
    if (errs.length) throw new SpError('usage', errs[0], { hint: errs.length > 1 ? `and ${errs.length - 1} more: ${errs.slice(1).join('; ')}` : 'sp figma --help' });
    let recolor = spec.recolor;
    if (recolor === 'palette') {
      if (!palette?.map) throw new SpError('usage', 'spec.recolor is "palette" but no palette with a map was given');
      recolor = palette.map;
    }
    const r = rulesOf(rules);
    const pl = plan(spec, r);
    await helpers();
    const io = await ioDir();
    const job = `jobs/${Date.now().toString(36)}-${asciiName(spec.name)}`;
    const photos = await stagePhotos(Object.fromEntries(spec.blocks.flatMap((b, i) => (b.type === 'image' && b.src ? [[i, b.src]] : []))), baseDir, io);
    const blocks = spec.blocks.map((b, i) => (photos[i] ? { ...b, src: photos[i] } : b));
    const ms = {};
    let t = Date.now();
    const built = await exec(`return await sp.composeBuild(${JSON.stringify({ spec: { ...spec, blocks }, plan: pl })})`);
    ms.build = Date.now() - t;
    const lay = place(spec, pl, built, r);
    t = Date.now();
    const placed = await exec(`return await sp.composePlace(${JSON.stringify({ id: built.id, placements: lay.placements })})`);
    ms.place = Date.now() - t;
    t = Date.now();
    let recolorMap, recolorAdded;
    if (recolor && typeof recolor === 'object') {
      ({ map: recolorMap, added: recolorAdded } = await shadesOf(recolor, built.id));
      await exec(`return await sp.recolor(${JSON.stringify(built.id)}, ${JSON.stringify(recolorMap)})`);
    }
    // after the palette, one part: "" (the frame), "background", "logo" or a block's index
    for (const [part, map] of Object.entries(spec.recolorAt || {})) {
      const ids = part === '' ? [built.id] : part === 'background' ? built.background : part === 'logo' ? [built.logo?.id].filter(Boolean) : built.blocks[Number(part)]?.ids;
      if (!ids) throw new SpError('usage', `recolorAt "${part}" is not "", "background", "logo" or a block index`);
      for (const id of ids) await exec(`return await sp.recolor(${JSON.stringify(id)}, ${JSON.stringify(map)})`);
    }
    ms.recolor = Date.now() - t;
    const files = await deliver(io, job, built.id, outBase || path.join(baseDir, asciiName(spec.name)), ms);
    return {
      id: built.id, name: built.name, page: built.page, replaced: built.replaced,
      warnings: [...built.warnings, ...lay.warnings],
      layout: { contentW: pl.contentW, zone: lay.zone, stack: lay.stack, boxes: lay.boxes },
      fit: lay.fit, texts: placed.texts,
      ...(recolorAdded ? { recolorMap, recolorAdded } : {}),
      ms, ...files,
    };
  }

  // Glyphs outside the plate or pill behind each edited text, ours and the reference's (coverage.mjs)
  async function coverageOf(io, job, backed) {
    const ids = backed.flatMap((b) => [b.text, b.shape, b.refText, b.refShape]);
    const { scale, renders } = await exec(`return await sp.renders(${JSON.stringify(ids)}, ${JSON.stringify(job)})`);
    const { default: sharp } = await import('sharp');
    const load = async (i) => {
      const { data, info } = await sharp(path.join(io, 'out', job, `${i}.png`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data, width: info.width, height: info.height, x: renders[i].x * scale, y: renders[i].y * scale };
    };
    const out = [];
    for (const [k, b] of backed.entries()) {
      const [t, sh, rt, rs] = await Promise.all([0, 1, 2, 3].map((j) => load(4 * k + j)));
      const ours = uncovered(t, sh), ref = uncovered(rt, rs);
      const px = (v) => (v == null ? null : Math.round(v / scale));
      out.push({ key: b.key, outside: round3(ours.share), reference: round3(ref.share), clearance: px(ours.clearance), referenceClearance: px(ref.clearance) });
    }
    fs.rmSync(path.join(io, 'out', job), { recursive: true, force: true });
    return out;
  }

  // Run an export in the plugin. The first render of a new frame can outlast the 30 s call limit, but the
  // plugin keeps working after figma_execute gives up, so on a timeout wait for the file to land instead.
  // While the file's tab is not the active one in Figma, renders crawl: 20 s became 6 min (ticket 39).
  async function exported(io, job, code, waitMs = EXPORT_WAIT) {
    const file = path.join(io, 'out', job);
    try {
      await exec(`return ${code}`);
    } catch (e) {
      if (!/timed out/.test(e.message)) throw e;
      const until = Date.now() + waitMs;
      while (!fs.existsSync(file) && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
      if (!fs.existsSync(file)) throw new SpError('figma', `Figma did not finish ${job} in ${Math.round((EXEC_MAX + waitMs) / 1000)} s`, { hint: 'keep the connected file\'s tab the active one in Figma: a tab in the background renders slowly' });
    }
    return file;
  }

  // Figma's own PNG of a frame (scale 1 = the frame's size)
  async function png(ref, file) {
    await helpers();
    const io = await ioDir();
    const job = `jobs/${Date.now().toString(36)}-${asciiName(ref)}.png`;
    const r = await exec(`const f = await sp.frameOf(${JSON.stringify(ref)}); return { id: f.id, name: f.name, ...(await sp.exportPng(f.id, ${JSON.stringify(job)})) }`);
    return { id: r.id, name: r.name, w: r.w, h: r.h, ms: r.ms, png: collect(io, job, file) };
  }

  return { call, exec, status, up, down, helpers, slots, make, compose, png };
}
