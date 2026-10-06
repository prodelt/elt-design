# Building a creative in Figma

A new story or post is built in Figma from the client's own design file and rendered by Figma itself, in one of two ways:
- **compose** (the default; the operator asked for it: «не копії існуючих а пробувати збирати по своєму дотримувавшись чітких правил та використовуючи наявні в фігмі елементи»): a new layout assembled from the client's elements (background, logo, glass cards, pills, text styles, photos, campaign stickers) by the layout rules measured on their corpus. See "Compose" below.
- **make**: a copy of one real frame with new texts, photos and colours, for when the content fits a frame of theirs exactly (and for Reconstruction tests).

Nothing is drawn from scratch: glass, gradients, effects and type always come from the designers' nodes, so only content and composition can go wrong, and the checks below catch it. Flags and the spec formats: `sp figma --help`.

Needs: Figma Desktop with the client's frames pasted into a file the operator has open (their free Starter drafts are enough), and the Desktop Bridge plugin running in that file.

## Steps

1. **Bridge: `sp figma up --io <run folder>/figma-io`.** Done when `ready` is true. Otherwise follow `hint`: the operator opens the plugin (Plugins > Development > Figma Desktop Bridge), or you install `figma-console-mcp` with the command in the hint.
2. **Reproduction, once per client file.** For 2–3 frames that have the designers' own PNG: `sp figma png "<frame>" --out <file> --theirs <their.png>`. Done when each gives SSIM ≥ 0.99 and `changed` ≈ 0. Lower means the file in Figma is not the one they exported (missing photos or fonts): stop and tell the operator what differs, since every creative built on it would carry the difference.
3. **Reference.** Pick the frame whose layout fits the content: its archetype, its number of text blocks, its photo or none. Frames set aside for a blind or reconstruction test stay untouched.
4. **Slots: `sp figma slots "<frame>" --out slots.json`.** Read every text slot's `chars`, `runs`, `font`, `size` and `box`: the new text should have about the same length and number of lines.
5. **Spec** (a JSON file next to its outputs): `texts` by slot key, `images`, `recolor: "palette"` with `palette`, `hide`, `insert`. A slot with several `runs` takes an array, one string per run, so each run keeps its style.
6. **Make: `sp figma make <spec.json> --model <style model> [--palette <palette.json>]`.**
7. **Loop** on steps 5–6 until the creative is **clean**: `warnings` is empty, `lint.pass` is true, and you have looked at the PNG beside the reference frame's PNG and see nothing a designer would redo. Each run replaces its own frame in Figma, so iterate freely.

## Reference

**Slot keys** are child index paths inside the frame (`"6.1.0"`). Ids change when a frame is copied; keys do not, so a key from `slots` addresses the same node in every copy.

**Where things land.** New frames go to the page `site-proto` of the open file, one row, never onto the client's own frames. `<spec>.png` is Figma's render at the frame's size, `<spec>.scene.json` the scene graph the lint reads.

**Warnings** of `make`, each a thing a designer would see:
- `text fills N% of the height the reference text took`: the slot was sized for more text (a half-empty card). Write more, or pick a frame with a smaller slot.
- `glyphs come N px from the edge of the shape behind them`: a marker plate or pill was cut to the designers' lines; the new line lost its padding or runs past the edge. Match the reference line's length.
- `text needs N px more than its box`: a fixed box overflows.
- `Figma does not render this text`: a glyph or font is missing even after make set the fonts again (a variable font such as Exo can stop rendering after an edit; make repairs that case itself).

Make also keeps a text the designers centred vertically in its card centred, and keeps auto-width titles on the axis the designers set (frame centre, own centre or right edge).

