# Patterns and slots

Patterns are sections of block markup that people insert and Studio builds pages from. This page covers where they come from, how core registers them, and **slots**: a pattern's editable content as typed values, which Swap layout and building with AI work on. The decision behind slots is [ADR 0024](../adr/0024-ai-site-building.md); the product plan is [the visual site builder](../plans/visual-site-builder.md#slots).

| Part | Where | What it does |
| --- | --- | --- |
| Pattern registry | `apps/core/src/blocks/service.ts` (`kernel.blocks`) | `registerBlockPattern()`, `registerBlockPatternCategory()`, as WordPress's `WP_Block_Patterns_Registry`. See [Blocks](blocks.md#patterns). |
| Theme patterns | `apps/core/src/themes/php-patterns.ts` | A block theme's `patterns/*.php`, interpreted, never run. See [Themes](themes.md#patterns-in-php-files). |
| Pattern library | `packages/patterns` (`@pressbase/patterns`) | Pressbase's own section patterns, for any block theme. |
| Slots | `packages/slots` (`@pressbase/slots`) | `extractSlots()`, `fillSlots()`, `transferSlots()`, `slotsJsonSchema()`. Pure functions, for core and the browser. |

## Where patterns come from

Core registers, in this order:

1. **WordPress's pattern categories** and six small built-in patterns (`apps/core/src/blocks/patterns.ts`).
2. **The pattern library**: every pattern in `packages/patterns/src/patterns/`, as `pressbase/<file name>` with `source: 'core'`, and the library's section categories WordPress doesn't have (`features`, `pricing`, `faq`, `opening-hours`). The others use WordPress's names (`banner` for heroes, `about`, `services`, `testimonials`, `team`, `gallery`, `contact`, `call-to-action`, `header`, `footer`), so library, theme and plugin patterns of one kind sit together.
3. **The active theme's patterns** (`_register_theme_block_patterns()`), when the theme loads, and again on every switch.
4. **Plugins'**, through `api.blocks.registerBlockPattern()`.

All of them are served by `GET /wp/v2/block-patterns/patterns` and `/categories` to anyone who can edit posts.

### The library

Each library pattern is two files: `<name>.html`, the markup exactly as the block editor's Code editor shows it, and `<name>.json`, its title, description, categories (the first is the section's), keywords, viewport width and declared slots. The library is read from disk once, on first use, like WordPress 6.5 loads a pattern's `filePath` lazily. The files sit under `src/`, so the Docker image (which copies `packages/*/src`) includes them; there's no build step.

The rules every library pattern follows (theme presets only, core blocks only, one heading level at the start, real alt text, mobile, no JavaScript, honest sample text, alike repeated items) are in the [package README](../../packages/patterns/README.md). `checkPattern()` checks them: `packages/patterns/src/patterns.test.ts` and `apps/core/src/pattern-library.test.ts` fail any pattern that uses a raw colour or size, a non-core block, a script, a theme's class or a skipped heading level. Library names must not clash with the Pressbase theme's (`pressbase/hero-gradient`…) or core's built-ins (`pressbase/hero`…), and a test checks that too.

Issues #40–#43 add about forty patterns, and all 42 are in: hero, about and call to action (#40); features, services and gallery (#41); pricing, testimonials, team and questions and answers (#42); contact, opening hours, headers and footers (#43). Every section has two to four layouts; the [package README](../../packages/patterns/README.md#catalogue) lists them with screenshots. Headers and footers declare `blockTypes` (`core/template-part/header` or `/footer`), as WordPress's `Block Types` header does: they're served as `block_types`, offered for their template part (`core/update-template-part` rebuilds the site's header or footer from one), and kept out of Studio's Sections panel and the site builder's page sections. They're built from the site's own blocks (Site Title, Site Tagline, Site Logo, and a Navigation block without a `ref`, which shows the site's menu). Layouts of one section share slot shapes (`eyebrow`, `title`, `body`, `actions`, `image`, repeated items), so Swap layout carries content between them; `pattern-library.test.ts` checks every pair, and checks every pattern against the quality checks in the Pressbase theme's default and Midnight styles, and again with its placeholders filled in, when it must pass every check, the checklist's included.

Library patterns may use the Pressbase theme's own colour, font size and radius presets besides the portable ones (`PRESSBASE_PRESETS`): every generated design restyles those slugs, and other themes ignore them.

### Images

The library ships no image files. A pattern's image is an Image block (or a Gallery of them) with no `url`, an aspect ratio, and alt text that says what it should show, plus a declared `subject` for image search. In the editor it's the block's placeholder; `findPlaceholders()` and `checkPage()` report it as "Choose an image"; on the public site it renders as nothing until one is chosen, as WordPress's `render_block_core_image()` does (`apps/core/src/blocks/library/media.ts`). The same file ports the Gallery's `--wp--style--unstable-gallery-gap`, so a gallery keeps its columns in a theme whose block gap is wider than 16px.

## Slots

A slot is one piece of a pattern's content that can be read and replaced without touching its design.

```ts
import { parseBlocks, serializeBlocks } from '@pressbase/blocks';
import { extractSlots, fillSlots, slotValues } from '@pressbase/slots';

const blocks = parseBlocks(pattern.content);
const slots = extractSlots(blocks, { declarations: pattern.slots });
// [{ id: 'eyebrow', kind: 'text', role: 'eyebrow', value: 'Repairs, renovations and upkeep', maxLength: 50, … },
//  { id: 'title', kind: 'heading', role: 'title', level: 1, value: 'Good work, done properly and on time', … },
//  { id: 'body', kind: 'text', … },
//  { id: 'actions', kind: 'group', flat: true, minItems: 1, maxItems: 2, items: [[{ kind: 'button', … }], …] }]

const markup = serializeBlocks(
  fillSlots(blocks, { title: 'Fresh bread every morning', actions: [{ text: 'See the menu', url: '/menu' }] }),
);
```

