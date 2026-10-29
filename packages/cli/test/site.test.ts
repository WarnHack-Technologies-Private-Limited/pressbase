import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { PURGE_ACTION } from '@pressbase/core/src/cache/invalidation';
import { createZip } from '@pressbase/core/src/files/zip';
import { describe, expect, it } from 'vitest';
import { site } from './helpers';

/** plugin, theme, cache, rewrite and cron commands, and plugins' own commands. */

const PLUGIN = (slug: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: slug,
    title: 'Reading Time',
    version: '0.1.0',
    main: 'index.js',
    ...extra,
  });

const INDEX = `
export default function register(api) {
  api.cli.addCommand('reading-time estimate', async (args, assoc, io) => {
    if (!args[0]) io.error('Give a post ID.');
    const post = await api.content.posts.get(Number(args[0]));
    const words = post.content.split(/\\s+/).filter(Boolean).length;
    const minutes = Math.max(1, Math.round(words / Number(assoc.wpm ?? 200)));
    if (assoc.format) io.formatItems([{ ID: post.id, minutes }], ['ID', 'minutes']);
    else io.success(minutes + ' minute read' + (io.user ? ' (as ' + io.user.login + ')' : '') + '.');
  }, { shortdesc: 'Estimates a post’s reading time.', synopsis: '<id> [--wpm=<words>]' });
}
export async function activate(api) { await api.options.set('activated', true); }
export async function uninstall(api) { await api.options.delete('activated'); }
`;

describe('plugin', () => {
  it('installs, activates, deactivates and deletes through the plugin manager', async () => {
    const s = await site();
    const zip = createZip([
      {
        name: 'reading-time/plugin.json',
        data: PLUGIN('reading-time', { permissions: ['options'] }),
      },
      { name: 'reading-time/index.js', data: INDEX },
    ]);
    await writeFile(path.join(s.dataDir, 'reading-time.zip'), zip);

    expect(await s.ok(['plugin', 'install', 'reading-time.zip'])).toBe(
      'Installed Reading Time 0.1.0 (reading-time).\nSuccess: Installed 1 of 1 plugins.\n',
    );
    expect((await s.cli(['plugin', 'install', 'reading-time.zip'])).stderr).toMatch(
      /already installed/,
    );
    expect(await s.ok(['plugin', 'list', '--fields=name,status,source', '--format=csv'])).toBe(
      'name,status,source\ndaily-tips,inactive,bundled\npressbase-seo,inactive,bundled\nreading-time,inactive,site\n',
    );

    // It asks for a permission: activating needs agreement (--yes without a terminal).
    const asked = await s.cli(['plugin', 'activate', 'reading-time']);
    expect(asked.stderr).toMatch(/asks for these permissions: options\. .+Add --yes/);
    expect(await s.ok(['plugin', 'activate', 'reading-time', '--yes'])).toBe(
      "Plugin 'reading-time' activated.\nSuccess: Activated 1 of 1 plugins.\n",
    );
    expect(await s.kernel.options.get('reading_time_activated')).toBe(true);
    expect((await s.kernel.plugins.grants())['reading-time']?.permissions).toEqual(['options']);
    expect(await s.ok(['plugin', 'status'])).toMatch(
      / {2}I daily-tips\s+\d+\.\d+\.\d+\n {2}I pressbase-seo\s+\d+\.\d+\.\d+\n {2}A reading-time\s+0\.1\.0/,
    );
    expect(await s.ok(['plugin', 'status', 'reading-time'])).toMatch(
      /Status: Active\n {4}Version: 0\.1\.0/,
    );

    // Its command is there while it's active.
    const post = (
      await s.ok(['post', 'create', '--post_content=one two three four', '--porcelain'])
    ).trim();
    expect(await s.ok(['reading-time', 'estimate', post, '--wpm=2', '--user=admin'])).toBe(
      'Success: 2 minute read (as admin).\n',
    );
    expect(await s.ok(['reading-time', 'estimate', post, '--format=json'])).toBe(
      `[{"ID":${post},"minutes":1}]\n`,
    );
    expect((await s.cli(['reading-time', 'estimate'])).stderr).toMatch(/Give <id>/);
    expect(await s.ok(['help', 'reading-time', 'estimate'])).toMatch(
      /Estimates a post’s reading time\./,
    );
    expect(await s.ok([])).toMatch(
      /PLUGIN COMMANDS\n\n {2}reading-time estimate\s+Estimates a post’s reading time\. \(reading-time\)/,
    );

    const active = await s.cli(['plugin', 'delete', 'reading-time', '--yes']);
    expect(active).toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/deactivate it first/i),
    });
    expect(await s.ok(['plugin', 'deactivate', 'reading-time'])).toBe(
      "Plugin 'reading-time' deactivated.\nSuccess: Deactivated 1 of 1 plugins.\n",
    );
    expect((await s.cli(['reading-time', 'estimate', post])).stderr).toMatch(
      /isn’t a pressbase command/,
    );
    expect(await s.ok(['plugin', 'delete', 'reading-time', '--yes'])).toBe(
      "Deleted 'reading-time' plugin.\nSuccess: Deleted 1 of 1 plugins.\n",
    );
    expect(await s.kernel.options.get('reading_time_activated')).toBeUndefined();
    expect((await s.cli(['plugin', 'delete', 'daily-tips', '--yes'])).stderr).toMatch(
      /ships with Pressbase/,
    );
  });

  it('checks capabilities and reports failures with a non-zero exit', async () => {
    const s = await site();
    await s.loginAs('ed', 'editor');
    expect((await s.cli(['plugin', 'list', '--user=ed'])).stderr).toBe(
      'Error: ed isn’t allowed to manage plugins.\n',
    );
    expect((await s.cli(['plugin', 'activate', 'nope'])).stderr).toMatch(
      /There’s no plugin “nope”/,
    );

    const dir = path.join(s.dataDir, 'plugins', 'broken');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'plugin.json'), PLUGIN('broken', { title: 'Broken' }));
    await writeFile(
      path.join(dir, 'index.js'),
      'export default () => { throw new Error("Boom."); };',
    );
    const failed = await s.cli(['plugin', 'activate', 'broken']);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toMatch(
      /Warning: Broken could not be activated: Boom\.\nError: Activated 0 of 1 plugins\./,
    );
  });
});

