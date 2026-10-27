/**
 * Pressbase's email template: one calm layout for every message core sends.
 * Each email is built from a few plain parts and rendered twice, as plain
 * text and as simple, inline-styled HTML that survives most mail clients.
 */

export interface EmailContent {
  siteName: string;
  /** Shown at the top of the HTML version; the plain-text version starts with it too. */
  heading: string;
  /** Paragraphs of plain text (escaped in the HTML version). */
  paragraphs: string[];
  /** One button, with the URL repeated as text for clients that hide buttons. */
  action?: { label: string; url: string };
  /** Small print after the action, e.g. "If you didn't ask for this, ignore this email." */
  footnote?: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderText(content: EmailContent): string {
  const lines = [content.heading, '', ...content.paragraphs.flatMap((p) => [p, ''])];
  if (content.action) lines.push(`${content.action.label}:`, content.action.url, '');
  if (content.footnote) lines.push(content.footnote, '');
  lines.push('—', content.siteName);
  return `${lines.join('\n')}\n`;
}

// Literal colours: mail clients don't support CSS variables. They match the
// admin's light tokens (docs/design/tokens.md).
const C = {
  canvas: '#f6f6f3',
  surface: '#ffffff',
  border: '#e2e2dc',
  text: '#1b1b19',
  muted: '#5c5c57',
  accent: '#3b4cca',
};
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function renderHtml(content: EmailContent): string {
  const site = escapeHtml(content.siteName);
  const paragraphs = content.paragraphs
    .map((p) => `<p style="margin:0 0 16px;line-height:1.55">${escapeHtml(p)}</p>`)
    .join('');
  const action = content.action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(content.action.url)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:${C.accent};color:#ffffff;font-weight:600;text-decoration:none">${escapeHtml(content.action.label)}</a></p>
<p style="margin:0 0 16px;font-size:13px;color:${C.muted};line-height:1.5">Or copy this link into your browser:<br><a href="${escapeHtml(content.action.url)}" style="color:${C.accent};word-break:break-all">${escapeHtml(content.action.url)}</a></p>`
    : '';
  const footnote = content.footnote
    ? `<p style="margin:16px 0 0;font-size:13px;color:${C.muted};line-height:1.5">${escapeHtml(content.footnote)}</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(content.heading)}</title></head>
<body style="margin:0;padding:0;background:${C.canvas};font-family:${FONT};color:${C.text};font-size:15px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.canvas}"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
<tr><td style="padding:0 4px 16px;font-size:14px;font-weight:600;color:${C.muted}">${site}</td></tr>
<tr><td style="background:${C.surface};border:1px solid ${C.border};border-radius:12px;padding:28px">
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;font-weight:600">${escapeHtml(content.heading)}</h1>
${paragraphs}${action}${footnote}
</td></tr>
<tr><td style="padding:16px 4px 0;font-size:12px;color:${C.muted}">Sent by ${site}, powered by Pressbase.</td></tr>
</table></td></tr></table>
</body></html>
`;
}
