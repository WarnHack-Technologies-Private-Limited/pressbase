import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { schema } from '@pressbase/db';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  checkPrefix,
  connectWordPressDatabase,
  parseDatabaseUrl,
  redactDatabaseUrl,
  redactSecret,
  WordPressDatabaseError,
} from './import-export/wordpress-db';
import {
  FIXTURE_PASSWORDS,
  FIXTURE_SITE,
  FIXTURE_UPLOADS,
  memoryWordPressDatabase,
} from './import-export/wordpress-db-fixture';
import { localUploadsFetcher, migrateFromWordPressDatabase } from './import-export/wordpress-migrate';
import { SITE, setup } from './test-utils';

/** Migrating a WordPress site from its database (ADR 0016), against the in-memory fake. */

async function site() {
  const ctx = await setup();
  const adminId = await ctx.install();
  // Start empty: no sample post, page or comment.
  for (const post of await ctx.kernel.db.select().from(schema.posts))
    await ctx.kernel.posts.delete(post.id);
  const [admin] = await ctx.kernel.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.login, SITE.username));
  return { ...ctx, adminId: admin?.id ?? Number(adminId) };
}

async function logIn(ctx: Awaited<ReturnType<typeof site>>, login: string, password: string) {
  const res = await ctx.app.request('/wp-json/pressbase/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pressbase-request': '1' },
    body: JSON.stringify({ login, password }),
  });
  return res.status;
}

describe('database URLs', () => {
  it('parses URLs, asks for TLS only when told, and never shows the password', async () => {
    const plain = parseDatabaseUrl('mysql://reader:s%3Acr%40t@db.internal:3307/wordpress');
    expect(plain).toMatchObject({
      host: 'db.internal',
      port: 3307,
      user: 'reader',
      password: 's:cr@t',
      database: 'wordpress',
    });
    expect(plain.tls).toBeUndefined();
    expect(parseDatabaseUrl('mysql://u:p@h/db?ssl-mode=VERIFY_IDENTITY').tls).toEqual({
      verify: true,
    });
    expect(parseDatabaseUrl('mysql://u:p@h/db?sslmode=require').tls).toEqual({ verify: false });
    expect(parseDatabaseUrl('mysql://u:p@h/db?ssl=true').tls).toEqual({ verify: true });
    expect(parseDatabaseUrl('mysql://u:p@h/db?ssl-mode=DISABLED').tls).toBeUndefined();
    expect(() => parseDatabaseUrl('mysql://u:p@h/db?ssl-mode=maybe')).toThrow(/Unknown TLS mode/);

    expect(redactDatabaseUrl('mysql://reader:hunter2@db/wp')).toBe('mysql://reader:***@db/wp');
    expect(redactDatabaseUrl('not a url //reader:hunter2@db')).not.toContain('hunter2');
    expect(redactSecret('Access denied (hunter2)', 'hunter2')).toBe('Access denied (***)');
    for (const bad of ['postgres://u:hunter2@h/db', 'mysql://u:hunter2@h/', 'hunter2']) {
      expect(() => parseDatabaseUrl(bad)).toThrow();
      try {
        parseDatabaseUrl(bad);
      } catch (error) {
        expect((error as Error).message).not.toContain('hunter2');
      }
    }
    // Nothing listens on port 1: the error names the server, not the password.
    const refused = await connectWordPressDatabase('mysql://reader:hunter2@127.0.0.1:1/wp').catch(
      (error: Error) => error,
    );
    expect(refused).toBeInstanceOf(WordPressDatabaseError);
    expect((refused as Error).message).toMatch(/^Couldn’t connect to mysql:\/\/reader:\*\*\*@127\.0\.0\.1:1\/wp/);
    expect((refused as Error).message).not.toContain('hunter2');
    expect(() => checkPrefix('wp_; DROP TABLE x')).toThrow(/letters, numbers and underscores/);
    expect(checkPrefix('blog2_')).toBe('blog2_');
  });
});

