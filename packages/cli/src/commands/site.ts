import { PURGE_ACTION } from '@pressbase/core/src/cache/invalidation';
import { CacheTag } from '@pressbase/core/src/cache/tags';
import {
  permalinkSettings,
  permalinkSettingsInput,
  savePermalinkSettings,
} from '@pressbase/core/src/content/permalinks';
import type { CommandSpec } from '../command';

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
    examples: [['pressbase theme activate twentytwentyfive', 'Switch theme']],
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
