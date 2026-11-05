# AI client and Abilities API

Pressbase 0.7 ports two WordPress 7 APIs into core:

- **The AI client** (`wp_ai_client_prompt()`, `wp_supports_ai()`): a fluent prompt builder over a registry of providers. Pressbase ships the Anthropic provider (Claude). Plugins call it through `api.ai`.
- **The Abilities API** (`wp_register_ability()`): named units of work with JSON Schemas for their input and output and a required permission check. The REST API (`/wp-abilities/v1`), the CLI (`pressbase ability`) and AI models (as tools) can all discover and run them, with the same checks.

Pressbase 0.8 adds what Studio's AI features need: streaming, per-call timeouts, a model for quick edits and image input ([plan](../plans/visual-site-builder.md#changes-to-the-ai-client)).

AI is **off until an administrator turns it on** in **Settings → AI**. Pressbase SEO is the first user ([plan](../plans/first-party-plugins.md#ai)). Decisions are in [ADR 0019](../adr/0019-ai-client-and-abilities.md).

Code: `apps/core/src/ai/` (client, prompt builder, function resolver, providers), `apps/core/src/abilities/` (registry, JSON Schema, core abilities), `apps/core/src/routes/ai.ts` and `routes/abilities.ts`, `apps/core/src/plugins/ai.ts`, the admin screen in `apps/admin/src/components/settings/ai-settings.tsx`, the CLI in `packages/cli/src/commands/ability.ts`.

| WordPress (7.1) | Pressbase |
| --- | --- |
| `wp_supports_ai()`, `WP_AI_SUPPORT` | `kernel.ai.supportsAi()`, `PRESSBASE_AI_SUPPORT=0` |
| `wp_ai_client_prompt( $prompt )` | `kernel.ai.prompt(prompt)`, `api.ai.prompt(prompt)` |
| `WP_AI_Client_Prompt_Builder` (`ai-client/class-wp-ai-client-prompt-builder.php`) | `AiPromptBuilder` (`ai/prompt-builder.ts`) |
| `WP_AI_Client_Ability_Function_Resolver` | `AbilityFunctionResolver` (`ai/function-resolver.ts`) |
| AI provider plugins, the PHP AI Client's provider registry | `kernel.ai.registerProvider()`, `api.ai.registerProvider()` |
| Settings → Connectors, `connectors_ai_{id}_api_key`, `{ID}_API_KEY` | Settings → AI, the same option names, `PRESSBASE_{ID}_API_KEY` |
| `wp_register_ability()`, `wp_register_ability_category()` (`abilities-api.php`) | `kernel.abilities.register()`, `.registerCategory()`, `api.abilities.*` |
| `WP_Ability`, `WP_Abilities_Registry`, `WP_Ability_Categories_Registry` | `Ability`, `AbilitiesRegistry` (`abilities/registry.ts`) |
| `rest_validate_value_from_schema()`, `wp_prepare_json_schema_for_client()` | `validateJsonSchema()`, `prepareJsonSchemaForClient()` (`abilities/json-schema.ts`) |
| `/wp-abilities/v1` controllers | `routes/abilities.ts` |
| `core/get-site-info` (`abilities.php`) | the same, in `abilities/core-abilities.ts` |
| — | `core/check-page`: the [quality checks](quality-checks.md) for a page, as data |
| — | The [site-building abilities](site-abilities.md): `core/get-site-brief`, `core/get-design-system`, `core/list-patterns`, `core/get-page-structure`, `core/create-page`, `core/update-page-sections`, `core/update-global-styles`, `core/update-template-part`; writes go into the user's changeset, none publishes |

## The AI client

```ts
const titles = await kernel.ai
  .prompt(`Suggest three titles for this post:\n\n${excerpt}`)
  .usingSystemInstruction('You write short, specific post titles.')
  .usingMaxTokens(1000)
  .asJsonResponse({
    type: 'object',
    properties: { titles: { type: 'array', items: { type: 'string' } } },
    required: ['titles'],
  })
  .forUser(user)
  .forAbility('pressbase-seo/suggest-meta')
  .generateJson<{ titles: string[] }>();
```

| Method | WordPress | Notes |
| --- | --- | --- |
| `prompt(input?)` | `wp_ai_client_prompt()` | a string, or a list of messages |
| `withText(text)`, `withHistory(...messages)` | `with_text()`, `with_history()` | |
| `withImage(bytes \| base64, mimeType)` | `with_file()` | JPEG, PNG, GIF or WebP up to 5 MB, for a model that can see images (screenshot to section); never logged |
| `usingSystemInstruction(text)` | `using_system_instruction()` | |
| `usingMaxTokens(n)` | `using_max_tokens()` | default 16,000 |
| `usingTemperature(t)` | `using_temperature()` | ignored by Claude's current models, which reject sampling parameters |
| `usingTimeout(ms)` | `using_request_options()` | this prompt's timeout per request; default 30 s, from `wp_ai_client_default_request_timeout`. Generation stages use 60–120 s |
| `usingRequestTimeout(seconds)` | `using_request_options()` | the same, in seconds |
| `usingModelTier('default' \| 'fast')` | — | `fast` uses Settings → AI's **model for quick edits** (rewrites, small changes), or the main model when none is set |
| `asJsonResponse(schema)`, `asOutputSchema(schema)` | `as_json_response()`, `as_output_schema()` | structured output |
| `usingAbilities(...names)` | `using_abilities()` | the model may call these abilities ([below](#abilities-as-tools)) |
| `usingMaxFunctionRounds(n)` | — | how many rounds of ability calls are answered (default 5) |
| `forUser(user)`, `forAbility(name)` | — | who it's for (log, ability permissions) and which ability or pipeline stage (log): `site-builder/brief`, `site-builder/page` |
| `isSupportedForTextGeneration()` | `is_supported_for_text_generation()` | |
| `generateText()` | `generate_text()` | the reply's text, **HTML stripped** |
| `generateTextResult()` | `generate_text_result()` | `{ id, message, finishReason, tokenUsage: { promptTokens, completionTokens, totalTokens }, providerId, model }` |
| `generateJson<T>()` | — | the reply parsed and validated against the schema, HTML stripped from every string |
| `streamText()` | — | the reply as it's written ([below](#streaming)) |

### Streaming

```ts
const stream = kernel.ai
  .prompt(question)
  .usingModelTier('fast')
  .forUser(user)
  .forAbility('site-builder/edit')
  .streamText();
for await (const text of stream) send(text);   // plain-text pieces
const { tokenUsage } = await stream.result;    // the final AiResult
```

`streamText()` returns an async iterable of plain-text pieces and a `result` promise. It goes through the same checks as `generateText()`: AI on, the prevent filter, the daily caps, the timeout, key redaction and one log row per provider request, written when the stream ends. HTML is stripped as the text arrives (a tag or entity split across pieces is held back until it's complete). The timeout covers the whole reply, so long replies need `usingTimeout()`. With `usingAbilities()`, each round's text is streamed and ability calls are answered between rounds. Breaking out of the loop aborts the request; it's logged with the code `prompt_cancelled`, and `result` rejects with it.

The model is **a setting**, not something callers choose: the main model, or with `usingModelTier('fast')` the model for quick edits. Generation (building a site or a page) uses the main model; quick edits (rewrite, shorten, change tone) use the fast tier.

Generating methods throw an `AiError` with WordPress's codes and an HTTP status: `prompt_prevented` (503: AI off, or a `wp_ai_client_prevent_prompt` filter), `prompt_timeout` (504), `prompt_network_error` (503), `prompt_client_error` (4xx, e.g. a refused key), `prompt_upstream_server_error` (502), `prompt_refused` (the model declined), `prompt_invalid_output` (502: JSON that doesn't match the schema), `prompt_invalid_argument` (400), and Pressbase's `ai_daily_limit_reached` (429) and `prompt_cancelled` (a stream the caller stopped reading).

`supportsAi()` is false when `PRESSBASE_AI_SUPPORT=0`, when Settings → AI is off, or when the chosen provider has no key; then the `wp_supports_ai` filter decides.

### Hooks

| Hook | Type | Arguments |
| --- | --- | --- |
| `wp_supports_ai` | filter | `enabled` |
| `wp_ai_client_prevent_prompt` | filter | `prevent`, the builder (`builder.describe()` gives plugin, ability, user and abilities) |
| `wp_ai_client_default_request_timeout` | filter | `seconds` |
| `pressbase_ai_plugin_daily_request_limit` | filter | `limit` (the site's), `plugin` slug: a lower limit for one plugin |
| `pressbase_ai_request` | action | the log entry (no content), after each provider request |

### Caps, timeouts and the usage log

- **Daily cap:** `pressbase_ai_daily_request_limit` (default 100) requests per UTC day for the whole site. A plugin can be held to less with `pressbase_ai_plugin_daily_request_limit`. Each provider request counts, including each round of ability calls and **Test connection**; failed requests count too. The count is read before sending, so a burst of simultaneous requests can pass the limit by a few.
- **Timeout:** every request is aborted after its timeout (30 s by default, `usingTimeout()` per prompt) and fails with `prompt_timeout`; a streamed reply must finish within it. The SDK's own retries are off, so one call is one request.
- **Log:** each request adds a row to the `ai_requests` table: when, the user, the plugin, the ability, the provider, the model, input and output tokens, the duration, and `ok` or the error code (a stream the caller stopped reading is `prompt_cancelled`). The model is the one that answered, so quick edits on the fast tier show up separately. **Never the prompt, the output or the key.** Rows older than 90 days are deleted with the daily job cleanup.

### Keys and Settings → AI

**Settings → AI** (`manage_options`) turns AI on, chooses the provider, the model and the model for quick edits, saves the provider's API key, sets the daily limit and tests the connection. Its REST API is `/pressbase/v1/ai`:

- `GET /settings`: `enabled`, `provider`, `model` (empty: the provider's default), `fast_model` (the model for quick edits, option `pressbase_ai_fast_model`; empty: the main model), `daily_limit`, `requests_today`, `supports_ai`, and `providers` with each one's `models`, `default_model`, `env_var` and `key: { source: 'env' | 'database' | 'none', last4 }`.
- `POST /settings`: any of `enabled`, `provider`, `model`, `fast_model`, `daily_limit`, `api_key` (saved for `provider`; `""` deletes it).
- `POST /test`: a tiny prompt through the configured provider: `{ ok, provider, model }` or the error.

Keys are stored in the option WordPress uses, `connectors_ai_{provider}_api_key` (not autoloaded, never in `/wp/v2/settings`), and are **never returned** after saving: the screen shows "Saved, ends in …abcd". An environment variable wins over a saved key: `PRESSBASE_ANTHROPIC_API_KEY`. Keys are redacted (`[redacted]`) from every error message, along with anything shaped like a provider key.

### Providers

A provider is a small module implementing `AiProvider` (`ai/types.ts`):

```ts
interface AiProvider {
  id: string;            // 'anthropic': also names the key option and the env var
  name: string;          // shown in Settings → AI
  envVar: string;        // 'PRESSBASE_ANTHROPIC_API_KEY'
  defaultModel: string;  // used when the site hasn't picked one
  models: { id: string; name: string }[];
  keyUrl?: string;
  generateText(request: AiTextRequest, context: AiProviderContext): Promise<AiResult>;
  streamText?(request: AiTextRequest, context: AiProviderContext): AsyncIterable<AiStreamEvent>;
}
```

`generateText` receives the model, the system instruction, the messages (`{ role: 'user' | 'model', parts }`, with text, `function_call` and `function_response` parts), `maxTokens`, an optional `temperature`, an optional `outputSchema` and `functionDeclarations` (each with an object JSON Schema). User messages may hold `image` parts (`{ type: 'image', mimeType, data }`, base64). The context has the `apiKey`, an `AbortSignal` and `timeoutMs`. It returns one `AiResult` and throws an `AiError` on failure (core redacts the key from its message). A provider may put its raw reply on `message.providerContent` to get it back unchanged in the next turn of a tool loop.

`streamText` is optional: it yields `{ type: 'text', text }` events as the reply is written and ends with one `{ type: 'done', result }` carrying the same `AiResult` `generateText` would return. Without it, core calls `generateText` and the builder's `streamText()` gives the reply in one piece. Core aborts the signal on timeout and when the caller stops reading.

Register one in core (`kernel.ai.registerProvider()`) or from a plugin (`api.ai.registerProvider()`, removed on deactivation). OpenAI, Google and others are each one such module.

**Anthropic** (`ai/providers/anthropic.ts`) uses the official `@anthropic-ai/sdk` and the Messages API. The default model is `claude-opus-5-5`; Settings → AI also offers Claude Sonnet 5.5, Claude Haiku 5.5 and Claude Fable 5.1, or any model ID. Thinking is left at the model's default; structured output uses `output_config.format`; streaming uses the SDK's `messages.stream()` helper; images are base64 `image` blocks; abilities become tools with `tool_choice: auto`; Claude's own content (thinking blocks included) is sent back unchanged in tool loops. On the models that support it, refusals fall back server-side (`fallbacks: "default"`).

### Testing without a provider

Tests never reach a real provider. Core's API tests register a fake one (`kernel.ai.registerProvider()`) that answers from the request's schema (`site-builder.test.ts`, `site-builder-steps.test.ts`).

For end-to-end tests, screenshots and demos there's the **recorded provider** (`ai/providers/recorded.ts`): answers recorded for one site, a neighbourhood bakery, fitted to each request's schema. It never touches the network and is **off unless core starts with `PRESSBASE_AI_TEST_PROVIDER=recorded`**; then Settings → AI lists *Recorded answers (for testing)*, which still needs AI turned on and a key saved (any text). It tells the site builder's requests apart by their schema: clarifying questions, the brief (no facts of its own, so the honest-content rules apply), design directions (the next three after those shown), the sitemap (with the sections the site's patterns have), and pages and parts (plain copy, no numbers or names). Anything else gets the first value its schema allows. Studio's AI panel gets a few conversations played through the real tool loop (`recorded-assistant.ts`: rounder buttons, an FAQ, tidying a page, and a request it can't do; see [AI edits](ai-edits.md#tests)). `PRESSBASE_AI_TEST_DELAY_MS` adds a pause before each answer, to watch progress. The e2e suite sets the first ([testing](../development/testing.md#end-to-end-tests)).

## The Abilities API

```ts
kernel.abilities.register('my-plugin/count-drafts', {
  label: 'Count drafts',
  description: 'Counts the current user’s drafts.',
  category: 'site',
  inputSchema: { type: 'object', properties: { type: { type: 'string', default: 'post' } } },
  outputSchema: { type: 'integer', minimum: 0 },
  permissionCallback: (input, context) => context.can('edit_posts'),
  executeCallback: async (input, context) => countDrafts(context.user, input.type),
  meta: { annotations: { readonly: true }, showInRest: true },
});
```

- **Names** are `namespace/name` in lowercase letters, numbers and dashes. **Categories** must be registered first (`site` and `user` come with core).
- **`permissionCallback` is required.** It receives the input and an `AbilityContext`: `user`, `can(capability, objectId?)` (current_user_can()), and `via` (`rest`, `cli`, `ai`, `server`). Return `true`, `false` or an `AbilityError`.
- **`execute(input, context)`** runs WordPress's sequence: the `wp_ability_invoked` action, `wp_pre_execute_ability` (anything but the default short-circuits), the schema's `default` for missing input, input validation (`ability_invalid_input`), the permission check (`ability_invalid_permissions`), `wp_before_execute_ability`, the callback (exceptions become `ability_callback_exception`; throw an `AbilityError` for your own code), `wp_ability_execute_result`, output validation (`ability_invalid_output`) and `wp_after_execute_ability`. Failures are thrown as `AbilityError { code, message, status }`.
- **`meta.annotations`:** `readonly`, `destructive`, `idempotent`. **`meta.showInRest`** (or `public`) lists the ability in REST.
- Filters: `wp_register_ability_args` and `wp_register_ability_category_args` (synchronous), `wp_ability_normalize_input`, `wp_ability_validate_input`, `wp_ability_permission_result`, `wp_pre_execute_ability`, `wp_ability_execute_result`, `wp_ability_validate_output`.
- **JSON Schema** support is WordPress's: `type` (or a list), `enum`, `properties`, `required` (a list, or `required: true` on a property), `additionalProperties`, `patternProperties`, `min/maxProperties`, `items`, `min/maxItems`, `uniqueItems`, `min/maxLength`, `pattern`, `format` (email, uri, uuid, date-time, hex-color), `minimum`/`maximum` (and exclusive), `multipleOf`, `anyOf`, `oneOf`.

### REST: `/wp-abilities/v1`

| Route | Who | WordPress |
| --- | --- | --- |
| `GET /categories`, `GET /categories/{slug}` | logged in (`read`) | categories controller |
| `GET /abilities?category=&namespace=&page=&per_page=` | logged in | list controller; only `showInRest` abilities; `X-WP-Total`, `X-WP-TotalPages` |
| `GET /abilities/{namespace}/{name}` | logged in | `name`, `label`, `description`, `category`, `input_schema`, `output_schema`, `meta` (with `show_in_rest`), `_links` |
| `/abilities/{namespace}/{name}/run` | the ability's permission callback | run controller |

`run` takes **GET** for read-only abilities (input in `?input=`, as JSON or `input[key]=value`), **DELETE** for destructive idempotent ones, and **POST** for the rest (`{ "input": … }`); another method is `405 rest_ability_invalid_method`. Input is validated before the permission check: a schema error is `400 ability_invalid_input`; a refusal is `401`/`403 rest_ability_cannot_execute`; a hidden or unknown ability is `404 rest_ability_not_found`. The answer is the ability's output as JSON.

### Abilities as tools

`prompt(...).usingAbilities('core/get-site-info', 'my-plugin/count-drafts')` declares each ability to the model as a function named `wpab__{namespace}__{name}` with its input schema (object schemas as they are; others wrapped as `{ input: … }`). When the model calls one, the **ability function resolver** runs it with `execute()` as the prompt's `forUser()` user, with the same validation and permission checks, and sends the result (or `{ error, code }`) back; then the model answers. Only the listed abilities can run (`ability_not_allowed` otherwise). Without `forUser()`, abilities that check a capability refuse. WordPress leaves this loop to the caller; Pressbase runs it inside `generateText*()`, up to `usingMaxFunctionRounds()` rounds, each one a logged request.

## Plugins

```js
export default function register(api) {
  api.abilities.registerCategory('my-plugin', { label: 'My plugin', description: 'What my plugin can do.' });
  api.abilities.register('suggest-title', {           // → my-plugin/suggest-title
    label: 'Suggest a title',
    description: 'Suggests a title for a draft.',
    category: 'my-plugin',
    inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 5000 } }, required: ['text'] },
    outputSchema: { type: 'string' },
    permissionCallback: (input, context) => context.can('edit_posts'),
    executeCallback: (input, context) =>
      api.ai.prompt(`Suggest one title for:\n\n${input.text}`).forUser(context.user).generateText(),
  });
}
```

- `api.ai.supportsAi()`, `api.ai.prompt(input)`: the AI client, with requests logged under the plugin's slug and counted against its daily limit. Generating throws `prompt_prevented` while AI is off. `api.ai.registerProvider(provider)` adds a provider while the plugin is active.
- `api.abilities.register(name, args)`: `name` gets the plugin's slug (`my-plugin/…`); `api.abilities.registerCategory(slug, args)`: the slug is the plugin's or starts with it. Both are removed on deactivation. Also `get(name)`, `all(query)`, `execute(name, input, user)`, `context(user)` and `error(code, message, status?)` to make an `AbilityError`.

## CLI

`pressbase ability list [--category] [--namespace]`, `pressbase ability get <name>`, `pressbase ability run <name> --input='{…}'` (as `--user`, or with full trust without it), `pressbase ability category list`, and `pressbase ai test`. See [the CLI](../development/cli.md#ability-and-ai).

## Security

- AI requests only leave from core. The admin calls `/pressbase/v1/ai`; keys never reach the browser.
- Prompts, outputs and keys are never logged. Keys are redacted from errors.
- Text and JSON output have HTML stripped before they're returned.
- Every ability needs a permission callback, checked over REST, in the CLI (for `--user`) and when a model calls it, for the user the prompt runs for.
- Text an ability returns from the site (page copy, the brief, pattern samples) is data, never instructions: pass it to a model in a separate, labelled part of the prompt. The site-building abilities enforce permissions and write only into a changeset whatever a model asks ([site abilities](site-abilities.md#content-is-data-not-instructions)).
- Plugins are trusted code ([Plugins](plugins.md#security-model-and-limits)): a plugin can read the options table, so it can read a saved key. Prefer the environment variable on sites with plugins you don't fully trust.
