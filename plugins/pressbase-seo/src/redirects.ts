import type { PluginApi } from '@pressbase/plugin-sdk';

/**
 * Redirects and the 404 log, in the plugin's own tables (migrations/0001).
 *
 * - Rules are checked in `template_redirect` against a lookup cached in
 *   memory (exact sources in a Map, regex rules in a list), rebuilt after
 *   any change. Changing a rule purges its source path from the page cache
 *   (ADR 0017); regex rules purge the whole site.
 * - A 404 is logged with its path, the last referrer, a count and when it
 *   was last seen. Never the visitor's IP. A daily cron event keeps the log
 *   at most LOG_CAP rows and drops entries older than LOG_DAYS.
 */

export type RedirectStatus = 301 | 302 | 307 | 410;
export const STATUSES: RedirectStatus[] = [301, 302, 307, 410];
export const LOG_CAP = 5000;
export const LOG_DAYS = 90;

export interface Redirect {
  id: number;
  source: string;
  target: string;
  status: RedirectStatus;
  regex: boolean;
  hits: number;
  last_hit: string | null;
}

export interface NotFoundEntry {
  id: number;
  path: string;
  referrer: string;
  hits: number;
  last_seen: string;
}

export class RedirectError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** `/old-post/` and `/old-post` are the same address; the query string never matters. */
export function normalizePath(path: string): string {
  let p = path.trim().split('#')[0]?.split('?')[0] ?? '';
  try {
    if (/^https?:\/\//i.test(p)) p = new URL(p).pathname;
  } catch {
    // Not a URL: treated as a path.
  }
  if (!p.startsWith('/')) p = `/${p}`;
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

function row(r: Record<string, unknown>): Redirect {
  return {
    id: Number(r.id),
    source: String(r.source),
    target: String(r.target ?? ''),
    status: Number(r.status) as RedirectStatus,
    regex: Boolean(r.regex),
    hits: Number(r.hits ?? 0),
    last_hit: r.last_hit ? new Date(String(r.last_hit)).toISOString() : null,
  };
}

export interface RedirectInput {
  source: string;
  target?: string;
  status?: number;
  regex?: boolean;
}

/** Validates and normalises a rule; throws RedirectError with a message for the field. */
export function cleanRule(input: RedirectInput): Omit<Redirect, 'id' | 'hits' | 'last_hit'> {
  const status = Number(input.status ?? 301) as RedirectStatus;
  if (!STATUSES.includes(status)) {
    throw new RedirectError('invalid_status', 'Choose 301, 302, 307 or 410.');
  }
  const regex = Boolean(input.regex);
  const rawSource = String(input.source ?? '').trim();
  if (!rawSource) throw new RedirectError('invalid_source', 'Enter the address to redirect from.');
  let source: string;
  if (regex) {
    try {
      new RegExp(rawSource);
    } catch {
      throw new RedirectError('invalid_source', 'That regular expression isn’t valid.');
    }
    source = rawSource;
  } else {
    source = normalizePath(rawSource);
  }
  const target = String(input.target ?? '').trim();
  if (status !== 410) {
    if (!target) throw new RedirectError('invalid_target', 'Enter where visitors should go.');
    if (!/^(?:https?:\/\/[^\s]+|\/[^\s]*)$/i.test(target)) {
      throw new RedirectError(
        'invalid_target',
        'Use a path on this site (/new-page/) or a full address (https://…).',
      );
    }
    if (!regex && normalizePath(target) === source && target.startsWith('/')) {
      throw new RedirectError('invalid_target', 'A redirect can’t point to itself.');
    }
  }
  return { source, target: status === 410 ? '' : target, status, regex };
}

interface Lookup {
  exact: Map<string, Redirect>;
  patterns: { rule: Redirect; re: RegExp }[];
}

export class Redirects {
  #lookup: Promise<Lookup> | null = null;

  constructor(private readonly api: PluginApi) {}

  get #db() {
    const db = this.api.db;
    if (!db) throw new Error('Pressbase SEO needs the database permission.');
    return db;
  }

  /** Drops the cached lookup (after a change, or in tests). */
  invalidate(): void {
    this.#lookup = null;
  }

  async #load(): Promise<Lookup> {
    const { sql, query } = this.#db;
    const rows = (await query(sql`select * from pressbase_seo_redirects order by id`)).map(row);
    const exact = new Map<string, Redirect>();
    const patterns: Lookup['patterns'] = [];
    for (const rule of rows) {
      if (!rule.regex) exact.set(rule.source, rule);
      else {
        try {
          patterns.push({ rule, re: new RegExp(rule.source) });
        } catch {
          // Saved before validation existed: skipped.
        }
      }
    }
    return { exact, patterns };
  }

  /** The rule for a path, and where it sends the visitor (regex groups filled in). */
  async match(path: string): Promise<{ rule: Redirect; location: string } | null> {
    this.#lookup ??= this.#load();
    const lookup = await this.#lookup;
    const normal = normalizePath(path);
    let decoded = normal;
    try {
      decoded = normalizePath(decodeURIComponent(path));
    } catch {
      // Malformed escapes: match the raw path only.
    }
    const exact = lookup.exact.get(normal) ?? lookup.exact.get(decoded);
    if (exact) return { rule: exact, location: exact.target };
    for (const { rule, re } of lookup.patterns) {
      const m = re.exec(path) ?? re.exec(decoded);
      if (m) {
        const location = rule.target.replace(/\$(\d)/g, (_, n: string) => m[Number(n)] ?? '');
        return { rule, location };
      }
    }
    return null;
  }

  async hit(id: number): Promise<void> {
    const { sql, query } = this.#db;
    await query(
      sql`update pressbase_seo_redirects set hits = hits + 1, last_hit = now() where id = ${id}`,
    );
  }

  async list(args: { search?: string; after?: number; limit?: number } = {}): Promise<Redirect[]> {
    const { sql, query } = this.#db;
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
    const after = args.after ?? 0;
    const like = args.search ? `%${args.search.replace(/[%_\\]/g, '\\$&')}%` : null;
    const rows = like
      ? await query(
          sql`select * from pressbase_seo_redirects where id > ${after}
              and (source ilike ${like} or target ilike ${like}) order by id limit ${limit}`,
        )
      : await query(
          sql`select * from pressbase_seo_redirects where id > ${after} order by id limit ${limit}`,
        );
    return rows.map(row);
  }

  async get(id: number): Promise<Redirect | undefined> {
    const { sql, query } = this.#db;
    const [r] = await query(sql`select * from pressbase_seo_redirects where id = ${id}`);
    return r ? row(r) : undefined;
  }

  async count(): Promise<number> {
    const { sql, query } = this.#db;
    const [r] = await query<{ n: number | string }>(
      sql`select count(*) as n from pressbase_seo_redirects`,
    );
    return Number(r?.n ?? 0);
  }

  /** Purges what a rule can affect: its source path, or the site for a regex. */
  async #purge(rules: Pick<Redirect, 'source' | 'regex'>[]): Promise<void> {
    if (rules.some((r) => r.regex)) await this.api.cache.purge(['site']);
    else if (rules.length) await this.api.cache.purgePaths(rules.map((r) => r.source));
  }

  async create(input: RedirectInput): Promise<Redirect> {
    const rule = cleanRule(input);
    const { sql, query } = this.#db;
    const [existing] = await query(
      sql`select id from pressbase_seo_redirects where source = ${rule.source}`,
    );
    if (existing) {
      throw new RedirectError('duplicate_source', 'There’s already a redirect from this address.');
    }
    const [r] = await query(
      sql`insert into pressbase_seo_redirects (source, target, status, regex)
          values (${rule.source}, ${rule.target}, ${rule.status}, ${rule.regex}) returning *`,
    );
    this.invalidate();
    await this.#purge([rule]);
    return row(r as Record<string, unknown>);
  }

  async update(id: number, input: RedirectInput): Promise<Redirect | undefined> {
    const before = await this.get(id);
    if (!before) return undefined;
    const rule = cleanRule({ ...before, ...input });
    const { sql, query } = this.#db;
    const [clash] = await query(
      sql`select id from pressbase_seo_redirects where source = ${rule.source} and id <> ${id}`,
    );
    if (clash) {
      throw new RedirectError('duplicate_source', 'There’s already a redirect from this address.');
    }
    const [r] = await query(
      sql`update pressbase_seo_redirects set source = ${rule.source}, target = ${rule.target},
          status = ${rule.status}, regex = ${rule.regex} where id = ${id} returning *`,
    );
    this.invalidate();
    await this.#purge([before, rule]);
    return r ? row(r) : undefined;
  }

  async delete(id: number): Promise<Redirect | undefined> {
    const before = await this.get(id);
    if (!before) return undefined;
    const { sql, query } = this.#db;
    await query(sql`delete from pressbase_seo_redirects where id = ${id}`);
    this.invalidate();
    await this.#purge([before]);
    return before;
  }

  /** Adds or replaces many rules (CSV import): one purge at the end. */
  async upsertMany(inputs: RedirectInput[]): Promise<{ saved: number; errors: string[] }> {
    const { sql, query } = this.#db;
    const errors: string[] = [];
    const saved: Pick<Redirect, 'source' | 'regex'>[] = [];
    for (const [index, input] of inputs.entries()) {
      try {
        const rule = cleanRule(input);
        await query(
          sql`insert into pressbase_seo_redirects (source, target, status, regex)
              values (${rule.source}, ${rule.target}, ${rule.status}, ${rule.regex})
              on conflict (source) do update set target = excluded.target,
              status = excluded.status, regex = excluded.regex`,
        );
        saved.push(rule);
      } catch (error) {
        errors.push(`Row ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.invalidate();
    await this.#purge(saved.length > 200 ? [{ source: '', regex: true }] : saved);
    return { saved: saved.length, errors };
  }

  /* ------------------------------------------------------------ 404 log */

  async log404(path: string, referrer: string): Promise<void> {
    const { sql, query } = this.#db;
    const p = path.slice(0, 500);
    const ref = referrer.slice(0, 500);
    await query(
      sql`insert into pressbase_seo_404s (path, referrer) values (${p}, ${ref})
          on conflict (path) do update set hits = pressbase_seo_404s.hits + 1,
          last_seen = now(),
          referrer = case when excluded.referrer = '' then pressbase_seo_404s.referrer else excluded.referrer end`,
    );
  }

  async list404(args: { after?: number; limit?: number } = {}): Promise<NotFoundEntry[]> {
    const { sql, query } = this.#db;
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
    const rows = await query(
      args.after
        ? sql`select * from pressbase_seo_404s where id < ${args.after} order by id desc limit ${limit}`
        : sql`select * from pressbase_seo_404s order by id desc limit ${limit}`,
    );
    return rows.map((r) => ({
      id: Number(r.id),
      path: String(r.path),
      referrer: String(r.referrer ?? ''),
      hits: Number(r.hits ?? 0),
      last_seen: new Date(String(r.last_seen)).toISOString(),
    }));
  }

  async delete404(id?: number): Promise<void> {
    const { sql, query } = this.#db;
    await query(
      id === undefined
        ? sql`delete from pressbase_seo_404s`
        : sql`delete from pressbase_seo_404s where id = ${id}`,
    );
  }

  /** The daily prune: old entries, then anything beyond the cap (least recently seen first). */
  async prune404(cap = LOG_CAP, days = LOG_DAYS): Promise<void> {
    const { sql, query } = this.#db;
    await query(
      sql`delete from pressbase_seo_404s where id in (select id from pressbase_seo_404s
          where last_seen < now() - make_interval(days => ${days}) limit 5000)`,
    );
    await query(
      sql`delete from pressbase_seo_404s where id in (select id from pressbase_seo_404s
          order by last_seen desc, id desc offset ${cap})`,
    );
  }
}

/* ------------------------------------------------------------------- CSV */

function csvField(value: string | number | boolean): string {
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rules: Redirect[]): string {
  const lines = ['source,target,status,regex'];
  for (const r of rules) {
    lines.push([r.source, r.target, r.status, r.regex ? 1 : 0].map(csvField).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

/** CSV rows (with or without the header) as rules: source, target, status, regex. */
export function rulesFromCsv(text: string): RedirectInput[] {
  const rows = parseCsv(text);
  if (rows[0]?.[0]?.trim().toLowerCase() === 'source') rows.shift();
  return rows.map(([source = '', target = '', status = '301', regex = '0']) => ({
    source,
    target,
    status: Number(status) || 301,
    regex: ['1', 'true', 'yes'].includes(regex.trim().toLowerCase()),
  }));
}
