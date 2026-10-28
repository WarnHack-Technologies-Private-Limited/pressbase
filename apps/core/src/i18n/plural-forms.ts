/**
 * Gettext plural forms — a port of WordPress's Plural_Forms
 * (wordpress/wp-includes/pomo/plural-forms.php) and of
 * WP_Translation_File::get_plural_expression_from_header()
 * (wp-includes/l10n/class-wp-translation-file.php).
 *
 * A `Plural-Forms` header such as `nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : …);`
 * is a C expression. It is parsed into postfix with the shunting-yard
 * algorithm and evaluated with a stack: never with `eval`, so a translation
 * file can't run code.
 */

const OP_CHARS = '|&><!=%?:';

const PRECEDENCE: Record<string, number> = {
  '%': 6,
  '<': 5,
  '<=': 5,
  '>': 5,
  '>=': 5,
  '==': 4,
  '!=': 4,
  '&&': 3,
  '||': 2,
  '?:': 1,
  '?': 1,
  '(': 0,
  ')': 0,
};

type Token = { type: 'var' } | { type: 'value'; value: number } | { type: 'op'; op: string };

export class PluralFormsError extends Error {}

function span(str: string, chars: string, from: number): number {
  let end = from;
  while (end < str.length && chars.includes(str[end] as string)) end++;
  return end - from;
}

function parse(str: string): Token[] {
  const output: Token[] = [];
  const stack: string[] = [];
  let pos = 0;
  while (pos < str.length) {
    const next = str[pos] as string;
    switch (next) {
      case ' ':
      case '\t':
        pos++;
        break;
      case 'n':
        output.push({ type: 'var' });
        pos++;
        break;
      case '(':
        stack.push(next);
        pos++;
        break;
      case ')': {
        let found = false;
        while (stack.length) {
          const o2 = stack[stack.length - 1] as string;
          if (o2 !== '(') {
            output.push({ type: 'op', op: stack.pop() as string });
            continue;
          }
          stack.pop();
          found = true;
          break;
        }
        if (!found) throw new PluralFormsError('Mismatched parentheses');
        pos++;
        break;
      }
      case '|':
      case '&':
      case '>':
      case '<':
      case '!':
      case '=':
      case '%':
      case '?': {
        const length = span(str, OP_CHARS, pos);
        const operator = str.slice(pos, pos + length);
        if (!(operator in PRECEDENCE)) {
          throw new PluralFormsError(`Unknown operator "${operator}"`);
        }
        while (stack.length) {
          const o2 = stack[stack.length - 1] as string;
          // The ternary is right-associative, as in C.
          if (operator === '?:' || operator === '?') {
            if ((PRECEDENCE[operator] as number) >= (PRECEDENCE[o2] as number)) break;
          } else if ((PRECEDENCE[operator] as number) > (PRECEDENCE[o2] as number)) {
            break;
          }
          output.push({ type: 'op', op: stack.pop() as string });
        }
        stack.push(operator);
        pos += length;
        break;
      }
      case ':': {
        // The ternary's "else": turn the matching "?" into "?:".
        let found = false;
        let s = stack.length - 1;
        while (s >= 0) {
          if (stack[s] !== '?') {
            output.push({ type: 'op', op: stack.pop() as string });
            s--;
            continue;
          }
          stack[s] = '?:';
          found = true;
          break;
        }
        if (!found) throw new PluralFormsError('Missing starting "?" ternary operator');
        pos++;
        break;
      }
      default: {
        if (next >= '0' && next <= '9') {
          const length = span(str, '0123456789', pos);
          output.push({ type: 'value', value: Number.parseInt(str.slice(pos, pos + length), 10) });
          pos += length;
          break;
        }
        throw new PluralFormsError(`Unknown symbol "${next}"`);
      }
    }
  }
  while (stack.length) {
    const o2 = stack.pop() as string;
    if (o2 === '(' || o2 === ')') throw new PluralFormsError('Mismatched parentheses');
    output.push({ type: 'op', op: o2 });
  }
  return output;
}

/** A compiled plural expression: `get(n)` is the index of the plural form for n. */
export class PluralForms {
  readonly #tokens: Token[];
  readonly #cache = new Map<number, number>();

  /** Throws PluralFormsError when the expression is invalid. */
  constructor(expression: string) {
    this.#tokens = parse(expression);
    // Evaluate once, so a malformed expression fails here and not on first use.
    this.get(1);
  }

  get(n: number): number {
    const cached = this.#cache.get(n);
    if (cached !== undefined) return cached;
    const value = this.#execute(n);
    this.#cache.set(n, value);
    return value;
  }

  #execute(n: number): number {
    // Booleans are kept as 0/1, so `==` compares numbers as PHP's `===` does on ints.
    const stack: number[] = [];
    const pop = () => {
      const value = stack.pop();
      if (value === undefined) throw new PluralFormsError('Too few values on the stack');
      return value;
    };
    for (const token of this.#tokens) {
      if (token.type === 'var') {
        stack.push(n);
        continue;
      }
      if (token.type === 'value') {
        stack.push(token.value);
        continue;
      }
      if (token.op === '?:') {
        const v3 = pop();
        const v2 = pop();
        const v1 = pop();
        stack.push(v1 ? v2 : v3);
        continue;
      }
      const v2 = pop();
      const v1 = pop();
      switch (token.op) {
        case '%':
          // PHP's % on integers: an integer division by zero throws there; give 0 here.
          stack.push(v2 === 0 ? 0 : Math.trunc(v1) % Math.trunc(v2));
          break;
        case '||':
          stack.push(v1 || v2 ? 1 : 0);
          break;
        case '&&':
          stack.push(v1 && v2 ? 1 : 0);
          break;
        case '<':
          stack.push(v1 < v2 ? 1 : 0);
          break;
        case '<=':
          stack.push(v1 <= v2 ? 1 : 0);
          break;
        case '>':
          stack.push(v1 > v2 ? 1 : 0);
          break;
        case '>=':
          stack.push(v1 >= v2 ? 1 : 0);
          break;
        case '!=':
          stack.push(v1 !== v2 ? 1 : 0);
          break;
        case '==':
          stack.push(v1 === v2 ? 1 : 0);
          break;
        default:
          throw new PluralFormsError(`Unknown operator "${token.op}"`);
      }
    }
    if (stack.length !== 1) throw new PluralFormsError('Too many values remaining on the stack');
    return Math.trunc(stack[0] as number);
  }
}

/** English: only 1 is singular. */
export const ENGLISH_PLURAL = (n: number): number => (n === 1 ? 0 : 1);

/**
 * The plural expression of a `Plural-Forms` header
 * (WP_Translation_File::get_plural_expression_from_header()).
 */
export function pluralExpressionFromHeader(header: string): string {
  const match = /^\s*nplurals\s*=\s*(\d+)\s*;\s+plural\s*=\s*(.+)$/.exec(header);
  return match ? (match[2] as string).trim() : 'n != 1';
}

/**
 * A plural function for a `Plural-Forms` header, falling back to English's
 * rule when the header is missing or invalid
 * (WP_Translation_File::make_plural_form_function()).
 */
export function pluralFunction(header: string | undefined): (n: number) => number {
  if (!header) return ENGLISH_PLURAL;
  try {
    const forms = new PluralForms(pluralExpressionFromHeader(header).replace(/;+\s*$/, ''));
    return (n) => forms.get(n);
  } catch {
    return ENGLISH_PLURAL;
  }
}
