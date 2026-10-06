#!/usr/bin/env node
// sp: the ELT Design toolkit. Each file in commands/ is one subcommand exporting
//   summary  one line for `sp --help`
//   help     the full `sp <cmd> --help` text: the only place flags are described
//   options  node:util parseArgs options
//   phase    optional: the phase the command belongs to (number, or function of ctx); the command
//            refuses to run until that phase's required artifacts exist
//   run(ctx) returns the fields of the JSON summary, or throws SpError
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { EXIT, SpError, printSummary } from './lib/out.mjs';
import { TOOLKIT_DIR } from './lib/paths.mjs';

const COMMANDS_DIR = path.join(TOOLKIT_DIR, 'commands');

const GLOBAL_OPTIONS = {
  run: { type: 'string' },
  client: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

const GLOBAL_HELP = `Global flags:
  --run <dir>      act on this run folder (default: the run around the current folder,
                   else the newest active run of the elt-design/ found from here)
  --client <dir>   look for elt-design/ from this client folder instead of the current one
  -h, --help       this text`;

async function loadCommand(name) {
  const file = path.join(COMMANDS_DIR, `${name}.mjs`);
  if (!/^[a-z][a-z-]*$/.test(name) || !fs.existsSync(file)) {
    throw new SpError('usage', `unknown command "${name}"`, { hint: 'sp --help lists the commands' });
  }
  return import(pathToFileURL(file).href);
}

async function usage() {
  const names = fs.readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4)).sort();
  const lines = [];
  for (const name of names) lines.push(`  ${name.padEnd(8)} ${(await loadCommand(name)).summary}`);
  process.stdout.write(
    `sp: the ELT Design toolkit. Every command prints one JSON line: {"ok": true|false, "cmd": ...}.\n` +
      `Flags of a command: sp <command> --help\n\nCommands:\n${lines.join('\n')}\n\n${GLOBAL_HELP}\n`,
  );
}

function context(values, positionals) {
  let located;
  const ctx = {
    args: values,
    positionals,
    cwd: process.cwd(),
    // { root, run } for this invocation; either may be null
    locate: async () => {
      const { locate } = await import('./lib/run.mjs');
      return (located ??= locate({ run: values.run, client: values.client, cwd: ctx.cwd }));
    },
    requireRun: async () => {
      const { run } = await ctx.locate();
      if (!run) {
        throw new SpError('no-run', 'no active run here', {
          hint: 'run from the client folder or inside its elt-design/, pass --run <dir>, or create one with sp start',
        });
      }
      return run;
    },
  };
  return ctx;
}

async function main(argv) {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') return usage();
  const command = await loadCommand(name);
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: { ...GLOBAL_OPTIONS, ...command.options }, allowPositionals: true, strict: true });
  } catch (e) {
    throw new SpError('usage', e.message, { hint: `sp ${name} --help` });
  }
  if (parsed.values.help) {
    process.stdout.write(`${command.help}\n\n${GLOBAL_HELP}\n`);
    return;
  }
  const ctx = context(parsed.values, parsed.positionals);
  if (command.phase !== undefined) {
    const run = await ctx.requireRun();
    const n = typeof command.phase === 'function' ? command.phase(ctx, run) : command.phase;
    const { missing, phaseDef } = await import('./lib/run.mjs');
    const lacking = missing(run, n);
    if (lacking.length) {
      throw new SpError('gate', `phase ${n} (${phaseDef(run, n).id}) cannot start: required artifacts are missing`, {
        phase: { n, id: phaseDef(run, n).id },
        missing: lacking,
      });
    }
  }
  printSummary({ ok: true, cmd: name, ...(await command.run(ctx)) });
}

// Exit once stdout has flushed (Windows pipes write asynchronously), even if a stray handle lingers.
const exit = (code) => process.stdout.write('', () => process.exit(code));

main(process.argv.slice(2)).then(
  () => exit(0),
  (e) => {
    const cmd = process.argv[2] ?? null;
    if (e instanceof SpError) {
      printSummary({ ok: false, cmd, error: e.code, message: e.message, ...e.extra });
      return exit(EXIT[e.code] ?? 1);
    }
    printSummary({ ok: false, cmd, error: 'crash', message: String(e?.stack ?? e).split('\n').slice(0, 4).join(' | ') });
    exit(1);
  },
);
