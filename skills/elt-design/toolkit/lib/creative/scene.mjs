// The scene graph of one creative: every visible node of a frame flattened with frame-relative boxes,
// exact paints, effects and text metrics, and a role (text, image, glass, blob, logo, shape, container).
// The style model, the lint and the reconstruction compare all read scenes, never .fig internals, so a
// scene built from a live Figma file through the plugin bridge (same JSON shape) is checked the same way.
//
// Scene: { id, name, width, height, fills: [Paint], nodes: [Node], source? }
// Node:  { id, parent, depth, type, role, name, box, visible, opacity, alpha, blend?, radius?,
//          fills: [Paint], strokes: [Paint], effects: [Effect], text?: Text, image?: { hash, mode } }
// Paint: { type: 'solid', color: '#RRGGBBAA' } | { type: 'linear'|'radial'|'angular'|'diamond', stops: [{ color, pos }] }
//        | { type: 'image', hash, mode }
// Text:  { chars, family, style, size, lineHeightPx|null, trackingPct, align, lines: [{ text, width }],
//          overflow: boolean, runs: [{ text, family?, style?, size?, color? }] }
import { nodeId } from 'openfig-core';
import { figColorHex } from './color.mjs';

export const CREATIVE_SIZES = ['1080x1920', '1080x1350', '1080x1080', '2160x3840', '2160x2700'];

const IDENTITY = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
const mul = (A, B) => ({
  m00: A.m00 * B.m00 + A.m01 * B.m10, m01: A.m00 * B.m01 + A.m01 * B.m11, m02: A.m00 * B.m02 + A.m01 * B.m12 + A.m02,
  m10: A.m10 * B.m00 + A.m11 * B.m10, m11: A.m10 * B.m01 + A.m11 * B.m11, m12: A.m10 * B.m02 + A.m11 * B.m12 + A.m12,
});
function boxOf(M, w, h) {
  const pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => [M.m00 * x + M.m01 * y + M.m02, M.m10 * x + M.m11 * y + M.m12]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x: r1(x), y: r1(y), w: r1(Math.max(...xs) - x), h: r1(Math.max(...ys) - y) };
}
export function intersect(a, b) {
  if (!a || !b) return null;
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
}
const r1 = (v) => Math.round(v * 10) / 10;
const hashHex = (h) => (h ? [...h].map((b) => b.toString(16).padStart(2, '0')).join('') : null);
const kidsOf = (doc, n) => doc.childrenMap.get(nodeId(n)) || [];

function paint(p) {
  if (!p || p.visible === false) return null;
  const op = p.opacity ?? 1;
  if (op === 0) return null;
  if (p.type === 'SOLID') return { type: 'solid', color: figColorHex(p.color, op) };
  if (p.type?.startsWith('GRADIENT_')) {
    return { type: p.type.slice(9).toLowerCase(), stops: (p.stops || []).map((s) => ({ color: figColorHex(s.color, op), pos: r1(s.position * 100) / 100 })) };
  }
  if (p.type === 'IMAGE') return { type: 'image', hash: hashHex(p.image?.hash), mode: p.imageScaleMode || 'FILL' };
  return null;
}
const paints = (list) => (list || []).map(paint).filter(Boolean);

function effects(n) {
  return (n.effects || [])
    .filter((e) => e.visible !== false)
    .map((e) => ({
      type: e.type,
      radius: r1(e.radius || 0),
      ...(e.type.includes('SHADOW') ? { x: r1(e.offset?.x || 0), y: r1(e.offset?.y || 0), spread: r1(e.spread || 0), color: figColorHex(e.color || { r: 0, g: 0, b: 0, a: 0 }) } : {}),
    }));
}

function radiusOf(n) {
  if (n.cornerRadius !== undefined && n.cornerRadius !== 0) return r1(n.cornerRadius);
  const c = [n.rectangleTopLeftCornerRadius, n.rectangleTopRightCornerRadius, n.rectangleBottomRightCornerRadius, n.rectangleBottomLeftCornerRadius];
  if (c.some((v) => v)) return r1(Math.max(...c.map((v) => v || 0)));
  return undefined;
}

