# Standing rules

The operator's rules for every run. The coordinator reads this whole file at the start of each session. `sp assign` copies the "Every agent" section verbatim into each assignment. Only the Retro changes this file, with the operator's approval.

## Every agent

1. **Show first, build later.** Variants and creatives are built only from the recipes the operator approved at checkpoint 2. Before that, a run researches, captures and assembles the moodboard.
2. **Real references, real code, real numbers.** Every visual decision traces to a live reference: its measured computed styles, authored CSS, font files and motion timings, or source code ported from it. Record each one in `SOURCES.md`: what was taken, and from where. Minified bundles are read for numbers, not copied.
3. **Any source, provenance recorded.** Take references and code from any site, gallery, library or industry, whatever its licence. Record only where each came from. Restrictions come from the operator's words and this file alone. Add none of your own.
4. **Free and open source first.** Use free tools and sources. Images and video come from the operator through Google Flow.
5. **Client facts come from the client's materials only.** A missing fact (name, number, photo, licence, testimonial) becomes a visible `.tbd` placeholder, never an invented one. Photos of people come only from the client.
6. **One site language.** Everything the client will see is in the site's language, named in the brief. Reports and working notes are in English.
7. **See it before you call it done.** Look at your result in a real browser at 1440 and 390 px through `sp` captures before reporting. A 390 px layout and live WebGL are mandatory.
8. **Your folder is yours.** Write only inside your work folder and read anything in the run. Client originals and `client/inputs/` are read-only. Git belongs to the coordinator.
9. **Use the toolkit.** Capture, measure and check with `sp` commands. Use agent-browser for interactive steps. When the toolkit lacks something, do that step by hand once and name the gap in your report.
10. **Design-taste skills** (design-taste-frontend, high-end-visual-design and the like) load only in builder agents, next to the reference measurements.
11. **Shell on Windows.** In Git Bash, prefix commands with `MSYS_NO_PATHCONV=1 PYTHONIOENCODING=utf-8`. Open pages over HTTP (`sp serve`): `file://` breaks ES modules and WebGL.

## Coordinator

1. **Languages.** Talk with the operator in their language (`operator.language` in `sp status`). The package speaks the client's language. Skill files, scripts and assignments are in English.
2. **The operator's decisions stand as given.** Record them verbatim and act on them without re-arguing. A rule the operator lifted stays lifted, for you and for every agent.
3. **The client's folder.** Runs live in `<client folder>/elt-design/`. Client originals stay untouched: working copies go to `client/inputs/`.
4. **Git only on request.** Commit in the client's folder or the skill's repository only when the operator asks. The Retro commits skill changes the operator approved.
5. **Nothing client-specific enters the skill.** The skill's repository holds no client data, absolute paths or secrets, so it can be published as it is.
6. **One working day.** A prototype run takes about 4.5 hours of pipeline time plus the operator's two checkpoints. Each phase file gives its timebox.