describe('theme and rewrite', () => {
  it('lists and activates themes, and sets the permalink structure', async () => {
    const s = await site();
    expect(await s.ok(['theme', 'list', '--format=json'])).toMatch(
      /"name":"twentytwentyfive","status":"active"/,
    );
    expect(await s.ok(['theme', 'activate', 'twentytwentyfive'])).toBe('');
    expect((await s.cli(['theme', 'activate', 'nope'])).stderr).toMatch(/There’s no theme “nope”/);

    expect(await s.ok(['rewrite', 'structure', '/%postname%/', '--category-base=topics'])).toBe(
      'Success: Rewrite structure set to “/%postname%/”.\n',
    );
    expect(await s.kernel.options.get('permalink_structure')).toBe('/%postname%/');
    expect(await s.kernel.options.get('category_base')).toBe('/topics');
    const clash = await s.cli(['rewrite', 'structure', '/%postname%/', '--tag-base=topics']);
    expect(clash.stderr).toMatch(
      /--tag-base: The category base and the tag base must be different\./,
    );
    const bad = await s.cli(['rewrite', 'structure', '/%nonsense%/']);
    expect(bad.code).toBe(1);
  });
});

describe('cache flush', () => {
  it('purges the public site’s page cache through the revalidation endpoint', async () => {
    const received: { auth?: string; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ auth: req.headers.authorization, body });
        res.writeHead(req.url === '/_pressbase/revalidate' ? 200 : 404).end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(4510, '127.0.0.1', resolve));
    try {
      const s = await site({ revalidate: { urls: ['http://127.0.0.1:4510'], secret: 's3cret' } });
      expect(await s.ok(['cache', 'flush'])).toBe(
        'Success: Flushed the public site’s page cache.\n',
      );
      expect(received).toEqual([{ auth: 'Bearer s3cret', body: '{"tags":["site"]}' }]);

      // Content changes made from the command line purge too, as the server's do.
      received.length = 0;
      await s.ok(['option', 'update', 'blogname', 'Field notes']);
      expect(received.map((r) => r.body)).toEqual(['{"tags":["site"]}']);
    } finally {
      server.close();
    }

    const off = await site();
    const result = await off.cli(['cache', 'flush']);
    expect(result).toMatchObject({ code: 0, stderr: expect.stringMatching(/page cache is off/) });

    const down = await site({ revalidate: { urls: ['http://127.0.0.1:9'], secret: 'x' } });
    const failed = await down.cli(['cache', 'flush']);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toMatch(
      /Error: The page cache couldn’t be flushed\. Check that the public site is running/,
    );
  });
});

