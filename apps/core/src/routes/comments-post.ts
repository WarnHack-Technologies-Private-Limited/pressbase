import { escAttr, escHtml, escUrl } from '@pressbase/blocks';
import { Hono } from 'hono';
import { commentLink } from '../comments/links';
import { CommentError } from '../comments/service';
import { permalink, permalinkContext } from '../content/permalinks';
import { type AppEnv, clientIp } from '../http';
import type { Kernel } from '../kernel';

/**
 * POST /wp-comments-post — wordpress/wp-comments-post.php: the public
 * comment form (`core/post-comments-form`) posts here as
 * application/x-www-form-urlencoded, outside /wp-json.
 *
 * On success the visitor is redirected back to the comment (or to a safe
 * `redirect_to`), with `unapproved` and `moderation-hash` added when the
 * comment is held, so they can still see it. On failure an error page
 * explains what to do, with WordPress's status codes (wp_die()).
 *
 * The form is cross-origin by nature (the public site posts it), so the
 * X-Pressbase-Request header can't be required. Session cookies are
 * SameSite=Lax and never sent with a cross-site POST, so a forged form can
 * only ever post as an anonymous visitor. Content from this endpoint is always
 * filtered with kses, even for administrators (WordPress lifts that with a
 * nonce; Pressbase doesn't need raw HTML in front-end comments).
 */

function errorPage(message: string, back: string | undefined, status: number): Response {
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Comment Submission Failure</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;background:#f6f6f3;color:#1b1b19;margin:0;padding:48px 16px}
main{max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e2dc;border-radius:12px;padding:32px}
h1{font-size:20px;margin:0 0 12px}a{color:#3343c0}
@media (prefers-color-scheme:dark){body{background:#121211;color:#ededea}main{background:#1a1a19;border-color:#2c2c2a}a{color:#a3adff}}
</style>
</head>
<body>
<main>
<h1>Your comment wasn’t posted</h1>
<p>${escHtml(message)}</p>
${back ? `<p><a href="${escAttr(escUrl(back))}">&laquo; Back to the post</a></p>` : ''}
</main>
</body>
</html>`;
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}

/** wp_safe_redirect(): only to the site's own hosts. */
async function isSafeRedirect(kernel: Kernel, target: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  for (const option of ['home', 'siteurl']) {
    const base = await kernel.options.get<string>(option, '');
    try {
      if (base && new URL(base).host === url.host) return true;
    } catch {
      // An invalid option can't vouch for anything.
    }
  }
  return false;
}

/** add_query_arg() before the #fragment. */
function withQuery(url: string, params: Record<string, string>): string {
  const [base = '', hash] = url.split('#');
  const query = new URLSearchParams(params).toString();
  return `${base}${base.includes('?') ? '&' : '?'}${query}${hash !== undefined ? `#${hash}` : ''}`;
}

export function commentsPostRoutes() {
  const app = new Hono<AppEnv>({ strict: false });

  app.post('/', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody();
    } catch {
      return errorPage('The form could not be read. Go back and try again.', undefined, 400);
    }
    const field = (name: string) => (typeof form[name] === 'string' ? (form[name] as string) : '');

    const postId = Number(field('comment_post_ID'));
    const post =
      Number.isInteger(postId) && postId > 0 ? await kernel.posts.get(postId) : undefined;
    const links = await permalinkContext(kernel);
    const back = post ? await permalink(kernel, post, links) : undefined;

    try {
      const comment = await kernel.comments.handleSubmission(
        {
          postId,
          parentId: Number(field('comment_parent')) || null,
          content: field('comment'),
          author: field('author'),
          authorEmail: field('email'),
          authorUrl: field('url'),
          authorIp: clientIp(c) || '127.0.0.1',
          agent: c.req.header('user-agent') ?? '',
        },
        user,
      );
      await kernel.hooks.doAction('set_comment_cookies', comment, user);
      const options = await kernel.comments.options();
      const target = field('redirect_to');
      let location =
        target && (await isSafeRedirect(kernel, target))
          ? `${target.split('#')[0]}#comment-${comment.id}`
          : post
            ? await commentLink(kernel, comment, post, options, links)
            : '/';
      // wp-comments-post.php: show a held comment to its author for a while.
      if (comment.approved === '0' && comment.authorEmail) {
        location = withQuery(location, {
          unapproved: String(comment.id),
          'moderation-hash': await kernel.comments.moderationHash(comment),
        });
      }
      location = String(
        await kernel.hooks.applyFilters('comment_post_redirect', location, comment),
      );
      return c.redirect(location, 302);
    } catch (error) {
      if (error instanceof CommentError) return errorPage(error.message, back, error.status);
      throw error;
    }
  });

  return app;
}
