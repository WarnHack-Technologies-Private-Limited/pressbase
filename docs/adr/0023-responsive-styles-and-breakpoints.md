# 0023: Responsive styles and breakpoints

- **Status:** Accepted
- **Date:** 2026-11-03

## Context

Studio's responsive mode (#49) lets a designer give a block a different value on tablets and phones, and hide a block on a device. WordPress 7.1 shipped the same feature ([responsive block styles and configurable viewports](https://make.wordpress.org/core/2026/08/05/responsive-block-styles-and-configurable-viewports-in-wordpress-7-1/)), with a data format that block themes now use:

- `settings.viewport` in `theme.json`: `{ "mobile": "480px", "tablet": "782px" }` (the defaults);
- `@mobile` and `@tablet` style states in `theme.json`, beside the existing pseudo states (`styles.blocks["core/heading"]["@mobile"]`), and in a block's `style` attribute (`style["@mobile"].typography.fontSize`);
- `metadata.blockVisibility` on any block: `false`, or `{ "viewport": { "mobile": false } }`.

Pressbase promises that WordPress block themes run unchanged, and Studio needs a storage format anyway. Inventing our own would split us from 7.1 themes and from WordPress's editor data.

Forces:

- The output must match WordPress's for the same `theme.json` and attributes, selectors and ordering included, so a theme looks the same on both.
- A site without responsive values must render byte for byte as before.
- Per-instance CSS must not go in the `style` attribute: media queries can't be inline.

## Decision

Port WordPress 7.1's code, with its names and shapes. Nothing is Pressbase-specific.

- **Breakpoints** (`packages/theme-json/src/viewport.ts`): `getViewportMediaQueries()` and `sanitizeViewportSettings()` port the `WP_Theme_JSON` methods. Only `px`, `em` and `rem` lengths are accepted; with nothing valid the defaults apply; a single valid value stands alone (`@media (width <= 900px)`); `tablet` must be larger than `mobile` (em and rem count as 16px). The ranges don't overlap: `@mobile` is `(width <= 480px)`, `@tablet` `(480px < width <= 782px)`, and block visibility adds `@desktop` `(width > 782px)`. A tablet value therefore does not reach phones; the editor copies values down when it wants them inherited.
- **theme.json states** (`theme-json.ts`): `get_block_nodes()` emits a style node per breakpoint for a block, for each of its pseudo states and for each element, carrying the media query, right after the node it overrides; `get_styles_for_block()` wraps the node's rules (including block gap layout rules and `&` custom CSS) in it. Block style variations get their breakpoint CSS (feature, base, pseudo, custom CSS, block gap, elements) the same way, also per instance. `settings.viewport` is sanitised where it is set and removed from per-block settings, as in `sanitize()`; `removeInsecureProperties()` keeps safe breakpoint styles. As in WordPress, root and top-level element styles have no breakpoint states.
- **Per-instance states** (`apps/core/src/themes/states.ts`, `states.php`): a `render_block` filter turns the `style` attribute's pseudo states (Button and Navigation link only, `VALID_BLOCK_PSEUDO_SELECTORS`) and viewport states, with their elements and pseudo states, into rules. The class is `wp-states-` + the first 8 hex digits of the md5 of `wp_json_encode()` of the rules, so identical blocks share one rule and the class is the one WordPress prints. Declarations are `!important` (to beat inline styles and preset classes), with WordPress's border-style and gradient-reset fallbacks, and go to the block supports stylesheet (`core-block-supports-inline-css`), never inline. Selectors come from the block type's `selectors` (`wp_build_state_selector()`).
- **Block visibility** (`apps/core/src/themes/block-visibility.ts`, `block-visibility.php`): `blockVisibility: false` renders nothing; per-device hiding adds `wp-block-hidden-{device}` classes with `display: none !important` in the device's media query, and sets `fetchpriority="auto"` on the block's images. Blocks with `supports.visibility: false` ignore the per-device form.
- **The style engine's declarations** (`packages/theme-json/src/style-engine.ts`): `styleEngineDeclarations()` ports `WP_Style_Engine::parse_block_styles()` (declarations only) and `styleEngineStylesheet()` the rules store's merging and printing, with `!important` and rules groups. States need it because their CSS is built from the same definitions as WordPress's.

## Consequences

- WordPress 7.1 themes with breakpoints and responsive styles render as in WordPress; Studio writes the same attributes WordPress's editor writes.
- Without responsive values nothing changes: the Pressbase theme's stylesheet and variation styles are identical before and after (checked).
- Two values can be stored for one property (the base inline style and an `!important` state rule). That is WordPress's design; the UI must show which applies where.
- Not ported yet: responsive **layout** (`style["@mobile"].layout`, flex orientation, grid columns, child layout and block gap per device, in `layout.php`), and hiding `blockVisibility: false` blocks from automatic excerpts (`excerpt_remove_blocks()`; Pressbase builds excerpts from the content's text). The style engine's `safe_style_css` property allow-list is not ported; values are checked as everywhere else in Pressbase.
- Fixtures were written by reading the PHP; no PHP runtime was available to generate them. A mismatch found later is a bug to fix here, with a fixture.

## Alternatives considered

- **Pressbase's own format** (`responsive: { mobile: {…} }`): simpler to read, but WordPress themes and content would need conversion both ways.
- **Inline styles with `@container` or CSS custom properties per device**: no hashed classes, but it differs from WordPress's output and doesn't work for elements and pseudo states.
- **Overlapping ranges (tablet applies to phones too)**: more natural for a "values inherit downward" UI, but WordPress chose non-overlapping ranges; the editor can copy values instead.
