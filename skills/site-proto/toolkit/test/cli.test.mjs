// The run lifecycle through the sp command line, in a throw-away client folder and operator home.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SP = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'sp.mjs');

let home, client;

function sp(args, { cwd = client, input } = {}) {
  const result = spawnSync(process.execPath, [SP, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...process.env, SITE_PROTO_HOME: home },
  });
  const lines = result.stdout.trim().split('\n');
  return { code: result.status, json: JSON.parse(lines.at(-1)), stderr: result.stderr };
}

const passEnv = () =>
  fs.writeFileSync(path.join(home, 'env.json'), JSON.stringify({ ok: true, checked: new Date().toISOString() }));

before(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-test-'));
  home = path.join(base, 'home');
  client = path.join(base, 'Acme');
  fs.mkdirSync(home);
  fs.mkdirSync(client);
});

after(() => fs.rmSync(path.dirname(home), { recursive: true, force: true }));

describe('a prototype run', () => {
  let runDir;

  test('status outside any site-proto/ reports no root', () => {
    const { code, json } = sp(['status']);
    assert.equal(code, 0);
    assert.equal(json.root, null);
    assert.equal(json.run, null);
  });

  test('start refuses without a passing sp env', () => {
    const { code, json } = sp(['start']);
    assert.equal(code, 1);
    assert.equal(json.error, 'env');
  });

  test('start creates site-proto/ and a run at phase 0', () => {
    passEnv();
    const { code, json } = sp(['start']);
    assert.equal(code, 0, JSON.stringify(json));
    runDir = json.run;
    assert.match(json.id, /^\d{4}-\d{2}-\d{2}-prototype$/);
    assert.equal(json.phase.n, 0);
    assert.equal(json.phase.fileExists, true);
    const root = path.join(client, 'site-proto');
    for (const p of ['.gitignore', 'client/brand', 'client/inputs', 'runs']) assert.ok(fs.existsSync(path.join(root, p)), p);
    for (const p of ['run.json', 'run-log.md', 'checkpoints', 'assignments', 'variants']) assert.ok(fs.existsSync(path.join(runDir, p)), p);
  });

  test('start refuses a second active run of the same mode unless --new', () => {
    assert.equal(sp(['start']).json.error, 'active-run');
    const second = sp(['start', '--new']);
    assert.equal(second.code, 0);
    assert.match(second.json.id, /-prototype-2$/);
    fs.rmSync(second.json.run, { recursive: true });
  });

  test('status finds the run from the client folder and from inside the run', () => {
    assert.equal(sp(['status']).json.run, runDir);
    assert.equal(sp(['status'], { cwd: path.join(runDir, 'variants') }).json.run, runDir);
    assert.deepEqual(sp(['status']).json.gate, { phase: 1, id: 'intake', missing: [] });
  });

  test('log done moves to intake and writes the timings', () => {
    const { code, json } = sp(['log', 'done']);
    assert.equal(code, 0);
    assert.deepEqual(json.to, { n: 1, id: 'intake' });
    assert.equal(json.phase.n, 1);
    const log = fs.readFileSync(path.join(runDir, 'run-log.md'), 'utf8');
    assert.match(log, /\| 0 start \| .+ \| .+ \| \d+ \|/);
    assert.match(log, /\| 1 intake \| .+ \| … \| … \|/);
  });

  test('the gate keeps research closed until checkpoint 1 has the operator\'s words and the brief exists', () => {
    let { code, json } = sp(['log', 'done']);
    assert.equal(code, 3);
    assert.equal(json.error, 'gate');
    assert.deepEqual(json.missing, ["checkpoints/1-intake.md with the operator's words", 'client/brief.md']);

    const template = fs.readFileSync(path.join(path.dirname(SP), '..', 'templates', 'checkpoint.md'), 'utf8');
    fs.writeFileSync(path.join(runDir, 'checkpoints', '1-intake.md'), template);
    fs.writeFileSync(path.join(client, 'site-proto', 'client', 'brief.md'), '# Brief\n');
    assert.equal(sp(['log', 'done']).json.error, 'gate', 'an empty template does not pass');

    const filled = template.replace(/(## Operator's words\n\n)<!--[\s\S]*?-->/, '$1> Так, беремо профіль 2. Без синього.');
    fs.writeFileSync(path.join(runDir, 'checkpoints', '1-intake.md'), filled);
    ({ code, json } = sp(['log', 'done']));
    assert.equal(code, 0, JSON.stringify(json));
    assert.equal(json.phase.id, 'research');
  });

  test('a phase-4 role is refused before checkpoint 2', () => {
    const { code, json } = sp(['assign', 'builder', '--name', 'a-bold']);
    assert.equal(code, 3);
    assert.deepEqual(json.missing, ["checkpoints/2-recipes.md with the operator's words"]);
  });

  test('assign writes the assignment with standing rules, operator words and specifics', () => {
    const { code, json } = sp(['assign', 'market-voc', '--timebox', '40', '--specifics', '-'], {
      input: 'Focus on reviews of installers in Kyiv.',
    });
    assert.equal(code, 0, JSON.stringify(json));
    assert.equal(json.workdir, `${runDir}/research/market-voc`);
    assert.ok(fs.existsSync(json.workdir));
    assert.match(json.prompt, /role market-voc/);
    const text = fs.readFileSync(json.assignment, 'utf8');
    assert.match(text, /## Every agent|Show first, build later/);
    assert.match(text, /> Так, беремо профіль 2\. Без синього\./);
    assert.match(text, /Focus on reviews of installers in Kyiv\./);
    assert.match(text, /40 min, until \d{2}:\d{2}/);
    assert.doesNotMatch(text, /\{\{\w+\}\}/, 'every placeholder is filled');
  });

  test('assign asks for --name where a role has several agents, and rejects unknown roles', () => {
    assert.equal(sp(['assign', 'scout']).json.error, 'usage');
    const unknown = sp(['assign', 'painter']);
    assert.equal(unknown.json.error, 'usage');
    assert.ok(unknown.json.roles.includes('synth'));
  });

  test('client rules reach the assignment as text', () => {
    fs.writeFileSync(path.join(client, 'site-proto', 'client', 'rules.json'), JSON.stringify({ rules: [{ text: 'No blue.' }] }));
    const { json } = sp(['assign', 'scout', '--name', 'heroes']);
    assert.match(fs.readFileSync(json.assignment, 'utf8'), /^- No blue\.$/m);
  });

  test('log next sets the resume pointer', () => {
    sp(['log', 'next', 'Wait for the scouts, then launch synth.']);
    assert.equal(sp(['status']).json.next, 'Wait for the scouts, then launch synth.');
  });

  test('serve starts one detached server per run, answers, and stops', async () => {
    const first = sp(['serve']);
    assert.equal(first.code, 0, JSON.stringify(first.json));
    try {
      assert.equal(first.json.reused, false);
      const res = await fetch(first.json.server.url + 'variants', { redirect: 'manual' });
      assert.equal(res.status, 301);
      assert.equal(res.headers.get('location'), '/variants/');
      assert.equal(sp(['serve']).json.reused, true);
      assert.equal(sp(['status']).json.server.alive, true);
    } finally {
      assert.equal(sp(['serve', '--stop']).json.stopped, true);
    }
  });

  test('unknown commands and flags fail as usage errors', () => {
    assert.equal(sp(['frobnicate']).code, 2);
    assert.equal(sp(['status', '--bogus']).json.error, 'usage');
  });
});
