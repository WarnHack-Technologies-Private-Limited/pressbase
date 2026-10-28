import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { site } from './helpers';

/** post, term and comment commands, on an in-memory site. */

describe('post', () => {
  it('lists posts with WP_Post field names, in every format', async () => {
    const s = await site();
    expect(await s.ok(['post', 'list', '--format=json'])).toMatch(
      /^\[\{"ID":1,"post_title":"Hello world!","post_name":"hello-world","post_date":"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d","post_status":"publish"\}\]\n$/,
    );
    expect(await s.ok(['post', 'list', '--post_type=page', '--format=ids'])).toBe('2\n');
    expect(await s.ok(['post', 'list', '--post_type=any', '--format=count'])).toBe('2\n');
    expect(await s.ok(['post', 'list', '--fields=ID,post_type', '--format=csv'])).toBe(
      'ID,post_type\n1,post\n',
    );
    expect(await s.ok(['post', 'list', '--field=post_name'])).toBe('hello-world\n');
    expect(await s.ok(['post', 'list', '--s=nothing-matches', '--format=count'])).toBe('0\n');
    const bad = await s.cli(['post', 'list', '--fields=ID,nope']);
    expect(bad).toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/There’s no field “nope”/),
    });
    const unknown = await s.cli(['post', 'list', '--meta_key=x']);
    expect(unknown.stderr).toMatch(/--meta_key isn’t a query argument/);
  });

  it('creates, reads, updates and deletes posts', async () => {
    const s = await site();
    const id = (
      await s.ok([
        'post',
        'create',
        '--post_title=Launch notes',
        '--post_status=publish',
        '--tags_input=launch,notes',
        '--meta_input={"source":"cli"}',
        '--porcelain',
      ])
    ).trim();
    expect(id).toMatch(/^\d+$/);
    const post = JSON.parse(await s.ok(['post', 'get', id, '--format=json']));
    expect(post).toMatchObject({
      post_title: 'Launch notes',
      post_status: 'publish',
      post_name: 'launch-notes',
      post_type: 'post',
      post_author: 0,
    });
    expect(await s.kernel.posts.getMeta(Number(id), 'source')).toBe('cli');
    const tags = await s.kernel.terms.objectTermIds([Number(id)], 'post_tag');
    expect(tags.get(Number(id))?.length).toBe(2);
    // Uncategorized, by default.
    expect((await s.kernel.terms.objectTermIds([Number(id)], 'category')).get(Number(id))).toEqual([
      1,
    ]);

    expect(await s.ok(['post', 'update', id, '--post_title=Revised', '--post_status=draft'])).toBe(
      `Success: Updated post ${id}.\n`,
    );
    expect(await s.ok(['post', 'get', id, '--field=post_title'])).toBe('Revised\n');
    expect(await s.ok(['post', 'get', id, '--field=post_status'])).toBe('draft\n');

    const invalid = await s.cli(['post', 'update', id, '--post_status=bogus']);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toMatch(/^Error: --post_status: /);

    expect(await s.ok(['post', 'delete', id])).toBe(`Success: Trashed post ${id}.\n`);
    expect(await s.ok(['post', 'get', id, '--field=post_status'])).toBe('trash\n');
    const again = await s.cli(['post', 'delete', id]);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/already in the Trash\. Add --force/);

    // --force deletes permanently, and asks first.
    const asked = await s.cli(['post', 'delete', id, '--force']);
    expect(asked.code).toBe(1);
    expect(asked.stderr).toMatch(/Permanently delete post \d+\? This can’t be undone\. Add --yes/);
    expect(await s.ok(['post', 'delete', id, '--force', '--yes'])).toBe(
      `Success: Deleted post ${id}.\n`,
    );
    expect((await s.cli(['post', 'get', id])).stderr).toBe(
      `Error: There’s no post with the ID ${id}.\n`,
    );
  });

  it('reads content from a file or standard input', async () => {
    const s = await site();
    await writeFile(
      path.join(s.dataDir, 'body.html'),
      '<!-- wp:paragraph -->\n<p>From a file.</p>\n<!-- /wp:paragraph -->',
    );
    const fromFile = (
      await s.ok(['post', 'create', 'body.html', '--post_title=File', '--porcelain'])
    ).trim();
    expect(await s.ok(['post', 'get', fromFile, '--field=post_content'])).toMatch(/From a file\./);

    const fromStdin = (
      await s.ok(['post', 'create', '-', '--post_type=page', '--post_title=About', '--porcelain'], {
        stdin: '<p>Piped in.</p>',
      })
    ).trim();
    expect(
      await s.ok(['post', 'get', fromStdin, '--fields=post_type,post_content', '--format=json']),
    ).toBe('{"post_type":"page","post_content":"<p>Piped in.</p>"}\n');
    await s.ok(['post', 'update', fromStdin, '-'], { stdin: '<p>Replaced.</p>' });
    expect(await s.ok(['post', 'get', fromStdin, '--field=post_content'])).toBe(
      '<p>Replaced.</p>\n',
    );

    const missing = await s.cli(['post', 'create', 'nowhere.html']);
    expect(missing.stderr).toMatch(/There’s no file at .+nowhere\.html/);
  });

  it('applies the user’s capabilities with --user', async () => {
    const s = await site();
    const contributor = await s.loginAs('casey', 'contributor');
    await s.loginAs('sub', 'subscriber');

    const denied = await s.cli(['post', 'create', '--post_title=No', '--user=sub']);
    expect(denied).toMatchObject({
      code: 1,
      stderr: 'Error: sub isn’t allowed to create posts.\n',
    });

    const publish = await s.cli([
      'post',
      'create',
      '--post_title=No',
      '--post_status=publish',
      '--user=casey',
    ]);
    expect(publish.stderr).toBe('Error: casey isn’t allowed to publish posts.\n');

    const id = (
      await s.ok([
        'post',
        'create',
        '--post_title=Pending piece',
        '--post_status=pending',
        '--user=casey',
        '--porcelain',
      ])
    ).trim();
    expect(await s.ok(['post', 'get', id, '--field=post_author'])).toBe(`${contributor.id}\n`);
    // Contributors can't edit the administrator's post, and can only list published posts.
    expect((await s.cli(['post', 'update', '1', '--post_title=Mine', '--user=casey'])).stderr).toBe(
      'Error: casey isn’t allowed to edit post 1.\n',
    );
    expect((await s.cli(['post', 'list', '--user=sub'])).stderr).toMatch(
      /can only list published posts/,
    );
    expect(
      await s.ok(['post', 'list', '--post_status=publish', '--user=sub', '--format=ids']),
    ).toBe('1\n');
    // Without unfiltered_html, content is filtered as in the admin.
    await s.ok([
      'post',
      'update',
      id,
      '--post_content=<p>Hi</p><script>alert(1)</script>',
      '--user=casey',
    ]);
    expect(await s.ok(['post', 'get', id, '--field=post_content'])).toBe('<p>Hi</p>\n');

    const unknown = await s.cli(['post', 'list', '--user=nobody']);
    expect(unknown.stderr).toMatch(/There’s no user “nobody”/);
  });
});

