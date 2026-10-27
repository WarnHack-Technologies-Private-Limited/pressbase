# Accessibility

**Standard: WCAG 2.2 level AA**, for every screen in the admin and in default themes. Accessibility is part of "done", not a later pass.

## Built into the system

- **Contrast.** Text tokens reach at least 4.5:1 on their surfaces, in both themes.
- **Focus.** A visible `--focus-ring` on every interactive element (`:focus-visible`).
- **Targets.** Controls are 40px tall (32px small), above the 24px minimum.
- **Forms.**
  - Labels are real `<label>` elements.
  - Hints and errors are linked with `aria-describedby`; invalid fields get `aria-invalid`.
  - On submit with errors, focus moves to the first invalid field.
- **Announcements.**
  - Danger notices use `role="alert"`.
  - Status messages and toasts use polite live regions.
  - Multi-step flows move focus to the new step's heading.
- **Structure.**
  - A skip link.
  - Landmarks: `nav`, `main`, labelled `aside` and `section`.
  - One `h1` per page and no skipped heading levels.
  - Current page and step are marked with `aria-current`.
- **Motion.** Every transition respects `prefers-reduced-motion`.
- **Zoom.** Inputs are 16px on touch screens, so iOS doesn't zoom on focus. Layouts reflow at 320px wide without horizontal scrolling.

## Review checklist for UI pull requests

- [ ] Every action can be done with the **keyboard alone**, in a logical tab order, with no traps (Escape closes overlays).
- [ ] **Focus is always visible**, and lands somewhere sensible after dialogs, navigation and errors.
- [ ] Every form control has a **label**. Errors are tied to their fields and announced.
- [ ] Icon-only buttons have an **`aria-label`**. Decorative icons have `aria-hidden="true"`.
- [ ] Information is **never conveyed by colour alone**.
- [ ] Checked in **light and dark** mode, at **320px** and at **200% zoom**.
- [ ] A screen reader (VoiceOver, NVDA or Orca) reads the change in an order that makes sense.
- [ ] Animations stop under **reduced motion**.
