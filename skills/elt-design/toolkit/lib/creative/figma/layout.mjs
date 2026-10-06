// Geometry of a composed story (sp figma compose): where each element cloned from the client's frames goes.
// Pure: bridge.mjs asks `plan` for the widths the plugin sets before it measures, the plugin builds and
// measures the elements (plugin.js composeBuild), `place` turns those sizes into positions, and the plugin
// applies them (composePlace). Every number is a rule measured on the client's corpus, not a taste call.

// Measured on 98 current-style stories of a medical-centre test set (ticket 43, its layout-rules file and the style model):
// p50 unless noted. A client's own measurements replace them through the spec's "rules".
export const DEFAULT_RULES = {
  frame: { w: 1080, h: 1920 },
  contentW: 820, // text block width, p50 (p25 725, p75 875)
  logo: { top: 142, gap: 85 }, // logo top (logoTop p50), logo to the first block (logoToFirst p25)
  zone: { top: 238, bottom: 1732 }, // where the corpus sets text
  gap: { titleText: 50, textText: 50, textCard: 69, cardCard: 43, pill: 31 }, // cardCard p25, pill = cardCard p10
  pad: { x: 45, top: 28, bottom: 31 }, // text inside a card
  stagger: 48, // sideways offset of staggered pills
  title: { maxLines: 3, step: 0.92, steps: 2 }, // a longer title steps down 8 % at most twice
};

const TYPES = ['text', 'card', 'pills', 'image', 'sticker', 'layer', 'space'];
const p = (v, k = 'p50') => (v && typeof v === 'object' ? v[k] : v);

// Rules from a measured layout-rules file (percentiles, the ticket 43 format) and/or plain overrides in the
// shape of DEFAULT_RULES; anything missing keeps the default.
export function rulesOf(src = {}) {
  const r = structuredClone(DEFAULT_RULES);
  if (src.contentW != null) r.contentW = p(src.contentW);
  if (src.gapTitleText) r.gap.titleText = p(src.gapTitleText);
  if (src.gapTextText) r.gap.textText = p(src.gapTextText);
  if (src.gapTextCard) r.gap.textCard = p(src.gapTextCard);
  if (src.gapCardCard) Object.assign(r.gap, { cardCard: p(src.gapCardCard, 'p25'), pill: p(src.gapCardCard, 'p10') });
  if (src.padX) r.pad.x = p(src.padX);
  if (src.padTop) r.pad.top = p(src.padTop);
  if (src.padBottom) r.pad.bottom = p(src.padBottom);
  if (src.logoToFirst) r.logo.gap = p(src.logoToFirst, 'p25');
  for (const k of ['frame', 'logo', 'zone', 'gap', 'pad', 'title']) if (src[k] && typeof src[k] === 'object') Object.assign(r[k], src[k]);
  if (typeof src.stagger === 'number') r.stagger = src.stagger;
  return r;
}

// padding: a number, { x, top, bottom } (the rules' shape) or { l, r, t, b }
export function padOf(v, fallback) {
  if (v == null) return fallback == null ? null : padOf(fallback);
  if (typeof v === 'number') return { l: v, r: v, t: v, b: v };
  if ('l' in v || 'r' in v || 't' in v || 'b' in v) return { l: v.l ?? 0, r: v.r ?? 0, t: v.t ?? 0, b: v.b ?? 0 };
  return { l: v.x ?? 0, r: v.x ?? 0, t: v.top ?? 0, b: v.bottom ?? 0 };
}