function textOf(n, box) {
  const chars = n.textData?.characters || '';
  const size = n.fontSize || 0;
  const lh = n.lineHeight;
  let lineHeightPx = null;
  if (lh?.units === 'PIXELS') lineHeightPx = lh.value;
  else if (lh?.units === 'PERCENT') lineHeightPx = (lh.value / 100) * size;
  else if (lh?.units === 'RAW') lineHeightPx = lh.value * size;
  const ls = n.letterSpacing;
  const trackingPct = !ls ? 0 : ls.units === 'PIXELS' ? (size ? (ls.value / size) * 100 : 0) : ls.value;
  const baselines = n.derivedTextData?.baselines || [];
  const lines = baselines
    .map((b) => ({ text: chars.slice(b.firstCharacter, b.endCharacter).replace(/\s+$/, ''), width: r1(b.width || 0), baseline: b.position?.y ?? (b.lineY || 0) + (b.lineAscent || 0) }))
    .filter((l) => l.text.length);
  // Figma wraps inside the box, and a line's width counts its trailing space, so only a single word
  // wider than the box, glyphs (last baseline + descender) below a fixed box, or Figma's own
  // truncation is an overflow; a one-line label in a tight box is a designer's choice, not an overflow
  const glyphBottom = Math.max(0, ...lines.map((l) => l.baseline)) + size * 0.22;
  const fixedBox = n.textAutoResize === 'NONE' || n.textAutoResize === undefined;
  const overflow =
    (n.derivedTextData?.truncationStartIndex ?? -1) >= 0 ||
    (lines.length > 1 && fixedBox && glyphBottom > box.h + Math.max(2, size * 0.15)) ||
    lines.some((l) => !/\s/.test(l.text) && l.width > box.w + Math.max(2, size * 0.1));
  const table = new Map((n.textData?.styleOverrideTable || []).map((s) => [s.styleID, s]));
  const runs = [];
  const ids = n.textData?.characterStyleIDs || [];
  let cur = null, start = 0;
  for (let i = 0; i <= ids.length; i++) {
    const sid = i < ids.length ? ids[i] : -1;
    if (sid === cur) continue;
    if (cur !== null && cur !== 0 && i > start) {
      const o = table.get(cur) || {};
      const fill = paints(o.fillPaints)[0];
      runs.push({ text: chars.slice(start, i), family: o.fontName?.family, style: o.fontName?.style, size: o.fontSize, color: fill?.type === 'solid' ? fill.color : undefined });
    }
    cur = sid;
    start = i;
  }
  return {
    chars,
    family: n.fontName?.family || null,
    style: n.fontName?.style || null,
    size: r1(size),
    lineHeightPx: lineHeightPx == null ? null : r1(lineHeightPx),
    trackingPct: r1(trackingPct * 10) / 10,
    align: n.textAlignHorizontal || 'LEFT',
    lines: lines.map(({ text, width }) => ({ text, width })),
    overflow,
    runs: runs.filter((r) => r.family || r.style || r.size || r.color),
  };
}

// an outlined wordmark: a group of >= 7 same-height vectors (letters), optionally next to a 3-vector mark
function looksLikeWordmark(doc, n) {
  const kv = kidsOf(doc, n).filter((k) => k.visible !== false);
  if (kv.length < 7 || !kv.every((k) => k.type === 'VECTOR')) return false;
  const hs = kv.map((k) => k.size?.y || 0);
  return Math.min(...hs) > 4 && Math.max(...hs) / Math.min(...hs) < 1.3;
}

// a logo is a node named so, an outlined wordmark, or a small group holding a wordmark (with its mark)
function isLogo(doc, n, frameWidth) {
  if (/logo|лого|wordmark/i.test(n.name || '')) return true;
  const kv = kidsOf(doc, n).filter((k) => k.visible !== false);
  if (kv.length <= 4 && (n.size?.x || 0) < frameWidth * 0.8 && kv.some((k) => looksLikeWordmark(doc, k))) return true;
  return looksLikeWordmark(doc, n);
}