describe('cron', () => {
  it('lists, runs and deletes events', async () => {
    const s = await site();
    const events = JSON.parse(
      await s.ok(['cron', 'event', 'list', '--fields=hook,recurrence', '--format=json']),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        { hook: 'pressbase_delete_expired_sessions', recurrence: '1 day' },
        { hook: 'pressbase_prune_jobs', recurrence: '1 day' },
      ]),
    );
    expect(await s.ok(['cron', 'schedule', 'list', '--field=name'])).toBe(
      'hourly\ntwicedaily\ndaily\nweekly\n',
    );

    const ran: unknown[][] = [];
    s.kernel.hooks.addAction('cli_test_event', (...args: unknown[]) => {
      ran.push(args);
    });
    await s.kernel.cron.scheduleSingleEvent(
      Math.floor(Date.now() / 1000) + 3600,
      'cli_test_event',
      ['x'],
    );
    const run = await s.ok(['cron', 'event', 'run', 'cli_test_event']);
    expect(run).toMatch(
      /^Executed the cron event 'cli_test_event' in \d+\.\d{3}s\.\nSuccess: Executed a total of 1 cron event\.\n$/,
    );
    expect(ran).toEqual([['x']]);
    expect(await s.kernel.cron.nextScheduled('cli_test_event', ['x'])).toBe(false);

    // A recurring event is rescheduled when it runs.
    const before = await s.kernel.cron.nextScheduled('pressbase_prune_jobs');
    await s.ok(['cron', 'event', 'run', 'pressbase_prune_jobs']);
    const after = await s.kernel.cron.nextScheduled('pressbase_prune_jobs');
    expect(after).not.toBe(false);
    expect(after).not.toBe(before);

    const none = await s.cli(['cron', 'event', 'run', 'cli_test_event']);
    expect(none).toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/No event of 'cli_test_event' is scheduled/),
    });

    expect(await s.ok(['cron', 'event', 'run', '--due-now'])).toMatch(
      /Success: Executed a total of \d+ cron events?\./,
    );
    expect(await s.ok(['cron', 'event', 'delete', 'pressbase_prune_jobs'])).toBe(
      'Success: Deleted a total of 1 cron event.\n',
    );
    expect((await s.cli(['cron', 'event', 'delete', 'pressbase_prune_jobs'])).code).toBe(1);
  });

  it('tests that events run on time', async () => {
    const s = await site();
    // The daily events were due at midnight UTC; run them, as the worker would have.
    await s.ok(['cron', 'event', 'run', '--due-now']);
    expect(await s.ok(['cron', 'test'])).toBe('Success: Scheduled events are running on time.\n');
    await s.kernel.cron.scheduleSingleEvent(Math.floor(Date.now() / 1000) - 3600, 'cli_late_event');
    const late = await s.cli(['cron', 'test']);
    expect(late.code).toBe(1);
    expect(late.stderr).toMatch(
      /1 scheduled event is more than ten minutes late\. Check that a Pressbase server is running/,
    );
  });
});

describe('purges', () => {
  it('fire for changes made from the command line', async () => {
    const s = await site();
    const tags: string[][] = [];
    s.kernel.hooks.addAction(PURGE_ACTION, (t: string[]) => {
      tags.push(t);
    });
    await s.ok(['theme', 'activate', 'twentytwentyfive']);
    await s.ok(['post', 'update', '1', '--post_title=Changed']);
    expect(tags.flat()).toContain('post:1');
  });
});
