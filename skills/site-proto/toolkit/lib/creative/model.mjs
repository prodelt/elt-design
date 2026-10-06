// The style model of a client's creatives, learned from their own frames: fonts and the sizes, tracking
// and leading each font is set at, colour tokens (CIEDE2000 clusters), effect and radius presets, and
// envelopes (percentiles) of layout and density features. The lint checks a new creative against it,
// so every threshold comes from the client's corpus, not from a generic rulebook.
import { deltaE2000, hexToLab, labToLch, parseHex } from './color.mjs';

const r2 = (v) => Math.round(v * 100) / 100;

function quantiles(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const q = (p) => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))];
  return { n: v.length, min: r2(v[0]), p5: r2(q(0.05)), p50: r2(q(0.5)), p95: r2(q(0.95)), max: r2(v.at(-1)) };
}

const rgbHex = (hex8) => hex8.slice(0, 7).toUpperCase();
const alphaOf = (hex8) => parseHex(hex8).a;

// every colour a creative paints with (not photos, not shadows): '#RRGGBB' -> uses
export function sceneColors(scene) {
  const out = new Map();
  const add = (hex8) => {
    if (alphaOf(hex8) < 0.05) return;
    const k = rgbHex(hex8);
    out.set(k, (out.get(k) || 0) + 1);
  };
  const take = (p) => {
    if (p.type === 'solid') add(p.color);
    else if (p.stops) p.stops.forEach((s) => add(s.color));
  };
  scene.fills.forEach(take);
  for (const n of scene.nodes) {
    if (n.role === 'logo-part' || n.role === 'image') continue;
    n.fills.forEach(take);
    n.strokes.forEach(take);
    for (const r of n.text?.runs || []) if (r.color) add(r.color);
  }
  return out;
}

// the arc of hues a creative spans, over its chromatic colours (chroma >= 15): 0 for one hue family
export function hueSpread(colors) {
  const hues = [...new Set([...colors.keys()].map((hex) => labToLch(hexToLab(hex))).filter(([, C]) => C >= 15).map(([, , h]) => Math.round(h)))].sort((a, b) => a - b);
  if (hues.length < 2) return 0;
  let gap = 360 - hues.at(-1) + hues[0];
  for (let i = 1; i < hues.length; i++) gap = Math.max(gap, hues[i] - hues[i - 1]);
  return 360 - gap;
}

export const fontKey = (t) => `${t.family}|${t.style}`;

// how far a text box may stick out of a card sideways and still count as sitting in it
export const CARD_SIDE = 4;
// cards: glass, or a filled rounded shape, big enough to hold a text
export const cardsOf = (scene) => scene.nodes.filter((n) => (n.role === 'glass' || (n.role === 'shape' && n.fills.length && n.radius >= 8)) && n.box.w >= 60 && n.box.h >= 40);
// the height the glyphs of a text take (a fixed box can be taller or shorter than its lines)
export const glyphHeight = (n) => Math.min(n.box.h, n.text.lines.length * (n.text.lineHeightPx || n.text.size * 1.2));
// parent id of each node id, for inCard
export const parentsOf = (scene) => new Map(scene.nodes.map((n) => [n.id, n.parent]));
// texts sitting in a card: inside it horizontally, their top inside it, and on the card's branch of the
// layer tree (the card's parent is an ancestor of the text): tilted pills overlap, and a label of one pill
// falls in the box of the pill above it
export const inCard = (n, c, parents) => {
  const tb = n.box, cb = c.box;
  if (!(cb.w * cb.h > tb.w * tb.h && tb.x >= cb.x - CARD_SIDE && tb.x + tb.w <= cb.x + cb.w + CARD_SIDE && tb.y >= cb.y && tb.y < cb.y + cb.h)) return false;
  if (!parents) return true;
  for (let p = n.parent; ; p = parents.get(p)) {
    if ((p ?? null) === (c.parent ?? null)) return true;
    if (p == null) return false;
  }
};

// the emptiest card holding text: share of its height left below the last line (0 = filled to the bottom)
function cardSlack(scene, texts) {
  let worst = null;
  const parents = parentsOf(scene);
  for (const c of cardsOf(scene)) {
    const held = texts.filter((n) => inCard(n, c, parents));
    if (!held.length) continue;
    const bottom = Math.max(...held.map((n) => n.box.y + glyphHeight(n)));
    const slack = Math.max(0, (c.box.y + c.box.h - bottom) / c.box.h);
    worst = worst == null ? slack : Math.max(worst, slack);
  }
  return worst == null ? null : r2(worst);
}

