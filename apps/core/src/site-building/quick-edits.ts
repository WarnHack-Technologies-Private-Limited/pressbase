import type { EditOperation } from '@pressbase/site-edits';
import { extractSlots, type Slot, type SlotValues } from '@pressbase/slots';
import type { JsonSchema } from '../abilities/json-schema';
import { AiError } from '../ai/types';
import type { CurrentUser } from '../auth/users';
import type { BlockPattern } from '../blocks/patterns';
import type { Kernel } from '../kernel';
import {
  enforceHonestContent,
  FACT_CATEGORIES,
  type Grounding,
  groundingFrom,
  unsupportedDetails,
} from '../site-builder/honest';
import { labelled, pageSchema, SYSTEM, sectionCategories } from '../site-builder/pipeline';
import { getSiteBrief, type SiteBrief } from './brief';
import { PROPOSE_SITE_EDITS } from './edits';
import { type Patterns, patternBlocks, patternIndex } from './sections';

/**
 * *Ask AI* in Studio (#63): quick requests about what's selected, and a
 * prompt to a section or a page. Each is one or two structured calls
 * (`generateJson()`), never a free-running agent:
 *
 * - **Rewrite** (`rewriteTexts()`): rewrite, shorten, expand, change the
 *   tone, translate or fix the spelling of a few texts, with the quick-edits
 *   model (`usingModelTier('fast')`). Studio turns the answer into
 *   `updateSlots` operations.
 * - **Prompt to section** (`proposeSection()`): which kind of section the
 *   person describes (from their words when they name one, else asked),
 *   then one of its patterns with its slots filled: an `insertSection`.
 * - **Prompt to page** (`proposePage()`): a title and the kinds of section,
 *   then each section's pattern and slots: a `createPage`.
 *
 * Honest content applies throughout: facts only from the site's brief and
 * the person's own words; anything else is a placeholder. Sections and pages
 * are checked by `core/propose-site-edits` as the person, so what Studio
 * gets is a set it can apply with Keep and Undo. Nothing here writes.
 * See docs/architecture/ai-edits.md#ask-ai.
 */

export const REWRITE_ACTIONS = [
  'rewrite',
  'shorten',
  'expand',
  'tone',
  'translate',
  'fix_spelling',
] as const;
export type RewriteAction = (typeof REWRITE_ACTIONS)[number];

export const TONES = ['friendly', 'formal', 'confident', 'simple', 'playful'] as const;
export type Tone = (typeof TONES)[number];

/** Attribution in the usage log. */
export const QUICK_EDIT_ABILITY = 'studio/quick-edit';
export const SECTION_ABILITY = 'studio/section';
export const PAGE_ABILITY = 'studio/page';

export const MAX_TEXTS = 40;
export const MAX_TEXT_LENGTH = 2000;
/** Sections a prompted page may have. */
export const MAX_PAGE_SECTIONS = 6;
/** Patterns offered for each section. */
const CANDIDATES = 4;
const TIMEOUT_MS = { rewrite: 45_000, plan: 60_000, fill: 120_000 };

const TONE_WORDS: Record<Tone, string> = {
  friendly: 'warmer and friendlier',
  formal: 'more formal and professional',
  confident: 'more confident and direct',
  simple: 'simpler, in plain words anyone understands',
  playful: 'lighter and more playful',
};

/** What each action asks for, as the task's first line. */
export function rewriteTask(action: RewriteAction, options: { tone?: Tone; language?: string }) {
  switch (action) {
    case 'rewrite':
      return 'Rewrite each text so it reads better. Keep its meaning, its language and about its length.';
    case 'shorten':
      return 'Make each text shorter, about half as long, keeping what matters most. Keep its language.';
    case 'expand':
      return 'Make each text a little longer, at most one more sentence, by saying more clearly what it already says. Keep its language. Add no new facts.';
    case 'tone':
      return `Rewrite each text so it sounds ${TONE_WORDS[options.tone ?? 'friendly']}. Keep its meaning and its language.`;
    case 'translate':
      return `Translate each text into ${options.language || 'English'}. Keep names of people, places and businesses as they are.`;
    case 'fix_spelling':
      return 'Correct spelling, grammar and punctuation only. Change nothing else; return a text that is already correct exactly as it is.';
  }
}

