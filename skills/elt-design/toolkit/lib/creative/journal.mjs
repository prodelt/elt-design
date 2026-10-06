// The experiment journal of a creative run: one JSON line per iteration of build -> measure -> fix,
// so a plateau, a regression or the change that helped can be read back instead of remembered.
import fs from 'node:fs';
import path from 'node:path';

export function appendJournal(file, { hypothesis, change, metrics, decision, tags }) {
  if (!hypothesis || !change) throw new Error('a journal entry needs a hypothesis and a change');
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const entry = { at: new Date().toISOString(), hypothesis, change, metrics: metrics ?? null, decision: decision ?? null, ...(tags?.length ? { tags } : {}) };
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return entry;
}

export function readJournal(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
