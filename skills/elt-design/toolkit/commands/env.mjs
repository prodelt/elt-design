import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { SpError, slash } from '../lib/out.mjs';
import { ensureHome } from '../lib/config.mjs';
import { TOOLKIT_DIR, agentBrowserBin, claudeDir, homePath } from '../lib/paths.mjs';

export const summary = "Check this machine, install the toolkit's packages, set up ~/.elt-design/ (phase 0).";

export const help = `sp env [--no-install]

Checks, in order:
  node          Node >= 20
  packages      the toolkit's npm packages at their pinned versions (runs npm ci when not)
  chrome        Chrome starts with a throw-away profile, and the profile is removed afterwards
  webgl         a WebGL canvas renders under SwiftShader
  ffmpeg, sharp load and report their versions
  port          a local port can be opened
  shell-vars    Windows: MSYS_NO_PATHCONV=1 and PYTHONIOENCODING=utf-8 are set (warning only)
  temp-path     Windows: TEMP has no non-ASCII letters
  agent-browser version and \`doctor --offline --quick\`
  orphans       removes Chrome profiles left in TEMP by killed runs (warning only)
  grilling      the grilling skill is installed, as a plugin or a ~/.claude/skills link
Also creates ~/.elt-design/ with a default config.json on the first run; config.missing lists the
answers to ask the operator and write into that file.

Each check is {id, ok, level, ...}; a failed "fail"-level check makes the command fail. The result
goes to ~/.elt-design/env.json: sp start needs a passing one from the last 24 hours.

  --no-install   report packages that are missing instead of running npm ci`;

export const options = { 'no-install': { type: 'boolean' } };

const win = process.platform === 'win32';

export async function run(ctx) {
  const t0 = Date.now();
  const config = ensureHome();
  const checks = [];
  const check = async (id, fn, level = 'fail') => {
    const started = Date.now();
    try {
      const result = await fn();
      checks.push({ id, ok: result.ok !== false, level, ...result, ms: Date.now() - started });
    } catch (e) {
      checks.push({ id, ok: false, level, error: String(e?.message ?? e).split('\n')[0].slice(0, 300), ms: Date.now() - started });
    }
  };
  const passed = (id) => checks.find((c) => c.id === id)?.ok;
  const skip = (id, why) => checks.push({ id, ok: false, level: 'fail', skipped: why });

  await check('node', () => ({ ok: Number(process.versions.node.split('.')[0]) >= 20, version: process.versions.node }));
  await check('packages', () => packages(!ctx.args['no-install']));

  if (passed('packages')) {
    await check('chrome', chromeAndWebgl);
    const { webgl, ...chrome } = checks.pop();
    checks.push(chrome);
    if (webgl) checks.push({ id: 'webgl', level: 'fail', ...webgl });
    else skip('webgl', 'chrome did not start');
    await check('ffmpeg', ffmpeg);
    await check('sharp', async () => {
      const { versions } = (await import('sharp')).default;
      return { version: versions.sharp, vips: versions.vips };
    });
  } else {
    for (const id of ['chrome', 'webgl', 'ffmpeg', 'sharp']) skip(id, 'packages missing');
  }
  await check('port', freePort);
  if (win) {
    await check('shell-vars', shellVars, 'warn');
    await check('temp-path', () => ({ ok: /^[\x20-\x7e]*$/.test(os.tmpdir()), path: slash(os.tmpdir()) }));
  }
  if (passed('packages')) await check('agent-browser', agentBrowser);
  else skip('agent-browser', 'packages missing');
  await check('orphans', async () => ({ removed: (await import('../lib/browser.mjs')).pruneOrphanProfiles().length }), 'warn');
  await check('grilling', grilling);

  const ok = checks.every((c) => c.ok || c.level !== 'fail');
  const result = {
    checks,
    config: { dir: slash(config.dir), file: slash(config.config), created: config.created, missing: config.missing },
    seconds: Math.round((Date.now() - t0) / 100) / 10,
  };
  fs.writeFileSync(homePath('env.json'), JSON.stringify({ ok, checked: new Date().toISOString(), ...result }, null, 2) + '\n');
  if (!ok) {
    throw new SpError('env', 'some checks failed', { failed: checks.filter((c) => !c.ok && c.level === 'fail').map((c) => c.id), ...result });
  }
  return result;
}

function packages(install) {
  const pkg = JSON.parse(fs.readFileSync(path.join(TOOLKIT_DIR, 'package.json'), 'utf8'));
  const wrong = () =>
    Object.entries(pkg.dependencies).filter(([name, version]) => {
      const file = path.join(TOOLKIT_DIR, 'node_modules', name, 'package.json');
      return !fs.existsSync(file) || JSON.parse(fs.readFileSync(file, 'utf8')).version !== version;
    }).map(([name]) => name);
  let missing = wrong();
  let installed = false;
  if (missing.length && install) {
    const log = homePath('cache', 'npm-ci.log');
    const fd = fs.openSync(log, 'w');
    spawnSync(win ? 'npm.cmd' : 'npm', ['ci', '--no-audit', '--no-fund'], {
      cwd: TOOLKIT_DIR,
      shell: win,
      stdio: ['ignore', fd, fd],
      timeout: 15 * 60 * 1000,
    });
    fs.closeSync(fd);
    installed = true;
    missing = wrong();
    if (missing.length) return { ok: false, installed, missing, log: slash(log) };
  }
  return missing.length
    ? { ok: false, missing, hint: `npm ci in ${slash(TOOLKIT_DIR)}` }
    : { installed, versions: pkg.dependencies };
}

