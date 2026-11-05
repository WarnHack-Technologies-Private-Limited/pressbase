import { schema } from '@pressbase/db';
import { and, count, eq, gte, lt } from 'drizzle-orm';
import type { AbilitiesRegistry } from '../abilities/registry';
import type { CurrentUser } from '../auth/users';
import type { Kernel } from '../kernel';
import { AiPromptBuilder } from './prompt-builder';
import { createAnthropicProvider } from './providers/anthropic';
import {
  createRecordedProvider,
  RECORDED_PROVIDER_ID,
  TEST_PROVIDER_ENV,
} from './providers/recorded';
import { keyHint, redactSecrets } from './security';
import {
  AiError,
  type AiMessage,
  type AiModelTier,
  type AiProvider,
  type AiResult,
  type AiStreamEvent,
  type AiTextRequest,
} from './types';

/**
 * The AI client, `kernel.ai`: WordPress 7's wp_supports_ai() and
 * wp_ai_client_prompt() (wordpress/wp-includes/ai-client.php) over a registry
 * of providers, with what a hosted site needs around them: keys kept on the
 * server, request timeouts, a daily request cap and a usage log without
 * content. See docs/architecture/ai.md and ADR 0019.
 *
 * AI requests only ever leave from core. The admin calls core's REST API,
 * which never returns a key.
 */

/** Settings → AI. Stored as options; the key separately, per provider. */
export interface AiSettings {
  enabled: boolean;
  provider: string;
  /** Empty: the provider's default model. */
  model: string;
  /**
   * The "model for quick edits" (`usingModelTier('fast')`): rewrites and
   * small changes. Empty: the main model.
   */
  fastModel: string;
  /** Requests per UTC day for the whole site. */
  dailyLimit: number;
}

export type AiKeySource = 'env' | 'database' | 'none';

/** Who and what a request is for: the usage log and the caps. */
export interface AiAttribution {
  plugin: string | null;
  ability: string | null;
  user: CurrentUser | null;
  /** This request's timeout; otherwise `wp_ai_client_default_request_timeout` (30 s). */
  timeoutMs?: number;
  /** Which of the site's models to use (default: the main one). */
  tier?: AiModelTier;
}

/** A usage log row, as `pressbase_ai_request` receives it: never the prompt or the output. */
export interface AiRequestLogEntry {
  userId: number | null;
  plugin: string | null;
  ability: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  status: 'ok' | 'error';
  errorCode: string | null;
}

declare module '@pressbase/hooks' {
  interface FilterRegistry {
    /** wp_supports_ai: turn AI off per site or per request. */
    wp_supports_ai: [enabled: boolean];
    /** Stop a prompt before it's sent; the builder is passed for inspection. */
    wp_ai_client_prevent_prompt: [prevent: boolean, builder: AiPromptBuilder];
    /** The default request timeout, in seconds (30). */
    wp_ai_client_default_request_timeout: [seconds: number];
    /** A plugin's own daily request limit; the site's limit applies too. */
    pressbase_ai_plugin_daily_request_limit: [limit: number, plugin: string];
  }
  interface ActionRegistry {
    /** After each provider request is logged. */
    pressbase_ai_request: [entry: AiRequestLogEntry];
  }
}

export const AI_OPTIONS = {
  enabled: 'pressbase_ai_enabled',
  provider: 'pressbase_ai_provider',
  model: 'pressbase_ai_model',
  fastModel: 'pressbase_ai_fast_model',
  dailyLimit: 'pressbase_ai_daily_request_limit',
} as const;

export const DEFAULT_DAILY_LIMIT = 100;
const DEFAULT_TIMEOUT_SECONDS = 30;
/** Usage log rows are kept this long. */
export const AI_LOG_RETENTION_DAYS = 90;

/** WordPress's option for a provider key: connectors_ai_{id}_api_key (wp-includes/connectors.php). */
export function apiKeyOption(providerId: string): string {
  return `connectors_ai_${providerId.replace(/-/g, '_')}_api_key`;
}

const timeoutError = () =>
  new AiError('prompt_timeout', 'The AI provider took too long to answer.', 504);