const RULES = [
  'Each text is plain text from the site owner’s page: answer with plain text, never HTML or Markdown.',
  'Honest content: add no facts that aren’t in the text or the brief — no numbers, prices, dates, names, addresses, phone numbers, quotes or claims.',
  'Keep anything in square brackets, such as [Add a customer quote], exactly as it is: it’s a gap for the owner to fill.',
];

export interface RewriteInput {
  action: RewriteAction;
  tone?: Tone;
  language?: string;
  texts: { id: string; text: string }[];
}

export interface RewriteResult {
  texts: { id: string; text: string }[];
  /** IDs left as they were: the answer added details the brief doesn't give. */
  kept: string[];
}

/** The answer's schema: one string per text, by its key (`t1`, `t2`…). */
export function rewriteSchema(input: RewriteInput): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  input.texts.forEach((t, i) => {
    const length = t.text.length;
    const max =
      input.action === 'shorten'
        ? Math.max(1, length)
        : input.action === 'expand'
          ? length * 3 + 200
          : length * 2 + 80;
    properties[`t${i + 1}`] = { type: 'string', minLength: 1, maxLength: Math.min(max, 4000) };
  });
  return {
    type: 'object',
    properties: {
      rewritten: {
        type: 'object',
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
      },
    },
    required: ['rewritten'],
    additionalProperties: false,
  };
}

/** One structured call, asked again once when the answer doesn't fit the schema. */
async function ask<T>(
  kernel: Kernel,
  user: CurrentUser,
  call: {
    task: string;
    data: string[];
    schema: JsonSchema;
    ability: string;
    tier: 'default' | 'fast';
    timeoutMs: number;
    validate?: (value: T) => string | null;
  },
): Promise<T> {
  let problem: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const builder = kernel.ai
      .prompt(call.task)
      .usingSystemInstruction(SYSTEM)
      .asJsonResponse(call.schema)
      .usingModelTier(call.tier)
      .usingTimeout(call.timeoutMs)
      .forUser(user)
      .forAbility(call.ability);
    for (const part of call.data) builder.withText(part);
    if (problem) {
      builder.withText(
        `Your previous answer couldn’t be used: ${problem} Answer again, following the schema exactly.`,
      );
    }
    try {
      const value = await builder.generateJson<T>();
      problem = call.validate?.(value) ?? null;
      if (!problem) return value;
    } catch (error) {
      if (!(error instanceof AiError) || error.code !== 'prompt_invalid_output') throw error;
      problem = error.message;
    }
  }
  throw new AiError('prompt_invalid_output', `The answer stayed invalid: ${problem}`, 502);
}

/** What the brief knows, plus `more` (the person's own words, the page's text): facts. */
function grounding(brief: SiteBrief, more: string[]): Grounding {
  return groundingFrom([brief.name, ...brief.facts, ...more]);
}

/**
 * Rewrites texts as `action` asks, with the quick-edits model. A text whose
 * new version brings in numbers, addresses or links the brief and the page
 * don't have keeps its old version (`kept`).
 */
export async function rewriteTexts(
  kernel: Kernel,
  user: CurrentUser,
  input: RewriteInput,
): Promise<RewriteResult> {
  const brief = await getSiteBrief(kernel);
  const keys = new Map(input.texts.map((t, i) => [`t${i + 1}`, t]));
  const answer = await ask<{ rewritten: Record<string, string> }>(kernel, user, {
    task: [rewriteTask(input.action, input), ...RULES].join('\n'),
    data: [
      labelled('site_brief', { name: brief.name, kind: brief.kind, tone: brief.tone }),
      labelled('texts', Object.fromEntries([...keys].map(([key, t]) => [key, t.text]))),
    ],
    schema: rewriteSchema(input),
    ability: QUICK_EDIT_ABILITY,
    tier: 'fast',
    timeoutMs: TIMEOUT_MS.rewrite,
  });
  const facts = grounding(
    brief,
    input.texts.map((t) => t.text),
  );
  const texts: RewriteResult['texts'] = [];
  const kept: string[] = [];
  for (const [key, original] of keys) {
    const text = String(answer.rewritten[key] ?? '').trim();
    if (!text || unsupportedDetails(text, facts).length) {
      kept.push(original.id);
      continue;
    }
    texts.push({ id: original.id, text });
  }
  return { texts, kept };
}