async function chromeAndWebgl() {
  const { launch } = await import('../lib/browser.mjs');
  const session = await launch({ label: 'sp env' });
  let version, webgl;
  try {
    version = await session.browser.version();
    const page = await session.browser.newPage();
    const gl = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 16;
      const g = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!g) return null;
      g.clearColor(1, 0, 0, 1);
      g.clear(g.COLOR_BUFFER_BIT);
      const pixel = new Uint8Array(4);
      g.readPixels(8, 8, 1, 1, g.RGBA, g.UNSIGNED_BYTE, pixel);
      const info = g.getExtension('WEBGL_debug_renderer_info');
      return {
        context: typeof WebGL2RenderingContext !== 'undefined' && g instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl',
        renderer: info ? g.getParameter(info.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER),
        pixel: [...pixel],
      };
    });
    webgl = gl
      ? { ok: gl.pixel[0] === 255 && gl.pixel[3] === 255 && /swiftshader/i.test(gl.renderer), ...gl }
      : { ok: false, error: 'no WebGL context' };
  } finally {
    await session.close();
  }
  const profileRemoved = !fs.existsSync(session.profile);
  return { ok: profileRemoved, version, profileRemoved, webgl };
}

async function ffmpeg() {
  const bin = (await import('ffmpeg-static')).default;
  const result = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  const first = (result.stdout ?? '').split('\n')[0];
  return { ok: result.status === 0, version: first.match(/ffmpeg version (\S+)/)?.[1] ?? first, path: slash(bin) };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve({ port }));
    });
  });
}

function shellVars() {
  const unset = [];
  if (process.env.MSYS_NO_PATHCONV !== '1') unset.push('MSYS_NO_PATHCONV=1');
  if (!/^utf-?8$/i.test(process.env.PYTHONIOENCODING ?? '')) unset.push('PYTHONIOENCODING=utf-8');
  return unset.length ? { ok: false, unset, hint: `in Git Bash, prefix commands with ${unset.join(' ')}` } : {};
}

// agent-browser spawns a daemon that inherits stdout pipes and never lets a pipe close
// (agent-browser issue #1407), so its output always goes through a file.
function agentBrowserRun(bin, args) {
  const out = path.join(os.tmpdir(), `sp-env-ab-${process.pid}-${args[0]}.txt`);
  const fd = fs.openSync(out, 'w');
  const ffmpegDir = path.join(TOOLKIT_DIR, 'node_modules', 'ffmpeg-static');
  try {
    const result = spawnSync(bin, args, {
      stdio: ['ignore', fd, fd],
      timeout: 30_000,
      windowsHide: true,
      env: {
        ...process.env,
        AGENT_BROWSER_SOCKET_DIR: homePath('cache', 'agent-browser'),
        PATH: `${ffmpegDir}${path.delimiter}${process.env.PATH}`,
      },
    });
    return { status: result.status, text: fs.readFileSync(out, 'utf8') };
  } finally {
    fs.closeSync(fd);
    fs.rmSync(out, { force: true });
  }
}

function agentBrowser() {
  const bin = agentBrowserBin();
  if (!fs.existsSync(bin)) return { ok: false, error: `no binary ${slash(bin)}` };
  const version = agentBrowserRun(bin, ['--version']);
  const doctor = agentBrowserRun(bin, ['doctor', '--offline', '--quick', '--json']);
  let report = null;
  try {
    report = JSON.parse(doctor.text);
  } catch {
    // older builds print text only
  }
  const failed = (report?.checks ?? []).filter((c) => c.status === 'fail').map((c) => `${c.id}: ${c.message}`);
  return {
    ok: version.status === 0 && doctor.status === 0 && failed.length === 0,
    version: version.text.trim().split(/\s+/).pop(),
    path: slash(bin),
    ...(failed.length ? { failed } : {}),
  };
}

// grilling counts as installed from a ~/.claude/skills link or from any installed plugin.
function grilling() {
  const forms = [];
  if (fs.existsSync(path.join(claudeDir(), 'skills', 'grilling', 'SKILL.md'))) forms.push('link');
  const installed = path.join(claudeDir(), 'plugins', 'installed_plugins.json');
  if (fs.existsSync(installed)) {
    const plugins = JSON.parse(fs.readFileSync(installed, 'utf8')).plugins ?? {};
    const hit = Object.values(plugins).flat().some((p) => p.installPath && findSkill(path.join(p.installPath, 'skills'), 'grilling', 3));
    if (hit) forms.push('plugin');
  }
  return forms.length
    ? { forms }
    : { ok: false, hint: 'install the mattpocock-skills plugin: /plugin install mattpocock-skills@claude-plugins-official' };
}

function findSkill(dir, name, depth) {
  if (depth < 0 || !fs.existsSync(dir)) return false;
  if (fs.existsSync(path.join(dir, name, 'SKILL.md'))) return true;
  return fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && findSkill(path.join(dir, e.name), name, depth - 1));
}
