import type { DesignChoice } from '@pressbase/design';
import type { JsonSchema } from '@pressbase/slots';
import { parseStructuredOutput } from '../ai/prompt-builder';
import { AiError } from '../ai/types';
import type { CurrentUser } from '../auth/users';
import type { Kernel } from '../kernel';
import {
  getSiteBrief,
  SITE_BRIEF_JSON_SCHEMA,
  type SiteBrief,
  siteBriefSchema,
} from '../site-building/brief';
import { patternIndex } from '../site-building/sections';
import {
  briefRequest,
  type ClarifyAnswer,
  designChoiceSchema,
  finishBrief,
  labelled,
  MAX_PAGES,
  normaliseSitemap,
  SITEMAP_TASK,
  STAGE_TIMEOUTS_MS,
  SYSTEM,
  sectionCategories,
  sitemapPagesSchema,
} from './pipeline';
import type { RunInput, Sitemap, SitemapPage, TokenUsage } from './runs';

/**
 * The guided flow's steps before a run (#60): Clarify, Brief, Design
 * direction and Sitemap, each one structured request the person sees the
 * answer to, edits, and passes to the run (`POST /runs` with `brief`,
 * `design` and `sitemap`), so the run doesn't ask again. The same rules as
 * the pipeline: the person's words are labelled data, the answer is checked
 * against a schema and retried once, and facts come only from the person.
 * See docs/architecture/site-builder.md#the-guided-flow.
 */

/** What one step used, so the flow can tell the person at the end. */
export interface StepUsage {
  tokens: TokenUsage;
  requests: number;
}

export const MAX_QUESTIONS = 3;
export const DESIGNS_PER_SET = 3;

interface Ask<T> {
  ability: string;
  task: string;
  data: string[];
  schema: JsonSchema;
  timeoutMs: number;
  validate?: (value: T) => string | null;
}

/** One structured request, as the pipeline makes them: checked, retried once with what was wrong. */
async function ask<T>(
  kernel: Kernel,
  user: CurrentUser,
  call: Ask<T>,
): Promise<{ value: T; usage: StepUsage }> {
  const usage: StepUsage = { tokens: { prompt: 0, completion: 0, total: 0 }, requests: 0 };
  let problem: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const builder = kernel.ai
      .prompt(call.task)
      .usingSystemInstruction(SYSTEM)
      .asJsonResponse(call.schema)
      .usingTimeout(call.timeoutMs)
      .forUser(user)
      .forAbility(call.ability);
    for (const part of call.data) builder.withText(part);
    if (problem) {
      builder.withText(
        `Your previous answer couldn’t be used: ${problem} Answer again, following the schema exactly.`,
      );
    }
    const result = await builder.generateTextResult();
    usage.requests++;
    usage.tokens.prompt += result.tokenUsage.promptTokens;
    usage.tokens.completion += result.tokenUsage.completionTokens;
    usage.tokens.total += result.tokenUsage.totalTokens;
    const text = result.message.parts
      .flatMap((p) => (p.type === 'text' ? [p.text] : []))
      .join('')
      .trim();
    try {
      const value = parseStructuredOutput<T>(text, call.schema);
      problem = call.validate?.(value) ?? null;
      if (!problem) return { value, usage };
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      problem = error.message;
    }
  }
  throw new AiError('prompt_invalid_output', `The answer stayed invalid: ${problem}`, 502);
}

/* ---------------------------------------------------------------- clarify */

export interface ClarifyQuestion {
  question: string;
}

const CLARIFY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      maxItems: MAX_QUESTIONS,
      description: `At most ${MAX_QUESTIONS} short questions; none when the description is enough.`,
      items: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            minLength: 5,
            maxLength: 160,
            description: 'One short question in plain words, such as “Do you take orders online?”',
          },
        },
        required: ['question'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
};

/** Clarify: at most three questions the description doesn't answer. */
export async function clarify(
  kernel: Kernel,
  user: CurrentUser,
  input: RunInput,
): Promise<{ questions: ClarifyQuestion[]; usage: StepUsage }> {
  const { value, usage } = await ask<{ questions: ClarifyQuestion[] }>(kernel, user, {
    ability: 'site-builder/clarify',
    task: [
      'Stage: clarify. Before the site brief is written, ask the site owner what you need to know and can’t tell from what they wrote.',
      `Ask at most ${MAX_QUESTIONS} short questions, the most useful first, each about one thing: what visitors can do (book, order, visit), what sets the business apart, who it serves. Don’t ask for anything they already gave. Ask none when the description is enough.`,
      'Write in the language the owner wrote in, in plain words a first-time site owner understands.',
    ].join('\n'),
    data: [labelled('site_owner_input', input)],
    schema: CLARIFY_SCHEMA,
    timeoutMs: STAGE_TIMEOUTS_MS.brief,
  });
  const seen = new Set<string>();
  const questions = value.questions
    .map((q) => ({ question: q.question.trim() }))
    .filter((q) => q.question && !seen.has(q.question) && seen.add(q.question))
    .slice(0, MAX_QUESTIONS);
  return { questions, usage };
}

/* ------------------------------------------------------------------ brief */

