import fs from 'node:fs';
import path from 'node:path';
import { SpError, slash } from '../lib/out.mjs';
import { alive } from '../lib/lock.mjs';
import { SP_SCRIPT, agentBrowserBin, skillPath } from '../lib/paths.mjs';
import { ROLES } from '../lib/phases.mjs';
import { operatorWords } from '../lib/run.mjs';

export const summary = "Write an agent's assignment and print the prompt that launches the agent.";

export const help = `sp assign <role> [--name <slug>] [--timebox <minutes>] [--specifics <file>|-]

Writes assignments/<role>[-<name>].md from templates/assignment.md with: the role's instruction
file, the standing rules for every agent, the operator's words from every checkpoint so far, the
client's rules (client/rules.json), the agent's work folder (created), how to call sp, the run
server, the timebox and the report format. Re-running replaces the assignment.

Prints the assignment path, the model from the role file's header (null: the session's model) and
the prompt for a general-purpose background agent.

Roles: scout, market-demand, market-competitors, market-voc, synth (phase 2), builder (phase 4),
reviewer (phase 5). Refuses until the role's phase may start.

  --name <slug>        which scout, builder or reviewer: a group of sections for a scout, the
                       variant folder (e.g. a-bold) for a builder or reviewer; required for those
  --timebox <minutes>  overrides the timebox from the role file's header
  --specifics <file>   markdown for the "Specifics" section: what only this agent needs
                       (- reads it from stdin)`;

export const options = {
  name: { type: 'string' },
  timebox: { type: 'string' },
  specifics: { type: 'string' },
};

export const phase = (ctx, run) => roleSpec(ctx, run).phase;

const DEFAULT_TIMEBOX = 60;

function roleSpec(ctx, run) {
  const table = ROLES[run.state.mode];
  if (!table) throw new SpError('usage', `no agent roles for ${run.state.mode} runs yet`);
  const spec = table[ctx.positionals[0]];
  if (!spec) throw new SpError('usage', `unknown role "${ctx.positionals[0] ?? ''}"`, { roles: Object.keys(table) });
  return spec;
}

export async function run(ctx) {
  const run = await ctx.requireRun();
  const role = ctx.positionals[0];
  const spec = roleSpec(ctx, run);
  const { name } = ctx.args;
  const named = spec.dir.includes('{name}');
  if (named && !name) throw new SpError('usage', `${role} needs --name`, { hint: 'sp assign --help' });
  if (name && !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new SpError('usage', `--name "${name}" is not a lowercase slug`);

  const id = named ? `${role}-${name}` : role;
  const workdir = path.join(run.dir, spec.dir.replace('{name}', name ?? ''));
  fs.mkdirSync(workdir, { recursive: true });

  const roleFile = skillPath('references', 'roles', `${role}.md`);
  const header = frontmatter(roleFile);
  const minutes = Number(ctx.args.timebox ?? header.timebox ?? DEFAULT_TIMEBOX);
  if (!(minutes > 0)) throw new SpError('usage', `timebox "${ctx.args.timebox}" is not a number of minutes`);
  const due = new Date(Date.now() + minutes * 60_000);
  const server = run.state.server && alive(run.state.server.pid) ? run.state.server : null;

  const values = {
    role,
    id,
    run: slash(run.dir),
    workdir: slash(workdir),
    report: slash(path.join(workdir, 'report.md')),
    role_file: fs.existsSync(roleFile) ? slash(roleFile) : `${slash(roleFile)} (not written yet: work from this assignment alone)`,
    sp: `node "${slash(SP_SCRIPT)}"`,
    server: server
      ? `${server.url} serves the run folder; your folder is ${server.url}${slash(path.relative(run.dir, workdir))}/`
      : 'none running (the coordinator starts it with sp serve when your work needs one)',
    agent_browser: `"${slash(agentBrowserBin())}"`,
    socket_dir: slash(path.join(run.dir, '.sockets')),
    timebox: `${minutes} min, until ${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}`,
    standing_rules: section(skillPath('references', 'standing-rules.md'), 'Every agent'),
    operator_words: checkpointWords(run),
    client_rules: clientRules(run.root),
    specifics: readSpecifics(ctx.args.specifics),
  };
  const template = fs.readFileSync(skillPath('templates', 'assignment.md'), 'utf8');
  const text = template.replace(/\{\{(\w+)\}\}/g, (match, key) => values[key] ?? match);
  const file = path.join(run.dir, 'assignments', `${id}.md`);
  const replaced = fs.existsSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);

  return {
    role,
    assignment: slash(file),
    replaced,
    workdir: slash(workdir),
    model: header.model && header.model !== 'session' ? header.model : null,
    timeboxMinutes: minutes,
    roleFileExists: fs.existsSync(roleFile),
    prompt:
      `You are a site-proto agent in the role ${role}. You are already a background agent: do all the work ` +
      `yourself, without starting other agents. Read your assignment and follow it: ${slash(file)}`,
  };
}

// `key: value` lines between the leading --- fences of a markdown file.
function frontmatter(file) {
  if (!fs.existsSync(file)) return {};
  const match = fs.readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  return Object.fromEntries(
    match[1].split(/\r?\n/).map((line) => line.match(/^([\w-]+):\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]),
  );
}

// Body of the "## <heading>" section, up to the next "## ".
function section(file, heading) {
  const text = fs.readFileSync(file, 'utf8');
  const start = text.search(new RegExp(`^## ${heading}\\s*$`, 'm'));
  if (start < 0) throw new SpError('skill', `no "## ${heading}" section in ${slash(file)}`);
  const body = text.slice(text.indexOf('\n', start) + 1);
  const end = body.search(/^## /m);
  return (end < 0 ? body : body.slice(0, end)).trim();
}

function checkpointWords(run) {
  const dir = path.join(run.dir, 'checkpoints');
  const parts = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => [f.slice(0, -3), operatorWords(path.join(dir, f))])
    .filter(([, words]) => words)
    .map(([name, words]) => `### Checkpoint ${name}\n\n${words}`);
  return parts.length ? parts.join('\n\n') : '(no checkpoint passed yet)';
}

function clientRules(root) {
  const file = path.join(root, 'client', 'rules.json');
  if (!fs.existsSync(file)) return '(none)';
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const items = Array.isArray(data) ? data : data.rules;
  if (Array.isArray(items)) return items.map((r) => `- ${typeof r === 'string' ? r : (r.text ?? JSON.stringify(r))}`).join('\n');
  return '```json\n' + JSON.stringify(data, null, 2) + '\n```';
}

function readSpecifics(source) {
  if (!source) return '(none)';
  const text = fs.readFileSync(source === '-' ? 0 : path.resolve(source), 'utf8').trim();
  return text || '(none)';
}
