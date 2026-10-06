import fs from 'node:fs';
import path from 'node:path';
import { SpError, slash } from '../lib/out.mjs';
import { loadConfig } from '../lib/config.mjs';

export const summary = 'Measure creatives: reproduction, style lint, reconstruction, blind test, journal, regression.';

export const help = `The creative measurement stand. Works on files, needs no run.

sp creative frames <file.fig> [--page <name>]
    creative-sized frames (1080x1920, 1080x1350, 1080x1080, ...) with id, name, page, container
sp creative scene <file.fig> --frame <id> [--out scene.json]
    the scene graph of one frame: visible nodes with boxes, paints, effects, text metrics and a role
sp creative model <file.fig> [--page <name>] [--size 1080x1920] [--only ids.json] [--exclude <id,id>]
                  [--png-dir <dir>] --out model.json
    learn the style model (fonts, colour tokens, presets, envelopes) from the client's own frames;
    --only takes a JSON array of ids (or of objects with an id), --png-dir their exports named
    <frame name>.png for the contrast floor
sp creative lint <scene.json | file.fig --frame <id>> --model model.json [--png render.png] [--palette palette.json]
                 [--out report.json]
    level 2: errors are values outside everything the corpus shows, warnings outside its p5..p95;
    pass = at most 2 errors (calibrated by cross-validation on the client's own frames).
    --palette {map: {"#client": "#campaign"}, extra: ["#hex"]}: a campaign recolour; colours must then be
    client tokens, tokens through the map or campaign-sketch colours, and a mapped client colour left
    in place is an error (color.unmapped)
sp creative diff <ours.png> <theirs.png> [--heatmap diff.png]
    level 1: SSIM, share of changed pixels, CIEDE2000 mean / p95 / share over the noticeable step
sp creative compare <ours.json> <theirs.json> [--png-ours a.png --png-theirs b.png]
    level 3: layout F1 of matched blocks, title typography, palette distance, one 0..1 score
sp creative blind make --ours <a.png,b.png,...> --theirs <c.png,...> --out <dir> [--seed <n>] [--lang uk|en]
sp creative blind score --key <dir.key.json> --picked <3,7,12,...>
    level 4: a self-scoring page of shuffled, re-encoded images; the key is written next to the folder
sp creative journal add --file <journal.jsonl> --hypothesis "<text>" --change "<text>" [--metrics '<json>'] [--decision "<text>"]
sp creative journal list --file <journal.jsonl>
sp creative regress <suite.json>
    run a suite of cases {name, kind: diff|lint|compare, ...files, expect: {ssimMin, changedMax,
    deltaEp95Max, errorsMax, errorsMin, scoreMin, f1Min}}; paths are relative to the suite file.
    lint cases take scene (a scene.json, or a .fig with frame) and model; errorsMin marks a
    negative control, a rejected design that must keep failing

Each subcommand prints one JSON line; bulky results go to --out when given.`;

export const options = {
  page: { type: 'string' },
  frame: { type: 'string' },
  out: { type: 'string' },
  size: { type: 'string' },
  only: { type: 'string' },
  exclude: { type: 'string' },
  'png-dir': { type: 'string' },
  model: { type: 'string' },
  png: { type: 'string' },
  palette: { type: 'string' },
  heatmap: { type: 'string' },
  'png-ours': { type: 'string' },
  'png-theirs': { type: 'string' },
  ours: { type: 'string' },
  theirs: { type: 'string' },
  seed: { type: 'string' },
  lang: { type: 'string' },
  key: { type: 'string' },
  picked: { type: 'string' },
  file: { type: 'string' },
  hypothesis: { type: 'string' },
  change: { type: 'string' },
  metrics: { type: 'string' },
  decision: { type: 'string' },
};

const need = (value, what) => {
  if (!value) throw new SpError('usage', `missing ${what}`, { hint: 'sp creative --help' });
  return value;
};
const exists = (file) => {
  if (!fs.existsSync(file)) throw new SpError('missing', `no such file: ${file}`);
  return file;
};
const readJson = (file) => JSON.parse(fs.readFileSync(exists(file), 'utf8'));
const list = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);
const write = (file, data) => {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
  return slash(path.resolve(file));
};

async function withFig(file, fn) {
  const { openFig } = await import('../lib/creative/figfile.mjs');
  const fig = openFig(exists(file));
  try {
    return await fn(fig);
  } finally {
    fig.close();
  }
}

async function loadScene(target, frame) {
  if (target.endsWith('.json')) return readJson(target);
  const { sceneOf } = await import('../lib/creative/scene.mjs');
  return withFig(target, (fig) => {
    const node = fig.doc.nodeMap.get(need(frame, '--frame <id>'));
    if (!node) throw new SpError('missing', `no frame ${frame} in ${target}`);
    return sceneOf(fig.doc, node, { source: { file: slash(path.resolve(target)), frame } });
  });
}

