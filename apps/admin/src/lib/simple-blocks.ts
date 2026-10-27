/**
 * The writing editor's format, until the block editor arrives in v0.3.
 *
 * Writers type plain text with a few Markdown-style shortcuts; it is saved as
 * the same block markup Gutenberg produces, so posts open cleanly in the block
 * editor later. Only content that converts back without loss is shown as
 * text — anything else (images, custom blocks, attributes) opens in code view.
 *
 *   Paragraphs ........ blank line between them; single line breaks are kept
 *   ## Heading ........ # to ###### (## is the default heading size)
 *   - item / 1. item .. bulleted and numbered lists
 *   > quote ........... a quote
 *   --- ............... a separator
 *   **bold** *italic* `code` [link](https://…)
 */

const esc = (text: string) =>
  text.replace(/&(?![a-zA-Z]+;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;').replace(/<(?=[\s\d=])/g, '&lt;');

const unesc = (html: string) =>
  html.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Inline Markdown → HTML. Existing inline HTML passes through. */
export function inlineToHtml(text: string): string {
  return esc(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:|\/)[^\s)]+)\)/g, '<a href="$2">$1</a>');
}

/** HTML → inline Markdown, for the tags inlineToHtml produces. */
export function inlineToText(html: string): string {
  return unesc(
    html
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<code>([^<]*)<\/code>/g, '`$1`')
      .replace(/<strong>([^<]*)<\/strong>/g, '**$1**')
      .replace(/<em>([^<]*)<\/em>/g, '*$1*')
      .replace(/<a href="([^"]+)">([^<]*)<\/a>/g, '[$2]($1)'),
  );
}

const para = (inner: string) => `<!-- wp:paragraph -->\n<p>${inner}</p>\n<!-- /wp:paragraph -->`;

export function textToBlocks(text: string): string {
  const chunks = text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((c) => c.replace(/^\n+|\s+$/g, ''))
    .filter(Boolean);

  return chunks
    .map((chunk) => {
      const lines = chunk.split('\n');
      const heading = /^(#{1,6})\s+(.+)$/.exec(chunk);
      if (heading && lines.length === 1) {
        const level = heading[1]?.length ?? 2;
        const attrs = level === 2 ? '' : ` {"level":${level}}`;
        return `<!-- wp:heading${attrs} -->\n<h${level} class="wp-block-heading">${inlineToHtml(heading[2] ?? '')}</h${level}>\n<!-- /wp:heading -->`;
      }
      if (chunk.trim() === '---') {
        return '<!-- wp:separator -->\n<hr class="wp-block-separator has-alpha-channel-opacity"/>\n<!-- /wp:separator -->';
      }
      if (lines.every((l) => /^[-*]\s+/.test(l)) || lines.every((l) => /^\d+[.)]\s+/.test(l))) {
        const ordered = /^\d/.test(lines[0] ?? '');
        const tag = ordered ? 'ol' : 'ul';
        const items = lines
          .map((l) => l.replace(/^([-*]|\d+[.)])\s+/, ''))
          .map((l) => `<!-- wp:list-item -->\n<li>${inlineToHtml(l)}</li>\n<!-- /wp:list-item -->`)
          .join('');
        return `<!-- wp:list${ordered ? ' {"ordered":true}' : ''} -->\n<${tag} class="wp-block-list">${items}</${tag}>\n<!-- /wp:list -->`;
      }
      if (lines.every((l) => /^>\s?/.test(l))) {
        const inner = lines.map((l) => l.replace(/^>\s?/, '')).join('\n');
        const paragraphs = inner
          .split(/\n[ \t]*\n/)
          .filter((p) => p.trim())
          .map((p) => para(inlineToHtml(p).replace(/\n/g, '<br>')))
          .join('');
        return `<!-- wp:quote -->\n<blockquote class="wp-block-quote">${paragraphs}</blockquote>\n<!-- /wp:quote -->`;
      }
      return para(inlineToHtml(chunk).replace(/\n/g, '<br>'));
    })
    .join('\n\n');
}

/* ------------------------------------------------------------------ parsing */

interface Block {
  name: string;
  attrs: string;
  /** HTML inside the block, with inner blocks left as their markup. */
  inner: string;
  children: Block[];
}

const DELIMITER =
  /<!--\s+(\/)?wp:((?:[a-z][a-z0-9_-]*\/)?[a-z][a-z0-9_-]*)\s+(\{(?:(?!-->)[\s\S])*?\}\s+)?(\/)?-->/g;

