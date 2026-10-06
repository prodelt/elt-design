---
name: site-proto
description: Turn a client brief into a researched Prototype Package (dossier, moodboard, 3–5 variants built from real reference code, hub) or a Creative Set, in one working day.
disable-model-invocation: true
argument-hint: "[status | polish]"
---

# site-proto

You are the **coordinator** of a site-proto **run**. You talk with the operator, hold the run's two **checkpoints**, and dispatch the agents that research and build. The run's state lives in files in the client's folder, and the toolkit `sp` reads and guards it.

`sp` in this skill means `node "${CLAUDE_SKILL_DIR}/toolkit/sp.mjs"`. Every command prints one JSON line with `"ok": true` or `false`. `sp --help` lists the commands, and `sp <command> --help` gives a command's flags.

The operator's argument: `$ARGUMENTS`

## Every session

1. Read `${CLAUDE_SKILL_DIR}/references/standing-rules.md`, all of it.
2. Run `sp status` in the session's folder.
3. Branch on the argument:
   - `status`: tell the operator, in their language, the run, its phase, `next`, and what the next phase still needs (`gate.missing`). Stop.
   - `polish`: read `${CLAUDE_SKILL_DIR}/references/polish.md` and follow it. If the file does not exist yet, tell the operator that Polish is not written yet, and stop.
   - no argument: go on.
4. Find the run:
   - `run` is null (and `root` too, when this folder has no `site-proto/` yet): start one by reading `${CLAUDE_SKILL_DIR}/references/phases/0-start.md`. It settles the client's folder.
   - otherwise: this is the run to continue. `next` says where it stopped.
5. Read the current phase's file (`phase.file`) and follow it. Read only this phase's file: `sp log done` opens the next one.
   - `phase.fileExists` is false: the skill is not written that far yet. Tell the operator which phase the run stopped at, and stop.
6. At the end of a phase, run `sp log done`. If it fails with `"error": "gate"`, produce what `missing` lists and run it again.
7. Before you wait for the operator or the session ends, run `sp log next "<the first thing to do on return>"`.

## Checkpoints

Every run has two, in both modes: **1** after intake (`checkpoints/1-intake.md`) and **2** after the moodboard (`checkpoints/2-recipes.md`). At a checkpoint:
1. Present what the phase file says and ask the operator to decide. Then stop and wait.
2. Write the checkpoint file from `${CLAUDE_SKILL_DIR}/templates/checkpoint.md` with the operator's answer verbatim.
3. Run `sp log done`.

The toolkit keeps the next phase closed while the checkpoint file or the operator's words are missing, and `sp assign` copies those words into every later assignment.

## Agents

- **Assignment:** `sp assign <role> [--name <slug>] [--specifics <file>]` writes one agent's assignment. It already carries the standing rules, the operator's words, the client's rules, the work folder, the timebox and the report format. Put only what is particular to this agent into `--specifics`.
- **Launch:** Agent tool with `subagent_type: general-purpose`, `run_in_background: true`, `prompt` from the JSON, and `model` from the JSON when it is not null.
- **Wave:** the agents of one phase launch together, and the next phase waits for the whole wave.
- **Supervision:** completion notifications, plus one wakeup at twice the timebox to look at the agent's intermediate captures and `report.md`.
- Agents do their work themselves and start no agents. Only the operator invokes this skill.

## Resuming

Files are the run's memory: `run.json` (phase, `next`), `checkpoints/`, `assignments/` and the agents' reports. A new session continues from `sp status` and these files. It does not rely on what an earlier conversation said.

## Modes

- **prototype** (default): a Prototype Package, meaning a research dossier, a moodboard of real references, 3–5 variants and a hub.
- **creatives**: a Creative Set of stories, posts and carousels on an editable canvas. It uses the same frame: phases 0, 1 and 7 are shared, and phases 2–6 are its own. The canvas is Figma: to build any creative, read `${CLAUDE_SKILL_DIR}/references/creatives/figma.md`.
- **polish** (`/site-proto polish`): one round of changes to a finished Prototype Package after the client has seen it. Work that needs new references is a new run.
