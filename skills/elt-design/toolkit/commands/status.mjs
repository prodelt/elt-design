import { loadConfig } from '../lib/config.mjs';
import { slash } from '../lib/out.mjs';
import { alive } from '../lib/lock.mjs';
import { describe, listRuns } from '../lib/run.mjs';

export const summary = 'Show the run: phase and its instruction file, NEXT, what the next phase still needs.';

export const help = `sp status

Prints the run this folder belongs to:
  phase     current phase and its instruction file (fileExists: false = that part of the skill is
            not written yet)
  next      NEXT, where to resume
  gate      what the next phase still requires before sp log done lets it start
  server    the run's sp serve, with alive: false if its process is gone
  runs      every run of this client
  operator  studio and language from ~/.elt-design/config.json (null until phase 0 asks)
With no elt-design/ here or above, run and root are null.`;

export async function run(ctx) {
  const { studio, operatorLanguage } = loadConfig();
  const operator = { studio, language: operatorLanguage };
  const { root, run } = await ctx.locate();
  if (!root) {
    return { run: null, root: null, operator, hint: 'no elt-design/ here or above: ask the operator for the client folder' };
  }
  const runs = listRuns(root).map(({ state }) => ({ id: state.id, mode: state.mode, phase: state.phase, status: state.status }));
  if (!run) return { run: null, root: slash(root), runs, operator, hint: 'no active run: sp start creates one' };
  const summary = describe(run);
  if (summary.server) summary.server = { ...summary.server, alive: alive(summary.server.pid) };
  return { ...summary, root: slash(root), runs, operator };
}
