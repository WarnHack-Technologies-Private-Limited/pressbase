import { describe, expect, it } from 'vitest';
import { setup } from './test-utils';

/**
 * Themes × comments: the public renderer passes the comment query variables
 * to the comment blocks, and understands WordPress's /comment-page-N/ URLs.
 */

async function render(ctx: Awaited<ReturnType<typeof setup>>, url: string) {
  const res = await ctx.app.request(`/wp-json/pressbase/v1/render?url=${encodeURIComponent(url)}`);
  return (await res.json()) as { status: number; html: string };
}

describe('comments on the public site', () => {
  it('renders comments in the theme and paginates them with /comment-page-N/', async () => {
    const ctx = await setup();
    await ctx.install();
    await ctx.request('POST', '/wp/v2/settings', {
      page_comments: true,
      comments_per_page: 1,
      default_comments_page: 'oldest',
      comment_order: 'asc',
    });
    const post = await ctx.request('POST', '/wp/v2/posts', {
      title: 'Paged talk',
      status: 'publish',
    });
    for (const content of ['First thought from the desk', 'Second thought from the studio']) {
      const res = await ctx.request('POST', '/wp/v2/comments', { post: post.body.id, content });
      expect(res.status).toBe(201);
    }
    const path = new URL(post.body.link).pathname;

    const first = await render(ctx, path);
    expect(first.status).toBe(200);
    expect(first.html).toContain('First thought from the desk');
    expect(first.html).not.toContain('Second thought from the studio');

    const second = await render(ctx, `${path}comment-page-2/`);
    expect(second.status).toBe(200);
    expect(second.html).toContain('Second thought from the studio');
    expect(second.html).not.toContain('First thought from the desk');

    // The plain form works too.
    expect((await render(ctx, `${path}?cpage=2`)).html).toContain('Second thought from the studio');
  });
});
