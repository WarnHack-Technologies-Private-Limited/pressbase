# Components

The kit lives in `apps/admin/src/components/ui/`. Use these before writing new markup. If something is missing, add it here, documented, rather than styling inline.

## Button: `ui/button.tsx`

```tsx
<Button variant="primary" loading={busy}>Save changes</Button>
<ButtonLink href="/admin" variant="secondary">Back to the dashboard</ButtonLink>
```

| Variant     | When                                               |
| ----------- | -------------------------------------------------- |
| `primary`   | The single main action on a screen or form.        |
| `secondary` | Other actions. This is the default.                |
| `ghost`     | Low-emphasis actions: Back, Discard, icon buttons. |
| `danger`    | Destructive actions. Always confirm first.         |

- `loading` disables the button, shows a spinner and sets `aria-busy`. Change the label to an "-ing" verb ("Saving…").
- An icon-only button must have an `aria-label`.

## Fields: `ui/field.tsx`

`TextField`, `SelectField`, `PasswordField` and `Checkbox` connect the label, hint and error for assistive technology (`aria-describedby`, `aria-invalid`).

```tsx
<TextField label="Email" type="email" value={email} onChange={…}
  hint="Never shown publicly." error={errors.email} />
```

`TextAreaField` is the multi-line version, for captions and descriptions.

- Fields are required by default. Mark the exceptions with `optional`, which shows "(optional)". Required is the norm, so we don't put asterisks everywhere.
- The hint explains; the error corrects. Both can show at once.
- `PasswordField isNew` adds generate, copy and a strength meter. Pass `context` (username, email) so passwords built from personal details are rated weak.

## Notice: `ui/surface.tsx`

```tsx
<Notice tone="danger" title="The database server refused the connection.">
  Check that PostgreSQL is running and that the host and port are right.
</Notice>
```

- Tones: `info`, `success`, `warning`, `danger`.
- `danger` uses `role="alert"`; the others use `role="status"`.
- The title says what happened; the body says what to do.

## Card, Badge, EmptyState, Logo: `ui/surface.tsx`

- **Card:** a titled section of a page. Use the `description` prop for a one-line explanation and `actions` for a badge or a small button.
- **Badge:** short status labels ("Recommended", "Coming in v0.2"). Tones: `accent`, `success`, `warning`, or neutral.
- **EmptyState:** an icon, a title, one or two sentences and one action. Use it for empty lists and unbuilt sections. It always offers a way forward.

## Shell: `components/shell/`

- **AdminShell:** sidebar, top bar with the user menu (Profile, Theme: System / Light / Dark, Log out; a WAI-ARIA menu with arrow-key navigation), skip link. Below 860px the sidebar becomes a drawer (made `inert` while closed). Escape closes the drawer and menus.
- **PageHeader:** the page `h1`, an optional description, and actions on the right.

## Patterns

| Pattern           | Where                     | Notes                                                                                               |
| ----------------- | ------------------------- | --------------------------------------------------------------------------------------------------- |
| Stepper           | Installer                 | `aria-current="step"`; focus moves to each new step's heading.                                      |
| Radio cards       | Installer database choice | A real `<input type="radio">` inside a `<label>`, so the keyboard and screen readers just work.     |
| Segmented control | Installer "details / URL" | A `<fieldset>` of buttons with `aria-pressed`.                                                      |
| Save bar          | Settings                  | Appears only when the form is dirty. Discard and Save. Warns before unloading the page.             |
| Toast             | Settings                  | Confirms a background action. Polite live region, gone after 3s, never the only record of an error. |
| Format picker     | Settings, date and time   | Each preset shows a live example plus its format code. "Custom" takes free text.                    |

## Dialog: `ui/dialog.tsx`

`ConfirmDialog` asks before anything destructive or hard to undo: "Delete permanently?", "Switch to draft?", "Leave without saving?".

- It's built on `<dialog>`, so focus trapping, Escape and the backdrop come from the browser.
- **Focus starts on Cancel**, so a stray Enter never destroys anything.
- The title asks the question. The body says what will happen, in one sentence.

## Toast: `ui/toast.tsx`

`useToast()` is available on every admin screen (the provider lives in `AdminShell`).

```tsx
toast('1 post moved to the Trash.', { action: { label: 'Undo', onClick: restore } });
toast('Could not save.', { tone: 'danger' });
```

