// Plugin API helpers for figma-console-mcp `figma_execute`: runs in Figma's plugin sandbox, not in Node.
// Verified in Figma Desktop 126.9.10 on a Starter account (ticket 15): clone, setRuns / setText, swapImage,
// recolor, exportPng, scene (matches the .fig scene graph node for node), slots and make; composeBuild and
// composePlace on story 1.2 of the test set (ticket 39).
// bridge.mjs serves this file from the sidecar and evals it once per plugin session; sp.version tells a
// stale copy from the current one. Results that outgrow an MCP text answer (PNG, scene JSON) are POSTed to
// the sidecar.
globalThis.sp = (() => {
  const SIDECAR = 'http://localhost:9232';
  // Style fields that split a text node into runs (insert/delete keeps every other per-character property too).
  const SEG_FIELDS = ['fontName', 'fontSize', 'fills', 'textDecoration', 'textCase', 'letterSpacing', 'lineHeight',
    'textStyleId', 'fillStyleId', 'hyperlink'];

  // A node, or its id (make passes the nodes it already holds).
  async function node(ref) {
    if (typeof ref !== 'string') return ref;
    const n = await figma.getNodeByIdAsync(ref);
    if (!n) throw new Error(`node ${ref} not found`);
    return n;
  }
  async function textNode(id) {
    const t = await node(id);
    if (t.type !== 'TEXT') throw new Error(`node ${t.id} is ${t.type}, not TEXT`);
    const fonts = t.characters.length
      ? t.getRangeAllFontNames(0, t.characters.length)
      : (t.fontName === figma.mixed ? [] : [t.fontName]);
    await loadFonts(fonts);
    return t;
  }
  // each font once per plugin session: in Figma 126.9.10 repeated loadFontAsync calls for fonts already
  // loaded took 10 s and then hung past the 30 s call limit on the fourth pill of an A04 make (ticket 15)
  const loaded = new Set();
  async function loadFonts(fonts) {
    for (const f of fonts) {
      const k = `${f.family}|${f.style}`;
      if (loaded.has(k)) continue;
      await figma.loadFontAsync(f);
      loaded.add(k);
    }
  }
  const runsOf = (t) => t.getStyledTextSegments(SEG_FIELDS).map((s) => ({ start: s.start, end: s.end, text: s.characters }));

  // Text runs of a node: [{start, end, text}] — read before calling setRuns.
  async function runs(id) { return runsOf(await textNode(id)); }

  // Replace text run by run: parts[i] replaces run i and keeps run i's styling (font, size, gradient fill, spacing…).
  // Never assigns `characters` (that resets range styles, per the Plugin API docs).
  async function setRuns(id, parts) {
    const t = await textNode(id);
    const segs = runsOf(t);
    if (!Array.isArray(parts) || parts.length !== segs.length) {
      throw new Error(`node has ${segs.length} runs ${JSON.stringify(segs.map((s) => s.text))}, got ${parts?.length} parts`);
    }
    for (let i = segs.length - 1; i >= 0; i--) {
      const { start, end, text } = segs[i];
      if (parts[i] === text) continue;
      if (parts[i].length) t.insertCharacters(end, parts[i], 'BEFORE'); // style copied from the run's last character
      t.deleteCharacters(start, end);
    }
    return runsOf(t).map((s) => s.text);
  }

  // Replace the whole text with the style of its first character (for single-style nodes).
  async function setText(id, text) {
    const t = await textNode(id);
    const len = t.characters.length;
    if (!len) { t.characters = text; return text; }
    t.insertCharacters(0, text, 'AFTER');
    t.deleteCharacters(text.length, text.length + len);
    return t.characters;
  }

  // Swap the image of an IMAGE paint and keep the paint's scaleMode, imageTransform (crop), rotation,
  // scalingFactor, filters, opacity and blend mode. `src`: 'hash:<imageHash>' (image already in the file),
  // an http(s) URL on an allowed domain, or a path relative to the sidecar --in dir.
  async function swapImage(id, src, { index, mode } = {}) {
    const n = await node(id);
    if (!('fills' in n) || n.fills === figma.mixed) throw new Error(`node ${id} has no plain fills`);
    let hash;
    if (src.startsWith('hash:')) {
      hash = src.slice(5);
      if (!figma.getImageByHash(hash)) throw new Error(`no image ${hash} in this file`);
    } else {
      const url = /^https?:/.test(src) ? src : `${SIDECAR}/in/${src.split('/').map(encodeURIComponent).join('/')}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
      hash = figma.createImage(new Uint8Array(await r.arrayBuffer())).hash; // PNG/JPEG/GIF, max 4096 px per side
    }
    const k = index ?? n.fills.findIndex((p) => p.type === 'IMAGE');
    if (k < 0 || n.fills[k]?.type !== 'IMAGE') throw new Error(`node ${id} has no IMAGE fill at ${k}`);
    const old = n.fills[k];
    // mode 'FILL' drops the old photo's crop (a crop fitted to another picture) and centres the new one
    const paint = mode === 'FILL' ? (({ imageTransform, scalingFactor, ...rest }) => ({ ...rest, scaleMode: 'FILL' }))(old) : old;
    n.fills = n.fills.map((p, i) => (i === k ? { ...paint, imageHash: hash } : p));
    const size = await figma.getImageByHash(hash).getSizeAsync();
    return { id: n.id, index: k, oldHash: old.imageHash, hash, scaleMode: n.fills[k].scaleMode, size };
  }

  // Recolor a subtree: map {'#1EA6DF': '#EA73AA', …}. Touches SOLID paints, gradient stops, shadow colors and
  // per-run text fills. Paints bound to variables/styles are changed in place only where the color is literal.
  const hexToRgb = (h) => {
    const m = h.replace('#', '');
    return { r: parseInt(m.slice(0, 2), 16) / 255, g: parseInt(m.slice(2, 4), 16) / 255, b: parseInt(m.slice(4, 6), 16) / 255 };
  };
  async function recolor(rootId, map, { tol = 1.5 / 255 } = {}) {
    const pairs = Object.entries(map).map(([a, b]) => [hexToRgb(a), hexToRgb(b)]);
    const near = (c, a) => Math.abs(c.r - a.r) <= tol && Math.abs(c.g - a.g) <= tol && Math.abs(c.b - a.b) <= tol;
    const to = (c) => { const hit = pairs.find(([a]) => near(c, a)); return hit ? hit[1] : null; };
    let count = 0;
    const paints = (list) => {
      let changed = false;
      const out = list.map((p) => {
        if (p.type === 'SOLID') {
          const c = to(p.color);
          if (c) { changed = true; return { ...p, color: c }; }
        } else if (p.type.startsWith('GRADIENT_')) {
          let hit = false;
          const stops = p.gradientStops.map((s) => {
            const c = to(s.color);
            if (!c) return s;
            hit = true;
            return { ...s, color: { ...c, a: s.color.a } };
          });
          if (hit) { changed = true; return { ...p, gradientStops: stops }; }
        }
        return p;
      });
      if (changed) count++;
      return changed ? out : null;
    };
    const root = await node(rootId);
    const all = [root, ...('findAll' in root ? root.findAll() : [])];
    for (const n of all) {
      if ('fills' in n && n.fills !== figma.mixed) { const f = paints(n.fills); if (f) n.fills = f; }
      if ('strokes' in n) { const s = paints(n.strokes); if (s) n.strokes = s; }
      if ('effects' in n && n.effects.some((e) => e.color)) {
        let hit = false;
        const fx = n.effects.map((e) => {
          const c = e.color && to(e.color);
          if (!c) return e;
          hit = true;
          return { ...e, color: { ...c, a: e.color.a } };
        });
        if (hit) { n.effects = fx; count++; }
      }
      if (n.type === 'TEXT' && n.fills === figma.mixed) {
        const t = await textNode(n);
        for (const seg of t.getStyledTextSegments(['fills'])) {
          const f = paints(seg.fills);
          if (f) t.setRangeFills(seg.start, seg.end, f);
        }
      }
    }
    return { changed: count, scanned: all.length };
  }

  // Duplicate a node (top-level story frame) and place it; clone() parents to the current page by default.
  async function clone(id, { dx = 0, dy = 0, x, y, name, parentId } = {}) {
    const n = await node(id);
    const c = n.clone();
    if (parentId) (await node(parentId)).appendChild(c);
    c.x = x ?? n.x + dx;
    c.y = y ?? n.y + dy;
    if (name) c.name = name;
    return { id: c.id, name: c.name, x: c.x, y: c.y, w: c.width, h: c.height };
  }

  async function post(name, bytes) {
    const r = await fetch(`${SIDECAR}/out/${name.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
    });
    if (!r.ok) throw new Error(`sidecar ${r.status}: ${await r.text()}`);
    return r.json();
  }

  // Figma-rendered PNG/JPG at exact size (scale 1 of a 1080×1920 frame = 1080×1920) -> sidecar --out/<name>.
  async function exportPng(id, name, { scale = 1, format = 'PNG' } = {}) {
    const n = await node(id);
    const t0 = Date.now();
    const bytes = await n.exportAsync({ format, constraint: { type: 'SCALE', value: scale } });
    const saved = await post(name, bytes);
    return { ...saved, w: Math.round(n.width * scale), h: Math.round(n.height * scale), ms: Date.now() - t0 };
  }

  // Figma Motion video export of the enclosing top-level frame. Runs in the background because encoding can
  // outlast figma_execute's 30 s cap; poll sp.jobs[name] (or watch the sidecar log / the file on disk).
  const jobs = {};
  async function exportVideo(id, name, { format = 'MP4', fps, quality = 'HIGH', constraint } = {}) {
    const n = await node(id);
    const top = n.parent?.type === 'PAGE' ? n : n.getTopLevelFrame();
    if (!top) throw new Error(`node ${id} is not inside a top-level frame`);
    const settings = { format, ...(fps ? { fps } : {}), ...(format === 'GIF' ? {} : { quality }), ...(constraint ? { constraint } : {}) };
    jobs[name] = { running: true, frame: top.id, started: Date.now() };
    (async () => {
      try {
        const bytes = await top.exportAsync(settings);
        jobs[name] = { ok: true, ...(await post(name, bytes)), ms: Date.now() - jobs[name].started };
      } catch (e) {
        jobs[name] = { ok: false, error: String(e) };
      }
    })();
    return { started: name, frame: top.id, settings };
  }

  // Minimal Motion keyframes (Plugin API Motion is beta): fade in (and optionally rise by dy px) between t0 and t1 s.
  async function fadeIn(id, t0, t1, { dy = 0 } = {}) {
    const n = await node(id);
    n.applyManualKeyframeTrack({ type: 'PROPERTY', name: 'OPACITY' }, {
      keyframes: [{ timelinePosition: t0, value: { type: 'FLOAT', value: 0 } }, { timelinePosition: t1, value: { type: 'FLOAT', value: 1 } }],
    });
    if (dy) {
      n.applyManualKeyframeTrack({ type: 'PROPERTY', name: 'TRANSLATION_Y' }, {
        keyframes: [{ timelinePosition: t0, value: { type: 'FLOAT', value: dy } }, { timelinePosition: t1, value: { type: 'FLOAT', value: 0 } }],
      });
    }
    return { id, timelines: n.timelines };
  }
  async function setDuration(frameId, seconds) {
    const f = await node(frameId);
    const [tl] = f.timelines;
    if (!tl) throw new Error('frame has no Motion timeline yet (add keyframes first)');
    f.setTimelineDuration(tl.id, seconds);
    return { id: frameId, timeline: tl.id, seconds };
  }

  // ---- scene graph from the live file, in the shape of toolkit/lib/creative/scene.mjs, so `sp creative lint`
  // and `compare` check a story built in Figma exactly like one read from a .fig. Figma re-lays text after
  // an edit, so overflow here is measured: a clone of the text node grows to its natural height.
  const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0').toUpperCase();
  const hex8 = (c, op = 1) => '#' + hex2(c.r) + hex2(c.g) + hex2(c.b) + hex2((c.a ?? 1) * op);
  const r1 = (v) => Math.round(v * 10) / 10;
  const EFFECT = { LAYER_BLUR: 'FOREGROUND_BLUR' }; // the .fig's name for the same effect
  function scenePaint(p) {
    if (!p || p.visible === false) return null;
    const op = p.opacity ?? 1;
    if (op === 0) return null;
    if (p.type === 'SOLID') return { type: 'solid', color: hex8(p.color, op) };
    if (p.type.startsWith('GRADIENT_')) return { type: p.type.slice(9).toLowerCase(), stops: p.gradientStops.map((s) => ({ color: hex8(s.color, op), pos: r1(s.position * 100) / 100 })) };
    if (p.type === 'IMAGE') return { type: 'image', hash: p.imageHash, mode: p.scaleMode };
    return null;
  }
  const scenePaints = (list) => (list && list !== figma.mixed ? list.map(scenePaint).filter(Boolean) : []);
  const sceneEffects = (n) => ('effects' in n ? n.effects : [])
    .filter((e) => e.visible !== false)
    .map((e) => ({ type: EFFECT[e.type] || e.type, radius: r1(e.radius || 0), ...(e.type.includes('SHADOW') ? { x: r1(e.offset.x), y: r1(e.offset.y), spread: r1(e.spread || 0), color: hex8(e.color) } : {}) }));
  const intersect = (a, b) => {
    if (!a || !b) return null;
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
  };
  const kidsOf = (n) => ('children' in n ? n.children : []);
  const looksLikeWordmark = (n) => {
    const kv = kidsOf(n).filter((k) => k.visible);
    if (kv.length < 7 || !kv.every((k) => k.type === 'VECTOR')) return false;
    const hs = kv.map((k) => k.height);
    return Math.min(...hs) > 4 && Math.max(...hs) / Math.min(...hs) < 1.3;
  };
  const isLogo = (n, W) => /logo|лого|wordmark/i.test(n.name || '') ||
    (kidsOf(n).filter((k) => k.visible).length <= 4 && n.width < W * 0.8 && kidsOf(n).some(looksLikeWordmark)) || looksLikeWordmark(n);

  async function sceneText(n, box) {
    const segs = n.getStyledTextSegments(['fontName', 'fontSize', 'letterSpacing', 'lineHeight', 'fills']);
    const base = segs.reduce((a, s) => (s.end - s.start > a.end - a.start ? s : a), segs[0]);
    const size = base.fontSize;
    const lh = base.lineHeight;
    const lineHeightPx = lh.unit === 'PIXELS' ? lh.value : lh.unit === 'PERCENT' ? (lh.value / 100) * size : null;
    const ls = base.letterSpacing;
    const trackingPct = ls.unit === 'PERCENT' ? ls.value : size ? (ls.value / size) * 100 : 0;
    // natural height at the same width: a throw-away clone that grows with its text
    await loadFonts(segs.map((s) => s.fontName));
    const probe = n.clone();
    probe.textAutoResize = 'HEIGHT';
    const natural = probe.height;
    probe.remove();
    const perLine = lineHeightPx || size * 1.2;
    // trailing line breaks (designers' texts end in \r\n) add empty lines to the height, not glyphs
    const trailing = (n.characters.match(/[\r\n\u2028]+\s*$/)?.[0].match(/\r\n|\n|\r|\u2028/g) || []).length;
    const lines = Math.max(1, Math.round(natural / perLine) - trailing);
    const chars = n.characters;
    const per = Math.ceil(chars.replace(/\n/g, '').length / lines);
    return {
      chars,
      family: base.fontName.family,
      style: base.fontName.style,
      size: r1(size),
      lineHeightPx: lineHeightPx == null ? null : r1(lineHeightPx),
      trackingPct: r1(trackingPct * 10) / 10,
      align: n.textAlignHorizontal,
      // the Plugin API has no line layout: line count from the natural height, lines of even length
      lines: Array.from({ length: lines }, (_, i) => ({ text: chars.replace(/\n/g, ' ').slice(i * per, (i + 1) * per).trim(), width: 0 })),
      approxLines: true,
      overflow: n.textAutoResize === 'NONE' && lines > 1 && natural > box.h + Math.max(2, size * 0.15),
      runs: segs.length > 1 ? segs.map((s) => ({ text: s.characters, family: s.fontName.family, style: s.fontName.style, size: s.fontSize, color: s.fills[0]?.type === 'SOLID' ? hex8(s.fills[0].color, s.fills[0].opacity ?? 1) : undefined })) : [],
    };
  }

  async function scene(frameId) {
    const frame = await node(frameId);
    const W = frame.width, H = frame.height;
    const fx = frame.absoluteTransform[0][2], fy = frame.absoluteTransform[1][2];
    const nodes = [];
    const walk = async (parent, clip, depth, alpha, inLogo) => {
      let maskClip = null;
      for (const k of kidsOf(parent)) {
        if (!k.visible || k.opacity === 0) continue;
        const bb = k.absoluteBoundingBox || { x: k.absoluteTransform[0][2], y: k.absoluteTransform[1][2], width: k.width, height: k.height };
        const box = { x: r1(bb.x - fx), y: r1(bb.y - fy), w: r1(bb.width), h: r1(bb.height) };
        if (k.isMask) { maskClip = intersect(box, clip); continue; }
        const c = maskClip ? intersect(clip, maskClip) : clip;
        const visible = intersect(box, c);
        if (!visible) continue;
        const fills = scenePaints('fills' in k ? k.fills : []);
        const effects = sceneEffects(k);
        const a = alpha * (k.opacity ?? 1);
        const blur = effects.find((e) => e.type === 'FOREGROUND_BLUR' && e.radius >= 40);
        const glassy = effects.some((e) => e.type === 'INNER_SHADOW' || e.type === 'BACKGROUND_BLUR') && box.w >= 40 && box.h >= 40;
        const logo = !inLogo && isLogo(k, W);
        const image = fills.find((p) => p.type === 'image');
        const role = inLogo ? 'logo-part' : logo ? 'logo' : k.type === 'TEXT' ? 'text' : image ? 'image' : blur ? 'blob' : glassy ? 'glass' : kidsOf(k).length ? 'container' : 'shape';
        const out = {
          id: k.id, parent: parent.id === frame.id ? null : parent.id, depth, type: k.type, role, name: k.name || '',
          box, visible, opacity: k.opacity ?? 1, alpha: r1(a * 100) / 100, fills, strokes: scenePaints('strokes' in k ? k.strokes : []), effects,
        };
        if ('blendMode' in k && !['PASS_THROUGH', 'NORMAL'].includes(k.blendMode)) out.blend = k.blendMode;
        if ('cornerRadius' in k) {
          const rad = k.cornerRadius === figma.mixed ? Math.max(k.topLeftRadius, k.topRightRadius, k.bottomRightRadius, k.bottomLeftRadius) : k.cornerRadius;
          if (rad) out.radius = r1(rad);
        }
        if (k.type === 'TEXT') out.text = await sceneText(k, box);
        if (image) out.image = { hash: image.hash, mode: image.mode };
        nodes.push(out);
        const clips = k.type === 'FRAME' && k.clipsContent;
        await walk(k, clips ? intersect(box, c) || c : c, depth + 1, a, inLogo || logo);
      }
    };
    await walk(frame, { x: 0, y: 0, w: W, h: H }, 0, 1, false);
    return { id: frame.id, name: frame.name, width: r1(W), height: r1(H), fills: scenePaints(frame.fills), nodes, source: { figma: figma.fileKey || null, frame: frame.id } };
  }

  // scene -> sidecar --out/<name> as JSON (scenes of busy frames outgrow an MCP text answer)
  async function saveScene(frameId, name) {
    const s = await scene(frameId);
    const saved = await post(name, JSON.stringify(s)); // the sandbox fetch takes a string body
    return { ...saved, nodes: s.nodes.length };
  }

  // ---- generation from a reference frame. Nodes are addressed by slot key = child index path inside the
  // story frame ("3.0.2"): ids change when a frame is copied or pasted, the child order does not, so a key
  // read from the reference finds the same node in every clone.
  const keyOf = (frame, n) => {
    const p = [];
    for (let k = n; k && k !== frame; k = k.parent) p.unshift(k.parent.children.indexOf(k));
    return p.join('.');
  };
  const byKey = (frame, key) => String(key).split('.').reduce((n, i) => {
    const c = 'children' in n ? n.children[Number(i)] : null;
    if (!c) throw new Error(`no slot ${key} in "${frame.name}"`);
    return c;
  }, frame);
  const hex6 = (c) => '#' + hex2(c.r) + hex2(c.g) + hex2(c.b);

  // Pages one by one: figma.loadAllPagesAsync() hung past the 30 s call limit in Figma 126.9.10 once the
  // file had a page created by a plugin, while page.loadAsync() stays instant (ticket 15).
  async function loadPages() {
    for (const p of figma.root.children) await p.loadAsync();
  }

  // A top-level frame by id, or by exact name (must be unique across the file).
  async function frameOf(ref) {
    if (/^\d+:\d+$/.test(ref)) return node(ref);
    await loadPages();
    const hits = figma.root.children.flatMap((p) => p.children.filter((c) => c.name === ref));
    if (hits.length !== 1) throw new Error(`${hits.length} top-level frames named "${ref}"`);
    return hits[0];
  }

  // What can be edited in a reference story: texts (with runs and fonts), image fills, named layers and the
  // colours in use (hex -> count) for planning a recolor.
  async function slots(ref) {
    const f = await frameOf(ref);
    const fx = f.absoluteTransform[0][2], fy = f.absoluteTransform[1][2];
    const boxOf = (k) => {
      const bb = k.absoluteBoundingBox || { x: k.absoluteTransform[0][2], y: k.absoluteTransform[1][2], width: k.width, height: k.height };
      return { x: r1(bb.x - fx), y: r1(bb.y - fy), w: r1(bb.width), h: r1(bb.height) };
    };
    const out = { id: f.id, name: f.name, w: f.width, h: f.height, texts: [], images: [], layers: [], colors: {} };
    const count = (c) => { const h = hex6(c); out.colors[h] = (out.colors[h] || 0) + 1; };
    const walk = (parent, depth) => {
      for (const k of kidsOf(parent)) {
        if (!k.visible) continue;
        const key = keyOf(f, k);
        for (const p of [...('fills' in k && k.fills !== figma.mixed ? k.fills : []), ...('strokes' in k ? k.strokes : [])]) {
          if (p.visible === false) continue;
          if (p.type === 'SOLID') count(p.color);
          else if (p.type.startsWith('GRADIENT_')) p.gradientStops.forEach((s) => count(s.color));
        }
        if ('effects' in k) k.effects.forEach((e) => e.visible !== false && e.color && count(e.color));
        if (k.type === 'TEXT') {
          const segs = k.getStyledTextSegments(['fontName', 'fontSize', 'fills']);
          segs.forEach((s) => s.fills.forEach((p) => p.type === 'SOLID' ? count(p.color) : p.gradientStops?.forEach((g) => count(g.color))));
          out.texts.push({
            key, id: k.id, name: k.name, chars: k.characters,
            runs: segs.length > 1 ? segs.map((s) => s.characters) : undefined,
            font: `${segs[0].fontName.family} ${segs[0].fontName.style}`, size: r1(segs[0].fontSize),
            box: boxOf(k), autoResize: k.textAutoResize, align: k.textAlignHorizontal,
          });
        }
        const img = 'fills' in k && k.fills !== figma.mixed && k.fills.find((p) => p.type === 'IMAGE' && p.visible !== false);
        if (img) out.images.push({ key, id: k.id, name: k.name, box: boxOf(k), hash: img.imageHash, mode: img.scaleMode });
        if (depth <= 2 && k.type !== 'TEXT') out.layers.push({ key, id: k.id, name: k.name, type: k.type, box: boxOf(k) });
        walk(k, depth + 1);
      }
    };
    walk(f, 1);
    out.colors = Object.fromEntries(Object.entries(out.colors).sort((a, b) => b[1] - a[1]));
    return out;
  }

  // Page that holds generated stories (created once), so the client's frames are never edited in place.
  async function workPage(name) {
    await loadPages();
    return figma.root.children.find((p) => p.name === name) || Object.assign(figma.createPage(), { name });
  }

  // Natural height of a text node at its width vs its box: > 0 means the text needs more room than the box.
  async function textFit(t) {
    const probe = t.clone();
    probe.textAutoResize = 'HEIGHT';
    const natural = probe.height;
    probe.remove();
    return { natural: r1(natural), box: r1(t.height), grow: r1(natural - t.height) };
  }

  // The shape a text sits on, sized to it by the designers (a marker plate, a pill): a sibling below the
  // text in paint order, painted (a fill of >= 50 % opacity, no layer blur: not a glow), that holds >= 80 %
  // of the text box and is at most 6x its area (not a background).
  const SHAPES = ['BOOLEAN_OPERATION', 'VECTOR', 'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'FRAME', 'GROUP'];
  function backingOf(n) {
    const p = n.parent;
    const tb = n.absoluteBoundingBox;
    if (!p || !tb) return null;
    const area = tb.width * tb.height;
    for (let j = p.children.indexOf(n) - 1; j >= 0; j--) {
      const k = p.children[j];
      const solid = 'fills' in k && k.fills !== figma.mixed && k.fills.some((p) => p.visible !== false && (p.opacity ?? 1) >= 0.5);
      const blurred = 'effects' in k && k.effects.some((e) => e.visible !== false && e.type === 'LAYER_BLUR');
      const sb = k.visible && SHAPES.includes(k.type) && (solid || k.type === 'GROUP' || k.type === 'FRAME') && !blurred ? k.absoluteBoundingBox : null;
      if (!sb) continue;
      const ix = Math.min(tb.x + tb.width, sb.x + sb.width) - Math.max(tb.x, sb.x);
      const iy = Math.min(tb.y + tb.height, sb.y + sb.height) - Math.max(tb.y, sb.y);
      if (ix > 0 && iy > 0 && ix * iy >= 0.8 * area && sb.width * sb.height <= 6 * area) return k;
    }
    return null;
  }

  // PNG renders (alpha kept) of nodes to <job>/<i>.png with their absolute render bounds, for coverage.mjs
  async function renders(ids, job, scale = 0.5) {
    const out = [];
    for (const [i, id] of ids.entries()) {
      const n = await node(id);
      const b = n.absoluteRenderBounds || n.absoluteBoundingBox;
      await post(`${job}/${i}.png`, await n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } }));
      out.push({ id, x: b.x, y: b.y, w: b.width, h: b.height });
    }
    return { scale, renders: out };
  }

  // Build a new story from a reference frame. spec:
  //   { from: <frame id | unique name>, name, page = 'site-proto', x, y,
  //     texts:   { <key>: 'text' | ['run 0', 'run 1', …] },        // an array keeps each run's style
  //     images:  { <key>: 'photos/a.jpg' | 'hash:<h>' | 'https://…' | { src, mode: 'FILL' } },
  //     recolor: { '#1EA6DF': '#EF5CA1', … },                      // token table; alpha of each paint is kept
  //     recolorAt: { <key>: { '#EF5CA1': '#FEF3F8' } },            // after recolor, on one subtree ('' = frame)
  //     hide: [<key>], show: [<key>],
  //     insert:  [{ from: <node id>, x, y, w, rotation, above: <key> }],  // e.g. a campaign sticker
  //     out: 'dir/name' }                                          // -> <out>.png + <out>.scene.json via sidecar
  async function make(spec) {
    const t = Date.now(), ms = {};
    const lap = (k) => { ms[k] = Date.now() - (ms._ ?? t); ms._ = Date.now(); };
    // steps of the last make, readable after a call that timed out: return sp.trace
    const trace = (api.trace = []);
    const step = (what) => trace.push(`${Date.now() - t} ${what}`);
    const src = await frameOf(spec.from);
    const page = await workPage(spec.page || 'site-proto');
    const c = src.clone();
    page.appendChild(c);
    c.name = spec.name || `${src.name} · sp`;
    // re-running a spec replaces its own earlier result (same name on the work page) in place
    const old = page.children.filter((n) => n !== c && n.name === c.name);
    const right = page.children.filter((n) => n !== c && !old.includes(n)).reduce((m, n) => Math.max(m, n.x + n.width), -100);
    c.x = spec.x ?? old[0]?.x ?? right + 100;
    c.y = spec.y ?? old[0]?.y ?? 0;
    old.forEach((n) => n.remove());
    lap('clone');
    const warnings = [], texts = [], backed = [];
    // resolve every key before editing: inserts and hides must not shift the index paths of later keys
    const at = (key) => (key === '' ? c : byKey(c, key));
    const targets = {
      texts: Object.entries(spec.texts || {}).map(([k, v]) => [k, at(k), v]),
      images: Object.entries(spec.images || {}).map(([k, v]) => [k, at(k), v]),
      hide: (spec.hide || []).map((k) => at(k)),
      show: (spec.show || []).map((k) => at(k)),
      above: (spec.insert || []).map((s) => (s.above != null ? at(s.above) : null)),
      recolorAt: Object.entries(spec.recolorAt || {}).map(([k, m]) => [at(k), m]),
    };
    for (const [key, n, v] of targets.texts) {
      if (n.type !== 'TEXT') throw new Error(`slot ${key} is ${n.type}, not TEXT`);
      step(`text ${key}`);
      const nRuns = runsOf(await textNode(n)).length;
      step(`text ${key} runs ${nRuns}`);
      const before = Math.max((await textFit(n)).natural, n.height); // the room the designers gave this slot
      const back = backingOf(n); // found before the edit, on the reference geometry
      if (back) backed.push({ key, text: n.id, shape: back.id, refText: byKey(src, key).id, refShape: byKey(src, keyOf(c, back)).id });
      step(`text ${key} before ${before}`);
      const bb0 = n.absoluteBoundingBox;
      const fx0 = c.absoluteTransform[0][2];
      // an auto-width text grows from its left edge; keep the axis the designer set: the frame's centre line
      // (a centred title, whatever its alignment), the text's own centre, or its right edge
      const anchor = n.textAutoResize !== 'WIDTH_AND_HEIGHT' ? null
        : Math.abs(bb0.x - fx0 + bb0.width / 2 - c.width / 2) <= 12 || n.textAlignHorizontal === 'CENTER' ? 'center'
          : n.textAlignHorizontal === 'RIGHT' ? 'right' : null;
      if (Array.isArray(v)) await setRuns(n, v);
      else {
        if (nRuns > 1) warnings.push(`${key}: ${nRuns} runs replaced by one string, styles after the first run are lost`);
        await setText(n, v);
      }
      // Figma 126.9.10: after insertCharacters a variable font (Exo, wght axis) can stop rendering the node
      // (absoluteRenderBounds null, blank in the PNG) until the font is set again (ticket 39, story 2.1)
      if (n.visible && n.characters.trim() && !n.absoluteRenderBounds) {
        for (const g of n.getStyledTextSegments(['fontName'])) n.setRangeFontName(g.start, g.end, g.fontName);
        if (!n.absoluteRenderBounds) warnings.push(`${key}: Figma does not render this text (a missing glyph or font)`);
      }
      step(`text ${key} set, anchor ${anchor}`);
      if (anchor) {
        const bb1 = n.absoluteBoundingBox;
        const dx = anchor === 'center' ? bb0.x + bb0.width / 2 - (bb1.x + bb1.width / 2) : bb0.x + bb0.width - (bb1.x + bb1.width);
        if (Math.abs(dx) > 0.5) n.x += dx;
      }
      // a text the designers centred vertically in its card stays centred when its height changes
      if (back) {
        const cb = back.absoluteBoundingBox, bb1 = n.absoluteBoundingBox;
        if (Math.abs(bb0.y + bb0.height / 2 - (cb.y + cb.height / 2)) <= 10) {
          const dy = cb.y + cb.height / 2 - (bb1.y + bb1.height / 2);
          if (Math.abs(dy) > 0.5) n.y += dy;
        }
      }
      step(`text ${key} fit`);
      const fit = await textFit(n);
      const fill = Math.round((fit.natural / before) * 100) / 100;
      texts.push({ key, chars: n.characters, ...fit, before, fill });
      // a much shorter text leaves the hole the slot was sized for (a half-empty card): refill or re-pick
      if (fill < 0.8) warnings.push(`${key}: text fills ${Math.round(fill * 100)}% of the height the reference text took`);
      if (fit.grow > Math.max(2, (n.fontSize === figma.mixed ? 40 : n.fontSize) * 0.15) && n.textAutoResize === 'NONE') {
        warnings.push(`${key}: text needs ${fit.grow}px more than its box`);
      }
    }
    lap('texts');
    const images = [];
    for (const [key, n, v] of targets.images) {
      const { src: from, ...opts } = typeof v === 'string' ? { src: v } : v;
      images.push({ key, ...(await swapImage(n, from, opts)) });
    }
    lap('images');
    const recolored = spec.recolor ? await recolor(c, spec.recolor) : null;
    for (const [n, m] of targets.recolorAt) await recolor(n, m);
    lap('recolor');
    targets.hide.forEach((n) => (n.visible = false));
    targets.show.forEach((n) => (n.visible = true));
    const inserted = [];
    for (const [i, s] of (spec.insert || []).entries()) {
      const n = (await node(s.from)).clone();
      const above = targets.above[i];
      if (above) above.parent.insertChild(above.parent.children.indexOf(above) + 1, n);
      else c.appendChild(n);
      if (s.w) n.rescale(s.w / n.width);
      if (s.rotation) n.rotation = s.rotation;
      n.x = s.x ?? n.x;
      n.y = s.y ?? n.y;
      inserted.push({ from: s.from, id: n.id, key: keyOf(c, n), w: r1(n.width), h: r1(n.height) });
    }
    lap('edits');
    // export here only when asked: bridge.mjs exports in separate calls, each with its own 30 s budget
    let png = null, sceneFile = null;
    if (spec.out) {
      png = (await exportPng(c, `${spec.out}.png`)).path;
      lap('png');
      sceneFile = (await saveScene(c, `${spec.out}.scene.json`)).path;
      lap('scene');
    }
    delete ms._;
    return { id: c.id, name: c.name, page: page.name, from: src.id, replaced: old.length, png, scene: sceneFile, texts, backed, images, recolored, inserted, warnings, ms: { ...ms, total: Date.now() - t } };
  }

  // ---- composition (bridge.mjs compose): a new empty frame assembled from elements cloned out of the
  // client's frames. Phase 1 (composeBuild) clones and sizes the texts to the widths layout.mjs planned and
  // measures everything; phase 2 (composePlace) applies the positions layout.mjs computed from those sizes.

  // An element: a node id, a top-level frame's name, or { from: <frame name | node id>, key: <slot key> }
  async function refNode(ref) {
    const base = async (r) => (/^\d+:\d+$/.test(r) ? node(r) : frameOf(r));
    if (typeof ref === 'string') return base(ref);
    const b = await base(ref.from);
    return ref.key == null || ref.key === '' ? b : byKey(b, String(ref.key));
  }
  const topOf = (n) => { let t = n; while (t.parent && t.parent.type !== 'PAGE') t = t.parent; return t; };
  // the node's transform relative to its top-level frame (top-level frames are neither rotated nor scaled)
  const relTo = (n, top) => {
    const a = n.absoluteTransform, t = top.absoluteTransform;
    return [[a[0][0], a[0][1], a[0][2] - t[0][2]], [a[1][0], a[1][1], a[1][2] - t[1][2]]];
  };
  // the part of a shape that is sized: the shape itself, or the largest shape in a group (the group's own
  // effects, a drop shadow on the whole card, stay)
  const BODY = ['RECTANGLE', 'FRAME', 'ELLIPSE', 'BOOLEAN_OPERATION', 'VECTOR', 'POLYGON', 'STAR', 'COMPONENT', 'INSTANCE'];
  function bodyOf(n) {
    if (n.type !== 'GROUP') return n;
    let best = null;
    const walk = (p) => {
      for (const k of p.children) {
        if (!k.visible) continue;
        if (BODY.includes(k.type) && (!best || k.width * k.height > best.width * best.height)) best = k;
        if (k.type === 'GROUP') walk(k);
      }
    };
    walk(n);
    return best || n;
  }
  const ALIGN = { left: 'LEFT', center: 'CENTER', right: 'RIGHT' };
  // line metrics of a text: the size of its largest run, lines from the height and the main run's leading
  function metrics(t) {
    const segs = t.getStyledTextSegments(['fontSize', 'lineHeight']);
    const main = segs.reduce((a, s) => (s.end - s.start > a.end - a.start ? s : a), segs[0]);
    const lh = main.lineHeight;
    const line = lh.unit === 'PIXELS' ? lh.value : lh.unit === 'PERCENT' ? (lh.value / 100) * main.fontSize : main.fontSize * 1.2;
    return { w: r1(t.width), h: r1(t.height), size: r1(Math.max(...segs.map((s) => s.fontSize))), lines: Math.max(1, Math.round(t.height / line)) };
  }
  // Balanced lines (the designers break a centred title into lines of about equal length): the narrowest
  // width that keeps the text's height, searched down to half its width
  function balance(t) {
    const w0 = t.width, h0 = t.height;
    if (metrics(t).lines < 2) return;
    let lo = w0 / 2, hi = w0;
    while (hi - lo > 4) {
      const mid = (lo + hi) / 2;
      t.resize(mid, t.height);
      t.textAutoResize = 'HEIGHT';
      if (t.height > h0 + 0.5) lo = mid; else hi = mid;
    }
    t.resize(Math.ceil(hi), t.height);
    t.textAutoResize = 'HEIGHT';
  }
  // every run's size (and pixel leading and tracking) times s
  function scaleText(t, s) {
    for (const g of t.getStyledTextSegments(['fontSize', 'lineHeight', 'letterSpacing'])) {
      t.setRangeFontSize(g.start, g.end, Math.round(g.fontSize * s * 100) / 100);
      if (g.lineHeight.unit === 'PIXELS') t.setRangeLineHeight(g.start, g.end, { unit: 'PIXELS', value: g.lineHeight.value * s });
      if (g.letterSpacing.unit === 'PIXELS') t.setRangeLetterSpacing(g.start, g.end, { unit: 'PIXELS', value: g.letterSpacing.value * s });
    }
  }
  // One string takes the style of the node's longest run (the body, not a bold lead-in); an array replaces
  // run by run (setRuns).
  async function setContent(t, v) {
    if (Array.isArray(v)) return setRuns(t, v);
    const segs = runsOf(t);
    if (segs.length <= 1) return setText(t, v);
    const main = segs.reduce((a, s) => (s.end - s.start > a.end - a.start ? s : a));
    const len = t.characters.length;
    t.insertCharacters(main.end, v, 'BEFORE');
    t.deleteCharacters(main.end + v.length, len + v.length);
    t.deleteCharacters(0, main.end);
    return t.characters;
  }
  // a clone of a text style with new text, at a fixed width (lines wrap) or its own width (a pill label)
  async function textFrom(style, frame, value, { width, align, warnings, label }) {
    const src = await refNode(style);
    if (src.type !== 'TEXT') throw new Error(`${label}: the style ${JSON.stringify(style)} is ${src.type}, not TEXT`);
    const t = src.clone();
    frame.appendChild(t);
    t.rotation = 0;
    await textNode(t);
    await setContent(t, value);
    t.textAlignHorizontal = ALIGN[align] || 'CENTER';
    t.textAlignVertical = 'TOP';
    if (width) {
      t.resize(width, Math.max(1, t.height));
      t.textAutoResize = 'HEIGHT';
    } else t.textAutoResize = 'WIDTH_AND_HEIGHT';
    // the variable-font render bug of make (Figma 126.9.10, ticket 39)
    if (t.characters.trim() && !t.absoluteRenderBounds) {
      for (const g of t.getStyledTextSegments(['fontName'])) t.setRangeFontName(g.start, g.end, g.fontName);
      if (!t.absoluteRenderBounds) warnings.push(`${label}: Figma does not render this text (a missing glyph or font)`);
    }
    return t;
  }
  async function shapeFrom(ref, frame) {
    const c = (await refNode(ref)).clone();
    frame.appendChild(c);
    c.rotation = 0;
    // a card cloned with its text keeps only the shape: the text is a style clone of its own
    if ('findAll' in c) for (const t of c.findAll((k) => k.type === 'TEXT')) t.remove();
    // the layout sizes shapes along the frame's axes: a body the designers turned (frame "Кадр 2": a pill drawn
    // upright, turned 83° in a group turned 7°) is set straight, its sides then resized
    const body = bodyOf(c);
    if (body !== c && Math.abs(body.rotation) > 0.01) body.rotation = 0;
    return c;
  }
  const turnOf = (n) => { const a = n.absoluteTransform; return (Math.atan2(a[1][0], a[0][0]) * 180) / Math.PI; };
  // the padding the designers gave the style text on that shape in their frame (null when it is not on it)
  async function pairPad(shapeRef, styleRef) {
    const body = bodyOf(await refNode(shapeRef)), text = await refNode(styleRef);
    const sb = body.absoluteBoundingBox, tb = text.absoluteBoundingBox;
    if (!sb || !tb) return null;
    const ix = Math.min(tb.x + tb.width, sb.x + sb.width) - Math.max(tb.x, sb.x), iy = Math.min(tb.y + tb.height, sb.y + sb.height) - Math.max(tb.y, sb.y);
    if (ix <= 0 || iy <= 0 || ix * iy < 0.8 * tb.width * tb.height) return null;
    if (Math.abs(turnOf(body)) > 0.5 || Math.abs(turnOf(text)) > 0.5) {
      // turned: from the shapes' own sides, the body's swapped when it stands on end
      const onEnd = Math.abs(Math.round(turnOf(body) / 90)) % 2 === 1;
      const x = ((onEnd ? body.height : body.width) - text.width) / 2, y = ((onEnd ? body.width : body.height) - text.height) / 2;
      return x >= 0 && y >= 0 ? { l: r1(x), r: r1(x), t: r1(y), b: r1(y) } : null;
    }
    const l = tb.x - sb.x, r = sb.x + sb.width - (tb.x + tb.width), t = tb.y - sb.y, b = sb.y + sb.height - (tb.y + tb.height);
    if (Math.min(l, r, t, b) < 0) return null;
    return { l: r1((l + r) / 2), r: r1((l + r) / 2), t: r1(t), b: r1(b) };
  }

  // Phase 1. { spec, plan } (layout.mjs plan) -> the frame and what layout.mjs place needs to know
  async function composeBuild({ spec, plan }) {
    const t0 = Date.now();
    const trace = (api.trace = []);
    const step = (what) => trace.push(`${Date.now() - t0} ${what}`);
    const page = await workPage(spec.page || 'site-proto');
    const f = figma.createFrame();
    page.appendChild(f);
    f.name = spec.name;
    f.resize(plan.W, plan.H);
    f.clipsContent = true;
    f.fills = [];
    // re-running a spec replaces its own earlier frame (same name on the work page) in place
    const old = page.children.filter((n) => n !== f && n.name === f.name);
    const right = page.children.filter((n) => n !== f && !old.includes(n)).reduce((m, n) => Math.max(m, n.x + n.width), -100);
    f.x = spec.x ?? old[0]?.x ?? right + 100;
    f.y = spec.y ?? old[0]?.y ?? 0;
    old.forEach((n) => n.remove());
    const warnings = [];
    const out = { id: f.id, name: f.name, page: page.name, replaced: old.length, background: [], logo: null, blocks: [], warnings };
    // the background: that frame's fills, and its listed layers where they were
    if (spec.background) {
      const bg = await frameOf(spec.background.from);
      f.fills = bg.fills;
      for (const key of spec.background.keys || []) {
        const n = byKey(bg, String(key));
        const c = n.clone();
        f.appendChild(c);
        c.relativeTransform = relTo(n, bg);
        out.background.push(c.id);
      }
      step('background');
    }
    for (const [i, b] of spec.blocks.entries()) {
      const pb = plan.blocks[i], label = `block ${i}`;
      if (b.type === 'text') {
        const t = await textFrom(b.style, f, b.text, { width: pb.textW, align: b.align || spec.align, warnings, label });
        if (pb.balance) balance(t);
        const m = metrics(t);
        // smaller sizes measured on throw-away clones, for a title that runs past the corpus's lines
        const probes = [];
        if (m.lines > plan.maxLines) {
          for (const s of plan.scales) {
            const q = t.clone();
            q.resize(pb.textW, q.height);
            q.textAutoResize = 'HEIGHT';
            scaleText(q, s);
            if (pb.balance) balance(q);
            const qm = metrics(q);
            q.remove();
            probes.push({ scale: s, w: qm.w, h: qm.h, lines: qm.lines });
          }
        }
        out.blocks.push({ type: b.type, id: t.id, ids: [t.id], ...m, probes });
      } else if (b.type === 'card') {
        const shape = await shapeFrom(b.shape, f);
        const t = await textFrom(b.style, f, b.text, { width: pb.textW, align: b.align || 'left', warnings, label });
        const m = metrics(t);
        out.blocks.push({ type: b.type, shape: shape.id, text: t.id, ids: [shape.id, t.id], textW: m.w, textH: m.h, lines: m.lines, size: m.size });
      } else if (b.type === 'pills') {
        const pad = pb.pad || (await pairPad(b.shape, b.style)) || pb.fallbackPad;
        const items = [];
        for (const [k, text] of b.items.entries()) {
          const shape = await shapeFrom(b.shape, f);
          const t = await textFrom(b.style, f, text, { align: b.align || 'center', warnings, label: `${label} item ${k}` });
          const maxW = pb.maxW - pad.l - pad.r;
          if (t.width > maxW) {
            t.resize(maxW, t.height);
            t.textAutoResize = 'HEIGHT';
          }
          items.push({ shape: shape.id, text: t.id, textW: r1(t.width), textH: r1(t.height) });
        }
        out.blocks.push({ type: b.type, pad, padFrom: pb.pad ? 'spec' : pad === pb.fallbackPad ? 'rules' : 'source', items, ids: items.flatMap((it) => [it.shape, it.text]) });
      } else if (b.type === 'image' || b.type === 'sticker' || b.type === 'layer') {
        const src = await refNode({ from: b.from, key: b.key });
        const c = src.clone();
        f.appendChild(c);
        if (b.type === 'layer') c.relativeTransform = relTo(src, topOf(src));
        else c.rotation = 0;
        if (b.type === 'image' && b.src) await swapImage(c, b.src, { mode: 'FILL' });
        if (b.type === 'sticker' && b.w) c.rescale(b.w / c.width);
        const bb = c.absoluteBoundingBox;
        out.blocks.push({ type: b.type, id: c.id, ids: [c.id], w: r1(c.width), h: r1(c.height), ...(b.type === 'layer' ? { x: r1(bb.x - f.absoluteTransform[0][2]), y: r1(bb.y - f.absoluteTransform[1][2]) } : {}) });
      } else out.blocks.push({ type: b.type, ids: [] });
      step(`${label} ${b.type}`);
    }
    // the logo last: above photos and cards, like the designers'
    if (spec.logo) {
      const c = (await refNode(spec.logo)).clone();
      f.appendChild(c);
      c.rotation = 0;
      if (spec.logo.w) c.rescale(spec.logo.w / c.width);
      out.logo = { id: c.id, w: r1(c.width), h: r1(c.height) };
      step('logo');
    }
    out.ms = Date.now() - t0;
    return out;
  }

  // Phase 2. { id, placements: [{ id, x, y, w?, h?, scale?, rotation? }] }, frame coordinates; a shape's
  // x, y, w, h are those of its body (bodyOf)
  async function composePlace({ id, placements }) {
    const t0 = Date.now();
    const f = await node(id);
    const fx = f.absoluteTransform[0][2], fy = f.absoluteTransform[1][2];
    for (const p of placements) {
      const n = await node(p.id);
      if (p.scale && n.type === 'TEXT') { await textNode(n); scaleText(n, p.scale); }
      if (p.w && n.type === 'TEXT') {
        n.resize(p.w, n.height);
        n.textAutoResize = 'HEIGHT';
      }
      const body = bodyOf(n);
      if (p.w && p.h && n.type !== 'TEXT') {
        body.resize(Math.max(1, p.w), Math.max(1, p.h));
        // a photo resized keeps covering its box, centred, instead of stretching a crop made for another size
        if ('fills' in body && body.fills !== figma.mixed && body.fills.some((q) => q.type === 'IMAGE' && q.scaleMode !== 'FILL')) {
          body.fills = body.fills.map((q) => (q.type === 'IMAGE' ? (({ imageTransform, scalingFactor, ...rest }) => ({ ...rest, scaleMode: 'FILL' }))(q) : q));
        }
      }
      n.x += p.x - (body.absoluteTransform[0][2] - fx);
      n.y += p.y - (body.absoluteTransform[1][2] - fy);
      if (p.rotation) {
        // turned about its centre
        const b0 = n.absoluteBoundingBox;
        n.rotation = p.rotation;
        const b1 = n.absoluteBoundingBox;
        n.x += b0.x + b0.width / 2 - (b1.x + b1.width / 2);
        n.y += b0.y + b0.height / 2 - (b1.y + b1.height / 2);
      }
    }
    const texts = f.findAll((k) => k.type === 'TEXT' && k.characters.length).map((t) => ({ id: t.id, chars: t.characters.slice(0, 60), ...metrics(t) }));
    return { id: f.id, placed: placements.length, texts, ms: Date.now() - t0 };
  }

  const api = { SIDECAR, runs, setRuns, setText, swapImage, recolor, clone, exportPng, exportVideo, jobs, fadeIn, setDuration, scene, saveScene, frameOf, slots, make, renders, composeBuild, composePlace, trace: [] };
  return api;
})();
