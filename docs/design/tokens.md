# Design tokens

Tokens are CSS custom properties defined in `apps/admin/src/app/globals.css`. Components use **semantic** tokens (`--color-text-muted`), never raw values, so dark mode and future admin colour schemes only need to redefine tokens.

> Changing a token? Update this page in the same pull request, and check contrast in **both** themes.

## Colour

| Token                       | Light                 | Dark                  | Use                                                               |
| --------------------------- | --------------------- | --------------------- | ----------------------------------------------------------------- |
| `--color-canvas`            | `#f6f6f3`             | `#121211`             | App background (warm neutral, easy on the eyes for long sessions) |
| `--color-surface`           | `#ffffff`             | `#1a1a19`             | Cards, inputs, sidebar                                            |
| `--color-surface-sunken`    | `#f0f0ec`             | `#151514`             | Wells, segmented controls                                         |
| `--color-surface-hover`     | `#f3f3ef`             | `#232321`             | Hover on neutral items                                            |
| `--color-border`            | `#e2e2dc`             | `#2c2c2a`             | Dividers, card edges                                              |
| `--color-border-strong`     | `#c7c7c0`             | `#45453f`             | Input borders                                                     |
| `--color-text`              | `#1b1b19`             | `#ededea`             | Body text                                                         |
| `--color-text-muted`        | `#5c5c57`             | `#a9a9a2`             | Secondary text (≥ 4.5:1 on surface)                               |
| `--color-text-subtle`       | `#73736d`             | `#8e8e87`             | Meta and placeholders (≥ 4.5:1 on surface)                        |
| `--color-accent`            | `#3b4cca`             | `#5b6cf0`             | Primary actions, focus, selection                                 |
| `--color-accent-soft`       | `#eef0fd`             | `#23264a`             | Selected backgrounds                                              |
| `--color-accent-text`       | `#3343c0`             | `#a3adff`             | Links, active nav text                                            |
| `--color-success` / `-soft` | `#1a7f4b` / `#e7f5ed` | `#4cc283` / `#15291e` | Confirmation                                                      |
| `--color-warning` / `-soft` | `#8a5a00` / `#fdf4dc` | `#e2b44b` / `#2c2412` | Needs attention, not broken                                       |
| `--color-danger` / `-soft`  | `#c22f2a` / `#fcebea` | `#ff7b73` / `#331816` | Errors, destructive actions                                       |

**Rules**
- The accent is for action and focus only. Don't use it decoratively.
- Status colour never stands alone. Pair it with an icon or text, for colour-blind users.
- Dark mode follows the OS (`prefers-color-scheme`). `data-theme="light|dark"` on `<html>` overrides it.

### Choosing light or dark

People choose **System**, **Light** or **Dark** under *Theme* in the user menu (top right). The items are `menuitemradio`s: arrow keys, Home and End move through the menu, Enter or Space picks, Escape closes it.

- **System** removes `data-theme`, so the OS decides. **Light** and **Dark** set it.
- The choice is saved per user in core (the `pressbase_admin_color_scheme` user meta, through `POST /wp/v2/users/me`), so it follows the person to other browsers, and mirrored in `localStorage` (`pressbase-admin-color-scheme`).
- **No flash of the wrong theme.** An inline script in the root layout's `<head>` applies the `localStorage` copy before the first paint, on every screen including login and the installer. On admin pages a second inline script applies the account's saved choice and refreshes the mirror, so a new browser gets it right on the first load too. Storage access is wrapped in `try`/`catch`; when it's blocked, the account's choice still applies. The code is in `apps/admin/src/lib/color-scheme.ts`.
- Changing a token still means checking contrast in both themes, whichever one you use.

## Typography

System font stack (`--font-sans`): no web-font download, native feel on every OS. Monospace (`--font-mono`) is for code, URLs and format strings.

| Token        | Size | Use                                                                 |
| ------------ | ---- | ------------------------------------------------------------------- |
| `--text-xs`  | 12px | Badges, group labels                                                |
| `--text-sm`  | 13px | Hints, meta, table secondary text                                   |
| `--text-md`  | 14px | Admin body (the default)                                            |
| `--text-lg`  | 16px | Lead text, card titles; inputs on touch screens (prevents iOS zoom) |
| `--text-xl`  | 20px | Section headings                                                    |
| `--text-2xl` | 24px | Page titles                                                         |
| `--text-3xl` | 30px | Big numbers                                                         |

Weights: 400 (regular), 500 (medium: labels, buttons), 600 (semibold: headings). Headings use `text-wrap: balance`.

## Spacing

A 4px grid: `--space-1` (4px), `--space-2` (8), `--space-3` (12), `--space-4` (16), `--space-5` (20), `--space-6` (24), `--space-8` (32), `--space-10` (40), `--space-12` (48), `--space-16` (64).

Typical gaps:
- 8px: a label and its control;
- 20px: between fields;
- 24px: between cards and around card content;
- 32px: below the page header.

## Shape and depth

- Radii: `--radius-sm` 6px (small controls), `--radius-md` 8px (inputs, buttons), `--radius-lg` 12px (cards, panels), `--radius-full` (pills, avatars).
- Controls: `--control-height` 40px, `--control-height-sm` 32px. Both exceed the WCAG 2.2 target-size minimum of 24px.
- Shadows: `--shadow-xs` resting cards, `--shadow-sm` raised segments, `--shadow-md` floating panels, `--shadow-lg` menus, drawers, save bar.

## Motion

- `--duration-fast` (120ms) for hover and press; `--duration-base` (200ms) for entering and leaving.
- Easing: `--ease-out`.
- Both become 0 under `prefers-reduced-motion`.
- Motion explains a change (a panel rising into view). It never decorates.

## Focus

`--focus-ring` draws a 2px gap and then a 2px accent ring. It's applied to `:focus-visible` globally, so never remove it without replacing it.
