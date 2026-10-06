// The phase map of each mode and the roles agents play. This table is the checkpoint gate:
// a phase may start only when everything in its `requires` exists.
//
// `requires` entries:
//   "checkpoints/…", "variants/*/site/index.html"  path inside the run folder; `*` matches one folder level
//   "client/brief.md"                              path inside elt-design/ (shared by the client's runs)
//   "checkpoint:<name>"                            checkpoints/<name>.md with the operator's words filled in

const start = { n: 0, id: 'start', file: 'references/phases/0-start.md', requires: [] };
const intake = { n: 1, id: 'intake', file: 'references/phases/1-intake.md', requires: [] };
const retro = { n: 7, id: 'retro', file: 'references/phases/7-retro.md', requires: ['run-log.md'] };

export const PHASES = {
  prototype: [
    start,
    intake,
    { n: 2, id: 'research', file: 'references/prototype/2-research.md', requires: ['checkpoint:1-intake', 'client/brief.md'] },
    { n: 3, id: 'moodboard', file: 'references/prototype/3-moodboard.md', requires: ['checkpoint:1-intake'] },
    { n: 4, id: 'variants', file: 'references/prototype/4-variants.md', requires: ['checkpoint:2-recipes'] },
    { n: 5, id: 'review', file: 'references/prototype/5-review.md', requires: ['checkpoint:2-recipes', 'variants/*/site/index.html'] },
    { n: 6, id: 'hub', file: 'references/prototype/6-hub.md', requires: ['checkpoint:2-recipes', 'variants/*/site/index.html'] },
    retro,
  ],
  creatives: [
    start,
    intake,
    { n: 2, id: 'analysis', file: 'references/creatives/2-analysis.md', requires: ['checkpoint:1-intake', 'client/brief.md'] },
    { n: 3, id: 'moodboard', file: 'references/creatives/3-moodboard.md', requires: ['checkpoint:1-intake'] },
    { n: 4, id: 'canvas', file: 'references/creatives/4-canvas.md', requires: ['checkpoint:2-recipes'] },
    { n: 5, id: 'review', file: 'references/creatives/5-review.md', requires: ['checkpoint:2-recipes'] },
    { n: 6, id: 'export', file: 'references/creatives/6-export.md', requires: ['checkpoint:2-recipes'] },
    retro,
  ],
};

export const MODES = Object.keys(PHASES);

// Checkpoint files end the phase named here; the coordinator writes them from templates/checkpoint.md.
export const CHECKPOINTS = { '1-intake': 1, '2-recipes': 3 };

// Roles agents play in a prototype run. `dir` is the agent's work folder inside the run;
// `{name}` is the --name the coordinator gives (one agent per group of sections or per variant).
export const ROLES = {
  prototype: {
    scout: { phase: 2, dir: 'research/scout-{name}' },
    'market-demand': { phase: 2, dir: 'research/market-demand' },
    'market-competitors': { phase: 2, dir: 'research/market-competitors' },
    'market-voc': { phase: 2, dir: 'research/market-voc' },
    synth: { phase: 2, dir: 'dossier' },
    builder: { phase: 4, dir: 'variants/{name}' },
    reviewer: { phase: 5, dir: 'variants/{name}/review' },
  },
};
