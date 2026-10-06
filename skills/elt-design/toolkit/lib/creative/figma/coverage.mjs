// Text on a shape the designers sized to it (marker plates, pills): which share of the glyphs falls
// outside the shape. Both come as Figma renders with alpha, each placed by its absolute render bounds.
// Measuring the renders works for any alignment, rotation or mix of styles, which line maths does not.

const ON = 128; // alpha from which a pixel counts as painted

// glyphs, shape: { data: RGBA bytes, width, height, x, y } in one pixel space (x, y: top-left of the render).
// share: glyph pixels outside the shape / all glyph pixels.
// clearance: the smallest gap on any pixel row between the outermost glyphs and the shape's edge on that
// row (negative when glyphs run past it, minus the glyphs' width where the shape does not reach the row);
// null without glyphs. A plate that lost its padding reads here, not in the share: one line of four
// touching the edge is a handful of pixels.
export function uncovered(glyphs, shape) {
  let painted = 0, outside = 0, clearance = Infinity;
  const dx = Math.round(glyphs.x - shape.x), dy = Math.round(glyphs.y - shape.y);
  const covered = (sx, sy) => sx >= 0 && sy >= 0 && sx < shape.width && sy < shape.height && shape.data[(sy * shape.width + sx) * 4 + 3] >= ON;
  for (let y = 0; y < glyphs.height; y++) {
    let gL = Infinity, gR = -Infinity;
    for (let x = 0; x < glyphs.width; x++) {
      if (glyphs.data[(y * glyphs.width + x) * 4 + 3] < ON) continue;
      painted++;
      if (!covered(x + dx, y + dy)) outside++;
      gL = Math.min(gL, x + dx);
      gR = Math.max(gR, x + dx);
    }
    if (gL > gR) continue;
    const sy = y + dy;
    let sL = Infinity, sR = -Infinity;
    if (sy >= 0 && sy < shape.height) {
      for (let sx = 0; sx < shape.width; sx++) if (covered(sx, sy)) { sL = Math.min(sL, sx); sR = Math.max(sR, sx); }
    }
    clearance = Math.min(clearance, sL > sR ? -(gR - gL + 1) : Math.min(gL - sL, sR - gR));
  }
  return { share: painted ? outside / painted : 0, clearance: painted ? clearance : null };
}
