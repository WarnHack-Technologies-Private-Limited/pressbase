import type { AbilityContext, PluginApi } from '@pressbase/plugin-sdk';
import { summarize } from './analysis';
import { auditPost } from './audit';
import { plainText, trimText } from './html';

/**
 * AI suggestions (opt-in, on core's AI client: docs/architecture/ai.md).
 * Three abilities, usable from the SEO panel (through `/wp-abilities/v1`),
 * the CLI (`pressbase ability run`) and AI agents, with the same checks:
 *
 * - `pressbase-seo/suggest-meta`: 2–3 options for the SEO title, the meta
 *   description, or the social title or description.
 * - `pressbase-seo/suggest-alt-text`: 2–3 alt texts for an image, from its
 *   file name, caption and the post around it (the client sends text only,
 *   so the model doesn't see the image; the panel says so).
 * - `pressbase-seo/audit-post`: the content checks, plus, with `explain`,
 *   a short plain-language summary written by the model.
 *
 * Suggestions are never applied: the editor picks one or none. Only the
 * post's title, excerpt and the start of its content are sent, never
 * private or password-protected text. Output is plain text (core strips
 * HTML) and length-checked here.
 */

export const FIELDS = ['title', 'description', 'social-title', 'social-description'] as const;
export type SuggestField = (typeof FIELDS)[number];

const LIMITS: Record<SuggestField | 'alt', number> = {
  title: 70,
  description: 160,
  'social-title': 90,
  'social-description': 200,
  alt: 150,
};

const INSTRUCTIONS: Record<SuggestField, string> = {
  title:
    'Write SEO titles for a web page: specific, accurate, under 60 characters, the main topic near the start. No site name, no quotes, no clickbait.',
  description:
    'Write meta descriptions for a web page: one or two plain sentences, 120 to 155 characters, saying what the reader gets. No quotes, no clickbait, no keyword stuffing.',
  'social-title':
    'Write titles for sharing a web page on Facebook and X: specific and inviting, under 70 characters, no hashtags, no clickbait.',
  'social-description':
    'Write short descriptions for sharing a web page on Facebook and X: one sentence, under 160 characters, no hashtags.',
};

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

export interface Suggestions {
  options: string[];
  provider: string;
  model: string;
}

const OPTIONS_SCHEMA = {
  type: 'object',
  properties: {
    options: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
  },
  required: ['options'],
};

const SUGGESTIONS_OUTPUT = {
  type: 'object',
  properties: {
    options: { type: 'array', items: { type: 'string' } },
    provider: { type: 'string' },
    model: { type: 'string' },
  },
  required: ['options', 'provider', 'model'],
};

/** Plain text, one line, cut to the field's limit; empty and repeated options dropped. */
export function cleanOptions(raw: unknown, max: number): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const text = trimText(
      plainText(item)
        .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
        .trim(),
      max,
    );
    if (text && !out.some((o) => o.toLowerCase() === text.toLowerCase())) out.push(text);
  }
  return out.slice(0, 3);
}

function providerLabel(id: string): string {
  return PROVIDER_NAMES[id] ?? id;
}

/** The text a suggestion may see: title, excerpt and the start of the content. */
async function postText(
  api: PluginApi,
  input: { postId?: number; title?: string; excerpt?: string; content?: string },
): Promise<{ title: string; excerpt: string; content: string }> {
  let { title = '', excerpt = '', content = '' } = input;
  if (input.postId) {
    const post = await api.content.posts.get(input.postId);
    if (post?.password) {
      // Protected: only what the public sees.
      return { title: plainText(title || post.title), excerpt: '', content: '' };
    }
    if (post) {
      title ||= post.title;
      excerpt ||= post.excerpt;
      content ||= post.content;
    }
  }
  return {
    title: plainText(title).slice(0, 300),
    excerpt: plainText(excerpt).slice(0, 600),
    content: trimText(plainText(content), 1500),
  };
}

