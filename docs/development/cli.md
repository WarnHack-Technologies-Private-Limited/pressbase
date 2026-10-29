# The pressbase CLI

`pressbase` manages a site from a terminal or a script, as [wp-cli](https://wp-cli.org) does for WordPress. It boots Pressbase's kernel in its own process (the way wp-cli loads WordPress), runs one command through core's services, and exits. Command names, flags and output follow wp-cli's; differences are noted below. The design is in [ADR 0014](../adr/0014-pressbase-cli.md); the code is in `packages/cli`.

```sh
pnpm pressbase post list                       # from the repository root (corepack pnpm … works too)
docker exec pressbase pressbase user list      # inside the Docker image (PostgreSQL sites)
pressbase help post create                     # help for any command, or add --help
```

## Which site

The CLI resolves configuration exactly as core does (`apps/core/src/config.ts`): environment variables win, then `<dataDir>/config.json`.

| Setting | Source |
| --- | --- |
| Data folder | `--data-dir=<path>`, else `PRESSBASE_DATA_DIR`, else `.pressbase` in `apps/core` (where `pnpm dev` keeps it). The repository's `.env` is read too, as core's scripts read it. |
| Database | `DATABASE_URL`, else `databaseUrl` in `config.json` |
| Page-cache purges | `PRESSBASE_REVALIDATE_SECRET` and `WEB_URL`, as the server |

Relative paths in arguments (`--data-dir`, files) are relative to where you run the command.

### The built-in database

The built-in database belongs to one process at a time; two processes writing to it would destroy it. Whoever opens it holds `<dataDir>/db.lock`, and the CLI refuses to start while the server holds it:

```
Error: The built-in database is in use by another Pressbase process (the Pressbase server, process 4242). Stop the Pressbase server first, or use PostgreSQL.
```

Stop the server, run the command, start it again. In Docker the server is the container, so stop it and run the image once: `docker run --rm -v pressbase:/data pressbase pressbase post list`. A lock left by a crashed process is taken over automatically (at once on the same machine; after a minute from another container). With PostgreSQL the CLI and the server run side by side.

**Running server, PostgreSQL:** a server keeps settings, plugins and the theme in memory. After a command changes them, the CLI reminds you to restart the server. Content (posts, users, comments) needs no restart.

## Global flags

| Flag | |
| --- | --- |
| `--format=<format>` | `table` (an ASCII table in a terminal, tab-separated when piped, as wp-cli), `json`, `csv`, `yaml`, `ids`, `count`, where a command prints data |
| `--fields=<a,b>` / `--field=<a>` | only these fields / only this field's value, one per line |
| `--user=<id\|login\|email>` | run as this user: their capabilities apply, as on the REST API. Without it the command line is trusted and nothing is checked, as in wp-cli |
| `--yes` | answer yes to confirmations. Without a terminal, commands that confirm stop and ask for `--yes` |
| `--quiet` | hide informational messages and `Success:` lines (data, warnings and errors still print) |
| `--data-dir=<path>` | the site's data folder |
| `--debug` | print the stack when something unexpected fails |
| `--help` | help for a command or group |

Exit code: `0` on success, `1` on an error (`Error: …` on standard error), as wp-cli. Answering "no" to a confirmation exits with `0`.

**Commands that confirm:** `user delete` without `--reassign`, `post delete --force`, `comment delete --force`, `term delete`, `plugin activate` for a plugin asking for permissions, `plugin deactivate --uninstall`, `plugin delete`, `media regenerate` of every image, `search-replace` (not with `--dry-run`), `user application-password delete --all`.

## Commands

### core

| Command | |
| --- | --- |
| `core version [--extra]` | the Pressbase version (`--extra`: data version, Node.js) |
| `core install --url=<url> --title=<title> --admin_user=<login> --admin_email=<email> [--admin_password=<password>] [--timezone=<tz>] [--database-url=<postgres-url> \| --builtin-database] [--discourage-search-engines]` | runs the web installer's code (`installPressbase()`): the administrator, default settings, sample content, `config.json`. Without `--admin_password` a strong one is generated and printed. `--database-url`/`--builtin-database` choose the database when none is configured. Already installed: says so and exits 0 |

```sh
pressbase core install --builtin-database --url=http://localhost:3000 --title="Field notes" \
  --admin_user=admin --admin_email=admin@example.com
```

### db

| Command | |
| --- | --- |
| `db check [--format=json\|yaml]` | connects, lists applied and pending migrations and whether the site is installed. Exits 1 if migrations are pending |
| `db migrate` | applies pending migrations (the server also does this on boot) |

Neither boots the kernel or loads plugins. wp-cli's `db export/import/query` aren't provided: use `pg_dump`/`psql`.

### option

| Command | |
| --- | --- |
| `option get <key> [--format=plaintext\|json\|yaml]` | |
| `option add <key> [<value>] [--format=plaintext\|json] [--autoload=yes\|no]` | fails if it exists |
| `option update <key> [<value>] [--format=plaintext\|json] [--autoload=yes\|no]` | adds it if missing |
| `option delete <key>...` | |
| `option list [--search=<pattern>] [--autoload=on\|off]` | `*` is a wildcard; fields `option_name`, `option_value` (also `option_id`, `autoload`) |

Values are JSON in Pressbase. With `plaintext`, a value is text, except that for a registered setting (`posts_per_page`, `blog_public`…) or an option already holding a number, boolean or JSON, text that reads as that type is stored as it. `--format=json` always parses. A left-out value is read from standard input. Updating a registered setting runs its validation and `sanitize_option_{option}`, as a save in the admin does.

```sh
pressbase option update posts_per_page 5
echo '{"enabled":true}' | pressbase option update my_plugin_settings --format=json
```

### user

| Command | |
| --- | --- |
| `user list [--role=<role>] [--include=<ids>] [--search=<text>]` | fields `ID`, `user_login`, `display_name`, `user_email`, `user_registered`, `roles` (also `user_nicename`, `user_url`, `first_name`, `last_name`, `nickname`, `description`) |
| `user get <user>` | `<user>` is an ID, login or email everywhere |
| `user create <login> <email> [--role=<role>] [--user_pass=<pw>] [--display_name=…] [--user_nicename=…] [--user_url=…] [--first_name=…] [--last_name=…] [--description=…] [--send-email] [--porcelain]` | a generated password is printed |
| `user update <user>... [--user_pass=…] [--user_email=…] [--display_name=…] [--role=<role>] [--skip-email] …` | a new password logs the user out everywhere |
| `user delete <user>... [--reassign=<user>]` | without `--reassign` their posts are deleted (asks first) |
| `user set-role <user> [<role>]` | default: the site's default role. The last administrator can't lose the role |
| `user reset-password <user>... [--skip-email] [--show-password] [--porcelain]` | |
| `user application-password create <user> <app-name> [--app-id=<uuid>] [--porcelain]` | prints the password once |
| `user application-password list <user> [--name=<name>]` | fields `uuid`, `app_id`, `name`, `created`, `last_used`, `last_ip` |
| `user application-password delete <user> [<uuid>...] [--all]` | |

### post

| Command | |
| --- | --- |
| `post list [--post_type=<types>] [--post_status=<statuses>] [--<field>=<value>]` | defaults `post` and `any`. Query arguments: `posts_per_page`, `paged`, `offset`, `s`, `author`, `author__in`, `author__not_in`, `post__in`, `post__not_in`, `name`, `post_parent`, `post_mime_type`, `menu_order`, `has_password`, `orderby`, `order`. Fields: `ID`, `post_title`, `post_name`, `post_date`, `post_status` by default; all WP_Post fields available |
| `post get <id>` | every field |
| `post create [<file>] [--post_type=…] [--post_title=…] [--post_content=…] [--post_status=…] [--post_name=…] [--post_author=<id>] [--post_date=…] [--post_excerpt=…] [--post_parent=…] [--menu_order=…] [--comment_status=…] [--ping_status=…] [--post_password=…] [--post_category=<ids or slugs>] [--tags_input=<names>] [--meta_input=<json>] [--porcelain]` | `<file>` (or `-` for standard input) is the content |
| `post update <id>... [<file>] [--post_title=…] …` | same fields |
| `post delete <id>... [--force]` | to the Trash, or permanently with `--force` |

Writes are validated with the REST API's schema; with `--user`, the REST API's rules apply (publishing needs `publish_posts`, writing as someone else `edit_others_posts`, content is filtered without `unfiltered_html`).

```sh
pressbase post create ./launch.html --post_title="Launch notes" --post_status=publish --porcelain
cat about.html | pressbase post create - --post_type=page --post_title=About
pressbase post delete $(pressbase post list --post_status=trash --format=ids) --force --yes
```

### term, comment

| Command | |
| --- | --- |
| `term list <taxonomy>... [--search=…] [--slug=…] [--parent=<id>] [--hide_empty]` | fields `term_id`, `term_taxonomy_id`, `name`, `slug`, `description`, `parent`, `count` |
| `term create <taxonomy> <name> [--slug=…] [--description=…] [--parent=<id>] [--porcelain]` | |
| `term delete <taxonomy> <term>... [--by=id\|slug]` | |
| `comment list [--status=all\|approve\|hold\|spam\|trash\|any] [--post_id=<id>] [--type=…] [--search=…] [--number=<n>]` | fields `comment_ID`, `comment_post_ID`, `comment_date`, `comment_approved`, `comment_author`, `comment_author_email` |
| `comment approve <id>...`, `comment spam <id>...` | |
| `comment delete <id>... [--force]` | |

### plugin, theme

| Command | |
| --- | --- |
| `plugin list [--status=active\|inactive\|invalid]` | fields `name`, `title`, `status`, `version`, `source` (also `permissions`, `author`, `description`, `error`) |
| `plugin status [<plugin>]` | |
| `plugin activate <plugin>... \| --all` | shows the permissions the plugin asks for and asks to agree (`--yes` agrees) |
| `plugin deactivate <plugin>... \| --all [--uninstall]` | |
| `plugin install <zip> [--activate]` | through the same strict ZIP checks as an upload. No plugin directory or URLs yet |
| `plugin delete <plugin>...` | runs the plugin's `uninstall` |
| `theme list [--status=…]`, `theme activate <theme>` | block themes only |
| `theme install <zip> [--force] [--activate]` | the checks of Appearance → Themes → Upload theme (a safe archive, `style.css` with a `Theme Name`, `templates/index.html`). `--force` replaces a theme installed in the same folder, as wp-cli's does; `--activate` switches to it. Needs `upload_themes`. No theme directory or URLs yet |
| `theme delete <theme>...` | asks first (`--yes` agrees). Not the active theme, its parent or a bundled theme (wp-cli's `--force` for the active theme isn't offered). Needs `delete_themes` |

Everything goes through the plugin manager, so migrations, `activate`/`deactivate`/`uninstall`, the lifecycle hooks, recorded permissions and page-cache purges happen as from the Plugins screen. Theme commands go through `kernel.themes` the same way (see [Themes](../architecture/themes.md#installing-and-deleting-themes)).

### cache, rewrite, cron, media

| Command | |
| --- | --- |
| `cache flush` | purges every page of the public site's cache (`site` tag) through `PRESSBASE_REVALIDATE_SECRET`/`WEB_URL`, the mechanism core uses (`apps/core/src/cache/`). Exits 1 if the public site can't be reached; a warning if the cache is off |
| `rewrite structure <structure> [--category-base=…] [--tag-base=…]` | Settings → Permalinks' code: old addresses keep redirecting |
| `cron event list [--hook=…]` | fields `hook`, `next_run_gmt`, `next_run_relative`, `recurrence` (also `schedule`, `interval`, `timestamp`, `args`) |
| `cron event run <hook>... \| --due-now \| --all` | runs events in this process; recurring ones are rescheduled |
| `cron event delete <hook>...` | |
| `cron schedule list` | |
| `cron test` | fails when events are more than ten minutes late (no job worker running) and lists recent failed jobs. wp-cli tests spawning wp-cron.php; Pressbase has a worker instead |
| `media regenerate [<id>...] [--only-missing] [--skip-delete]` | remakes image sub-sizes from the originals |

### ability and ai

| Command | |
| --- | --- |
| `ability list [--category=…] [--namespace=…]` | fields `name`, `label`, `category`, `description` (also `readonly`, `destructive`, `idempotent`, `show_in_rest`, `plugin`) |
| `ability get <name>` | the ability with its `input_schema` and `output_schema` |
| `ability run <name> [--input=<json>] [--format=json\|yaml\|plaintext]` | runs it through `execute()`: input validated, permission checked for `--user` (full trust without it). `--input=-` reads standard input |
| `ability category list` | |
| `ai test` | sends a tiny prompt to the provider set in Settings → AI; it counts against the daily limit |

See [AI client and Abilities API](../architecture/ai.md).

### search-replace

```
pressbase search-replace <old> <new> [<table>...] [--dry-run] [--include-columns=<cols>] [--skip-columns=<cols>]
                         [--regex] [--regex-flags=<flags>] [--report-changed-only] [--format=table|count]
```

Covers `posts` (`post_title`, `post_content`, `post_excerpt`, `guid`), `postmeta` (`meta_value`), `options` (`option_value`), `comments` (`comment_content`, `comment_author_url`) and `commentmeta`. Revisions are rows of `posts`, so they change too, as in wp-cli. The report has wp-cli's columns; `Type` says whether the column holds JSON.

**JSON stays valid.** wp-cli unserializes PHP data; Pressbase's equivalent is JSON, replaced inside the structure: every string in JSON option and meta values, text that is a whole JSON document, and block attributes in post content (`<!-- wp:image {"url":"…"} -->`, serialised again as WordPress does). Keys never change. Changed options go through the Options API; the page cache is purged.

```sh
pressbase search-replace http://old.example https://new.example --dry-run
pressbase search-replace http://old.example https://new.example --skip-columns=guid --yes
```

## Plugin commands

Plugins add commands with `api.cli.addCommand()`, Pressbase's `WP_CLI::add_command()`. The name is the plugin's slug, optionally followed by subcommand words; it can't take a core command's name. The command exists while the plugin is active, like everything else it registers.

```ts
export default definePlugin((api) => {
  api.cli.addCommand(
    'reading-time estimate',
    async (args, assoc, io) => {
      const post = await api.content.posts.get(Number(args[0]));
      if (!post) io.error(`There’s no post ${args[0]}.`);
      io.success(`${Math.ceil(post.content.split(/\s+/).length / Number(assoc.wpm ?? 200))} minute read.`);
    },
    { shortdesc: 'Estimates a post’s reading time.', synopsis: '<id> [--wpm=<words>]' },
  );
});
```

`args` are the positional arguments and `assoc` the `--key=value` ones (`--flag` is `true`). `io` has `log`, `success`, `warning`, `error` (stops with exit code 1), `formatItems(rows, fields)` (honours `--format`, `--fields`), `confirm(question)` and `user` (the `--user`, or null). A `synopsis` in wp-cli's syntax is checked before the handler runs and shown in `--help`. Plugin commands are listed in `pressbase help`.

## import and export

`pressbase import` and `pressbase export` move content in WordPress's export format (WXR), as `wp import` and `wp export` do. They run core's `importWxr()` and `exportWxr()` in this process, without the job queue, so a big import doesn't depend on the server ([Import and export](../architecture/import-export.md)).

```bash
pressbase import site.xml --user=admin                       # authors become users with the same username; media is downloaded
pressbase import site.xml --user=admin --authors=current --skip=attachment
pressbase export                                             # everything, to <site>.wordpress.<date>.xml here
pressbase export --post_type=page --start_date=2026-01 --dir=backups
pressbase export --stdout > site.xml
```

| Command | Options |
| --- | --- |
| `import <file>...` | `--user` (required, needs `import`), `--authors=create\|current`, `--skip=attachment` |
| `export` | `--dir`, `--stdout`, `--post_type`, `--post_author`, `--category`, `--start_date`, `--end_date`, `--post_status` |

Posts already on the site are skipped, so an import can be run again. Attachments are downloaded from the original site unless `--skip=attachment`; private network addresses are refused unless `PRESSBASE_IMPORT_ALLOW_PRIVATE_HOSTS=1`.

## migrate wordpress

`pressbase migrate wordpress` moves a WordPress site straight from its MySQL or MariaDB database: users with their passwords and roles, every post type, media, comments, menus, SEO meta and settings. It runs core's `migrateFromWordPressDatabase()` in this process ([Migrating from a WordPress database](../architecture/import-export.md#migrating-from-a-wordpress-database), [ADR 0016](../adr/0016-wordpress-database-migration.md)).

```bash
# Count what would be migrated; change nothing
pressbase migrate wordpress --db-url=mysql://reader:secret@localhost/wordpress --dry-run --user=admin
# Migrate, reading files from a local copy of wp-content/uploads
pressbase migrate wordpress --db-url=mysql://reader:secret@localhost/wordpress \
  --uploads=/srv/old-site/wp-content/uploads --user=admin
# The URL from the environment, over TLS; another prefix; no files or comments
PRESSBASE_WP_DB_URL='mysql://reader:secret@db.example:3306/wp?ssl-mode=VERIFY_IDENTITY' \
  pressbase migrate wordpress --prefix=blog_ --skip=attachment,comments --user=admin
```

| Option | What it does |
| --- | --- |
| `--db-url=<url>` | `mysql://user:password@host:3306/database`. TLS with `?ssl-mode=VERIFY_IDENTITY`, `VERIFY_CA` or `REQUIRED` (and `ssl-ca=<file>`). Default: the `PRESSBASE_WP_DB_URL` environment variable, which keeps the password out of shell history. |
| `--prefix=<prefix>` | The table prefix (`$table_prefix` in wp-config.php). Default `wp_`. |
| `--uploads=<path>` | A copy of the old `wp-content/uploads`. Files are read from it instead of downloaded. |
| `--uploads-url=<url>` | Where the old site served uploads from, when it isn't `<siteurl>/wp-content/uploads` (a CDN, a custom `WP_CONTENT_URL`). |
| `--skip=<list>` | Comma-separated: `attachment` (no files), `comments`, `options` (keep this site's settings), or any post type. |
| `--dry-run` | Count users, terms, posts per type and comments, and change nothing. |
| `--user` | Required. Needs `import`, plus `create_users`, `upload_files` and `promote_users` to bring users, files and roles. |

The password is never printed (`mysql://reader:***@localhost/wordpress`), and only `SELECT`s run, in a read-only transaction, so a MySQL user with just `SELECT` is enough. Multisite networks are refused. The report lists what was migrated per post type, the settings carried and refused, post types this site doesn't have, and every error; the exit code is 1 if anything failed. Running it again skips everything already here (users by username or email address, posts, terms, comments, menus).
