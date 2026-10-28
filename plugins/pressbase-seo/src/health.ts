import type { PluginApi, SiteHealthTestResult } from '@pressbase/plugin-sdk';
import { escHtml } from './html';
import { getSite, getTitles, getWpseo } from './store';

/**
 * Site Health checks (`site_status_tests`): search engines discouraged, no
 * site representation, and whether the sitemap answers.
 */

export function registerSiteHealth(api: PluginApi): void {
  const { __ } = api.i18n;
  const badge = { label: __('Search'), color: 'blue' as const };
  const settings = (text: string) =>
    `<p><a href="/admin/settings/pressbase-seo">${escHtml(text)}</a></p>`;

  api.hooks.addFilter('site_status_tests', (tests) => {
    tests.direct.pressbase_seo_search_engines = {
      label: __('Search engines can index the site'),
      test: async (): Promise<SiteHealthTestResult> => {
        const site = await getSite(api);
        return site.public
          ? {
              test: 'pressbase_seo_search_engines',
              status: 'good',
              badge,
              label: __('Search engines can index the site'),
              description: `<p>${escHtml(__('Search engines are allowed to show the site in their results.'))}</p>`,
              actions: '',
            }
          : {
              test: 'pressbase_seo_search_engines',
              status: 'critical',
              badge,
              label: __('Search engines are discouraged from indexing the site'),
              description: `<p>${escHtml(__('Every page asks search engines not to index it, so the site won’t appear in search results. That’s right while you build the site, not once it’s live.'))}</p>`,
              actions: `<p><a href="/admin/settings/reading">${escHtml(__('Change it in Settings → Reading'))}</a></p>`,
            };
      },
    };
    tests.direct.pressbase_seo_representation = {
      label: __('The site says who it represents'),
      test: async (): Promise<SiteHealthTestResult> => {
        const titles = await getTitles(api);
        const set =
          titles.company_or_person === 'person'
            ? Number(titles.company_or_person_user_id) > 0
            : Boolean(String(titles.company_name ?? '').trim());
        return set
          ? {
              test: 'pressbase_seo_representation',
              status: 'good',
              badge,
              label: __('The site says who it represents'),
              description: `<p>${escHtml(__('Search engines can connect the site to an organisation or a person.'))}</p>`,
              actions: '',
            }
          : {
              test: 'pressbase_seo_representation',
              status: 'recommended',
              badge,
              label: __('The site doesn’t say who it represents'),
              description: `<p>${escHtml(__('Naming the organisation or person behind the site helps search engines show it correctly, for example in knowledge panels.'))}</p>`,
              actions: settings(__('Set the site representation')),
            };
      },
    };
    tests.direct.pressbase_seo_sitemap = {
      label: __('The XML sitemap is reachable'),
      test: async (): Promise<SiteHealthTestResult> => {
        const [site, wpseo] = await Promise.all([getSite(api), getWpseo(api)]);
        const fail = (message: string): SiteHealthTestResult => ({
          test: 'pressbase_seo_sitemap',
          status: 'recommended',
          badge,
          label: __('The XML sitemap isn’t reachable'),
          description: `<p>${escHtml(message)}</p>`,
          actions: settings(__('Check the crawling settings')),
        });
        if (!wpseo.enable_xml_sitemap) return fail(__('Sitemaps are turned off in Settings → SEO.'));
        if (!site.public) return fail(__('Sitemaps are off while search engines are discouraged.'));
        const url = `${site.home}/wp-sitemap.xml`;
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
          if (!res.ok) return fail(`${__('The sitemap answered with status')} ${res.status}.`);
        } catch {
          return fail(__('The sitemap couldn’t be fetched from the site’s own address.'));
        }
        return {
          test: 'pressbase_seo_sitemap',
          status: 'good',
          badge,
          label: __('The XML sitemap is reachable'),
          description: `<p>${escHtml(url)}</p>`,
          actions: '',
        };
      },
    };
    return tests;
  });
}
