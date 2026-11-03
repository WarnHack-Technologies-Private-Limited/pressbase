# Design generator

When Studio builds a site with AI, the model chooses a **design direction** (a mood, a hue, a font pair, a corner style and a spacing density) and **code** turns it into colours and presets. So every generated site passes WCAG 2.2 AA contrast, whatever the model picked ([plan](../plans/visual-site-builder.md#pipeline), [ADR 0024](../adr/0024-ai-site-building.md)). The same functions serve people choosing a direction by hand in the "Design direction" step, and they need no AI.

Code: `packages/design` (`@pressbase/design`), pure functions with no I/O, so core, the admin's live previews and the [quality checks](quality-checks.md) share them.

```ts
import { checkPalette, createDesign, toGlobalStyles } from '@pressbase/design';

const design = createDesign({
  mood: 'warm', hue: 30, contrast: 'standard', scheme: 'light',
  fontPair: 'slab-humanist', radius: 'rounded', density: 'comfortable',
});
checkPalette(design.palette);       // [] for every generated palette
const userStyles = toGlobalStyles(design);   // for wp_global_styles
```

## The design choice

`DESIGN_CHOICE_SCHEMA` is the JSON Schema the Design stage passes to `asJsonResponse()`; every field is an enum or a bounded number, so the answer can't be anything code doesn't handle.

| Field | Values | What it controls |
| --- | --- | --- |
| `mood` | `calm`, `warm`, `vibrant`, `elegant`, `earthy`, `minimal`, `playful` | How colourful the accent is, how tinted the page colours are (warm and earthy tint them towards cream), how far the second colour's hue turns |
| `hue` | 0–359 | The accent's hue (other numbers wrap) |
| `contrast` | `standard`, `high` | AA (4.5:1 text, 3:1 large text and UI), or AAA for text (7:1, 4.5:1 large) |
| `scheme` | `light`, `dark` | Light or dark pages |
| `fontPair` | see [below](#font-pairs) | Heading and body fonts |
| `radius` | `square`, `subtle`, `rounded`, `soft` | Corner presets |
| `density` | `compact`, `comfortable`, `spacious` | Spacing presets and the gap between blocks |

## Palettes

`generatePalette({ hue, mood, contrast?, scheme? })` returns a `theme.json` palette (`{ name, slug, color }[]`, hex colours) with the **Pressbase theme's slugs**: `base`, `surface`, `contrast`, `muted`, `border`, `accent`, `accent-text`, `accent-soft`, `on-accent` and `violet` (the theme's name for its second brand colour, the end of the accent gradient; a generated one can be any hue). Saved as user global styles, it restyles the theme and every pattern that uses its presets.

How it's built:

1. **In OKLCH.** Each colour starts at a lightness and chroma set by the scheme and the mood, at the chosen hue (the second colour at the hue plus the mood's turn). OKLCH is perceptual: equal lightness looks equally light at every hue, so one recipe works for yellow and for blue. Colours outside sRGB are brought in by lowering chroma, keeping lightness and hue.
2. **Page colours are fixed first**: `base`, `surface`, `accent-soft` and `border`.
3. **Every text colour is then darkened** (lightened on a dark scheme) in steps of 0.005 lightness, until its contrast with each background it's drawn on passes. The contrast is computed on the final hex values, so rounding can't break it. Black or white end the search, and they always pass against these backgrounds, so generation can't fail.
4. **Button colours**: `on-accent` is white on a light scheme and the page colour on a dark one; the accent is adjusted until button text on it passes as text, and the accent itself passes as large text on the page.

The pairs checked are `PALETTE_PAIRS`, every pair the Pressbase theme draws, the same list its own palettes are tested against:

| Text | On | Minimum | Where |
| --- | --- | --- | --- |
| `contrast` | `base`, `surface`, `accent-soft` | text | body text on the page, cards and soft sections |
| `base` | `contrast` | text | the Ink section style |
| `muted` | `base`, `surface`, `accent-soft` | text | captions, excerpts, dates |
| `accent-text` | `base`, `surface`, `accent-soft` | text | links, pills |
| `on-accent` | `accent` | text | buttons |
| `accent`, `violet` | `base`, `surface` | large text and UI | marquee words, gradient heading accents, focus rings |

`border` is decorative (separators) and has no minimum; form fields draw their own borders from the text colour.

`checkPalette(palette, level?, pairs?)` lists the pairs below the minimums; use it on palettes people adjust by hand. Property tests generate 6,000 random palettes (both schemes, both levels, all moods, hues outside 0–360) plus every whole-degree hue for every mood, and every pair passes.

Saturated light hues (yellows, limes) come out darker than their brand colour on a light scheme: white text on them needs it. That's the price of AA, and the reason `accent-text` exists apart from `accent`.

## Font pairs

`FONT_PAIRS` is a curated list. Every font is open and **local**: nothing is fetched from Google or any font service.

- **Theme fonts** (`source: 'theme'`): Manrope and Platypi, bundled with the Pressbase theme under the SIL Open Font License and served from the site. Pairs using them need a theme that declares those font families; `availableFontPairs(themeFontSlugs)` filters the list.
- **System stacks** (`source: 'system'`): fonts already on visitors' devices, from [Modern Font Stacks](https://modernfontstacks.com/) (CC0): transitional, old style, Didone, humanist, geometric humanist, rounded, industrial and slab serif. They cost no download.

| Pair | Headings | Body |
| --- | --- | --- |
| `platypi-manrope` | Platypi | Manrope (the theme's own) |
| `manrope` | Manrope | Manrope |
| `platypi-system` | Platypi | system sans |
| `transitional-humanist` | transitional | humanist |
| `old-style` | old style | old style |
| `didone-humanist` | Didone | humanist |
| `geometric` | geometric humanist | system sans |
| `rounded` | rounded | system sans |
| `industrial` | industrial | humanist |
| `slab-humanist` | slab serif | humanist |

## Corners and spacing

- `radiusPresets(radius)` gives sizes for the theme's `border.radiusSizes` slugs (`sm`, `md`, `lg`, `xl`, `full`). `rounded` is the theme's own scale. `full` is what buttons and pills use: a pill except with `square` (0) or `subtle` corners, where buttons match the rest.
- `spacingPresets(density)` scales WordPress's spacing slugs `20`–`80` (the theme's scale is `comfortable`; `compact` is ×0.75, `spacious` ×1.3), keeping the fluid `clamp()` steps fluid. `blockGap(density)` scales the gap between blocks.

## User global styles

`toGlobalStyles(design)` returns a `wp_global_styles` document:

- `settings.color.palette.theme`, `settings.border.radiusSizes.theme` and `settings.spacing.spacingSizes.theme`: the theme's presets replaced, keyed by the `theme` origin as applying a style variation does;
- `settings.typography.fontFamilies.custom`: the pair's system stacks, added beside the theme's fonts;
- `styles`: the body font, heading and button fonts, the block gap, and the fonts of the site title, quotes and pull quotes.

It holds only the design, so merge it into the site's existing user styles (`mergeGlobalStylesConfigs()`) to keep other changes; the site-building abilities write it into the changeset, never straight to the site.

## Not yet

- Shadows: the theme's `glow` and `lifted` shadows are tinted with its indigo and aren't regenerated.
- Gradients follow the palette (they're built from `accent` and `violet` variables), but a theme with literal colours in its gradients won't.
- Other block themes' palette slugs (Twenty Twenty-Five's `accent-1`…`accent-6`): a mapping per theme is future work.
