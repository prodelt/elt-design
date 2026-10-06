// Level 2, Style lint: is every value of a new creative one the client's designers use?
// Errors fall outside everything the corpus shows (min..max plus a small tolerance); warnings fall outside
// its usual range (p5..p95). A value the designers never used needs a stated reason, not a silent pass.
import { contrast, deltaE2000, hexToLab, parseHex } from './color.mjs';
import { cardsOf, features, fontKey, glyphHeight, inCard, parentsOf } from './model.mjs';
import { regionMedian } from './image.mjs';
import { intersect } from './scene.mjs';

// tolerance added to the corpus min..max before a value counts as an error
const TOLERANCE = { marginLeft: 8, marginRight: 8, textTop: 16, textBottom: 16, logoCx: 12, logoTop: 16, logoW: 12, textCoverage: 0.02, nodes: 2, textCount: 1, titleSize: 4, titleMaxChars: 2, hueSpread: 10, cardSlack: 0.05 };
// which side of an envelope matters: margins only too small, spreads and counts only too large
const SIDE = { marginLeft: 'low', marginRight: 'low', textTop: 'low', textBottom: 'high', hueSpread: 'high', titleMaxChars: 'high', cardSlack: 'high' };
// CIEDE2000 distance to the nearest token that still counts as that token (calibrated by cross-validation)
export const COLOR_RADIUS = 5;
// A creative passes with at most this many errors. Calibrated on a medical-centre test set (ticket 43): 5-fold
// cross-validation over 98 current-style stories gave >= 3 errors on 4 % of the designers' own frames,
// while each of the four rejected variants V1-V4 had 5 to 11.
export const GATE_MAX_ERRORS = 2;
// fewer samples of a font than this make its size, tracking and leading ranges warnings, not errors
const MIN_SAMPLES = 5;

function envelopeCheck(check, value, env, tol, side = 'both') {
  if (value == null || !env) return null;
  const low = side !== 'high', high = side !== 'low';
  if ((low && value < env.min - tol) || (high && value > env.max + tol)) {
    return { check, severity: 'error', value: round(value), expected: `${env.min}..${env.max} (corpus)` };
  }
  if ((low && value < env.p5) || (high && value > env.p95)) {
    return { check, severity: 'warn', value: round(value), expected: `${env.p5}..${env.p95} (p5..p95)` };
  }
  return null;
}
const round = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);

function neighbours(model, font, size, spread = 0.2) {
  const same = model.text.filter((t) => t.font === font);
  const near = same.filter((t) => Math.abs(t.size - size) <= size * spread);
  return near.length >= 3 ? near : same;
}
const range = (xs) => (xs.length ? [Math.min(...xs), Math.max(...xs)] : null);

