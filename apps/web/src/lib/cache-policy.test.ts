import { describe, expect, it } from 'vitest';
import { bypassReason, cacheKey, cleanTags, notModified, ttlFor } from './cache-policy';

const req = (url: string, headers: Record<string, string> = {}, method = 'GET') => ({
  method,
  url,
  headers: new Headers(headers),
});

describe('bypassReason', () => {
  it('caches anonymous GET and HEAD requests', () => {
    expect(bypassReason(req('http://site.test/hello/'))).toBeUndefined();
    expect(bypassReason(req('http://site.test/feed/', {}, 'HEAD'))).toBeUndefined();
    expect(bypassReason(req('http://site.test/?s=tea'))).toBeUndefined();
  });

  it('never caches other methods', () => {
    expect(bypassReason(req('http://site.test/', {}, 'POST'))).toBe('method');
  });

  it('skips logged-in visitors, unlocked posts and commenters', () => {
    expect(bypassReason(req('http://site.test/', { cookie: 'pressbase_session=abc' }))).toBe(
      'cookie',
    );
    expect(bypassReason(req('http://site.test/', { cookie: '_ga=1; wp-postpass=hash' }))).toBe(
      'cookie',
    );
    expect(bypassReason(req('http://site.test/', { cookie: 'comment_author_abc=Ann' }))).toBe(
      'cookie',
    );
    expect(bypassReason(req('http://site.test/', { authorization: 'Basic x' }))).toBe(
      'authorization',
    );
  });

  it('ignores cookies that do not change the page', () => {
    expect(
      bypassReason(req('http://site.test/', { cookie: '_ga=GA1.1; theme=dark' })),
    ).toBeUndefined();
  });

  it('skips previews and held-comment previews', () => {
    expect(bypassReason(req('http://site.test/?p=5&preview=true'))).toBe('query');
    expect(bypassReason(req('http://site.test/hello/?unapproved=3&moderation-hash=x'))).toBe(
      'query',
    );
    expect(bypassReason(req('http://site.test/hello/?replytocom=3'))).toBe('query');
  });
});

describe('cacheKey', () => {
  it('is the path and query string', () => {
    expect(cacheKey('http://site.test/hello/?a=1')).toBe('/hello/?a=1');
    expect(cacheKey('http://other.test/')).toBe('/');
  });
});

describe('ttlFor', () => {
  it('keeps pages, briefly keeps redirects and 404s, and nothing else', () => {
    expect(ttlFor(200, {})).toEqual({ fresh: 3600, stale: 86_400 });
    expect(ttlFor(301, { 'cache-control': 'no-cache' })).toEqual({ fresh: 60, stale: 0 });
    expect(ttlFor(404, {})).toEqual({ fresh: 60, stale: 0 });
    expect(ttlFor(302, {})).toBeUndefined();
    expect(ttlFor(500, {})).toBeUndefined();
  });

  it('never keeps private or no-store answers', () => {
    expect(ttlFor(200, { 'Cache-Control': 'private, no-cache' })).toBeUndefined();
    expect(ttlFor(200, { 'cache-control': 'private, no-store' })).toBeUndefined();
  });
});

describe('notModified', () => {
  it('matches ETags, weak or strong, and Last-Modified', () => {
    const headers = { etag: 'W/"abc"', 'last-modified': 'Tue, 27 Oct 2026 10:00:00 GMT' };
    expect(notModified(new Headers({ 'if-none-match': 'W/"abc"' }), headers)).toBe(true);
    expect(notModified(new Headers({ 'if-none-match': '"x", "abc"' }), headers)).toBe(true);
    expect(notModified(new Headers({ 'if-none-match': '"other"' }), headers)).toBe(false);
    expect(
      notModified(new Headers({ 'if-modified-since': 'Tue, 27 Oct 2026 11:00:00 GMT' }), headers),
    ).toBe(true);
    expect(
      notModified(new Headers({ 'if-modified-since': 'Tue, 27 Oct 2026 09:00:00 GMT' }), headers),
    ).toBe(false);
    expect(notModified(new Headers(), headers)).toBe(false);
  });
});

describe('cleanTags', () => {
  it('keeps short printable strings only', () => {
    expect(cleanTags(['site', 'post:1', '', 'bad tag', 5, 'x'.repeat(300)])).toEqual([
      'site',
      'post:1',
    ]);
    expect(cleanTags('site')).toEqual([]);
  });
});
