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
- `blockTypes`: headers and footers only, `["core/template-part/header"]` or `["core/template-part/footer"]`, as WordPress's `Block Types` header. The editor then offers the pattern when replacing that template part, and Studio's Sections panel and the site builder leave it out of a page's sections.
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
   - colours: `base` and `contrast`, and otherwise let the theme's styles colour the section.
   - No `fontFamily`, no custom `contentSize` or `wideSize` (use `align: wide` or `full`). A column's width as a percentage is allowed, and so is a grid's `minimumColumnWidth` in `rem` (it's what makes the grid wrap on small screens).

   The Pressbase theme's own presets are allowed too (`PRESSBASE_PRESETS`), because every site Pressbase builds has them: generated designs (`@pressbase/design`) restyle the same slugs. Colours `surface`, `muted`, `border`, `accent`, `accent-text`, `accent-soft`, `on-accent` and `violet`; font sizes `xxx-large` and `display`; radius `var:preset|border-radius|sm` to `xl` and `full`. A theme without one ignores it, so the section must still read without it: a card on `surface` becomes a card on the page colour, a `display` headline the theme's own `h1`. Use them as the Pressbase theme does: `muted` for secondary text, `accent-text` for small labels, `surface` for cards, `accent-soft` and `contrast` (with `base` text) for whole sections.
2. **Core blocks only.** No plugin blocks, and not `core/html`, `core/freeform`, `core/shortcode`, `core/embed`, `core/pattern` or `core/template-part`. Class names only for core block styles (`is-style-outline`, `is-style-rounded`…), never a theme's.
3. **One heading level at the start.** A section opens with one heading: `h1` for a hero, `h2` for everything else. Headings inside it are lower levels and never skip one (h2 → h3, not h2 → h4). Headers and footers are exempt.
4. **Real alt-text slots.** Every image has alt text that says what it shows, and a declared `subject` when the alt text doesn't make a good image search. AI fills alt text; it never picks the image itself. The library ships no image files: an image is an Image block with no `url` (`<img alt="…"/>`), which the editor shows as a placeholder to fill, the "Before you publish" checklist lists as "Choose an image", and the public site leaves out until one is chosen (as WordPress's `render_block_core_image()` does). Give it an `aspectRatio` and `scale: cover`, so any picture fits the layout.
5. **Looks right on mobile.** Columns stack (`isStackedOnMobile` is never `false`), nothing has a fixed width, and text fits at 360 px wide. Check in the editor's mobile preview.
6. **No JavaScript.** No scripts, event handlers or `javascript:` links. Interactivity comes from core blocks (`core/details`).
7. **Honest sample text.** Plain, believable business copy that is obviously replaceable. Facts the site owner must supply (prices, hours, names, quotes, addresses, phone numbers) are declared with `"facts": true` and a `placeholder`; testimonials and team members use placeholders such as `[Customer name]`, never invented people.
8. **Repeated items are alike.** Cards, columns, rows and list items have the same blocks in the same order, so a group can grow and shrink. Highlight one item with a core block style or a preset, not an extra block.
9. **Name the blocks that hold content** (List View → Rename) when the name helps: `Day`, `Time`, `Note`. The name becomes the slot's ID and label. Name the repeated container after its items (`Features`, `Services`, `Gallery`) and the section's outer group differently (`Features section`): a group whose name matches a declared group's ID is treated as that group.
10. **Real links.** Buttons and links go somewhere real: a page most sites have (`/contact/`, `/privacy-policy/`) or, for directions, a map (declared `facts`, so the site builder links the real address). Never `#`, which the "Before you publish" checklist lists as unfinished.
11. **Headers and footers use the site's own blocks.** Site Title, Site Tagline, Site Logo and a Navigation block without a `ref`, which shows the site's menu; a footer's menu has an `ariaLabel` (`Footer`), so the page's two menus are told apart. They declare `blockTypes` (above) and are exempt from rule 3.
12. **Layouts of one section share their slots.** Swap layout carries content from one pattern of a category to the next by role, so use the same shape where you can: an `eyebrow` label, a `title`, a `body`, `actions` buttons, an `image` (named `Image`), and repeated `items` with a title and body each.

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

## Catalogue

Each pattern is registered as `pressbase/<name>`. Contact sheets show every layout of a section in the Pressbase theme's default style and its dark Midnight style, desktop beside mobile; images not chosen yet are drawn as grey placeholders there.

