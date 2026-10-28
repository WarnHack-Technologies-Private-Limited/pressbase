import { readFile } from 'node:fs/promises';
import type { InstalledPlugin } from '@pressbase/core/src/plugins/discovery';
import { authorName } from '@pressbase/core/src/plugins/manifest';
import { maxPluginBytes } from '@pressbase/core/src/routes/plugins';
import type { CommandSpec, Context } from '../command';
import { service } from './shared';

/**
 * `pressbase plugin`: wp-cli's extension-command for plugins, through the
 * plugin manager, so everything the Plugins screen does happens here too:
 * the declared permissions are shown and must be agreed to, migrations run,
 * `activate`/`deactivate`/`uninstall` and the lifecycle hooks fire, the page
 * cache is purged, and archives go through the same strict ZIP checks.
 */

const FIELDS = ['name', 'title', 'status', 'version', 'source', 'permissions', 'author', 'description', 'error'];
const LIST_FIELDS = ['name', 'title', 'status', 'version', 'source'];

async function rows(ctx: Context) {
  const { plugins, invalid } = await ctx.kernel.plugins.discover();
  const out = [];
  for (const plugin of plugins) {
    const status = await ctx.kernel.plugins.status(plugin);
    out.push({
      name: plugin.slug,
      title: plugin.manifest.title,
      status: status.active ? 'active' : 'inactive',
      version: plugin.manifest.version,
      source: plugin.source,
      permissions: plugin.manifest.permissions.join(','),
      author: authorName(plugin.manifest),
      description: plugin.manifest.description,
      error: status.error?.message ?? (status.compatible ? '' : `Needs Pressbase ${plugin.manifest.requires}`),
    });
  }
  for (const broken of invalid) {
    out.push({
      name: broken.slug,
      title: broken.slug,
      status: 'invalid',
      version: '',
      source: broken.source,
      permissions: '',
      author: '',
      description: '',
      error: broken.error,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function find(ctx: Context, slug: string): Promise<InstalledPlugin> {
  const plugin = await ctx.kernel.plugins.get(slug);
  if (!plugin) {
    ctx.error(`There’s no plugin “${slug}”. “pressbase plugin list” shows the installed ones.`);
  }
  return plugin;
}

/** Asks the user to agree to a plugin's permissions, as the Plugins screen does. */
async function agree(ctx: Context, plugin: InstalledPlugin): Promise<void> {
  const permissions = plugin.manifest.permissions;
  if (!permissions.length) return;
  await ctx.confirm(
    `${plugin.manifest.title} asks for these permissions: ${permissions.join(', ')}. Plugins run with full access to the server; activate it only if you trust it. Activate?`,
  );
}

async function activate(ctx: Context, plugin: InstalledPlugin): Promise<boolean> {
  if ((await ctx.kernel.plugins.activeSlugs()).includes(plugin.slug)) {
    ctx.warning(`Plugin '${plugin.slug}' is already active.`);
    return true;
  }
  await agree(ctx, plugin);
  try {
    await ctx.kernel.plugins.activate(plugin.slug, {
      permissions: plugin.manifest.permissions,
      userId: ctx.user?.id ?? null,
    });
  } catch (error) {
    ctx.warning((error as Error).message);
    return false;
  }
  ctx.changedServerState();
  ctx.log(`Plugin '${plugin.slug}' activated.`);
  return true;
}

function summary(ctx: Context, done: number, total: number, verb: string) {
  const message = `${verb} ${done} of ${total} plugin${total === 1 ? '' : 's'}.`;
  if (done < total) ctx.error(message);
  ctx.success(message);
}

export const pluginCommands: CommandSpec[] = [
  {
    name: 'plugin list',
    shortdesc: 'Lists installed plugins.',
    synopsis: '[--status=<status>] [--fields=<fields>] [--field=<field>] [--format=<format>]',
    options: { status: 'Only plugins with this status.' },
    choices: { status: ['active', 'inactive', 'invalid'] },
    examples: [['pressbase plugin list --status=active --field=name', 'Names of active plugins']],
    needs: 'installed',
    async run(ctx) {
      await ctx.require('activate_plugins', undefined, `${ctx.user?.login} isn’t allowed to manage plugins.`);
      const status = ctx.string('status');
      const items = (await rows(ctx)).filter((r) => !status || r.status === status);
      ctx.formatItems(items, LIST_FIELDS, { all: FIELDS, idField: 'name' });
    },
  },
  {
    name: 'plugin status',
    shortdesc: 'Shows the plugins’ status, or one plugin’s details.',
    synopsis: '[<plugin>]',
    options: { plugin: 'A plugin’s name, for its details.' },
    examples: [
      ['pressbase plugin status', 'Show every plugin’s status'],
      ['pressbase plugin status daily-tips', 'Show one plugin'],
    ],
    needs: 'installed',
    async run(ctx) {
      await ctx.require('activate_plugins', undefined, `${ctx.user?.login} isn’t allowed to manage plugins.`);
      const all = await rows(ctx);
      const [slug] = ctx.args;
      if (slug) {
        const row = all.find((r) => r.name === slug);
        if (!row) return ctx.error(`There’s no plugin “${slug}”.`);
        ctx.line(`Plugin ${row.name} details:`);
        for (const [label, value] of [
          ['Name', row.title],
          ['Status', row.status === 'active' ? 'Active' : row.status === 'invalid' ? 'Invalid' : 'Inactive'],
          ['Version', row.version],
          ['Author', row.author],
          ['Description', row.description],
          ['Permissions', row.permissions || 'none'],
          ...(row.error ? [['Error', row.error]] : []),
        ] as [string, string][]) {
          ctx.line(`    ${label}: ${value}`);
        }
        return;
      }
      if (!all.length) {
        ctx.line('No plugins installed.');
        return;
      }
      ctx.line(`${all.length} installed plugin${all.length === 1 ? '' : 's'}:`);
      const width = Math.max(...all.map((r) => r.name.length));
      for (const row of all) {
        const mark = row.status === 'active' ? 'A' : row.status === 'invalid' ? '!' : 'I';
        ctx.line(`  ${mark} ${row.name.padEnd(width)}  ${row.version}`);
      }
      ctx.line('\nLegend: A = Active, I = Inactive, ! = Can’t be loaded');
    },
  },
  {
    name: 'plugin activate',
    shortdesc: 'Activates plugins, after you agree to the permissions they ask for.',
    synopsis: '[<plugin>...] [--all]',
    options: {
      plugin: 'The plugins’ names.',
      all: 'Activate every installed plugin.',
    },
    longdesc:
      'A plugin that asks for permissions (database, options, network, filesystem) lists them and asks before it’s activated; --yes agrees for you.',
    examples: [
      ['pressbase plugin activate daily-tips', 'Activate a plugin'],
      ['pressbase plugin activate reading-time --yes', 'Activate and agree to its permissions in a script'],
    ],
    needs: 'installed',
    async run(ctx) {
      await ctx.require('activate_plugins', undefined, `${ctx.user?.login} isn’t allowed to activate plugins.`);
      const slugs = ctx.flag('all')
        ? (await ctx.kernel.plugins.discover()).plugins.map((p) => p.slug)
        : ctx.args;
      if (!slugs.length) ctx.error('Give the plugins to activate, or --all.');
      let done = 0;
      for (const slug of slugs) if (await activate(ctx, await find(ctx, slug))) done += 1;
      summary(ctx, done, slugs.length, 'Activated');
    },
  },
  {
    name: 'plugin deactivate',
    shortdesc: 'Deactivates plugins.',
    synopsis: '[<plugin>...] [--all] [--uninstall]',
    options: {
      plugin: 'The plugins’ names.',
      all: 'Deactivate every active plugin.',
      uninstall: 'Then delete them (runs their uninstall). Asks first, unless --yes.',
    },
    examples: [['pressbase plugin deactivate daily-tips', 'Deactivate a plugin']],
    needs: 'installed',
    async run(ctx) {
      await ctx.require('activate_plugins', undefined, `${ctx.user?.login} isn’t allowed to deactivate plugins.`);
      const active = await ctx.kernel.plugins.activeSlugs();
      const slugs = ctx.flag('all') ? active : ctx.args;
      if (!slugs.length) ctx.error(ctx.flag('all') ? 'No plugins are active.' : 'Give the plugins to deactivate, or --all.');
      if (ctx.flag('uninstall')) {
        await ctx.require('delete_plugins', undefined, `${ctx.user?.login} isn’t allowed to delete plugins.`);
        await ctx.confirm(`Deactivate and delete ${slugs.join(', ')}? Their data may be removed too.`);
      }
      let done = 0;
      for (const slug of slugs) {
        await find(ctx, slug);
        if (!active.includes(slug)) {
          ctx.warning(`Plugin '${slug}' isn’t active.`);
        } else {
          await ctx.kernel.plugins.deactivate(slug);
          ctx.changedServerState();
          ctx.log(`Plugin '${slug}' deactivated.`);
        }
        if (ctx.flag('uninstall')) {
          await service(() => ctx.kernel.plugins.delete(slug));
          ctx.log(`Deleted '${slug}' plugin.`);
        }
        done += 1;
      }
      summary(ctx, done, slugs.length, 'Deactivated');
    },
  },
  {
    name: 'plugin install',
    shortdesc: 'Installs a plugin from a .zip file.',
    synopsis: '<zip> [--activate]',
    options: {
      zip: 'Path to the plugin’s .zip, as made by “npm run pack” in a create-pressbase-plugin project.',
      activate: 'Activate it once installed.',
    },
    longdesc:
      'There is no plugin directory to download from yet, so give a file. To replace an installed plugin, delete it first.',
    examples: [['pressbase plugin install ./reading-time-0.1.0.zip --activate', 'Install and activate']],
    needs: 'installed',
    async run(ctx) {
      await ctx.require('install_plugins', undefined, `${ctx.user?.login} isn’t allowed to install plugins.`);
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
      const plugin = await service(() =>
        ctx.kernel.plugins.install(data, { maxBytes: maxPluginBytes(ctx.kernel) }),
      );
      ctx.log(`Installed ${plugin.manifest.title} ${plugin.manifest.version} (${plugin.slug}).`);
      if (ctx.flag('activate')) {
        await ctx.require('activate_plugins', undefined, `${ctx.user?.login} isn’t allowed to activate plugins.`);
        if (!(await activate(ctx, plugin))) ctx.error(`Installed ${plugin.slug}, but it couldn’t be activated.`);
      }
      ctx.success(`Installed 1 of 1 plugins.`);
    },
  },
  {
    name: 'plugin delete',
    shortdesc: 'Deletes inactive plugins, running their uninstall first.',
    synopsis: '<plugin>...',
    options: { plugin: 'The plugins’ names.' },
    longdesc:
      'Asks first, unless --yes. Plugins bundled with Pressbase can’t be deleted; active ones must be deactivated first.',
    examples: [['pressbase plugin delete reading-time --yes', 'Delete a plugin']],
    needs: 'installed',
    async run(ctx) {
      await ctx.require('activate_plugins', undefined, `${ctx.user?.login} isn’t allowed to manage plugins.`);
      await ctx.require('delete_plugins', undefined, `${ctx.user?.login} isn’t allowed to delete plugins.`);
      await ctx.confirm(`Delete ${ctx.args.join(', ')}? Their uninstall runs and their files are removed.`);
      let done = 0;
      for (const slug of ctx.args) {
        try {
          await ctx.kernel.plugins.delete(slug);
          ctx.log(`Deleted '${slug}' plugin.`);
          done += 1;
        } catch (error) {
          ctx.warning((error as Error).message);
        }
      }
      summary(ctx, done, ctx.args.length, 'Deleted');
    },
  },
];
