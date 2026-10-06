// Run state: the client's elt-design/ folder, its runs, run.json (phase, NEXT, phase times) and the
// checkpoint gate. Everything a session needs to resume is in these files, never in conversation memory.
import fs from 'node:fs';
import path from 'node:path';
import { SpError, slash } from './out.mjs';
import { ROOT_NAME, skillPath } from './paths.mjs';
import { PHASES, MODES } from './phases.mjs';

const GITIGNORE = `# Written by sp start: heavy and machine-local files stay out of the client's git.
client/inputs/
runs/*/hub/
runs/*/.sockets/
runs/*/server.log
runs/**/shots/
runs/**/ref/
runs/**/cache/
runs/**/node_modules/
`;

const RUN_DIRS = ['checkpoints', 'assignments', 'research', 'moodboard', 'dossier', 'variants', 'hub', 'polish'];

const TIMINGS_START = '<!-- sp:timings (sp log rewrites this block) -->';
const TIMINGS_END = '<!-- /sp:timings -->';

// ---------- locating ----------

const isDir = (p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;

// Nearest elt-design/ at or above `from`: either `from` itself or its child named elt-design.
export function findRoot(from) {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    if (path.basename(dir) === ROOT_NAME && isDir(path.join(dir, 'runs'))) return dir;
    if (isDir(path.join(dir, ROOT_NAME, 'runs'))) return path.join(dir, ROOT_NAME);
    if (path.dirname(dir) === dir) return null;
  }
}

function runDirAbove(from) {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'run.json')) && path.basename(path.dirname(dir)) === 'runs') return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

const rootOf = (runDir) => path.dirname(path.dirname(runDir));

export function listRuns(root) {
  const runsDir = path.join(root, 'runs');
  if (!isDir(runsDir)) return [];
  return fs.readdirSync(runsDir)
    .filter((id) => fs.existsSync(path.join(runsDir, id, 'run.json')))
    .map((id) => loadRun(path.join(runsDir, id)))
    .sort((a, b) => a.state.created.localeCompare(b.state.created));
}

// Which run a command acts on: --run, else the run folder around cwd, else the newest active run
// of the elt-design/ found from --client or cwd. Returns { root, run } with either possibly null.
export function locate({ run, client, cwd = process.cwd() } = {}) {
  if (run) {
    const dir = path.resolve(run);
    if (!fs.existsSync(path.join(dir, 'run.json'))) throw new SpError('no-run', `no run.json in ${slash(dir)}`);
    return { root: rootOf(dir), run: loadRun(dir) };
  }
  if (!client) {
    const dir = runDirAbove(cwd);
    if (dir) return { root: rootOf(dir), run: loadRun(dir) };
  }
  const root = findRoot(client ?? cwd);
  if (!root) return { root: null, run: null };
  const active = listRuns(root).filter((r) => r.state.status === 'active');
  return { root, run: active.at(-1) ?? null };
}

// ---------- creating ----------

export function ensureRoot(clientDir) {
  const root = path.join(path.resolve(clientDir), ROOT_NAME);
  for (const dir of ['client/brand', 'client/inputs', 'runs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const gitignore = path.join(root, '.gitignore');
  if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, GITIGNORE);
  return root;
}

export function createRun(root, mode, now = new Date()) {
  if (!MODES.includes(mode)) throw new SpError('usage', `unknown mode "${mode}"`, { modes: MODES });
  const base = `${localDate(now)}-${mode}`;
  let id = base;
  for (let i = 2; fs.existsSync(path.join(root, 'runs', id)); i++) id = `${base}-${i}`;
  const dir = path.join(root, 'runs', id);
  for (const sub of RUN_DIRS) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  const first = PHASES[mode][0];
  const state = {
    schema: 1,
    id,
    mode,
    profile: null,
    status: 'active',
    created: now.toISOString(),
    phase: first.n,
    next: defaultNext(first),
    phases: [{ n: first.n, id: first.id, start: now.toISOString(), end: null }],
    server: null,
  };
  fs.writeFileSync(path.join(dir, 'run-log.md'), `# Run log: ${id}\n\n${TIMINGS_START}\n${TIMINGS_END}\n`);
  const run = { root, dir, state };
  saveRun(run);
  return run;
}

// ---------- reading and saving ----------

export function loadRun(dir) {
  return { root: rootOf(dir), dir, state: JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) };
}

