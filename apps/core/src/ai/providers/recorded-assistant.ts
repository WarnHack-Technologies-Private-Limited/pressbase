import type { AiMessage, AiMessagePart, AiTextRequest } from '../types';

/**
 * The recorded provider's answers for Studio's AI panel (#62): a few
 * requests a site owner makes, each played through the tool loop as a
 * model would — read the site with an ability, propose the edits with
 * `core/propose-site-edits`, then say what changed. Abilities run for real,
 * so the proposal is checked against the site like any other.
 *
 * - "…buttons rounder…": reads the design system, proposes fully rounded
 *   buttons (setGlobalStyles with a preset reference).
 * - "…FAQ…" or "…questions…": finds a questions section in the patterns,
 *   proposes adding it at the end of the open page with a heading.
 * - "…tidy…": a set of several page operations (Studio's applier e2e,
 *   #57): reads the open page, then puts a call to action first, gives the
 *   section that was first a soft accent background and moves it to the end.
 * - anything else: proposes nothing and says what it can't do.
 */

const PROPOSE = 'wpab__core__propose-site-edits';
const ASKS = 'The site owner asks:';

type Call = Extract<AiMessagePart, { type: 'function_call' }>;
type Response = Extract<AiMessagePart, { type: 'function_response' }>;

export function isAssistantRequest(request: AiTextRequest): boolean {
  return Boolean(request.functionDeclarations?.some((f) => f.name === PROPOSE));
}

const textOf = (message: AiMessage | undefined) =>
  (message?.parts ?? []).flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');

function openPage(prompt: string): { id: number | null; slug: string } | null {
  const match = prompt.match(/<studio_context>\n([\s\S]*?)\n<\/studio_context>/);
  if (!match) return null;
  try {
    const context = JSON.parse(match[1] as string) as {
      open_page?: { id: number | null; slug: string };
    };
    return context.open_page ?? null;
  } catch {
    return null;
  }
}

export type AssistantAnswer = { call: Omit<Call, 'type' | 'id'> } | { text: string };

/** The next step of a recorded conversation: an ability call, or the reply. */
export function recordedAssistantStep(request: AiTextRequest): AssistantAnswer {
  const { messages } = request;
  // The request is the last person's message that asks something; what follows is this turn.
  let start = messages.length - 1;
  while (start > 0 && !textOf(messages[start]).includes(ASKS)) start--;
  const prompt = textOf(messages[start]);
  const asked = (prompt.split(ASKS)[1] ?? '').trim().toLowerCase();
  const turn = messages.slice(start + 1);
  const responses = turn.flatMap((m) =>
    m.parts.filter((p): p is Response => p.type === 'function_response'),
  );
  const last = responses[responses.length - 1];
  const page = openPage(prompt);
  const pageRef = page ? (page.id ?? page.slug) : undefined;

  const proposed = responses.find((r) => r.name === PROPOSE);
  if (proposed) {
    const answer = proposed.response as { error?: string; summary?: string };
    if (answer?.error) {
      return { text: `I couldn’t make that change: ${answer.error}` };
    }
    return { text: `Done. ${answer.summary ?? ''} Keep it if you like it, or undo it.`.trim() };
  }

  if (/round/.test(asked) && /button/.test(asked)) {
    if (!last) return { call: { name: 'wpab__core__get-design-system', args: {} } };
    return {
      call: {
        name: PROPOSE,
        args: {
          summary: 'Gives every button fully rounded corners.',
          operations: [
            {
              type: 'setGlobalStyles',
              styles: {
                elements: { button: { border: { radius: 'var:preset|border-radius|full' } } },
              },
            },
          ],
        },
      },
    };
  }

  if (/\bfaq\b|question/.test(asked)) {
    if (!last) {
      return { call: { name: 'wpab__core__list-patterns', args: { search: 'Questions' } } };
    }
    const listed = last.response as {
      patterns?: { name: string; slots: { id: string; kind: string }[] }[];
    };
    const pattern = listed.patterns?.[0];
    if (!pattern)
      return { text: 'I couldn’t find a questions section to add. Try the Sections panel.' };
    const heading = pattern.slots.find((s) => s.kind === 'heading');
    return {
      call: {
        name: PROPOSE,
        args: {
          summary: 'Adds a questions and answers section at the end of the page.',
          ...(pageRef !== undefined ? { page: pageRef } : {}),
          operations: [
            {
              type: 'insertSection',
              pattern: pattern.name,
              ...(heading ? { slots: { [heading.id]: 'Questions people ask' } } : {}),
            },
          ],
        },
      },
    };
  }

  if (/\btidy\b/.test(asked) && pageRef !== undefined) {
    if (!last) {
      return {
        call: {
          name: 'wpab__core__get-page-structure',
          args: typeof pageRef === 'number' ? { id: pageRef } : { slug: pageRef },
        },
      };
    }
    if (last.name === 'wpab__core__get-page-structure') {
      return { call: { name: 'wpab__core__list-patterns', args: { category: 'call-to-action' } } };
    }
    const listed = last.response as {
      patterns?: { name: string; slots: { id: string; kind: string }[] }[];
    };
    const pattern = listed.patterns?.[0];
    const structure = responses.find((r) => r.name === 'wpab__core__get-page-structure')
      ?.response as { sections?: unknown[] } | undefined;
    const count = structure?.sections?.length ?? 0;
    if (!pattern || count === 0) return { text: 'This page has nothing to tidy yet.' };
    const heading = pattern.slots.find((s) => s.kind === 'heading');
    return {
      call: {
        name: PROPOSE,
        args: {
          summary: 'Puts a call to action first and moves the old first section to the end.',
          page: pageRef,
          operations: [
            {
              type: 'updateBlockAttributes',
              index: 0,
              attributes: { backgroundColor: 'accent-soft' },
            },
            {
              type: 'insertSection',
              pattern: pattern.name,
              index: 0,
              ...(heading ? { slots: { [heading.id]: 'Come and say hello' } } : {}),
            },
            { type: 'moveSection', index: 1, to: count },
          ],
        },
      },
    };
  }

  return {
    text: 'I can’t do that from here. I can change your pages’ sections, text, colours, fonts, the header and footer, and the menu. Publishing stays with you: use Publish when you’re happy.',
  };
}
