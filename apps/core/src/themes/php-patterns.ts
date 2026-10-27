import { escAttr, escHtml, escUrl } from '@pressbase/blocks';
import { sanitizePostContent } from '../content/sanitize';
import { PATTERN_HEADERS, readFileHeaders } from './file-headers';

/**
 * Block theme patterns are PHP files (`patterns/*.php`): a header comment,
 * then block markup with small PHP snippets for translation and URLs, e.g.
 *
 *   <h2><?php esc_html_e( 'Blog', 'twentytwentyfive' ); ?></h2>
 *   <img src="<?php echo esc_url( get_template_directory_uri() ); ?>/assets/a.webp" />
 *
 * Pressbase never runs PHP. This loader *interprets* the tiny subset of PHP
 * those snippets use and refuses everything else: the pattern is skipped
 * with a reason, never partially rendered.
 *
 * Supported:
 * - statements: `echo expr[, expr];`, and calls to the output functions
 *   below, separated by `;` (the last may end at `?>`);
 * - expressions: single- and double-quoted strings (double-quoted strings
 *   may not interpolate variables), `.` concatenation, calls to the
 *   functions below;
 * - comments: `//`, `#` and `/* … *\/`.
 *
 * Functions — translation is the identity until i18n arrives (v0.6):
 * - output: `_e`, `esc_html_e`, `esc_attr_e`, `printf`;
 * - values: `__`, `_x`, `esc_html__`, `esc_attr__`, `esc_html_x`,
 *   `esc_attr_x`, `esc_html`, `esc_attr`, `esc_url`, `wp_kses_post`,
 *   `sprintf`, `get_template_directory_uri`, `get_stylesheet_directory_uri`,
 *   `get_theme_file_uri`, `get_parent_theme_file_uri`.
 */

export interface PhpPatternContext {
  /** get_template_directory_uri(): the parent (or only) theme's URL. */
  templateUri: string;
  /** get_stylesheet_directory_uri(): the active (child) theme's URL. */
  stylesheetUri: string;
}

export interface LoadedPattern {
  slug: string;
  title: string;
  content: string;
  description?: string;
  categories?: string[];
  keywords?: string[];
  blockTypes?: string[];
  postTypes?: string[];
  templateTypes?: string[];
  viewportWidth?: number;
  inserter?: boolean;
}

export type PatternLoadResult =
  | { ok: true; pattern: LoadedPattern }
  | { ok: false; reason: string };

class PatternError extends Error {}

type Token =
  | { type: 'string'; value: string }
  | { type: 'ident'; value: string }
  | { type: 'punct'; value: '(' | ')' | ',' | '.' | ';' };

/** Splits a PHP code block into tokens; anything outside the subset throws. */
function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < code.length) {
    const ch = code[i] as string;
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      if (end === -1) throw new PatternError('unterminated comment');
      i = end + 2;
    } else if ((ch === '/' && code[i + 1] === '/') || ch === '#') {
      while (i < code.length && code[i] !== '\n') i++;
    } else if (ch === "'") {
      let value = '';
      i++;
      for (;;) {
        if (i >= code.length) throw new PatternError('unterminated string');
        const c = code[i] as string;
        if (c === '\\' && (code[i + 1] === "'" || code[i + 1] === '\\')) {
          value += code[i + 1];
          i += 2;
        } else if (c === "'") {
          i++;
          break;
        } else {
          value += c;
          i++;
        }
      }
      tokens.push({ type: 'string', value });
    } else if (ch === '"') {
      let value = '';
      i++;
      const escapes: Record<string, string> = {
        n: '\n',
        t: '\t',
        r: '\r',
        '\\': '\\',
        '"': '"',
        $: '$',
      };
      for (;;) {
        if (i >= code.length) throw new PatternError('unterminated string');
        const c = code[i] as string;
        if (
          c === '\\' &&
          code[i + 1] !== undefined &&
          escapes[code[i + 1] as string] !== undefined
        ) {
          value += escapes[code[i + 1] as string];
          i += 2;
        } else if (c === '$' || (c === '{' && code[i + 1] === '$')) {
          throw new PatternError('variable interpolation in a string');
        } else if (c === '"') {
          i++;
          break;
        } else {
          value += c;
          i++;
        }
      }
      tokens.push({ type: 'string', value });
    } else if (/[A-Za-z_]/.test(ch)) {
      let value = '';
      while (i < code.length && /[A-Za-z0-9_]/.test(code[i] as string)) value += code[i++];
      tokens.push({ type: 'ident', value });
    } else if ('(),.;'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch as '(' | ')' | ',' | '.' | ';' });
      i++;
    } else {
      throw new PatternError(`unsupported PHP syntax "${ch}"`);
    }
  }
  return tokens;
}