export function sceneOf(doc, frameIdOrNode, { source } = {}) {
  const frame = typeof frameIdOrNode === 'string' ? doc.nodeMap.get(frameIdOrNode) : frameIdOrNode;
  if (!frame) throw new Error(`no node ${frameIdOrNode}`);
  const W = frame.size.x, H = frame.size.y;
  const nodes = [];
  const walk = (parent, M, clip, depth, alpha, inLogo) => {
    let maskClip = null;
    for (const k of kidsOf(doc, parent)) {
      if (k.visible === false || (k.opacity ?? 1) === 0) continue;
      const KM = mul(M, k.transform || IDENTITY);
      const box = boxOf(KM, k.size?.x || 0, k.size?.y || 0);
      if (k.mask) {
        maskClip = intersect(box, clip);
        continue;
      }
      const c = maskClip ? intersect(clip, maskClip) : clip;
      const visible = intersect(box, c);
      if (!visible) continue;
      const fills = paints(k.fillPaints);
      const fx = effects(k);
      const a = alpha * (k.opacity ?? 1);
      const blur = fx.find((e) => (e.type === 'FOREGROUND_BLUR' || e.type === 'LAYER_BLUR') && e.radius >= 40);
      const glassy = fx.some((e) => e.type === 'INNER_SHADOW' || e.type === 'BACKGROUND_BLUR') && box.w >= 40 && box.h >= 40;
      const logo = !inLogo && isLogo(doc, k, W);
      const image = fills.find((p) => p.type === 'image');
      const kids = kidsOf(doc, k);
      let role;
      if (inLogo) role = 'logo-part';
      else if (logo) role = 'logo';
      else if (k.type === 'TEXT') role = 'text';
      else if (image) role = 'image';
      else if (blur) role = 'blob';
      else if (glassy && k.type !== 'TEXT') role = 'glass';
      else if (kids.length) role = 'container';
      else role = 'shape';
      const node = {
        id: nodeId(k), parent: nodeId(parent) === nodeId(frame) ? null : nodeId(parent), depth, type: k.type, role, name: k.name || '',
        box, visible, opacity: k.opacity ?? 1, alpha: r1(a * 100) / 100,
        fills, strokes: paints(k.strokePaints), effects: fx,
      };
      const blend = k.blendMode && !['PASS_THROUGH', 'NORMAL'].includes(k.blendMode) ? k.blendMode : null;
      if (blend) node.blend = blend;
      const radius = radiusOf(k);
      if (radius !== undefined) node.radius = radius;
      if (k.type === 'TEXT') node.text = textOf(k, box);
      if (image) node.image = { hash: image.hash, mode: image.mode };
      nodes.push(node);
      const clips = k.type === 'FRAME' && k.frameMaskDisabled !== true;
      walk(k, KM, clips ? intersect(box, c) || c : c, depth + 1, a, inLogo || logo);
    }
  };
  walk(frame, IDENTITY, { x: 0, y: 0, w: W, h: H }, 0, 1, false);
  return { id: nodeId(frame), name: frame.name || '', width: r1(W), height: r1(H), fills: paints(frame.fillPaints), nodes, ...(source ? { source } : {}) };
}

// Creative frames of a page (or of the whole file): the outermost frames of a creative size,
// including those nested in sections and container frames.
export function listCreatives(doc, { page, sizes = CREATIVE_SIZES } = {}) {
  const pages = doc.nodes.filter((n) => n.type === 'CANVAS' && n.name !== 'Internal Only Canvas' && (!page || n.name === page));
  const out = [];
  for (const pg of pages) {
    const walk = (n, trail) => {
      for (const k of kidsOf(doc, n)) {
        if (k.visible === false) continue;
        const size = `${Math.round(k.size?.x || 0)}x${Math.round(k.size?.y || 0)}`;
        if ((k.type === 'FRAME' || k.type === 'INSTANCE' || k.type === 'COMPONENT') && sizes.includes(size)) {
          out.push({ id: nodeId(k), name: k.name || '', page: pg.name, size, container: trail.join(' / ') || null });
        } else if (k.type === 'FRAME' || k.type === 'SECTION' || k.type === 'GROUP') {
          walk(k, [...trail, k.name || k.type]);
        }
      }
    };
    walk(pg, []);
  }
  return out;
}
