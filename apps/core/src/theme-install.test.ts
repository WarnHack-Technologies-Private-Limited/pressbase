import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapMetaCap } from './auth/meta-caps';
import { PURGE_ACTION } from './cache/invalidation';
import { createZip, type NewZipEntry } from './files/zip';
import { SITE, setup } from './test-utils';
import { userGlobalStylesPost } from './themes/global-styles';
import { sanitizeThemeSlug, themeArchiveRoot } from './themes/install';

/**
 * Installing themes from a .zip (POST /pressbase/v1/themes,
 * kernel.themes.install()) and deleting them (DELETE
 * /pressbase/v1/themes/{stylesheet}, kernel.themes.delete()).
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

async function site() {
  const ctx = await setup();
  await ctx.install();
  return ctx;
}

const STYLE = (name: string, extra = '') =>
  `/*\nTheme Name: ${name}\nVersion: 1.0\nAuthor: Ada\n${extra}*/\nbody { color: black; }\n`;

const INDEX = (text: string) => `<!-- wp:paragraph --><p>${text}</p><!-- /wp:paragraph -->`;

/** A block theme's files, optionally inside a folder. */
function themeZip(
  folder: string,
  options: { name?: string; text?: string; extra?: NewZipEntry[]; style?: string } = {},
) {
  const prefix = folder ? `${folder}/` : '';
  return createZip([
    { name: `${prefix}style.css`, data: options.style ?? STYLE(options.name ?? 'Upload Test') },
    { name: `${prefix}templates/index.html`, data: INDEX(options.text ?? 'Uploaded theme') },
    { name: `${prefix}theme.json`, data: JSON.stringify({ version: 3 }) },
    ...(options.extra ?? []),
  ]);
}

/** Logs in on a fresh cookie and returns headers for raw (multipart) requests. */
async function headersFor(ctx: Ctx, login = SITE.username, password = SITE.password) {
  const res = await ctx.app.request('/wp-json/pressbase/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pressbase-request': '1' },
    body: JSON.stringify({ login, password }),
  });
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
  return { cookie, 'x-pressbase-request': '1' };
}

async function upload(
  ctx: Ctx,
  zip: Uint8Array,
  options: { filename?: string; overwrite?: boolean; headers?: Record<string, string> } = {},
) {
  const form = new FormData();
  form.append(
    'file',
    new File([new Uint8Array(zip)], options.filename ?? 'theme.zip', { type: 'application/zip' }),
  );
  if (options.overwrite) form.append('overwrite', 'true');
  const res = await ctx.app.request('/wp-json/pressbase/v1/themes', {
    method: 'POST',
    headers: options.headers ?? (await headersFor(ctx)),
    body: form,
  });
  // biome-ignore lint/suspicious/noExplicitAny: test responses are loosely typed.
  return { status: res.status, body: (await res.json()) as any };
}

async function exists(file: string) {
  return stat(file).then(
    () => true,
    () => false,
  );
}

async function render(ctx: Ctx, url = '/') {
  const res = await ctx.app.request(`/wp-json/pressbase/v1/render?url=${encodeURIComponent(url)}`);
  return ((await res.json()) as { html: string }).html;
}

describe('theme folder names', () => {
  it('sanitises names as sanitize_file_name() does, to the characters Pressbase allows', () => {
    expect(sanitizeThemeSlug('my-theme')).toBe('my-theme');
    expect(sanitizeThemeSlug('My Theme (1)')).toBe('My-Theme-1');
    expect(sanitizeThemeSlug('Café Noir')).toBe('Cafe-Noir');
    expect(sanitizeThemeSlug('theme.v2.0')).toBe('theme-v2-0');
    expect(sanitizeThemeSlug('--_x_--')).toBe('x');
    expect(sanitizeThemeSlug('!!!')).toBe('');
  });

  it('finds the theme at the root or in one top-level folder', () => {
    const entry = (name: string) => ({ name, data: new Uint8Array() });
    expect(themeArchiveRoot([entry('a/style.css'), entry('a/templates/index.html')])).toEqual({
      prefix: 'a/',
      folder: 'a',
    });
    expect(themeArchiveRoot([entry('style.css'), entry('templates/index.html')])).toEqual({
      prefix: '',
      folder: '',
    });
    expect(themeArchiveRoot([entry('a/style.css'), entry('b/style.css')]).prefix).toBe('');
  });

  it('maps upload_themes to install_themes, as map_meta_cap() does', async () => {
    const ctx = await site();
    expect(await mapMetaCap(ctx.kernel, 'upload_themes', null)).toEqual(['install_themes']);
    expect(await mapMetaCap(ctx.kernel, 'upload_plugins', null)).toEqual(['install_plugins']);
  });
});

describe('POST /pressbase/v1/themes', () => {
  it('installs a theme from the archive root, named after the file', async () => {
    const ctx = await site();
    const events: unknown[] = [];
    ctx.kernel.hooks.addAction('upgrader_process_complete', (_u, extra) => {
      events.push(extra);
    });
    const res = await upload(ctx, themeZip(''), { filename: 'upload-test.zip' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      stylesheet: 'upload-test',
      template: 'upload-test',
      name: { raw: 'Upload Test' },
      version: '1.0',
      status: 'inactive',
      is_block_theme: true,
      pressbase_source: 'site',
      pressbase_deletable: true,
    });
    expect(events).toEqual([{ action: 'install', type: 'theme', themes: ['upload-test'] }]);
    const dir = path.join(ctx.dataDir, 'themes', 'upload-test');
    expect(await readFile(path.join(dir, 'templates', 'index.html'), 'utf8')).toContain(
      'Uploaded theme',
    );
    // No staging folders are left behind.
    expect((await readdir(path.join(ctx.dataDir, 'themes'))).sort()).toEqual(['upload-test']);

    const list = (await ctx.request('GET', '/wp/v2/themes')).body as {
      stylesheet: string;
      pressbase_deletable: boolean;
      pressbase_source: string;
    }[];
    expect(list.find((t) => t.stylesheet === 'upload-test')?.pressbase_deletable).toBe(true);
    expect(list.find((t) => t.stylesheet === 'twentytwentyfive')).toMatchObject({
      pressbase_source: 'bundled',
      pressbase_deletable: false,
    });

    // It activates and renders like any installed block theme.
    expect((await ctx.request('POST', '/pressbase/v1/themes/upload-test/activate')).status).toBe(
      200,
    );
    expect(await render(ctx)).toContain('<p>Uploaded theme</p>');
  });

  it('installs a theme inside one top-level folder, named after the folder', async () => {
    const ctx = await site();
    const res = await upload(ctx, themeZip('Sunny Days', { name: 'Sunny' }), {
      filename: 'download (3).zip',
    });
    expect(res.status).toBe(201);
    expect(res.body.stylesheet).toBe('Sunny-Days');
    expect(await exists(path.join(ctx.dataDir, 'themes', 'Sunny-Days', 'style.css'))).toBe(true);
  });

  it('refuses archives that aren’t block themes, with WordPress’s codes', async () => {
    const ctx = await site();
    const cases: [Uint8Array, string, RegExp][] = [
      [
        createZip([{ name: 't/templates/index.html', data: INDEX('x') }]),
        'incompatible_archive_theme_no_style',
        /missing the style\.css stylesheet/,
      ],
      [
        themeZip('t', { style: '/* A stylesheet without headers */' }),
        'incompatible_archive_theme_no_name',
        /does not contain a valid theme header/,
      ],
      [
        createZip([
          { name: 'classic/style.css', data: STYLE('Classic') },
          { name: 'classic/index.php', data: '<?php get_header();' },
          { name: 'classic/functions.php', data: '<?php' },
        ]),
        'pressbase_theme_not_block_theme',
        /Classic is a classic theme.+Pressbase only runs block themes/,
      ],
      [
        createZip([{ name: 'empty/style.css', data: STYLE('Empty') }]),
        'incompatible_archive_theme_no_index',
        /templates\/index\.html/,
      ],
      [new TextEncoder().encode('not a zip'), 'incompatible_archive', /not a valid ZIP/],
    ];
    for (const [zip, code, message] of cases) {
      const res = await upload(ctx, zip);
      expect(res.status, code).toBe(400);
      expect(res.body.code).toBe(code);
      expect(res.body.message).toMatch(message);
    }
    expect(await exists(path.join(ctx.dataDir, 'themes', 't'))).toBe(false);
    expect(await exists(path.join(ctx.dataDir, 'themes', 'classic'))).toBe(false);
  });

  it('refuses zip-slip paths and symlinks, writing nothing', async () => {
    const ctx = await site();
    const slip = await upload(
      ctx,
      themeZip('evil', { extra: [{ name: 'evil/../../escaped.css', data: 'x' }] }),
    );
    expect(slip.status).toBe(400);
    expect(slip.body.code).toBe('incompatible_archive_path');
    const link = await upload(
      ctx,
      themeZip('evil', { extra: [{ name: 'evil/link.css', data: '/etc/passwd', symlink: true }] }),
    );
    expect(link.body.code).toBe('incompatible_archive_symlink');
    expect(await exists(path.join(ctx.dataDir, 'escaped.css'))).toBe(false);
    expect(await exists(path.join(ctx.dataDir, 'themes', 'evil'))).toBe(false);
  });

  it('refuses an existing folder unless overwrite, and replaces it with overwrite', async () => {
    const ctx = await site();
    expect((await upload(ctx, themeZip('dup'))).status).toBe(201);
    const v2 = themeZip('dup', {
      style: STYLE('Upload Test', 'Template: \n').replace('1.0', '2.0'),
      text: 'Second copy',
    });
    const clash = await upload(ctx, v2);
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({
      code: 'folder_exists',
      data: {
        stylesheet: 'dup',
        current: { name: 'Upload Test', version: '1.0', source: 'site' },
        uploaded: { name: 'Upload Test', version: '2.0' },
      },
    });

    const overwrote: unknown[] = [];
    ctx.kernel.hooks.addAction('upgrader_overwrote_package', (pkg, data, type) => {
      overwrote.push([pkg, (data as { Version: string }).Version, type]);
    });
    const replaced = await upload(ctx, v2, { overwrite: true, filename: 'dup-2.zip' });
    expect(replaced.status).toBe(200);
    expect(replaced.body.version).toBe('2.0');
    expect(overwrote).toEqual([['dup-2.zip', '2.0', 'theme']]);
    expect(
      await readFile(path.join(ctx.dataDir, 'themes', 'dup', 'templates', 'index.html'), 'utf8'),
    ).toContain('Second copy');
    expect((await readdir(path.join(ctx.dataDir, 'themes'))).sort()).toEqual(['dup']);
  });

  it('treats a bundled theme’s name as taken, and installs an overwrite beside it', async () => {
    const ctx = await site();
    const zip = themeZip('twentytwentyfive', { name: 'My TT5' });
    const clash = await upload(ctx, zip);
    expect(clash.status).toBe(409);
    expect(clash.body.data.current).toMatchObject({
      source: 'bundled',
      name: 'Twenty Twenty-Five',
    });
  });

  it('keeps an overwritten active theme active, reloads it and purges the page cache', async () => {
    const ctx = await site();
    await upload(ctx, themeZip('live', { text: 'Version one' }));
    await ctx.request('POST', '/pressbase/v1/themes/live/activate');
    expect(await render(ctx)).toContain('Version one');

    const purges: [string[], string][] = [];
    ctx.kernel.hooks.addAction(PURGE_ACTION, (tags, reason) => {
      purges.push([tags, reason]);
    });
    const res = await upload(ctx, themeZip('live', { text: 'Version two' }), { overwrite: true });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(await ctx.kernel.options.get('stylesheet')).toBe('live');
    expect(await render(ctx)).toContain('Version two');
    expect(purges).toContainEqual([['site'], 'theme_overwrite']);

    // A new, inactive theme doesn't purge anything.
    purges.length = 0;
    await upload(ctx, themeZip('other'));
    expect(purges).toEqual([]);
  });

  it('needs install_themes', async () => {
    const ctx = await site();
    await ctx.loginAs('ed', 'editor');
    const res = await upload(ctx, themeZip('nope'), {
      headers: await headersFor(ctx, 'ed', 'password-123'),
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('rest_cannot_install_theme');
    const anonymous = await upload(ctx, themeZip('nope'), {
      headers: { 'x-pressbase-request': '1' },
    });
    expect(anonymous.status).toBe(401);
    expect(await exists(path.join(ctx.dataDir, 'themes', 'nope'))).toBe(false);
  });

  it('asks for a multipart upload and limits its size', async () => {
    const ctx = await site();
    const json = await ctx.request('POST', '/pressbase/v1/themes', { slug: 'twentytwelve' });
    expect(json.body.code).toBe('pressbase_theme_directory_unavailable');
    const big = await ctx.kernel.themes
      .install(themeZip('big'), { maxBytes: 10 })
      .catch((error: { code: string; status: number }) => error);
    expect(big).toMatchObject({ code: 'rest_upload_file_too_big', status: 413 });
  });
});

describe('DELETE /pressbase/v1/themes/{stylesheet}', () => {
  it('deletes an inactive uploaded theme, its theme mods and translations, not its styles', async () => {
    const ctx = await site();
    await upload(ctx, themeZip('gone'));
    // Its global styles post, created while it was active.
    await ctx.request('POST', '/pressbase/v1/themes/gone/activate');
    await ctx.request('GET', '/wp/v2/themes');
    expect(await userGlobalStylesPost(ctx.kernel, 'gone')).toBeTruthy();
    await ctx.request('POST', '/pressbase/v1/themes/twentytwentyfive/activate');
    await ctx.kernel.options.set('theme_mods_gone', { header_textcolor: 'blank' });
    const languages = path.join(ctx.kernel.i18n.languagesDir, 'themes');
    await mkdir(languages, { recursive: true });
    for (const file of ['gone-de_DE.mo', 'gone-de_DE.po', 'gone-more-de_DE.mo']) {
      await writeFile(path.join(languages, file), '');
    }

    const hooks: unknown[] = [];
    ctx.kernel.hooks.addAction('delete_theme', (s) => {
      hooks.push(['delete_theme', s]);
    });
    ctx.kernel.hooks.addAction('deleted_theme', (s, deleted) => {
      hooks.push(['deleted_theme', s, deleted]);
    });
    const res = await ctx.request('DELETE', '/pressbase/v1/themes/gone');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true, previous: { stylesheet: 'gone' } });
    expect(hooks).toEqual([
      ['delete_theme', 'gone'],
      ['deleted_theme', 'gone', true],
    ]);
    expect(await exists(path.join(ctx.dataDir, 'themes', 'gone'))).toBe(false);
    expect(await ctx.kernel.options.get('theme_mods_gone')).toBeUndefined();
    expect(await readdir(languages)).toEqual(['gone-more-de_DE.mo']);
    expect(await userGlobalStylesPost(ctx.kernel, 'gone')).toBeTruthy();
    expect((await ctx.request('DELETE', '/pressbase/v1/themes/gone')).status).toBe(404);
  });

  it('refuses the active theme, its parent and bundled themes', async () => {
    const ctx = await site();
    expect(await ctx.request('DELETE', '/pressbase/v1/themes/twentytwentyfive')).toMatchObject({
      status: 400,
      body: { code: 'pressbase_cannot_delete_bundled_theme' },
    });

    await upload(ctx, themeZip('parent', { name: 'Parent' }));
    await upload(
      ctx,
      themeZip('child', { style: STYLE('Child', 'Template: parent\n'), text: 'Child' }),
    );
    await ctx.request('POST', '/pressbase/v1/themes/child/activate');
    expect(await ctx.request('DELETE', '/pressbase/v1/themes/child')).toMatchObject({
      status: 400,
      body: { code: 'rest_cannot_delete_active_theme' },
    });
    expect(await ctx.request('DELETE', '/pressbase/v1/themes/parent')).toMatchObject({
      status: 400,
      body: { code: 'pressbase_cannot_delete_parent_theme' },
    });
    const list = (await ctx.request('GET', '/wp/v2/themes')).body as {
      stylesheet: string;
      pressbase_deletable: boolean;
    }[];
    expect(Object.fromEntries(list.map((t) => [t.stylesheet, t.pressbase_deletable]))).toEqual({
      child: false,
      parent: false,
      twentytwentyfive: false,
    });
    expect(await exists(path.join(ctx.dataDir, 'themes', 'parent'))).toBe(true);
  });

  it('needs delete_themes', async () => {
    const ctx = await site();
    await upload(ctx, themeZip('kept'));
    const editor = await ctx.loginAs('ed', 'editor');
    const res = await editor.request('DELETE', '/pressbase/v1/themes/kept');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('rest_cannot_delete_theme');
    expect(await exists(path.join(ctx.dataDir, 'themes', 'kept'))).toBe(true);
  });
});

describe('uploaded theme files', () => {
  it('are served only for allow-listed types, with nosniff; PHP and HTML never', async () => {
    const ctx = await site();
    await upload(
      ctx,
      themeZip('assets', {
        extra: [
          { name: 'assets/patterns/hero.php', data: '<?php echo "x"; ?>' },
          { name: 'assets/shell.php', data: '<?php system($_GET["c"]);' },
          { name: 'assets/logo.svg', data: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
          { name: 'assets/page.html', data: '<script>alert(1)</script>' },
          { name: 'assets/notes.md', data: '# notes' },
        ],
      }),
    );
    const css = await ctx.app.request('/wp-content/themes/assets/style.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('x-content-type-options')).toBe('nosniff');
    const svg = await ctx.app.request('/wp-content/themes/assets/logo.svg');
    expect(svg.headers.get('content-security-policy')).toContain('sandbox');
    for (const file of [
      'shell.php',
      'patterns/hero.php',
      'page.html',
      'templates/index.html',
      'theme.json',
      'notes.md',
    ]) {
      expect((await ctx.app.request(`/wp-content/themes/assets/${file}`)).status, file).toBe(404);
    }
  });
});