/** PHP's sprintf() for %s, %d, %% and numbered arguments (%1$s). */
export function phpSprintf(format: string, args: string[]): string {
  let next = 0;
  return format.replace(/%(?:(\d+)\$)?([sd%])/g, (_match, position: string | undefined, kind) => {
    if (kind === '%') return '%';
    const index = position ? Number(position) - 1 : next++;
    const value = args[index];
    if (value === undefined) throw new PatternError('too few arguments to sprintf');
    return kind === 'd' ? String(Number.parseInt(value, 10) || 0) : value;
  });
}

const VALUE_FUNCTIONS: Record<string, { min: number; max: number }> = {
  __: { min: 1, max: 2 },
  _x: { min: 2, max: 3 },
  esc_html__: { min: 1, max: 2 },
  esc_attr__: { min: 1, max: 2 },
  esc_html_x: { min: 2, max: 3 },
  esc_attr_x: { min: 2, max: 3 },
  esc_html: { min: 1, max: 1 },
  esc_attr: { min: 1, max: 1 },
  esc_url: { min: 1, max: 1 },
  wp_kses_post: { min: 1, max: 1 },
  sprintf: { min: 1, max: 20 },
  get_template_directory_uri: { min: 0, max: 0 },
  get_stylesheet_directory_uri: { min: 0, max: 0 },
  get_theme_file_uri: { min: 0, max: 1 },
  get_parent_theme_file_uri: { min: 0, max: 1 },
};

const OUTPUT_FUNCTIONS: Record<string, { min: number; max: number }> = {
  _e: { min: 1, max: 2 },
  esc_html_e: { min: 1, max: 2 },
  esc_attr_e: { min: 1, max: 2 },
  printf: { min: 1, max: 20 },
};

class Interpreter {
  #tokens: Token[] = [];
  #pos = 0;

  constructor(private readonly context: PhpPatternContext) {}

