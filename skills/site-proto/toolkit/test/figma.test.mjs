// The Figma bridge without Figma: the real sidecar, and a fake daemon that answers like figma-console-mcp
// and writes the files the plugin would (plugin.js itself is verified live in Figma, ticket 15).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createSidecar, listenLoopback } from '../lib/creative/figma/sidecar.mjs';
import { asciiName, bridge, pluginVersion } from '../lib/creative/figma/bridge.mjs';
import { uncovered } from '../lib/creative/figma/coverage.mjs';

const SP = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'sp.mjs');
let dir, io, sidecar, fake;

// figma-console-mcp's answer shape: text content holding a JSON body
const answer = (body) => ({ result: { content: [{ type: 'text', text: JSON.stringify(body) }] } });

function fakeDaemon() {
  const state = { version: null, evals: 0, specs: [], builds: [], placed: [], recolors: [] };
  const server = http.createServer(async (req, res) => {
    const send = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/tools') return send([{ name: 'figma_execute' }, { name: 'figma_get_status' }]);
    let raw = '';
    for await (const c of req) raw += c;
    const { name, arguments: args } = JSON.parse(raw);
    if (name === 'figma_get_status') return send(answer({ setup: { probeResult: { success: true } }, transport: { websocket: { connectedFile: { fileName: 'Test file', fileKey: 'k1', currentPage: 'Page 1' } } } }));
    const code = args.code;
    if (code.includes('globalThis.sp?.version')) return send(answer({ success: true, result: state.version }));
    if (code.includes('sp.version =')) {
      state.evals++;
      state.version = JSON.parse(code.match(/sp\.version = ("[^"]+")/)[1]);
      return send(answer({ success: true, result: state.version }));
    }
    if (code.includes('sp.make(')) {
      const spec = JSON.parse(code.slice(code.indexOf('sp.make(') + 8, code.lastIndexOf(')')));
      state.specs.push(spec);
      const backed = spec.name === 'plate' ? [{ key: '4.7', text: 't', shape: 's', refText: 'rt', refShape: 'rs' }] : [];
      return send(answer({ success: true, result: { id: '9:1', name: spec.name, page: 'site-proto', from: '1:1', texts: [], backed, warnings: [], ms: { total: 5 } } }));
    }
    // composing: phase 1 reports each block's elements and sizes, phase 2 takes the placements
    const arg = (fn) => JSON.parse(code.slice(code.indexOf(`sp.${fn}(`) + fn.length + 4, code.lastIndexOf(')')));
    if (code.includes('sp.composeBuild(')) {
      const { spec, plan } = arg('composeBuild');
      state.builds.push({ spec, plan });
      const blocks = spec.blocks.map((b, i) => {
        if (b.type === 'text') return { type: 'text', id: `t${i}`, ids: [`t${i}`], w: plan.blocks[i].textW, h: 100, size: i === 0 ? 76 : 40, lines: 2, probes: [] };
        if (b.type === 'card') return { type: 'card', shape: `s${i}`, text: `c${i}`, ids: [`s${i}`, `c${i}`], textW: plan.blocks[i].textW, textH: 96, lines: 2 };
        if (b.type === 'image') return { type: 'image', id: `i${i}`, ids: [`i${i}`], w: 1000, h: 1500 };
        return { type: b.type, ids: [] };
      });
      return send(answer({ success: true, result: { id: '9:2', name: spec.name, page: spec.page || 'site-proto', replaced: 0, background: ['bg0'], logo: { id: 'L', w: 313, h: 59 }, blocks, warnings: [], ms: 3 } }));
    }
    if (code.includes('sp.composePlace(')) {
      state.placed.push(arg('composePlace'));
      return send(answer({ success: true, result: { id: '9:2', placed: 1, texts: [], ms: 1 } }));
    }
    if (code.includes('sp.recolor(')) {
      state.recolors.push(JSON.parse(`[${code.slice(code.indexOf('sp.recolor(') + 11, code.lastIndexOf(')'))}]`));
      return send(answer({ success: true, result: { changed: 1, scanned: 1 } }));
    }
    const job = code.match(/sp\.(exportPng|saveScene)\("[^"]+", "([^"]+)"\)/);
    if (job) {
      const out = path.join(io, 'out', job[2]);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const write = async () => {
        if (job[1] === 'exportPng') await sharp({ create: { width: 108, height: 192, channels: 3, background: '#EF5CA1' } }).png().toFile(out);
        else fs.writeFileSync(out, JSON.stringify({ id: '9:1', name: 'x', width: 108, height: 192, fills: [], nodes: [] }));
      };
      // the first render of a new frame outlasting the 30 s call: figma_execute gives up, the plugin finishes later
      if (job[1] === 'exportPng' && state.slowNext) {
        state.slowNext = false;
        setTimeout(write, 300);
        return send(answer({ success: false, error: 'Error: Execution timed out after 30000ms' }));
      }
      await write();
      return send(answer({ success: true, result: { path: out } }));
    }
    const rendersCall = code.match(/sp\.renders\((\[[^\]]*\]), "([^"]+)"\)/);
    if (rendersCall) {
      // text 10 px wide at x 0..10 (ours) or 2..8 (reference); the plate behind covers x 0..8
      const ids = JSON.parse(rendersCall[1]);
      const boxes = { t: [0, 10], s: [0, 8], rt: [2, 6], rs: [0, 8] };
      const renders = [];
      for (const [i, id] of ids.entries()) {
        const [x, w] = boxes[id];
        const out = path.join(io, 'out', rendersCall[2], `${i}.png`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        await sharp({ create: { width: w, height: 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toFile(out);
        renders.push({ id, x, y: 0, w, h: 4 });
      }
      return send(answer({ success: true, result: { scale: 1, renders } }));
    }
    const slots = { id: '1:1', name: 'Ref', texts: [{ key: '4' }], images: [], layers: [], colors: { '#1EA6DF': 3, '#1FA8E0': 1, '#FFFFFF': 9 } };
    if (code.includes('sp.slots(')) return send(answer({ success: true, result: code.includes(').colors') ? slots.colors : slots }));
    if (code.includes('timeout-me')) return send(answer({ success: false, error: 'Error: Execution timed out after 30000ms' }));
    return send(answer({ success: false, error: 'unexpected code' }));
  });
  return { state, server };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-figma-'));
  io = path.join(dir, 'io');
  fs.mkdirSync(path.join(io, 'in'), { recursive: true });
  sidecar = await listenLoopback(() => createSidecar({ io }), 0);
  fake = fakeDaemon();
  await new Promise((r) => fake.server.listen(0, '127.0.0.1', r));
  fake.port = fake.server.address().port;
});
after(() => {
  for (const s of sidecar.servers) s.close();
  fake.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('sidecar', () => {
  const u = (p) => `http://127.0.0.1:${sidecar.port}${p}`;
  test('serves in/, writes out/, reports its folder and refuses bad names and escapes', async () => {
    fs.writeFileSync(path.join(io, 'in', 'photo 1.jpg'), Buffer.from([1, 2, 3]));
    const g = await fetch(u('/in/photo%201.jpg'));
    assert.equal(g.status, 200);
    assert.deepEqual([...Buffer.from(await g.arrayBuffer())], [1, 2, 3]);
    const p = await fetch(u('/out/jobs/a.png'), { method: 'POST', body: new Uint8Array([9, 8]) });
    assert.equal(p.status, 200);
    assert.deepEqual([...fs.readFileSync(path.join(io, 'out', 'jobs', 'a.png'))], [9, 8]);
    assert.equal((await (await fetch(u('/sp/info'))).json()).io, path.resolve(io).replaceAll('\\', '/'));
    assert.equal((await fetch(u('/out/%D0%90.png'), { method: 'POST', body: 'x' })).status, 400); // non-ASCII name
    assert.equal((await fetch(u('/out/..%2Fescape.png'), { method: 'POST', body: 'x' })).status, 400);
    assert.ok([400, 404].includes((await fetch(u('/in/..%2F..%2Fsecret.txt'))).status));
    assert.equal((await fetch(u('/health'))).status, 404); // the Desktop Bridge port scanner must skip it
    const pre = await fetch(u('/out/x.png'), { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Private-Network': 'true' } });
    assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
  });

  test('POST /sp/quit asks the sidecar to stop', async () => {
    let quit = false;
    const s = await listenLoopback(() => createSidecar({ io, onQuit: () => (quit = true) }), 0);
    const r = await fetch(`http://127.0.0.1:${s.port}/sp/quit`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(quit, true);
    for (const x of s.servers) x.close();
  });
});

describe('bridge', () => {
  const b = () => bridge({ daemonPort: fake.port, sidecarPort: sidecar.port, home: path.join(dir, 'home') });

  test('status is ready with daemon, sidecar and a connected plugin', async () => {
    const s = await b().status();
    assert.equal(s.ready, true);
    assert.equal(s.plugin.file, 'Test file');
    assert.equal(s.sidecar.io, path.resolve(io).replaceAll('\\', '/'));
  });

  test('make loads the helpers once, stages and downscales photos, applies the palette and collects the files', async () => {
    const specDir = path.join(dir, 'specs');
    fs.mkdirSync(specDir, { recursive: true });
    await sharp({ create: { width: 5000, height: 2000, channels: 3, background: '#808080' } }).png().toFile(path.join(specDir, 'big.png'));
    const palette = { map: { '#1EA6DF': '#EF5CA1' } };
    const spec = { from: 'Кадр 33', name: 'AS S1', texts: { 4: 'Осіння серія' }, images: { 0: 'big.png', 1: 'hash:abc' }, recolor: 'palette' };
    const r = await b().make(spec, { baseDir: specDir, outBase: path.join(dir, 'out', 'S1'), palette });
    assert.equal(fake.state.evals, 1);
    assert.equal(fake.state.version, pluginVersion());
    const sent = fake.state.specs.at(-1);
    assert.equal(sent.recolor['#1EA6DF'], '#EF5CA1');
    assert.ok(sent.recolor['#1FA8E0'], 'a near shade of a mapped token is mapped too');
    assert.equal(sent.recolor['#FFFFFF'], undefined);
    assert.equal(r.recolorAdded.length, 1);
    assert.equal(sent.images[1], 'hash:abc');
    assert.match(sent.images[0], /^photos\/[0-9a-f]{12}\.png$/);
    const staged = await sharp(path.join(io, 'in', sent.images[0])).metadata();
    assert.equal(Math.max(staged.width, staged.height), 4096);
    assert.equal(r.png, path.resolve(dir, 'out', 'S1.png').replaceAll('\\', '/'));
    assert.ok(fs.existsSync(path.join(dir, 'out', 'S1.scene.json')));
    assert.deepEqual(fs.readdirSync(path.join(io, 'out', 'jobs')), ['a.png'], 'results are moved out of the sidecar');
    await b().make({ from: '1:1' }, { baseDir: specDir, outBase: path.join(dir, 'out', 'S2') });
    assert.equal(fake.state.evals, 1, 'helpers of the same version are not loaded again');
  });

  test('an image given as { src, mode } is staged and keeps its mode', async () => {
    const specDir = path.join(dir, 'specs');
    await b().make({ from: '1:1', name: 'fill', images: { 0: { src: 'big.png', mode: 'FILL' }, 1: { src: 'hash:abc', mode: 'FILL' } } }, { baseDir: specDir, outBase: path.join(dir, 'out', 'fill') });
    const sent = fake.state.specs.at(-1).images;
    assert.match(sent[0].src, /^photos\/[0-9a-f]{12}\.png$/);
    assert.equal(sent[0].mode, 'FILL');
    assert.deepEqual(sent[1], { src: 'hash:abc', mode: 'FILL' });
  });

  test('an export that outlasts the call limit is collected when the plugin finishes it', async () => {
    fake.state.slowNext = true;
    const r = await b().make({ from: '1:1', name: 'slow' }, { baseDir: dir, outBase: path.join(dir, 'out', 'slow') });
    assert.ok(fs.existsSync(r.png));
    assert.equal(fake.state.slowNext, false);
  });

  test('a text running past the plate behind it warns; the reference share is the baseline', async () => {
    const r = await b().make({ from: '1:1', name: 'plate' }, { baseDir: dir, outBase: path.join(dir, 'out', 'plate') });
    assert.deepEqual(r.coverage, [{ key: '4.7', outside: 0.2, reference: 0, clearance: -2, referenceClearance: 0 }]);
    assert.match(r.warnings.join(' | '), /4[.]7: glyphs come -2 px from the edge of the shape behind them [(]reference 0 px[)], 20% of them outside it/);
    assert.deepEqual(fs.readdirSync(path.join(io, 'out', 'jobs')).filter((f) => f.endsWith('-cov')), [], 'renders are cleaned up');
  });

  test('a spec without "from", "palette" without a palette and a missing photo are usage errors', async () => {
    await assert.rejects(b().make({ texts: {} }), /needs "from"/);
    await assert.rejects(b().make({ from: 'x', recolor: 'palette' }), /no palette/);
    await assert.rejects(b().make({ from: 'x', images: { 0: 'nope.jpg' } }, { baseDir: dir }), /no photo/);
  });

  test('compose builds, places by the layout rules, recolours the composed frame and collects the files', async () => {
    const specDir = path.join(dir, 'specs');
    const palette = { map: { '#1EA6DF': '#EF5CA1' } };
    const spec = {
      name: 'AS 1.2 · compose', page: 'Осіння серія',
      background: { from: 'Кадр 6', keys: ['0'] }, logo: { from: 'Кадр 6', key: '2' },
      blocks: [
        { type: 'text', style: { from: 'Кадр 6', key: '1.0' }, text: 'Коли ти востаннє дбала про себе?' },
        { type: 'card', shape: { from: 'Кадр 33', key: '6.0' }, style: { from: 'Кадр 33', key: '6.1.0' }, text: 'Не про роботу.' },
        { type: 'image', from: '24:8092', src: 'big.png', h: 600 },
      ],
      recolor: 'palette', recolorAt: { background: { '#EF5CA1': '#FEF3F8' }, 1: { '#EF5CA1': '#A31D53' } },
    };
    const r = await b().compose(spec, { baseDir: specDir, outBase: path.join(dir, 'out', 'C1'), palette, rules: { contentW: { p50: 860 } } });
    const { spec: sent, plan } = fake.state.builds.at(-1);
    assert.equal(plan.contentW, 860, 'the spec\'s rules are applied');
    assert.equal(plan.blocks[1].textW, 860 - 90);
    assert.match(sent.blocks[2].src, /^photos\/[0-9a-f]{12}\.png$/, 'a photo file is staged');
    const at = Object.fromEntries(fake.state.placed.at(-1).placements.map((q) => [q.id, q]));
    assert.deepEqual(at.L, { id: 'L', x: 384, y: 142 });
    assert.equal(at.c1.y - at.s1.y, 28, 'the card text sits at the card padding');
    assert.equal(at.s1.y - (at.t0.y + 100), 69, 'title to card: the corpus gap');
    assert.deepEqual([at.i2.w, at.i2.h], [860, 600]);
    const [palRun, ...parts] = fake.state.recolors.slice(-4);
    assert.equal(palRun[0], '9:2');
    assert.ok(palRun[1]['#1FA8E0'], 'near shades in the composed frame move with the token');
    const byId = Object.fromEntries(parts);
    assert.deepEqual(byId.bg0, { '#EF5CA1': '#FEF3F8' });
    assert.deepEqual([byId.s1, byId.c1], [{ '#EF5CA1': '#A31D53' }, { '#EF5CA1': '#A31D53' }]);
    assert.equal(r.recolorAdded.length, 1);
    assert.equal(r.png, path.resolve(dir, 'out', 'C1.png').replaceAll('\\', '/'));
    assert.ok(fs.existsSync(path.join(dir, 'out', 'C1.scene.json')));
    assert.equal(r.layout.contentW, 860);
    assert.deepEqual(r.warnings, []);
  });

  test('a compose spec without blocks or with an unknown recolorAt part is a usage error', async () => {
    await assert.rejects(b().compose({ name: 'x', blocks: [] }), (e) => e.code === 'usage' && /blocks/.test(e.message));
    await assert.rejects(b().compose({ name: 'x', blocks: [{ type: 'text', style: '1:1', text: 'a' }], recolor: 'palette' }), /no palette/);
    await assert.rejects(b().compose({ name: 'x', blocks: [{ type: 'text', style: '1:1', text: 'a' }], recolorAt: { card: {} } }, { outBase: path.join(dir, 'out', 'C2') }), /recolorAt "card"/);
  });

  test('a timed-out plugin call says to split the work', async () => {
    await assert.rejects(b().exec('timeout-me'), (e) => e.code === 'figma' && /split/.test(e.extra.hint));
  });

  test('coverage: glyphs inside their plate are covered, a line running past the plate is not', () => {
    const img = (width, height, x, y, paint) => {
      const data = new Uint8Array(width * height * 4);
      for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) if (paint(i, j)) data[(j * width + i) * 4 + 3] = 255;
      return { data, width, height, x, y };
    };
    const plate = img(100, 20, 0, 0, () => true);
    assert.deepEqual(uncovered(img(80, 10, 10, 5, () => true), plate), { share: 0, clearance: 10 });
    assert.deepEqual(uncovered(img(120, 10, -10, 5, () => true), plate), { share: 20 / 120, clearance: -10 }); // 10 px out on each side
    assert.deepEqual(uncovered(img(10, 10, 0, 0, () => false), plate), { share: 0, clearance: null }); // nothing painted
    // one line of four runs 5 px past the plate: a small share, a negative clearance
    const lines = img(100, 40, 0, 0, (i, j) => j % 10 < 5 && (j < 30 ? i >= 10 && i < 90 : true));
    const r = uncovered(lines, img(100, 40, 0, 0, (i) => i >= 5 && i < 95));
    assert.ok(r.share < 0.05 && r.clearance === -5, JSON.stringify(r));
  });

  test('asciiName keeps sidecar names ASCII and distinct', () => {
    assert.match(asciiName('Кадр 33'), /^[\w.\-]+$/);
    assert.notEqual(asciiName('Кадр 33'), asciiName('Кадр 35'));
  });

  test('sp figma slots, make and compose run end to end through the CLI', async () => {
    const env = { ...process.env, SP_FIGMA_DAEMON_PORT: String(fake.port), SP_FIGMA_SIDECAR_PORT: String(sidecar.port), SITE_PROTO_HOME: path.join(dir, 'home') };
    const sp = (args) => new Promise((resolve) => {
      const p = spawn(process.execPath, [SP, 'figma', ...args], { cwd: dir, env });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('close', (code) => resolve({ code, json: JSON.parse(out.trim().split('\n').at(-1)) }));
    });
    const s = await sp(['slots', 'Ref']);
    assert.equal(s.json.ok, true);
    assert.equal(s.json.texts[0].key, '4');
    fs.writeFileSync(path.join(dir, 'S3.json'), JSON.stringify({ from: 'Ref', name: 'S3', texts: { 4: 'x' } }));
    const m = await sp(['make', 'S3.json']);
    assert.equal(m.json.ok, true, JSON.stringify(m.json));
    assert.ok(fs.existsSync(path.join(dir, 'S3.png')));
    const bad = await sp(['make']);
    assert.equal(bad.json.ok, false);
    assert.equal(bad.json.error, 'usage');
    fs.writeFileSync(path.join(dir, 'C3.json'), JSON.stringify({ name: 'C3', blocks: [{ type: 'text', style: { from: 'Ref', key: '4' }, text: 'x' }] }));
    const c = await sp(['compose', 'C3.json']);
    assert.equal(c.json.ok, true, JSON.stringify(c.json));
    assert.ok(fs.existsSync(path.join(dir, 'C3.png')));
    assert.equal(c.json.layout.contentW, 820);
    fs.writeFileSync(path.join(dir, 'C4.json'), JSON.stringify({ name: 'C4', blocks: [{ type: 'card', text: 'x' }] }));
    const badCompose = await sp(['compose', 'C4.json']);
    assert.equal(badCompose.json.error, 'usage');
    assert.match(badCompose.json.message, /needs "style"/);
  });
});
