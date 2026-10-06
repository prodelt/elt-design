// Machine-wide cap on the Chromes sp commands run at once: one slot file per running Chrome in
// ~/.site-proto/locks/. A slot whose process is gone, or which is older than MAX_AGE, is free again.
import fs from 'node:fs';
import path from 'node:path';
import { SpError } from './out.mjs';
import { homePath } from './paths.mjs';

const MAX_AGE_MS = 6 * 60 * 60 * 1000;

export const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

const readSlot = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // being written or removed right now
  }
};

const stale = (info) => !info || !alive(info.pid) || Date.now() - Date.parse(info.started) > MAX_AGE_MS;

// An unreadable slot file is either mid-write (fresh) or corrupt (old).
const staleFile = (file) => {
  const info = readSlot(file);
  if (info) return stale(info);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  return !!stat && Date.now() - stat.mtimeMs > 5000;
};

// Waits for a free slot and returns { slot, update(info), release() }.
export async function acquireChromeSlot({ limit, label = 'sp', timeoutMs = 10 * 60 * 1000, pollMs = 1000 }) {
  const dir = homePath('locks');
  fs.mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (let slot = 0; slot < limit; slot++) {
      const file = path.join(dir, `chrome-${slot}.json`);
      if (staleFile(file)) fs.rmSync(file, { force: true });
      let info = { pid: process.pid, label, started: new Date().toISOString() };
      try {
        fs.writeFileSync(file, JSON.stringify(info), { flag: 'wx' });
      } catch (e) {
        if (e.code === 'EEXIST') continue;
        throw e;
      }
      let held = true;
      const release = () => {
        if (held) fs.rmSync(file, { force: true });
        held = false;
        process.off('exit', release);
      };
      process.on('exit', release);
      const update = (extra) => {
        info = { ...info, ...extra };
        fs.writeFileSync(file, JSON.stringify(info));
      };
      return { slot, update, release };
    }
    if (Date.now() > deadline) {
      throw new SpError('chrome-busy', `all ${limit} Chrome slots stayed busy for ${Math.round(timeoutMs / 60000)} min`, {
        holders: liveSlots().map((s) => s.label),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// Slots held by live processes, with whatever they recorded (label, profile path).
export function liveSlots() {
  const dir = homePath('locks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((name) => readSlot(path.join(dir, name)))
    .filter((info) => !stale(info));
}
