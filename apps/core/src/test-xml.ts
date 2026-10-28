import { expect } from 'vitest';

/**
 * A strict little XML well-formedness check for feed and sitemap tests:
 * balanced, properly nested elements; no stray `<` or `&`; only XML's five
 * named entities or numeric references outside CDATA; quoted attributes; no
 * characters XML 1.0 forbids. Returns the element names in document order.
 */
export function assertWellFormedXml(xml: string): string[] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: checking for forbidden characters.
  expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml), 'forbidden control character').toBe(
    false,
  );
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'XML declaration').toBe(true);
  const stack: string[] = [];
  const names: string[] = [];
  let roots = 0;
  const token =
    /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([A-Za-z_][\w:.-]*)\s*>|<([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|([^<]+)|(<)/g;
  for (const m of xml.matchAll(token)) {
    const [whole, close, open, attrs, selfClose, text, stray] = m;
    if (stray) throw new Error(`Stray "<" at ${m.index}: ${xml.slice(m.index, m.index + 40)}`);
    const checkEntities = (s: string) => {
      for (const e of s.matchAll(/&([^;\s]*);?/g)) {
        if (!/^&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);$/.test(e[0])) {
          throw new Error(
            `Invalid entity ${e[0]} near ${s.slice(Math.max(0, (e.index ?? 0) - 20), (e.index ?? 0) + 20)}`,
          );
        }
      }
    };
    if (text !== undefined) {
      if (stack.length === 0 && text.trim())
        throw new Error(`Text outside the root: ${text.slice(0, 40)}`);
      checkEntities(text);
    } else if (open) {
      checkEntities(attrs ?? '');
      if (stack.length === 0) roots++;
      names.push(open);
      if (!selfClose) stack.push(open);
    } else if (close) {
      const top = stack.pop();
      if (top !== close) throw new Error(`</${close}> closes <${top}>`);
    } else if (whole.startsWith('<![CDATA[') && stack.length === 0) {
      throw new Error('CDATA outside the root');
    }
  }
  expect(stack, 'unclosed elements').toEqual([]);
  expect(roots, 'one root element').toBe(1);
  return names;
}

/** The text of every `<name>` element (CDATA unwrapped). */
export function elementTexts(xml: string, name: string): string[] {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g');
  return [...xml.matchAll(re)].map((m) =>
    (m[1] ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim(),
  );
}
