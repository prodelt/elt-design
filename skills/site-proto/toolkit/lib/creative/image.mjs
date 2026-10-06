// Pixels for the creative stand: PNG/JPEG in and out through sharp, flattened on white, as RGBA.
import sharp from 'sharp';

// -> { data: Buffer RGBA, width, height, original: { width, height } }
export async function loadRGBA(file, { width, height } = {}) {
  const meta = await sharp(file).metadata();
  let img = sharp(file).flatten({ background: '#ffffff' }).ensureAlpha();
  if (width && height && (width !== meta.width || height !== meta.height)) img = img.resize(width, height, { fit: 'fill' });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, original: { width: meta.width, height: meta.height } };
}

export async function writeRGBA(file, data, width, height) {
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(file);
}

// Rec. 601 luma, 0-255
export function luma(rgba, width, height) {
  const out = new Float64Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  return out;
}

// median RGB of a rectangle, skipping pixels close to `skip` (e.g. the text colour itself)
export function regionMedian(rgba, width, height, box, skip, near = 40) {
  const x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.ceil(box.x + box.w)), y1 = Math.min(height, Math.ceil(box.y + box.h));
  const ch = [[], [], []];
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 4000)));
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const p = (y * width + x) * 4;
      if (skip && Math.abs(rgba[p] - skip[0]) + Math.abs(rgba[p + 1] - skip[1]) + Math.abs(rgba[p + 2] - skip[2]) < near) continue;
      ch[0].push(rgba[p]); ch[1].push(rgba[p + 1]); ch[2].push(rgba[p + 2]);
    }
  }
  if (!ch[0].length) return null;
  return ch.map((v) => v.sort((a, b) => a - b)[v.length >> 1]);
}
