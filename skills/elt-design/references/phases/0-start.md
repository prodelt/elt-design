# Phase 0: start

The machine is ready, the operator's settings exist, the run folder is created. About 5 minutes. Done when `sp status` shows phase 1 (intake).

1. **Check the machine: `sp env`.** It installs the toolkit's packages itself on the first run.
   - `"ok": false`: fix each failed check by its `hint` or `error` and run `sp env` again. Chrome missing: the operator installs Google Chrome, or sets `chromePath` in `~/.elt-design/config.json`. `grilling` missing: the operator runs `/plugin install mattpocock-skills@claude-plugins-official` and starts a new session.
   - Checks with `"level": "warn"` never block. `shell-vars` names the prefix your Git Bash calls need.
   - `config.missing` is not empty on the first run on a machine. Ask the operator for each missing answer in one message: `studio` (the studio name hubs show) and `operatorLanguage` (the language you speak with them). Write the answers into `config.file`.
2. **Settle the client folder:** the session's folder, unless the operator meant another one. Ask when the session's folder does not look like a client's (the skill's own repository, a home folder). `sp` writes only inside its `elt-design/` subfolder. When the named folder already has an active run, continue that one: `sp status --client <folder>`.
3. **Settle the mode:** `prototype` (site variants), or `creatives` when the operator asked for social media creatives.
4. **Create the run: `sp start --mode <mode>`**, adding `--client <folder>` when the client folder is not the session's folder.
   - `"error": "active-run"`: a run of this mode is already open. Continue it from `sp status`, or pass `--new` when the operator wants a fresh run.
5. **Close the phase: `sp log done`.** Then read the phase file `sp status` names.
