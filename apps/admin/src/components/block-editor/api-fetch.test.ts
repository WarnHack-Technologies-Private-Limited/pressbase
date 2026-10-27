import apiFetch, { type APIFetchOptions } from '@wordpress/api-fetch';
import { beforeAll, describe, expect, it } from 'vitest';
import { configureApiFetch, pressbaseMiddleware, withRealMethods } from './api-fetch';

describe('api-fetch configuration', () => {
  const seen: APIFetchOptions[] = [];

  beforeAll(() => {
    configureApiFetch(apiFetch);
    configureApiFetch(apiFetch); // idempotent: middlewares are added once
    // Record what would reach fetch(), after every middleware has run.
    apiFetch.setFetchHandler(
      withRealMethods(async (options) => {
        seen.push(options);
        return { ok: true };
      }),
    );
  });

  it('sends requests to /wp-json/ with the CSRF header, same-origin', async () => {
    await apiFetch({ path: '/wp/v2/block-types?context=edit' });
    const options = seen.at(-1);
    expect(options?.url).toMatch(/^\/wp-json\/wp\/v2\/block-types\?context=edit/);
    expect(options?.headers?.['x-pressbase-request']).toBe('1');
    expect(options?.credentials).toBe('same-origin');
  });

  it('keeps PUT, PATCH and DELETE as real methods', async () => {
    await apiFetch({ path: '/wp/v2/blocks/7', method: 'PUT', data: { title: 'x' } });
    expect(seen.at(-1)?.method).toBe('PUT');
    expect(seen.at(-1)?.headers?.['X-HTTP-Method-Override']).toBeUndefined();
    await apiFetch({ path: '/wp/v2/blocks/7', method: 'DELETE' });
    expect(seen.at(-1)?.method).toBe('DELETE');
  });

  it('leaves plain POSTs alone', async () => {
    await apiFetch({ path: '/wp/v2/media', method: 'POST', data: {} });
    expect(seen.at(-1)?.method).toBe('POST');
  });
});

describe('pressbaseMiddleware', () => {
  it('adds the header without dropping existing ones', async () => {
    let passed: APIFetchOptions | undefined;
    await pressbaseMiddleware({ path: '/x', headers: { Accept: 'application/json' } }, (o) => {
      passed = o;
      return Promise.resolve();
    });
    expect(passed?.headers).toEqual({ Accept: 'application/json', 'x-pressbase-request': '1' });
  });
});
