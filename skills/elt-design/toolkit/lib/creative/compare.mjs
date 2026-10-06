// Level 3, Reconstruction: how close is a creative we rebuilt from content alone to the one the
// designers made? Blocks are matched by role and overlap (IoU), then typography of the title,
// palette (CIEDE2000) and structure are compared. Scores are 0..1 where 1 is the designers' own frame.
import { deltaE2000, hexToLab } from './color.mjs';
import { features } from './model.mjs';
import { intersect } from './scene.mjs';

const ROLES = ['text', 'image', 'glass', 'logo', 'blob'];
export const WEIGHTS = { layout: 0.7, title: 0.2, palette: 0.1 };
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
const area = (b) => (b ? b.w * b.h : 0);
const box = (n) => n.visible || n.box;

export function iou(a, b) {
  const i = area(intersect(a, b));
  return i ? i / (area(a) + area(b) - i) : 0;
}

// greedy one-to-one matching, best overlaps first
function match(ours, theirs) {
  const pairs = [];
  for (const o of ours) for (const t of theirs) {
    const v = iou(box(o), box(t));
    if (v > 0) pairs.push([v, o, t]);
  }
  pairs.sort((a, b) => b[0] - a[0]);
  const used = new Set();
  const out = [];
  for (const [v, o, t] of pairs) {
    if (used.has(o) || used.has(t)) continue;
    used.add(o);
    used.add(t);
    out.push({ ours: o, theirs: t, iou: v });
  }
  return out;
}

// area-weighted F1 of matched overlap: recall over their blocks, precision over ours
function layout(ours, theirs) {
  const byRole = {};
  let recallNum = 0, recallDen = 0, precNum = 0, precDen = 0;
  for (const role of ROLES) {
    const o = ours.nodes.filter((n) => n.role === role);
    const t = theirs.nodes.filter((n) => n.role === role);
    if (!o.length && !t.length) continue;
    const m = match(o, t);
    const got = new Map(m.flatMap((x) => [[x.ours, x.iou], [x.theirs, x.iou]]));
    for (const n of t) { recallNum += area(box(n)) * (got.get(n) || 0); recallDen += area(box(n)); }
    for (const n of o) { precNum += area(box(n)) * (got.get(n) || 0); precDen += area(box(n)); }
    byRole[role] = { ours: o.length, theirs: t.length, matched: m.length, meanIou: r3(m.length ? m.reduce((s, x) => s + x.iou, 0) / Math.max(o.length, t.length) : 0) };
  }
  const recall = recallDen ? recallNum / recallDen : 1;
  const precision = precDen ? precNum / precDen : 1;
  return { f1: r3(recall + precision ? (2 * recall * precision) / (recall + precision) : 0), recall: r3(recall), precision: r3(precision), byRole };
}

// symmetric mean of each colour's distance to the nearest colour of the other creative, weighted by use
function paletteDistance(a, b) {
  const la = [...a].map(([hex, c]) => [hexToLab(hex), c]);
  const lb = [...b].map(([hex, c]) => [hexToLab(hex), c]);
  if (!la.length || !lb.length) return null;
  const one = (x, y) => {
    let s = 0, w = 0;
    for (const [lab, c] of x) { s += c * Math.min(...y.map(([l]) => deltaE2000(lab, l))); w += c; }
    return s / w;
  };
  return (one(la, lb) + one(lb, la)) / 2;
}

function title(fo, ft) {
  const o = fo.title, t = ft.title;
  if (!o || !t) return null;
  const lead = (n) => (n.text.lineHeightPx ? n.text.lineHeightPx / n.text.size : null);
  return {
    sameFont: o.text.family === t.text.family && o.text.style === t.text.style,
    sizeRatio: r3(o.text.size / t.text.size),
    trackingDelta: r3(o.text.trackingPct - t.text.trackingPct),
    leadingDelta: lead(o) != null && lead(t) != null ? r3(lead(o) - lead(t)) : null,
    lines: [o.text.lines.length, t.text.lines.length],
    boxIou: r3(iou(box(o), box(t))),
  };
}

export function compareScenes(ours, theirs) {
  const fo = features(ours), ft = features(theirs);
  const lay = layout(ours, theirs);
  const pal = paletteDistance(fo.colors, ft.colors);
  const ti = title(fo, ft);
  const counts = {};
  for (const k of ['textCount', 'images', 'glass', 'blobs']) counts[k] = [fo[k], ft[k]];
  // one number for journals and plateaus. Layout carries it: on the test corpus layout F1 alone
  // separates same- from different-archetype pairs (AUC 0.79) while palette does not (0.52), since a
  // client's frames share one palette; off-palette colour is the lint's job.
  const palScore = pal == null ? 0 : Math.max(0, 1 - pal / 20);
  const titleScore = ti ? (ti.sameFont ? 0.4 : 0) + 0.3 * Math.max(0, 1 - Math.abs(1 - ti.sizeRatio) * 4) + 0.3 * ti.boxIou : 0;
  return {
    score: r3(WEIGHTS.layout * lay.f1 + WEIGHTS.title * titleScore + WEIGHTS.palette * palScore),
    parts: { layout: lay.f1, title: r3(titleScore), palette: r3(palScore) },
    layout: lay,
    palette: { deltaE: r3(pal) },
    title: ti,
    counts,
    archetype: ours.archetype || theirs.archetype ? { ours: ours.archetype || null, theirs: theirs.archetype || null, match: !!ours.archetype && ours.archetype === theirs.archetype } : null,
  };
}
