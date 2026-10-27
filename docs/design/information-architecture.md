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
| `/admin/{section}`       | Section index (posts, pages, …)                                    |
| `/admin/settings/{page}` | Settings: general, writing, reading, discussion, media, permalinks |

URLs are nouns, lowercase and stable. The equivalent WordPress screens (`edit.php`, `options-general.php`) will redirect here once the public site exists.

## Dashboard

The dashboard answers three questions, in this order:
1. **Is anything wrong?** Warnings, such as search engines being discouraged.
2. **What's the state of my site?** At a glance: posts, drafts, pages, comments, and pending moderation.
3. **What should I do next?** The _Get your site ready_ checklist, _Recently edited_, _Site health_.

## Settings

Settings follow WordPress's screens one to one: General, Writing, Reading, Discussion, Media, Permalinks. Inside a screen, fields are grouped into cards by the question the user is answering (_Site identity_, _Address and contact_, _Date and time_), not by storage.
