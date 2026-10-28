import { type Context, Hono } from 'hono';
import { z } from 'zod';
import {
  basePath,
  PERMALINK_HISTORY_OPTION,
  permalinkHistory,
  remember,
  sanitizePermalinkBase,
  sanitizePermalinkStructure,
} from '../content/permalinks';
import { type AppEnv, invalidParams, readJson, requireCapability, restError } from '../http';
import type { Kernel } from '../kernel';

/**
 * /pressbase/v1/permalinks: Settings → Permalinks
 * (wordpress/wp-admin/options-permalink.php).
 *
 * WordPress doesn't expose `permalink_structure`, `category_base` or
 * `tag_base` in /wp/v2/settings, and saving them is more than writing three
 * options: the values are normalised as options-permalink.php does, checked
 * together, and the replaced values are remembered so old addresses keep
 * redirecting. So they get their own endpoint and /wp/v2/settings stays
 * WordPress's. Changing an option purges every cached page (`site`) through
 * cache/invalidation.ts.
 */

const body = z.object({
  permalink_structure: z.string().max(200).optional(),
  category_base: z.string().max(200).optional(),
  tag_base: z.string().max(200).optional(),
});

async function read(kernel: Kernel) {
  return {
    permalink_structure: await kernel.options.get<string>('permalink_structure', ''),
    category_base: await kernel.options.get<string>('category_base', ''),
    tag_base: await kernel.options.get<string>('tag_base', ''),
  };
}

export function permalinksRoutes() {
  const app = new Hono<AppEnv>();
  app.use(requireCapability('manage_options'));

  app.get('/', async (c) => c.json(await read(c.get('kernel'))));

  const update = async (c: Context<AppEnv>) => {
    const kernel = c.get('kernel');
    const parsed = body.safeParse(await readJson(c));
    if (!parsed.success) return invalidParams(c, parsed.error);
    const input = parsed.data;

    const params: Record<string, string> = {};
    const next: Partial<Record<keyof typeof input, string>> = {};
    const check = (name: keyof typeof input, sanitize: typeof sanitizePermalinkBase) => {
      const value = input[name];
      if (value === undefined) return;
      const result = sanitize(value);
      if (result.ok) next[name] = result.value;
      else params[name] = result.error;
    };
    check('permalink_structure', sanitizePermalinkStructure);
    check('category_base', sanitizePermalinkBase);
    check('tag_base', sanitizePermalinkBase);

    const current = await read(kernel);
    const category = basePath(next.category_base ?? current.category_base, 'category');
    const tag = basePath(next.tag_base ?? current.tag_base, 'tag');
    if (!params.category_base && !params.tag_base && category === tag) {
      params[next.tag_base !== undefined ? 'tag_base' : 'category_base'] =
        'The category base and the tag base must be different.';
    }
    if (Object.keys(params).length > 0) {
      return restError(
        c,
        400,
        'rest_invalid_param',
        `Invalid parameter(s): ${Object.keys(params).join(', ')}`,
        { params },
      );
    }

    // Remember what is being replaced, for redirects from old addresses (frontend/query.ts).
    const history = await permalinkHistory(kernel);
    const updated = {
      structures:
        next.permalink_structure === undefined
          ? history.structures
          : remember(history.structures, current.permalink_structure, next.permalink_structure),
      categoryBases: remember(
        history.categoryBases,
        basePath(current.category_base, 'category'),
        category,
      ),
      tagBases: remember(history.tagBases, basePath(current.tag_base, 'tag'), tag),
    };
    if (JSON.stringify(updated) !== JSON.stringify(history)) {
      await kernel.options.set(PERMALINK_HISTORY_OPTION, updated, { autoload: true });
    }
    for (const [name, value] of Object.entries(next)) {
      if (value !== current[name as keyof typeof current]) await kernel.options.set(name, value);
    }
    return c.json(await read(kernel));
  };

  app.post('/', update);
  app.put('/', update);
  app.patch('/', update);
  return app;
}
