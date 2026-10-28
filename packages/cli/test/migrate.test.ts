import {
  FIXTURE_UPLOADS,
  memoryWordPressDatabase,
} from '@pressbase/core/src/import-export/wordpress-db-fixture';
import { afterEach, describe, expect, it } from 'vitest';
import { wordpressConnector } from '../src/commands/migrate';
import { site } from './helpers';

/** migrate wordpress: against the in-memory WordPress database (core's fixture). */

const realConnect = wordpressConnector.connect;
const urls: string[] = [];
afterEach(() => {
  wordpressConnector.connect = realConnect;
  urls.length = 0;
});

function useFake(options: { multisite?: boolean } = {}) {
  wordpressConnector.connect = async (url, prefix) => {
    urls.push(url);
    return memoryWordPressDatabase(undefined, {
      prefix,
      extraTables: options.multisite ? ['blogs'] : [],
    });
  };
}

const DB = '--db-url=mysql://reader:s3cret-pass@db.internal/wordpress';

describe('migrate wordpress', () => {
  it('counts on a dry run, migrates, and skips everything on a second run', {
    timeout: 180_000,
  }, async () => {
    useFake();
    const to = await site();
    expect((await to.cli(['migrate', 'wordpress', DB])).stderr).toMatch(/Add --user=<username>/);

    const dry = await to.cli(['migrate', 'wordpress', DB, '--dry-run', '--user=admin']);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('Reading mysql://reader:***@db.internal/wordpress (tables wp_*)');
    expect(dry.stdout).toContain('Harbour Notes (https://harbour.example): 3 users, 6 terms');
    expect(dry.stdout).toContain('Success: Dry run: nothing was changed.');
    expect(`${dry.stdout}${dry.stderr}`).not.toContain('s3cret-pass');
    expect(await to.ok(['post', 'list', '--field=post_title'])).not.toContain('Hauling out');

    const run = await to.cli([
      'migrate',
      'wordpress',
      DB,
      `--uploads=${FIXTURE_UPLOADS}`,
      '--user=admin',
    ]);
    expect(run.stderr).not.toMatch(/Error/);
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/Migrated 10 posts \(attachment 1, page 5, post 3, wp_navigation 1\)/);
    expect(run.stdout).toContain('2 new users');
    expect(run.stderr).toContain('1 “product” post left out');
    expect(run.stdout).toContain('Success: Migrated the WordPress site.');
    expect(`${run.stdout}${run.stderr}`).not.toMatch(/s3cret-pass|\$P\$|\$wp\$/);
    expect(urls.every((u) => u.includes('s3cret-pass'))).toBe(true);
    expect(await to.ok(['post', 'list', '--field=post_title'])).toContain('Hauling out for winter');
    expect(await to.ok(['option', 'get', 'blogname'])).toContain('Harbour Notes');

    const again = await to.ok(['migrate', 'wordpress', DB, '--user=admin', '--skip=attachment']);
    expect(again).toMatch(/Migrated 0 posts \(none\), 0 terms, 0 comments, 0 new users, 0 menus\./);
    expect(again).toMatch(/Skipped \d+/);
  });

  it('refuses a multisite network, and needs a database', async () => {
    const to = await site();
    useFake({ multisite: true });
    const multi = await to.cli(['migrate', 'wordpress', DB, '--user=admin']);
    expect(multi.code).not.toBe(0);
    expect(multi.stderr).toMatch(/multisite network/);
    const none = await to.cli(['migrate', 'wordpress', '--user=admin'], { env: {} });
    expect(none.stderr).toMatch(/--db-url=mysql:/);
    const bad = await to.cli(['migrate', 'wordpress', DB, '--user=admin', '--uploads=/no/such/dir']);
    expect(bad.stderr).toContain('There’s no folder at /no/such/dir.');
  });
});
