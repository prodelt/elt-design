// The geometry of sp figma compose: pure rules, no Figma (the plugin's measuring is checked live, ticket 39).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_RULES, gapBetween, padOf, place, plan, rulesOf, specErrors } from '../lib/creative/figma/layout.mjs';

const R = DEFAULT_RULES;
const ref = { from: 'Ref', key: '1' };
const text = (t, extra = {}) => ({ type: 'text', style: ref, text: t, ...extra });
// measured texts: w = the planned width, size and lines as the plugin reports them
const mText = (id, h, size, lines = 1, probes = []) => ({ type: 'text', id, w: 820, h, size, lines, probes });
const logo = { id: 'L', w: 313, h: 59 };

describe('layout rules', () => {
  test('a measured rules file gives p50s (card gaps p25, pill gaps p10); plain overrides win', () => {
    const r = rulesOf({ contentW: { p50: 800 }, gapTitleText: { p50: 44 }, gapCardCard: { p10: 30, p25: 40, p50: 150 }, padX: { p50: 50 }, logoToFirst: { p25: 90 }, zone: { bottom: 1700 } });
    assert.equal(r.contentW, 800);
    assert.equal(r.gap.titleText, 44);
    assert.equal(r.gap.cardCard, 40);
    assert.equal(r.gap.pill, 30);
    assert.equal(r.pad.x, 50);
    assert.equal(r.logo.gap, 90);
    assert.deepEqual(r.zone, { top: 238, bottom: 1700 });
    assert.equal(DEFAULT_RULES.contentW, 820, 'the defaults are not changed');
  });

  test('padding forms and gaps between kinds of blocks', () => {
    assert.deepEqual(padOf(10), { l: 10, r: 10, t: 10, b: 10 });
    assert.deepEqual(padOf(null, R.pad), { l: 45, r: 45, t: 28, b: 31 });
    assert.deepEqual(padOf({ l: 1, t: 2 }), { l: 1, r: 0, t: 2, b: 0 });
    assert.equal(gapBetween('title', 'text', R.gap), 50);
    assert.equal(gapBetween('text', 'card', R.gap), 69);
    assert.equal(gapBetween('card', 'card', R.gap), 43);
    assert.equal(gapBetween('text', 'media', R.gap), 69);
  });

  test('a spec without name or blocks, or with a block missing its elements, is refused', () => {
    assert.match(specErrors({ blocks: [text('a')] })[0], /needs "name"/);
    assert.match(specErrors({ name: 'x', blocks: [] })[0], /needs "blocks"/);
    const errs = specErrors({ name: 'x', blocks: [{ type: 'card', style: ref, text: 'a' }, { type: 'nope' }, { type: 'space' }, { type: 'image', from: '1:2', bleed: 'left' }] });
    assert.equal(errs.length, 4, errs.join(' | '));
    assert.deepEqual(specErrors({ name: 'x', blocks: [text('a'), { type: 'sticker', from: '11:51' }] }), []);
  });

  test('plan: widths set before measuring', () => {
    const p = plan({ blocks: [text('a'), { type: 'card', text: 'b' }, { type: 'pills', items: ['c'] }, { type: 'image', bleed: 'top' }, { type: 'image', w: 600 }] }, R);
    assert.equal(p.margin, 130);
    assert.equal(p.blocks[0].textW, 820);
    assert.equal(p.blocks[1].textW, 820 - 90);
    assert.equal(p.blocks[2].pad, null, 'pills measure the designers\' padding unless the spec sets one');
    assert.equal(p.blocks[3].w, 1080);
    assert.equal(p.blocks[4].w, 600);
    assert.deepEqual(p.scales, [0.92, 0.8464]);
    assert.equal(plan({ width: 880, blocks: [text('a')] }, R).blocks[0].textW, 880);
    const bal = plan({ align: 'left', blocks: [text('a'), text('b', { align: 'center' }), text('c', { align: 'center', balance: false })] }, R).blocks;
    assert.deepEqual(bal.map((x) => x.balance), [false, true, false], 'centred texts are set in balanced lines');
  });
});

