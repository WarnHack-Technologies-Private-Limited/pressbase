/**
 * The recorded provider's answers for Studio's *Ask AI* (#63): quick edits
 * of a selection, and the plans for a prompted section or page. The
 * sections' slots are filled as the site builder's pages are (plain copy,
 * no facts), so honest content leaves placeholders where facts would go.
 *
 * - Rewrite (`rewritten`): each text changed by the action the task names:
 *   shortened to its first sentence (or half its words), expanded by a
 *   sentence, a tone's closing line, a translation (a few recorded French
 *   phrases, else the text marked with the language), spelling fixed from a
 *   short list, or a light rewording.
 * - A section's kind (`category`, `intent`): the kind whose name the request
 *   mentions, else the first.
 * - A page's plan (`title`, `sections`): the request's first words as its
 *   title, and the kinds of section it mentions (else the first two).
 */

type Json = Record<string, unknown>;
type Schema = {
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: unknown[];
  maxLength?: number;
};

const FRENCH: Record<string, string> = {
  'bread baked fresh every morning': 'Du pain frais, cuit chaque matin',
  'sourdough, pastries and good coffee for the neighbourhood.':
    'Du levain, des viennoiseries et du bon café pour le quartier.',
  'come in, say hello and take something warm home.':
    'Entrez, dites bonjour et repartez avec quelque chose de chaud.',
  'a small bakery with a big oven': 'Une petite boulangerie avec un grand four',
  'come and visit': 'Venez nous voir',
  'visit us': 'Rendez-nous visite',
  'our bakes': 'Nos pains',
};

const MISSPELLINGS: Record<string, string> = {
  evry: 'every',
  teh: 'the',
  recieve: 'receive',
  bakeing: 'baking',
  delicous: 'delicious',
  mornig: 'morning',
  neighbourood: 'neighbourhood',
  breakfst: 'breakfast',
};

const TONE_LINES: [RegExp, string][] = [
  [/friendlier/, 'We’d love to see you.'],
  [/formal/, 'We look forward to welcoming you.'],
  [/confident/, 'You won’t find better.'],
  [/simpler/, 'That’s it.'],
  [/playful/, 'Go on, treat yourself!'],
];

function action(task: string): string {
  if (/^Make each text shorter/m.test(task)) return 'shorten';
  if (/^Make each text a little longer/m.test(task)) return 'expand';
  if (/^Translate each text into/m.test(task)) return 'translate';
  if (/^Correct spelling/m.test(task)) return 'fix_spelling';
  if (/so it sounds/.test(task)) return 'tone';
  return 'rewrite';
}

const withStop = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);

function rewriteOne(text: string, task: string): string {
  switch (action(task)) {
    case 'shorten': {
      const sentence = text.match(/^.+?[.!?](?=\s|$)/)?.[0];
      if (sentence && sentence.length < text.length) return sentence;
      const words = text.split(/\s+/);
      return words.slice(0, Math.max(1, Math.ceil(words.length / 2))).join(' ');
    }
    case 'expand':
      return `${withStop(text)} Come in and see for yourself.`;
    case 'tone': {
      const line = TONE_LINES.find(([pattern]) => pattern.test(task))?.[1] ?? 'We’d love to see you.';
      return `${withStop(text)} ${line}`;
    }
    case 'translate': {
      const language = task.match(/Translate each text into ([^.]+)\./)?.[1]?.trim() ?? '';
      const french = /^(french|français|francais|fr)$/i.test(language)
        ? FRENCH[text.toLowerCase()]
        : undefined;
      return french ?? `${text} (${language})`;
    }
    case 'fix_spelling':
      return text.replace(/\p{L}+/gu, (word) => {
        const fixed = MISSPELLINGS[word.toLowerCase()];
        if (!fixed) return word;
        return word[0] === word[0]?.toUpperCase() ? fixed[0]?.toUpperCase() + fixed.slice(1) : fixed;
      });
    default: {
      const first = text.charAt(0).toLowerCase() + text.slice(1);
      return `Fresh from our kitchen: ${first}`;
    }
  }
}

/** The texts the request carries (`<texts>{ "t1": … }</texts>`). */
function textsOf(prompt: string): Record<string, string> {
  const match = prompt.match(/<texts>\n([\s\S]*?)\n<\/texts>/);
  if (!match) return {};
  try {
    return JSON.parse(match[1] as string) as Record<string, string>;
  } catch {
    return {};
  }
}

export function recordedRewrite(schema: Schema, prompt: string): Json {
  const texts = textsOf(prompt);
  const keys = Object.keys(schema.properties?.rewritten?.properties ?? {});
  const rewritten: Record<string, string> = {};
  for (const key of keys) {
    const max = Number(schema.properties?.rewritten?.properties?.[key]?.maxLength ?? 4000);
    const text = rewriteOne(String(texts[key] ?? ''), prompt) || 'Fresh bread';
    rewritten[key] = text.length > max ? text.slice(0, max).trim() : text;
  }
  return { rewritten };
}

/** The request the person typed (`<site_owner_request>"…"</site_owner_request>`). */
function requestOf(prompt: string): string {
  const match = prompt.match(/<site_owner_request>\n([\s\S]*?)\n<\/site_owner_request>/);
  try {
    return match ? String(JSON.parse(match[1] as string)) : '';
  } catch {
    return '';
  }
}

/** Kinds of section the request names, in the order it names them. */
function mentioned(request: string, kinds: string[]): string[] {
  const text = request.toLowerCase();
  return kinds
    .map((kind) => ({ kind, at: text.indexOf(kind.replace(/-/g, ' ').replace(/s$/, '')) }))
    .filter((k) => k.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((k) => k.kind);
}

export function recordedSectionPlan(schema: Schema, prompt: string): Json {
  const kinds = (schema.properties?.category?.enum as string[] | undefined) ?? [];
  const request = requestOf(prompt);
  const category = mentioned(request, kinds)[0] ?? kinds[0] ?? '';
  return { category, intent: request.slice(0, 200) || `A ${category} section.` };
}

export function recordedPagePlan(schema: Schema, prompt: string): Json {
  const kinds =
    (schema.properties?.sections?.items?.properties?.category?.enum as string[] | undefined) ?? [];
  const request = requestOf(prompt);
  const named = mentioned(request, kinds);
  const sections = (named.length ? named : kinds.slice(0, 2)).slice(0, 4);
  const words = (request.split(/\s+with\s+|,|:/i)[0] ?? '')
    .replace(/^(a|an|the)\s+/i, '')
    .replace(/\s+page$/i, '')
    .trim();
  const title = words ? words.charAt(0).toUpperCase() + words.slice(1) : 'New page';
  return {
    title: title.replace(/[^\p{L}\p{N} ]/gu, '').slice(0, 60) || 'New page',
    sections: sections.map((category) => ({ category, intent: `The ${category} section.` })),
  };
}
