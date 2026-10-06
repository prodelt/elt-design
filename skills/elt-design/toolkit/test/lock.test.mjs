import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

process.env.ELT_DESIGN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-lock-'));
const { acquireChromeSlot, liveSlots } = await import('../lib/lock.mjs');
const locks = path.join(process.env.ELT_DESIGN_HOME, 'locks');

before(() => fs.mkdirSync(locks, { recursive: true }));
after(() => fs.rmSync(process.env.ELT_DESIGN_HOME, { recursive: true, force: true }));

test('slots run out at the limit and come back on release', async () => {
  const a = await acquireChromeSlot({ limit: 2, label: 'a' });
  const b = await acquireChromeSlot({ limit: 2, label: 'b' });
  assert.deepEqual([a.slot, b.slot], [0, 1]);
  await assert.rejects(acquireChromeSlot({ limit: 2, timeoutMs: 300, pollMs: 50 }), { code: 'chrome-busy' });
  a.release();
  const c = await acquireChromeSlot({ limit: 2, timeoutMs: 300, pollMs: 50 });
  assert.equal(c.slot, 0);
  b.release();
  c.release();
  assert.deepEqual(fs.readdirSync(locks), []);
});

test('a waiting caller gets the slot as soon as it is released', async () => {
  const a = await acquireChromeSlot({ limit: 1, label: 'a' });
  setTimeout(() => a.release(), 150);
  const b = await acquireChromeSlot({ limit: 1, timeoutMs: 2000, pollMs: 50 });
  assert.equal(b.slot, 0);
  b.release();
});

test('a slot held by a dead process is reclaimed', async () => {
  fs.writeFileSync(path.join(locks, 'chrome-0.json'), JSON.stringify({ pid: 999999, label: 'ghost', started: new Date().toISOString() }));
  const a = await acquireChromeSlot({ limit: 1, timeoutMs: 300, pollMs: 50 });
  assert.equal(a.slot, 0);
  a.release();
});

test('recorded details show up in liveSlots', async () => {
  const a = await acquireChromeSlot({ limit: 1, label: 'capture' });
  a.update({ profile: 'C:/tmp/elt-design-prof-x' });
  assert.deepEqual(liveSlots().map((s) => [s.label, s.profile]), [['capture', 'C:/tmp/elt-design-prof-x']]);
  a.release();
});
