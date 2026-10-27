# Twenty Twenty-Five in Pressbase

This folder is **Twenty Twenty-Five 1.5**, the default WordPress block theme, by the WordPress team, copied unchanged from WordPress 7.1.3 (`wp-content/themes/twentytwentyfive/`). It is licensed under the GNU General Public License v2 or later, like Pressbase; see `readme.txt` for the theme's own copyright and the licenses of its fonts and images.

Pressbase bundles it so a new site has a theme, and to prove that WordPress block themes run unchanged.

Differences from the WordPress copy:

- `package.json` and `package-lock.json` (the theme's development tooling) are left out.
- `functions.php` is kept for reference but **not executed**: Pressbase never runs PHP. Its effects are reproduced by core (see `docs/architecture/themes.md`, "functions.php").
- Patterns (`patterns/*.php`) are read by Pressbase's pattern loader, which converts the few translation and escaping calls they use into text without running PHP.

Upstream: <https://wordpress.org/themes/twentytwentyfive/>
