import { describe, expect, it } from 'vitest';
import { type CachedPage, PageCache } from './page-cache';

const page = (body: string, tags: string[], status = 200): CachedPage => ({
  status,
  headers: { 'content-type': 'text/html' },
  body,
  tags,
});

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (s: number) => (now += s * 1000) };
}

describe('PageCache', () => {
  it('serves a stored page fresh, then stale, then forgets it', () => {
    const time = clock();
    const cache = new PageCache({ now: time.now });
    expect(
      cache.store('/a/', page('A', ['site', 'post:1']), {
        ttl: 10,
        stale: 20,
        generation: cache.generation(),
      }),
    ).toBe(true);
    expect(cache.lookup('/a/')).toMatchObject({ state: 'fresh', age: 0, page: { body: 'A' } });
    time.advance(15);
    expect(cache.lookup('/a/')).toMatchObject({ state: 'stale', age: 15 });
    time.advance(20);
    expect(cache.lookup('/a/')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('purges exactly the pages carrying a tag', () => {
    const cache = new PageCache();
    const g = cache.generation();
    cache.store('/hello/', page('hello', ['site', 'post:1', 'posts:post']), {
      ttl: 60,
      generation: g,
    });
    cache.store('/', page('home', ['site', 'home', 'post:1', 'post:2', 'posts:post']), {
      ttl: 60,
      generation: g,
    });
    cache.store('/about/', page('about', ['site', 'post:9', 'posts:page']), {
      ttl: 60,
      generation: g,
    });
    expect(cache.purge(['post:2'])).toBe(1);
    expect(cache.lookup('/')).toBeUndefined();
    expect(cache.lookup('/hello/')).toBeDefined();
    expect(cache.purge(['post:1', 'posts:post'])).toBe(1);
    expect(cache.lookup('/about/')).toBeDefined();
    expect(cache.purge(['unknown'])).toBe(0);
  });

  it('drops everything for `site`', () => {
    const cache = new PageCache();
    const g = cache.generation();
    cache.store('/a/', page('a', ['site', 'x']), { ttl: 60, generation: g });
    cache.store('/b/', page('b', ['site', 'y']), { ttl: 60, generation: g });
    expect(cache.purge(['site'])).toBe(2);
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  it('refuses a render that started before a purge', () => {
    const cache = new PageCache();
    const started = cache.generation();
    cache.purge(['post:1']);
    expect(cache.store('/hello/', page('old', ['post:1']), { ttl: 60, generation: started })).toBe(
      false,
    );
    expect(cache.lookup('/hello/')).toBeUndefined();
  });

  it('evicts the least recently used pages past its size, and skips huge ones', () => {
    const cache = new PageCache({ maxBytes: 1000 });
    const g = () => cache.generation();
    cache.store('/1', page('x'.repeat(100), ['t1']), { ttl: 60, generation: g() });
    cache.store('/2', page('x'.repeat(100), ['t2']), { ttl: 60, generation: g() });
    expect(cache.store('/big', page('x'.repeat(200), ['t']), { ttl: 60, generation: g() })).toBe(
      false,
    );
    for (let i = 3; i <= 12; i++) {
      cache.lookup('/1'); // keep /1 recently used
      cache.store(`/${i}`, page('x'.repeat(100), [`t${i}`]), { ttl: 60, generation: g() });
    }
    expect(cache.bytes).toBeLessThanOrEqual(1000);
    expect(cache.lookup('/1')).toBeDefined();
    expect(cache.lookup('/2')).toBeUndefined();
    // Evicted entries leave the tag index too.
    expect(cache.purge(['t2'])).toBe(0);
  });

  it('replaces an entry stored again under the same key', () => {
    const cache = new PageCache();
    cache.store('/a/', page('one', ['old']), { ttl: 60, generation: cache.generation() });
    cache.store('/a/', page('two', ['new']), { ttl: 60, generation: cache.generation() });
    expect(cache.purge(['old'])).toBe(0);
    expect(cache.lookup('/a/')?.page.body).toBe('two');
  });
});