describe('migrating from a WordPress database', () => {
  it('refuses a multisite network', async () => {
    const ctx = await site();
    await expect(
      migrateFromWordPressDatabase(ctx.kernel, {
        database: memoryWordPressDatabase(undefined, { extraTables: ['blogs'] }),
        userId: ctx.adminId,
      }),
    ).rejects.toThrow(/multisite network.*only migrate single sites/);
  });

  it('counts on a dry run, and writes nothing', async () => {
    const ctx = await site();
    const before = await ctx.kernel.db.select().from(schema.users);
    const result = await migrateFromWordPressDatabase(ctx.kernel, {
      database: memoryWordPressDatabase(),
      userId: ctx.adminId,
      dryRun: true,
    });
    expect(result.report).toBeNull();
    expect(result.counts).toEqual({
      users: 3,
      terms: { category: 3, post_tag: 2, nav_menu: 1 },
      // No revision, no auto-draft.
      posts: { page: 5, post: 3, product: 1, attachment: 1, nav_menu_item: 3, wp_navigation: 1 },
      // No spam.
      comments: 3,
    });
    expect(result.site.title).toBe('Harbour Notes');
    expect(await ctx.kernel.db.select().from(schema.users)).toHaveLength(before.length);
    expect(await ctx.kernel.db.select().from(schema.posts)).toHaveLength(0);
    expect(await ctx.kernel.options.get('blogname')).toBe(SITE.title);
  });

  it('moves users, content, media, menus and settings, and skips everything on a second run', {
    timeout: 120_000,
  }, async () => {
    const ctx = await site();
    const { kernel } = ctx;
    // A category of this site's own, so imported terms get IDs other than their old ones.
    await kernel.terms.insert('category', { name: 'Local news' });
    const db = memoryWordPressDatabase();
    const result = await migrateFromWordPressDatabase(kernel, {
      database: db,
      userId: ctx.adminId,
      uploads: FIXTURE_UPLOADS,
    });
    const report = result.report;
    if (!report) throw new Error('No report.');
    expect(report.errors.items).toEqual([]);
    expect(report.imported).toMatchObject({
      users: 2,
      comments: 3,
      menus: 1,
      posts: { page: 5, post: 3, attachment: 1, wp_navigation: 1 },
    });
    expect(report.skippedPostTypes).toEqual({ product: 1 });
    // Pages were read in batches by ID, and no query asked for everything at once.
    expect(db.queries).toContain('posts 0');

    /* Users: matched by login, or created with their hash, roles and profile. */
    const users = await kernel.db.select().from(schema.users);
    expect(users.map((u) => u.login).sort()).toEqual(['admin', 'nadia', 'theo']);
    expect(report.authors.admin).toBe(ctx.adminId);
    expect(await logIn(ctx, 'nadia', FIXTURE_PASSWORDS.nadia)).toBe(200);
    expect(await logIn(ctx, 'theo', FIXTURE_PASSWORDS.theo)).toBe(200);
    expect(await logIn(ctx, 'theo', 'wrong password')).not.toBe(200);
    // The existing admin keeps their own password.
    expect(await logIn(ctx, 'admin', SITE.password)).toBe(200);
    expect(await logIn(ctx, 'admin', FIXTURE_PASSWORDS.admin)).not.toBe(200);
    const nadia = users.find((u) => u.login === 'nadia');
    if (!nadia) throw new Error('nadia is missing');
    expect(nadia).toMatchObject({
      nicename: 'nadia-rahman',
      displayName: 'Nadia Rahman',
      email: 'nadia@harbour.example',
    });
    expect(nadia.registeredAt.toISOString()).toBe('2025-11-20T16:40:12.000Z');
    const nadiaMeta = new Map(
      (
        await kernel.db.select().from(schema.usermeta).where(eq(schema.usermeta.userId, nadia.id))
      ).map((m) => [m.key, m.value]),
    );
    expect(nadiaMeta.get('capabilities')).toEqual({ author: true });
    expect(nadiaMeta.get('first_name')).toBe('Nadia');
    expect(nadiaMeta.get('description')).toBe('Writes the yard’s logbook.');
    // en_GB isn't installed here, so nadia gets the site's language.
    expect(nadiaMeta.get('locale')).toBe('');
    expect(nadiaMeta.has('session_tokens')).toBe(false);
    const theo = users.find((u) => u.login === 'theo');
    const [theoCaps] = await kernel.db
      .select({ value: schema.usermeta.value })
      .from(schema.usermeta)
      .where(and(eq(schema.usermeta.userId, theo?.id ?? 0), eq(schema.usermeta.key, 'capabilities')));
    expect(theoCaps?.value).toEqual({ editor: true });

    /* Terms. */
    const categories = (await kernel.terms.list('category')).terms;
    const boats = categories.find((t) => t.slug === 'boats');
    const repairs = categories.find((t) => t.slug === 'repairs');
    expect(repairs?.parent).toBe(boats?.id);
    const termMeta = async (termId: number) =>
      new Map(
        (
          await kernel.db.select().from(schema.termmeta).where(eq(schema.termmeta.termId, termId))
        ).map((m) => [m.key, m.value]),
      );
    expect((await termMeta(boats?.id ?? 0)).get('rank_math_title')).toBe(
      'Boats we look after %sep% %sitename%',
    );
    expect((await termMeta(repairs?.id ?? 0)).get('wpseo_desc')).toBe(
      'Hull, deck and engine repairs at the yard.',
    );

    /* Posts, pages and their relationships. */
    const posts = await kernel.db.select().from(schema.posts);
    const byTitle = (title: string, type = 'post') => {
      const found = posts.find((p) => p.title === title && p.type === type);
      if (!found) throw new Error(`${type} “${title}” is missing`);
      return found;
    };
    expect(posts.some((p) => p.type === 'revision' || p.title === 'Auto Draft')).toBe(false);
    const hauling = byTitle('Hauling out for winter');
    const gallery = byTitle('Antifouling, a gallery');
    const hull = byTitle('Hull on stands', 'attachment');
    const about = byTitle('About the yard', 'page');
    const services = byTitle('Services', 'page');
    expect(hauling.authorId).toBe(nadia.id);
    expect(gallery.authorId).toBe(theo?.id);
    expect(byTitle('Notes for spring').status).toBe('draft');
    expect(byTitle('Our crew', 'page').parentId).toBe(about.id);
    expect(byTitle('Winter rates', 'page').parentId).toBe(services.id);
    expect(hull.parentId).toBe(hauling.id);
    expect(await kernel.options.get('sticky_posts')).toEqual([hauling.id]);
    const categoryIds = (await kernel.terms.objectTermIds([hauling.id], 'category')).get(
      hauling.id,
    );
    expect(categoryIds).toEqual([repairs?.id]);
    expect((await kernel.terms.objectTermIds([hauling.id], 'post_tag')).get(hauling.id)).toHaveLength(2);

    // Featured image, SEO meta kept as it was, primary category remapped.
    expect(Number(await kernel.posts.getMeta(hauling.id, '_thumbnail_id'))).toBe(hull.id);
    expect(await kernel.posts.getMeta(hauling.id, '_yoast_wpseo_title')).toBe(
      '%%title%% %%sep%% %%sitename%%',
    );
    expect(await kernel.posts.getMeta(hauling.id, '_yoast_wpseo_metadesc')).toBe(
      'How we haul boats out for the winter.',
    );
    expect(repairs?.id).not.toBe(3);
    expect(Number(await kernel.posts.getMeta(hauling.id, '_yoast_wpseo_primary_category'))).toBe(
      repairs?.id,
    );
    expect(await kernel.posts.getMeta(gallery.id, 'rank_math_description')).toBe(
      'Antifouling, coat by coat.',
    );
    expect(await kernel.posts.getMeta(hauling.id, '_edit_lock')).toBeUndefined();

    // The attachment: from the local uploads folder, in its old folder, with sizes.
    expect(await kernel.posts.getMeta(hull.id, '_wp_attached_file')).toBe(
      '2026/02/hull-on-stands.png',
    );
    expect(await kernel.posts.getMeta(hull.id, '_wp_attachment_image_alt')).toBe(
      'A blue hull on stands',
    );
    const metadata = (await kernel.posts.getMeta(hull.id, '_wp_attachment_metadata')) as {
      sizes: Record<string, { file: string }>;
    };
    expect(Object.keys(metadata.sizes)).toEqual(expect.arrayContaining(['thumbnail', 'medium']));
    const stored = await readFile(path.join(ctx.dataDir, 'uploads', '2026/02/hull-on-stands.png'));
    expect(stored.equals(await readFile(path.join(FIXTURE_UPLOADS, '2026/02/hull-on-stands.png')))).toBe(true);

    // Content now points at the new IDs and this site.
    expect(hauling.content).toContain(`"id":${hull.id}`);
    expect(hauling.content).toContain(`wp-image-${hull.id}`);
    expect(hauling.content).toContain(`?page_id=${services.id}`);
    expect(hauling.content).not.toContain(FIXTURE_SITE);
    expect(gallery.content).toContain(`[gallery ids="${hull.id}" columns="2"]`);

    // Comments: no spam, threads and commenters' accounts kept.
    const comments = await kernel.db.select().from(schema.comments);
    expect(comments).toHaveLength(3);
    const question = comments.find((c) => c.author === 'Inês Costa');
    const answer = comments.find((c) => c.author === 'Nadia Rahman');
    expect(answer?.parentId).toBe(question?.id);
    expect(answer?.userId).toBe(nadia.id);
    expect(comments.find((c) => c.author === 'Sam')?.approved).toBe('0');
    const [akismet] = await kernel.db
      .select()
      .from(schema.commentmeta)
      .where(eq(schema.commentmeta.commentId, question?.id ?? 0));
    expect(akismet).toMatchObject({ key: 'akismet_result', value: false });

    // Menus: the classic menu becomes a block menu; the block menu keeps its link.
    const mainMenu = byTitle('Main menu', 'wp_navigation');
    expect(mainMenu.content).toContain(`"id":${about.id}`);
    expect(mainMenu.content).toContain(`"id":${boats?.id}`);
    expect(mainMenu.content).toContain('https://wordpress.org/');
    expect(byTitle('Footer', 'wp_navigation').content).toContain(`"id":${about.id}`);

    // Settings.
    expect(await kernel.options.get('blogname')).toBe('Harbour Notes');
    expect(await kernel.options.get('permalink_structure')).toBe('/%postname%/');
    expect(await kernel.options.get('tag_base')).toBe('/topic');
    expect(await kernel.options.get('timezone_string')).toBe('Europe/Lisbon');
    expect(await kernel.options.get('posts_per_page')).toBe(6);
    expect(await kernel.options.get('show_on_front')).toBe('page');
    expect(await kernel.options.get('page_on_front')).toBe(about.id);
    expect(await kernel.options.get('page_for_posts')).toBe(byTitle('Logbook', 'page').id);
    expect(await kernel.options.get('siteurl')).not.toBe(FIXTURE_SITE);
    expect(result.options.skipped).toEqual([]);
    expect(result.options.carried).toEqual(
      expect.arrayContaining(['blogname', 'timezone_string', 'page_on_front', 'default_category']),
    );

    // Hashes are never in the report.
    expect(JSON.stringify(result)).not.toMatch(/\$P\$|\$wp\$/);

    /* A second run finds everything already here. */
    const again = await migrateFromWordPressDatabase(kernel, {
      database: memoryWordPressDatabase(),
      userId: ctx.adminId,
      uploads: FIXTURE_UPLOADS,
    });
    expect(again.report?.errors.items).toEqual([]);
    expect(again.report?.imported).toEqual({
      users: 0,
      terms: 0,
      posts: {},
      comments: 0,
      menus: 0,
    });
    expect(await kernel.db.select().from(schema.posts)).toHaveLength(posts.length);
    expect(await kernel.db.select().from(schema.users)).toHaveLength(3);
    expect(await kernel.db.select().from(schema.comments)).toHaveLength(3);
  });

  it('downloads files from the old site without an uploads folder, and can leave them out', {
    timeout: 60_000,
  }, async () => {
    const ctx = await site();
    const asked: string[] = [];
    const png = await readFile(path.join(FIXTURE_UPLOADS, '2026/02/hull-on-stands.png'));
    const result = await migrateFromWordPressDatabase(ctx.kernel, {
      database: memoryWordPressDatabase(),
      userId: ctx.adminId,
      skip: ['comments', 'options'],
      fetchFile: async (url) => {
        asked.push(url);
        return { data: new Uint8Array(png), filename: 'hull-on-stands.png', contentType: 'image/png', url };
      },
    });
    expect(asked).toEqual([`${FIXTURE_SITE}/wp-content/uploads/2026/02/hull-on-stands.png`]);
    expect(result.report?.imported.posts.attachment).toBe(1);
    expect(result.report?.imported.comments).toBe(0);
    expect(await ctx.kernel.options.get('blogname')).toBe(SITE.title);

    const other = await site();
    const skipped = await migrateFromWordPressDatabase(other.kernel, {
      database: memoryWordPressDatabase(),
      userId: other.adminId,
      skip: ['attachment'],
    });
    expect(skipped.counts.posts.attachment).toBeUndefined();
    expect(skipped.report?.imported.posts.attachment).toBeUndefined();
    expect(skipped.report?.errors.items).toEqual([]);
  });

  it('reads files only from inside the uploads folder', async () => {
    const fetch = localUploadsFetcher(FIXTURE_UPLOADS, `${FIXTURE_SITE}/wp-content/uploads`);
    const base = `${FIXTURE_SITE}/wp-content/uploads`;
    const file = await fetch(`${base}/2026/02/hull-on-stands.png`, { maxBytes: 1_000_000 });
    expect(file.filename).toBe('hull-on-stands.png');
    await expect(fetch(`${base}/../../../../../../../etc/hostname`, { maxBytes: 1e6 })).rejects.toMatchObject({
      code: expect.stringMatching(/import_file_(outside_uploads|missing)/),
    });
    await expect(fetch(`${base}/2026/02/missing.png`, { maxBytes: 1e6 })).rejects.toMatchObject({
      code: 'import_file_missing',
    });
    await expect(fetch(`${base}/2026/02/hull-on-stands.png`, { maxBytes: 10 })).rejects.toMatchObject({
      code: 'import_file_too_big',
    });
  });
});
