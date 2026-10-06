// Every sp command ends with exactly one JSON line on stdout: the summary its caller parses.
// Failures carry a short `error` code; `gate` means a phase's required artifacts are missing.

export const EXIT = { usage: 2, gate: 3 };

export class SpError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

export function printSummary(summary) {
  process.stdout.write(JSON.stringify(summary) + '\n');
}

// Forward slashes read the same in Git Bash, PowerShell and JSON.
export const slash = (p) => (p == null ? p : String(p).replaceAll('\\', '/'));
