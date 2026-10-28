import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { AiError } from '../ai/types';
import { type AppEnv, invalidParams, readJson, requireCapability, restError } from '../http';
import type { Kernel } from '../kernel';

/**
 * Settings → AI (`manage_options`): `/pressbase/v1/ai`.
 *
 * - `GET /settings`: the settings, each provider with its models and key
 *   status (`source`: env, database or none; `last4`), today's usage, and
 *   whether AI is available. Keys are never returned.
 * - `POST /settings`: `enabled`, `provider`, `model`, `daily_limit`, and
 *   `api_key` (saved for `provider`; `""` deletes it). A key set in the
 *   environment wins over a saved one.
 * - `POST /test`: "Test connection", a tiny prompt through the configured
 *   provider. It counts against the daily limit.
 *
 * WordPress keeps provider keys in Settings → Connectors
 * (wp-admin/options-connectors.php, wp-includes/connectors.php), under the
 * same option names Pressbase uses: connectors_ai_{provider}_api_key.
 */

const settingsBody = z
  .object({
    enabled: z.boolean().optional(),
    provider: z.string().min(1).max(64).optional(),
    model: z
      .string()
      .max(191)
      .regex(/^[A-Za-z0-9._:@/-]*$/, 'Use the model ID, like claude-opus-5-5.')
      .optional(),
    daily_limit: z.number().int().min(0).max(1_000_000).optional(),
    api_key: z
      .string()
      .max(500)
      .regex(/^[\x21-\x7e]*$/, 'An API key has no spaces or special characters.')
      .optional(),
  })
  .strict();

async function settingsResponse(kernel: Kernel) {
  const settings = await kernel.ai.settings();
  const providers = await Promise.all(
    kernel.ai.providers().map(async (p) => ({
      id: p.id,
      name: p.name,
      default_model: p.defaultModel,
      models: p.models,
      key_url: p.keyUrl ?? null,
      env_var: p.envVar,
      key: await kernel.ai.keyStatus(p.id),
    })),
  );
  return {
    enabled: settings.enabled,
    provider: settings.provider,
    model: settings.model,
    daily_limit: settings.dailyLimit,
    providers,
    requests_today: await kernel.ai.requestsToday(),
    supports_ai: await kernel.ai.supportsAi(),
  };
}

const aiError = (c: Context<AppEnv>, error: AiError) =>
  restError(c, error.status as 500, error.code, error.message);

export function aiRoutes() {
  const app = new Hono<AppEnv>({ strict: false });
  app.use(requireCapability('manage_options'));

  app.get('/settings', async (c) => c.json(await settingsResponse(c.get('kernel'))));

  app.post('/settings', async (c) => {
    const kernel = c.get('kernel');
    const parsed = settingsBody.safeParse(await readJson(c));
    if (!parsed.success) return invalidParams(c, parsed.error);
    const body = parsed.data;
    const provider = body.provider ?? (await kernel.ai.settings()).provider;
    if (!kernel.ai.provider(provider)) {
      return restError(c, 400, 'rest_invalid_param', 'Invalid parameter(s): provider', {
        params: { provider: 'Choose one of the listed providers.' },
      });
    }
    await kernel.ai.saveSettings({
      enabled: body.enabled,
      provider: body.provider,
      model: body.model,
      dailyLimit: body.daily_limit,
    });
    if (body.api_key !== undefined) await kernel.ai.setApiKey(provider, body.api_key || null);
    return c.json(await settingsResponse(kernel));
  });

  app.post('/test', async (c) => {
    const kernel = c.get('kernel');
    try {
      const result = await kernel.ai.testConnection(c.get('user'));
      return c.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof AiError) return aiError(c, error);
      throw error;
    }
  });

  return app;
}
