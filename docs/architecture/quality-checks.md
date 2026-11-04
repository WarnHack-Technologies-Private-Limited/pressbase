# Quality checks

Checks for a page's blocks. They run after every AI generation (the pipeline's Check stage), on Studio's "Before you publish" checklist and from the evaluation suite, and they're as useful for pages people build by hand. A check never changes the page: it returns findings, each with a reference to the block it's about, and the editor or the pipeline decides what to do.

Code: `apps/core/src/quality/check-page.ts` (pure), `quality/ability.ts` (the ability), `routes/quality.ts` (the REST route). The contrast maths is `@pressbase/design`'s ([design generator](design-generator.md)); placeholders are `@pressbase/slots`' ([patterns and slots](patterns.md)).

## Running them

```ts
import { checkPage, pageStylesFromThemeJson } from './quality/check-page';

const active = await kernel.themes.active();
const findings = checkPage(markup, pageStylesFromThemeJson(active.themeJson.tree.getRawData()), {
  blockTypes: kernel.blocks.registry,
  titleIsH1: true,           // the template shows the title as the page's h1
  i18n: kernel.i18n,         // translated messages
});
```

- **The ability** `core/check-page` (category `site`, read-only): input `content` (block markup) or `id` (a post's saved content), and optionally `global_styles` (user global styles to check against instead of the saved ones, such as a generated design that isn't published), `title_is_h1` and `rules` (a subset). Output `{ findings, errors, warnings, passed }`; `passed` means no errors. Permission: `edit_post` for an `id`, otherwise `edit_posts`.
- **REST:** `POST /pressbase/v1/check-page` with the same body runs the ability as the request's user. `/wp-abilities/v1/abilities/core/check-page/run` works too, but a read-only ability runs with GET, and a page's markup doesn't belong in a URL. A missing `id` is `404 rest_post_invalid_id`; a refusal is `403 ability_invalid_permissions`.
- **CLI:** `pressbase ability run core/check-page --input='{"id":12}'`.

A finding:

```json
{
  "rule": "contrast",
  "severity": "error",
  "message": "Text doesn't stand out enough from its background (2.10:1, 4.5:1 is needed).",
  "block": { "path": [2, 0], "name": "core/group" },
  "data": { "kind": "text", "text": "#5c5c57", "background": "#1b1b19", "ratio": 2.1, "min": 4.5, "example": [2, 0, 1] }
}
```

`block.path` is the block's index among the page's top-level blocks, then among each block's `innerBlocks`, as `parse_blocks()` returns them: Studio selects the block from it. `block` is null for findings about the page as a whole. **Errors** fail the page (the bar the [evaluation suite](../plans/visual-site-builder.md#how-well-know-it-works) holds generated sites to); **warnings** are listed for a person to decide.

## The checks

| Rule | Severity | What it finds | Why |
| --- | --- | --- | --- |
| `block_invalid` | error | A block delimiter never closed, or closed without being opened; HTML outside any block; an attribute that doesn't match the block type's schema; a block outside its required `parent` or `ancestor` (a Button outside Buttons) or inside a block whose `allowedBlocks` don't include it | The editor shows these as broken ("This block contains unexpected or invalid content"), and the page renders differently from what was meant |
| `block_unknown` | error | A block type that isn't registered (a plugin's block after the plugin is gone, or a name a model invented) | It renders nothing on the site |
| `contrast` | error | Text, links and buttons below WCAG 2.2 AA against the background they sit on: 4.5:1, or 3:1 for large text (headings h1–h3, large font size presets, 24px and up) | [1.4.3 Contrast (Minimum)](https://www.w3.org/TR/WCAG22/#contrast-minimum): text people can't read, in sunlight or with low vision |
| `heading_multiple_h1` | error | More than one `h1`, counting the page title when the template shows it as the `h1` (`titleIsH1`) | One main heading tells screen-reader users and search engines what the page is |
| `heading_no_h1` | error | No `h1`, when the template doesn't show the title as one (`titleIsH1: false`) | The same |
| `heading_skipped` | error | A heading more than one level below the one before it (h2 then h4) | [1.3.1 Info and Relationships](https://www.w3.org/TR/WCAG22/#info-and-relationships): screen-reader users navigate by headings, and a skipped level reads as a missing section |
| `image_alt` | error | An image with a source but no alternative text, not marked decorative | [1.1.1 Non-text Content](https://www.w3.org/TR/WCAG22/#non-text-content) |
| `placeholder` | warning | Text that is a placeholder (`[Add your opening hours]`), a button linking to `#` or nowhere, an image not chosen yet | [Honest content](../plans/visual-site-builder.md#honest-content): what the site owner hasn't told us is left visible, never invented, and listed before publishing |
| `link_text` | error when empty, warning when vague | A link with no text (no words, `aria-label` or image alt), or text that doesn't say where it goes: "click here", "here", "read more", "learn more", "more"… | [2.4.4 Link Purpose](https://www.w3.org/TR/WCAG22/#link-purpose-in-context): screen-reader users often list a page's links out of context. Vague text is a warning because surrounding text can make it clear |
| `color_raw` | warning | A literal colour (hex, `rgb()`, `hsl()`…, a colour name) in a block's colour, border or element styles rather than a preset; the finding names the preset with the same value when there is one | Raw colours don't follow the site's palette when the design changes, and escape the contrast guarantees of a generated palette |

### How contrast is worked out

The checker follows colours down the block tree as CSS inherits them:

- **The site's styles**: the body's text and background, link colour and button colours, from the merged `theme.json` (`styles.color`, `styles.elements.link`, `styles.elements.button`). `pageStylesFromThemeJson()` builds them, with the palette from every origin (default, theme, then user, later ones winning) and the colours of every block style variation.
- **Each block's own colours**: the `textColor` and `backgroundColor` presets, `style.color.text` and `style.color.background`, link colours in `style.elements.link`, and section styles (`is-style-section-ink`) through their variation's colours.
- **Buttons** use their own colours, or the theme's button colours; an outline button is drawn on the background it sits on.
- **Unknown backgrounds** stop the check below them: a gradient, a Cover with an image, or a Cover overlay that isn't fully opaque. The checker can't know which pixels the text sits on, so it says nothing rather than guess.

A failing pair is reported **once, on the block that set it** (the group whose background is wrong, where a person would fix it), with the first text block it affects in `data.example`. When the site's own body colours fail, the finding has no block.

The page's text is checked with the AA minimums whatever the palette's level; a palette made at high contrast (AAA) passes them with room to spare.

### Decorative images

WordPress's Image block always saves an `alt` attribute, empty by default, so an empty `alt` can't tell "decorative" from "forgotten". An image counts as decorative when its block has `metadata.decorative: true` (a Pressbase extension that WordPress ignores, for Studio to set from a "Decorative image" toggle) or its `img` has `role="presentation"`, `role="none"` or `aria-hidden="true"`. Cover backgrounds are always decorative. An image with no source yet is a placeholder, not an alt-text problem.

## Not checked (yet)

- Contrast of text over images and gradients, and of borders and form fields (1.4.11 non-text contrast).
- Vague link text in languages other than English.
- Headings inside Custom HTML blocks, and the HTML of Custom HTML blocks generally.
- Block validation as the editor does it (comparing saved HTML with each block's `save()` output) needs the blocks' JavaScript; the server checks structure, types, attributes and nesting.