  /** Runs one `<?php … ?>` block and returns what it echoes. */
  run(code: string): string {
    this.#tokens = tokenize(code);
    this.#pos = 0;
    let output = '';
    while (this.#pos < this.#tokens.length) {
      if (this.#peekPunct(';')) {
        this.#pos++;
        continue;
      }
      const token = this.#tokens[this.#pos];
      if (token?.type === 'ident' && token.value === 'echo') {
        this.#pos++;
        output += this.#expression();
        while (this.#peekPunct(',')) {
          this.#pos++;
          output += this.#expression();
        }
      } else if (token?.type === 'ident' && OUTPUT_FUNCTIONS[token.value]) {
        this.#pos++;
        output += this.#call(
          token.value,
          OUTPUT_FUNCTIONS[token.value] as { min: number; max: number },
          true,
        );
      } else {
        throw new PatternError(
          token?.type === 'ident'
            ? `unsupported function or keyword "${token.value}"`
            : 'unsupported statement',
        );
      }
      if (this.#pos < this.#tokens.length && !this.#peekPunct(';')) {
        throw new PatternError('expected ";"');
      }
    }
    return output;
  }

  #peekPunct(value: string): boolean {
    const token = this.#tokens[this.#pos];
    return token?.type === 'punct' && token.value === value;
  }

  #expect(value: string): void {
    if (!this.#peekPunct(value)) throw new PatternError(`expected "${value}"`);
    this.#pos++;
  }

  #expression(): string {
    let value = this.#term();
    while (this.#peekPunct('.')) {
      this.#pos++;
      value += this.#term();
    }
    return value;
  }

  #term(): string {
    const token = this.#tokens[this.#pos++];
    if (!token) throw new PatternError('unexpected end of code');
    if (token.type === 'string') return token.value;
    if (token.type === 'ident' && VALUE_FUNCTIONS[token.value]) {
      return this.#call(
        token.value,
        VALUE_FUNCTIONS[token.value] as { min: number; max: number },
        false,
      );
    }
    if (token.type === 'punct' && token.value === '(') {
      const value = this.#expression();
      this.#expect(')');
      return value;
    }
    throw new PatternError(
      token.type === 'ident' ? `unsupported function "${token.value}"` : 'unsupported expression',
    );
  }

  #call(name: string, arity: { min: number; max: number }, output: boolean): string {
    this.#expect('(');
    const args: string[] = [];
    if (!this.#peekPunct(')')) {
      args.push(this.#expression());
      while (this.#peekPunct(',')) {
        this.#pos++;
        if (this.#peekPunct(')')) break; // PHP allows a trailing comma.
        args.push(this.#expression());
      }
    }
    this.#expect(')');
    if (args.length < arity.min || args.length > arity.max) {
      throw new PatternError(`wrong number of arguments to ${name}()`);
    }
    const [first = ''] = args;
    const { templateUri, stylesheetUri } = this.context;
    const themeFile = (base: string) => (first ? `${base}/${first.replace(/^\/+/, '')}` : base);
    switch (name) {
      case '__':
      case '_x':
      case '_e':
        return first;
      case 'esc_html__':
      case 'esc_html_x':
      case 'esc_html':
      case 'esc_html_e':
        return escHtml(first);
      case 'esc_attr__':
      case 'esc_attr_x':
      case 'esc_attr':
      case 'esc_attr_e':
        return escAttr(first);
      case 'esc_url':
        return escUrl(first);
      case 'wp_kses_post':
        return sanitizePostContent(first);
      case 'sprintf':
      case 'printf':
        return phpSprintf(first, args.slice(1));
      case 'get_template_directory_uri':
        return templateUri;
      case 'get_stylesheet_directory_uri':
        return stylesheetUri;
      case 'get_theme_file_uri':
        return themeFile(stylesheetUri);
      case 'get_parent_theme_file_uri':
        return themeFile(templateUri);
      default:
        throw new PatternError(`unsupported function "${name}"${output ? '' : ''}`);
    }
  }
}

/** Runs the file's PHP blocks and returns its output, as `ob_start(); include $file;` would. */
export function evaluatePatternFile(source: string, context: PhpPatternContext): string {
  const interpreter = new Interpreter(context);
  let output = '';
  let at = 0;
  while (at < source.length) {
    const open = source.indexOf('<?php', at);
    const shortEcho = source.indexOf('<?=', at);
    if (shortEcho !== -1 && (open === -1 || shortEcho < open)) {
      throw new PatternError('unsupported short echo tag "<?="');
    }
    if (open === -1) {
      output += source.slice(at);
      break;
    }
    output += source.slice(at, open);
    const close = source.indexOf('?>', open + 5);
    const code = source.slice(open + 5, close === -1 ? undefined : close);
    output += interpreter.run(code);
    if (close === -1) break;
    at = close + 2;
    // PHP swallows a single newline right after a closing tag.
    if (source.startsWith('\r\n', at)) at += 2;
    else if (source[at] === '\n') at += 1;
  }
  return output;
}

const list = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * _register_theme_block_patterns() for one file: reads the headers and
 * evaluates the content. Patterns without a title or slug are refused, as in
 * WordPress.
 */
export function loadPhpPattern(source: string, context: PhpPatternContext): PatternLoadResult {
  const headers = readFileHeaders(source, PATTERN_HEADERS);
  if (!headers.slug) return { ok: false, reason: 'the "Slug" header is missing' };
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(headers.slug)) {
    return { ok: false, reason: `the slug "${headers.slug}" is not "theme/name"` };
  }
  if (!headers.title) return { ok: false, reason: 'the "Title" header is missing' };
  let content: string;
  try {
    content = evaluatePatternFile(source, context);
  } catch (error) {
    if (error instanceof PatternError) return { ok: false, reason: error.message };
    throw error;
  }
  const pattern: LoadedPattern = {
    slug: headers.slug,
    title: headers.title,
    content: content.trim(),
  };
  if (headers.description) pattern.description = headers.description;
  for (const key of [
    'categories',
    'keywords',
    'blockTypes',
    'postTypes',
    'templateTypes',
  ] as const) {
    if (headers[key]) pattern[key] = list(headers[key]);
  }
  if (headers.viewportWidth && /^\d+$/.test(headers.viewportWidth)) {
    pattern.viewportWidth = Number(headers.viewportWidth);
  }
  if (headers.inserter)
    pattern.inserter = !['no', 'false'].includes(headers.inserter.toLowerCase());
  return { ok: true, pattern };
}
