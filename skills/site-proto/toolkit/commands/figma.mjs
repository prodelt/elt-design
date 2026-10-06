import fs from 'node:fs';
import path from 'node:path';
import { SpError, slash } from '../lib/out.mjs';

export const summary = 'Build creatives in the operator\'s Figma from the client\'s real frames and elements; Figma renders the PNG.';

export const help = `Figma is the canvas of the creatives mode: a new creative is a copy of a real frame of the client's
design file with new texts, photos and colours (make), or a new frame assembled from that file's elements
by the layout rules of their corpus (compose), rendered by Figma itself. Needs Figma Desktop with the
client's frames in an open file and the Desktop Bridge plugin running in it.

sp figma up [--io <dir>] [--wait <seconds>]
    start what is missing (daemon :9240 with figma-console-mcp, sidecar :9232 for bytes) and wait for
    the plugin; --io is the sidecar's exchange folder (default ~/.site-proto/figma-io)
sp figma status
    daemon, sidecar and plugin: which file is connected; ready = all three
sp figma down
    stop the daemon and the sidecar (the plugin then shows it is disconnected)
sp figma slots <frame name | id> [--out slots.json]
    what a reference frame lets you change: texts (slot key, runs, font, size, box), image fills,
    layers down to depth 2, and the colours in use. Slot keys are child index paths ("6.1.0"): ids
    change on copy, keys do not, so a key read here addresses the same node in every copy
sp figma make <spec.json> [--model model.json] [--palette palette.json] [--out <path without extension>]
    copy the reference frame to the page "site-proto" and apply the spec, then write <out>.png
    (Figma's render) and <out>.scene.json, and lint the scene when --model is given. Spec:
      { "from": "<frame name | id>", "name": "<new frame name>",
        "texts":  { "<key>": "text" | ["run 0", "run 1"] },   an array keeps each run's style
        "images": { "<key>": "photo.jpg" | "hash:<imageHash>" | { "src": …, "mode": "FILL" } },
                  paths relative to the spec; mode FILL drops the old photo's crop and centres the new one
        "recolor": "palette" | { "#1EA6DF": "#EF5CA1" },        "palette" = the palette's map
        "recolorAt": { "<key>": { "#EF5CA1": "#FEF3F8" } },      after recolor, one subtree ("" = frame)
        "hide": ["<key>"], "show": ["<key>"],
        "insert": [{ "from": "<node id>", "x": 0, "y": 0, "w": 240, "rotation": -8, "above": "<key>" }],
        "palette": "<palette.json, relative to the spec>" }
    Warnings flag a text that outgrows its box, fills < 80 % of the room the reference text took (a
    half-empty card), loses the padding of the plate or pill behind it, or does not render;
    --out defaults to the spec's path without .json
sp figma compose <spec.json> [--model model.json] [--palette palette.json] [--out <path without extension>]
    a NEW frame on the spec's page, assembled from elements cloned out of the client's frames and set
    by the layout rules measured on their corpus (lib/creative/figma/layout.mjs); then recolour, PNG,
    scene and lint as make. An element is { "from": "<frame name | id>", "key": "<slot key>" } or a node
    id; slot keys as sp figma slots prints them. Spec:
      { "name": "<frame name>", "page": "site-proto", "x": 0, "y": 0,
        "background": { "from": "<frame>", "keys": ["0"] },  its fills, and those layers where they were
        "logo": { "from": "<frame>", "key": "2", "w": 313 },   centred, at the corpus's logo top
        "align": "center" | "left" | "right",  "valign": "center" | "top" | "bottom",
        "width": 820,                                          content width (default: the rules')
        "blocks": [                                            stacked top to bottom with the corpus's gaps
          { "type": "text",  "style": <text element>, "text": "…" | ["run 0", "run 1"] },
          { "type": "card",  "shape": <shape>, "style": <text>, "text": "…", "align": "left", "w": 820,
                             "pad": { "x": 45, "top": 28, "bottom": 31 } },  card = text + padding
          { "type": "pills", "shape": <shape>, "style": <text>, "items": ["…"], "flow": "column" | "row",
                             "stagger": true | <px>, "tilt": 7 },  padding: "pad", else the designers' own
          { "type": "image", "from": <node with a photo fill>, "src": "hash:<h>" | "photo.jpg",
                             "h": 900, "bleed": "top" | "bottom", "overlap": 0 },  bled = full width
          { "type": "sticker", "from": "<node id>", "w": 300, "rotation": 8 },
          { "type": "layer", "from": "<frame>", "key": "…" },  decoration where it was in its frame
          { "type": "space", "h": 320, "label": "IG poll" } ],  room kept for an Instagram widget
        "recolor": "palette" | { … }, "palette": "<palette.json>",
        "recolorAt": { "" | "background" | "logo" | "<block index>": { "#EF5CA1": "#FEF3F8" } },
        "rules": "<layout-rules.json, relative to the spec>" | { … } }
    Any block takes "gap" (px above it), "x", and "y" (pins it, out of the stack). A title (the text
    block set largest) past 3 lines steps down 8 % at most twice. Warnings: the stack outgrows the zone
    between logo and 1732 px, a title still past 3 lines, a sticker over text. Shapes are resized (a
    group: its largest shape), texts get new characters; nothing else is drawn
sp figma png <frame name | id> --out <file.png> [--theirs <their.png>] [--heatmap diff.png]
    Figma's PNG of a frame; with --theirs also the reproduction test (SSIM, changed pixels, dE2000)
sp figma exec "<Plugin API code>" | --file <code.js>
    run code in the plugin (an async body that returns a JSON value), with the helpers loaded as sp
    (sp.slots, sp.make, sp.scene, sp.recolor, sp.setRuns, ...: lib/creative/figma/plugin.js)

Each subcommand prints one JSON line.`;

