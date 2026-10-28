import type { BlockAttributes, ParsedBlock } from './types';

/**
 * parse_blocks() — a port of WP_Block_Parser
 * (wordpress/wp-includes/class-wp-block-parser.php). The output matches
 * WordPress's shape exactly: top-level HTML between blocks becomes freeform
 * blocks (`blockName: null`), void blocks have empty content, and each block's
 * `innerContent` holds `null` where its inner blocks sit.
 *
 * One deliberate difference: attributes whose JSON can't be decoded are `{}`
 * rather than PHP's `null`, so `attrs` is always an object.
 */

/**
 * The block delimiter tokenizer. PHP uses a possessive quantifier for the
 * attributes; JavaScript has none, so — like the official
 * @wordpress/block-serialization-default-parser — a lookahead plus a
 * backreference (`(?=(…))\5`) emulates it and avoids catastrophic backtracking.
 *
 * Groups: 1 closer, 2 namespace, 3 name, 4 attributes, 6 void.
 */
const TOKENIZER =
  /<!--\s+(\/)?wp:([a-z][a-z0-9_-]*\/)?([a-z][a-z0-9_-]*)\s+({(?:(?=([^}]+|}+(?=})|(?!}\s+\/?-->)[\s\S])*)\5|[\s\S]*?)}\s+)?(\/)?-->/g;

/**
 * A fresh copy of the block delimiter pattern (global, so use exec() in a
 * loop or String.replace). Groups as above. For tools that edit attributes
 * in place, like `pressbase search-replace`.
 */
export function blockDelimiterPattern(): RegExp {
  return new RegExp(TOKENIZER.source, 'g');
}

type Token =
  | { type: 'no-more-tokens' }
  | {
      type: 'void-block' | 'block-opener' | 'block-closer';
      name: string;
      attrs: BlockAttributes;
      start: number;
      length: number;
    };

/** WP_Block_Parser_Frame */
interface Frame {
  block: ParsedBlock;
  tokenStart: number;
  tokenLength: number;
  prevOffset: number;
  leadingHtmlStart: number | null;
}

function block(name: string | null, attrs: BlockAttributes, innerHTML = ''): ParsedBlock {
  return {
    blockName: name,
    attrs,
    innerBlocks: [],
    innerHTML,
    innerContent: innerHTML ? [innerHTML] : [],
  };
}

function freeform(html: string): ParsedBlock {
  return { blockName: null, attrs: {}, innerBlocks: [], innerHTML: html, innerContent: [html] };
}

function decodeAttrs(json: string | undefined): BlockAttributes {
  if (json === undefined) return {};
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as BlockAttributes)
      : {};
  } catch {
    return {};
  }
}

class Parser {
  #document = '';
  #offset = 0;
  #output: ParsedBlock[] = [];
  #stack: Frame[] = [];

  parse(document: string): ParsedBlock[] {
    this.#document = document;
    this.#offset = 0;
    this.#output = [];
    this.#stack = [];
    while (this.#proceed()) {
      // Keep going until the document is consumed.
    }
    return this.#output;
  }

  /** WP_Block_Parser::proceed() */
  #proceed(): boolean {
    const token = this.#nextToken();
    const depth = this.#stack.length;

    if (token.type === 'no-more-tokens') {
      if (depth === 0) {
        this.#addFreeform();
        return false;
      }
      // Unclosed blocks: assume implicit closers at the end of the document.
      while (this.#stack.length > 0) this.#addBlockFromStack();
      return false;
    }

    const { start, length } = token;
    // There may be HTML soup before the next block.
    const leadingHtmlStart = start > this.#offset ? this.#offset : null;

    switch (token.type) {
      case 'void-block': {
        // A void block at the top level is a complete block on its own.
        if (depth === 0) {
          if (leadingHtmlStart !== null) {
            this.#output.push(freeform(this.#document.slice(leadingHtmlStart, start)));
          }
          this.#output.push(block(token.name, token.attrs));
          this.#offset = start + length;
          return true;
        }
        this.#addInnerBlock(block(token.name, token.attrs), start, length);
        this.#offset = start + length;
        return true;
      }

      case 'block-opener':
        this.#stack.push({
          block: block(token.name, token.attrs),
          tokenStart: start,
          tokenLength: length,
          prevOffset: start + length,
          leadingHtmlStart,
        });
        this.#offset = start + length;
        return true;

      case 'block-closer': {
        // A closer with no opener is an error: everything left becomes freeform.
        if (depth === 0) {
          this.#addFreeform();
          return false;
        }
        if (depth === 1) {
          this.#addBlockFromStack(start);
          this.#offset = start + length;
          return true;
        }
        // Closing a nested block: add it to its parent.
        const top = this.#stack.pop() as Frame;
        const html = this.#document.slice(top.prevOffset, start);
        top.block.innerHTML += html;
        top.block.innerContent.push(html);
        top.prevOffset = start + length;
        this.#addInnerBlock(top.block, top.tokenStart, top.tokenLength, start + length);
        this.#offset = start + length;
        return true;
      }
    }
  }

  /** WP_Block_Parser::next_token() */
  #nextToken(): Token {
    TOKENIZER.lastIndex = this.#offset;
    const match = TOKENIZER.exec(this.#document);
    if (!match) return { type: 'no-more-tokens' };

    const [whole, closer, namespace, name, attrs, , isVoid] = match;
    const blockName = `${namespace ?? 'core/'}${name}`;
    const common = { name: blockName, start: match.index, length: whole.length };
    // Closers with attributes or a void marker are tolerated; the extras are ignored.
    if (isVoid) return { type: 'void-block', attrs: decodeAttrs(attrs), ...common };
    if (closer) return { type: 'block-closer', attrs: {}, ...common };
    return { type: 'block-opener', attrs: decodeAttrs(attrs), ...common };
  }

  /** WP_Block_Parser::add_freeform() */
  #addFreeform(): void {
    if (this.#offset >= this.#document.length) return;
    this.#output.push(freeform(this.#document.slice(this.#offset)));
  }

  /** WP_Block_Parser::add_inner_block() */
  #addInnerBlock(
    inner: ParsedBlock,
    tokenStart: number,
    tokenLength: number,
    lastOffset?: number,
  ): void {
    const parent = this.#stack[this.#stack.length - 1] as Frame;
    parent.block.innerBlocks.push(inner);
    const html = this.#document.slice(parent.prevOffset, tokenStart);
    if (html) {
      parent.block.innerHTML += html;
      parent.block.innerContent.push(html);
    }
    parent.block.innerContent.push(null);
    parent.prevOffset = lastOffset ?? tokenStart + tokenLength;
  }

  /** WP_Block_Parser::add_block_from_stack() */
  #addBlockFromStack(endOffset?: number): void {
    const top = this.#stack.pop() as Frame;
    const html =
      endOffset === undefined
        ? this.#document.slice(top.prevOffset)
        : this.#document.slice(top.prevOffset, endOffset);
    if (html) {
      top.block.innerHTML += html;
      top.block.innerContent.push(html);
    }
    if (top.leadingHtmlStart !== null) {
      this.#output.push(freeform(this.#document.slice(top.leadingHtmlStart, top.tokenStart)));
    }
    this.#output.push(top.block);
  }
}

/** parse_blocks(): the block tree of a post's content. */
export function parseBlocks(content: string): ParsedBlock[] {
  return new Parser().parse(content);
}

/** has_blocks(): whether the content contains block delimiters. */
export function hasBlocks(content: string): boolean {
  return content.includes('<!-- wp:');
}
