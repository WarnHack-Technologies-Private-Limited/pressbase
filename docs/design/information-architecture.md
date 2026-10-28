# Information architecture

## Admin navigation

Pressbase keeps WordPress's menu **order**, so muscle memory transfers, and adds **group labels**, so a long flat list becomes scannable. The source of truth is `apps/admin/src/lib/sections.ts`.

| Group   | Items (WordPress order)       | Capability to see it                                            |
| ------- | ----------------------------- | --------------------------------------------------------------- |
| —       | Dashboard                     | `read`                                                          |
| Content | Posts, Pages, Media, Comments | `edit_posts`, `edit_pages`, `upload_files`, `moderate_comments` |
| Design  | Appearance                    | `switch_themes`                                                 |
| Extend  | Plugins                       | `activate_plugins`                                              |
| Manage  | Users, Tools, Settings        | `list_users`, `edit_posts`, `manage_options`                    |

WordPress puts Media between Posts and Pages. Pressbase puts it after Pages, so the two _writing_ destinations sit together. This is the only reordering, and it's deliberate.

Items the user can't access are **hidden, not disabled**, as in WordPress. Items not yet built **are shown**, with their release badge, and lead to an explanatory empty state.

## URL structure

| URL                      | Screen                                                             |
| ------------------------ | ------------------------------------------------------------------ |
| `/install`               | Installer (redirects to `/admin` once installed)                   |
| `/login`                 | Login (supports `?redirect_to=/admin/...`)                         |
| `/admin`                 | Dashboard                                                          |
| `/admin/posts`, `/admin/pages` | Lists. Filters in the URL: `?status=draft&s=launch&cat=3&paged=2` |
| `/admin/posts/new`, `/admin/posts/{id}` | The editor (same for pages)                                    |
| `/admin/posts/categories`, `/admin/posts/tags` | Taxonomy management, reached through the Posts sub-navigation |
| `/admin/media`           | Media library. Filters in the URL: `?type=image&s=beach`           |
| `/admin/users`           | Users. Filters in the URL: `?role=editor&s=grace&paged=2`          |
| `/admin/users/new`, `/admin/users/{id}` | Add user, edit user (your own account redirects to Profile) |
| `/admin/profile`         | Your profile and application passwords (from the user menu)        |
| `/lost-password`, `/reset-password?key=…&login=…` | Forgot your password, choose a new one (linked from `/login`) |
| `/admin/comments`        | Comments. Filters in the URL: `?comment_status=moderated&s=spam&paged=2`; `?c=12` opens one comment for editing (themes' "Edit" links) |
| `/admin/appearance`      | Themes (WordPress's `themes.php`)                                  |
| `/admin/appearance/styles` | Styles: style variations, colours, type and layout with a live preview, and revisions (`edit_theme_options`). Reached from the Appearance tabs and the active theme's *Edit styles* button |
| `/admin/{section}`       | Sections that aren't built yet show what's coming                  |
| `/admin/settings/{page}` | Settings: general, writing, reading, discussion, media, permalinks |

URLs are nouns, lowercase and stable. The equivalent WordPress screens (`edit.php`, `options-general.php`) will redirect here once the public site exists.

## Dashboard

The dashboard answers three questions, in this order:
1. **Is anything wrong?** Warnings, such as search engines being discouraged.
2. **What's the state of my site?** At a glance: posts, drafts, pages, comments, and pending moderation. "N awaiting moderation" links to the Pending tab.
3. **What should I do next?** The _Get your site ready_ checklist, _Recently edited_, _Site health_, and for moderators _Recent comments_ (beside _Recently edited_, like WordPress's Activity widget).

## Settings

Settings follow WordPress's screens one to one: General, Writing, Reading, Discussion, Media, Permalinks. Inside a screen, fields are grouped into cards by the question the user is answering (_Site identity_, _Address and contact_, _Date and time_), not by storage.

## Appearance

Appearance has tabs, like Posts: **Themes** and **Styles** (more Appearance screens add theirs). Themes is where you choose a theme; Styles is where you tune the one you have.

**Styles** answers "how does my site look?" in WordPress's own vocabulary (style variations, palette, typography, layout), but on one screen instead of the site editor's drill-down panels: a controls panel beside a preview of the real public site. The panel has five tabs, ordered from the broadest choice to the finest: _Styles_ (complete looks), _Colours_, _Type_, _Layout_, _History_. Nothing goes live until **Save**; _Discard_ returns to what's live, _Reset to theme defaults_ to the theme's own styles, and _History_ brings back any saved version (into the preview first, then Save).

**Where site identity lives.** The logo and site icon are in **Settings → General**, in the _Site identity_ card beside the site title and tagline. They describe the site, not the theme: they survive a theme switch, the icon also shows in the admin and in browser tabs, and WordPress puts the site icon on its General settings screen too (the logo lived in the Customizer's "Site Identity" panel, next to title and tagline). They need `manage_options`, like the rest of General. The Styles screen links there from its footer, so someone tuning the look finds them in one step.