export const options = {
  io: { type: 'string' },
  wait: { type: 'string' },
  out: { type: 'string' },
  model: { type: 'string' },
  palette: { type: 'string' },
  theirs: { type: 'string' },
  file: { type: 'string' },
  heatmap: { type: 'string' },
};

const need = (value, what) => {
  if (!value) throw new SpError('usage', `missing ${what}`, { hint: 'sp figma --help' });
  return value;
};
const readJson = (file) => {
  if (!fs.existsSync(file)) throw new SpError('missing', `no such file: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

// with --model: the style lint of the built frame's scene and PNG
async function withLint(ctx, result, r, palette) {
  if (!ctx.args.model) return result;
  const { lint } = await import('../lib/creative/lint.mjs');
  const { loadRGBA } = await import('../lib/creative/image.mjs');
  const scene = readJson(r.scene);
  const png = await loadRGBA(r.png, { width: Math.round(scene.width), height: Math.round(scene.height) });
  // the lint checks against the table actually applied: the palette's map plus the near shades added to it
  const applied = palette && r.recolorMap ? { ...palette, map: r.recolorMap } : palette;
  const report = lint(scene, readJson(ctx.args.model), { png, palette: applied });
  return { ...result, lint: { errors: report.errors, warnings: report.warnings, pass: report.pass, violations: report.violations } };
}

const VERBS = {
  async up(ctx, b) {
    return b.up({ io: ctx.args.io, waitMs: 1000 * Number(ctx.args.wait || 20) });
  },
  async status(ctx, b) {
    return b.status();
  },
  async down(ctx, b) {
    return b.down();
  },
  async slots(ctx, b) {
    const s = await b.slots(need(ctx.positionals[0], '<frame name | id>'));
    if (!ctx.args.out) return s;
    fs.writeFileSync(ctx.args.out, JSON.stringify(s, null, 1));
    return { id: s.id, name: s.name, texts: s.texts.length, images: s.images.length, layers: s.layers.length, out: slash(path.resolve(ctx.args.out)) };
  },
  async make(ctx, b) {
    const specFile = path.resolve(need(ctx.positionals[0], '<spec.json>'));
    const spec = readJson(specFile);
    const baseDir = path.dirname(specFile);
    const paletteFile = ctx.args.palette || (spec.palette && path.resolve(baseDir, spec.palette));
    const palette = paletteFile ? readJson(paletteFile) : undefined;
    const outBase = ctx.args.out || specFile.replace(/\.json$/i, '');
    const r = await b.make(spec, { baseDir, outBase, palette });
    const result = { id: r.id, name: r.name, page: r.page, from: r.from, png: r.png, scene: r.scene, warnings: r.warnings, texts: r.texts, coverage: r.coverage, recolorAdded: r.recolorAdded, inserted: r.inserted, ms: r.ms };
    return withLint(ctx, result, r, palette);
  },
  async compose(ctx, b) {
    const specFile = path.resolve(need(ctx.positionals[0], '<spec.json>'));
    const spec = readJson(specFile);
    const baseDir = path.dirname(specFile);
    const paletteFile = ctx.args.palette || (spec.palette && path.resolve(baseDir, spec.palette));
    const palette = paletteFile ? readJson(paletteFile) : undefined;
    const rules = typeof spec.rules === 'string' ? readJson(path.resolve(baseDir, spec.rules)) : spec.rules;
    const outBase = ctx.args.out || specFile.replace(/\.json$/i, '');
    const r = await b.compose(spec, { baseDir, outBase, palette, rules });
    const result = { id: r.id, name: r.name, page: r.page, png: r.png, scene: r.scene, warnings: r.warnings, layout: r.layout, fit: r.fit, texts: r.texts, recolorAdded: r.recolorAdded, ms: r.ms };
    return withLint(ctx, result, r, palette);
  },
  async exec(ctx, b) {
    const code = ctx.args.file ? fs.readFileSync(ctx.args.file, 'utf8') : need(ctx.positionals[0], '"<code>" or --file <code.js>');
    await b.helpers();
    return { result: await b.exec(code) };
  },
  async png(ctx, b) {
    const r = await b.png(need(ctx.positionals[0], '<frame name | id>'), need(ctx.args.out, '--out <file.png>'));
    if (!ctx.args.theirs) return r;
    const { reproduction } = await import('../lib/creative/reproduce.mjs');
    return { ...r, reproduction: await reproduction(r.png, ctx.args.theirs, { heatmap: ctx.args.heatmap }) };
  },
};

export async function run(ctx) {
  const [verb] = ctx.positionals;
  const handler = VERBS[verb];
  if (!handler) throw new SpError('usage', `expected one of: ${Object.keys(VERBS).join(', ')}`, { hint: 'sp figma --help' });
  const { bridge } = await import('../lib/creative/figma/bridge.mjs');
  return handler({ ...ctx, positionals: ctx.positionals.slice(1) }, bridge());
}
