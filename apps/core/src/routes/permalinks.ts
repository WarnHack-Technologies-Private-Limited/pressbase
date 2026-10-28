import { type Context, Hono } from 'hono';
import {
  permalinkSettings,
  permalinkSettingsInput,
  savePermalinkSettings,
} from '../content/permalinks';
import { type AppEnv, invalidParams, readJson, requireCapability, restError } from '../http';

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
 * cache/invalidation.ts. The rules live in content/permalinks.ts
 * (savePermalinkSettings), shared with `pressbase rewrite structure`.
 */

export function permalinksRoutes() {
  const app = new Hono<AppEnv>();
  app.use(requireCapability('manage_options'));

  app.get('/', async (c) => c.json(await permalinkSettings(c.get('kernel'))));

  const update = async (c: Context<AppEnv>) => {
    const kernel = c.get('kernel');
    const parsed = permalinkSettingsInput.safeParse(await readJson(c));
    if (!parsed.success) return invalidParams(c, parsed.error);
    const result = await savePermalinkSettings(kernel, parsed.data);
    if (!result.ok) {
      return restError(
        c,
        400,
        'rest_invalid_param',
        `Invalid parameter(s): ${Object.keys(result.params).join(', ')}`,
        { params: result.params },
      );
    }
    return c.json(result.settings);
  };

  app.post('/', update);
  app.put('/', update);
  app.patch('/', update);
  return app;
}