describe('layout place', () => {
  test('logo centred at its top; title, text and card stacked with the corpus gaps, centred in the zone', () => {
    const spec = { blocks: [text('T'), text('b'), { type: 'card', shape: ref, style: ref, text: 'c' }] };
    const p = plan(spec, R);
    const m = { logo, blocks: [mText('t', 170, 76, 2), mText('b', 100, 40, 2), { type: 'card', shape: 's', text: 'ct', textW: 730, textH: 96, lines: 2 }] };
    const r = place(spec, p, m, R);
    assert.deepEqual(r.placements[0], { id: 'L', x: 384, y: 142 });
    assert.equal(r.zone.top, 142 + 59 + 85);
    const cardH = 28 + 96 + 31;
    const total = 170 + 50 + 100 + 69 + cardH;
    assert.equal(r.stack.h, total);
    const top = Math.round(r.zone.top + (1732 - r.zone.top - total) / 2);
    const at = Object.fromEntries(r.placements.map((q) => [q.id, q]));
    assert.equal(at.t.y, top);
    assert.equal(at.t.x, 130);
    assert.equal(at.b.y, top + 170 + 50);
    assert.deepEqual(at.s, { id: 's', x: 130, y: top + 170 + 50 + 100 + 69, w: 820, h: cardH });
    assert.deepEqual(at.ct, { id: 'ct', x: 175, y: at.s.y + 28 });
    assert.deepEqual(r.warnings, []);
  });

  test('a title past 3 lines takes the first smaller size that fits; none fits: a warning', () => {
    const spec = { blocks: [text('T'), text('b')] };
    const p = plan(spec, R);
    const probes = [{ scale: 0.92, h: 300, lines: 4 }, { scale: 0.8464, h: 210, lines: 3 }];
    const r = place(spec, p, { blocks: [mText('t', 380, 76, 4, probes), mText('b', 50, 40, 1)] }, R);
    assert.equal(r.placements.find((q) => q.id === 't').scale, 0.8464);
    // a smaller title is balanced again: its narrower width is set and centred
    const narrow = place(spec, p, { blocks: [mText('t', 380, 76, 4, [{ scale: 0.92, w: 640, h: 250, lines: 3 }]), mText('b', 50, 40, 1)] }, R);
    assert.deepEqual(narrow.placements.find((q) => q.id === 't'), { id: 't', x: 220, y: narrow.placements[0].y, scale: 0.92, w: 640 });
    assert.equal(r.stack.h, 210 + 50 + 50);
    assert.deepEqual(r.fit, [{ block: 0, lines: 4, size: 76, scale: 0.8464, linesAfter: 3 }]);
    const worse = place(spec, p, { blocks: [mText('t', 480, 76, 5, [{ scale: 0.92, h: 400, lines: 5 }, { scale: 0.8464, h: 330, lines: 4 }]), mText('b', 50, 40)] }, R);
    assert.match(worse.warnings.join(), /title runs 4 lines even 15 % smaller/);
    // a body text past 3 lines is not a title and keeps its size
    const body = place(spec, p, { blocks: [mText('t', 90, 76, 1), mText('b', 250, 40, 5, probes)] }, R);
    assert.equal(body.placements.find((q) => q.id === 'b').scale, undefined);
  });

  test('a stack taller than the zone warns and starts at the zone top', () => {
    const spec = { blocks: [text('T'), { type: 'space', h: 1400 }] };
    const r = place(spec, plan(spec, R), { logo, blocks: [mText('t', 170, 76, 2), { type: 'space' }] }, R);
    assert.match(r.warnings[0], /need \d+ px more than the zone 286\.\.1732/);
    assert.equal(r.placements.find((q) => q.id === 't').y, 286);
  });

  test('valign top and bottom', () => {
    const spec = { valign: 'top', blocks: [text('T')] };
    assert.equal(place(spec, plan(spec, R), { blocks: [mText('t', 100, 76)] }, R).placements[0].y, 238);
    const low = { valign: 'bottom', blocks: [text('T')] };
    assert.equal(place(low, plan(low, R), { blocks: [mText('t', 100, 76)] }, R).placements[0].y, 1632);
  });

  test('pills: a staggered column sized to their labels, and rows that wrap', () => {
    const spec = { blocks: [{ type: 'pills', shape: ref, style: ref, items: ['a', 'b', 'c'], stagger: true }] };
    const pad = { l: 30, r: 30, t: 20, b: 20 };
    const items = [{ shape: 's0', text: 't0', textW: 300, textH: 50 }, { shape: 's1', text: 't1', textW: 200, textH: 50 }, { shape: 's2', text: 't2', textW: 400, textH: 100 }];
    const r = place(spec, plan(spec, R), { blocks: [{ type: 'pills', pad, items }] }, R);
    const at = Object.fromEntries(r.placements.map((q) => [q.id, q]));
    assert.equal(at.s0.w, 360);
    assert.equal(at.s2.h, 140);
    assert.equal(at.s1.y - (at.s0.y + at.s0.h), 31, 'pills are 31 px apart');
    // left, right, left of the axis by 48 px
    const cx = (q) => q.x + q.w / 2;
    assert.equal(cx(at.s0), 540 - 48);
    assert.equal(cx(at.s1), 540 + 48);
    assert.equal(cx(at.s2), 540 - 48);
    assert.deepEqual([at.t0.x, at.t0.y], [at.s0.x + 30, at.s0.y + 20]);
    assert.equal(at.s0.rotation, undefined);
    const tilted = { blocks: [{ ...spec.blocks[0], tilt: 7 }] };
    const tr = place(tilted, plan(tilted, R), { blocks: [{ type: 'pills', pad, items }] }, R).placements;
    assert.deepEqual(tr.map((q) => q.rotation), [7, 7, -7, -7, 7, 7], 'pill and label turn together, alternately');
    const row = { blocks: [{ type: 'pills', shape: ref, style: ref, items: ['a', 'b', 'c'], flow: 'row' }] };
    const rr = place(row, plan(row, R), { blocks: [{ type: 'pills', pad, items }] }, R);
    const ra = Object.fromEntries(rr.placements.map((q) => [q.id, q]));
    assert.equal(ra.s0.y, ra.s1.y, 'two pills share the first row');
    assert.ok(ra.s2.y > ra.s0.y, 'the third wraps');
    assert.equal(ra.s1.x - (ra.s0.x + ra.s0.w), 31);
  });

  test('a bled photo takes the frame width at its edge and moves the zone; a sticker over text warns', () => {
    const spec = { blocks: [{ type: 'image', from: '1:2', h: 900, bleed: 'top' }, text('T'), { type: 'sticker', from: '11:51', y: 1000 }, { type: 'layer', from: 'Ref', key: '0' }] };
    const m = { logo, blocks: [{ type: 'image', id: 'i', w: 1387, h: 2081 }, mText('t', 170, 76, 2), { type: 'sticker', id: 'k', w: 300, h: 340 }, { type: 'layer', id: 'y', x: -130, y: 897, w: 634, h: 563 }] };
    const r = place(spec, plan(spec, R), m, R);
    const at = Object.fromEntries(r.placements.map((q) => [q.id, q]));
    assert.deepEqual(at.i, { id: 'i', x: 0, y: 0, w: 1080, h: 900 });
    assert.equal(r.zone.top, 900 + 69);
    assert.equal(at.t.y, Math.round(969 + (1732 - 969 - 170) / 2));
    assert.deepEqual(at.y, { id: 'y', x: -130, y: 897 });
    assert.equal(at.k.x, 390);
    assert.match(r.warnings.join(), /block 2 \(sticker\) covers block 1's text/);
  });

  test('an unbled photo without h keeps its aspect at the content width', () => {
    const spec = { blocks: [{ type: 'image', from: '1:2' }] };
    const r = place(spec, plan(spec, R), { blocks: [{ type: 'image', id: 'i', w: 1000, h: 500 }] }, R);
    assert.deepEqual([r.placements[0].w, r.placements[0].h, r.placements[0].x], [820, 410, 130]);
  });
});
