import { Hono } from 'hono';
import { z } from 'zod';
import { AbilityError } from '../abilities/registry';
import { type AppEnv, invalidParams, readJson, requireCapability, restError } from '../http';
import { CHECK_RULES, type CheckRule } from '../quality/check-page';

/**
 * `POST /pressbase/v1/check-page`: the quality checks for Studio's "Before
 * you publish" checklist and the site-building pipeline. It runs the
 * `core/check-page` ability as the request's user (so the same permission
 * check applies), with a POST body: `/wp-abilities/v1` runs read-only
 * abilities with GET, and a page's markup doesn't belong in a URL.
 *
 * Body: `content` (block markup) or `id` (a post's saved content), and
 * optionally `global_styles` (user global styles to check against),
 * `title_is_h1` and `rules`. Answer: `{ findings, errors, warnings, passed }`.
 * See docs/architecture/quality-checks.md.
 */

const body = z
  .object({
    content: z.string().max(2_000_000).optional(),
    id: z.number().int().positive().optional(),
    global_styles: z.record(z.string(), z.unknown()).optional(),
    title_is_h1: z.boolean().optional(),
    rules: z
      .array(z.enum(CHECK_RULES as [CheckRule, ...CheckRule[]]))
      .max(CHECK_RULES.length)
      .optional(),
  })
  .strict()
  .refine((value) => value.content !== undefined || value.id !== undefined, {
    message: 'Give the content or the ID of a page.',
    path: ['content'],
  });

export function qualityRoutes() {
  const app = new Hono<AppEnv>({ strict: false });
  app.use(requireCapability('edit_posts'));

  app.post('/', async (c) => {
    const kernel = c.get('kernel');
    const parsed = body.safeParse(await readJson(c));
    if (!parsed.success) return invalidParams(c, parsed.error);
    // A missing post is a 404, as the posts endpoints answer, not a refusal.
    if (parsed.data.id !== undefined && !(await kernel.posts.get(parsed.data.id))) {
      return restError(c, 404, 'rest_post_invalid_id', 'Invalid post ID.');
    }
    const ability = kernel.abilities.get('core/check-page');
    if (!ability) return restError(c, 404, 'rest_no_route', 'No route was found.');
    const user = c.get('user');
    try {
      return c.json(
        (await ability.execute(parsed.data, kernel.abilities.context(user, 'rest'))) as never,
      );
    } catch (error) {
      if (!(error instanceof AbilityError)) throw error;
      const status =
        error.code === 'ability_invalid_permissions' ? (user ? 403 : 401) : (error.status ?? 400);
      return restError(c, status as 400, error.code, error.message);
    }
  });

  return app;
}