const VERBS = {
  async frames(ctx) {
    const [file] = ctx.positionals;
    const { listCreatives } = await import('../lib/creative/scene.mjs');
    const frames = await withFig(need(file, '<file.fig>'), (fig) => listCreatives(fig.doc, { page: ctx.args.page }));
    const bySize = {};
    for (const f of frames) bySize[f.size] = (bySize[f.size] || 0) + 1;
    if (ctx.args.out) return { count: frames.length, bySize, out: write(ctx.args.out, frames) };
    return { count: frames.length, bySize, frames };
  },

  async scene(ctx) {
    const scene = await loadScene(need(ctx.positionals[0], '<file.fig>'), ctx.args.frame);
    const roles = {};
    for (const n of scene.nodes) roles[n.role] = (roles[n.role] || 0) + 1;
    const head = { id: scene.id, name: scene.name, size: `${scene.width}x${scene.height}`, nodes: scene.nodes.length, roles };
    return ctx.args.out ? { ...head, out: write(ctx.args.out, scene) } : { ...head, scene };
  },

  async model(ctx) {
    const [file] = ctx.positionals;
    const out = need(ctx.args.out, '--out model.json');
    const { listCreatives, sceneOf } = await import('../lib/creative/scene.mjs');
    const { buildModel } = await import('../lib/creative/model.mjs');
    const size = ctx.args.size || '1080x1920';
    const exclude = new Set(list(ctx.args.exclude));
    const only = ctx.args.only ? new Set(readJson(ctx.args.only).map((x) => (typeof x === 'string' ? x : x.id))) : null;
    const pngDir = ctx.args['png-dir'];
    const { scenes, contrasts } = await withFig(need(file, '<file.fig>'), async (fig) => {
      const frames = listCreatives(fig.doc, { page: ctx.args.page }).filter((f) => f.size === size && !exclude.has(f.id) && (!only || only.has(f.id)));
      const scenes = frames.map((f) => sceneOf(fig.doc, f.id));
      let contrasts = null;
      if (pngDir) {
        const { loadRGBA, regionMedian } = await import('../lib/creative/image.mjs');
        const { contrast, parseHex } = await import('../lib/creative/color.mjs');
        contrasts = {};
        for (const s of scenes) {
          const png = path.join(pngDir, `${s.name}.png`);
          if (!fs.existsSync(png)) continue;
          const img = await loadRGBA(png, { width: Math.round(s.width), height: Math.round(s.height) });
          contrasts[s.id] = [];
          for (const n of s.nodes.filter((x) => x.role === 'text')) {
            const solid = n.fills.find((p) => p.type === 'solid');
            if (!solid) continue;
            const rgb = parseHex(solid.color).rgb;
            const bg = regionMedian(img.data, img.width, img.height, n.visible || n.box, rgb);
            if (bg) contrasts[s.id].push(Math.round(contrast(rgb, bg) * 100) / 100);
          }
        }
      }
      return { scenes, contrasts };
    });
    if (!scenes.length) throw new SpError('missing', `no ${size} frames to learn from`, { hint: 'check --page, --size, --only' });
    const model = buildModel(scenes, { source: { file: slash(path.resolve(file)), page: ctx.args.page || null, excluded: [...exclude] }, contrasts });
    return { frames: model.frames, fonts: Object.keys(model.fonts).length, colors: model.colors.length, contrastFrames: contrasts ? Object.keys(contrasts).length : 0, out: write(out, model) };
  },

  async lint(ctx) {
    const { lint } = await import('../lib/creative/lint.mjs');
    const scene = await loadScene(need(ctx.positionals[0], '<scene.json | file.fig>'), ctx.args.frame);
    const model = readJson(need(ctx.args.model, '--model model.json'));
    let png = null;
    if (ctx.args.png) {
      const { loadRGBA } = await import('../lib/creative/image.mjs');
      png = await loadRGBA(exists(ctx.args.png), { width: Math.round(scene.width), height: Math.round(scene.height) });
    }
    const palette = ctx.args.palette ? readJson(ctx.args.palette) : undefined;
    const report = lint(scene, model, { png, palette });
    const head = { scene: report.scene, name: report.name, errors: report.errors, warnings: report.warnings, pass: report.pass };
    return ctx.args.out ? { ...head, out: write(ctx.args.out, report) } : { ...head, violations: report.violations };
  },

  async diff(ctx) {
    const [ours, theirs] = ctx.positionals;
    const { reproduction } = await import('../lib/creative/reproduce.mjs');
    const result = await reproduction(exists(need(ours, '<ours.png>')), exists(need(theirs, '<theirs.png>')), { heatmap: ctx.args.heatmap });
    return { ...result, ...(ctx.args.heatmap ? { heatmap: slash(path.resolve(ctx.args.heatmap)) } : {}) };
  },

  async compare(ctx) {
    const [ours, theirs] = ctx.positionals;
    const { compareScenes } = await import('../lib/creative/compare.mjs');
    const result = compareScenes(readJson(need(ours, '<ours.json>')), readJson(need(theirs, '<theirs.json>')));
    if (ctx.args['png-ours'] && ctx.args['png-theirs']) {
      const { reproduction } = await import('../lib/creative/reproduce.mjs');
      const px = await reproduction(exists(ctx.args['png-ours']), exists(ctx.args['png-theirs']), { ssimScale: 0.25 });
      result.pixels = { ssim: px.ssim, deltaE: px.deltaE };
    }
    return result;
  },

  async blind(ctx) {
    const [, action] = ctx.positionals;
    const { makeBlind, scoreBlind } = await import('../lib/creative/blind.mjs');
    if (action === 'make') {
      const ours = list(need(ctx.args.ours, '--ours')).map(exists);
      const theirs = list(need(ctx.args.theirs, '--theirs')).map(exists);
      const lang = ctx.args.lang || loadConfig().operatorLanguage || 'uk';
      const made = await makeBlind({ ours, theirs, outDir: need(ctx.args.out, '--out <dir>'), seed: ctx.args.seed ? Number(ctx.args.seed) : undefined, lang });
      return { ...made, dir: slash(path.resolve(made.dir)), key: slash(made.key), open: slash(path.resolve(made.dir, 'index.html')) };
    }
    if (action === 'score') {
      const key = readJson(need(ctx.args.key, '--key'));
      return scoreBlind(key, list(need(ctx.args.picked, '--picked')));
    }
    throw new SpError('usage', 'expected: sp creative blind make | score', { hint: 'sp creative --help' });
  },

  async journal(ctx) {
    const [, action] = ctx.positionals;
    const { appendJournal, readJournal } = await import('../lib/creative/journal.mjs');
    const file = need(ctx.args.file, '--file <journal.jsonl>');
    if (action === 'add') {
      const metrics = ctx.args.metrics ? JSON.parse(ctx.args.metrics) : null;
      return { file: slash(path.resolve(file)), entry: appendJournal(file, { hypothesis: ctx.args.hypothesis, change: ctx.args.change, metrics, decision: ctx.args.decision }) };
    }
    if (action === 'list') {
      const entries = readJournal(file);
      return { file: slash(path.resolve(file)), count: entries.length, entries };
    }
    throw new SpError('usage', 'expected: sp creative journal add | list', { hint: 'sp creative --help' });
  },

  async regress(ctx) {
    const suiteFile = need(ctx.positionals[0], '<suite.json>');
    const suite = readJson(suiteFile);
    const base = path.dirname(path.resolve(suiteFile));
    const at = (p) => (p ? path.resolve(base, p) : p);
    const { reproduction } = await import('../lib/creative/reproduce.mjs');
    const { lint } = await import('../lib/creative/lint.mjs');
    const { compareScenes } = await import('../lib/creative/compare.mjs');
    const results = [];
    for (const c of suite.cases || []) {
      const e = c.expect || {};
      const fails = [];
      let metrics;
      try {
        if (c.kind === 'diff') {
          metrics = await reproduction(exists(at(c.ours)), exists(at(c.theirs)));
          if (e.ssimMin != null && metrics.ssim < e.ssimMin) fails.push(`ssim ${metrics.ssim} < ${e.ssimMin}`);
          if (e.changedMax != null && metrics.changed > e.changedMax) fails.push(`changed ${metrics.changed} > ${e.changedMax}`);
          if (e.deltaEp95Max != null && metrics.deltaE.p95 > e.deltaEp95Max) fails.push(`dE p95 ${metrics.deltaE.p95} > ${e.deltaEp95Max}`);
        } else if (c.kind === 'lint') {
          const r = lint(await loadScene(at(c.scene), c.frame), readJson(at(c.model)));
          metrics = { errors: r.errors, warnings: r.warnings, checks: [...new Set(r.violations.filter((v) => v.severity === 'error').map((v) => v.check))] };
          if (e.errorsMax != null && r.errors > e.errorsMax) fails.push(`errors ${r.errors} > ${e.errorsMax}`);
          // a negative control: a design the operator rejected must keep failing the lint
          if (e.errorsMin != null && r.errors < e.errorsMin) fails.push(`errors ${r.errors} < ${e.errorsMin} (negative control passed)`);
        } else if (c.kind === 'compare') {
          const r = compareScenes(readJson(at(c.ours)), readJson(at(c.theirs)));
          metrics = { score: r.score, f1: r.layout.f1, deltaE: r.palette.deltaE };
          if (e.scoreMin != null && r.score < e.scoreMin) fails.push(`score ${r.score} < ${e.scoreMin}`);
          if (e.f1Min != null && r.layout.f1 < e.f1Min) fails.push(`f1 ${r.layout.f1} < ${e.f1Min}`);
        } else fails.push(`unknown kind ${c.kind}`);
      } catch (err) {
        fails.push(err.message);
      }
      results.push({ name: c.name || c.kind, pass: !fails.length, fails, metrics });
    }
    const failed = results.filter((r) => !r.pass).length;
    return { suite: slash(path.resolve(suiteFile)), cases: results.length, failed, pass: failed === 0, results };
  },
};

export async function run(ctx) {
  const [verb] = ctx.positionals;
  const handler = VERBS[verb];
  if (!handler) throw new SpError('usage', `expected one of: ${Object.keys(VERBS).join(', ')}`, { hint: 'sp creative --help' });
  if (verb === 'blind' || verb === 'journal') return handler(ctx);
  return handler({ ...ctx, positionals: ctx.positionals.slice(1) });
}