- Use it for **outcomes of actions**, not for errors on forms; those go next to their fields.
- Offer **Undo** instead of a confirmation whenever the action is reversible (trashing is; permanent deletion isn't).
- Toasts with an action stay for 8s, others for 4s.

## Content screens: `components/content/`

| Component | Pattern |
|---|---|
| `PostList` | Status tabs with counts. Search, plus a category filter for posts. Row actions appear on hover or focus, and always on touch. Bulk selection reveals a bulk bar. Pages show as an indented tree. Filters live in the URL, so views can be shared. |
| `PostEditor` | Sticky action bar: back, status badge, save state, a secondary action and one primary action whose label says exactly what will happen (Publish / Schedule / Update / Submit for review), and a Settings toggle. The canvas is the block editor (below) with a **Code** view for raw markup. A sidebar with **Post** and **Block** tabs; the Block tab opens when a block is selected. ⌘/Ctrl+S saves, from inside the canvas too. A warning before leaving with unsaved changes. A newer autosave or browser copy is offered back in a calm notice (Restore / Dismiss), never a modal. |
| `TagInput` | ARIA combobox: type, then Enter or comma; arrow keys move through suggestions; Backspace removes the last tag. New tags are created on save. |
| `TermsScreen` | Add form on the left, table on the right, inline editing in place. |
| `CommentsScreen` (`components/comments/`) | Status tabs with a warning-coloured Pending count. Pending rows carry a "Pending" label and a warning edge (never colour alone). Author column with initials avatar, email and IP. Row actions change with the status (Approve / Unapprove, Reply, Quick edit, Spam, Trash; Not spam, Restore, Delete permanently). Reply and Quick edit open in place; Escape cancels, ⌘/Ctrl+Enter submits. Every status change ends in a toast with Undo; permanent deletion asks first. On phones, rows stack: author over comment, with the post and date folded in. |

## Media: `components/media/`

| Component | Pattern |
|---|---|
| `MediaLibrary` | Thumbnail grid with type filter and search in the URL, "Load more", an upload button and drop-anywhere uploads. Each upload shows its own progress; errors stay until dismissed, and a finished batch ends in a toast. |
| `MediaGrid` | One tab stop for the whole grid; arrow keys, Home and End move between tiles. Each tile is a button named by the title, type and dimensions. |
| `MediaDetails` | `<dialog>`: preview, file facts, URL with Copy, editable alt text / title / caption / description with an explicit Save, and *Delete permanently* behind a `ConfirmDialog`. Arrow keys page between items. Closing with unsaved changes asks first. Full screen on phones. |
| `MediaPicker` | Choose one item or upload one (it's then selected). `allowedTypes` limits the kinds; `title` and `selectLabel` name the task ("Set featured image"). Double-click chooses at once. With `multiple`, several items are picked in order (numbered tiles, "N selected" footer with **Clear**, Shift+click for a range), and `multipleLabel(n)` names the button ("Create gallery (3)"). |

## Appearance: `components/appearance/`

| Component | Pattern |
|---|---|
| `AppearanceSubnav` | Themes · Styles · Menus tabs (`aria-current="page"`), each shown only with its capability. |
| `MenuEditor` | One menu at a time: a select to switch (asks before discarding changes), **New menu**, the name, and **Use in the header** (or an "In the header" badge). The structure is a tree of item rows: a drag handle, then the label with its type ("Page", "Custom link · Opens in a new tab") as a disclosure button. The handle moves the item with the arrow keys (↑ ↓ among siblings, → into the submenu above, ← out), and the open panel has the same moves as labelled buttons ("Into submenu of “About”"), WordPress's classic menu pattern. Drop targets show a line (before, after) or an outline (inside). Moves are announced politely and focus stays on the control used. Removing an item offers Undo. Save bar as in Settings; **Delete menu** asks first. Empty state: **Create a menu from your pages**. |
| *Add items* card | Segmented tabs (Pages, Posts, Categories, Link) with arrow-key navigation; search results as checkboxes and one **Add to menu** button; custom links validate the address (web, path, `mailto:`, `tel:`) next to the field. Sticky beside the menu on wide screens. |
| `MenuPreview` | The site's header with the unsaved menu, in a sandboxed frame scaled from a 1280px (desktop) or 390px (mobile) viewport; a Desktop/Mobile segmented control (`aria-pressed`). Links are inert; the menu button works, so the overlay can be tried. |
| `ThemeList` | Theme cards; the active block theme offers **Edit styles**. |
| `StylesEditor` | A controls panel (23rem) beside the preview, wider than the usual 1080px column. The panel's head shows the save state ("Unsaved changes" with a dot, or "Saved" with a check, in a polite live region) with *Discard* and the one primary button, **Save**. Below, an ARIA tablist (arrow keys, Home, End): **Styles**, **Colours**, **Type**, **Layout**, **History**. The footer holds *Reset to theme defaults* and a link to the logo and icon. A warning before leaving with unsaved changes. Below 900px the preview sits on top and the tabs stick under the top bar. |
| Variation cards | Toggle buttons (`aria-pressed`) drawn like the site editor's style previews: the variation's background, a large "Aa" in its heading font and text colour, and up to three accent dots. The selected card gets an accent ring and a check badge — never colour alone. Palettes are strips of five colours; font pairings show "Aa Aa" in the heading and body fonts. The theme's fonts are loaded for the cards from the theme folder. |
| Colour roles | Background, Text and Accent: a `<fieldset>` each, with the current colour's swatch, name and hex as its legend, palette swatches as real radio inputs, and a native colour picker for any other colour. Choosing an accent also picks the button text colour that reads best on it. A contrast line under the roles ("Text on background: 12.6:1 — easy to read" or a warning icon with "hard to read (aim for 4.5:1 or more)"). The palette list edits each theme colour in place. |
| Type and layout | Heading and body font selects with a live sample; base size as a segmented control of the theme's sizes plus a slider; content and wide widths as sliders with "Use the theme's 645px" to undo. |
| History | Saved versions, newest first, with date, author and "Theme defaults" / "Custom styles"; **Preview** loads one into the preview, and Save restores it. |
| `StylePreview` | The real public page rendered with the unsaved styles (core's preview endpoint), debounced. Two frames take turns so updates never flash; the scroll position is kept. Desktop / Tablet / Phone sizes (scaled to fit); links and search stay inside the preview; "Open page" opens the live page. |

## Site Health: `components/site-health/`

| Component | Pattern |
|---|---|
| `StatusScreen` | A *Site health status* card with a score ring and the rating in words ("Good", "Should be improved", or "Results are still loading…" with a spinner and how many tests are left), never colour alone. Then a card per group, *N critical issues* and *N recommended improvements*, each with a one-line intro, and **Passed tests** (a disclosure button, `aria-expanded`) for the rest. **Check again** reruns everything. When the tests finish, a polite live region says so. |
| `AccordionItem` | A heading holding a full-width button (`aria-expanded`, `aria-controls`) and its panel. Status items show an icon with a text label (Critical, Recommended, Passed), the title, and the category badge (Security, Performance, Privacy). |
| `InfoScreen` | An intro card with **Copy site info to clipboard** (a toast confirms; "Copied!" shows beside the button for 3 seconds), then every section as a collapsed accordion item with a two-column table that stacks on phones. Private values carry a "Not copied" badge. Directory sizes fill in after the page loads. |
| `SiteHealthSummary` | The Dashboard's *Site health* card: the last rating with its icon, WordPress's sentence, "Take a look at the N items on the Site Health screen" and when it was checked. Before any check: "No information yet…". |

## Settings: site identity

`SiteLogoField` and `SiteIconField` (`components/settings/site-identity-fields.tsx`) sit in General → *Site identity*: a `<fieldset>` each, choosing an image with `MediaPicker`. The logo shows on a sunken, dashed-when-empty well; the icon previews at real size in a browser-tab mock and as a phone home-screen tile, and notes images that aren't square (the centre is used) or are smaller than 512 px. Both save with the rest of the form.

## People: `components/people/`

| Component | Pattern |
|---|---|
| `UserList` | Role tabs with counts, search, initials avatars. Row actions: Edit, Delete. Bulk: change role, delete. You can't select or delete yourself here. |
| `DeleteUsersDialog` | `ConfirmDialog` with a choice: give the content to another user (the default, preselected) or delete it too. |
| `UserEditor` | Profile and Edit user: role radio cards, name with a display-name chooser, contact, bio, password (hidden behind "Set a new password"), application passwords, and a separate danger card for deletion. Save bar as in Settings. |
| `ApplicationPasswords` | Create with a name; the new password appears once in a warning-toned box with Copy, and focus moves to it. List with created / last used / last IP; Revoke asks first. |
| `LostPasswordForm`, `ResetPasswordForm` | `AuthLayout` screens. The reset link is checked before the form appears; expired or used links say so and offer a new one. |

## Block editor: `components/block-editor/`

Gutenberg inside Pressbase's chrome. Architecture and wiring: [Block editor](../architecture/block-editor.md).

- **Layout.** The editor fills the viewport under the action bar; the canvas and the sidebar scroll on their own, like WordPress. The title sits inside the canvas, in the content's typeface, so the page reads like what will be published.
- **Our toolbar, their tools.** The editor toolbar (Add block, Undo, Redo, List view, word count, Visual/Code) is built from our `Button`s and follows the admin theme. Gutenberg's own UI (block toolbar, inserter, list view, inspector, popovers) keeps its familiar look, with our accent colour and softer radii.
- **Light islands in dark mode.** WordPress's components are light-only, and the canvas previews content in the colours readers see. So the canvas, the inserter and list view panels, the Block tab and every popover stay light in dark mode. They're framed as paper on a dark desk, not themed halfway. The `lightScope` class (exported by the block editor) re-declares the light tokens for any container of WordPress UI.
- **Panels.** Add block and List view open a panel on the canvas's left edge: beside the canvas when there's room, over it when there isn't. Opening moves focus into the panel (search field / tree); Escape closes it and returns focus to its toggle. Choosing a block closes the inserter and focuses the new block.
- **Narrow screens.** Below 1100px the sidebar is a drawer from the right, opened with the Settings toggle and closed with Escape or its close button. Below 480px the canvas runs edge to edge.
- **Unavailable features are hidden, not broken.** Blocks that need server pieces that aren't there yet are left out of the inserter; uploads without a media library explain what to do instead ("Use “Insert from URL” instead").
