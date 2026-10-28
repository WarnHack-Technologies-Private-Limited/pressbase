import { siteInfo } from '../blocks/helpers';
import type { Kernel } from '../kernel';
import { sitemapIndexUrl, sitemapsEnabled } from './sitemaps';

/**
 * /robots.txt — WordPress's do_robots() (wordpress/wp-includes/functions.php)
 * with WP_Sitemaps::add_robots(). The admin lives at /admin/ instead of
 * /wp-admin/, so that is what crawlers are asked to skip.
 *
 * A site that asks search engines not to index it (Settings → Reading, the
 * `blog_public` option) answers `Disallow: /`, as WordPress did before 5.3;
 * its pages also carry `noindex` (the robots meta tag and X-Robots-Tag).
 *
 * Hooks: `do_robotstxt` (action) before, `robots_txt` (filter: output, public) after.
 */
export async function renderRobots(kernel: Kernel): Promise<string> {
  await kernel.hooks.doAction('do_robotstxt');
  const site = await siteInfo(kernel);
  const isPublic = Boolean(await kernel.options.get('blog_public', true));
  const base = new URL(`${site.siteUrl || site.home}/`, 'http://pressbase.invalid').pathname;
  let output = 'User-agent: *\n';
  if (isPublic) {
    output += `Disallow: ${base}admin/\n`;
  } else {
    output += 'Disallow: /\n';
  }
  // WP_Sitemaps::add_robots() runs on robots_txt at priority 0.
  if (isPublic && (await sitemapsEnabled(kernel))) {
    output += `\nSitemap: ${sitemapIndexUrl(site)}\n`;
  }
  return String(await kernel.hooks.applyFilters('robots_txt', output, isPublic));
}