| Section | Pattern | Layout | Slots |
| --- | --- | --- | --- |
| Hero (`banner`) | `hero-centered` | Label, headline, introduction and two buttons, centred | eyebrow, title, body, actions |
| | `hero-split-image` | Text and buttons beside a tall image | + image |
| | `hero-bold-band` | A display-size headline on a band in the text colour, with the introduction and buttons beside it | eyebrow, title, body, actions |
| | `hero-image-below` | Centred text and buttons above a wide image | + image |
| About | `about-split-image` | A tall image beside a heading, two paragraphs and a button | image, eyebrow, title, body, more, actions |
| | `about-values` | Heading and button beside a column of cards, one per value | eyebrow, title, body, actions, values (2–5) |
| | `about-statement` | A large statement on a soft background, three short columns and a button | eyebrow, title, story (2–3), actions |
| Call to action | `cta-split-band` | A rounded band in the text colour: heading and sentence, buttons on the right | title, body, actions |
| | `cta-soft-centered` | Centred heading, sentence and buttons on a soft background | eyebrow, title, body, actions |
| | `cta-image-card` | A rounded card: image beside heading, sentence and buttons | image, title, body, actions |
| Features | `features-cards` | Centred heading above a grid of cards, three to a row | eyebrow, title, body, features (2–9) |
| | `features-split-list` | Heading and button beside features separated by lines | eyebrow, title, body, actions, features (2–6) |
| | `features-image-grid` | A tall image beside a heading and features in two columns | image, eyebrow, title, body, features (2–6) |
| Services | `services-cards` | Heading beside an introduction, then three services with images | eyebrow, title, body, actions, services (2–3: image, title, body) |
| | `services-list` | Rows of services, each with a name, a description and a button | eyebrow, title, body, services (1–8) |
| | `services-two-by-two` | Cards two to a row on a soft background, each with a list of what's included | eyebrow, title, body, services (2–6, with list) |
| Gallery | `gallery-grid` | Centred heading above a Gallery block of six square images | eyebrow, title, body, gallery (3–12) |
| | `gallery-mosaic` | One large image beside a Gallery block of four | eyebrow, title, body, actions, featured-image, gallery (2–4) |
| | `gallery-captioned` | Three tall images, each with a project name and a line about it (facts) | eyebrow, title, body, projects (2–3) |
| Pricing | `pricing-three-plans` | Centred heading above three plan cards, the middle one on a soft background; each with a price (fact), what's included and a button | eyebrow, title, body, plans (2–4: title, body, price, list, actions), note |
| | `pricing-plan-rows` | Plans in rows separated by lines: name, who it is for, price, button | eyebrow, title, body, plans (1–6: title, body, price, actions) |
| | `pricing-price-list` | Heading and button beside a list of services with their prices | eyebrow, title, body, actions, prices (1–12: title, price, body) |
| Testimonials | `testimonials-cards` | Centred heading above three quotes in cards (Quote blocks) | eyebrow, title, body, testimonials (1–6: body, citation) |
| | `testimonials-large-quote` | One quote in large type on a soft background | title, testimonials (1) |
| | `testimonials-split` | Heading and button beside two quotes | eyebrow, title, body, actions, testimonials (1–4) |
| Team | `team-grid` | Four portraits with name, role and a line each, four to a row | eyebrow, title, body, people (1–8: image, title, role, body) |
| | `team-list` | Heading and button beside people in rows, no photos needed | eyebrow, title, body, actions, people (1–8: title, role, body) |
| Questions and answers (`faq`) | `faq-centered` | Centred heading above a column of questions (Details blocks) and a button | eyebrow, title, body, questions (1–12: summary, body), actions |
| | `faq-split` | Heading and button beside the questions | eyebrow, title, body, actions, questions (1–12) |
| | `faq-two-columns` | Heading above questions in two columns | eyebrow, title, body, questions (1–12) |
| Contact | `contact-cards` | Centred heading above cards for address, phone and email (facts), and a directions button | eyebrow, title, body, details (1–4: title, body), actions |
| | `contact-split-image` | A tall image of the place beside the heading, details and directions button | image, eyebrow, title, body, details (1–4), actions |
| | `contact-band` | A rounded band in the text colour: large heading, details side by side, button | title, body, details (1–4), actions |
| Opening hours | `opening-hours` | Heading, note and button beside days and times (facts) | title, body, note, actions, hours (1–7: day, time) |
| | `opening-hours-card` | A centred card: heading, a list of days and times, note and button | title, body, hours (1–7, list), note, actions |
| | `opening-hours-band` | Heading, note and button beside a card listing days and times, on a soft background | title, body, note, actions, hours (1–7, list) |
| Header | `header-simple` | Logo and site title, the menu on the right | none |
| | `header-with-button` | Logo and site title; the menu and one button on the right | actions |
| | `header-centered` | Site title and tagline centred, the menu below | none |
| Footer | `footer-centered` | Site title, tagline and menu centred, a privacy link | privacy |
| | `footer-columns` | Site title and tagline, the menu, contact details (facts) in columns; a privacy link | menu-label, contact-label, address, phone, email, privacy |
| | `footer-hours` | Address and directions, opening hours (a list), phone and email; then title, menu and privacy link | address, actions, hours, phone, email, privacy and labels |

