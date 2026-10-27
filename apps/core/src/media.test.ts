import { existsSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { sanitizeFileName } from './media/filenames';
import { constrainDimensions, resizeDimensions } from './media/images';
import { checkFileType } from './media/mime';
import { filenameFromDisposition } from './routes/media';
import { keyFromPath } from './routes/uploads';
import { SITE, setup, type TestResponse } from './test-utils';

type Ctx = Awaited<ReturnType<typeof setup>>;

/** A solid-colour image generated in the test, in any format sharp writes. */
async function image(
  width: number,
  height: number,
  format: 'jpeg' | 'png' | 'webp' | 'gif' | 'avif' = 'jpeg',
  options: { orientation?: number } = {},
): Promise<Buffer> {
  let img = sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } },
  }).toFormat(format);
  if (options.orientation) img = img.withMetadata({ orientation: options.orientation });
  return img.toBuffer();
}

/** Logs in over HTTP and returns the session cookie, for requests the JSON client can't make. */
async function cookieFor(ctx: Ctx, login: string, password: string): Promise<string> {
  const res = await ctx.app.request('/wp-json/pressbase/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pressbase-request': '1' },
    body: JSON.stringify({ login, password }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function installed() {
  const ctx = await setup();
  await ctx.install();
  const admin = await cookieFor(ctx, SITE.username, SITE.password);
  return { ...ctx, admin };
}

async function json(res: Response): Promise<TestResponse> {
  return { status: res.status, body: await res.json(), headers: res.headers };
}

/** multipart/form-data upload, as the admin's library sends it. */
async function upload(
  ctx: Ctx,
  cookie: string,
  file: Uint8Array,
  name: string,
  fields: Record<string, string> = {},
  type = 'application/octet-stream',
) {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(file)], name, { type }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return json(
    await ctx.app.request('/wp-json/wp/v2/media', {
      method: 'POST',
      headers: { cookie, 'x-pressbase-request': '1' },
      body: form,
    }),
  );
}

async function rest(ctx: Ctx, cookie: string, method: string, url: string, body?: unknown) {
  return json(
    await ctx.app.request(`/wp-json${url}`, {
      method,
      headers: { cookie, 'x-pressbase-request': '1', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

const yearMonth = () => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SITE.timezone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  return `${parts.find((p) => p.type === 'year')?.value}/${parts.find((p) => p.type === 'month')?.value}`;
};

describe('helpers ported from WordPress', () => {
  it('sanitizes file names like sanitize_file_name()', () => {
    expect(sanitizeFileName('My Holiday Photo (1).JPG')).toBe('My-Holiday-Photo-1.jpg');
    expect(sanitizeFileName('Café du Monde.png')).toBe('Cafe-du-Monde.png');
    expect(sanitizeFileName('shell.php.jpg')).toBe('shell.php_.jpg');
    expect(sanitizeFileName('../../etc/passwd.txt')).toBe('etcpasswd.txt');
    expect(sanitizeFileName('jpg')).toBe('unnamed-file.jpg');
  });

  it('computes sizes like image_resize_dimensions()', () => {
    expect(resizeDimensions(1200, 800, 300, 300, false)).toMatchObject({ width: 300, height: 200 });
    expect(resizeDimensions(1200, 800, 150, 150, true)).toMatchObject({
      width: 150,
      height: 150,
      left: 200,
      top: 0,
      cropWidth: 800,
      cropHeight: 800,
    });
    // Never upscales; a 0 height means "any height".
    expect(resizeDimensions(200, 100, 300, 300, false)).toBeUndefined();
    expect(resizeDimensions(1200, 800, 768, 0, false)).toMatchObject({ width: 768, height: 512 });
    expect(constrainDimensions(465, 700, 177, 177)).toEqual([118, 177]);
  });

  it('checks the content against the extension', async () => {
    const png = await image(10, 10, 'png');
    expect(checkFileType('a.png', png)).toEqual({ ext: 'png', type: 'image/png' });
    // A PNG named .jpg is corrected, as WordPress does.
    expect(checkFileType('a.jpg', png)).toMatchObject({
      type: 'image/png',
      properFilename: 'a.png',
    });
    expect(checkFileType('a.pdf', png)).toBeUndefined();
    expect(
      checkFileType('a.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBeUndefined();
    expect(checkFileType('a.txt', Buffer.from('<html><script>alert(1)</script>'))).toBeUndefined();
    expect(checkFileType('a.exe', Buffer.from('MZ\x90\x00'))).toBeUndefined();
    expect(checkFileType('notes.txt', Buffer.from('Just some notes.\n'))).toMatchObject({
      type: 'text/plain',
    });
    expect(checkFileType('doc.pdf', Buffer.from('%PDF-1.7\n'))).toMatchObject({
      type: 'application/pdf',
    });
  });

  it('parses Content-Disposition and refuses unsafe upload paths', () => {
    expect(filenameFromDisposition('attachment; filename="photo one.jpg"')).toBe('photo one.jpg');
    expect(filenameFromDisposition("attachment; filename*=UTF-8''caf%C3%A9.png")).toBe('café.png');
    expect(filenameFromDisposition('attachment')).toBeUndefined();
    expect(keyFromPath('/wp-content/uploads/2026/10/a.jpg')).toBe('2026/10/a.jpg');
    for (const bad of [
      '/wp-content/uploads/..%2Fconfig.json',
      '/wp-content/uploads/2026/%2e%2e/x.jpg',
      '/wp-content/uploads/a%5C..%5Cb.jpg',
      '/wp-content/uploads/.hidden.jpg',
      '/wp-content/uploads/a%00.jpg',
      '/wp-content/uploads//a.jpg',
    ]) {
      expect(keyFromPath(bad), bad).toBeUndefined();
    }
  });
});

describe('POST /wp/v2/media', () => {
  it('stores an image with WordPress meta and every sub-size', async () => {
    const ctx = await installed();
    const res = await upload(ctx, ctx.admin, await image(1200, 800), 'Beach Day.jpg', {
      alt_text: 'Waves on the sand',
      caption: 'Summer',
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('Location')).toBe(`/wp-json/wp/v2/media/${res.body.id}`);
    const folder = yearMonth();
    expect(res.body).toMatchObject({
      type: 'attachment',
      status: 'inherit',
      slug: 'beach-day',
      title: { raw: 'Beach Day' },
      alt_text: 'Waves on the sand',
      caption: { raw: 'Summer', rendered: '<p>Summer</p>\n' },
      media_type: 'image',
      mime_type: 'image/jpeg',
      post: null,
      source_url: `http://localhost:3000/wp-content/uploads/${folder}/Beach-Day.jpg`,
      missing_image_sizes: [],
    });
    expect(res.body.guid.raw).toBe(res.body.source_url);
    const details = res.body.media_details;
    expect(details).toMatchObject({ width: 1200, height: 800, file: `${folder}/Beach-Day.jpg` });
    expect(details.filesize).toBeGreaterThan(0);
    expect(details.image_meta.orientation).toBe(0);
    const sizes = Object.fromEntries(
      Object.entries(
        details.sizes as Record<string, { file: string; width: number; height: number }>,
      ).map(([name, s]) => [name, `${s.file} ${s.width}x${s.height}`]),
    );
    expect(sizes).toEqual({
      thumbnail: 'Beach-Day-150x150.jpg 150x150',
      medium: 'Beach-Day-300x200.jpg 300x200',
      medium_large: 'Beach-Day-768x512.jpg 768x512',
      large: 'Beach-Day-1024x683.jpg 1024x683',
      full: 'Beach-Day.jpg 1200x800',
    });
    expect(details.sizes.medium).toMatchObject({
      mime_type: 'image/jpeg',
      source_url: `http://localhost:3000/wp-content/uploads/${folder}/Beach-Day-300x200.jpg`,
    });

    // Files on disk, with the dimensions the metadata promises and no EXIF.
    const dir = path.join(ctx.dataDir, 'uploads', folder);
    const medium = await sharp(path.join(dir, 'Beach-Day-300x200.jpg')).metadata();
    expect([medium.width, medium.height, medium.format]).toEqual([300, 200, 'jpeg']);
    expect(medium.exif).toBeUndefined();

    // Meta keys exactly as WordPress names them.
    const meta = await ctx.kernel.posts.getMeta(res.body.id, '_wp_attached_file');
    expect(meta).toBe(`${folder}/Beach-Day.jpg`);
    const stored = (await ctx.kernel.posts.getMeta(res.body.id, '_wp_attachment_metadata')) as {
      sizes: Record<string, Record<string, unknown>>;
    };
    expect(stored.sizes.thumbnail?.['mime-type']).toBe('image/jpeg');
    expect(await ctx.kernel.posts.getMeta(res.body.id, '_wp_attachment_image_alt')).toBe(
      'Waves on the sand',
    );
  });

  it('scales big images to 2560 and keeps the original, in its own format', async () => {
    const ctx = await installed();
    const res = await upload(ctx, ctx.admin, await image(3000, 1500, 'png'), 'panorama.png');
    expect(res.status).toBe(201);
    const details = res.body.media_details;
    expect(details).toMatchObject({
      width: 2560,
      height: 1280,
      original_image: 'panorama.png',
    });
    expect(details.file).toMatch(/\/panorama-scaled\.png$/);
    expect(res.body.source_url).toMatch(/\/panorama-scaled\.png$/);
    expect(details.sizes['2048x2048']).toMatchObject({ file: 'panorama-2048x1024.png' });
    expect(details.sizes.large).toMatchObject({
      file: 'panorama-1024x512.png',
      mime_type: 'image/png',
    });
    const dir = path.join(ctx.dataDir, 'uploads', yearMonth());
    expect(existsSync(path.join(dir, 'panorama.png'))).toBe(true);
    const scaled = await sharp(path.join(dir, 'panorama-scaled.png')).metadata();
    expect([scaled.width, scaled.height, scaled.format]).toEqual([2560, 1280, 'png']);
  });

  it('turns photos upright from their EXIF orientation', async () => {
    const ctx = await installed();
    // Stored 400x200 with "rotate 90°" (6): displayed 200x400.
    const res = await upload(
      ctx,
      ctx.admin,
      await image(400, 200, 'jpeg', { orientation: 6 }),
      'phone.jpg',
    );
    expect(res.status).toBe(201);
    expect(res.body.media_details).toMatchObject({
      width: 200,
      height: 400,
      original_image: 'phone.jpg',
      image_meta: { orientation: 1 },
    });
    expect(res.body.media_details.file).toMatch(/phone-rotated\.jpg$/);
    expect(res.body.media_details.sizes.medium).toMatchObject({ width: 150, height: 300 });
  });

  it('makes file names unique, as wp_unique_filename() does', async () => {
    const ctx = await installed();
    const jpg = await image(500, 400);
    const names = [];
    for (let i = 0; i < 3; i++) {
      const res = await upload(ctx, ctx.admin, jpg, 'photo.jpg');
      names.push(res.body.media_details.file.split('/').pop());
      expect(res.body.slug).toBe(i === 0 ? 'photo' : `photo-${i + 1}`);
    }
    expect(names).toEqual(['photo.jpg', 'photo-1.jpg', 'photo-2.jpg']);
    // A name that looks like a sub-size always gets a number.
    const sized = await upload(ctx, ctx.admin, jpg, 'banner-300x200.jpg');
    expect(sized.body.media_details.file).toMatch(/banner-300x200-1\.jpg$/);
  });

  it('accepts a raw body with Content-Disposition, and documents without sizes', async () => {
    const ctx = await installed();
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
    const res = await json(
      await ctx.app.request('/wp-json/wp/v2/media?title=Annual%20report', {
        method: 'POST',
        headers: {
          cookie: ctx.admin,
          'x-pressbase-request': '1',
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="report 2026.pdf"',
        },
        body: pdf,
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      title: { raw: 'Annual report' },
      media_type: 'file',
      mime_type: 'application/pdf',
      media_details: { filesize: pdf.length, sizes: {} },
    });
    expect(res.body.source_url).toMatch(/\/report-2026\.pdf$/);

    const missing = await json(
      await ctx.app.request('/wp-json/wp/v2/media', {
        method: 'POST',
        headers: {
          cookie: ctx.admin,
          'x-pressbase-request': '1',
          'content-type': 'application/pdf',
        },
        body: pdf,
      }),
    );
    expect(missing.body.code).toBe('rest_upload_no_content_disposition');
  });

  it('rejects disallowed and disguised files', async () => {
    const ctx = await installed();
    const svg = await upload(
      ctx,
      ctx.admin,
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      'logo.svg',
    );
    expect(svg.status).toBe(400);
    expect(svg.body.code).toBe('rest_upload_invalid_type');

    const exe = await upload(
      ctx,
      ctx.admin,
      Buffer.from('MZ\x90\x00\x03\x00\x00\x00'),
      'setup.exe',
    );
    expect(exe.body.code).toBe('rest_upload_invalid_type');

    // HTML disguised as an image.
    const fake = await upload(
      ctx,
      ctx.admin,
      Buffer.from('<html><script>x</script></html>'),
      'cat.jpg',
    );
    expect(fake.status).toBe(400);
    expect(fake.body.code).toBe('rest_upload_invalid_type');

    const empty = await upload(ctx, ctx.admin, new Uint8Array(), 'empty.jpg');
    expect(empty.body.code).toBe('rest_upload_no_data');

    // Nothing was stored.
    const list = await rest(ctx, ctx.admin, 'GET', '/wp/v2/media');
    expect(list.body).toEqual([]);
  });

  it('enforces the upload size limit', async () => {
    const ctx = await setup({ maxUploadMb: 1 });
    await ctx.install();
    const admin = await cookieFor(ctx, SITE.username, SITE.password);
    const big = Buffer.alloc(1024 * 1024 + 10, 0x20);
    big.write('Plain text');
    const res = await upload(ctx, admin, big, 'notes.txt');
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('rest_upload_file_too_big');
  });

  it('needs upload_files: contributors get 403, visitors 401', async () => {
    const ctx = await installed();
    await ctx.loginAs('connie', 'contributor');
    const contributor = await cookieFor(ctx, 'connie', 'password-123');
    const res = await upload(ctx, contributor, await image(20, 20), 'a.jpg');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('rest_cannot_create');
    const visitor = await upload(ctx, '', await image(20, 20), 'a.jpg');
    expect(visitor.status).toBe(401);
  });
});

describe('reading, editing and deleting media', () => {
  it('lists with filters and pagination headers', async () => {
    const ctx = await installed();
    await upload(ctx, ctx.admin, await image(40, 40, 'png'), 'red square.png');
    await upload(ctx, ctx.admin, await image(40, 40, 'webp'), 'tile.webp');
    await upload(ctx, ctx.admin, Buffer.from('a,b\n1,2\n'), 'data.csv');

    const all = await rest(ctx, '', 'GET', '/wp/v2/media?per_page=2');
    expect(all.status).toBe(200);
    expect(all.headers.get('X-WP-Total')).toBe('3');
    expect(all.headers.get('X-WP-TotalPages')).toBe('2');
    expect(all.body).toHaveLength(2);

    const images = await rest(ctx, '', 'GET', '/wp/v2/media?media_type=image');
    expect(images.body.map((m: { mime_type: string }) => m.mime_type).sort()).toEqual([
      'image/png',
      'image/webp',
    ]);
    const files = await rest(ctx, '', 'GET', '/wp/v2/media?media_type=text');
    expect(files.body.map((m: { mime_type: string }) => m.mime_type)).toEqual(['text/csv']);
    const png = await rest(ctx, '', 'GET', '/wp/v2/media?mime_type=image/png');
    expect(png.body).toHaveLength(1);
    const search = await rest(ctx, '', 'GET', '/wp/v2/media?search=square');
    expect(search.body.map((m: { slug: string }) => m.slug)).toEqual(['red-square']);
    // Raw fields need the edit context.
    expect(all.body[0].title.raw).toBeUndefined();
  });

  it('updates title, alt text, caption, description and parent', async () => {
    const ctx = await installed();
    const created = await upload(ctx, ctx.admin, await image(30, 30), 'x.jpg');
    const post = await rest(ctx, ctx.admin, 'POST', '/wp/v2/posts', { title: 'Story' });
    const res = await rest(ctx, ctx.admin, 'POST', `/wp/v2/media/${created.body.id}`, {
      title: 'New title',
      alt_text: '  A <b>bold</b> alt  ',
      caption: 'Caption',
      description: 'Line one\n\nLine two',
      post: post.body.id,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      title: { raw: 'New title' },
      alt_text: 'A bold alt',
      caption: { raw: 'Caption' },
      description: { raw: 'Line one\n\nLine two', rendered: '<p>Line one</p>\n<p>Line two</p>\n' },
      post: post.body.id,
    });
    const attached = await rest(ctx, ctx.admin, 'GET', `/wp/v2/media?parent=${post.body.id}`);
    expect(attached.body.map((m: { id: number }) => m.id)).toEqual([created.body.id]);
    // A draft parent hides its media from visitors.
    const visitor = await rest(ctx, '', 'GET', `/wp/v2/media/${created.body.id}`);
    expect(visitor.status).toBe(401);
  });

  it('lets authors edit only their own media', async () => {
    const ctx = await installed();
    const adminMedia = await upload(ctx, ctx.admin, await image(30, 30), 'admin.jpg');
    await ctx.loginAs('ann', 'author');
    const author = await cookieFor(ctx, 'ann', 'password-123');
    const own = await upload(ctx, author, await image(30, 30), 'mine.jpg');
    expect(own.status).toBe(201);

    const editOwn = await rest(ctx, author, 'PATCH', `/wp/v2/media/${own.body.id}`, {
      alt_text: 'Mine',
    });
    expect(editOwn.status).toBe(200);
    const editOther = await rest(ctx, author, 'PATCH', `/wp/v2/media/${adminMedia.body.id}`, {
      alt_text: 'Hijacked',
    });
    expect(editOther.status).toBe(403);
    expect(editOther.body.code).toBe('rest_cannot_edit');
    const deleteOther = await rest(
      ctx,
      author,
      'DELETE',
      `/wp/v2/media/${adminMedia.body.id}?force=true`,
    );
    expect(deleteOther.status).toBe(403);
    const editContext = await rest(
      ctx,
      author,
      'GET',
      `/wp/v2/media/${adminMedia.body.id}?context=edit`,
    );
    expect(editContext.status).toBe(403);
  });

  it('deletes the row and every file, and needs force', async () => {
    const ctx = await installed();
    const created = await upload(ctx, ctx.admin, await image(3000, 2000), 'huge.jpg');
    const dir = path.join(ctx.dataDir, 'uploads', yearMonth());
    const files = [
      'huge.jpg',
      'huge-scaled.jpg',
      ...Object.values(created.body.media_details.sizes as Record<string, { file: string }>).map(
        (s) => s.file,
      ),
    ];
    for (const file of files) expect(existsSync(path.join(dir, file)), file).toBe(true);

    const soft = await rest(ctx, ctx.admin, 'DELETE', `/wp/v2/media/${created.body.id}`);
    expect(soft.status).toBe(501);
    expect(soft.body.code).toBe('rest_trash_not_supported');

    const res = await rest(ctx, ctx.admin, 'DELETE', `/wp/v2/media/${created.body.id}?force=true`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true, previous: { id: created.body.id } });
    for (const file of files) expect(existsSync(path.join(dir, file)), file).toBe(false);
    expect((await rest(ctx, ctx.admin, 'GET', `/wp/v2/media/${created.body.id}`)).status).toBe(404);
  });
});

describe('GET /wp-content/uploads/*', () => {
  it('serves files with safe, cacheable headers', async () => {
    const ctx = await installed();
    const created = await upload(ctx, ctx.admin, await image(64, 48, 'png'), 'pixel.png');
    const url = new URL(created.body.source_url).pathname;
    const res = await ctx.app.request(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toContain('max-age=31536000');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    const etag = res.headers.get('etag') ?? '';
    expect(etag).toBeTruthy();
    expect(res.headers.get('last-modified')).toBeTruthy();
    const body = Buffer.from(await res.arrayBuffer());
    expect((await sharp(body).metadata()).width).toBe(64);

    const cached = await ctx.app.request(url, { headers: { 'if-none-match': etag } });
    expect(cached.status).toBe(304);

    const partial = await ctx.app.request(url, { headers: { range: 'bytes=0-7' } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(`bytes 0-7/${body.length}`);
    expect(Buffer.from(await partial.arrayBuffer())).toEqual(body.subarray(0, 8));
  });

  it('refuses traversal, hidden files, symlinks out and unknown types with 404', async () => {
    const ctx = await installed();
    const uploads = path.join(ctx.dataDir, 'uploads');
    await mkdir(uploads, { recursive: true });
    await writeFile(path.join(uploads, '.env.txt'), 'secret');
    await writeFile(path.join(uploads, 'script.js'), 'alert(1)');
    await symlink(path.join(ctx.dataDir, 'config.json'), path.join(uploads, 'config.txt'));
    await writeFile(path.join(ctx.dataDir, 'config.json'), '{"databaseUrl":"secret"}');
    for (const url of [
      '/wp-content/uploads/../config.json',
      '/wp-content/uploads/..%2Fconfig.json',
      '/wp-content/uploads/%2e%2e/config.json',
      '/wp-content/uploads/..%5Cconfig.json',
      '/wp-content/uploads/.env.txt',
      '/wp-content/uploads/script.js',
      '/wp-content/uploads/config.txt',
      '/wp-content/uploads/missing.jpg',
    ]) {
      const res = await ctx.app.request(url);
      expect(res.status, url).toBe(404);
      expect(await res.text(), url).not.toContain('secret');
    }
  });
});

describe('featured images', () => {
  it('round-trips featured_media on posts and pages and validates it', async () => {
    const ctx = await installed();
    const img = await upload(ctx, ctx.admin, await image(40, 40), 'cover.jpg');
    const doc = await upload(ctx, ctx.admin, Buffer.from('Notes\n'), 'notes.txt');

    const post = await rest(ctx, ctx.admin, 'POST', '/wp/v2/posts', {
      title: 'With cover',
      featured_media: img.body.id,
    });
    expect(post.status).toBe(201);
    expect(post.body.featured_media).toBe(img.body.id);
    expect(await ctx.kernel.posts.getMeta(post.body.id, '_thumbnail_id')).toBe(img.body.id);
    const listed = await rest(ctx, ctx.admin, 'GET', '/wp/v2/posts?status=draft&context=edit');
    expect(listed.body[0].featured_media).toBe(img.body.id);

    const page = await rest(ctx, ctx.admin, 'POST', '/wp/v2/pages', {
      title: 'Page',
      featured_media: img.body.id,
    });
    expect(page.body.featured_media).toBe(img.body.id);

    for (const bad of [doc.body.id, post.body.id, 999999]) {
      const res = await rest(ctx, ctx.admin, 'POST', `/wp/v2/posts/${post.body.id}`, {
        featured_media: bad,
      });
      expect(res.status, String(bad)).toBe(400);
      expect(res.body.code).toBe('rest_invalid_featured_media');
    }

    const cleared = await rest(ctx, ctx.admin, 'POST', `/wp/v2/posts/${post.body.id}`, {
      featured_media: 0,
    });
    expect(cleared.body.featured_media).toBe(0);

    // Deleting the image clears it from posts that used it.
    await rest(ctx, ctx.admin, 'POST', `/wp/v2/posts/${post.body.id}`, {
      featured_media: img.body.id,
    });
    await rest(ctx, ctx.admin, 'DELETE', `/wp/v2/media/${img.body.id}?force=true`);
    const after = await rest(ctx, ctx.admin, 'GET', `/wp/v2/posts/${post.body.id}?context=edit`);
    expect(after.body.featured_media).toBe(0);
  });
});

describe('Settings → Media', () => {
  it('exposes size and folder settings, and new uploads follow them', async () => {
    const ctx = await installed();
    const current = await rest(ctx, ctx.admin, 'GET', '/wp/v2/settings');
    expect(current.body).toMatchObject({
      thumbnail_size_w: 150,
      thumbnail_crop: true,
      medium_size_w: 300,
      large_size_h: 1024,
      uploads_use_yearmonth_folders: true,
    });
    const bad = await rest(ctx, ctx.admin, 'POST', '/wp/v2/settings', { medium_size_w: -5 });
    expect(bad.status).toBe(400);
    const saved = await rest(ctx, ctx.admin, 'POST', '/wp/v2/settings', {
      thumbnail_size_w: 100,
      thumbnail_size_h: 100,
      thumbnail_crop: false,
      uploads_use_yearmonth_folders: false,
    });
    expect(saved.status).toBe(200);
    const res = await upload(ctx, ctx.admin, await image(400, 200), 'flat.jpg');
    expect(res.body.media_details.file).toBe('flat.jpg');
    expect(res.body.media_details.sizes.thumbnail).toMatchObject({
      file: 'flat-100x50.jpg',
      width: 100,
      height: 50,
    });
  });
});