/* ------------------------------------------------------ sections and pages */

interface Candidate {
  name: string;
  title: string;
  description?: string;
  slots: Slot[];
}

function candidates(patterns: Patterns, names: string[]): Candidate[] {
  return names.slice(0, CANDIDATES).flatMap((name) => {
    const pattern = patterns.get(name);
    if (!pattern) return [];
    const slots = extractSlots(patternBlocks(pattern, patterns), { declarations: pattern.slots });
    return [{ name, title: pattern.title, description: pattern.description, slots }];
  });
}

/** Lower-cased words, accents kept. */
const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const stem = (word: string) => word.replace(/(ies|es|s)$/u, '');
/** Words too common to tell sections apart. */
const COMMON = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'with',
  'for',
  'of',
  'to',
  'our',
  'my',
  'section',
  'page',
  'add',
  'some',
  'about',
  'in',
  'on',
]);

/**
 * Patterns whose title or keywords the person's words name ("pricing with
 * three tiers" → the pattern with the keyword "pricing"), best first:
 * section patterns only. Empty when nothing matches.
 */
export function searchPatterns(
  prompt: string,
  patterns: Patterns,
  sections: ReadonlySet<string>,
): string[] {
  const said = new Set(
    words(prompt)
      .filter((w) => !COMMON.has(w) && w.length > 2)
      .map(stem),
  );
  if (!said.size) return [];
  const order = (name: string) => (patterns.get(name)?.source === 'core' ? 0 : 1);
  return [...sections]
    .map((name) => {
      const pattern = patterns.get(name);
      const terms = new Set(
        [...words(pattern?.title ?? ''), ...(pattern?.keywords ?? []).flatMap(words)].map(stem),
      );
      return { name, score: [...said].filter((w) => terms.has(w)).length };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score || order(a.name) - order(b.name))
    .map((p) => p.name);
}

/**
 * The kind of section the person names, when their words name exactly one
 * ("pricing with three tiers" → pricing): no call needed. Null otherwise.
 */
export function namedCategory(prompt: string, labels: Map<string, string>): string | null {
  const said = new Set(words(prompt));
  const saidStems = new Set([...said].map(stem));
  const found = [...labels].filter(([name, label]) => {
    const terms = [...new Set([...words(name.replace(/-/g, ' ')), ...words(label)])];
    return terms.length > 0 && terms.every((t) => said.has(t) || saidStems.has(stem(t)));
  });
  return found.length === 1 ? (found[0]?.[0] ?? null) : null;
}

function categorySchema(names: string[], labels: Map<string, string>): JsonSchema {
  return {
    type: 'string',
    enum: names,
    description: `The kind of section: ${names.map((n) => `${n} (${labels.get(n) ?? n})`).join(', ')}.`,
  };
}

interface SectionPlan {
  category: string;
  intent: string;
  /** Patterns to choose from, when found by search; else the category's. */
  patterns?: string[];
}

/** The kind of facts a section holds, for honest content: its category, or one its pattern names. */
function factCategory(category: string, pattern: BlockPattern | undefined): string {
  if (FACT_CATEGORIES.has(category)) return category;
  const named = [...(pattern?.categories ?? []), ...(pattern?.keywords ?? [])].find((c) =>
    FACT_CATEGORIES.has(c),
  );
  return named ?? category;
}

/** Writes sections: one call choosing each one's pattern and filling its slots, honest content enforced. */
async function fillSections(
  kernel: Kernel,
  user: CurrentUser,
  context: {
    brief: SiteBrief;
    prompt: string;
    page: string;
    ability: string;
    patterns: Patterns;
    categories: Map<string, string[]>;
  },
  plans: SectionPlan[],
): Promise<{ pattern: string; slots: SlotValues }[]> {
  const sections = plans
    .map((s) => ({
      ...s,
      candidates: candidates(
        context.patterns,
        s.patterns ?? context.categories.get(s.category) ?? [],
      ),
    }))
    .filter((s) => s.candidates.length);
  if (!sections.length) {
    throw new AiError(
      'studio_ai_no_section',
      'There’s no section of that kind to build with.',
      422,
    );
  }
  const answer = await ask<Record<string, { pattern: string; slots: SlotValues }>>(kernel, user, {
    task: [
      `Write ${sections.length === 1 ? 'a section' : 'the sections'} for the “${context.page}” page: for each section, choose one of its patterns and fill its slots.`,
      'Every slot is plain text. Use facts only from the brief and the site owner’s request; anywhere a fact is missing, write the slot’s placeholder in square brackets.',
      'Link buttons to the site’s pages by path, such as /contact/.',
    ].join('\n'),
    data: [
      labelled('site_brief', context.brief),
      labelled('site_owner_request', context.prompt),
      labelled(
        'sections',
        sections.map(({ category, intent }) => ({ category, intent })),
      ),
    ],
    schema: pageSchema(sections),
    ability: context.ability,
    tier: 'default',
    timeoutMs: TIMEOUT_MS.fill,
  });
  const facts = grounding(context.brief, [context.prompt]);
  return sections.map((section, i) => {
    const value = answer[`section_${i + 1}`] as { pattern: string; slots: SlotValues };
    const candidate =
      section.candidates.find((c) => c.name === value.pattern) ??
      (section.candidates[0] as Candidate);
    const honest = enforceHonestContent(
      candidate.slots,
      value.slots ?? {},
      facts,
      factCategory(section.category, context.patterns.get(candidate.name)),
    );
    return { pattern: candidate.name, slots: honest.values };
  });
}

export interface Proposal {
  operations: EditOperation[];
  summary: string;
  unused: string[];
}

/** Checks a set with core/propose-site-edits as the person (it changes nothing). */
async function propose(
  kernel: Kernel,
  user: CurrentUser,
  input: {
    operations: unknown[];
    summary: string;
    page?: number | string;
    changeset_uuid?: string;
  },
): Promise<Proposal> {
  const ability = kernel.abilities.get(PROPOSE_SITE_EDITS);
  if (!ability) throw new Error(`${PROPOSE_SITE_EDITS} isn’t registered.`);
  const result = (await ability.execute(
    {
      operations: input.operations,
      summary: input.summary,
      ...(input.page !== undefined ? { page: input.page } : {}),
      ...(input.changeset_uuid ? { changeset_uuid: input.changeset_uuid } : {}),
    },
    kernel.abilities.context(user, 'rest'),
  )) as Proposal;
  return { operations: result.operations, summary: result.summary, unused: result.unused ?? [] };
}

function library(kernel: Kernel) {
  const patterns = patternIndex(kernel);
  const categories = sectionCategories(patterns);
  const all = new Map(kernel.blocks.patternCategories().map((c) => [c.name, c.label]));
  const labels = new Map([...categories.keys()].map((name) => [name, all.get(name) ?? name]));
  return { patterns, categories, labels };
}

/** A prompt to one section, added to `page` at `index` (the end by default). */
export async function proposeSection(
  kernel: Kernel,
  user: CurrentUser,
  input: {
    prompt: string;
    page: number | string;
    pageTitle: string;
    index?: number;
    changeset_uuid?: string;
  },
): Promise<Proposal & { pattern: { name: string; title: string } }> {
  const brief = await getSiteBrief(kernel);
  const { patterns, categories, labels } = library(kernel);
  const names = [...categories.keys()];
  // The person's words first: a kind of section they name, else patterns they describe.
  let plan: SectionPlan | null = null;
  const named = namedCategory(input.prompt, labels);
  // Within a kind of section they name, the layouts their words describe come first
  // ("pricing with three tiers": the three-plan cards), then the kind's others.
  const found = searchPatterns(
    input.prompt,
    patterns,
    new Set(named ? (categories.get(named) ?? []) : [...categories.values()].flat()),
  );
  if (named) {
    const rest = (categories.get(named) ?? []).filter((name) => !found.includes(name));
    plan = { category: named, intent: input.prompt, patterns: [...found, ...rest] };
  } else if (found.length) {
    const first = patterns.get(found[0] as string);
    const category = first?.categories?.find((c) => categories.has(c)) ?? names[0] ?? '';
    plan = { category, intent: input.prompt, patterns: found };
  } else {
    plan = await ask<SectionPlan>(kernel, user, {
      task: 'Which kind of section does the site owner ask for? Answer with its kind and, in one sentence, what it says or does.',
      data: [labelled('site_owner_request', input.prompt)],
      schema: {
        type: 'object',
        properties: {
          category: categorySchema(names, labels),
          intent: { type: 'string', maxLength: 200 },
        },
        required: ['category', 'intent'],
        additionalProperties: false,
      },
      ability: SECTION_ABILITY,
      tier: 'fast',
      timeoutMs: TIMEOUT_MS.plan,
    });
  }
  const [section] = await fillSections(
    kernel,
    user,
    {
      brief,
      prompt: input.prompt,
      page: input.pageTitle,
      ability: SECTION_ABILITY,
      patterns,
      categories,
    },
    [plan],
  );
  const title = patterns.get(section?.pattern ?? '')?.title ?? labels.get(plan.category) ?? '';
  const proposal = await propose(kernel, user, {
    operations: [
      {
        type: 'insertSection',
        page: input.page,
        pattern: section?.pattern,
        slots: section?.slots,
        ...(input.index !== undefined ? { index: input.index } : {}),
      },
    ],
    summary: `Adds a section: ${title}.`,
    page: input.page,
    changeset_uuid: input.changeset_uuid,
  });
  return { ...proposal, pattern: { name: section?.pattern ?? '', title } };
}

/** A prompt to a new page made of sections (a draft page in the changeset, once kept). */
export async function proposePage(
  kernel: Kernel,
  user: CurrentUser,
  input: { prompt: string; changeset_uuid?: string },
): Promise<Proposal & { page: { title: string; slug: string } }> {
  const brief = await getSiteBrief(kernel);
  const { patterns, categories, labels } = library(kernel);
  const names = [...categories.keys()];
  const plan = await ask<{ title: string; sections: SectionPlan[] }>(kernel, user, {
    task: [
      'Plan the new page the site owner asks for: its title, and its sections in order.',
      `Between 2 and ${MAX_PAGE_SECTIONS} sections. Plan a section for facts the brief doesn’t give (prices, testimonials…) only when the page needs it: it will hold placeholders for the owner to fill.`,
    ].join('\n'),
    data: [labelled('site_brief', brief), labelled('site_owner_request', input.prompt)],
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 60 },
        sections: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_PAGE_SECTIONS,
          items: {
            type: 'object',
            properties: {
              category: categorySchema(names, labels),
              intent: { type: 'string', maxLength: 200 },
            },
            required: ['category', 'intent'],
            additionalProperties: false,
          },
        },
      },
      required: ['title', 'sections'],
      additionalProperties: false,
    },
    ability: PAGE_ABILITY,
    tier: 'default',
    timeoutMs: TIMEOUT_MS.plan,
    validate: (value) =>
      value.sections.some((s) => categories.has(s.category))
        ? null
        : 'The page has no section of a known kind.',
  });
  const title = plan.title.trim().slice(0, 60) || 'New page';
  const sections = await fillSections(
    kernel,
    user,
    { brief, prompt: input.prompt, page: title, ability: PAGE_ABILITY, patterns, categories },
    plan.sections.filter((s) => categories.has(s.category)).slice(0, MAX_PAGE_SECTIONS),
  );
  const proposal = await propose(kernel, user, {
    operations: [{ type: 'createPage', title, sections }],
    summary:
      sections.length === 1
        ? `Adds a new page, “${title}”, with one section.`
        : `Adds a new page, “${title}”, with ${sections.length} sections.`,
    changeset_uuid: input.changeset_uuid,
  });
  const created = proposal.operations.find((o) => o.type === 'createPage') as
    | { title: string; slug?: string }
    | undefined;
  return { ...proposal, page: { title, slug: created?.slug ?? '' } };
}
