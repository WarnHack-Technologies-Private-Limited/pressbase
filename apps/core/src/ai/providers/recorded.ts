import type { JsonSchema } from '../../abilities/json-schema';
import type { AiProvider, AiResult, AiTextRequest } from '../types';
import { isAssistantRequest, recordedAssistantStep } from './recorded-assistant';

/**
 * The recorded provider: answers recorded for one site (a neighbourhood
 * bakery), for end-to-end tests, screenshots and demos without a real AI
 * provider or key. It never reaches the network.
 *
 * **Off unless `PRESSBASE_AI_TEST_PROVIDER=recorded`** is set when core
 * starts (the e2e suite sets it); then Settings → AI lists it as
 * "Recorded answers (for testing)". It still needs a key saved, like any
 * provider (anything will do), and AI turned on.
 *
 * It tells the site builder's requests apart by their schema (the request
 * carries no ability name) and answers each with the recording, fitted to
 * the schema: the sitemap keeps the sections this site's patterns have, and
 * a page fills every slot it's given with plain copy and no facts, so the
 * honest-content rules leave placeholders where facts would go.
 * Anything else gets the first value its schema allows. Studio's AI panel
 * gets a few recorded conversations through the tool loop
 * (recorded-assistant.ts).
 * See docs/architecture/ai.md#testing-without-a-provider.
 */

type Schema = JsonSchema & {
  type?: string | string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  anyOf?: Schema[];
  enum?: unknown[];
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
};
type Json = Record<string, unknown>;

export const RECORDED_PROVIDER_ID = 'recorded';
export const TEST_PROVIDER_ENV = 'PRESSBASE_AI_TEST_PROVIDER';
/** Milliseconds to wait before each answer (default none), to watch progress. */
export const TEST_DELAY_ENV = 'PRESSBASE_AI_TEST_DELAY_MS';

const QUESTIONS = [
  'Can people order online, or only in the shop?',
  'What are you best known for?',
  'Who comes in most: neighbours, families or office workers?',
];

const design = (
  label: string,
  mood: string,
  hue: number,
  fontPair: string,
  radius: string,
  density: string,
) => ({ label, mood, hue, fontPair, radius, density });

const DESIGNS = [
  design('Warm and bright', 'warm', 30, 'platypi-manrope', 'rounded', 'comfortable'),
  design('Fresh and calm', 'calm', 150, 'geometric', 'soft', 'spacious'),
  design('Classic and quiet', 'elegant', 250, 'old-style', 'subtle', 'comfortable'),
  design('Bold and playful', 'playful', 340, 'rounded', 'soft', 'compact'),
  design('Earthy', 'earthy', 60, 'slab-humanist', 'subtle', 'spacious'),
  design('Clean and simple', 'minimal', 200, 'transitional-humanist', 'square', 'comfortable'),
];

const page = (title: string, slug: string, sections: string[]) => ({ title, slug, sections });

const PAGES = [
  page('Home', 'home', ['banner', 'about', 'services', 'testimonials', 'call-to-action']),
  page('Our bakes', 'our-bakes', ['services', 'text', 'call-to-action']),
  page('About us', 'about-us', ['about', 'team']),
  page('Visit', 'visit', ['opening-hours', 'contact']),
];

/** Plain copy with no facts in it: no numbers, names or addresses. */
const COPY = [
  'Bread baked fresh every morning',
  'Sourdough, pastries and good coffee for the neighbourhood.',
  'Come in, say hello and take something warm home.',
  'Made by hand, slowly, the way bread should be.',
  'A small bakery with a big oven',
  'Seasonal bakes and old favourites, side by side.',
];

const SHORT = ['Come and visit', 'Our bakes', 'Visit us', 'Say hello', 'Visit'];

function firstType(s: Schema): string | undefined {
  return Array.isArray(s.type) ? s.type[0] : s.type;
}

/** A value for a schema: the first choice, the fewest items, plain copy for text. */
export function fillSchema(s: Schema, key = '', n = { i: 0 }): unknown {
  if (s.anyOf) return fillSchema(s.anyOf[0] as Schema, key, n);
  if (s.enum) return s.enum[0];
  const type = firstType(s);
  if (type === 'object') {
    const out: Json = {};
    for (const [k, v] of Object.entries(s.properties ?? {})) out[k] = fillSchema(v, k, n);
    return out;
  }
  if (type === 'array') {
    const count = Math.min(Math.max(1, Number(s.minItems ?? 1)), Number(s.maxItems ?? 3));
    return Array.from({ length: count }, () => fillSchema(s.items ?? {}, key, n));
  }
  if (type === 'integer' || type === 'number') return Number(s.minimum ?? 0);
  if (type === 'boolean') return false;
  if (/url|href|link/i.test(key)) return '/visit/';
  const max = Number(s.maxLength ?? Number.POSITIVE_INFINITY);
  const min = Number(s.minLength ?? 0);
  const next = COPY[n.i++ % COPY.length] as string;
  // Short slots (buttons, labels) get a short phrase rather than a cut sentence.
  const text = next.length <= max ? next : (SHORT.find((t) => t.length <= max) ?? next);
  let out = text.length > max ? text.slice(0, max) : text;
  while (out.length < min) out += ' fresh';
  return out;
}

