# Static WordPress assets

Files served by core at WordPress's own URLs (`/wp-includes/…`), so block
themes find them where they expect.

- `wp-includes/css/dist/block-library/style.min.css` is WordPress 7.1.3's
  front-end block stylesheet, copied unchanged from the reference
  `wordpress/wp-includes/css/dist/block-library/style.min.css`.
  GPL-2.0-or-later, © the WordPress contributors.

To update it, copy the same file from a newer WordPress release and run the
theme tests (`pnpm --filter @pressbase/core test`).
