import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PURGE_ACTION } from '@pressbase/core/src/cache/invalidation';
import { CacheTag } from '@pressbase/core/src/cache/tags';
import {
  permalinkSettings,
  permalinkSettingsInput,
  savePermalinkSettings,
} from '@pressbase/core/src/content/permalinks';
import { ThemeError } from '@pressbase/core/src/themes/install';
import { CliError, type CommandSpec } from '../command';
import { service } from './shared';

/**
 * `pressbase theme`, `pressbase cache` and `pressbase rewrite`: the
 * site-wide switches. Each goes through the same core code as the admin.
 */

export const themeCommands: CommandSpec[] = [
  {
    name: 'theme list',
    shortdesc: 'Lists installed themes.',
    synopsis: '[--status=<status>] [--fields=<fields>] [--field=<field>] [--format=<format>]',
    options: { status: 'Only themes with this status.' },
    choices: { status: ['active', 'parent', 'inactive'] },
    examples: [['pressbase theme list', 'List themes']],
    needs: 'installed',
    async run(ctx) {
      await ctx.require(
        'switch_themes',
        undefined,
        `${ctx.user?.login} isn’t allowed to manage themes.`,
      );
      const active = await ctx.kernel.themes.active();
      const stylesheet = active.info.stylesheet;
      const template = active.info.template;
      const status = ctx.string('status');
      const items = (await ctx.kernel.themes.all())
        .map((t) => ({
          name: t.stylesheet,
          title: t.name,
          status:
            t.stylesheet === stylesheet
              ? 'active'
              : t.stylesheet === template
                ? 'parent'
                : 'inactive',
          version: t.version,
          author: t.author,
          block_theme: t.isBlockTheme,
        }))
        .filter((t) => !status || t.status === status);
      ctx.formatItems(items, ['name', 'status', 'version', 'title'], {
        all: ['name', 'title', 'status', 'version', 'author', 'block_theme'],
        idField: 'name',
      });
    },
  },
  {
    name: 'theme activate',
    shortdesc: 'Switches the site to another theme.',
    synopsis: '<theme>',
    options: { theme: 'The theme’s folder name (see “pressbase theme list”).' },
    examples: [['pressbase theme activate pressbase', 'Switch theme']],
    needs: 'installed',
    async run(ctx) {
      await ctx.require(
        'switch_themes',
        undefined,
        `${ctx.user?.login} isn’t allowed to switch themes.`,
      );
      const [name = ''] = ctx.args;
      const theme = await ctx.kernel.themes.get(name);
      if (!theme)
        return ctx.error(
          `There’s no theme “${name}”. “pressbase theme list” shows the installed ones.`,
        );
      if (!theme.isBlockTheme) {
        ctx.error(
          `${theme.name} isn’t a block theme (it has no templates/index.html), and Pressbase only runs block themes.`,
        );
      }
      if ((await ctx.kernel.themes.activeStylesheet()) === theme.stylesheet) {
        ctx.warning(`The '${theme.name}' theme is already active.`);
        return;
      }
      await ctx.kernel.themes.activate(theme.stylesheet);
      ctx.changedServerState();
      ctx.success(`Switched to '${theme.name}' theme.`);
    },
  },
  {
    name: 'theme install',
    shortdesc: 'Installs a block theme from a .zip file.',
    synopsis: '<zip> [--force] [--activate]',
    options: {
      zip: 'Path to the theme’s .zip. The theme sits at its root or in one top-level folder.',
      force: 'Replace a theme already installed with the same folder name.',
      activate: 'Activate it once installed.',
    },
    longdesc:
      'Goes through the same checks as Appearance → Themes → Upload theme: a safe archive, a style.css with a Theme Name, and templates/index.html (Pressbase runs block themes only). There is no theme directory to download from yet, so give a file.',
    examples: [
      ['pressbase theme install ./sunny.zip --activate', 'Install and activate'],
      ['pressbase theme install ./sunny-1.1.zip --force', 'Replace the installed copy'],
    ],
    needs: 'installed',
    async run(ctx) {
      await ctx.require(
        'upload_themes',
        undefined,
        `${ctx.user?.login} isn’t allowed to install themes.`,
      );
      const [file = ''] = ctx.args;
      if (/^https?:\/\//.test(file)) {
        ctx.error('Installing from a URL isn’t supported. Download the .zip and give its path.');
      }
      let data: Uint8Array;
      try {
        data = await readFile(ctx.resolvePath(file));
      } catch {
        ctx.error(`There’s no file at ${ctx.resolvePath(file)}.`);
      }
      const force = ctx.flag('force');
      const { theme, replaced } = await service(async () => {
        try {
          return await ctx.kernel.themes.install(data, {
            overwrite: force,
            filename: path.basename(file),
          });
        } catch (error) {
          if (error instanceof ThemeError && error.code === 'folder_exists') {
            throw new CliError(
              `${error.message.replace(/ Replace it.+$/, '')} Add --force to replace it.`,
            );
          }
          throw error;
        }
      });
      ctx.log(
        replaced
          ? `Replaced ${theme.name} with version ${theme.version || '—'} (${theme.stylesheet}).`
          : `Installed ${theme.name} ${theme.version} (${theme.stylesheet}).`,
      );
      if (replaced) ctx.changedServerState();
      if (ctx.flag('activate')) {
        await ctx.require(
          'switch_themes',
          undefined,
          `${ctx.user?.login} isn’t allowed to switch themes.`,
        );
        if ((await ctx.kernel.themes.activeStylesheet()) === theme.stylesheet) {
          ctx.warning(`The '${theme.name}' theme is already active.`);
        } else {
          await ctx.kernel.themes.activate(theme.stylesheet);
          ctx.changedServerState();
          ctx.log(`Switched to '${theme.name}' theme.`);
        }
      }
      ctx.success('Installed 1 of 1 themes.');
    },
  },
  {
    name: 'theme delete',
    shortdesc: 'Deletes installed themes.',
    synopsis: '<theme>...',
    options: { theme: 'The themes’ folder names (see “pressbase theme list”).' },
    longdesc:
      'Asks first, unless --yes. The active theme, the active child theme’s parent and themes bundled with Pressbase can’t be deleted (wp-cli’s --force for the active theme isn’t offered). The theme’s saved styles stay, as in WordPress.',
    examples: [['pressbase theme delete sunny --yes', 'Delete a theme']],
    needs: 'installed',
    async run(ctx) {
      await ctx.require(
        'delete_themes',
        undefined,
        `${ctx.user?.login} isn’t allowed to delete themes.`,
      );
      if (!ctx.args.length) ctx.error('Give the themes to delete.');
      await ctx.confirm(`Delete ${ctx.args.join(', ')}? Their files are removed.`);
      let done = 0;
      for (const slug of ctx.args) {
        try {
          await ctx.kernel.themes.delete(slug);
          ctx.log(`Deleted '${slug}' theme.`);
          done += 1;
        } catch (error) {
          ctx.warning(
            error instanceof ThemeError && error.code === 'rest_theme_not_found'
              ? `There’s no theme “${slug}”.`
              : (error as Error).message,
          );
        }
      }
      // wp-cli's report_batch_operation_results(): always the plural noun.
      const message = `Deleted ${done} of ${ctx.args.length} themes.`;
      if (done < ctx.args.length) ctx.error(message);
      ctx.success(message);
    },
  },
];

