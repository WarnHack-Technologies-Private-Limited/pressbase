import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { PRESSBASE_VERSION } from '../version';
import { ADMIN_DOMAIN, CORE_DOMAIN } from './l10n';
import { exportPo, type PoEntry } from './translation-file';

/**
 * `pnpm i18n:extract`: writes the translation templates translators start
 * from, as `wp i18n make-pot` does for WordPress:
 *
 * - `languages/pressbase.pot`: core's strings (`apps/core/src`, domain `pressbase`);
 * - `languages/pressbase-admin.pot`: the admin's (`apps/admin/src`, domain
 *   `pressbase-admin`), including strings marked with `msgid('…')` in static data.
 *
 * Calls are read from the TypeScript syntax tree: `__`, `_x`, `_n`, `_nx`,
 * `esc_html__`, `esc_attr__`, `esc_html_x`, `esc_attr_x`, called directly
 * or as a method (`i18n.__()`), with string literals and the domain as the
 * last argument. A comment starting `translators:` before the call becomes a
 * note for translators. `--check` exits with an error when a template is out
 * of date (a test runs it). See docs/development/translating.md.
 */

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Function name → positions of [text, plural, context, domain] (-1: none). */
const FUNCTIONS: Record<string, [number, number, number, number]> = {
  __: [0, -1, -1, 1],
  esc_html__: [0, -1, -1, 1],
  esc_attr__: [0, -1, -1, 1],
  _x: [0, -1, 1, 2],
  esc_html_x: [0, -1, 1, 2],
  esc_attr_x: [0, -1, 1, 2],
  _n: [0, 1, -1, 3],
  _nx: [0, 1, 3, 4],
};

export interface ExtractTarget {
  domain: string;
  /** Folders to scan, relative to the repository. */
  dirs: string[];
  /** The template, relative to the repository. */
  pot: string;
  /** Also collect `msgid('…')` markers (static data translated where it's shown). */
  markers?: boolean;
}

export const TARGETS: ExtractTarget[] = [
  { domain: CORE_DOMAIN, dirs: ['apps/core/src'], pot: `languages/${CORE_DOMAIN}.pot` },
  {
    domain: ADMIN_DOMAIN,
    dirs: ['apps/admin/src'],
    pot: `languages/${ADMIN_DOMAIN}.pot`,
    markers: true,
  },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

function literal(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  // 'a' + 'b'
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literal(node.left);
    const right = literal(node.right);
    return left !== undefined && right !== undefined ? left + right : undefined;
  }
  if (ts.isParenthesizedExpression(node)) return literal(node.expression);
  return undefined;
}

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

