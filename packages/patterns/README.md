# @pressbase/patterns

The Pressbase pattern library: section patterns that ship with Pressbase and work in any block theme. Studio's Sections panel, Swap layout, starter sites and building with AI all use them. Core registers each one as `pressbase/<name>` beside the active theme's patterns, so they also appear in the block editor's inserter and at `/wp/v2/block-patterns/patterns`.

How it fits together is in [docs/architecture/patterns.md](../../docs/architecture/patterns.md).

## A pattern is two files

In `src/patterns/`:

- **`<name>.html`**: the block markup, exactly as the block editor's **Code editor** shows it. Build the section in the editor, then copy it.
- **`<name>.json`**: its metadata.

```json
{
  "title": "Opening hours",
  "description": "A heading, a short note and a directions button beside a list of days and times.",
  "categories": ["opening-hours", "contact"],
  "keywords": ["opening hours", "hours", "open", "times"],
  "viewportWidth": 1000,
  "slots": {
    "hours": { "minItems": 1, "maxItems": 7, "facts": true, "placeholder": "[Add your opening hours]" }
  }
}
```

- `title`: sentence case, says what the section is and, after a comma, how it looks (`Hero, centred`).
- `categories`: the **first** is the section's category, one of the table below; add WordPress categories after it if they fit (`featured`, `contact`).
- `viewportWidth`: the width the inserter previews it at (1000–1400 for most sections).
- `slots`: optional declarations that refine the slots found in the markup. See [Slots](#slots).

The name comes from the file name. Name files `<category>-<what is different>` (`hero-centered`, `hero-split-image`, `pricing-three-plans`) and never reuse a name the Pressbase theme uses (`themes/pressbase/patterns/`): a test fails on a clash.

## Categories

| Section | Category name | WordPress has it |
| --- | --- | --- |
| Hero | `banner` | yes |
| About | `about` | yes |
| Features | `features` | no, core registers it |
| Services | `services` | yes |
| Pricing | `pricing` | no, core registers it |
| Testimonials | `testimonials` | yes |
| Team | `team` | yes |
| Questions and answers | `faq` | no, core registers it |
| Gallery | `gallery` | yes |
| Contact | `contact` | yes |
| Opening hours | `opening-hours` | no, core registers it |
| Call to action | `call-to-action` | yes |
| Header | `header` | yes |
| Footer | `footer` | yes |

## The rules

Every pattern follows these. `checkPattern()` checks the ones code can check, and `pnpm --filter @pressbase/patterns test` fails on any problem.

1. **Theme presets only.** No raw colours (`#fff`, `rgb()`), sizes (`24px`, `2rem`, `50%`) or fonts, in attributes or inline styles. Use the presets every block theme has, so the section looks at home in any theme:
   - font sizes `small`, `medium`, `large`, `x-large`, `xx-large`;
   - spacing `var:preset|spacing|20` to `80`;
   - colours: none, ideally; `base` and `contrast` at most. The theme's styles colour the section.
   - No `fontFamily`, no custom `contentSize` or `wideSize` (use `align: wide` or `full`). A column's width as a percentage is allowed.
2. **Core blocks only.** No plugin blocks, and not `core/html`, `core/freeform`, `core/shortcode`, `core/embed`, `core/pattern` or `core/template-part`. Class names only for core block styles (`is-style-outline`, `is-style-rounded`…), never a theme's.
3. **One heading level at the start.** A section opens with one heading: `h1` for a hero, `h2` for everything else. Headings inside it are lower levels and never skip one (h2 → h3, not h2 → h4). Headers and footers are exempt.
4. **Real alt-text slots.** Every image has alt text that says what it shows, and a declared `subject` when the alt text doesn't make a good image search. AI fills alt text; it never picks the image itself.
5. **Looks right on mobile.** Columns stack (`isStackedOnMobile` is never `false`), nothing has a fixed width, and text fits at 360 px wide. Check in the editor's mobile preview.
6. **No JavaScript.** No scripts, event handlers or `javascript:` links. Interactivity comes from core blocks (`core/details`).
7. **Honest sample text.** Plain, believable business copy that is obviously replaceable. Facts the site owner must supply (prices, hours, names, quotes, addresses, phone numbers) are declared with `"facts": true` and a `placeholder`; testimonials and team members use placeholders such as `[Customer name]`, never invented people.
8. **Repeated items are alike.** Cards, columns, rows and list items have the same blocks in the same order, so a group can grow and shrink. Highlight one item with a core block style or a preset, not an extra block.
9. **Name the blocks that hold content** (List View → Rename) when the name helps: `Day`, `Time`, `Note`. The name becomes the slot's ID and label.

## Slots

The markup's editable content becomes typed slots automatically (see `@pressbase/slots`): headings, paragraphs, list items, buttons, images and repeated groups. Declarations in `slots` override what's inferred. Keys are slot IDs, and `group.child` for a slot inside a group's items:

| Field | For | Meaning |
| --- | --- | --- |
| `label`, `description` | all | Shown in Studio and given to the model. |
| `role` | all | What the slot is for, when the inferred role is wrong. |
| `maxLength` | text, buttons | Longest text that still fits the design. |
| `minItems`, `maxItems` | groups | How many items the layout takes. Declaring either keeps a group a group even with one item. |
| `subject` | images | What the picture should show. |
| `facts`, `placeholder` | all | Honest content: fill only from facts the person gave, otherwise use the placeholder. |
| `ignore` | all | Not a slot: keep the pattern's content. |

To see a pattern's slots, run its test, or call `extractSlots(parseBlocks(content), { declarations })`.

## Adding a pattern

1. Build the section in the block editor with the Pressbase theme, then try it in a second block theme.
2. Copy the markup from the Code editor into `src/patterns/<name>.html`, add `<name>.json`.
3. `pnpm --filter @pressbase/patterns test` and `pnpm --filter @pressbase/core exec vitest run src/pattern-library.test.ts`.
4. In the pull request: screenshots on desktop and mobile, in the default style and one dark style variation.