/** Midnight UTC today: the daily caps reset then. */
function startOfDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export class AiClient {
  #providers = new Map<string, AiProvider>();

  constructor(readonly kernel: Kernel) {
    this.registerProvider(createAnthropicProvider());
    // Recorded answers for e2e tests and screenshots: only when asked for (providers/recorded.ts).
    if (process.env[TEST_PROVIDER_ENV] === RECORDED_PROVIDER_ID) {
      this.registerProvider(createRecordedProvider());
    }
  }

  get abilities(): AbilitiesRegistry {
    return this.kernel.abilities;
  }

  /* ------------------------------------------------------------ providers */

  /** Adds a provider (or replaces one with the same id). Returns a function that removes it. */
  registerProvider(provider: AiProvider): () => void {
    if (!/^[a-z0-9-]+$/.test(provider.id)) {
      throw new Error(`Provider ids use lowercase letters, numbers and dashes: "${provider.id}".`);
    }
    const previous = this.#providers.get(provider.id);
    this.#providers.set(provider.id, provider);
    return () => {
      if (this.#providers.get(provider.id) !== provider) return;
      if (previous) this.#providers.set(provider.id, previous);
      else this.#providers.delete(provider.id);
    };
  }

  provider(id: string): AiProvider | undefined {
    return this.#providers.get(id);
  }

  providers(): AiProvider[] {
    return [...this.#providers.values()];
  }

  /* ------------------------------------------------------------- settings */

  async settings(): Promise<AiSettings> {
    const { options } = this.kernel;
    const limit = Number(await options.get(AI_OPTIONS.dailyLimit, DEFAULT_DAILY_LIMIT));
    return {
      enabled: Boolean(await options.get(AI_OPTIONS.enabled, false)),
      provider: String(await options.get(AI_OPTIONS.provider, 'anthropic')),
      model: String(await options.get(AI_OPTIONS.model, '')),
      fastModel: String(await options.get(AI_OPTIONS.fastModel, '')),
      dailyLimit: Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_DAILY_LIMIT,
    };
  }

  async saveSettings(input: Partial<AiSettings>): Promise<AiSettings> {
    const { options } = this.kernel;
    if (input.provider !== undefined && !this.#providers.has(input.provider)) {
      throw new AiError('rest_invalid_param', `Unknown AI provider "${input.provider}".`, 400);
    }
    if (input.enabled !== undefined) await options.set(AI_OPTIONS.enabled, input.enabled);
    if (input.provider !== undefined) await options.set(AI_OPTIONS.provider, input.provider);
    if (input.model !== undefined) await options.set(AI_OPTIONS.model, input.model.trim());
    if (input.fastModel !== undefined) {
      await options.set(AI_OPTIONS.fastModel, input.fastModel.trim());
    }
    if (input.dailyLimit !== undefined) await options.set(AI_OPTIONS.dailyLimit, input.dailyLimit);
    return this.settings();
  }

  /**
   * A provider's key and where it came from: the environment variable wins
   * over the saved option (_wp_connectors_get_api_key_source()).
   */
  async apiKey(providerId: string): Promise<{ key: string | null; source: AiKeySource }> {
    const provider = this.#providers.get(providerId);
    const fromEnv = provider ? process.env[provider.envVar] : undefined;
    if (fromEnv) return { key: fromEnv, source: 'env' };
    const saved = await this.kernel.options.get<string>(apiKeyOption(providerId), '');
    if (typeof saved === 'string' && saved) return { key: saved, source: 'database' };
    return { key: null, source: 'none' };
  }

  /** Saves a key (not autoloaded), or deletes it with null or ''. */
  async setApiKey(providerId: string, key: string | null): Promise<void> {
    if (!this.#providers.has(providerId)) {
      throw new AiError('rest_invalid_param', `Unknown AI provider "${providerId}".`, 400);
    }
    const value = key?.trim();
    if (value) await this.kernel.options.set(apiKeyOption(providerId), value, { autoload: false });
    else await this.kernel.options.delete(apiKeyOption(providerId));
  }

  /** What Settings → AI shows about a key: its source and last four characters, never the key. */
  async keyStatus(providerId: string): Promise<{ source: AiKeySource; last4: string | null }> {
    const { key, source } = await this.apiKey(providerId);
    return { source, last4: key ? keyHint(key) : null };
  }

  /**
   * wp_supports_ai(): off when PRESSBASE_AI_SUPPORT=0 (WordPress's
   * WP_AI_SUPPORT constant), when the site hasn't turned AI on, or when the
   * chosen provider has no key; then the `wp_supports_ai` filter decides.
   */
  async supportsAi(): Promise<boolean> {
    if (process.env.PRESSBASE_AI_SUPPORT === '0' || this.kernel.state !== 'ready') return false;
    const settings = await this.settings();
    const configured =
      settings.enabled &&
      this.#providers.has(settings.provider) &&
      (await this.apiKey(settings.provider)).key !== null;
    if (!configured) return false;
    return Boolean(await this.kernel.hooks.applyFilters('wp_supports_ai', true));
  }

  /* -------------------------------------------------------------- prompts */

  /** wp_ai_client_prompt(): a prompt builder. `plugin` attributes it (api.ai sets it). */
  prompt(input?: string | AiMessage[], plugin: string | null = null): AiPromptBuilder {
    return new AiPromptBuilder(this, input, plugin);
  }

  /** Requests sent today (UTC), by the whole site or one plugin. */
  async requestsToday(plugin?: string): Promise<number> {
    const since = gte(schema.aiRequests.createdAt, startOfDay());
    const [row] = await this.kernel.db
      .select({ n: count() })
      .from(schema.aiRequests)
      .where(plugin ? and(since, eq(schema.aiRequests.plugin, plugin)) : since);
    return Number(row?.n ?? 0);
  }

  async #checkCaps(plugin: string | null): Promise<void> {
    const { dailyLimit } = await this.settings();
    if ((await this.requestsToday()) >= dailyLimit) {
      throw new AiError(
        'ai_daily_limit_reached',
        'This site has used all of its AI requests for today. The limit resets at midnight UTC.',
        429,
      );
    }
    if (plugin) {
      const limit = await this.kernel.hooks.applyFilters(
        'pressbase_ai_plugin_daily_request_limit',
        dailyLimit,
        plugin,
      );
      if (limit < dailyLimit && (await this.requestsToday(plugin)) >= limit) {
        throw new AiError(
          'ai_daily_limit_reached',
          'This plugin has used all of its AI requests for today. The limit resets at midnight UTC.',
          429,
        );
      }
    }
  }

  /**
   * What every request needs before it's sent: the provider, its key, the
   * model for the tier, the timeout, the caps checked, and a log entry.
   */
  async #prepare(attribution: AiAttribution) {
    const settings = await this.settings();
    const provider = this.#providers.get(settings.provider);
    const { key } = await this.apiKey(settings.provider);
    if (!provider || !key) {
      throw new AiError(
        'prompt_prevented',
        'AI features are not supported in this environment.',
        503,
      );
    }
    await this.#checkCaps(attribution.plugin);
    const main = settings.model || provider.defaultModel;
    const model = attribution.tier === 'fast' ? settings.fastModel || main : main;
    let timeoutMs = attribution.timeoutMs;
    if (timeoutMs === undefined) {
      const filtered = await this.kernel.hooks.applyFilters(
        'wp_ai_client_default_request_timeout',
        DEFAULT_TIMEOUT_SECONDS,
      );
      const seconds =
        typeof filtered === 'number' && filtered > 0 ? filtered : DEFAULT_TIMEOUT_SECONDS;
      timeoutMs = Math.round(seconds * 1000);
    }
    const entry: AiRequestLogEntry = {
      userId: attribution.user?.id ?? null,
      plugin: attribution.plugin,
      ability: attribution.ability,
      provider: provider.id,
      model,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      status: 'ok',
      errorCode: null,
    };
    return { provider, key, model, timeoutMs, entry };
  }

  /** A failure as an AiError with keys redacted from its message, recorded on the log entry. */
  #failure(error: unknown, key: string, entry: AiRequestLogEntry): AiError {
    const failure =
      error instanceof AiError
        ? new AiError(error.code, redactSecrets(error.message, [key]), error.status)
        : new AiError(
            'prompt_builder_error',
            redactSecrets(error instanceof Error ? error.message : String(error), [key]),
            500,
          );
    entry.status = 'error';
    entry.errorCode = failure.code;
    return failure;
  }

  #record(entry: AiRequestLogEntry, result: AiResult, model: string): void {
    entry.inputTokens = result.tokenUsage.promptTokens;
    entry.outputTokens = result.tokenUsage.completionTokens;
    entry.model = result.model || model;
  }

  /**
   * Sends one request to the configured provider: checks the caps, applies
   * the timeout, redacts keys from errors and logs the request without content.
   * The prompt builder calls this; use the builder.
   */
  async send(request: Omit<AiTextRequest, 'model'>, attribution: AiAttribution): Promise<AiResult> {
    const { provider, key, model, timeoutMs, entry } = await this.#prepare(attribution);
    const started = Date.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(timeoutError());
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([
        provider.generateText(
          { ...request, model },
          { apiKey: key, signal: controller.signal, timeoutMs },
        ),
        timeout,
      ]);
      this.#record(entry, result, model);
      return result;
    } catch (error) {
      throw this.#failure(error, key, entry);
    } finally {
      clearTimeout(timer);
      entry.durationMs = Date.now() - started;
      await this.#log(entry);
    }
  }

  /**
   * send(), streamed: yields the provider's text events and ends with
   * `done`. The caps, the timeout (for the whole reply), key redaction and
   * the log are send()'s; the request is logged once, when the stream ends,
   * fails or is abandoned (`prompt_cancelled`). A provider without
   * streamText() answers in one piece. Use the builder's streamText().
   */
  async *stream(
    request: Omit<AiTextRequest, 'model'>,
    attribution: AiAttribution,
  ): AsyncGenerator<AiStreamEvent, void, undefined> {
    const { provider, key, model, timeoutMs, entry } = await this.#prepare(attribution);
    const started = Date.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(timeoutError());
      }, timeoutMs);
    });
    // Between two events nobody awaits the timeout; that isn't an unhandled rejection.
    timeout.catch(() => {});
    const full = { ...request, model };
    const context = { apiKey: key, signal: controller.signal, timeoutMs };
    const source: AsyncIterable<AiStreamEvent> = provider.streamText
      ? provider.streamText(full, context)
      : (async function* () {
          yield { type: 'done' as const, result: await provider.generateText(full, context) };
        })();
    const iterator = source[Symbol.asyncIterator]();
    let finished = false;
    try {
      for (;;) {
        const next = await Promise.race([iterator.next(), timeout]);
        if (next.done) break;
        const event = next.value;
        if (event.type === 'done') {
          this.#record(entry, event.result, model);
          finished = true;
          yield event;
          return;
        }
        if (event.text) yield event;
      }
      throw new AiError(
        'prompt_upstream_server_error',
        'The AI provider ended its reply early.',
        502,
      );
    } catch (error) {
      throw this.#failure(error, key, entry);
    } finally {
      clearTimeout(timer);
      if (!finished) {
        // Failed, or the caller stopped reading: stop the provider too.
        controller.abort();
        if (entry.status === 'ok') {
          entry.status = 'error';
          entry.errorCode = 'prompt_cancelled';
        }
        iterator.return?.()?.catch(() => {});
      }
      entry.durationMs = Date.now() - started;
      await this.#log(entry);
    }
  }

  async #log(entry: AiRequestLogEntry): Promise<void> {
    try {
      await this.kernel.db.insert(schema.aiRequests).values({
        userId: entry.userId,
        plugin: entry.plugin,
        ability: entry.ability,
        provider: entry.provider,
        model: entry.model.slice(0, 191),
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        durationMs: entry.durationMs,
        status: entry.status,
        errorCode: entry.errorCode,
      });
      await this.kernel.hooks.doAction('pressbase_ai_request', entry);
    } catch (error) {
      console.error('Could not log an AI request:', error instanceof Error ? error.message : error);
    }
  }

  /** Deletes usage log rows older than the retention period. */
  async pruneLog(days = AI_LOG_RETENTION_DAYS): Promise<void> {
    const before = new Date(Date.now() - days * 86_400_000);
    await this.kernel.db.delete(schema.aiRequests).where(lt(schema.aiRequests.createdAt, before));
  }

  /**
   * Settings → AI's "Test connection": a tiny prompt to the configured
   * provider. Counts against the daily cap and is logged like any request.
   */
  async testConnection(user: CurrentUser | null): Promise<{ provider: string; model: string }> {
    const result = await this.prompt('Reply with the single word OK.')
      .usingMaxTokens(1024)
      .forUser(user)
      .generateTextResult();
    return { provider: result.providerId, model: result.model };
  }
}