// What makes a spec unusable, before anything is built: a list of messages.
export function specErrors(spec) {
  const errs = [];
  if (!spec || typeof spec !== 'object') return ['the spec must be an object'];
  if (!spec.name) errs.push('the spec needs "name": re-running a spec replaces the frame of that name');
  if (!Array.isArray(spec.blocks) || !spec.blocks.length) errs.push('the spec needs "blocks": a non-empty array');
  const ref = (v) => typeof v === 'string' || (v && typeof v === 'object' && v.from);
  for (const [i, b] of (Array.isArray(spec.blocks) ? spec.blocks : []).entries()) {
    const at = `blocks[${i}]`;
    if (!TYPES.includes(b?.type)) { errs.push(`${at}.type must be one of ${TYPES.join(', ')}`); continue; }
    if (['text', 'card', 'pills'].includes(b.type) && !ref(b.style)) errs.push(`${at} needs "style": the text node to clone, { "from": "<frame>", "key": "<slot key>" }`);
    if (['card', 'pills'].includes(b.type) && !ref(b.shape)) errs.push(`${at} needs "shape": the card or pill to clone, { "from": "<frame>", "key": "<slot key>" }`);
    if (['text', 'card'].includes(b.type) && !(typeof b.text === 'string' || Array.isArray(b.text))) errs.push(`${at} needs "text": a string, or an array with one string per run of the style`);
    if (b.type === 'pills' && !(Array.isArray(b.items) && b.items.length)) errs.push(`${at} needs "items": the pills' texts`);
    if (['image', 'sticker', 'layer'].includes(b.type) && !b.from) errs.push(`${at} needs "from": a node id, or a frame with "key"`);
    if (b.type === 'space' && !(b.h > 0)) errs.push(`${at} needs "h": the height kept free`);
    if (b.type === 'image' && b.bleed && !['top', 'bottom'].includes(b.bleed)) errs.push(`${at}.bleed must be "top" or "bottom"`);
  }
  if (spec.background && !spec.background.from) errs.push('background needs "from": the frame whose fills and layers make the background');
  if (spec.logo && !ref(spec.logo)) errs.push('logo needs "from" and "key"');
  return errs;
}

// Widths the plugin sets before it measures: text blocks at the content width, card texts inside the
// card's padding, pills capped at the content width, images at the content width (or the frame's, bled).
export function plan(spec, rules = DEFAULT_RULES) {
  const W = rules.frame.w, H = rules.frame.h;
  const contentW = spec.width ?? rules.contentW;
  const blocks = spec.blocks.map((b, i) => {
    // a centred text is set in balanced lines unless "balance": false
    if (b.type === 'text') return { i, type: b.type, textW: b.w ?? contentW, balance: b.balance ?? (b.align || spec.align || 'center') === 'center' };
    if (b.type === 'card') {
      const w = b.w ?? contentW, pad = padOf(b.pad, rules.pad);
      return { i, type: b.type, w, pad, textW: w - pad.l - pad.r };
    }
    // pills without "pad" take the padding the designers gave the style text on that shape (the plugin
    // measures it), else the card rule
    if (b.type === 'pills') return { i, type: b.type, maxW: b.w ?? contentW, pad: padOf(b.pad), fallbackPad: padOf(rules.pad) };
    if (b.type === 'image') return { i, type: b.type, w: b.bleed ? W : b.w ?? contentW };
    return { i, type: b.type };
  });
  const { maxLines, step, steps } = rules.title;
  return { W, H, contentW, margin: (W - contentW) / 2, maxLines, scales: Array.from({ length: steps }, (_, k) => Math.round(step ** (k + 1) * 10000) / 10000), blocks };
}

const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const rnd = (v) => Math.round(v);

// The gap above block b after block a: the corpus's gap for that pair of kinds.
export function gapBetween(a, b, gap) {
  if (a === 'card' && b === 'card') return gap.cardCard;
  if (a === 'media' || b === 'media' || a === 'card' || b === 'card') return gap.textCard;
  if (a === 'title' || b === 'title') return gap.titleText;
  return gap.textText;
}

