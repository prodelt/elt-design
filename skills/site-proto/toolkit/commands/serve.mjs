import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { SpError, slash } from '../lib/out.mjs';
import { alive } from '../lib/lock.mjs';
import { TOOLKIT_DIR } from '../lib/paths.mjs';
import { saveRun } from '../lib/run.mjs';

export const summary = 'Serve the run folder over HTTP in the background: one server per run.';

export const help = `sp serve [--port <n>]
sp serve --stop

Starts a detached static server for the run folder on http://127.0.0.1:<port>/ and records url, port
and pid in run.json; while it runs, sp serve returns it again. Folder URLs without the trailing
slash redirect to it, as on the hub host; nothing is cached. Variants live at
/variants/<name>/site/, the hub at /hub/. Server output goes to server.log in the run folder.

  --port <n>   port to listen on (default: the run's previous port, else the first free from 5170)
  --stop       stop this run's server`;

export const options = {
  port: { type: 'string' },
  stop: { type: 'boolean' },
};

const SERVER = path.join(TOOLKIT_DIR, 'lib', 'server.mjs');

export async function run(ctx) {
  const run = await ctx.requireRun();
  const current = run.state.server;

  if (ctx.args.stop) {
    const running = !!current && alive(current.pid);
    if (running) process.kill(current.pid);
    run.state.server = null;
    saveRun(run);
    return { stopped: running };
  }

  if (current && alive(current.pid) && (await answers(current.url))) return { reused: true, server: current };

  const port = ctx.args.port ? Number(ctx.args.port) : await freePort(current?.port ?? 5170);
  const log = fs.openSync(path.join(run.dir, 'server.log'), 'a');
  const child = spawn(process.execPath, [SERVER, run.dir, String(port)], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(log);

  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 5000;
  while (!(await answers(url))) {
    if (Date.now() > deadline) {
      throw new SpError('serve', `the server did not answer on ${url}`, { log: slash(path.join(run.dir, 'server.log')) });
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  run.state.server = { url, port, pid: child.pid, started: new Date().toISOString() };
  saveRun(run);
  return { reused: false, server: run.state.server };
}

async function answers(url) {
  try {
    await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function freePort(from) {
  for (let port = from; port < from + 100; port++) {
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new SpError('serve', `no free port in ${from}-${from + 99}`);
}