**Palette.** A campaign colour comes from data only: `map` translates the client's colour tokens (the transition table measured from the client's own frames), `extra` lists the colours of the campaign sketch. make and compose also move each near shade of a mapped token (within the lint's radius, 5 dE2000) with it, keeping its offset in CIELAB (`lib/creative/palette.mjs`); pure white and black stay. With `--palette` the lint checks against the table actually applied and fails a client colour left untranslated (`color.unmapped`). `recolorAt` recolours one part only, e.g. a light background variant: the field to `#FEF3F8`, its title to burgundy.

**Photos** come as `hash:<imageHash>` of an image already in the file (the operator pastes new photos into the file; read a photo's hash from its node, and its bytes with `figma.getImageByHash(h).getBytesAsync()` for a preview: exporting a 4096 px photo node is slow) or as a local file. `{ "src": …, "mode": "FILL" }` drops the crop fitted to the old picture.

**Stickers** (`insert` from the campaign sketch): 1–2 per frame, in the free zone of the photo or a shape's empty bump, never over live text, turned ±5–10° like the designers' tilted pills. A sticker with live text inside (a calendar) keeps that text at the corpus's smallest size or above: the lint reports `text.size` otherwise.

**Timing.** Building takes 0.1–1.2 s, a PNG 0.5–2 s; the first render of a new frame can take 10 s or more, and `make` waits for it. While the file's tab is not the active one in Figma, a PNG takes minutes: ask the operator to keep that tab in front. One plugin call is capped at 30 s: split long work into several `sp figma` calls.

## Compose: a new layout from the client's elements

When no frame's layout fits the content, or the operator asks for new compositions, `sp figma compose <spec.json> --model <style model> [--palette <palette.json>]` builds an empty frame and fills it with clones of the client's own elements: background (a frame's fills and layers), logo, cards and pills (shapes, resized), texts (text nodes as type styles, new characters), photos, stickers. Nothing else is drawn. Spec format: `sp figma --help`.

1. **Elements.** Run `slots` on 3–5 frames close to the content; pick by key: a background frame that suits the content, the logo in the colour for that background, text styles whose colour reads on it, a card or pill shape with its text style. Dark text on a light background, white on a saturated one, as in the frames they come from.
2. **Blocks** in reading order: `text`, `card`, `pills`, `image`, `sticker`, `space` (room for an Instagram widget), `layer` (decoration where it sat in its frame). The layout rules place them: content width 820, the corpus's gaps (title–text 50, text–card 69, card–card 43, pill–pill 31), card padding 45 / 28 / 31, logo centred at y 142, the stack centred in the zone below the logo down to y 1732. A spec's `rules` takes a client's own measurements.
3. **Loop** as with make until `warnings` is empty, the lint is clean and the PNG reads as the designers' work. Warnings: the stack outgrows the zone (shorten or drop a block), a title still past 3 lines after two 8 % steps down, a sticker over text.

Pills take the padding the designers gave that text on that shape in their frame; a pill they turned is set straight and can be turned back with `tilt`. A group used as a shape keeps its own effects (a card's drop shadow); its largest shape is resized, its texts dropped.

## A campaign series

1. **Brief file** in the run folder (`<client>/site-proto/<campaign>/brief.md`): the operator's texts verbatim with their numbering, the photo map (who is on which photo, with hashes), sticker ids, the operator's instructions verbatim. Placeholders the operator left (`Х`, prices, dates, a name) stay visible in the creatives.
2. **One series, one look:** the same background, logo, type styles and photo treatment across its stories. Variants differ in one factor (e.g. bright vs light field), side by side.
3. **Instagram widgets** (poll, question box, link) are added in Instagram: keep an empty `space` block for them, with no visible guide.
4. **Parallel agents** may compose different series at once through the one plugin: give each its own rows on the page and its own frame-name prefix, run one export at a time per agent, and keep Figma's connected file tab in front (a PNG from a background tab takes minutes and stalls agents).
5. **Present in Figma:** move the finished frames into a section named for what is new, one labelled row per series; earlier drafts go to a separate section. compose and make replace a frame by name only among the page's direct children: build and fix first, move into sections last.

Known gap: compose places a rotated or flipped `layer` away from where it sat in its frame; pin it with the `x`/`y` of its origin in the source frame until this is fixed.
