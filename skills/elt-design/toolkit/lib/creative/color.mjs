// Colour math for the creative stand: hex colours, sRGB -> CIELAB (D65) -> LCh, and CIEDE2000,
// the colour difference where ~1 is the smallest step a person notices side by side.

// '#RRGGBB', '#RRGGBBAA' -> { rgb: [r, g, b] (0-255), a (0-1) }
export function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(hex).trim());
  if (!m) throw new Error(`not a hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
}

const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0').toUpperCase();

// Figma colour { r, g, b, a } in 0-1, times an extra opacity -> '#RRGGBBAA'
export function figColorHex(c, opacity = 1) {
  return '#' + hex2(c.r * 255) + hex2(c.g * 255) + hex2(c.b * 255) + hex2((c.a ?? 1) * opacity * 255);
}

const linear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);

export function srgbToLab([r, g, b]) {
  const R = linear(r), G = linear(g), B = linear(b);
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export const hexToLab = (hex) => srgbToLab(parseHex(hex).rgb);

const finv = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
const gamma = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
// CIELAB (D65) -> '#RRGGBB', clipped to the sRGB gamut
export function labToHex([L, a, b]) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const X = finv(fx) * 0.95047, Y = finv(fy), Z = finv(fz) * 1.08883;
  const R = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const G = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  const B = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  return '#' + [R, G, B].map((c) => hex2(gamma(Math.max(0, Math.min(1, c))))).join('');
}

// [L, C, h in degrees]
export function labToLch([L, a, b]) {
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return [L, Math.hypot(a, b), h < 0 ? h + 360 : h];
}

// WCAG relative luminance and contrast ratio of two sRGB colours
export function luminance([r, g, b]) {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}
export function contrast(rgb1, rgb2) {
  const [hi, lo] = [luminance(rgb1), luminance(rgb2)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const rad = (d) => (d * Math.PI) / 180;

// CIEDE2000 (Sharma, Wu, Dalal 2005), kL = kC = kH = 1
export function deltaE2000([L1, a1, b1], [L2, a2, b2]) {
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cb7 = ((C1 + C2) / 2) ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hue = (b, a) => (b === 0 && a === 0 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360);
  const h1p = hue(b1, a1p), h2p = hue(b2, a2p);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
    else hbp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const T = 1 - 0.17 * Math.cos(rad(hbp - 30)) + 0.24 * Math.cos(rad(2 * hbp)) + 0.32 * Math.cos(rad(3 * hbp + 6)) - 0.2 * Math.cos(rad(4 * hbp - 63));
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Cbp7 = Cbp ** 7;
  const Rc = 2 * Math.sqrt(Cbp7 / (Cbp7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

export const deltaEHex = (h1, h2) => deltaE2000(hexToLab(h1), hexToLab(h2));