### What becomes a slot

Walking the blocks in order:

| Block | Slot |
| --- | --- |
| `core/heading` | `heading`, with its level |
| `core/paragraph`, `core/preformatted`, `core/verse` | `text` |
| `core/list-item` | `text` (role `item`) |
| `core/details` | `text` for the summary (role `summary`), then its inner blocks |
| `core/quote`, `core/pullquote` | the inner text, then the citation (role `citation`) |
| `core/button` | `button`: `{ text, url }` |
| `core/image`, `core/cover` and `core/media-text` with an image | `image`: `{ url, alt }`, and a `subject` |
| Lists, button groups, galleries; runs of two or more alike siblings (cards, columns, rows); columns and grids whose children are all alike; questions (`core/details`); containers declared with `minItems`/`maxItems` | `group`, with each item's slots |

Query loops, navigation, template parts, pattern references, synced patterns, code, tables and custom HTML hold no slots and aren't searched.

Siblings are **alike** when they have the same blocks in the same structure (attributes and the number of items in a nested list don't matter). Pricing cards where one has an extra "Most popular" label aren't alike, so each card's content becomes separate slots; the library's rule 8 avoids that.

### IDs, roles and limits

- **Role:** the first heading of a section (or of a group item) is its `title`; paragraphs before it are `eyebrow`s; other headings are `heading`, other text `body`; list items `item`, buttons `action`, images `media`; groups `list`, `actions`, `gallery` or `items`.
- **ID:** the slug of the block's name (List View → Rename, saved as `metadata.name`, which WordPress's pattern overrides also use) when it has one, otherwise the role; repeats get `-2`, `-3`. IDs are unique among siblings; a slot inside a group item is addressed as `group.child` in declarations and `group.2.child` in paths. In a **flat** group (items of one slot: list items, buttons) an item's value is the slot's value itself: `list: ["One", "Two"]`.
- **Limits:** `maxLength` is 1.5 times the pattern's own text, rounded up to ten, at least twenty characters (buttons at most forty). Groups take one item at least; columns and buttons at most as many as designed (they sit side by side), other groups twice as many.
- **Declarations** override all of this: a library pattern's `slots` object, or a theme pattern's `Slots:` header, one line of JSON:

  ```php
  /**
   * Title: Opening hours
   * Slug: mytheme/hours
   * Slots: {"hours":{"minItems":1,"maxItems":7,"facts":true},"hours.time":{"maxLength":30}}
   */
  ```

  Fields: `label`, `description`, `role`, `maxLength`, `minItems`, `maxItems`, `subject`, `facts`, `placeholder`, `ignore`. An invalid header skips the pattern with a warning in the log, like any other pattern error. Declarations are served with the pattern as `slots` in `/wp/v2/block-patterns/patterns` (a Pressbase field), so the editor can extract the same slots.

### Filling

`fillSlots(blocks, values, options)` returns new blocks; the input isn't changed.

- Text is written inside its element, so the block's comment attributes, classes and preset styles stay byte for byte. Text values are rich text (inline HTML, as the editor saves it); with `format: 'text'` they are plain text and escaped, which is what a model's answer is.
- Links go through `esc_url()`'s rules: `javascript:` and other unsafe schemes are dropped.
- A new image URL drops the old attachment ID (`id` and the `wp-image-N` class) unless a new `id` is given; a cover's `url` and `alt` attributes follow.
- A group takes as many items as its value has, between `minItems` and `maxItems`: missing items drop the group's last item, extra ones copy it (with the whitespace between items), then each item is filled. Slots without a value keep the pattern's content.

Filling with the values just extracted gives back the same markup; `apps/core/src/pattern-library.test.ts` checks this for every pattern of the Pressbase theme and the library.

### Swap layout

`transferSlots(from, to)` moves a section's values into another pattern's slots: same role first (title to title, actions to actions), then same kind in order; groups pair by role, then by the kind of content their items hold (buttons never become cards), and map item by item. What has no place comes back in `unused`, with a path, so Studio can keep it and tell the person:

```ts
const { values, unused } = transferSlots(extractSlots(current), extractSlots(next, { declarations }));
const replaced = fillSlots(next, values, { declarations });
```

### AI

`slotsJsonSchema(slots)` is the JSON Schema of the values for `prompt.asJsonResponse(schema).generateJson()`: one property per slot, `maxLength` and item counts from the slots, and a description built from the label, the role, the pattern's own text as an example and, for `facts` slots, the placeholder to use when no fact was given. Images ask only for `alt` and a `subject` to search for; choosing the picture is code's job. Fill the answer with `format: 'text'`.

### Honest content

A value that isn't known is a placeholder in square brackets, such as `[Add a customer quote]`: plain text, valid in any block and visible on the page. `isPlaceholder()` recognises one, `placeholderFor(slot)` gives a slot's, and `findPlaceholders(slots)` lists every placeholder text, `#` or empty link and image without a URL, for the "Before you publish" checklist.

## Not yet

- Choosing images for library patterns' image slots (uploads, Openverse); until then they stay empty and are left out of the public page.
- Table cells and image captions as slots.
- The AI pipeline that fills slots ([plan](../plans/visual-site-builder.md#pipeline)). Studio's Swap layout (#45) is described in [studio.md](studio.md#swap-layout).
