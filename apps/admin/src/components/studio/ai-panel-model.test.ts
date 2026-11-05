import { describe, expect, it } from 'vitest';
import {
  type AiMessage,
  problemText,
  readEvents,
  requestsLeft,
  upsertMessage,
} from './ai-panel-model';

describe('readEvents()', () => {
  it('reads complete events and keeps the rest for the next chunk', () => {
    const first = readEvents('event: start\ndata: {"a":1}\n\nevent: text\ndata: {"text":"Hel');
    expect(first.events).toEqual([{ event: 'start', data: { a: 1 } }]);
    const second = readEvents(`${first.rest}lo"}\n\n: comment\n\n`);
    expect(second.events).toEqual([{ event: 'text', data: { text: 'Hello' } }]);
    expect(second.rest).toBe('');
  });

  it('joins data lines, reads CRLF and keeps plain text', () => {
    expect(readEvents('data: one\r\ndata: two\r\n\r\n').events).toEqual([
      { event: 'message', data: 'one\ntwo' },
    ]);
  });
});

describe('upsertMessage()', () => {
  const message = (id: string, text: string): AiMessage => ({
    id,
    role: 'assistant',
    text,
    at: '2026-11-05T10:00:00Z',
  });
  it('replaces by ID, or adds at the end', () => {
    const list = [message('a', 'one')];
    expect(upsertMessage(list, message('a', 'two'))).toEqual([message('a', 'two')]);
    expect(upsertMessage(list, message('b', 'three'))).toHaveLength(2);
    expect(list[0]?.text).toBe('one');
  });
});

describe('problemText()', () => {
  const __ = (text: string) => text;
  const sprintf = (format: string, ...args: (string | number)[]) => {
    let n = 0;
    return format.replace(/%(\d\$)?[sd]/g, (_m, pos?: string) =>
      String(args[pos ? Number(pos[0]) - 1 : n++]),
    );
  };
  it('says what’s wrong in plain words, counting sections from 1', () => {
    expect(problemText({ code: 'no_section', index: 4, count: 3 }, __, sprintf)).toBe(
      'The page has no section 5 (it has 3).',
    );
    expect(
      problemText({ code: 'invalid', message: 'There are no changes to make.' }, __, sprintf),
    ).toBe('There are no changes to make.');
    expect(problemText({ code: 'no_part', slug: 'footer' }, __, sprintf)).toMatch(/footer isn’t/);
  });
});

describe('requestsLeft()', () => {
  it('never goes below zero', () => {
    expect(requestsLeft({ daily_limit: 50, requests_today: 48 })).toBe(2);
    expect(requestsLeft({ daily_limit: 50, requests_today: 60 })).toBe(0);
  });
});