/** A small block parser; returns undefined for malformed nesting. */
function parse(content: string): { blocks: Block[]; freeform: string } | undefined {
  const root: Block = { name: '', attrs: '', inner: '', children: [] };
  const stack: { block: Block; start: number }[] = [{ block: root, start: 0 }];
  let freeform = '';
  let last = 0;
  DELIMITER.lastIndex = 0;
  for (let m = DELIMITER.exec(content); m; m = DELIMITER.exec(content)) {
    const [whole, closer, rawName = '', rawAttrs = '', selfClosing] = m;
    const name = rawName.replace(/^core\//, '');
    const top = stack[stack.length - 1];
    if (!top) return undefined;
    if (stack.length === 1) freeform += content.slice(last, m.index);
    if (closer) {
      if (top.block.name !== name || stack.length === 1) return undefined;
      top.block.inner = content.slice(top.start, m.index);
      stack.pop();
    } else {
      const block: Block = { name, attrs: rawAttrs.trim(), inner: '', children: [] };
      top.block.children.push(block);
      if (!selfClosing) stack.push({ block, start: m.index + whole.length });
    }
    last = m.index + whole.length;
  }
  if (stack.length !== 1) return undefined;
  freeform += content.slice(last);
  return { blocks: root.children, freeform };
}

const stripChildren = (html: string) => html.replace(DELIMITER, '');

function blockToText(block: Block): string | undefined {
  const inner = block.inner.trim();
  switch (block.name) {
    case 'paragraph': {
      if (block.attrs) return undefined;
      const m = /^<p>([\s\S]*)<\/p>$/.exec(inner);
      return m ? inlineToText(m[1] ?? '') : undefined;
    }
    case 'heading': {
      const level = block.attrs ? /^\{"level":([1-6])\}$/.exec(block.attrs)?.[1] : '2';
      if (!level) return undefined;
      const m = new RegExp(
        `^<h${level}(?: class="wp-block-heading")?>([\\s\\S]*)</h${level}>$`,
      ).exec(inner);
      return m ? `${'#'.repeat(Number(level))} ${inlineToText(m[1] ?? '')}` : undefined;
    }
    case 'separator':
      return block.attrs || !/^<hr[^>]*\/?>$/.test(inner) ? undefined : '---';
    case 'list': {
      if (block.attrs && block.attrs !== '{"ordered":true}') return undefined;
      const ordered = block.attrs !== '';
      const tag = ordered ? 'ol' : 'ul';
      if (
        !new RegExp(`^<${tag}(?: class="wp-block-list")?>[\\s\\S]*</${tag}>$`).test(
          stripChildren(inner).trim(),
        )
      ) {
        return undefined;
      }
      const items: string[] = [];
      for (const child of block.children) {
        const m =
          child.name === 'list-item' && !child.attrs
            ? /^<li>([\s\S]*)<\/li>$/.exec(child.inner.trim())
            : null;
        if (!m || /<(ul|ol)\b/.test(m[1] ?? '')) return undefined;
        items.push(`${ordered ? `${items.length + 1}.` : '-'} ${inlineToText(m[1] ?? '')}`);
      }
      return items.length ? items.join('\n') : undefined;
    }
    case 'quote': {
      // Nothing but paragraph blocks may sit inside the quote (no citation, no other markup).
      const shell = stripChildren(inner)
        .replace(/<p>[\s\S]*?<\/p>/g, '')
        .replace(/\s+/g, '');
      if (block.attrs || shell !== '<blockquoteclass="wp-block-quote"></blockquote>') {
        return undefined;
      }
      const parts = block.children.map(blockToText);
      if (
        !parts.length ||
        parts.some((p) => p === undefined) ||
        block.children.some((c) => c.name !== 'paragraph')
      ) {
        return undefined;
      }
      return (parts as string[])
        .map((p) =>
          p
            .split('\n')
            .map((l) => `> ${l}`.trimEnd())
            .join('\n'),
        )
        .join('\n>\n');
    }
    default:
      return undefined;
  }
}

/**
 * Block markup → writing-mode text, or undefined when the content can't be
 * shown as text without losing something (it then opens in code view).
 */
export function blocksToText(content: string): string | undefined {
  if (!content.trim()) return '';
  const parsed = parse(content);
  if (!parsed) return undefined;

  if (!parsed.blocks.length) {
    // Classic (pre-block) content: fine as text when it holds only paragraphs and inline tags.
    if (/<(?!\/?(p|br|strong|em|code|a)\b)[a-z]/i.test(content)) return undefined;
    return inlineToText(content.replace(/<\/?p>/g, '\n\n').replace(/\n{3,}/g, '\n\n')).trim();
  }
  if (parsed.freeform.trim()) return undefined;

  const parts: string[] = [];
  for (const block of parsed.blocks) {
    const text = blockToText(block);
    if (text === undefined) return undefined;
    parts.push(text);
  }
  return parts.join('\n\n');
}