// png: optional { data, width, height } render of the same creative, for contrast.
// palette: optional campaign palette { map: {'#client': '#campaign', …}, extra: ['#hex', …] }. A colour then
// passes when it is a client token, a token translated through the map, or a colour of the campaign sketch
// (extra); a colour the map translates that is still in the creative is an error (a missed recolour).
export function lint(scene, model, { png, palette, colorRadius = COLOR_RADIUS } = {}) {
  const out = [];
  const push = (v, node) => v && out.push(node ? { ...v, node: node.id, name: node.name } : v);
  const size = `${Math.round(scene.width)}x${Math.round(scene.height)}`;
  if (size !== model.size) out.push({ check: 'model.size', severity: 'error', value: size, expected: model.size });
  const f = features(scene);

  for (const n of f.texts) {
    const t = n.text;
    const key = fontKey(t);
    if (!model.fonts[key]) {
      push({ check: 'text.font', severity: 'error', value: key, expected: Object.keys(model.fonts).join(', ') }, n);
      continue;
    }
    const all = model.text.filter((x) => x.font === key);
    const sure = (samples) => (samples.length >= MIN_SAMPLES ? 'error' : 'warn');
    const sizes = range(all.map((x) => x.size));
    if (sizes && (t.size < sizes[0] * 0.9 || t.size > sizes[1] * 1.1)) push({ check: 'text.size', severity: sure(all), value: t.size, expected: `${sizes[0]}..${sizes[1]} for ${key}` }, n);
    const near = neighbours(model, key, t.size);
    const tr = range(near.map((x) => x.tracking));
    if (tr && (t.trackingPct < tr[0] - 1.5 || t.trackingPct > tr[1] + 1.5)) push({ check: 'text.tracking', severity: sure(near), value: round(t.trackingPct), expected: `${round(tr[0])}..${round(tr[1])} % at ~${t.size}px` }, n);
    const withLeading = near.filter((x) => x.leading != null);
    const ld = range(withLeading.map((x) => x.leading));
    const leading = t.lineHeightPx ? t.lineHeightPx / t.size : null;
    if (ld && leading != null && t.lines.length > 1 && (leading < ld[0] - 0.08 || leading > ld[1] + 0.08)) push({ check: 'text.leading', severity: sure(withLeading), value: round(leading), expected: `${ld[0]}..${ld[1]} x size` }, n);
    const ch = range(near.map((x) => x.chars));
    const longest = Math.max(0, ...t.lines.map((l) => l.text.length));
    if (ch && longest > ch[1] * 1.1 + 1) push({ check: 'text.measure', severity: 'warn', value: longest, expected: `<= ${ch[1]} chars per line at ~${t.size}px` }, n);
    if (t.overflow) push({ check: 'text.overflow', severity: 'error', value: t.lines.length + ' lines', expected: `inside ${Math.round(n.box.w)}x${Math.round(n.box.h)}` }, n);
    if (png) {
      const solid = n.fills.find((p) => p.type === 'solid');
      if (solid) {
        const rgb = parseHex(solid.color).rgb;
        const bg = regionMedian(png.data, png.width, png.height, n.visible || n.box, rgb);
        if (bg) {
          const c = contrast(rgb, bg);
          const floor = model.contrast ? Math.max(1.3, model.contrast.min - 0.1) : 1.8;
          if (c < floor) push({ check: 'text.contrast', severity: 'error', value: round(c), expected: `>= ${round(floor)}` }, n);
        }
      }
    }
  }

  // text spilling out of its card: a text that sits in a card (inside it horizontally, its top inside) but
  // whose glyphs run below the card's bottom. Found on the ticket-15 probe, where a longer body text grew
  // 44 px below its glass card. The designers' own texts cross card edges sideways (bleeding panels), not
  // downward: on the test corpus this rule fires on 4 of 98 stories (cross-validated), the probe clone on 1 of 1.
  const cards = cardsOf(scene);
  const parents = parentsOf(scene);
  for (const n of f.texts) {
    const tb = n.box, t = n.text;
    for (const c of cards) {
      const cb = c.box;
      const below = tb.y + glyphHeight(n) - (cb.y + cb.h);
      if (inCard(n, c, parents) && below > Math.max(6, t.size * 0.25)) {
        push({ check: 'text.spill', severity: 'error', value: `${Math.round(below)} px below`, expected: `inside card ${c.id} ${Math.round(cb.w)}x${Math.round(cb.h)}` }, n);
        break;
      }
    }
  }

  // colours: each distinct colour once, with the nodes that use it
  const tokens = model.colors.map((t) => t.lab);
  const targets = palette ? [...Object.values(palette.map || {}), ...(palette.extra || [])].map(hexToLab) : [];
  const sources = palette ? Object.keys(palette.map || {}).map(hexToLab) : [];
  const nearest = (list, lab) => (list.length ? Math.min(...list.map((t) => deltaE2000(t, lab))) : Infinity);
  const offToken = new Map();
  const visit = (hex8, node) => {
    if (parseHex(hex8).a < 0.05) return;
    const hex = hex8.slice(0, 7).toUpperCase();
    if (offToken.has(hex)) return offToken.get(hex)?.nodes.push(node.id);
    const lab = hexToLab(hex);
    const dTarget = nearest(targets, lab);
    const d = Math.min(nearest(tokens, lab), dTarget);
    const unmapped = nearest(sources, lab) <= colorRadius && dTarget > colorRadius;
    offToken.set(hex, unmapped ? { unmapped, d, nodes: [node.id] } : d > colorRadius ? { d, nodes: [node.id] } : null);
  };
  const paintsOf = (p, node) => (p.type === 'solid' ? visit(p.color, node) : p.stops?.forEach((s) => visit(s.color, node)));
  scene.fills.forEach((p) => paintsOf(p, { id: scene.id }));
  for (const n of scene.nodes) {
    if (n.role === 'image' || n.role === 'logo-part') continue;
    n.fills.forEach((p) => paintsOf(p, n));
    n.strokes.forEach((p) => paintsOf(p, n));
  }
  for (const [hex, hit] of offToken) {
    if (hit?.unmapped) out.push({ check: 'color.unmapped', severity: 'error', value: hex, expected: 'translated by the campaign palette map', nodes: hit.nodes.slice(0, 8) });
    else if (hit) out.push({ check: 'color.token', severity: 'error', value: hex, expected: `a ${palette ? 'client or campaign' : 'client'} colour (nearest dE00 ${round(hit.d)})`, nodes: hit.nodes.slice(0, 8) });
  }

  // effects and radii the designers never used
  const presets = model.effects;
  for (const n of scene.nodes) {
    for (const e of n.effects) {
      const ok = presets.some((p) => p.type === e.type && Math.abs(p.radius - e.radius) <= Math.max(2, p.radius * 0.25));
      if (!ok) push({ check: 'effect.preset', severity: 'warn', value: `${e.type} r${e.radius}` }, n);
    }
    if (n.radius != null && n.role !== 'logo-part' && model.radii.length) {
      const ok = model.radii.some((r) => Math.abs(r.value - n.radius) <= 3);
      if (!ok) push({ check: 'shape.radius', severity: 'warn', value: n.radius }, n);
    }
  }

  // layout and density against the corpus envelopes
  const env = model.envelopes;
  for (const k of ['marginLeft', 'marginRight', 'textTop', 'textBottom', 'textCoverage', 'nodes', 'textCount', 'titleSize', 'titleMaxChars', 'hueSpread', 'cardSlack']) {
    push(envelopeCheck(`layout.${k}`, f[k], env[k], TOLERANCE[k], SIDE[k]));
  }
  if (f.logoCx != null) for (const k of ['logoCx', 'logoTop', 'logoW']) push(envelopeCheck(`logo.${k.slice(4).toLowerCase()}`, f[k], env[k], TOLERANCE[k]));
  else if (model.logoShare >= 0.9) out.push({ check: 'logo.missing', severity: 'warn', value: null, expected: `logo on ${Math.round(model.logoShare * 100)}% of corpus frames` });

  const errors = out.filter((v) => v.severity === 'error').length;
  return { scene: scene.id, name: scene.name, errors, warnings: out.length - errors, pass: errors <= GATE_MAX_ERRORS, violations: out };
}
