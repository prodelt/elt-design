// Level 1, Reproduction: does our render of a creative match the client's own export pixel for pixel?
// SSIM (structure), pixelmatch (share of changed pixels, anti-aliasing ignored) and CIEDE2000 (colour).
import pixelmatch from 'pixelmatch';
import { deltaE2000, srgbToLab } from './color.mjs';
import { loadRGBA, luma, writeRGBA } from './image.mjs';
import { ssim } from './ssim.mjs';

const JND = 2.3; // CIEDE2000 just-noticeable difference

function colourStats(a, b, n, step = 2) {
  const values = [];
  const cache = new Map();
  const lab = (r, g, bl) => {
    const key = (r << 16) | (g << 8) | bl;
    let v = cache.get(key);
    if (!v) cache.set(key, (v = srgbToLab([r, g, bl])));
    return v;
  };
  for (let i = 0; i < n; i += step) {
    const p = i * 4;
    values.push(deltaE2000(lab(a[p], a[p + 1], a[p + 2]), lab(b[p], b[p + 1], b[p + 2])));
  }
  values.sort((x, y) => x - y);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return {
    mean: round(mean, 3),
    p95: round(values[Math.floor(values.length * 0.95)], 3),
    overJnd: round(values.filter((v) => v > JND).length / values.length, 4),
  };
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

// ours is compared at the size of theirs; `ssimScale` < 1 computes SSIM on a smaller copy (viewing distance)
export async function reproduction(oursFile, theirsFile, { heatmap, ssimScale = 0.5 } = {}) {
  const theirs = await loadRGBA(theirsFile);
  const { width, height } = theirs;
  const ours = await loadRGBA(oursFile, { width, height });
  const n = width * height;
  const diff = heatmap ? Buffer.alloc(n * 4) : null;
  const changed = pixelmatch(ours.data, theirs.data, diff, width, height, { threshold: 0.1, includeAA: false });
  if (heatmap) await writeRGBA(heatmap, diff, width, height);
  let s;
  if (ssimScale < 1) {
    const w = Math.max(16, Math.round(width * ssimScale)), h = Math.max(16, Math.round(height * ssimScale));
    const [a, b] = await Promise.all([loadRGBA(oursFile, { width: w, height: h }), loadRGBA(theirsFile, { width: w, height: h })]);
    s = ssim(luma(a.data, w, h), luma(b.data, w, h), w, h).mean;
  } else {
    s = ssim(luma(ours.data, width, height), luma(theirs.data, width, height), width, height).mean;
  }
  return {
    size: { width, height },
    sizeMismatch: ours.original.width !== width || ours.original.height !== height ? ours.original : null,
    ssim: round(s, 5),
    changed: round(changed / n, 5),
    deltaE: colourStats(ours.data, theirs.data, n),
  };
}
