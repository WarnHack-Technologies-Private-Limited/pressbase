/**
 * The small part of semantic versioning plugin manifests need: is a version
 * valid, is a range valid, and does a version satisfy a range. It covers the
 * npm range syntax people actually write (`^0.5.0`, `~1.2`, `>=0.5 <2`,
 * `1.x`, `1.0.0 - 2.0.0`, `*`, alternatives joined with `||`). Pre-release
 * tags compare lower than the release, as in semver; build metadata is ignored.
 *
 * WordPress compares "Requires at least" with version_compare()
 * (is_wp_version_compatible()); Pressbase uses ranges, like package.json.
 */

type Triple = [number, number, number];

interface Version {
  parts: Triple;
  pre: string[];
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
/** A version in a range: parts may be missing or wildcards (1, 1.2, 1.x, *). */
const PARTIAL =
  /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(value: string): Version | null {
  const m = VERSION.exec(value.trim());
  if (!m) return null;
  return {
    parts: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.') : [],
  };
}

export function isValidVersion(value: string): boolean {
  return parseVersion(value) !== null;
}

function comparePre(a: string[], b: string[]): number {
  if (!a.length || !b.length) return a.length ? -1 : b.length ? 1 : 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn) return -1;
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const d = (a.parts[i] ?? 0) - (b.parts[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  const p = comparePre(a.pre, b.pre);
  return p < 0 ? -1 : p > 0 ? 1 : 0;
}

type Op = '<' | '<=' | '>' | '>=' | '=';
interface Comparator {
  op: Op;
  version: Version;
}

interface PartialVersion {
  /** Numbers given, before the first wildcard or missing part. */
  given: number[];
  pre: string[];
}

function parsePartial(value: string): PartialVersion | null {
  const m = PARTIAL.exec(value);
  if (!m) return null;
  const given: number[] = [];
  for (const part of [m[1], m[2], m[3]]) {
    if (part === undefined || /^[xX*]$/.test(part)) break;
    given.push(Number(part));
  }
  // A pre-release tag only makes sense on a complete version.
  if (m[4] && given.length < 3) return null;
  return { given, pre: m[4] ? m[4].split('.') : [] };
}

const v = (parts: number[], pre: string[] = []): Version => ({
  parts: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0],
  pre,
});

/** The version just above every version matching a partial (1.2 → 1.3.0-0). */
function upperOf(given: number[]): Version {
  const parts = [...given];
  const last = parts.length - 1;
  parts[last] = (parts[last] ?? 0) + 1;
  return v(parts, ['0']);
}

/** Expands one range term (`^1.2`, `>=1.0`, `1.x`) into comparators. */
function expand(term: string): Comparator[] | null {
  const m = /^(\^|~>?|>=|<=|>|<|=)?\s*(.+)$/.exec(term);
  if (!m) return null;
  const op = m[1] ?? '';
  const partial = parsePartial(m[2] ?? '');
  if (!partial) return null;
  const { given, pre } = partial;
  if (!given.length) {
    // `*`, `x`, `>=*`: anything. `<*` / `>*`: nothing can match.
    return op === '<' || op === '>' ? [{ op: '<', version: v([0, 0, 0], ['0']) }] : [];
  }
  const low = v(given, pre);
  switch (op) {
    case '^': {
      // Changes that don't modify the left-most non-zero part.
      // ^1.2.3 → <2.0.0, ^0.2.3 → <0.3.0, ^0.0.3 → <0.0.4, ^0.0 → <0.1.0.
      const nonZero = given.findIndex((n) => n !== 0);
      const bump = nonZero === -1 ? given.length - 1 : nonZero;
      return [
        { op: '>=', version: low },
        { op: '<', version: upperOf(given.slice(0, bump + 1)) },
      ];
    }
    case '~':
    case '~>':
      return [
        { op: '>=', version: low },
        { op: '<', version: upperOf(given.slice(0, given.length === 1 ? 1 : 2)) },
      ];
    case '>':
      return given.length === 3
        ? [{ op: '>', version: low }]
        : [{ op: '>=', version: upperOf(given) }];
    case '>=':
      return [{ op: '>=', version: low }];
    case '<':
      return [{ op: '<', version: given.length === 3 ? low : v(given, ['0']) }];
    case '<=':
      return given.length === 3
        ? [{ op: '<=', version: low }]
        : [{ op: '<', version: upperOf(given) }];
    default:
      return given.length === 3
        ? [{ op: '=', version: low }]
        : [
            { op: '>=', version: low },
            { op: '<', version: upperOf(given) },
          ];
  }
}

function parseRange(range: string): Comparator[][] | null {
  const sets: Comparator[][] = [];
  for (const alternative of range.split('||')) {
    let text = alternative.trim();
    const set: Comparator[] = [];
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
    if (hyphen) {
      const from = expand(`>=${hyphen[1]}`);
      const to = expand(`<=${hyphen[2]}`);
      if (!from || !to) return null;
      sets.push([...from, ...to]);
      continue;
    }
    // Allow a space between an operator and its version (">= 1.0").
    text = text.replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, '$1');
    for (const term of text ? text.split(/\s+/) : ['*']) {
      const comparators = expand(term);
      if (!comparators) return null;
      set.push(...comparators);
    }
    sets.push(set);
  }
  return sets;
}

export function isValidRange(range: string): boolean {
  return range.trim() !== '' && parseRange(range) !== null;
}

function test(c: Comparator, version: Version): boolean {
  const d = compareVersions(version, c.version);
  switch (c.op) {
    case '<':
      return d < 0;
    case '<=':
      return d <= 0;
    case '>':
      return d > 0;
    case '>=':
      return d >= 0;
    default:
      return d === 0;
  }
}

/** Whether `version` is in `range`. Invalid input never satisfies. */
export function satisfies(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  const sets = parseRange(range);
  if (!parsed || !sets) return false;
  return sets.some((set) => set.every((c) => test(c, parsed)));
}
