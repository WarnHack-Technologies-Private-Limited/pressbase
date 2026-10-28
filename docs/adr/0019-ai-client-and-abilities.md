# 0019: The AI client and the Abilities API in core

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

Pressbase SEO's v1 suggests titles, descriptions, social text and alt text with AI ([plan](../plans/first-party-plugins.md#ai), gap 10). WordPress 7.0 put the pieces for this in core: `wp_ai_client_prompt()`, a fluent prompt builder over a provider registry that plugins fill, and the Abilities API (`wp_register_ability()`, `/wp-abilities/v1`, abilities as AI function calls). Pressbase follows WordPress's names so plugins and people move across easily.

A site that turns AI on hands a third party its content and pays per request, so the client must keep keys out of the browser and out of logs, bound the cost, and stay off until an administrator turns it on.

## Decision

1. **Port both APIs into core**, with WordPress's names in TypeScript form: `kernel.ai.supportsAi()` / `prompt()` (`wp_supports_ai`, `wp_ai_client_prevent_prompt`, `wp_ai_client_default_request_timeout`), `kernel.abilities` (`wp_register_ability()` and its filters and actions), the ability function resolver (`wpab__` names), and `/wp-abilities/v1` with WordPress's shapes, methods and errors. Plugins get `api.ai` (attributed to the plugin) and `api.abilities` (namespaced by the slug, removed on deactivation). Where PHP returns a `WP_Error`, TypeScript throws an `AiError` or `AbilityError` with the same code and an HTTP status. Ability callbacks receive an `AbilityContext` (user, `can()`, where it runs from) because Pressbase has no global current user.
2. **Anthropic first**, through the official `@anthropic-ai/sdk`. A provider is a small module implementing `AiProvider`; core or a plugin registers it. The model is a site setting with the provider's default (`claude-opus-5-5`); callers never choose it.
3. **Keys stay on the server.** They're saved in WordPress's option names (`connectors_ai_{id}_api_key`), not autoloaded and outside `/wp/v2/settings`, and are never returned: REST gives only the source (`env`, `database`, `none`) and the last four characters. `PRESSBASE_{ID}_API_KEY` in the environment wins. Errors are redacted of the key and anything shaped like a provider key. They aren't encrypted at rest: the encryption key would live on the same server as the database, so it would only move the secret; the environment variable is the stronger option and is documented as such.
4. **A table for the usage log, and the caps count it.** `ai_requests` (migration 0002) holds one row per provider request: time, user, plugin, ability, provider, model, input and output tokens, duration, status and error code. Never content. The daily cap (`pressbase_ai_daily_request_limit`, default 100 per UTC day) and per-plugin caps (`pressbase_ai_plugin_daily_request_limit`) are `count(*)` over today's rows, by an index on `created_at` (and `plugin, created_at`). Rows older than 90 days are pruned with the daily job cleanup.
5. **Timeouts in core.** Each request is raced against its timeout (30 s by default) and aborted; the SDK's retries are off so one call is one counted request.
6. **Output is plain text.** `generateText()` and `generateJson()` strip HTML; JSON is validated against the caller's schema.
7. **Tool loops run in the builder.** With `usingAbilities()`, the builder answers the model's ability calls through the resolver, as the prompt's user, up to five rounds. WordPress leaves the loop to callers; one place that applies permissions and caps is safer.

## Consequences

- Plugins (Pressbase SEO first) get AI with one call and no key handling, and register abilities usable from REST, the CLI and, later, MCP, with one permission check.
- Each request costs one insert and one or two indexed counts; fine at the volumes a daily cap allows.
- The cap is checked before sending, so simultaneous requests can pass it by a few.
- A plugin can still read the options table, so it can read a saved key; plugins are trusted code ([plugins](../architecture/plugins.md#security-model-and-limits)). The environment variable avoids that.
- The ability JSON Schema validator is WordPress's subset, not full draft-04 (`$ref`, `allOf`, `not` are passed to clients but not validated), like WordPress.

## Alternatives considered

- **Options for the log and counters** (`pressbase_ai_usage` with a per-day counter): no history, read-modify-write races, and an autoloaded option that grows. A table is simple and queryable.
- **Logging to stdout only:** no daily caps without a store, and logs are where content tends to leak.
- **Calling providers from the admin (Next.js) server:** a second place holding keys and a second set of checks; core already owns permissions.
- **A provider-neutral HTTP shim instead of the SDK:** the official SDK gets typed errors, structured outputs and new API features without us tracking the wire format.
- **Leaving the tool loop to callers, as WordPress does:** each plugin would reimplement it, and forget the caps or the user.
