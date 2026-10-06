// The creative measurement stand: colour and SSIM maths against reference values, the scene graph on a
// synthetic .fig document, the style model and lint on a synthetic corpus, the reconstruction compare,
// the blind-test statistics, and the sp creative command line end to end.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { contrast, deltaE2000, hexToLab, labToHex, parseHex, srgbToLab } from '../lib/creative/color.mjs';
import { expandMap } from '../lib/creative/palette.mjs';
import { ssim } from '../lib/creative/ssim.mjs';
import { sceneOf } from '../lib/creative/scene.mjs';
import { buildModel, hueSpread } from '../lib/creative/model.mjs';
import { lint } from '../lib/creative/lint.mjs';
import { compareScenes } from '../lib/creative/compare.mjs';
import { hypergeomTail, scoreBlind, verdictOf } from '../lib/creative/blind.mjs';

const SP = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'sp.mjs');
let dir;
before(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-creative-'))));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function sp(args) {
  const r = spawnSync(process.execPath, [SP, 'creative', ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, json: JSON.parse(r.stdout.trim().split('\n').at(-1)) };
}

describe('colour', () => {
  test('CIEDE2000 matches Sharma, Wu, Dalal (2005) test pairs', () => {
    const pairs = [
      [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
      [[50, 0, 0], [50, -1, 2], 2.3669],
      [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
      [[50, 2.5, 0], [73, 25, -18], 27.1492],
      [[50, 2.5, 0], [56, -27, -3], 31.903],
      [[50, 2.5, 0], [50, 3.1736, 0.5854], 1.0],
    ];
    for (const [a, b, e] of pairs) assert.ok(Math.abs(deltaE2000(a, b) - e) < 1e-3, `${a} ${b}`);
  });
  test('sRGB white is L 100, black L 0; WCAG contrast of black on white is 21', () => {
    assert.ok(Math.abs(srgbToLab([255, 255, 255])[0] - 100) < 0.01);
    assert.ok(Math.abs(srgbToLab([0, 0, 0])[0]) < 0.01);
    assert.ok(Math.abs(contrast([0, 0, 0], [255, 255, 255]) - 21) < 1e-6);
    assert.deepEqual(parseHex('#1EA6DF80'), { rgb: [30, 166, 223], a: 128 / 255 });
  });
  test('hue spread is 0 for one hue and wide for blue with pink', () => {
    assert.equal(hueSpread(new Map([['#1EA6DF', 1], ['#70D5FF', 1]])) < 15, true);
    assert.equal(hueSpread(new Map([['#1EA6DF', 1], ['#EA73AA', 1]])) > 90, true);
  });
});

describe('SSIM', () => {
  const W = 64, H = 64;
  const img = new Float64Array(W * H).map((_, i) => ((i % W) * 3 + Math.floor(i / W) * 2) % 255);
  test('identical images score 1, a noisy copy less, and the score is symmetric', () => {
    assert.equal(Math.round(ssim(img, img, W, H).mean * 1e9) / 1e9, 1);
    let seed = 1;
    const noisy = img.map((v) => Math.min(255, Math.max(0, v + (((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5) * 80)));
    const s1 = ssim(img, noisy, W, H).mean, s2 = ssim(noisy, img, W, H).mean;
    assert.ok(s1 < 0.95 && s1 > 0);
    assert.ok(Math.abs(s1 - s2) < 1e-12);
  });
});

// a synthetic .fig document in openfig-core's shape: nodes with guid/parentIndex, nodeMap, childrenMap
function fakeDoc(spec) {
  const nodes = [];
  let local = 1;
  const add = (n, parent) => {
    const node = { ...n, guid: { sessionID: 1, localID: local++ }, children: undefined };
    if (parent) node.parentIndex = { guid: parent.guid };
    nodes.push(node);
    for (const c of n.children || []) add(c, node);
    return node;
  };
  add(spec, null);
  const id = (n) => `${n.guid.sessionID}:${n.guid.localID}`;
  const nodeMap = new Map(nodes.map((n) => [id(n), n]));
  const childrenMap = new Map();
  for (const n of nodes) if (n.parentIndex) {
    const p = `${n.parentIndex.guid.sessionID}:${n.parentIndex.guid.localID}`;
    childrenMap.set(p, [...(childrenMap.get(p) || []), n]);
  }
  return { nodes, nodeMap, childrenMap };
}
const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const solid = (hex) => ({ type: 'SOLID', visible: true, opacity: 1, color: { r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255, a: 1 } });
function story({ title = 'Сигнали, які не можна ігнорувати', color = '#19323D', font = 'Exo 2', x = 120, titleY = 380, extraText } = {}) {
  const text = (chars, size, y, fill, w = 840, h = size * 2.2) => ({
    type: 'TEXT', name: 'Heading', transform: at(x, y), size: { x: w, y: h }, fontSize: size, fontName: { family: font, style: 'SemiBold' },
    lineHeight: { units: 'PIXELS', value: size * 0.9 }, letterSpacing: { units: 'PERCENT', value: -5 }, textAutoResize: 'HEIGHT', fillPaints: [solid(fill)],
    textData: { characters: chars }, derivedTextData: { baselines: [{ firstCharacter: 0, endCharacter: chars.length, width: Math.min(w - 10, chars.length * size * 0.45), position: { x: 0, y: size * 0.8 }, lineY: 0, lineHeight: size * 0.9 }] },
  });
  return {
    type: 'FRAME', name: 'Story', size: { x: 1080, y: 1920 }, transform: at(0, 0), fillPaints: [solid('#E6F8FF')],
    children: [
      text(title, 76, titleY, color),
      text('Зверніться до лікаря', 40, 900, '#1B566F'),
      { type: 'ROUNDED_RECTANGLE', name: 'Card', transform: at(100, 1300), size: { x: 880, y: 300 }, cornerRadius: 40, fillPaints: [solid('#FFFFFF')], effects: [{ type: 'INNER_SHADOW', visible: true, radius: 5, offset: { x: 0, y: -4 }, color: { r: 0, g: 0.54, b: 0.71, a: 0.14 } }] },
      ...(extraText ? [extraText] : []),
    ],
  };
}
const sceneFrom = (opts) => {
  const doc = fakeDoc(story(opts));
  return sceneOf(doc, doc.nodes[0]);
};

describe('scene, model and lint', () => {
  const corpus = Array.from({ length: 12 }, (_, i) => sceneFrom({ titleY: 360 + i * 6, x: 110 + (i % 4) * 5 }));

  test('the scene graph flattens visible nodes with roles, boxes and text metrics', () => {
    const s = corpus[0];
    assert.equal(s.width, 1080);
    const roles = s.nodes.map((n) => n.role).sort();
    assert.deepEqual(roles, ['glass', 'text', 'text']);
    const title = s.nodes.find((n) => n.text?.size === 76);
    assert.equal(title.text.family, 'Exo 2');
    assert.equal(title.text.trackingPct, -5);
    assert.equal(title.text.overflow, false);
    assert.deepEqual(title.box, { x: 110, y: 360, w: 840, h: 167.2 });
  });

  test('a frame like the corpus passes; wrong font, off-palette colour and overflow are errors', () => {
    const model = buildModel(corpus);
    assert.equal(model.frames, 12);
    const ok = lint(sceneFrom({ titleY: 380, x: 115 }), model);
    assert.equal(ok.errors, 0, JSON.stringify(ok.violations));
    const bad = sceneFrom({ font: 'Montserrat', color: '#FF6A36', x: 20 });
    const checks = lint(bad, model).violations.filter((v) => v.severity === 'error').map((v) => v.check);
    assert.ok(checks.includes('text.font'));
    assert.ok(checks.includes('color.token'));
    assert.ok(checks.includes('layout.marginLeft'));
    const s = sceneFrom();
    s.nodes.find((n) => n.text?.size === 40).text.overflow = true;
    assert.ok(lint(s, model).violations.some((v) => v.check === 'text.overflow' && v.severity === 'error'));
  });

  test('a text growing below its card is a spill; the same text inside the card is not', () => {
    const model = buildModel(corpus);
    const inCard = { type: 'TEXT', name: 'Body', transform: at(140, 1340), size: { x: 700, y: 200 }, fontSize: 36, fontName: { family: 'Exo 2', style: 'SemiBold' },
      lineHeight: { units: 'PIXELS', value: 40 }, letterSpacing: { units: 'PERCENT', value: -5 }, textAutoResize: 'HEIGHT', fillPaints: [solid('#1B566F')],
      textData: { characters: 'Короткий текст' }, derivedTextData: { baselines: [{ firstCharacter: 0, endCharacter: 14, width: 300, position: { x: 0, y: 30 }, lineY: 0, lineHeight: 40 }] } };
    const spills = { ...inCard, size: { x: 700, y: 360 }, derivedTextData: { baselines: Array.from({ length: 9 }, (_, i) => ({ firstCharacter: 0, endCharacter: 14, width: 600, position: { x: 0, y: 30 + i * 40 }, lineY: i * 40, lineHeight: 40 })) } };
    const spill = (extraText) => lint(sceneFrom({ extraText }), model).violations.filter((v) => v.check === 'text.spill');
    assert.equal(spill(inCard).length, 0);
    assert.equal(spill(spills).length, 1);
    // tilted pills overlap: a label of pill B whose top falls in pill A's box is not in pill A
    const s = sceneFrom({ extraText: spills });
    const card = s.nodes.find((n) => n.role === 'glass'), text = s.nodes.find((n) => n.text?.size === 36);
    Object.assign(card, { parent: 'pillA' });
    Object.assign(text, { parent: 'pillB' });
    assert.equal(lint(s, model).violations.filter((v) => v.check === 'text.spill').length, 0);
    text.parent = 'pillA';
    assert.equal(lint(s, model).violations.filter((v) => v.check === 'text.spill').length, 1);
  });

  test('a campaign palette: colours through the token table or from the campaign sketch pass, an unmapped client colour does not', () => {
    const model = buildModel(corpus);
    const recolor = (scene, map) => JSON.parse(Object.entries(map).reduce((s, [a, b]) => s.replaceAll(a.toUpperCase(), b.toUpperCase()), JSON.stringify(scene)));
    const palette = { map: { '#19323D': '#450E26', '#1B566F': '#A31D53', '#E6F8FF': '#FEF3F8' }, extra: ['#EF5CA1'] };
    const pink = recolor(sceneFrom(), palette.map);
    const checks = (s, opts) => lint(s, model, opts).violations.filter((v) => v.check.startsWith('color.')).map((v) => `${v.check} ${v.value}`);
    assert.ok(checks(pink).some((c) => c.startsWith('color.token')), 'pink is off the client palette without a table');
    assert.deepEqual(checks(pink, { palette }), []);
    assert.deepEqual(checks(sceneFrom({ color: '#EF5CA1' }), { palette }).filter((c) => c.includes('EF5CA1')), []);
    const half = recolor(sceneFrom(), { '#19323D': '#450E26', '#E6F8FF': '#FEF3F8' }); // the body stays blue
    assert.deepEqual(checks(half, { palette }), ['color.unmapped #1B566F']);
  });

  test('a card left half empty by a short text is outside the corpus envelope of card slack', () => {
    const inCard = (lines) => ({ type: 'TEXT', name: 'Body', transform: at(140, 1330), size: { x: 700, y: lines * 40 }, fontSize: 36, fontName: { family: 'Exo 2', style: 'SemiBold' },
      lineHeight: { units: 'PIXELS', value: 40 }, letterSpacing: { units: 'PERCENT', value: -5 }, textAutoResize: 'HEIGHT', fillPaints: [solid('#1B566F')],
      textData: { characters: 'Текст у картці' }, derivedTextData: { baselines: Array.from({ length: lines }, (_, i) => ({ firstCharacter: 0, endCharacter: 14, width: 600, position: { x: 0, y: 30 + i * 40 }, lineY: i * 40, lineHeight: 40 })) } });
    const full = Array.from({ length: 12 }, (_, i) => sceneFrom({ titleY: 360 + i * 6, extraText: inCard(6 + (i % 2)) }));
    const model = buildModel(full);
    assert.ok(model.envelopes.cardSlack.max < 0.2, JSON.stringify(model.envelopes.cardSlack));
    const slack = (lines) => lint(sceneFrom({ extraText: inCard(lines) }), model).violations.filter((v) => v.check === 'layout.cardSlack');
    assert.deepEqual(slack(6), []);
    assert.equal(slack(2)[0]?.severity, 'error');
  });

  test('reconstruction: a frame scores 1 against itself and less when its blocks move', () => {
    const a = corpus[0];
    assert.equal(compareScenes(a, a).score, 1);
    const moved = sceneFrom({ titleY: 1000, x: 110 });
    const r = compareScenes(moved, a);
    assert.ok(r.score < 1 && r.layout.f1 < 1);
    assert.equal(r.title.sameFont, true);
  });
});

describe('blind test statistics', () => {
  test('hypergeometric tails for 5 of ours among 20, 5 picked', () => {
    assert.ok(Math.abs(hypergeomTail(20, 5, 5, 0) - 1) < 1e-12);
    assert.ok(Math.abs(hypergeomTail(20, 5, 5, 3) - 1126 / 15504) < 1e-9);
    assert.ok(Math.abs(hypergeomTail(20, 5, 5, 4) - 76 / 15504) < 1e-9);
    assert.equal(verdictOf(hypergeomTail(20, 5, 5, 2)), 'pass');
    assert.equal(verdictOf(hypergeomTail(20, 5, 5, 3)), 'borderline');
    assert.equal(verdictOf(hypergeomTail(20, 5, 5, 4)), 'visible');
  });
  test('scoring counts hits against the key', () => {
    const key = { items: Array.from({ length: 20 }, (_, i) => ({ n: i + 1, ours: i < 5 })) };
    const r = scoreBlind(key, ['1', '2', '9', '10', '11']);
    assert.equal(r.hits, 2);
    assert.equal(r.verdict, 'pass');
  });
});

describe('sp creative', () => {
  const png = async (file, color, box) => {
    let img = sharp({ create: { width: 108, height: 192, channels: 3, background: color } });
    if (box) img = img.composite([{ input: { create: { width: 40, height: 40, channels: 3, background: '#000000' } }, left: box[0], top: box[1] }]);
    await img.png().toFile(path.join(dir, file));
  };

  test('diff: identical PNGs score SSIM 1 with no changed pixels; a moved block does not', async () => {
    await png('a.png', '#1EA6DF', [10, 10]);
    await png('b.png', '#1EA6DF', [50, 120]);
    const same = sp(['diff', 'a.png', 'a.png']);
    assert.equal(same.code, 0, JSON.stringify(same.json));
    assert.equal(same.json.ssim, 1);
    assert.equal(same.json.changed, 0);
    const moved = sp(['diff', 'b.png', 'a.png', '--heatmap', 'heat.png']);
    assert.ok(moved.json.ssim < 0.99 && moved.json.changed > 0.05);
    assert.ok(fs.existsSync(path.join(dir, 'heat.png')));
  });

  test('blind make writes a page and a key outside it; score reads the key', async () => {
    for (let i = 0; i < 6; i++) await png(`t${i}.png`, '#E6F8FF', [i * 10, 20]);
    const made = sp(['blind', 'make', '--ours', 't0.png,t1.png', '--theirs', 't2.png,t3.png,t4.png,t5.png', '--out', 'blind', '--seed', '3', '--lang', 'en']);
    assert.equal(made.code, 0, JSON.stringify(made.json));
    assert.ok(fs.existsSync(path.join(dir, 'blind', 'index.html')));
    assert.ok(!fs.existsSync(path.join(dir, 'blind', 'key.json')));
    const key = JSON.parse(fs.readFileSync(path.join(dir, 'blind.key.json'), 'utf8'));
    const ours = key.items.filter((it) => it.ours).map((it) => it.n);
    const scored = sp(['blind', 'score', '--key', 'blind.key.json', '--picked', ours.join(',')]);
    assert.equal(scored.json.hits, 2);
  });

  test('journal add and list; regress runs a suite relative to its file', () => {
    assert.equal(sp(['journal', 'add', '--file', 'j.jsonl', '--hypothesis', 'tighter tracking', '--change', 'title -5 %', '--metrics', '{"score":0.6}']).code, 0);
    const listed = sp(['journal', 'list', '--file', 'j.jsonl']);
    assert.equal(listed.json.count, 1);
    assert.equal(listed.json.entries[0].metrics.score, 0.6);
    fs.writeFileSync(path.join(dir, 'suite.json'), JSON.stringify({ cases: [
      { name: 'same', kind: 'diff', ours: 'a.png', theirs: 'a.png', expect: { ssimMin: 0.999 } },
      { name: 'moved', kind: 'diff', ours: 'b.png', theirs: 'a.png', expect: { ssimMin: 0.999 } },
    ] }));
    const r = sp(['regress', 'suite.json']);
    assert.equal(r.json.cases, 2);
    assert.equal(r.json.failed, 1);
    assert.equal(r.json.results[1].pass, false);
  });

  test('a file that is not a .fig fails with error "fig"', () => {
    fs.writeFileSync(path.join(dir, 'x.fig'), 'not a zip');
    const r = sp(['frames', 'x.fig']);
    assert.equal(r.code, 1);
    assert.equal(r.json.error, 'fig');
  });
});

describe('campaign palette', () => {
  test('Lab to hex inverts hex to Lab', () => {
    for (const hex of ['#1EA6DF', '#2AB8F4', '#FFFFFF', '#000000', '#450E26', '#FEF3F8']) assert.equal(labToHex(hexToLab(hex)), hex);
  });
  test('a shade near a mapped token moves with it and keeps its offset; far colours stay', () => {
    // #2AB8F4 is 2.4 dE2000 from the mapped #2CC1FF (5.15 from #1EA6DF, outside the radius)
    const { map, added } = expandMap({ '#2CC1FF': '#EF5CA1' }, ['#2CC1FF', '#2AB8F4', '#FFFFFF']);
    assert.equal(map['#2CC1FF'], '#EF5CA1');
    assert.equal(map['#FFFFFF'], undefined);
    const to = map['#2AB8F4'];
    assert.ok(to && to !== '#EF5CA1', JSON.stringify(added));
    const shift = deltaE2000(hexToLab('#2AB8F4'), hexToLab('#2CC1FF'));
    assert.ok(Math.abs(deltaE2000(hexToLab(to), hexToLab('#EF5CA1')) - shift) < 3, `${to}`);
    assert.equal(added.length, 1);
    // white sits 1.8 dE2000 from a light tint the table maps, and still stays white
    assert.equal(expandMap({ '#F0F8FF': '#FEF3F8' }, ['#FFFFFF']).map['#FFFFFF'], undefined);
  });
});
