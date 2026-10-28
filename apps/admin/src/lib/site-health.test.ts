import { describe, expect, it } from 'vitest';
import {
  applySizes,
  countHeading,
  countResults,
  dashboardMessage,
  displayValue,
  overallStatus,
  type SiteInfo,
  type TestResult,
  unavailableResult,
} from './site-health';

const result = (status: TestResult['status']): TestResult => ({
  label: 'x',
  status,
  badge: { label: 'Security', color: 'blue' },
  description: '',
  actions: '',
  test: 'x',
});

describe('site health helpers', () => {
  it('rates the site as site-health.js does', () => {
    expect(overallStatus({ good: 20, recommended: 0, critical: 0 })).toEqual({
      score: 100,
      good: true,
    });
    expect(overallStatus({ good: 18, recommended: 4, critical: 0 })).toEqual({
      score: 90,
      good: true,
    });
    expect(overallStatus({ good: 30, recommended: 0, critical: 1 }).good).toBe(false);
    expect(overallStatus({ good: 2, recommended: 8, critical: 0 })).toEqual({
      score: 60,
      good: false,
    });
  });

  it('counts results and names the groups', () => {
    expect(
      countResults([result('good'), result('critical'), result('good'), result('recommended')]),
    ).toEqual({ good: 2, recommended: 1, critical: 1 });
    expect(countHeading('critical', 1)).toBe('1 critical issue');
    expect(countHeading('recommended', 3)).toBe('3 recommended improvements');
    expect(countHeading('good', 18)).toBe('18 items with no issues detected');
  });

  it('turns a failed request into “A test is unavailable”, escaped', () => {
    const issue = unavailableResult(
      { id: 'page_cache', label: 'Page <cache>', test: '/x', has_rest: true },
      'Boom',
    );
    expect(issue).toMatchObject({ status: 'recommended', label: 'A test is unavailable' });
    expect(issue.description).toBe('<p>Page &lt;cache&gt;</p><p>Boom</p>');
  });

  it('words the Dashboard message like wp_dashboard_site_health()', () => {
    expect(dashboardMessage({ good: 5, recommended: 0, critical: 0 })).toMatch(/^Great job!/);
    expect(dashboardMessage({ good: 5, recommended: 0, critical: 1 })).toMatch(/a critical issue/);
    expect(dashboardMessage({ good: 5, recommended: 1, critical: 0 })).toMatch(/one thing/);
  });

  it('fills in directory sizes in the sections and the copied text', () => {
    const data: SiteInfo = {
      info: {
        'wp-paths-sizes': {
          label: 'Directories and Sizes',
          fields: {
            uploads_size: {
              label: 'Uploads directory size',
              value: 'Loading…',
              debug: 'loading...',
            },
          },
        },
      },
      copy: '`\n### wp-paths-sizes ###\n\nuploads_size: loading...\n\n`',
    };
    const next = applySizes(data, {
      raw: 0,
      uploads_size: { size: '2 MB', debug: '2 MB (2097152 bytes)', raw: 2097152 },
    });
    expect(next.info['wp-paths-sizes']?.fields.uploads_size?.value).toBe('2 MB');
    expect(next.copy).toContain('uploads_size: 2 MB (2097152 bytes)');
  });

  it('shows values as text or name/value pairs', () => {
    expect(displayValue(true)).toBe('Yes');
    expect(displayValue(3)).toBe('3');
    expect(displayValue({ thumbnail: '150×150' })).toEqual([['thumbnail', '150×150']]);
  });
});
