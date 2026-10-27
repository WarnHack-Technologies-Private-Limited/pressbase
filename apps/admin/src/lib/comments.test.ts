import { describe, expect, it } from 'vitest';
import {
  avatarHue,
  bulkActions,
  commentPlainText,
  initials,
  statusMessage,
  tabCount,
  tabQuery,
} from './comments';

describe('comments helpers', () => {
  it('maps tabs to REST parameters', () => {
    expect(tabQuery('all', 3)).toEqual({ status: 'all' });
    expect(tabQuery('mine', 3)).toEqual({ status: 'all', author: '3' });
    expect(tabQuery('moderated', 3)).toEqual({ status: 'hold' });
    expect(tabQuery('approved', 3)).toEqual({ status: 'approve' });
  });

  it('reads tab counts', () => {
    const counts = { approved: 4, moderated: 2, spam: 1, trash: 0, all: 6, mine: 1 };
    expect(tabCount('moderated', counts)).toBe(2);
    expect(tabCount('all', counts)).toBe(6);
    expect(tabCount('all', null)).toBeUndefined();
  });

  it('makes initials and stable hues', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('  grace  ')).toBe('G');
    expect(initials('A Pressbase Commenter')).toBe('AC');
    expect(initials('<>')).toBe('?');
    expect(avatarHue('Ada')).toBe(avatarHue('ada'));
    expect(avatarHue('Ada')).toBeLessThan(360);
  });

  it('turns rendered comments into plain text', () => {
    expect(commentPlainText('<p>One<br />\ntwo &amp; three</p>\n<p>Four</p>')).toBe(
      'One \ntwo & three\n\nFour',
    );
  });

  it('words toasts and offers the right bulk actions', () => {
    expect(statusMessage('approve', 1)).toBe('Comment approved.');
    expect(statusMessage('trash', 3)).toBe('3 comments moved to the Trash.');
    expect(bulkActions('trash')).toEqual(['untrash', 'delete']);
    expect(bulkActions('moderated')).toContain('approve');
  });
});
