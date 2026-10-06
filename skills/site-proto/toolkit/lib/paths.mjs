// Where things live: the skill's own files, the operator's ~/.site-proto/, and a client's site-proto/ folder.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOLKIT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SKILL_DIR = path.dirname(TOOLKIT_DIR);
export const SP_SCRIPT = path.join(TOOLKIT_DIR, 'sp.mjs');
export const skillPath = (...parts) => path.join(SKILL_DIR, ...parts);

// SITE_PROTO_HOME overrides the operator folder (tests, a second operator profile).
export const homeDir = () => process.env.SITE_PROTO_HOME || path.join(os.homedir(), '.site-proto');
export const homePath = (...parts) => path.join(homeDir(), ...parts);

export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// agent-browser's native binary from the toolkit's packages (Windows on ARM runs the x64 build).
export function agentBrowserBin() {
  const win = process.platform === 'win32';
  const arch = win && os.arch() === 'arm64' ? 'x64' : os.arch();
  return path.join(TOOLKIT_DIR, 'node_modules', 'agent-browser', 'bin', `agent-browser-${process.platform}-${arch}${win ? '.exe' : ''}`);
}

// The folder sp start creates inside the client's folder.
export const ROOT_NAME = 'site-proto';
