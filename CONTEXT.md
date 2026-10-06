# ELT Design

Domain language of a skill that turns a client brief into a researched design package in one working day: website prototypes assembled from real code of reference sites. Canonical terms are English; the Ukrainian term used in planning docs follows in parentheses.

## People

**Operator** (Оператор):
The person who runs the skill, feeds it the client's materials and passes its checkpoints.
_Avoid_: user, designer

**Client** (Замовник):
The organisation or person the package is made for; sees only the finished hub.
_Avoid_: customer (reserved for the client's own customers)

## Package

**Prototype Package** (Пакет прототипу):
Everything one run hands to the client: research dossier, moodboard, variants and hub.
_Avoid_: prototype (when the whole package is meant), mockup

**Research Dossier** (Досьє дослідження):
A concise page of research conclusions (competitors, gallery benchmark, audience psychology and marketing, SEO) that explains and sells the decisions in the variants.
_Avoid_: research report

**Moodboard** (Мудборд):
A page of real references, each with a capture and a code (T for typeface, H for hero, …), from which variants or a creative series are assembled.
_Avoid_: collage, inspiration board

**Reference** (Референс):
A specific live site, demo, social media design or a fragment of one, taken as the source of a look, of code or of a writing style.
_Avoid_: inspiration, example (when the source of code is meant)

**Candidate** (Кандидат):
A site or fragment a search of the source catalog has found for a run but that nobody has chosen yet; it becomes a reference only when it goes onto the moodboard.
_Avoid_: reference (before it is chosen), result, hit

**Anti-reference** (Антиреференс):
A site or fragment the client explicitly dislikes; its traits are forbidden in every variant.
_Avoid_: bad example

**Variant** (Варіант):
One coherent site prototype in a single direction, assembled from the real code of references and adapted to the client.
_Avoid_: concept, mockup, version

**Section** (Секція):
One block of a variant page (hero, numbers, process, footer, …), belonging to one of the profile's section groups; assembled from one primary moodboard code that gives its layout, optionally with nested codes for devices inside it.
_Avoid_: block, component, module (reserved for research modules)

**Recipe** (Рецепт варіанта):
The moodboard codes one variant or one creative series is assembled from; for a variant: a typeface, a background or 3D preset, and for each section one primary code plus any nested codes. The operator approves recipes, not individual codes.
_Avoid_: combo, mix, selection

**Copy Deck** (Копідек):
The selling text of one variant in the client's language, derived from the dossier's positioning and the variant's angle; client facts come only from the client's materials, otherwise a visible placeholder.
_Avoid_: content, texts, copy (alone)

**Placeholder** (Заглушка):
A visibly marked spot in a variant where a client fact (name, number, photo, licence) is missing; never an invented fact or a stock face. The hub can list placeholders as what the client still has to provide.
_Avoid_: dummy, lorem, TBD (alone)

**Hub** (Хаб):
The page at the preview link that gathers the dossier, the moodboard and all variants for the client.
_Avoid_: portal, variants landing

**Profile** (Профіль):
A site type (corporate, services, portfolio, shop, app, …) that fixes the variant's pages or screens, reference sources, research modules and quality checklist on top of the shared run core.
_Avoid_: template, project type, category

**Creative Set** (Набір креативів):
A series of finished social media designs (stories, feed posts, carousels) with a tone of voice and writing style derived from the client's reference creatives, on a canvas both Claude and a person can edit.
_Avoid_: banners, SMM pack

**Client Design File** (Дизайн-файл замовника):
The client's own design source (a Figma file) from which a Creative Set takes its styles, elements and frames; new creatives are built from its frames, never redrawn after screenshots.
_Avoid_: export, materials (when the source file is meant)

**Reproduction** (Відтворення):
A check that a way of building creatives loses nothing: existing client creatives rebuilt that way show no difference beside the client's own export.
_Avoid_: fidelity, copy

**Archetype** (Архетип):
A recurring layout type in a client's creatives (a cover with a 3D object, a doctor portrait, a list in glass pills, …), with named slots for text, images and decor; a new creative is a copy of a real frame of one archetype with new content.
_Avoid_: template, layout (alone)

**Slot** (Слот):
One replaceable part of a real frame (a text, an image fill, a decor layer), addressed by its place in the frame's layer tree, so the same slot is found in every copy of the frame. A new text fits its slot when it takes about the room the designers' text took and keeps the padding of any plate or pill behind it.
_Avoid_: field, placeholder (that is a stand-in in a variant's code)

**Campaign Palette** (Палітра кампанії):
The colours a campaign may add to a client's style: the client's colour tokens translated through a transition table measured on their own frames, plus the colours of the campaign sketch. Every colour of a campaign creative comes from it or from the client's tokens.
_Avoid_: theme, recolour (that is the act, not the palette)

**Reconstruction** (Реконструкція):
A check of the way of choosing and filling archetypes: an existing client creative, hidden from the method, is rebuilt from its content alone and compared with the original.
_Avoid_: reproduction (that one keeps the original frame), recreation

**Blind Test** (Сліпий тест):
The acceptance check of a Creative Set: its new creatives are mixed with the client's own, and the operator or a studio designer cannot tell which are new.
_Avoid_: review, approval

**Source Catalog** (Каталог джерел):
The skill's curated list of sources of references and code (site and section galleries, demo collections, section and component libraries, code donors), each with how to access it, which profiles it serves and what role it plays in a recipe. Tools for capturing and checking are not sources and live outside it.
_Avoid_: links list, bookmarks, toolbox

## Process

**Brief** (Бриф):
The client's materials and facts as the skill has digested them; shared by every run for that client and extended at each intake.
_Avoid_: requirements, spec

**Run** (Прогін):
One execution of the skill from brief to hub for one client.
_Avoid_: session, launch

**Coordinator** (Координатор):
The agent in the operator's session that runs the skill: it talks to the operator, holds the checkpoints and dispatches the other agents.
_Avoid_: orchestrator, main agent

**Role** (Роль):
The fixed job an agent does in a run: reference scout, market researcher, dossier synthesiser, variant builder or variant reviewer.
_Avoid_: agent type, persona

**Wave** (Хвиля):
A group of agents the coordinator dispatches in parallel within one phase; the next phase waits for the whole wave.
_Avoid_: batch, round

**Assignment** (Доручення):
The written task one agent receives during a run: its role, inputs, outputs, the standing rules, when it counts as done and how to report.
_Avoid_: brief, ticket, prompt

**Checkpoint** (Контрольна точка):
A moment where the skill stops for the operator's decision; every run has two, in both modes: after intake and after the moodboard.

**Polish** (Полірування):
A separate mode of the skill: one round of changes to an existing Prototype Package after the client has seen the hub: fixes to its variants and new variants from the same moodboard. Work that needs new references is a new run.
_Avoid_: rework, fixes

**Run Log** (Журнал прогону):
The record a run keeps of phase timings, verbatim operator and client feedback, and what was rejected or praised.

**Retro** (Ретро):
The last phase of a run, where the skill proposes concrete changes to itself from the run log for the operator to approve.
_Avoid_: post-mortem, review

## Relationships

- A **Run** produces one **Prototype Package** or one **Creative Set** for one **Client**; a prototype run has one primary **Profile** that may borrow modules from other profiles.
- Every **Run** keeps a **Run Log** and ends with a **Retro**; approved retro changes update the skill, including its **Profiles** and **Source Catalog**.
- Searching the **Source Catalog** yields **Candidates**; those chosen onto the **Moodboard** become **References**.
- A **Moodboard** consists of **References**; every **Variant** is assembled from references on the moodboard and avoids every **Anti-reference**.
- Every **Variant** has one **Recipe** and one **Copy Deck**; the operator approves the recipes at the second **Checkpoint**, before any variant is built.
- A **Variant** consists of **Sections**; every section's codes come from its **Recipe**, and every missing client fact in it is a **Placeholder**.
- A **Hub** holds the **Research Dossier**, the **Moodboard** and 3–5 **Variants** (3 by default).
- **Polish** changes an existing **Prototype Package** (fixes and new variants from its moodboard); it does not start a new **Run**. Anything that needs new **References** is a new **Run**.
- The **Coordinator** dispatches **Waves** of agents; each agent gets one **Assignment** that names one **Role**.
- A **Creative Set** is built from the **Client Design File** when the client has one; its way of building passes **Reproduction** and **Reconstruction**, and the set itself passes a **Blind Test**.
- For a **Creative Set**, the **Moodboard** is the catalogue of the client's **Archetypes**, and each creative's **Recipe** names one archetype.
- A **Client** may have several **Runs** (for example a Prototype Package and a Creative Set); they share one **Brief**.
