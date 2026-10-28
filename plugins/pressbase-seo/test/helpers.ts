import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from '@pressbase/core/src/test-utils';
import { expect } from 'vitest';

/**
 * A fresh site (PGlite in memory) with Pressbase SEO installed from this
 * folder's build (`node build.mjs` runs before the tests) and activated, as
 * an administrator would: through the plugins REST API.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export type Ctx = Awaited<ReturnType<typeof site>>;

export async function site(options: { activate?: boolean } = {}) {
  const ctx = await setup();
  await ctx.install();
  const dir = path.join(ctx.dataDir, 'plugins', 'pressbase-seo');
  await mkdir(dir, { recursive: true });
  for (const entry of ['plugin.json', 'dist', 'migrations']) {
    await cp(path.join(root, entry), path.join(dir, entry), { recursive: true });
  }
  if (options.activate !== false) {
    const res = await ctx.request('POST', '/wp/v2/plugins/pressbase-seo', {
      status: 'active',
      permissions: ['database', 'options', 'network'],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  return ctx;
}

export function api(ctx: Ctx) {
  const runtime = ctx.kernel.plugins.runtime('pressbase-seo');
  if (!runtime) throw new Error('Pressbase SEO is not active.');
  return runtime.api;
}

export async function render(ctx: Ctx, link: string) {
  const url = link.replace(/^https?:\/\/[^/]+/, '');
  const res = await ctx.app.request(`/wp-json/pressbase/v1/render?url=${encodeURIComponent(url)}`);
  if (res.status !== 200) throw new Error(`render ${url}: ${res.status} ${await res.text()}`);
  return (await res.json()) as {
    status: number;
    headers: Record<string, string>;
    html: string;
    tags: string[];
  };
}

export async function publish(ctx: Ctx, body: Record<string, unknown>, type = 'posts') {
  const res = await ctx.request('POST', `/wp/v2/${type}`, { status: 'publish', ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: number; link: string; slug: string; meta: Record<string, unknown> };
}

/** The <head> of a rendered page. */
export function head(html: string): string {
  return /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? '';
}

/** The JSON-LD graph printed by Pressbase SEO. */
export function graph(html: string): Record<string, unknown>[] {
  const json =
    /<script type="application\/ld\+json" class="pressbase-seo-schema">([\s\S]*?)<\/script>/.exec(
      html,
    )?.[1];
  return json ? (JSON.parse(json)['@graph'] as Record<string, unknown>[]) : [];
}

export function meta(html: string, attr: 'name' | 'property', key: string): string | undefined {
  const re = new RegExp(`<meta ${attr}="${key.replace(/[:]/g, '\\:')}" content="([^"]*)"`);
  return re.exec(html)?.[1];
}
