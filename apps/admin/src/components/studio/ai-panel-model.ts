/**
 * Studio's AI panel (#62): the conversation as `/pressbase/v1/studio/ai`
 * keeps it, reading its Server-Sent Events, and what the panel says when a
 * set of changes can't be applied. Pure functions, tested in
 * ai-panel-model.test.ts. See docs/architecture/ai-edits.md.
 */

import type { EditOperation } from '@pressbase/site-edits';
import type { ApplyProblem } from './ai-edits-model';

export type Outcome = 'proposed' | 'kept' | 'undone';

/** A message in the conversation (core's ThreadMessage). */
export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: string;
  page?: { id: number | null; slug: string; title: string } | null;
  /** The changes proposed with the reply, checked against the site by core. */
  operations?: EditOperation[];
  summary?: string;
  /** The draft entry the set's style changes make, resolved by core. */
  styles?: { key: string; value: Record<string, unknown> };
  outcome?: Outcome;
  error?: { code: string; message: string };
}

/** GET /pressbase/v1/studio/ai. */
export interface AiStatus {
  supports_ai: boolean;
  can_manage_ai: boolean;
  daily_limit: number;
  requests_today: number;
  limit_reached: boolean;
  changeset_uuid: string | null;
  messages: AiMessage[];
}

export interface SseEvent {
  event: string;
  data: unknown;
}

/**
 * Reads complete events from a Server-Sent Events buffer; `rest` is the
 * start of the next one, to read with the following chunk.
 */
export function readEvents(buffer: string): { events: SseEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n?/g, '\n');
  const chunks = normalized.split('\n\n');
  const rest = chunks.pop() ?? '';
  const events: SseEvent[] = [];
  for (const chunk of chunks) {
    let event = 'message';
    const data: string[] = [];
    for (const line of chunk.split('\n')) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (!data.length) continue;
    const raw = data.join('\n');
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Plain text data stays a string.
    }
    events.push({ event, data: parsed });
  }
  return { events, rest };
}

/** Replaces a message by ID, or adds it at the end. */
export function upsertMessage(messages: readonly AiMessage[], message: AiMessage): AiMessage[] {
  const index = messages.findIndex((m) => m.id === message.id);
  if (index === -1) return [...messages, message];
  const next = [...messages];
  next[index] = message;
  return next;
}

type Translate = (text: string, domain: string) => string;
type Format = (format: string, ...args: (string | number)[]) => string;

/** What a problem with a set of changes means, for the person. */
export function problemText(problem: ApplyProblem, __: Translate, sprintf: Format): string {
  switch (problem.code) {
    case 'invalid':
      return problem.message;
    case 'no_section':
      return sprintf(
        __('The page has no section %1$d (it has %2$d).', 'pressbase-admin'),
        problem.index + 1,
        problem.count,
      );
    case 'no_block':
      return sprintf(
        __('Section %d doesn’t have the block these changes are for.', 'pressbase-admin'),
        problem.index + 1,
      );
    case 'no_pattern':
      return sprintf(
        __('There’s no section design called “%s” on this site.', 'pressbase-admin'),
        problem.pattern,
      );
    case 'no_slot':
      return sprintf(
        __('The section has no place for “%s”.', 'pressbase-admin'),
        problem.slot,
      );
    case 'no_page':
      return sprintf(__('There’s no page “%s”.', 'pressbase-admin'), problem.page);
    case 'no_part':
      return sprintf(
        __('The %s isn’t on this page. Open a page that shows it and ask again.', 'pressbase-admin'),
        problem.slug,
      );
    case 'no_menu':
      return __('The header has no menu to change.', 'pressbase-admin');
    case 'not_allowed':
      return problem.what === 'pages'
        ? __('Only people who can publish pages can add pages.', 'pressbase-admin')
        : __(
            'Only people who can change the site’s design can change its styles, header, footer and menu.',
            'pressbase-admin',
          );
  }
}

/** Requests the site has left today. */
export function requestsLeft(status: Pick<AiStatus, 'daily_limit' | 'requests_today'>): number {
  return Math.max(0, status.daily_limit - status.requests_today);
}
