import {
  FIXTURE_UPLOADS,
  memoryWordPressDatabase,
} from '@pressbase/core/src/import-export/wordpress-db-fixture';
import { migrateFromWordPressDatabase } from '@pressbase/core/src/import-export/wordpress-migrate';
import { describe, expect, it } from 'vitest';
import { graph, head, meta, render, site } from './helpers';

/**
 * A WordPress site with Yoast SEO, moved with the MySQL migration (ADR 0016),
 * keeps its search appearance with no conversion: the fixture's
 * `_yoast_wpseo_*` post meta and `wpseo_taxonomy_meta` render the <head>
 * Yoast would.
 */

describe('a migrated Yoast site', () => {
  it('renders the titles, descriptions, canonicals, robots and Open Graph it had', {
    timeout: 120_000,
  }, async () => {
    const ctx = await site();
    const result = await migrateFromWordPressDatabase(ctx.kernel, {
      database: memoryWordPressDatabase(),
      userId: 1,
      uploads: FIXTURE_UPLOADS,
    });
    expect(result.report?.errors.items).toEqual([]);

    const post = head((await render(ctx, '/hauling-out-for-winter/')).html);
    expect(post).toContain('<title>Hauling out for winter - Harbour Notes</title>');
    expect(post).toContain('<meta name="description" content="How we haul boats out for the winter." />');
    expect(post).toMatch(/<link rel="canonical" href="http:\/\/localhost:3000\/hauling-out-for-winter\/" \/>/);
    expect(post).toContain("<meta name='robots' content='index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1' />");
    expect(meta(post, 'property', 'og:title')).toBe('Hauling out for winter - Harbour Notes');
    expect(meta(post, 'property', 'og:description')).toBe('How we haul boats out for the winter.');
    expect(meta(post, 'property', 'og:type')).toBe('article');
    // The featured image came along with the media.
    expect(meta(post, 'property', 'og:image')).toMatch(/^http:\/\/localhost:3000\/.+\.(?:jpe?g|png)$/);
    // Yoast's primary category leads the breadcrumb trail.
    const crumbs = graph(post).find((n) => n['@type'] === 'BreadcrumbList') as {
      itemListElement: { name: string }[];
    };
    // Repairs sits under Boats.
    expect(crumbs.itemListElement.map((c) => c.name)).toEqual(['Home', 'Boats', 'Repairs', 'Hauling out for winter']);

    // wpseo_taxonomy_meta arrives as term meta.
    const category = head((await render(ctx, '/category/repairs/')).html);
    expect(category).toContain('<title>Repairs we do - Harbour Notes</title>');
    expect(category).toContain('<meta name="description" content="Hull, deck and engine repairs at the yard." />');

    // Rank Math's meta on the same site needs the one-time import.
    const before = head((await render(ctx, '/antifouling-a-gallery/')).html);
    expect(before).not.toContain('Antifouling, coat by coat.');
    const imported = await ctx.request('POST', '/pressbase-seo/v1/import/rankmath');
    expect(imported.body.posts).toBe(1);
    const after = head((await render(ctx, '/antifouling-a-gallery/')).html);
    expect(after).toContain('<meta name="description" content="Antifouling, coat by coat." />');
  });
});
