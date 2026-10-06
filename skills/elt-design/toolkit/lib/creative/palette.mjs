// A campaign palette applied to a real frame. The transition table maps the client's colour tokens; the
// designers also use near shades of each token (a lighter blue in an overlay, a darker one in a pill), which
// an exact-match recolour leaves blue and the lint then flags. Each shade within the lint's token radius of
// a mapped token moves with it and keeps its offset in CIELAB, so the designers' shading survives.
import { deltaE2000, hexToLab, labToHex } from './color.mjs';
import { COLOR_RADIUS } from './lint.mjs';

const norm = (hex) => hex.slice(0, 7).toUpperCase();
// pure white and black are tokens of their own (text, glass), never a shade of a mapped colour
const NEUTRAL = new Set(['#FFFFFF', '#000000']);

// map: { '#client': '#campaign' }; colors: the frame's colours ('#RRGGBB'). -> { map, added }
export function expandMap(map, colors, radius = COLOR_RADIUS) {
  const out = Object.fromEntries(Object.entries(map).map(([a, b]) => [norm(a), norm(b)]));
  const sources = Object.keys(out).map((hex) => ({ hex, lab: hexToLab(hex) }));
  const added = [];
  for (const color of new Set(colors.map(norm))) {
    if (out[color] || NEUTRAL.has(color)) continue;
    const lab = hexToLab(color);
    let best = null;
    for (const s of sources) {
      const d = deltaE2000(lab, s.lab);
      if (d <= radius && (!best || d < best.d)) best = { ...s, d };
    }
    if (!best) continue;
    const t = hexToLab(out[best.hex]);
    const to = labToHex(t.map((v, i) => v + lab[i] - best.lab[i]));
    out[color] = to;
    added.push({ from: color, via: best.hex, to, dE: Math.round(best.d * 100) / 100 });
  }
  return { map: out, added };
}