export function saveRun(run) {
  const file = path.join(run.dir, 'run.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(run.state, null, 2) + '\n');
  fs.renameSync(tmp, file);
  writeTimings(run);
}

export const phaseDef = (run, n = run.state.phase) => PHASES[run.state.mode].find((p) => p.n === n);

// ---------- the gate ----------

// Requirements of phase `n` that are not met yet, as readable paths.
export function missing(run, n) {
  return phaseDef(run, n).requires.filter((req) => !satisfied(run, req)).map(describeRequirement);
}

function satisfied(run, req) {
  if (req.startsWith('checkpoint:')) return checkpointFilled(checkpointFile(run, req.slice('checkpoint:'.length)));
  if (req.startsWith('client/')) return exists(run.root, req);
  return exists(run.dir, req);
}

const describeRequirement = (req) =>
  req.startsWith('checkpoint:') ? `checkpoints/${req.slice('checkpoint:'.length)}.md with the operator's words` : req;

export const checkpointFile = (run, name) => path.join(run.dir, 'checkpoints', `${name}.md`);

// The "## Operator's words" section of a checkpoint file, or null when the file or section is absent.
export function operatorWords(file) {
  if (!fs.existsSync(file)) return null;
  const match = fs.readFileSync(file, 'utf8').match(/^## Operator's words[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  return match ? match[1].replace(/<!--[\s\S]*?-->/g, '').trim() : null;
}

function checkpointFilled(file) {
  const words = operatorWords(file);
  return !!words && words.replace(/^\s*>\s?/gm, '').trim().length > 0;
}

// Relative path with `*` wildcards (one folder level each) exists under `base`.
function exists(base, rel) {
  const parts = rel.split('/');
  const walk = (dir, i) => {
    if (i === parts.length) return true;
    if (!parts[i].includes('*')) {
      const next = path.join(dir, parts[i]);
      return fs.existsSync(next) && walk(next, i + 1);
    }
    const re = new RegExp('^' + parts[i].split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    return isDir(dir) && fs.readdirSync(dir).some((entry) => re.test(entry) && walk(path.join(dir, entry), i + 1));
  };
  return walk(base, 0);
}

// ---------- moving through phases ----------

// Closes the current phase and opens the next one, or refuses with the next phase's missing artifacts.
export function advance(run, now = new Date()) {
  const { state } = run;
  if (state.status === 'done') throw new SpError('done', `run ${state.id} is already finished`);
  const phases = PHASES[state.mode];
  const from = phaseDef(run);
  const to = phases[phases.indexOf(from) + 1] ?? null;
  if (to) {
    const lacking = missing(run, to.n);
    if (lacking.length) {
      throw new SpError('gate', `phase ${to.n} (${to.id}) cannot start: required artifacts are missing`, {
        phase: { n: to.n, id: to.id },
        missing: lacking,
      });
    }
  }
  const record = state.phases.at(-1);
  record.end = now.toISOString();
  if (to) {
    state.phase = to.n;
    state.phases.push({ n: to.n, id: to.id, start: now.toISOString(), end: null });
    state.next = defaultNext(to);
  } else {
    state.status = 'done';
    state.next = 'Run finished.';
  }
  saveRun(run);
  return { from: { n: from.n, id: from.id, minutes: minutes(record) }, to: to && { n: to.n, id: to.id } };
}

export function setNext(run, text) {
  run.state.next = text;
  saveRun(run);
}

const defaultNext = (def) => `Phase ${def.n} (${def.id}): read ${def.file} and follow it.`;

// ---------- describing ----------

// The shape sp start, sp status and sp log print for a run.
export function describe(run) {
  const { state } = run;
  const def = phaseDef(run);
  const phases = PHASES[state.mode];
  const upcoming = phases[phases.indexOf(def) + 1];
  const file = skillPath(def.file);
  return {
    run: slash(run.dir),
    id: state.id,
    mode: state.mode,
    profile: state.profile,
    status: state.status,
    phase: { n: def.n, id: def.id, file: slash(file), fileExists: fs.existsSync(file) },
    next: state.next,
    gate:
      state.status === 'active' && upcoming
        ? { phase: upcoming.n, id: upcoming.id, missing: missing(run, upcoming.n) }
        : null,
    server: state.server,
  };
}

// ---------- run-log.md timings ----------

function writeTimings(run) {
  const file = path.join(run.dir, 'run-log.md');
  const rows = run.state.phases.map(
    (p) => `| ${p.n} ${p.id} | ${localStamp(p.start)} | ${p.end ? localStamp(p.end) : '…'} | ${p.end ? minutes(p) : '…'} |`,
  );
  const block = [TIMINGS_START, '| Phase | Started | Ended | Minutes |', '|---|---|---|---|', ...rows, TIMINGS_END].join('\n');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `# Run log: ${run.state.id}\n\n`;
  const start = text.indexOf(TIMINGS_START);
  const end = text.indexOf(TIMINGS_END);
  const next =
    start >= 0 && end > start
      ? text.slice(0, start) + block + text.slice(end + TIMINGS_END.length)
      : text.replace(/\n*$/, '\n\n') + block + '\n';
  fs.writeFileSync(file, next);
}

const minutes = (p) => Math.round((Date.parse(p.end) - Date.parse(p.start)) / 60000);
const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localStamp = (iso) => {
  const d = new Date(iso);
  return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
