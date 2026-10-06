// The operator's settings in ~/.elt-design/config.json, merged over defaults.
import fs from 'node:fs';
import { homeDir, homePath } from './paths.mjs';

const DEFAULTS = {
  studio: null, // studio name shown on hubs, e.g. "ELT Studio"
  operatorLanguage: null, // language the skill speaks with the operator, e.g. "uk"
  chromeLimit: 3, // Chromes sp may run at once on this machine
  chromePath: null, // Chrome binary when the system Chrome is missing
};

// Asked from the operator on the first run; null until answered.
const ASK = ['studio', 'operatorLanguage'];

export function loadConfig() {
  const file = homePath('config.json');
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return { ...DEFAULTS, ...saved };
}

// Creates ~/.elt-design/ with a default config on the first run; reports which answers are still missing.
export function ensureHome() {
  const file = homePath('config.json');
  const created = !fs.existsSync(file);
  for (const dir of ['brand', 'cache', 'locks']) fs.mkdirSync(homePath(dir), { recursive: true });
  if (created) fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + '\n');
  const config = loadConfig();
  return { dir: homeDir(), config: file, created, missing: ASK.filter((key) => !config[key]) };
}
