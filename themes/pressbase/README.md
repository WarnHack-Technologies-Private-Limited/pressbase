# Pressbase, the theme

The default theme of Pressbase, and a standard WordPress block theme: the same folder works unchanged in WordPress 6.7 to 7.1. Licensed GPLv2 or later; see `readme.txt` for the fonts' licences (SIL OFL 1.1).

## What's inside

| Folder or file | Contents |
|---|---|
| `theme.json` | Schema 3. The "Paper" look: palette (`base`, `surface`, `contrast`, `muted`, `border`, `accent`, `accent-text`, `accent-soft`, `on-accent`, `violet`), gradients, fluid font sizes up to `display`, spacing `20`–`80`, shadows (`soft`, `lifted`, `glow`, `deep`), radius sizes, Manrope, Platypi (with italic), Fira Code and a system mono |
| `style.css` | Theme header, motion and block style CSS (under 15 KB) |
| `functions.php` | For WordPress: enqueues `style.css`, registers the block styles and the `pressbase` and `pressbase_page` pattern categories. Pressbase reproduces it from `THEME_COMPAT.pressbase` in `apps/core/src/themes/compat.ts` |
| `templates/` | `index`, `home`, `front-page`, `single`, `page`, `page-no-title`, `archive`, `search`, `404` |
| `parts/` | `header` (sticky glass header), `footer` |
| `patterns/` | 29 patterns, 20 of them in the inserter; `hidden-*` ones are used by templates |
| `styles/` | `01-midnight.json` (dark), `colors/02-violet.json`, `typography/03-grotesk.json`, and the section styles `sections/section-ink.json` and `sections/section-soft.json` |
| `assets/` | Fonts (from Twenty Twenty-Five), SVG icons, placeholder portraits and the Pressbase mark |

## Block styles

| Style | Blocks | Effect |
|---|---|---|
| Reveal | Group, Columns, Image | Rises into place as it scrolls into view. In Columns and grid Groups, each child reveals in turn |
| Lift | Group, Column | A card that lifts on hover and focus |
| Glass | Group, Column | A frosted, translucent card |
| Gradient | Group, Cover | A slowly drifting indigo and violet aurora with film grain |
| Marquee | Group | Its inner row glides sideways as the page scrolls |
| Animated links | Group | Links underline themselves on hover and focus |
| Pill | Paragraph (and Post Terms, via the class) | A small rounded label |

## Motion rules

- CSS only. Pages ship no theme JavaScript.
- Only `transform` (and the individual `translate` and `scale` properties) and `opacity` animate, so motion never causes layout shift.
- Anything that starts hidden (reveals, the header's glass layer) is inside `@supports (animation-timeline: …)`. Browsers without scroll-driven animations show everything, statically.
- `@media (prefers-reduced-motion: reduce)` stops every animation and transition.
- The marquee moves only with the visitor's own scrolling. Nothing informative moves on its own.

`apps/core/src/pressbase-theme.test.ts` checks these rules, the patterns, templates, style variations and colour contrast.

## Performance

- Below-the-fold sections of `main` use `content-visibility: auto`.
- Fonts use `font-display: swap` with metric-matched local fallbacks (`Manrope Fallback`, `Platypi Fallback`), so the swap doesn't move text.
- The hero's terminal card uses the system monospace, so Fira Code only loads where code appears.

Lighthouse (mobile, the front page with sample content, Pressbase's production public app): performance 99, accessibility 100.