/** A `translators:` comment just before the call or the statement or JSX holding it. */
function translatorsComment(node: ts.Node, source: ts.SourceFile): string | undefined {
  const text = source.getFullText();
  let current: ts.Node | undefined = node;
  for (let depth = 0; current && depth < 6; depth++) {
    for (const range of ts.getLeadingCommentRanges(text, current.getFullStart()) ?? []) {
      const comment = text
        .slice(range.pos, range.end)
        .replace(/^\/\*+|\*+\/$|^\/\//g, '')
        .split('\n')
        .map((line) => line.replace(/^\s*\*?\s?/, '').trim())
        .join(' ')
        .trim();
      if (/^translators:/i.test(comment)) return comment;
    }
    // A JSX comment, {/* translators: … */}, is the expression container before the node.
    const parent: ts.Node | undefined = current.parent;
    if (parent && (ts.isJsxElement(parent) || ts.isJsxFragment(parent))) {
      const children = [...parent.children];
      const index = children.indexOf(current as ts.JsxChild);
      for (let i = index - 1; i >= 0; i--) {
        const sibling = children[i] as ts.JsxChild;
        if (ts.isJsxText(sibling) && !sibling.text.trim()) continue;
        if (ts.isJsxExpression(sibling) && !sibling.expression) {
          const raw = text.slice(sibling.getStart(source) + 1, sibling.getEnd() - 1);
          const comment = raw.replace(/^\s*\/\*+|\*+\/\s*$/g, '').trim();
          if (/^translators:/i.test(comment)) return comment;
        }
        break;
      }
    }
    if (ts.isStatement(current) || ts.isJsxAttribute(current)) break;
    current = parent;
  }
  return undefined;
}

export function extractStrings(target: ExtractTarget, root = ROOT): PoEntry[] {
  const found = new Map<string, PoEntry & { order: number }>();
  let order = 0;
  for (const dir of target.dirs) {
    for (const file of sourceFiles(path.join(root, dir))) {
      const code = readFileSync(file, 'utf8');
      if (!/\b(?:__|_x|_n|_nx|esc_(?:html|attr)_[_x]|msgid)\s*\(/.test(code)) continue;
      const source = ts.createSourceFile(
        file,
        code,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const relative = path.relative(root, file).split(path.sep).join('/');
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          const name = calleeName(node);
          const args = node.arguments;
          let entry: PoEntry | undefined;
          if (name && Object.hasOwn(FUNCTIONS, name)) {
            const [text, plural, context, domain] = FUNCTIONS[name] as [
              number,
              number,
              number,
              number,
            ];
            const singular = literal(args[text]);
            if (singular && literal(args[domain]) === target.domain) {
              entry = {
                context: context >= 0 ? (literal(args[context]) ?? '') : '',
                singular,
                translations: [],
              };
              if (plural >= 0) {
                const pluralText = literal(args[plural]);
                if (pluralText === undefined) entry = undefined;
                else entry.plural = pluralText;
              }
            }
          } else if (name === 'msgid' && target.markers && ts.isIdentifier(node.expression)) {
            const singular = literal(args[0]);
            if (singular) entry = { context: literal(args[1]) ?? '', singular, translations: [] };
          }
          if (entry) {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            const key = `${entry.context}\u0004${entry.singular}`;
            const existing = found.get(key);
            const note = translatorsComment(node, source);
            if (existing) {
              existing.references = [...(existing.references ?? []), `${relative}:${line}`];
              if (note && !existing.extractedComments?.includes(note)) {
                existing.extractedComments = [existing.extractedComments, note]
                  .filter(Boolean)
                  .join('\n');
              }
              if (entry.plural && !existing.plural) existing.plural = entry.plural;
            } else {
              found.set(key, {
                ...entry,
                references: [`${relative}:${line}`],
                ...(note ? { extractedComments: note } : {}),
                order: order++,
              });
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return [...found.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...entry }) => ({
      ...entry,
      ...(/%(?:\d+\$)?[sd]/.test(entry.singular + (entry.plural ?? ''))
        ? { flags: ['js-format'] }
        : {}),
    }));
}

/** The template's text. No creation date, so it only changes when the strings do. */
export function potFor(target: ExtractTarget, root = ROOT): string {
  return exportPo(
    {
      'Project-Id-Version': `Pressbase ${PRESSBASE_VERSION}`,
      'Report-Msgid-Bugs-To':
        'https://github.com/WarnHack-Technologies-Private-Limited/pressbase/issues',
      'MIME-Version': '1.0',
      'Content-Type': 'text/plain; charset=UTF-8',
      'Content-Transfer-Encoding': '8bit',
      'Plural-Forms': 'nplurals=2; plural=(n != 1);',
      'X-Generator': 'pressbase i18n:extract',
      'X-Domain': target.domain,
    },
    extractStrings(target, root),
    `Translation template for Pressbase (${target.domain}).\nThis file is generated by \`pnpm i18n:extract\`: don't edit it by hand.\nThis file is distributed under the GPL-2.0-or-later license.`,
  );
}

/**
 * A template without its `#:` source references: what `--check` compares, so
 * moving code around doesn't make a template stale, only changing its strings.
 */
export function withoutReferences(pot: string): string {
  return pot
    .split('\n')
    .filter((line) => !line.startsWith('#:'))
    .join('\n');
}

/** Templates whose strings differ from the source's, relative to the repository. */
export function staleTemplates(root = ROOT): string[] {
  return TARGETS.filter((target) => {
    let current = '';
    try {
      current = readFileSync(path.join(root, target.pot), 'utf8');
    } catch {
      // Missing: stale.
    }
    return withoutReferences(current) !== withoutReferences(potFor(target, root));
  }).map((target) => target.pot);
}

function main(argv: string[]) {
  const check = argv.includes('--check');
  let stale = false;
  for (const target of TARGETS) {
    const file = path.join(ROOT, target.pot);
    const next = potFor(target);
    let current = '';
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      // A new template.
    }
    const count = extractStrings(target).length;
    if (current === next || (check && withoutReferences(current) === withoutReferences(next))) {
      console.log(`${target.pot}: up to date (${count} strings).`);
    } else if (check) {
      stale = true;
      console.error(`${target.pot} is out of date. Run \`pnpm i18n:extract\`.`);
    } else {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, next);
      console.log(`${target.pot}: written (${count} strings).`);
    }
  }
  if (stale) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