Facts are never invented: prices, quotes, names, roles and contact details ship as bracketed placeholders (`[Add a price]`, `[Customer name]`), which the "Before you publish" checklist lists. `opening-hours` keeps the day and the time as two slots in rows; `opening-hours-card` and `-band` use a List block, one line per day (`Monday to Friday: 8:00 – 18:00`), so screen readers announce a list. Swap layout from the rows to a list moves each day and reports the times it had no place for; the other way, the times become placeholders.

| Section | Default | Midnight |
| --- | --- | --- |
| Hero | [hero-light.png](../../docs/assets/patterns/hero-light.png) | [hero-dark.png](../../docs/assets/patterns/hero-dark.png) |
| About | [about-light.png](../../docs/assets/patterns/about-light.png) | [about-dark.png](../../docs/assets/patterns/about-dark.png) |
| Call to action | [call-to-action-light.png](../../docs/assets/patterns/call-to-action-light.png) | [call-to-action-dark.png](../../docs/assets/patterns/call-to-action-dark.png) |
| Features | [features-light.png](../../docs/assets/patterns/features-light.png) | [features-dark.png](../../docs/assets/patterns/features-dark.png) |
| Services | [services-light.png](../../docs/assets/patterns/services-light.png) | [services-dark.png](../../docs/assets/patterns/services-dark.png) |
| Gallery | [gallery-light.png](../../docs/assets/patterns/gallery-light.png) | [gallery-dark.png](../../docs/assets/patterns/gallery-dark.png) |
| Pricing | [pricing-light.png](../../docs/assets/patterns/pricing-light.png) | [pricing-dark.png](../../docs/assets/patterns/pricing-dark.png) |
| Testimonials | [testimonials-light.png](../../docs/assets/patterns/testimonials-light.png) | [testimonials-dark.png](../../docs/assets/patterns/testimonials-dark.png) |
| Team | [team-light.png](../../docs/assets/patterns/team-light.png) | [team-dark.png](../../docs/assets/patterns/team-dark.png) |
| Questions and answers | [faq-light.png](../../docs/assets/patterns/faq-light.png) | [faq-dark.png](../../docs/assets/patterns/faq-dark.png) |
| Contact | [contact-light.png](../../docs/assets/patterns/contact-light.png) | [contact-dark.png](../../docs/assets/patterns/contact-dark.png) |
| Opening hours | [opening-hours-light.png](../../docs/assets/patterns/opening-hours-light.png) | [opening-hours-dark.png](../../docs/assets/patterns/opening-hours-dark.png) |
| Header | [header-light.png](../../docs/assets/patterns/header-light.png) | [header-dark.png](../../docs/assets/patterns/header-dark.png) |
| Footer | [footer-light.png](../../docs/assets/patterns/footer-light.png) | [footer-dark.png](../../docs/assets/patterns/footer-dark.png) |

All of #42 and #43 on one page: [pattern-library-sections.png](../../docs/assets/screenshots/pattern-library-sections.png).

## Adding a pattern

1. Build the section in the block editor with the Pressbase theme, then try it in a second block theme.
2. Copy the markup from the Code editor into `src/patterns/<name>.html`, add `<name>.json`.
3. `pnpm --filter @pressbase/patterns test` and `pnpm --filter @pressbase/core exec vitest run src/pattern-library.test.ts`.
4. In the pull request: screenshots on desktop and mobile, in the default style and one dark style variation.
