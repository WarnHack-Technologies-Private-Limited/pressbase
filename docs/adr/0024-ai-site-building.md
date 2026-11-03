# 0024: AI site building: pipeline, slots, operations, honest content

- **Status:** Proposed. The slots part is accepted and built (v0.8, #38 and #39); the pipeline, operations and the enforcement of honest content are pending and will be added to this record before it is accepted.
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

### Pending

- **The pipeline**: brief, design, sitemap, page and check stages as structured calls, run as a job, with progress over Server-Sent Events.
- **Operations**: the edit set (`insertSection`, `replaceSection`, `updateSlots`…) the AI panel applies through the editor's stores, with Keep and Undo.
- **Honest content enforcement**: the brief's facts versus written copy, the checks after generation, and the publish confirmation.
- **Custom sections** (v2): model-written markup, parsed, checked and sanitised.

## Consequences

- Any block theme's patterns can be swapped and filled by AI with no work from their authors; declarations make them better, not possible.
- The model never produces markup in the default path, so generated sections are always valid blocks with only the theme's presets, and a section costs a small JSON answer.
- Inference is a heuristic. A highlighted card with an extra block breaks the "alike" test and turns a group into separate slots; adding a block to a section shifts ordinal IDs (`body-2` becomes `body-3`). The library's rules avoid the first; Swap layout matches by role and kind, not by ID, which softens the second.
- A group shrunk to one item stays a group only for lists, buttons, galleries, columns, grids, questions and declared groups; elsewhere it becomes plain slots until it has two items again.
- Rich text is written as given in `html` format. Anything from a model or another untrusted source must use `text` format, and saved content is still sanitised by core for users without `unfiltered_html`.
- The `slots` field and `Slots:` header are Pressbase extensions; WordPress ignores both.

## Alternatives considered

- **Pattern overrides only** (WordPress's bindings): needs every pattern prepared by hand and covers no repeated groups or item counts.
- **Templates with placeholders** (`{{title}}` in markup): invalid blocks until filled, and no theme pattern has them.
- **The model writes block markup**, validated afterwards: more tokens, retries on invalid output, and quality depends on the model. Kept for v2's custom sections only.
- **A slot schema per pattern, written by hand**: precise but would leave every installed theme's patterns out; declarations give the same precision where it's wanted.
