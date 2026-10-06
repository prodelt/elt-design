// Structural similarity (Wang, Bovik, Sheikh, Simoncelli 2004) on luma: an 11-tap Gaussian window
// (sigma 1.5), K1 0.01, K2 0.03, L 255, averaged over the "valid" region like the reference MATLAB code.
// 1 means identical; a person usually stops seeing differences above ~0.98.

function gaussian(size = 11, sigma = 1.5) {
  const k = new Float64Array(size);
  const mid = (size - 1) / 2;
  let sum = 0;
  for (let i = 0; i < size; i++) sum += k[i] = Math.exp(-((i - mid) ** 2) / (2 * sigma * sigma));
  for (let i = 0; i < size; i++) k[i] /= sum;
  return k;
}

// separable 'valid' filter: (w - s + 1) x (h - s + 1)
function filter(src, w, h, k) {
  const s = k.length, ow = w - s + 1, oh = h - s + 1;
  const tmp = new Float64Array(ow * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < ow; x++) {
      let acc = 0;
      for (let i = 0; i < s; i++) acc += src[row + x + i] * k[i];
      tmp[y * ow + x] = acc;
    }
  }
  const out = new Float64Array(ow * oh);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let acc = 0;
      for (let i = 0; i < s; i++) acc += tmp[(y + i) * ow + x] * k[i];
      out[y * ow + x] = acc;
    }
  }
  return { data: out, width: ow, height: oh };
}

// -> { mean, map: Float64Array, width, height } (the map is per 'valid' pixel)
export function ssim(a, b, width, height) {
  const k = gaussian();
  const n = width * height;
  const aa = new Float64Array(n), bb = new Float64Array(n), ab = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    aa[i] = a[i] * a[i];
    bb[i] = b[i] * b[i];
    ab[i] = a[i] * b[i];
  }
  const mA = filter(a, width, height, k), mB = filter(b, width, height, k);
  const sAA = filter(aa, width, height, k).data, sBB = filter(bb, width, height, k).data, sAB = filter(ab, width, height, k).data;
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  const map = new Float64Array(mA.data.length);
  let sum = 0;
  for (let i = 0; i < map.length; i++) {
    const ma = mA.data[i], mb = mB.data[i];
    const va = sAA[i] - ma * ma, vb = sBB[i] - mb * mb, cov = sAB[i] - ma * mb;
    sum += map[i] = ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
  }
  return { mean: sum / map.length, map, width: mA.width, height: mA.height };
}
