// The one way sp commands get a Chrome. Both functions return the same session shape,
// { browser, owned, profile, close() }, so capture code takes whichever the caller asked for:
//   launch()       our own headless Chrome: a Chrome slot, a throw-away profile, SwiftShader WebGL;
//                  close() shuts it down, removes the profile and frees the slot.
//   attach(cdpUrl) a Chrome someone else owns (agent-browser's, via `agent-browser get cdp-url`);
//                  close() only disconnects.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { loadConfig } from './config.mjs';
import { acquireChromeSlot, liveSlots } from './lock.mjs';

export const PROFILE_PREFIX = 'site-proto-prof-';
const AGENT_BROWSER_PREFIX = 'agent-browser-chrome-';

const BASE_ARGS = ['--hide-scrollbars', '--no-first-run', '--mute-audio', '--lang=en-US'];
// Software WebGL: the same pixels on every machine, and WebGL works without a GPU.
const SWIFTSHADER_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

const open = new Set();
const closeAllAndExit = async () => {
  await Promise.allSettled([...open].map((session) => session.close()));
  process.exit(130);
};
process.once('SIGINT', closeAllAndExit);
process.once('SIGTERM', closeAllAndExit);

function track(session) {
  let closing;
  const close = session.close;
  session.close = () => (closing ??= close().finally(() => open.delete(session)));
  open.add(session);
  return session;
}

export async function launch({ label = 'sp', swiftshader = true, args = [], width = 1440, height = 900 } = {}) {
  const config = loadConfig();
  const slot = await acquireChromeSlot({ limit: config.chromeLimit, label });
  let profile;
  try {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX));
    slot.update({ profile });
    const browser = await puppeteer.launch({
      ...(config.chromePath ? { executablePath: config.chromePath } : { channel: 'chrome' }),
      headless: true,
      userDataDir: profile,
      args: [...BASE_ARGS, ...(swiftshader ? SWIFTSHADER_ARGS : []), ...args],
      defaultViewport: { width, height },
      protocolTimeout: 60_000,
    });
    return track({
      browser,
      owned: true,
      profile,
      close: async () => {
        await browser.close().catch(() => {});
        removeProfile(profile);
        slot.release();
      },
    });
  } catch (e) {
    removeProfile(profile);
    slot.release();
    throw e;
  }
}

export async function attach(cdpUrl) {
  const endpoint = cdpUrl.startsWith('ws') ? { browserWSEndpoint: cdpUrl } : { browserURL: cdpUrl };
  const browser = await puppeteer.connect({ ...endpoint, defaultViewport: null, protocolTimeout: 60_000 });
  return track({ browser, owned: false, profile: null, close: async () => browser.disconnect() });
}

// For commands with a --cdp flag: attach when given one, launch otherwise; always closes.
export async function withBrowser({ cdp, ...launchOptions }, fn) {
  const session = cdp ? await attach(cdp) : await launch(launchOptions);
  try {
    return await fn(session.browser, session);
  } finally {
    await session.close();
  }
}

function removeProfile(profile) {
  if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

// Removes profiles left behind by killed sp commands and agent-browser daemons. A profile is in use
// while its Chrome holds it: on Windows the `lockfile` inside cannot be deleted, elsewhere
// SingletonLock names a live pid. Profiles younger than `minAgeMs` are left alone.
export function pruneOrphanProfiles({ minAgeMs = 10 * 60 * 1000 } = {}) {
  const held = new Set(liveSlots().map((s) => s.profile).filter(Boolean));
  const tmp = os.tmpdir();
  const removed = [];
  for (const name of fs.readdirSync(tmp)) {
    if (!name.startsWith(PROFILE_PREFIX) && !name.startsWith(AGENT_BROWSER_PREFIX)) continue;
    const dir = path.join(tmp, name);
    const stat = fs.statSync(dir, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || held.has(dir) || Date.now() - stat.mtimeMs < minAgeMs || chromeHolds(dir)) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      removed.push(name);
    } catch {
      // a Chrome started using it after all
    }
  }
  return removed;
}

function chromeHolds(profile) {
  if (process.platform === 'win32') {
    try {
      fs.rmSync(path.join(profile, 'lockfile'), { force: true });
      return false;
    } catch {
      return true;
    }
  }
  try {
    const pid = Number(fs.readlinkSync(path.join(profile, 'SingletonLock')).split('-').pop());
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
