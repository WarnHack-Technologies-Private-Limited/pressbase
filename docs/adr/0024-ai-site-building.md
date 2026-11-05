# 0024: AI site building: pipeline, slots, operations, honest content

- **Status:** Proposed. Slots (v0.8, #38 and #39), the design generator (#54), the quality checks (#55), the site-building abilities (#56) the pipeline with its honest-content rules (#59), and the edit operations Studio applies with Keep and Undo (#57, #62) are accepted and built; the publish confirmation is pending and will be added to this record before it is accepted.
- **Date:** 2026-11-03

## Context

Studio ([plan](../plans/visual-site-builder.md)) builds sites from patterns, by hand and with AI. Three features need the same thing: a section's content separated from its design.

- **Swap layout** cycles a section through other patterns of its category and must keep its text and images.
- **Building with AI**: the model picks a pattern and writes its copy. If it wrote block markup, every answer would need validating, could contain invalid blocks, raw CSS or invented structure, and would cost more tokens. The plan's principle is "AI fills sections; code guarantees quality".
- **Honest content**: prices, opening hours, testimonials and people must come from the site owner, not the model, and what's missing must be visible and listed before publishing.

Every pattern a site has must work this way without extra effort from its author: the bundled theme's 29, the library's, and those of any WordPress block theme a person installs. Some patterns know more than can be inferred ("these rows are opening hours, one to seven of them, facts only").

WordPress has related pieces but not this one. Pattern overrides (6.5) let a synced pattern's named blocks (`metadata.name` with `core/pattern-overrides` bindings) take per-instance content, but only for blocks the author prepared, and only text and links of paragraphs, headings, buttons and images. Elementor and Wix templates bind content to their own data formats.

## Decision

### Slots (accepted)

- **Slots are found by walking the blocks**, in `@pressbase/slots`, a package of pure functions over `@pressbase/blocks`' parsed blocks (no I/O, so core and the browser share it). Headings, paragraphs, list items, details summaries, quote citations, buttons (text and URL) and images (URL, alt and a subject) become typed, ordered slots, with a role (title, eyebrow, body, action, media…) and a length limit taken from the pattern's own text. Lists, button groups, galleries and runs of alike siblings (the same blocks in the same structure: cards, columns, rows) become **repeated groups** whose items have their own slots.
- **IDs come from block names** (`metadata.name`, the same field pattern overrides use) and otherwise from roles, so they read well in a JSON schema: `title`, `body`, `actions`, `hours.day`.
- **Filling writes in place.** `fillSlots()` changes only the inner HTML of the element that holds the text, a link's `href` or an image's `src` and `alt` (and the attachment ID that goes with it), so every attribute, class and preset style stays as the pattern had it, and the result serialises as valid blocks. A group grows by copying its last item and shrinks by dropping it, within `minItems` and `maxItems`. Extract-then-fill gives back the same markup; a test holds every theme and library pattern to it.
- **Declarations override inference**: a `Slots:` header (one line of JSON) in a theme's PHP pattern, or `slots` in a library pattern's JSON, keyed by slot ID, with `label`, `description`, `role`, `maxLength`, `minItems`, `maxItems`, `subject`, `facts`, `placeholder` and `ignore`. Core serves them with the pattern as a `slots` field of `/wp/v2/block-patterns/patterns`.
- **For AI, slots become a JSON Schema** (`slotsJsonSchema()`): one property per slot, with limits and descriptions, using only the keywords core's validator and the providers' structured output support. The model writes plain text (`fillSlots(…, { format: 'text' })` escapes it). For images it writes alt text and a subject to search for, never a URL.
- **Swap layout uses `transferSlots()`**: values move by role, then by kind; what doesn't fit is returned, not dropped, so the editor can keep it and say so.
- **Placeholders are plain text in square brackets** (`[Add a customer quote]`), valid in any block and visible on the page; `facts` slots declare theirs, and `findPlaceholders()` lists every placeholder, `#` link and missing image for the checklist.
- **A pattern library ships with Pressbase** (`@pressbase/patterns`): section patterns made only of core blocks and the presets every block theme has, registered by core as `pressbase/<name>` under WordPress's category names where they exist, with rules (README) that a test enforces.

### Design generator (accepted)

- **The model chooses a direction; code chooses the colours.** The Design stage answers `DESIGN_CHOICE_SCHEMA`: a mood (seven), a hue (0–359), a contrast level, a light or dark scheme, a font pair, a corner style and a spacing density, all enums or bounded numbers. `@pressbase/design` turns it into a palette and presets. The model never writes a hex value, so it can't produce an unreadable site.
- **Palettes are built in OKLCH and checked with WCAG's formula on the final hex.** `generatePalette()` starts each colour at a lightness and chroma set by the scheme and the mood, then darkens (on dark pages, lightens) each text colour in small steps until every pair the theme draws passes AA (4.5:1 text, 3:1 large text and UI) or, at `high` contrast, AAA for text. Black and white end the search and always pass, so generation can't fail. Property tests hold thousands of random choices to it.
- **The palette uses the Pressbase theme's slugs** (`base`, `contrast`, `accent`, `accent-text`, `on-accent`…) and is saved as user global styles keyed by the `theme` origin, as a style variation is, so the theme and every pattern using its presets restyle without changes. The pairs checked are the ones the theme's own palettes are tested against.
- **Fonts are curated and local**: the theme's bundled OFL fonts and system font stacks, nothing from Google or another font service. Pairs needing theme fonts are offered only where the theme declares them.
- **Corners and density are small enums mapped to presets** (the theme's radius slugs; WordPress's spacing slugs 20–80), not free values.
- **A package of its own**, `@pressbase/design`, not part of `@pressbase/theme-json`: theme-json is a port of WordPress's engine and stays one; the generator is Pressbase's product logic with no WordPress counterpart. Pure functions, so the admin's live previews of directions use the same code as core.

### Quality checks (accepted)

- **One checker, three callers.** `checkPage(markup, styles)` runs after every generation (the pipeline's Check stage), on Studio's "Before you publish" checklist and in the evaluation suite. It's exposed as the `core/check-page` ability (so the pipeline, the CLI and outside agents call it with the same permission check) and as `POST /pressbase/v1/check-page`, because a read-only ability runs with GET and a page's markup doesn't belong in a URL.
- **Findings, not fixes**, each with the block's index path from `parse_blocks()`, so Studio can select it. Errors fail a generated page; warnings (placeholders, vague links, raw colours) are for a person.
- **Rules**: invalid or unknown blocks (delimiters, schema, `parent`/`ancestor`/`allowedBlocks`), contrast below AA following colours down the tree as CSS does, one `h1` and no skipped levels, alt text unless decorative, placeholders (the slots' rules), empty or vague link text, raw colours outside presets. Where the checker can't know (text over images or gradients) it says nothing rather than guess.
- **Decorative images are marked** with `metadata.decorative` (or `role="presentation"` / `aria-hidden`), because WordPress always saves an empty `alt` and can't tell decorative from forgotten.

### Abilities (accepted)

- **Eight abilities in core, WordPress-style names**: reads `core/get-site-brief`, `core/get-design-system`, `core/list-patterns`, `core/get-page-structure`; writes `core/create-page`, `core/update-page-sections`, `core/update-global-styles`, `core/update-template-part` (with `core/check-page` above). The AI panel's tool loop, the pipeline, the CLI and a future MCP server use the same ones. See [site abilities](../architecture/site-abilities.md).
- **Permissions as the user**: `edit_theme_options` for styles and parts; `edit_post` on a page, `edit_pages` and `publish_pages` to create one; `edit_posts` for the reads that hold nothing private (brief, presets, patterns).
- **Writes go into the user's changeset**, the open one or one named by `changeset_uuid`, started when there's none, through the changeset's entity handlers (which validate, sanitise and check each entry again). **No ability publishes.** A write needs a person (a changeset has an author), so the CLI needs `--user` for writes.
- **Sections by pattern and slots, never markup.** Page edits are the plan's operations (`insertSection`, `replaceSection`, `moveSection`, `removeSection`, `updateSlots`), each naming a registered pattern and plain-text slot values checked against the slots' schema; code renders with `fillSlots()` and records the pattern in `metadata.patternName`, as the block editor does, so a later read knows it. Replacing keeps content with `transferSlots()`, and reports what didn't fit.
- **Styles through a design direction or preset references.** `design` reuses the design generator, so colours are made by code; `styles` may hold preset references, sizes and keywords only, never raw colours, `url()` or CSS.
- **The brief is an option** (`pressbase_site_brief`), a REST setting, with the Brief stage's shape: facts are the person's, kept apart from copy.
- **Content from the site is data, not instructions**: what the reads return goes into prompts as labelled data; the abilities enforce permissions and the changeset whatever a model asks.

### Pipeline (accepted)

- **A fixed pipeline in code, not an agent**: brief → design → sitemap → pages → assemble → check. Each stage is one structured call with a JSON Schema (`asJsonResponse()`), parsed and validated as `generateJson()` does, checked again in code, and **retried once** with what was wrong; a second bad answer fails the stage (a page fails alone, the others go on). Each request is attributed to its stage (`site-builder/brief`, `/design`, `/sitemap`, `/page`) in the usage log. A five-page site is eight requests.
- **One call per page**, its sections together so the copy flows. The schema has one property per planned section, each a choice (`anyOf`) of up to four patterns of the section's category with their slots, so a valid answer always names a pattern that fits. Up to **three pages at a time**.
- **Writes through the abilities**, as the person who started the run, into one changeset: `core/update-global-styles`, `core/create-page`, `core/update-template-part`, and changeset entries for the menu, the home page and the brief. Writes are serialised, because pages finish together. Nothing publishes; pages go live with their default status when a person publishes the changeset.
- **Changesets name new posts by slug**: `wp_navigation` entries may create a menu, and `page_on_front`, `page_for_posts` and `pressbase_navigation_fallback` may hold a post's slug, resolved to its ID when published or previewed. So a generated home page and menu need no publishing first.
- **Steps the person already took are passed in** (brief, design, sitemap), and the stage makes no request: the guided flow lets them edit each before generating.
- **A run is a record and a job**: a private `pressbase_site_run` post holding the run as JSON, events included, and a `pressbase/site-builder` job that isn't retried. Progress is Server-Sent Events from `GET /pressbase/v1/site-builder/runs/{id}`, replayed from `Last-Event-ID`, so closing the tab loses nothing.
- **The daily cap stops a run cleanly**: no new request, the rest of the pages skipped, assemble and checks still done (they need no AI), status `stopped` with the tokens used. The run counts its own requests in flight against the cap.

### Honest content (accepted)

- **Facts only from the person**: the form's fields, and facts the model drew from the description only where the description supports them.
- **Enforced in code after every answer**, not just asked for: fact slots (declared, and the items and citations of sections about facts: testimonials, team, pricing, statistics, contact, hours) keep only values found in the facts; any other slot keeps its copy unless it gives a number, an email or a web address the facts don't have; `tel:`, `mailto:` and outside links must be in the facts. Otherwise the slot gets its placeholder (or the link `#`), and the run lists what it replaced.
- **The person's words are labelled data**: separate prompt parts in tags, JSON-encoded so they can't close the tag, with a system instruction never to follow instructions in them.

### Operations (accepted)

- **Ten operations, one shared package**: `insertSection`, `replaceSection`, `moveSection`, `removeSection`, `updateSlots`, `updateBlockAttributes` (presets only), `setGlobalStyles`, `updateTemplatePart`, `createPage`, `updateMenu`. Their types, JSON Schema and the checks that need only the set (shapes, presets only, safe links) are `@pressbase/site-edits`, used by core and the admin, so both refuse the same things with the same words. See [AI edits](../architecture/ai-edits.md).
- **A model proposes; core checks; Studio applies.** In Studio's AI panel (#62) the model reads through the site-building abilities and hands over a set by calling `core/propose-site-edits`, which checks it against the site as the person's changeset has it and **writes nothing**; an error names the operation, and the model may try again within the request's rounds. Core resolves what only it can make: the styles a design direction gives (the changeset entry, returned with the set).
- **Applied in the editor, as one step.** Studio plans the set against the canvas and the draft (pure, unit-tested per operation), refuses it whole if any operation doesn't fit, then puts the open page's and the header's and footer's new blocks on the canvas as **one undo step** named after the set, other and new pages and the styles into the draft, and the menu through core-data as the Navigation block edits it. Changed blocks are highlighted; **Keep** or **Undo** acts on the whole set. Nothing is written but the draft, saved as for any edit; nothing publishes.
- **Rendered as core renders**: Studio fills patterns with the same slots functions (`text` format for anything from a model), so what the person sees is what core checked.
- **A conversation per changeset**, kept in its meta (the last 40 messages, 12 sent as history, with what was kept or undone), streamed as Server-Sent Events from `POST /pressbase/v1/studio/ai/messages`. Requests that can't be done get a plain answer and no changes; the daily cap is said as such.

### Pending

- **The publish confirmation** for placeholders left (#61).
- **Custom sections** (v2): model-written markup, parsed, checked and sanitised.

## Consequences

- Any block theme's patterns can be swapped and filled by AI with no work from their authors; declarations make them better, not possible.
- The model never produces markup in the default path, so generated sections are always valid blocks with only the theme's presets, and a section costs a small JSON answer.
- Inference is a heuristic. A highlighted card with an extra block breaks the "alike" test and turns a group into separate slots; adding a block to a section shifts ordinal IDs (`body-2` becomes `body-3`). The library's rules avoid the first; Swap layout matches by role and kind, not by ID, which softens the second.
- A group shrunk to one item stays a group only for lists, buttons, galleries, columns, grids, questions and declared groups; elsewhere it becomes plain slots until it has two items again.
- Rich text is written as given in `html` format. Anything from a model or another untrusted source must use `text` format, and saved content is still sanitised by core for users without `unfiltered_html`.
- The `slots` field and `Slots:` header are Pressbase extensions; WordPress ignores both.
- Generated palettes pass AA by construction; a person can still choose any colour, and the quality checks catch what then fails.
- Saturated light hues (yellow, lime) come out darker on light pages than a brand colour might be: white button text on them needs it.
- Generated designs restyle the Pressbase theme fully. Other block themes get the presets whose slugs they share (spacing 20–80, often `base` and `contrast`); a slug mapping per theme is future work. The theme's tinted shadows aren't regenerated.
- `metadata.decorative` and `POST /pressbase/v1/check-page` are Pressbase extensions.
- Honest content is strict by words, not meaning: a fact the model rephrases becomes a placeholder for the person to fill. Safer than a site that states something untrue.
- A run's cost is predictable (one request per stage and per page, plus at most one retry each), and a run that hits the cap leaves a usable, smaller site rather than nothing.
- Changesets now create menus and take slugs for post-ID options; anything reading those options from a changeset entry must expect a slug.

- The abilities write whole entries: an AI edit and a person's edit to the same page in Studio meet in one changeset entry, and the last save wins, as for two people in Studio.
- The AI panel's edits avoid that: Studio saves the canvas before asking and applies the set to the canvas itself, so the person's latest edits and the AI's meet in one place. Undo after later edits to the same region takes those edits too (one undo away).
- Style changes from AI show on the canvas only once Studio's Styles panel draws the draft's styles (#46); until then, in Preview.
- A section's pattern is known only when its block names it (`metadata.patternName`); sections pasted or built by hand are read through inferred slots.

## Alternatives considered

- **Abilities that publish, or write the live site**: simpler for agents, but a model's mistake would reach visitors; a changeset makes every AI change reviewable and undoable as a whole.
- **Raw `styles` and `settings` passed through**: the model would write hex values and CSS, which the design generator exists to avoid.
- **The AI panel writing through the write abilities** (core applies, Studio reloads): simpler, but the change wouldn't be an undo step on the canvas, couldn't be highlighted, and would race the person's unsaved edits. Core checks; the editor applies.
- **Core returning rendered markup with each operation**: Studio would apply exactly what core rendered, but the canvas may have moved on since (an edit not yet saved), and a set made elsewhere (a command, #63) would need a round trip. Studio renders with the same slots functions instead.

- **Pattern overrides only** (WordPress's bindings): needs every pattern prepared by hand and covers no repeated groups or item counts.
- **Templates with placeholders** (`{{title}}` in markup): invalid blocks until filled, and no theme pattern has them.
- **A free-running agent with the abilities as tools** for the whole site: fewer lines of code, but an unpredictable number of requests, no per-stage retry or test, and a run that can't be resumed or shown as progress.
- **Honest content left to the prompt**: models invent plausible hours and quotes even when told not to; checking in code is cheap and testable.
- **Progress by polling only**: simpler, but the guided flow wants pages to appear as they finish; SSE with replay costs little more and polling still works (`GET` without the event-stream header).
- **The model writes block markup**, validated afterwards: more tokens, retries on invalid output, and quality depends on the model. Kept for v2's custom sections only.
- **The model picks colours (hex) and code checks them afterwards**: retries when a pair fails, and a model's sense of contrast is unreliable. Generating from a hue costs nothing and can't fail.
- **Palettes in HSL**: equal lightness in HSL isn't equal perceived lightness (yellow versus blue), so one recipe gives uneven palettes across hues.
- **Web fonts from Google Fonts or a font CDN**: a request to a third party on every page view, against the privacy of visitors; local and system fonts cost nothing.
- **Checks in the browser only (the editor's block validation)**: the pipeline runs on the server, and the checks must be the same for both.
- **A slot schema per pattern, written by hand**: precise but would leave every installed theme's patterns out; declarations give the same precision where it's wanted.