export const cacheCommands: CommandSpec[] = [
  {
    name: 'cache flush',
    shortdesc: 'Empties the public site’s page cache.',
    longdesc:
      'Sends the same purge core sends when settings change: every cached page (the `site` tag) goes, through PRESSBASE_REVALIDATE_SECRET and WEB_URL as the server is configured. Without that secret the public site doesn’t cache pages, so there’s nothing to flush.',
    examples: [['pressbase cache flush', 'Empty the page cache']],
    needs: 'installed',
    async run(ctx) {
      await ctx.require(
        'manage_options',
        undefined,
        `${ctx.user?.login} isn’t allowed to flush the cache.`,
      );
      const revalidate = ctx.kernel.config.revalidate;
      if (!revalidate) {
        ctx.warning(
          'The public site’s page cache is off (PRESSBASE_REVALIDATE_SECRET isn’t set), so there’s nothing to flush.',
        );
        return;
      }
      await ctx.kernel.hooks.doAction(PURGE_ACTION, [CacheTag.site], 'cli');
      const problems = await ctx.flushPurges();
      if (problems.length) {
        ctx.error(
          `The page cache couldn’t be flushed. Check that the public site is running at ${revalidate.urls.join(', ')} (WEB_URL).`,
        );
      }
      ctx.success('Flushed the public site’s page cache.');
    },
  },
];

export const rewriteCommands: CommandSpec[] = [
  {
    name: 'rewrite structure',
    shortdesc: 'Sets the permalink structure, as Settings → Permalinks does.',
    synopsis: '<permastruct> [--category-base=<base>] [--tag-base=<base>]',
    options: {
      permastruct:
        'The structure, with tags like %year%, %monthnum%, %postname% and %post_id%. An empty string uses plain ?p=123 addresses.',
      'category-base': 'The prefix of category archives (default: category).',
      'tag-base': 'The prefix of tag archives (default: tag).',
    },
    longdesc:
      'Old addresses keep working: Pressbase remembers the previous structure and redirects to the new one.',
    examples: [
      ['pressbase rewrite structure "/%postname%/"', 'Use post names'],
      [
        'pressbase rewrite structure "/%year%/%postname%/" --category-base=topics',
        'Change the structure and the category base',
      ],
    ],
    needs: 'installed',
    async run(ctx) {
      await ctx.require(
        'manage_options',
        undefined,
        `${ctx.user?.login} isn’t allowed to change permalinks.`,
      );
      const parsed = permalinkSettingsInput.safeParse({
        permalink_structure: ctx.args[0],
        category_base: ctx.string('category-base'),
        tag_base: ctx.string('tag-base'),
      });
      if (!parsed.success)
        return ctx.error(parsed.error.issues[0]?.message ?? 'That structure isn’t valid.');
      const before = await permalinkSettings(ctx.kernel);
      const result = await savePermalinkSettings(ctx.kernel, parsed.data);
      if (!result.ok) {
        const flags: Record<string, string> = {
          permalink_structure: 'permastruct',
          category_base: '--category-base',
          tag_base: '--tag-base',
        };
        return ctx.error(
          Object.entries(result.params)
            .map(([k, m]) => `${flags[k] ?? k}: ${m}`)
            .join(' '),
        );
      }
      ctx.changedServerState();
      if (JSON.stringify(before) === JSON.stringify(result.settings)) {
        ctx.success('Rewrite structure unchanged.');
        return;
      }
      ctx.success(`Rewrite structure set to “${result.settings.permalink_structure || 'plain'}”.`);
    },
  },
];
