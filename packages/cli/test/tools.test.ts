import { existsSync } from 'node:fs';
import path from 'node:path';
import { PURGE_ACTION } from '@pressbase/core/src/cache/invalidation';
import type { AttachmentMetadata } from '@pressbase/core/src/media/images';
import { META_FILE, META_METADATA, setMeta, uploadAttachment } from '@pressbase/core/src/media/service';
import { schema } from '@pressbase/db';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { site } from './helpers';

/** media regenerate and search-replace. */

async function png(width: number, height: number): Promise<Uint8Array> {
  return sharp({ create: { width, height, channels: 3, background: '#3858e9' } })
    .png()
    .toBuffer();
}

describe('media regenerate', () => {
  it('remakes sub-sizes after the sizes change, and removes unused files', async () => {
    const s = await site();
    const image = await uploadAttachment(s.kernel, {
      data: await png(400, 300),
      filename: 'harbour.png',
      user: null,
    });
    const uploads = path.join(s.dataDir, 'uploads');
    const meta = async () =>
      (await s.kernel.db.select().from(schema.postmeta).where(eq(schema.postmeta.postId, image.id)))
        .find((m) => m.key === META_METADATA)?.value as AttachmentMetadata;
    const before = await meta();
    const folder = path.dirname(before.file ?? '');
    expect(before.sizes?.thumbnail).toMatchObject({ width: 150, height: 150 });

    await s.ok(['option', 'update', 'thumbnail_size_w', '100']);
    await s.ok(['option', 'update', 'thumbnail_size_h', '100']);
    // Only-missing finds nothing to do: every size still has its file.
    expect(await s.ok(['media', 'regenerate', String(image.id), '--only-missing'])).toMatch(
      /1\/1 No missing sizes for "harbour" \(ID \d+\)\.\nSuccess: Regenerated 0 of 1 images \(1 already complete\)\./,
    );

    expect(await s.ok(['media', 'regenerate', String(image.id)])).toMatch(
      /^1\/1 Regenerated thumbnails for "harbour" \(ID \d+\)\.\nSuccess: Regenerated 1 of 1 images\.\n$/,
    );
    const after = await meta();
    expect(after.sizes?.thumbnail).toMatchObject({ width: 100, height: 100, file: 'harbour-100x100.png' });
    expect(existsSync(path.join(uploads, folder, 'harbour-100x100.png'))).toBe(true);
    expect(existsSync(path.join(uploads, folder, 'harbour-150x150.png'))).toBe(false);
    expect(existsSync(path.join(uploads, folder, 'harbour.png'))).toBe(true);

    // Every image needs a confirmation; a missing original is reported, not fatal to the rest.
    expect((await s.cli(['media', 'regenerate'])).stderr).toMatch(/Regenerate the sizes of all 1 images\? Add --yes/);
    await setMeta(s.kernel, image.id, META_FILE, `${folder}/gone.png`);
    const missing = await s.cli(['media', 'regenerate', '--yes']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/Warning: 1\/1 The original file of attachment \d+ is missing/);
    expect((await s.cli(['media', 'regenerate', '1'])).stderr).toMatch(/There’s no attachment with the ID 1\./);
  });
});

describe('search-replace', () => {
  it('replaces across tables and keeps JSON valid', async () => {
    const s = await site();
    const old = 'http://old.example';
    const content = `<!-- wp:image {"url":"${old}/a.png","caption":"x"} -->\n<figure><img src="${old}/a.png"/></figure>\n<!-- /wp:image -->`;
    const id = (await s.ok(['post', 'create', '-', '--post_title=Moving', '--porcelain'], { stdin: content })).trim();
    await setMeta(s.kernel, Number(id), 'links', { home: old, list: [`${old}/b`, 3], nested: JSON.stringify({ u: old }) });
    await s.kernel.options.set('cli_site', { url: old });
    await s.kernel.options.set('home', old);

    const dry = await s.ok(['search-replace', old, 'https://new.example/"q"', '--dry-run']);
    // The post and its revision, as wp-cli replaces in every row.
    expect(dry).toMatch(/posts\tpost_content\t4\ttext/);
    expect(dry).toMatch(/postmeta\tmeta_value\t3\tJSON/);
    expect(dry).toMatch(/options\toption_value\t2\tJSON/);
    expect(dry).toMatch(/Success: 9 replacements to be made\.\n$/);
    expect(await s.ok(['post', 'get', id, '--field=post_content'])).toBe(`${content}\n`);

    const asked = await s.cli(['search-replace', old, 'https://new.example']);
    expect(asked.stderr).toMatch(/Back up the database first; this can’t be undone\. Add --yes/);

    const purged: string[][] = [];
    s.kernel.hooks.addAction(PURGE_ACTION, (tags: string[]) => {
      purged.push(tags);
    });
    // A replacement with quotes, which would break JSON if replaced as plain text.
    const replacement = 'https://new.example/"q"';
    expect(await s.ok(['search-replace', old, replacement, '--yes', '--format=count'])).toBe('9\n');
    const updated = await s.ok(['post', 'get', id, '--field=post_content']);
    const attrs = /<!-- wp:image (\{.*?\}) -->/.exec(updated)?.[1] ?? '';
    expect(JSON.parse(attrs)).toEqual({ url: `${replacement}/a.png`, caption: 'x' });
    expect(attrs).toContain('\\u0022q\\u0022'); // serialize_block_attributes() escaping
    expect(updated).toContain(`<img src="${replacement}/a.png"/>`);
    expect(await s.kernel.posts.getMeta(Number(id), 'links')).toEqual({
      home: replacement,
      list: [`${replacement}/b`, 3],
      nested: JSON.stringify({ u: replacement }),
    });
    expect(await s.kernel.options.get('cli_site')).toEqual({ url: replacement });
    expect(await s.kernel.options.get('home')).toBe(replacement);
    expect(purged.flat()).toContain('site');
  });

  it('limits itself to tables and columns, and supports regular expressions', async () => {
    const s = await site();
    const id = (await s.ok(['post', 'create', '--post_title=Colour notes', '--post_content=colour and color', '--porcelain'])).trim();
    const only = await s.ok(['search-replace', 'colou?r', 'hue', '--regex', '--include-columns=post_content', '--report-changed-only', '--yes']);
    expect(only).toBe('Table\tColumn\tReplacements\tType\nposts\tpost_content\t4\ttext\nSuccess: Made 4 replacements.\n');
    expect(await s.ok(['post', 'get', id, '--fields=post_title,post_content', '--format=json'])).toBe(
      '{"post_title":"Colour notes","post_content":"hue and hue"}\n',
    );
    expect(await s.ok(['search-replace', 'COLOUR', 'Shade', '--regex', '--regex-flags=i', 'wp_posts', '--yes', '--format=count'])).toBe('2\n');
    expect(await s.ok(['search-replace', 'Test Site', 'Field notes', 'posts', '--yes', '--format=count'])).toBe('0\n');
    expect((await s.cli(['search-replace', 'a', 'b', 'users', '--dry-run'])).stderr).toMatch(/There’s no table called "users"/);
    expect((await s.cli(['search-replace', 'a', 'b', '--include-columns=user_pass', '--dry-run'])).stderr).toMatch(/no column called "user_pass"/);
    expect((await s.cli(['search-replace', '(', 'b', '--regex', '--dry-run'])).stderr).toMatch(/That regular expression isn’t valid/);
    expect((await s.cli(['search-replace', 'same', 'same'])).stderr).toMatch(/nothing to replace/);
  });
});
