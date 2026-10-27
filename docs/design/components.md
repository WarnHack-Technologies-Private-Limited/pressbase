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

- **AdminShell:** sidebar, top bar with the user menu, skip link. Below 860px the sidebar becomes a drawer (made `inert` while closed). Escape closes the drawer and menus.
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
