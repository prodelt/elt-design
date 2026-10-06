# site-proto

A Claude Code skill that turns a client brief into a researched design package in one working day:

- **Prototype Package**: a research dossier, a moodboard of real reference sites, 3–5 website variants assembled from the real code of those references, and a hub page that presents them;
- **Creative Set**: stories, posts and carousels on a canvas both Claude and a person can edit.

Status: v1 under construction. The frame works (runs, phases, checkpoint gates, agent assignments); most phases are still being written.

## Requirements

- Claude Code
- Node.js 20 or newer, Google Chrome
- The `grilling` skill from [mattpocock-skills](https://github.com/mattpocock/skills), installed as a plugin or as a linked skill

## Install

Clone this repository and link the skill folder into your personal skills:

```powershell
# Windows (PowerShell)
New-Item -ItemType Junction -Path "$HOME\.claude\skills\site-proto" -Target "<clone>\skills\site-proto"
```

```sh
# macOS, Linux
ln -s "<clone>/skills/site-proto" ~/.claude/skills/site-proto
```

The first run installs the toolkit's npm packages and asks for your studio name and language.

## Use

Open Claude Code in a client's folder, then run:

- `/site-proto` to start a run or continue the open one;
- `/site-proto status` to see where the run is;
- `/site-proto polish` for one round of changes after the client has seen the hub.

Everything the skill writes goes into `site-proto/` inside the client's folder. The client's own files stay untouched.

## Layout

```
.claude-plugin/plugin.json
skills/site-proto/
  SKILL.md          the coordinator's router
  references/       standing rules, one file per phase, agent roles
  templates/        assignment, checkpoint (hub, moodboard, dossier, variant to come)
  toolkit/          sp, the command-line toolkit (Node): sp --help
CONTEXT.md          the domain language
docs/adr/           architecture decisions
```

The toolkit's tests: `npm test` in `skills/site-proto/toolkit/`.

## License

MIT