/** Which request this is, from its schema's shape. */
export function recordedStage(schema: Schema | undefined): string {
  const props = schema?.properties ?? {};
  if ('questions' in props) return 'clarify';
  if ('designs' in props) return 'designs';
  if ('kind' in props && 'tone' in props) return 'brief';
  if ('hue' in props) return 'design';
  if ('pages' in props) return 'sitemap';
  if ('header' in props || 'footer' in props) return 'parts';
  if (Object.keys(props).some((k) => k.startsWith('section_'))) return 'page';
  return 'other';
}

/** The recorded answer for a request. */
export function recordedAnswer(request: AiTextRequest): unknown {
  const schema = request.outputSchema as Schema | undefined;
  const prompt = request.messages
    .flatMap((m) => m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])))
    .join('\n');
  switch (recordedStage(schema)) {
    case 'clarify':
      return { questions: QUESTIONS.map((question) => ({ question })) };
    case 'brief':
      return {
        name: '',
        kind: 'Neighbourhood bakery',
        audience: 'Neighbours, families and people on their way to work',
        tone: 'Warm, plain and friendly',
        facts: [],
        pages: PAGES.map((p) => p.title),
        language: '',
      };
    case 'designs':
    case 'design': {
      const allowed = (schema?.properties?.designs?.items ?? schema)?.properties?.fontPair?.enum as
        | string[]
        | undefined;
      // "Show three more": the next three, after those the prompt says were shown.
      const shown = prompt.includes('<shown_directions>')
        ? (prompt.match(/"hue":/g)?.length ?? 0)
        : 0;
      const pick = [0, 1, 2].map((i) => {
        const d = DESIGNS[(shown + i) % DESIGNS.length] as (typeof DESIGNS)[number];
        const fontPair = allowed?.includes(d.fontPair) ? d.fontPair : (allowed?.[0] ?? d.fontPair);
        return { ...d, fontPair, contrast: 'standard', scheme: 'light' };
      });
      if (recordedStage(schema) === 'designs') return { designs: pick };
      const { label: _label, ...choice } = pick[0] as Json;
      return choice;
    }
    case 'sitemap': {
      const value = fillSchema(schema as Schema) as Json;
      const known =
        (schema?.properties?.pages?.items?.properties?.sections?.items?.properties?.category
          ?.enum as string[] | undefined) ?? [];
      const pages = PAGES.map((page) => ({
        title: page.title,
        slug: page.slug,
        sections: page.sections
          .filter((c) => known.includes(c))
          .slice(0, 5)
          .map((category) => ({ category, intent: `The ${category.replace(/-/g, ' ')} section.` })),
      })).filter((p) => p.sections.length);
      value.pages = pages.length
        ? pages
        : [{ title: 'Home', slug: 'home', sections: [{ category: known[0], intent: '' }] }];
      return value;
    }
    default:
      return fillSchema(schema ?? { type: 'string' });
  }
}

export function createRecordedProvider(): AiProvider {
  let n = 0;
  return {
    id: RECORDED_PROVIDER_ID,
    name: 'Recorded answers (for testing)',
    envVar: 'PRESSBASE_RECORDED_API_KEY',
    defaultModel: 'recorded-1',
    models: [{ id: 'recorded-1', name: 'Recorded answers' }],
    async generateText(request, context): Promise<AiResult> {
      n++;
      // A pause before each answer, so progress can be watched (and screenshotted).
      const delay = Number(process.env[TEST_DELAY_ENV] ?? 0);
      if (delay > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(delay, 20_000));
          context.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      // Studio's AI panel: a tool loop, played a step at a time.
      const step = isAssistantRequest(request) ? recordedAssistantStep(request) : null;
      const value =
        step && 'text' in step
          ? step.text
          : request.outputSchema
            ? recordedAnswer(request)
            : 'Recorded answer.';
      const text =
        step && 'call' in step ? '' : typeof value === 'string' ? value : JSON.stringify(value);
      const promptTokens = Math.ceil(
        JSON.stringify(request.messages).length / 4 + (request.systemInstruction?.length ?? 0) / 4,
      );
      const completionTokens = Math.ceil(text.length / 4);
      return {
        id: `recorded_${n}`,
        message:
          step && 'call' in step
            ? {
                role: 'model',
                parts: [{ type: 'function_call', id: `recorded_call_${n}`, ...step.call }],
              }
            : { role: 'model', parts: [{ type: 'text', text }] },
        finishReason: step && 'call' in step ? 'tool_calls' : 'stop',
        tokenUsage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        providerId: RECORDED_PROVIDER_ID,
        model: request.model,
      };
    },
  };
}