/** Brief: the brief from the form and the answers, as the pipeline's Brief stage writes it. */
export async function draftBrief(
  kernel: Kernel,
  user: CurrentUser,
  input: RunInput,
  answers: ClarifyAnswer[],
): Promise<{ brief: SiteBrief; usage: StepUsage }> {
  const given = answers.filter((a) => a.answer.trim());
  const site = await getSiteBrief(kernel);
  const { value, usage } = await ask<SiteBrief>(kernel, user, {
    ability: 'site-builder/brief',
    ...briefRequest(input, given),
    schema: SITE_BRIEF_JSON_SCHEMA as unknown as JsonSchema,
    timeoutMs: STAGE_TIMEOUTS_MS.brief,
    validate: (v) => (siteBriefSchema.safeParse(v).success ? null : 'The brief is invalid.'),
  });
  return { brief: finishBrief(input, value, site, given), usage };
}

/* ---------------------------------------------------------------- designs */

export interface DesignOption {
  /** A short name for the direction, such as “Warm and bright”. */
  label: string;
  choice: DesignChoice;
}

/** The font pairs the active theme can show, from the design system. */
async function fontPairs(kernel: Kernel, user: CurrentUser): Promise<string[]> {
  const system = (await kernel.abilities
    .get('core/get-design-system')
    ?.execute({}, kernel.abilities.context(user, 'rest'))) as
    | { design_options: { font_pairs: { id: string }[] } }
    | undefined;
  return system?.design_options.font_pairs.map((p) => p.id) ?? [];
}

const sameDirection = (a: DesignChoice, b: DesignChoice) =>
  a.fontPair === b.fontPair &&
  a.mood === b.mood &&
  a.scheme === b.scheme &&
  Math.min(Math.abs(a.hue - b.hue), 360 - Math.abs(a.hue - b.hue)) < 20;

/**
 * Design direction: three different directions for the brief. `shown`
 * are directions already offered ("Show three more"): the new ones differ.
 */
export async function designOptions(
  kernel: Kernel,
  user: CurrentUser,
  brief: SiteBrief,
  shown: DesignChoice[] = [],
): Promise<{ designs: DesignOption[]; usage: StepUsage }> {
  const choice = designChoiceSchema(await fontPairs(kernel, user)) as JsonSchema & {
    properties: Record<string, JsonSchema>;
    required: string[];
  };
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      designs: {
        type: 'array',
        minItems: DESIGNS_PER_SET,
        maxItems: DESIGNS_PER_SET,
        items: {
          ...choice,
          properties: {
            label: {
              type: 'string',
              minLength: 1,
              maxLength: 40,
              description: 'A short name for the direction, such as “Warm and bright”.',
            },
            ...choice.properties,
          },
          required: ['label', ...choice.required],
        },
      },
    },
    required: ['designs'],
    additionalProperties: false,
  };
  const { value, usage } = await ask<{ designs: (DesignChoice & { label: string })[] }>(
    kernel,
    user,
    {
      ability: 'site-builder/designs',
      task: [
        `Stage: design directions. Offer ${DESIGNS_PER_SET} clearly different design directions that suit the site in the brief: different accent hues, moods and font pairs. Code makes the colours from each.`,
        ...(shown.length
          ? ['The owner has seen the directions under <shown_directions>: offer new ones.']
          : []),
      ].join('\n'),
      data: [
        labelled('site_brief', brief),
        ...(shown.length ? [labelled('shown_directions', shown)] : []),
      ],
      schema,
      timeoutMs: STAGE_TIMEOUTS_MS.design,
      validate: (v) => {
        const all = v.designs;
        for (let i = 0; i < all.length; i++) {
          for (let j = i + 1; j < all.length; j++) {
            if (sameDirection(all[i] as DesignChoice, all[j] as DesignChoice)) {
              return 'Two of the directions are the same. Make each one clearly different.';
            }
          }
        }
        return null;
      },
    },
  );
  const designs = value.designs.map(({ label, ...rest }) => ({
    label: label.trim(),
    choice: rest as DesignChoice,
  }));
  return { designs, usage };
}

/* ---------------------------------------------------------------- sitemap */

export interface SectionKind {
  category: string;
  label: string;
}

/** The kinds of section this site's patterns can build, for the sitemap's "Add section". */
export function sectionKinds(kernel: Kernel): SectionKind[] {
  const labels = new Map(kernel.blocks.patternCategories().map((c) => [c.name, c.label]));
  return [...sectionCategories(patternIndex(kernel)).keys()].map((category) => ({
    category,
    label: labels.get(category) ?? category,
  }));
}

/** Sitemap: the pages and their sections, for the person to arrange. */
export async function draftSitemap(
  kernel: Kernel,
  user: CurrentUser,
  brief: SiteBrief,
): Promise<{ sitemap: Sitemap; sections: SectionKind[]; usage: StepUsage }> {
  const sections = sectionKinds(kernel);
  const names = sections.map((s) => s.category);
  const known = new Set(names);
  const labels = new Map(sections.map((s) => [s.category, s.label]));
  const { value, usage } = await ask<{ pages: SitemapPage[] }>(kernel, user, {
    ability: 'site-builder/sitemap',
    task: SITEMAP_TASK.join('\n'),
    data: [labelled('site_brief', brief)],
    schema: {
      type: 'object',
      properties: { pages: sitemapPagesSchema(names, labels) },
      required: ['pages'],
      additionalProperties: false,
    },
    timeoutMs: STAGE_TIMEOUTS_MS.sitemap,
    validate: (v) =>
      normaliseSitemap(v.pages, known).pages.length
        ? null
        : 'The sitemap has no page with a known section.',
  });
  const sitemap = normaliseSitemap(value.pages, known);
  sitemap.pages = sitemap.pages.slice(0, MAX_PAGES);
  return { sitemap, sections, usage };
}