describe('term', () => {
  it('lists, creates and deletes terms', async () => {
    const s = await site();
    expect(
      await s.ok(['term', 'list', 'category', '--fields=term_id,name,count', '--format=json']),
    ).toBe('[{"term_id":1,"name":"Uncategorized","count":1}]\n');
    const id = (
      await s.ok(['term', 'create', 'category', 'Travel', '--description=Trips', '--porcelain'])
    ).trim();
    expect(await s.ok(['term', 'create', 'post_tag', 'trains'])).toMatch(
      /^Success: Created post_tag \d+\.\n$/,
    );
    expect(await s.ok(['term', 'list', 'category', 'post_tag', '--field=slug'])).toBe(
      'travel\nuncategorized\ntrains\n',
    );
    const dup = await s.cli(['term', 'create', 'category', 'Travel']);
    expect(dup.stderr).toMatch(/already exists/);
    expect((await s.cli(['term', 'list', 'genre'])).stderr).toMatch(
      /There’s no taxonomy “genre”\. Taxonomies: category, post_tag/,
    );

    expect((await s.cli(['term', 'delete', 'category', 'travel', '--by=slug'])).stderr).toMatch(
      /Add --yes/,
    );
    expect(await s.ok(['term', 'delete', 'category', 'travel', '--by=slug', '--yes'])).toBe(
      `Success: Deleted category ${id}.\n`,
    );
    const fallback = await s.cli(['term', 'delete', 'category', '1', '--yes']);
    expect(fallback.stderr).toMatch(/default category cannot be deleted/);
  });
});

describe('comment', () => {
  it('lists and moderates comments', async () => {
    const s = await site();
    expect(
      await s.ok([
        'comment',
        'list',
        '--fields=comment_ID,comment_approved,comment_author',
        '--format=csv',
      ]),
    ).toBe('comment_ID,comment_approved,comment_author\n1,1,A Pressbase Commenter\n');
    expect(await s.ok(['comment', 'spam', '1'])).toBe('Success: Marked comment 1 as spam.\n');
    expect(await s.ok(['comment', 'list', '--status=spam', '--format=ids'])).toBe('1\n');
    expect(await s.ok(['comment', 'list', '--format=count'])).toBe('0\n');
    expect(await s.ok(['comment', 'approve', '1'])).toBe('Success: Approved comment 1.\n');
    expect((await s.kernel.posts.get(1))?.commentCount).toBe(1);
    expect(await s.ok(['comment', 'delete', '1'])).toBe('Success: Trashed comment 1.\n');
    expect((await s.kernel.posts.get(1))?.commentCount).toBe(0);
    expect(await s.ok(['comment', 'delete', '1', '--force', '--yes'])).toBe(
      'Success: Deleted comment 1.\n',
    );
    expect((await s.cli(['comment', 'approve', '1'])).stderr).toBe(
      'Error: There’s no comment with the ID 1.\n',
    );

    await s.loginAs('sub', 'subscriber');
    expect((await s.cli(['comment', 'list', '--user=sub'])).stderr).toBe(
      'Error: sub isn’t allowed to moderate comments.\n',
    );
  });
});