async function ask(
  api: PluginApi,
  ability: string,
  context: AbilityContext,
  system: string,
  prompt: string,
  max: number,
): Promise<Suggestions> {
  const result = await api.ai
    .prompt(prompt)
    .usingSystemInstruction(
      `${system} Reply with JSON: {"options": [two or three different options]}. English, plain text only.`,
    )
    .usingMaxTokens(1000)
    .asJsonResponse(OPTIONS_SCHEMA)
    .forUser(context.user)
    .forAbility(ability)
    .generateTextResult();
  const text = result.message.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw api.abilities.error('prompt_invalid_output', 'The AI provider’s answer couldn’t be read.', 502);
  }
  const options = cleanOptions((parsed as { options?: unknown })?.options, max);
  if (!options.length) {
    throw api.abilities.error('prompt_invalid_output', 'The AI provider didn’t suggest anything usable.', 502);
  }
  return { options, provider: providerLabel(result.providerId), model: result.model };
}

const canEdit = async (postId: number | undefined, context: AbilityContext) =>
  postId ? context.can('edit_post', postId) : context.can('edit_posts');

export function registerAbilities(api: PluginApi): void {
  api.abilities.registerCategory('pressbase-seo', {
    label: 'SEO',
    description: 'Search titles, descriptions and content checks from Pressbase SEO.',
  });

  api.abilities.register<
    {
      field: SuggestField;
      postId?: number;
      title?: string;
      excerpt?: string;
      content?: string;
      keyphrase?: string;
    },
    Suggestions
  >('suggest-meta', {
    label: 'Suggest search and social text',
    description:
      'Suggests two or three SEO titles, meta descriptions or social texts for a post, from its title, excerpt and the start of its content. Nothing is saved.',
    category: 'pressbase-seo',
    inputSchema: {
      type: 'object',
      properties: {
        field: { type: 'string', enum: [...FIELDS], default: 'description' },
        postId: { type: 'integer', minimum: 1 },
        title: { type: 'string', maxLength: 1000 },
        excerpt: { type: 'string', maxLength: 5000 },
        content: { type: 'string', maxLength: 200000 },
        keyphrase: { type: 'string', maxLength: 200 },
      },
      required: ['field'],
      additionalProperties: false,
    },
    outputSchema: SUGGESTIONS_OUTPUT,
    permissionCallback: (input, context) => canEdit(input.postId, context),
    executeCallback: async (input, context) => {
      const text = await postText(api, input);
      if (!text.title && !text.content) {
        throw api.abilities.error('pressbase_seo_nothing_to_go_on', 'Write a title or some content first.', 400);
      }
      const keyphrase = input.keyphrase?.trim();
      const prompt = [
        `Post title: ${text.title || '(none)'}`,
        text.excerpt ? `Excerpt: ${text.excerpt}` : '',
        keyphrase ? `Focus keyphrase (use it naturally): ${keyphrase}` : '',
        text.content ? `Start of the post:\n${text.content}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      return ask(
        api,
        'pressbase-seo/suggest-meta',
        context,
        INSTRUCTIONS[input.field],
        prompt,
        LIMITS[input.field],
      );
    },
    meta: { annotations: { readonly: true, destructive: false, idempotent: false }, showInRest: true },
  });

  api.abilities.register<
    { attachmentId?: number; filename?: string; caption?: string; postId?: number; postTitle?: string; context?: string },
    Suggestions
  >('suggest-alt-text', {
    label: 'Suggest alt text',
    description:
      'Suggests two or three alt texts for an image from its file name, caption and the post it’s in. The model doesn’t see the image itself, so check the result against it. Nothing is saved.',
    category: 'pressbase-seo',
    inputSchema: {
      type: 'object',
      properties: {
        attachmentId: { type: 'integer', minimum: 1 },
        filename: { type: 'string', maxLength: 500 },
        caption: { type: 'string', maxLength: 1000 },
        postId: { type: 'integer', minimum: 1 },
        postTitle: { type: 'string', maxLength: 1000 },
        context: { type: 'string', maxLength: 5000 },
      },
      additionalProperties: false,
    },
    outputSchema: SUGGESTIONS_OUTPUT,
    permissionCallback: async (input, context) =>
      (await context.can('upload_files')) && (await canEdit(input.postId, context)),
    executeCallback: async (input, context) => {
      let filename = input.filename ?? '';
      let caption = input.caption ?? '';
      if (input.attachmentId) {
        const attachment = await api.content.posts.get(input.attachmentId);
        if (attachment?.type === 'attachment') {
          filename ||= String(await api.meta.get('post', attachment.id, '_wp_attached_file', true) ?? '');
          caption ||= attachment.excerpt || attachment.title;
        }
      }
      const name = filename.split('/').pop()?.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ') ?? '';
      if (!name.trim() && !caption.trim() && !input.context?.trim()) {
        throw api.abilities.error('pressbase_seo_nothing_to_go_on', 'There’s nothing to describe the image from yet.', 400);
      }
      const prompt = [
        name ? `Image file name: ${name}` : '',
        caption ? `Caption: ${plainText(caption)}` : '',
        input.postTitle ? `Post title: ${plainText(input.postTitle)}` : '',
        input.context ? `Text near the image: ${trimText(plainText(input.context), 800)}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      return ask(
        api,
        'pressbase-seo/suggest-alt-text',
        context,
        'Write alt text for an image on a web page: what the image shows, for someone who can’t see it, under 125 characters, no "image of" or "picture of".',
        prompt,
        LIMITS.alt,
      );
    },
    meta: { annotations: { readonly: true, destructive: false, idempotent: false }, showInRest: true },
  });

  api.abilities.register<
    { postId: number; explain?: boolean },
    {
      postId: number;
      summary: string;
      checks: { id: string; status: string; label: string; message: string; why: string }[];
      advice?: string;
      provider?: string;
    }
  >('audit-post', {
    label: 'Check a post’s SEO',
    description:
      'Runs Pressbase SEO’s content checks on a post (keyphrase, description, headings, alt text, links, duplicate titles). With explain, the AI client adds a short plain-language summary.',
    category: 'pressbase-seo',
    inputSchema: {
      type: 'object',
      properties: {
        postId: { type: 'integer', minimum: 1 },
        explain: { type: 'boolean', default: false },
      },
      required: ['postId'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        postId: { type: 'integer' },
        summary: { type: 'string' },
        checks: { type: 'array', items: { type: 'object' } },
        advice: { type: 'string' },
        provider: { type: 'string' },
      },
      required: ['postId', 'summary', 'checks'],
    },
    permissionCallback: (input, context) => context.can('edit_post', input.postId),
    executeCallback: async (input, context) => {
      const post = await api.content.posts.get(input.postId);
      if (!post || post.type === 'revision') {
        throw api.abilities.error('rest_post_invalid_id', 'Invalid post ID.', 404);
      }
      const results = await auditPost(api, post);
      const checks = results.map(({ id, status, label, message, why }) => ({ id, status, label, message, why }));
      const summary = summarize(results, (s) => api.i18n.__(s));
      if (!input.explain || !(await api.ai.supportsAi())) return { postId: post.id, summary, checks };
      const todo = checks.filter((c) => c.status === 'improve').map((c) => `- ${c.label}: ${c.message}`);
      const result = await api.ai
        .prompt(
          `Post title: ${plainText(post.title)}\n\nSuggestions from the checks:\n${todo.join('\n') || '- none'}`,
        )
        .usingSystemInstruction(
          'In two or three calm, plain sentences, say what would most improve this post’s search appearance, based only on the listed suggestions. No scores, no hype.',
        )
        .usingMaxTokens(600)
        .forUser(context.user)
        .forAbility('pressbase-seo/audit-post')
        .generateTextResult();
      const advice = trimText(
        plainText(result.message.parts.map((p) => (p.type === 'text' ? p.text : '')).join(' ')),
        600,
      );
      return { postId: post.id, summary, checks, advice, provider: providerLabel(result.providerId) };
    },
    meta: { annotations: { readonly: true, destructive: false, idempotent: true }, showInRest: true },
  });

  // Whether the panel shows Suggest buttons.
  api.rest.registerRoute('pressbase-seo/v1', '/ai', {
    permission: (c) => api.rest.userCan(c, 'edit_posts'),
    handler: async () => ({ available: await api.ai.supportsAi() }),
  });
}
