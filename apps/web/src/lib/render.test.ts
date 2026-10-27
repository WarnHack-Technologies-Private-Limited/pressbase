import { describe, expect, it } from 'vitest';
import { pickHeaders, renderEndpoint, responseFromCore, toResponse } from './render';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('renderEndpoint', () => {
  it('passes the path and query string to core, encoded', () => {
    expect(
      renderEndpoint('http://core:4000/', 'http://site.test/2026/10/27/hello/?s=a b&x=1'),
    ).toBe(
      `http://core:4000/wp-json/pressbase/v1/render?url=${encodeURIComponent('/2026/10/27/hello/?s=a%20b&x=1')}`,
    );
  });

  it('renders the home page for the root', () => {
    expect(renderEndpoint('http://core:4000', 'http://site.test/')).toBe(
      'http://core:4000/wp-json/pressbase/v1/render?url=%2F',
    );
  });
});

describe('pickHeaders', () => {
  it('keeps only safe headers and adds nosniff', () => {
    const headers = pickHeaders({
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'public, max-age=0',
      'Set-Cookie': 'evil=1',
      'X-Powered-By': 'PHP',
      Location: '/somewhere/',
    });
    expect(headers.get('content-type')).toBe('text/html; charset=UTF-8');
    expect(headers.get('cache-control')).toBe('public, max-age=0');
    expect(headers.get('location')).toBe('/somewhere/');
    expect(headers.get('set-cookie')).toBeNull();
    expect(headers.get('x-powered-by')).toBeNull();
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('defaults to HTML', () => {
    expect(pickHeaders({}).get('content-type')).toBe('text/html; charset=utf-8');
  });
});

describe('toResponse', () => {
  it('sends the status and HTML', async () => {
    const res = toResponse({ status: 404, headers: {}, html: '<p>Not found</p>' });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('<p>Not found</p>');
  });

  it('drops the body for 304 and HEAD', async () => {
    expect(await toResponse({ status: 304, headers: {}, html: 'x' }).text()).toBe('');
    expect(await toResponse({ status: 200, headers: {}, html: 'x' }, 'HEAD').text()).toBe('');
  });
});

describe('responseFromCore', () => {
  const options = { method: 'GET', adminUrl: 'http://admin.test/' };

  it('passes redirects through', async () => {
    const res = await responseFromCore(
      json({ status: 301, headers: { location: 'http://site.test/hello/' }, html: '' }),
      options,
    );
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('http://site.test/hello/');
  });

  it('sends visitors of an uninstalled site to the installer', async () => {
    const res = await responseFromCore(json({ code: 'pressbase_not_installed' }, 503), options);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://admin.test/install');
  });

  it('shows a 502 page when core cannot render', async () => {
    const res = await responseFromCore(json({ code: 'rest_no_route' }, 404), options);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('couldn’t render this page');
  });
});
