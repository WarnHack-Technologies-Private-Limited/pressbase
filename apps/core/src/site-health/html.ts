import sanitizeHtml from 'sanitize-html';
import type { SiteHealthTestResult } from './types';

/** esc_html() for values put into a test's description. */
export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** `<p>…</p>` around each paragraph. */
export function paragraphs(...items: (string | false | undefined)[]): string {
  return items
    .filter(Boolean)
    .map((p) => `<p>${p}</p>`)
    .join('');
}

/** An action: a link in a paragraph, opening in a new tab when it leaves the admin. */
export function actionLink(href: string, text: string): string {
  const external = /^https?:\/\//.test(href);
  return `<p><a href="${esc(href)}"${external ? ' target="_blank" rel="noopener"' : ''}>${esc(text)}${
    external ? '<span class="visually-hidden"> (opens in a new tab)</span>' : ''
  }</a></p>`;
}

/**
 * The HTML a description or action may use: a few block and inline tags and
 * links. Descriptions come from core and plugins and are shown as HTML in the
 * admin, so everything else is removed (WordPress escapes with wp_kses_post()
 * in the same place).
 */
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'a', 'code', 'strong', 'em', 'ul', 'ol', 'li', 'br', 'span'],
  allowedAttributes: { a: ['href', 'target', 'rel'], span: ['class'] },
  allowedClasses: { span: ['visually-hidden'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
};

export function ksesSiteHealth(html: string): string {
  return sanitizeHtml(html, OPTIONS);
}

/** The result as the REST API returns it: known fields only, HTML sanitised. */
export function prepareResult(result: SiteHealthTestResult): SiteHealthTestResult {
  return {
    label: String(result.label),
    status: result.status,
    badge: { label: String(result.badge?.label ?? ''), color: result.badge?.color ?? 'blue' },
    description: ksesSiteHealth(String(result.description ?? '')),
    actions: ksesSiteHealth(String(result.actions ?? '')),
    test: String(result.test),
  };
}

/** validateIssueData() in site-health.js: test, label and description must be strings. */
export function isValidResult(value: unknown): value is SiteHealthTestResult {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.test === 'string' &&
    typeof r.label === 'string' &&
    typeof r.description === 'string' &&
    (r.status === 'good' || r.status === 'recommended' || r.status === 'critical')
  );
}

/** 1.5 MB, 320 KB: size_format(). */
export function sizeFormat(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