// measured (plugin.js composeBuild): { logo: { id, w, h } | null, blocks: [per block, in spec order] }
//   text  { id, w, h, size, lines, probes: [{ scale, h, lines }] }   probes only past maxLines
//   card  { shape, text, textW, textH, lines }
//   pills { pad, items: [{ shape, text, textW, textH }] }
//   image | sticker { id, w, h }, layer { id, x, y, w, h }, space {}
// -> { placements: [{ id, x, y, w?, h?, scale?, rotation? }], boxes, zone, stack, fit, warnings }
export function place(spec, pl, measured, rules = DEFAULT_RULES) {
  const { W, H, margin } = pl;
  const warnings = [], placements = [], boxes = [], fit = [];
  const align = spec.align || 'center';
  const xOf = (w, a = align) => (a === 'left' ? margin : a === 'right' ? W - margin - w : (W - w) / 2);
  const zone = { top: rules.zone.top, bottom: rules.zone.bottom };
  const logo = measured.logo;
  if (logo) {
    const x = spec.logo?.x ?? (W - logo.w) / 2, y = spec.logo?.y ?? rules.logo.top;
    placements.push({ id: logo.id, x: rnd(x), y: rnd(y) });
    boxes.push({ block: 'logo', x: rnd(x), y: rnd(y), w: logo.w, h: logo.h });
    zone.top = Math.max(zone.top, rnd(y + logo.h + rules.logo.gap));
  }
  const specBlocks = spec.blocks, mb = measured.blocks;
  // the title: the text block set largest (the first of equals)
  const texts = specBlocks.map((b, i) => i).filter((i) => specBlocks[i].type === 'text');
  const title = texts.length ? texts.reduce((a, i) => (mb[i].size > mb[a].size ? i : a)) : null;

  // each block's box (w, h) and how to emit its placements once its top-left corner is known
  const items = specBlocks.map((b, i) => {
    const m = mb[i], pb = pl.blocks[i];
    const pinned = b.y != null;
    if (b.type === 'text') {
      let w = m.w, h = m.h, scale;
      if (i === title && m.lines > pl.maxLines) {
        const ok = (m.probes || []).find((q) => q.lines <= pl.maxLines);
        const pick = ok || (m.probes || []).at(-1);
        if (pick) ({ h, scale, w = m.w } = pick);
        fit.push({ block: i, lines: m.lines, size: m.size, scale: scale ?? 1, linesAfter: pick?.lines ?? m.lines });
        if (!ok) warnings.push(`block ${i}: the title runs ${pick?.lines ?? m.lines} lines even ${Math.round((1 - (scale ?? 1)) * 100)} % smaller; shorten it (the corpus sets titles in ${pl.maxLines} lines or fewer)`);
      }
      return { i, kind: i === title ? 'title' : 'text', pinned, w, h, text: true, emit: (x, y) => [{ id: m.id, x, y, ...(scale ? { scale, w } : {}) }] };
    }
    if (b.type === 'card') {
      const { w, pad } = pb, h = rnd(pad.t + m.textH + pad.b);
      // the text box spans the card's inner width, so its alignment decides where the lines sit
      return { i, kind: 'card', pinned, w, h, text: true, emit: (x, y) => [{ id: m.shape, x, y, w, h }, { id: m.text, x: rnd(x + pad.l), y: rnd(y + pad.t) }] };
    }
    if (b.type === 'pills') {
      const pad = m.pad, gap = b.gap ?? rules.gap.pill;
      const sizes = m.items.map((it) => ({ ...it, w: rnd(Math.min(it.textW + pad.l + pad.r, pb.maxW)), h: rnd(it.textH + pad.t + pad.b) }));
      const off = b.stagger === true ? rules.stagger : typeof b.stagger === 'number' ? b.stagger : 0;
      const rel = []; // pill positions inside the block box
      let w, h;
      if (b.flow === 'row') {
        // greedy rows no wider than the content, each row centred
        const rows = [];
        for (const s of sizes) {
          const row = rows.at(-1);
          if (row && row.w + gap + s.w <= pb.maxW) { row.items.push(s); row.w += gap + s.w; row.h = Math.max(row.h, s.h); } else rows.push({ items: [s], w: s.w, h: s.h });
        }
        w = Math.max(...rows.map((r) => r.w));
        let y = 0;
        for (const r of rows) {
          let x = (w - r.w) / 2;
          for (const s of r.items) { rel.push({ s, x, y: y + (r.h - s.h) / 2 }); x += s.w + gap; }
          y += r.h + gap;
        }
        h = y - gap;
      } else {
        // a column; staggered pills alternate left and right of the axis, the first to the left
        w = Math.min(pb.maxW, Math.max(...sizes.map((s) => s.w)) + 2 * off);
        let y = 0;
        for (const [k, s] of sizes.entries()) {
          rel.push({ s, x: (w - s.w) / 2 + (off ? (k % 2 ? off : -off) : 0), y });
          y += s.h + gap;
        }
        h = y - gap;
      }
      // tilted pills turn alternately, like the designers' (each shape and its label about their centres)
      const turn = (k) => (b.tilt ? { rotation: k % 2 ? -b.tilt : b.tilt } : {});
      return {
        i, kind: 'card', pinned, w: rnd(w), h: rnd(h), text: true,
        emit: (x, y) => rel.flatMap(({ s, x: dx, y: dy }, k) => {
          const px = rnd(x + dx), py = rnd(y + dy);
          return [{ id: s.shape, x: px, y: py, w: s.w, h: s.h, ...turn(k) }, { id: s.text, x: rnd(px + (s.w - s.textW) / 2), y: rnd(py + pad.t), ...turn(k) }];
        }),
      };
    }
    if (b.type === 'image') {
      const w = pb.w, h = rnd(b.h ?? (m.h * w) / m.w);
      if (b.bleed) {
        const y = b.bleed === 'top' ? 0 : H - h, cut = rules.gap.textCard - (b.overlap ?? 0);
        if (b.bleed === 'top') zone.top = Math.max(zone.top, h + cut);
        else zone.bottom = Math.min(zone.bottom, H - h - cut);
        return { i, kind: 'media', pinned: true, fixed: { x: 0, y }, w, h, emit: (x, yy) => [{ id: m.id, x, y: yy, w, h }] };
      }
      return { i, kind: 'media', pinned, w, h, emit: (x, y) => [{ id: m.id, x, y, w, h }] };
    }
    if (b.type === 'sticker') return { i, kind: 'media', pinned, decor: true, w: m.w, h: m.h, emit: (x, y) => [{ id: m.id, x, y, ...(b.rotation ? { rotation: b.rotation } : {}) }] };
    if (b.type === 'layer') return { i, kind: 'media', pinned: true, decor: true, fixed: { x: b.x ?? m.x, y: b.y ?? m.y }, w: m.w, h: m.h, emit: (x, y) => [{ id: m.id, x, y, ...(b.rotation ? { rotation: b.rotation } : {}) }] };
    return { i, kind: 'media', pinned, w: pl.contentW, h: b.h, label: b.label, emit: () => [] }; // space
  });

  // the stack: every block not pinned, top to bottom with the corpus's gaps
  const stack = items.filter((it) => !it.pinned);
  const gaps = stack.map((it, k) => (k === 0 ? 0 : specBlocks[it.i].gap ?? gapBetween(stack[k - 1].kind, it.kind, rules.gap)));
  const total = stack.reduce((s, it, k) => s + it.h + gaps[k], 0);
  const room = zone.bottom - zone.top;
  const valign = spec.valign || 'center';
  let y = valign === 'top' ? zone.top : valign === 'bottom' ? zone.bottom - total : zone.top + (room - total) / 2;
  if (total > room) {
    warnings.push(`the blocks need ${rnd(total - room)} px more than the zone ${zone.top}..${zone.bottom}; shorten the texts or drop a block`);
    y = zone.top;
  }
  const at = new Map();
  for (const [k, it] of stack.entries()) {
    y += gaps[k];
    at.set(it, { x: rnd(specBlocks[it.i].x ?? xOf(it.w, ['image', 'sticker'].includes(specBlocks[it.i].type) ? specBlocks[it.i].align : undefined)), y: rnd(y) });
    y += it.h;
  }
  for (const it of items.filter((x) => x.pinned)) {
    const b = specBlocks[it.i];
    at.set(it, it.fixed ? { x: rnd(it.fixed.x), y: rnd(it.fixed.y) } : { x: rnd(b.x ?? xOf(it.w, b.align)), y: rnd(b.y) });
  }
  for (const it of items) {
    const { x, y: top } = at.get(it);
    placements.push(...it.emit(x, top));
    boxes.push({ block: it.i, kind: it.kind, x, y: top, w: rnd(it.w), h: rnd(it.h), ...(it.label ? { label: it.label } : {}) });
  }
  // decoration is never set over live text
  for (const d of items.filter((it) => it.decor && specBlocks[it.i].type === 'sticker')) {
    const db = boxes.find((b) => b.block === d.i);
    for (const t of items.filter((it) => it.text)) {
      const tb = boxes.find((b) => b.block === t.i);
      if (overlap(db, tb) > 0) warnings.push(`block ${d.i} (sticker) covers block ${t.i}'s text; move it to a free zone`);
    }
  }
  return { placements, boxes, zone, stack: { top: stack.length ? at.get(stack[0]).y : null, bottom: rnd(y), h: rnd(total) }, fit, warnings };
}