// per-scene features the envelopes are built from
export function features(scene) {
  const W = scene.width, H = scene.height;
  const texts = scene.nodes.filter((n) => n.role === 'text' && n.text?.chars?.trim());
  const vis = (n) => n.visible || n.box;
  // content text sits wholly inside the frame; text bleeding off the edge is decoration (a repeated
  // wordmark band, a giant numeral) and would otherwise widen every margin envelope to zero
  const inside = (b) => b.x >= -1 && b.y >= -1 && b.x + b.w <= W + 1 && b.y + b.h <= H + 1;
  const content = texts.filter((n) => inside(n.box));
  const title = [...content].sort((a, b) => b.text.size - a.text.size || b.box.w * b.box.h - a.box.w * a.box.h)[0] || null;
  const logo = scene.nodes.find((n) => n.role === 'logo');
  const count = (role) => scene.nodes.filter((n) => n.role === role).length;
  const colors = sceneColors(scene);
  return {
    texts,
    title,
    colors,
    marginLeft: content.length ? Math.min(...content.map((n) => vis(n).x)) : null,
    marginRight: content.length ? Math.min(...content.map((n) => W - (vis(n).x + vis(n).w))) : null,
    textTop: content.length ? Math.min(...content.map((n) => vis(n).y)) : null,
    textBottom: content.length ? Math.max(...content.map((n) => vis(n).y + vis(n).h)) : null,
    logoCx: logo ? logo.box.x + logo.box.w / 2 : null,
    logoTop: logo ? logo.box.y : null,
    logoW: logo ? logo.box.w : null,
    textCoverage: content.reduce((s, n) => s + vis(n).w * vis(n).h, 0) / (W * H),
    nodes: scene.nodes.filter((n) => n.role !== 'logo-part' && n.role !== 'container').length,
    textCount: texts.length,
    images: count('image'),
    glass: count('glass'),
    blobs: count('blob'),
    titleSize: title ? title.text.size : null,
    titleMaxChars: title ? Math.max(0, ...title.text.lines.map((l) => l.text.length)) : null,
    hueSpread: hueSpread(colors),
    cardSlack: cardSlack(scene, content),
  };
}

export const ENVELOPES = ['marginLeft', 'marginRight', 'textTop', 'textBottom', 'logoCx', 'logoTop', 'logoW', 'textCoverage', 'nodes', 'textCount', 'titleSize', 'titleMaxChars', 'hueSpread', 'cardSlack'];

// greedy CIEDE2000 clustering, most used colours first
function colorTokens(counts, radius = 2) {
  const tokens = [];
  for (const [hex, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    const lab = hexToLab(hex);
    const hit = tokens.find((t) => deltaE2000(t.lab, lab) < radius);
    if (hit) hit.count += count;
    else tokens.push({ hex, count, lab: lab.map(r2) });
  }
  return tokens;
}

// contrasts: optional { frameId: [ratio, ...] } measured on the client's own renders
export function buildModel(scenes, { source, contrasts } = {}) {
  if (!scenes.length) throw new Error('no scenes to learn from');
  const size = `${Math.round(scenes[0].width)}x${Math.round(scenes[0].height)}`;
  const fonts = {};
  const text = [];
  const colorCounts = new Map();
  const effects = new Map();
  const radii = new Map();
  const feats = [];
  let withLogo = 0;
  for (const scene of scenes) {
    const f = features(scene);
    feats.push(f);
    if (f.logoCx != null) withLogo++;
    for (const [hex, c] of f.colors) colorCounts.set(hex, (colorCounts.get(hex) || 0) + c);
    for (const n of f.texts) {
      const k = fontKey(n.text);
      (fonts[k] ??= { count: 0 }).count++;
      text.push({
        font: k,
        size: n.text.size,
        tracking: n.text.trackingPct,
        leading: n.text.lineHeightPx ? r2(n.text.lineHeightPx / n.text.size) : null,
        chars: Math.max(0, ...n.text.lines.map((l) => l.text.length)),
      });
    }
    for (const n of scene.nodes) {
      for (const e of n.effects) {
        const key = `${e.type}|${Math.round(e.radius)}`;
        effects.set(key, (effects.get(key) || 0) + 1);
      }
      if (n.radius != null && n.role !== 'logo-part') radii.set(Math.round(n.radius), (radii.get(Math.round(n.radius)) || 0) + 1);
    }
  }
  const envelopes = {};
  for (const k of ENVELOPES) envelopes[k] = quantiles(feats.map((f) => f[k]));
  const allContrasts = contrasts ? Object.values(contrasts).flat() : [];
  return {
    kind: 'site-proto/style-model',
    version: 1,
    size,
    frames: scenes.length,
    source: source || null,
    logoShare: r2(withLogo / scenes.length),
    fonts,
    text,
    colors: colorTokens(colorCounts),
    effects: [...effects].map(([k, count]) => ({ type: k.split('|')[0], radius: Number(k.split('|')[1]), count })).sort((a, b) => b.count - a.count),
    radii: [...radii].map(([value, count]) => ({ value, count })).sort((a, b) => a.value - b.value),
    envelopes,
    contrast: allContrasts.length ? quantiles(allContrasts) : null,
  };
}
