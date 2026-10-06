import fs from 'node:fs';
import path from 'node:path';
import { SpError, slash } from '../lib/out.mjs';
import { homePath } from '../lib/paths.mjs';
import { MODES } from '../lib/phases.mjs';
import { createRun, describe, ensureRoot, findRoot, listRuns } from '../lib/run.mjs';

export const summary = 'Create a run in the client folder (phase 0).';

export const help = `sp start [--mode prototype|creatives] [--new]

Creates site-proto/ in the client folder (the current folder, or --client) unless one is found there
or above: .gitignore, client/brand/, client/inputs/, runs/. Then creates runs/<date>-<mode>/ with
run.json, run-log.md and the run's folders, at phase 0.

Refuses without a passing \`sp env\` from the last 24 hours, and while a run of the same mode is
active (continue that one instead).

  --mode <mode>   prototype (default) or creatives
  --new           start a new run although one of this mode is active`;

export const options = {
  mode: { type: 'string', default: 'prototype' },
  new: { type: 'boolean' },
};

const ENV_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function run(ctx) {
  const { mode } = ctx.args;
  if (!MODES.includes(mode)) throw new SpError('usage', `unknown mode "${mode}"`, { modes: MODES });

  const envFile = homePath('env.json');
  const env = fs.existsSync(envFile) ? JSON.parse(fs.readFileSync(envFile, 'utf8')) : null;
  if (!env?.ok || Date.now() - Date.parse(env.checked) > ENV_MAX_AGE_MS) {
    throw new SpError('env', 'no passing sp env in the last 24 hours', { hint: 'run sp env and fix what it reports' });
  }

  const clientDir = path.resolve(ctx.args.client ?? ctx.cwd);
  const found = findRoot(clientDir);
  const root = ensureRoot(found ? path.dirname(found) : clientDir);
  const active = listRuns(root).filter((r) => r.state.status === 'active' && r.state.mode === mode);
  if (active.length && !ctx.args.new) {
    throw new SpError('active-run', `run ${active.at(-1).state.id} is still active`, {
      run: slash(active.at(-1).dir),
      hint: 'continue it (sp status shows where), or pass --new',
    });
  }
  return { root: slash(root), ...describe(createRun(root, mode)) };
}
