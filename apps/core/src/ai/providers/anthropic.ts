import Anthropic from '@anthropic-ai/sdk';
import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema';
import type { JsonSchema } from '../../abilities/json-schema';
import {
  AiError,
  type AiFinishReason,
  type AiMessage,
  type AiMessagePart,
  type AiProvider,
  type AiProviderContext,
  type AiResult,
  type AiTextRequest,
} from '../types';

/**
 * The Anthropic provider: Claude through the official `@anthropic-ai/sdk`,
 * on the Messages API (POST /v1/messages).
 *
 * - The model is the site's setting (Settings → AI); `claude-opus-5-5` by default.
 * - Thinking is left to the model's default (adaptive on current models).
 *   `temperature` isn't sent: current Claude models reject sampling parameters.
 * - Structured output uses `output_config.format` (json_schema); the reply is
 *   parsed and validated by core.
 * - Abilities become tools with `tool_choice: auto` (forced tool choice is
 *   refused by current models). Thinking blocks are kept on the model's
 *   message and sent back unchanged in the next turn of a tool loop.
 * - On the models that support it, refusals fall back server-side
 *   (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`).
 * - The SDK's own retries are off: core owns timeouts and counts every request.
 */

/** Models that accept `fallbacks: "default"` on the Claude API. */
const FALLBACK_MODELS = new Set([
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
]);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** The subset of the SDK client this provider uses (so tests can pass a fake). */
export interface AnthropicClientLike {
  beta: {
    messages: {
      create(
        params: Anthropic.Beta.MessageCreateParamsNonStreaming,
        options?: { signal?: AbortSignal; timeout?: number },
      ): Promise<Anthropic.Beta.BetaMessage>;
    };
  };
}

export type AnthropicClientFactory = (options: {
  apiKey: string;
  timeout: number;
}) => AnthropicClientLike;

const defaultFactory: AnthropicClientFactory = ({ apiKey, timeout }) =>
  new Anthropic({ apiKey, timeout, maxRetries: 0 });

/** A tool's input schema: an object schema (core wraps others), without a top-level default. */
function toolSchema(parameters: JsonSchema | undefined): Anthropic.Beta.BetaTool.InputSchema {
  if (!parameters || Object.keys(parameters).length === 0)
    return { type: 'object', properties: {} };
  const { default: _default, ...rest } = parameters;
  return { ...rest, type: 'object' } as Anthropic.Beta.BetaTool.InputSchema;
}

function toContent(message: AiMessage): Anthropic.Beta.BetaContentBlockParam[] {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const part of message.parts) {
    if (part.type === 'text') content.push({ type: 'text', text: part.text });
    else if (part.type === 'function_call') {
      content.push({ type: 'tool_use', id: part.id, name: part.name, input: part.args });
    } else {
      const response = part.response as { error?: unknown } | null;
      content.push({
        type: 'tool_result',
        tool_use_id: part.id,
        content: JSON.stringify(part.response ?? null),
        ...(response && typeof response === 'object' && 'error' in response
          ? { is_error: true }
          : {}),
      });
    }
  }
  return content;
}

function finishReason(stop: Anthropic.Beta.BetaStopReason | null): AiFinishReason {
  switch (stop) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/** Maps SDK errors to the AI client's codes (WP_AI_Client_Prompt_Builder::exception_to_wp_error()). */
function toAiError(error: unknown): AiError {
  if (error instanceof AiError) return error;
  if (
    error instanceof Anthropic.APIConnectionTimeoutError ||
    error instanceof Anthropic.APIUserAbortError
  ) {
    return new AiError('prompt_timeout', 'The AI provider took too long to answer.', 504);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AiError('prompt_network_error', 'Could not reach the AI provider.', 503);
  }
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  ) {
    return new AiError('prompt_client_error', 'The AI provider refused the API key.', 401);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new AiError(
      'prompt_client_error',
      'The AI provider is rate limiting this site. Try again later.',
      429,
    );
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new AiError(
      'prompt_client_error',
      `The AI provider doesn't know this model: ${error.message}`,
      400,
    );
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 500;
    return status >= 500
      ? new AiError(
          'prompt_upstream_server_error',
          `The AI provider had a problem: ${error.message}`,
          502,
        )
      : new AiError('prompt_client_error', error.message, status);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new AiError('prompt_builder_error', message, 500);
}

export function createAnthropicProvider(
  factory: AnthropicClientFactory = defaultFactory,
): AiProvider {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    envVar: 'PRESSBASE_ANTHROPIC_API_KEY',
    defaultModel: 'claude-opus-5-5',
    models: [
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
      { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
    ],
    keyUrl: 'https://platform.claude.com/settings/keys',

    async generateText(request: AiTextRequest, context: AiProviderContext): Promise<AiResult> {
      const client = factory({ apiKey: context.apiKey, timeout: context.timeoutMs });
      const tools: Anthropic.Beta.BetaTool[] = (request.functionDeclarations ?? []).map((fn) => ({
        name: fn.name,
        description: fn.description,
        input_schema: toolSchema(fn.parameters),
      }));
      const messages: Anthropic.Beta.BetaMessageParam[] = request.messages.map((message) => {
        const raw = message.providerContent;
        if (message.role === 'model' && raw?.providerId === 'anthropic') {
          // The assistant turn as Claude sent it, thinking blocks included.
          return {
            role: 'assistant',
            content: raw.content as Anthropic.Beta.BetaContentBlockParam[],
          };
        }
        return {
          role: message.role === 'model' ? 'assistant' : 'user',
          content: toContent(message),
        };
      });
      const fallback = FALLBACK_MODELS.has(request.model);
      const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
        model: request.model,
        max_tokens: request.maxTokens,
        messages,
        ...(request.systemInstruction ? { system: request.systemInstruction } : {}),
        ...(tools.length ? { tools, tool_choice: { type: 'auto' } } : {}),
        ...(request.outputSchema
          ? {
              output_config: {
                format: {
                  type: 'json_schema',
                  schema: transformJSONSchema(request.outputSchema as never) as Record<
                    string,
                    unknown
                  >,
                },
              },
            }
          : {}),
        ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
      };

      let response: Anthropic.Beta.BetaMessage;
      try {
        response = await client.beta.messages.create(params, {
          signal: context.signal,
          timeout: context.timeoutMs,
        });
      } catch (error) {
        throw toAiError(error);
      }

      if (response.stop_reason === 'refusal') {
        throw new AiError('prompt_refused', 'The model declined this request.', 422);
      }
      const parts: AiMessagePart[] = [];
      for (const block of response.content) {
        if (block.type === 'text') parts.push({ type: 'text', text: block.text });
        else if (block.type === 'tool_use') {
          parts.push({
            type: 'function_call',
            id: block.id,
            name: block.name,
            args: (block.input ?? {}) as Record<string, unknown>,
          });
        }
      }
      const prompt =
        response.usage.input_tokens +
        (response.usage.cache_read_input_tokens ?? 0) +
        (response.usage.cache_creation_input_tokens ?? 0);
      const completion = response.usage.output_tokens;
      return {
        id: response.id,
        message: {
          role: 'model',
          parts,
          providerContent: { providerId: 'anthropic', content: response.content },
        },
        finishReason: finishReason(response.stop_reason),
        tokenUsage: {
          promptTokens: prompt,
          completionTokens: completion,
          totalTokens: prompt + completion,
        },
        providerId: 'anthropic',
        model: response.model,
      };
    },
  };
}
