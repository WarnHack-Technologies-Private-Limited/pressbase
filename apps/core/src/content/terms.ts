import { schema } from '@pressbase/db';
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { addCacheTags, CacheTag } from '../cache/tags';
import type { Kernel } from '../kernel';
import { sanitizeSlug, stripTags } from './sanitize';

/**
 * Terms — the taxonomy half of WordPress's data API (wp_insert_term,
 * wp_update_term, wp_delete_term, wp_set_object_terms, _update_post_term_count
 * in wordpress/wp-includes/taxonomy.php).
 *
 * Every term has exactly one term_taxonomy row. The public ID (REST `id`,
 * `parent`) is terms.id, as in WordPress since terms were split in 4.2.
 */

export interface Term {
  id: number;
  name: string;
  slug: string;
  description: string;
  taxonomy: string;
  /** Parent term ID, 0 for none. */
  parent: number;
  count: number;
  /** term_taxonomy.id, used by term_relationships. */
  ttId: number;
}

export class TermError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 | 500 = 400,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface TermListArgs {
  search?: string;
  include?: number[];
  exclude?: number[];
  slug?: string[];
  parent?: number;
  post?: number;
  hideEmpty?: boolean;
  orderby?: 'id' | 'name' | 'slug' | 'count' | 'description' | 'include' | 'term_group';
  order?: 'asc' | 'desc';
  page?: number;
  perPage?: number;
}

export class TermsService {
  constructor(private readonly kernel: Kernel) {}

  get #db() {
    return this.kernel.db;
  }

  #select() {
    const { terms, termTaxonomy } = schema;
    return this.#db
      .select({
        id: terms.id,
        name: terms.name,
        slug: terms.slug,
        description: termTaxonomy.description,
        taxonomy: termTaxonomy.taxonomy,
        parent:
          sql<number>`coalesce((select p.term_id from term_taxonomy p where p.id = ${termTaxonomy.parentId}), 0)`.mapWith(
            Number,
          ),
        count: termTaxonomy.count,
        ttId: termTaxonomy.id,
      })
      .from(terms)
      .innerJoin(termTaxonomy, eq(termTaxonomy.termId, terms.id));
  }

  async get(taxonomy: string, id: number): Promise<Term | undefined> {
    const [term] = await this.#select().where(
      and(eq(schema.terms.id, id), eq(schema.termTaxonomy.taxonomy, taxonomy)),
    );
    if (term) addCacheTags(CacheTag.term(term.id));
    return term;
  }

  async list(taxonomy: string, args: TermListArgs = {}): Promise<{ terms: Term[]; total: number }> {
    const { terms, termTaxonomy, termRelationships } = schema;
    const where: SQL[] = [eq(termTaxonomy.taxonomy, taxonomy)];
    if (args.search) {
      const like = `%${args.search.replace(/[%_\\]/g, '\\$&')}%`;
      where.push(or(ilike(terms.name, like), ilike(terms.slug, like)) as SQL);
    }
    if (args.include?.length) where.push(inArray(terms.id, args.include));
    if (args.exclude?.length) where.push(notInArray(terms.id, args.exclude));
    if (args.slug?.length) where.push(inArray(terms.slug, args.slug));
    if (args.hideEmpty) where.push(sql`${termTaxonomy.count} > 0`);
    if (args.parent !== undefined) {
      where.push(
        args.parent === 0
          ? sql`${termTaxonomy.parentId} is null`
          : sql`${termTaxonomy.parentId} = (select id from term_taxonomy where term_id = ${args.parent} and taxonomy = ${taxonomy})`,
      );
    }
    if (args.post !== undefined) {
      where.push(
        inArray(
          termTaxonomy.id,
          this.#db
            .select({ id: termRelationships.termTaxonomyId })
            .from(termRelationships)
            .where(eq(termRelationships.objectId, args.post)),
        ),
      );
    }
    const condition = and(...where);

    const direction = args.order === 'desc' ? desc : asc;
    const orderColumn = {
      id: terms.id,
      name: terms.name,
      slug: terms.slug,
      count: termTaxonomy.count,
      description: termTaxonomy.description,
      term_group: terms.termGroup,
      include: terms.id,
    }[args.orderby ?? 'name'];
    const orderBy =
      args.orderby === 'include' && args.include?.length
        ? sql`array_position(${sql.raw(`ARRAY[${args.include.map(Number).join(',')}]::bigint[]`)}, ${terms.id})`
        : direction(orderColumn);

    const perPage = args.perPage ?? 10;
    const page = args.page ?? 1;
    const [rows, [totals]] = await Promise.all([
      this.#select()
        .where(condition)
        .orderBy(orderBy, asc(terms.id))
        .limit(perPage)
        .offset((page - 1) * perPage),
      this.#db
        .select({ n: count() })
        .from(terms)
        .innerJoin(termTaxonomy, eq(termTaxonomy.termId, terms.id))
        .where(condition),
    ]);
    // A page showing these terms depends on them; one listing the taxonomy, on all of it.
    addCacheTags(
      ...rows.map((t) => CacheTag.term(t.id)),
      args.post === undefined && !args.slug?.length && !args.include?.length
        ? CacheTag.terms(taxonomy)
        : undefined,
    );
    return { terms: rows, total: totals?.n ?? 0 };
  }

  async #ttIdFor(taxonomy: string, termId: number): Promise<number> {
    const term = await this.get(taxonomy, termId);
    if (!term) throw new TermError('rest_term_invalid', 'Term does not exist.', 404);
    return term.ttId;
  }

  async #uniqueSlug(taxonomy: string, slug: string, exceptId?: number): Promise<string> {
    const base = slug || 'term';
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      const [clash] = await this.#select().where(
        and(
          eq(schema.terms.slug, candidate),
          eq(schema.termTaxonomy.taxonomy, taxonomy),
          exceptId ? sql`${schema.terms.id} <> ${exceptId}` : undefined,
        ),
      );
      if (!clash) return candidate;
    }
  }

  /** wp_insert_term() */
  async insert(
    taxonomy: string,
    input: { name: string; slug?: string; description?: string; parent?: number },
  ): Promise<Term> {
    const tax = this.kernel.taxonomies.get(taxonomy);
    if (!tax) throw new TermError('invalid_taxonomy', 'Invalid taxonomy.');
    const name = stripTags(input.name);
    if (!name) throw new TermError('empty_term_name', 'A name is required for this term.');
    if (input.parent && !tax.hierarchical) {
      throw new TermError(
        'rest_taxonomy_not_hierarchical',
        'Cannot set parent term, taxonomy is not hierarchical.',
      );
    }

    const requested = sanitizeSlug(input.slug ?? '');
    const slug = requested || sanitizeSlug(name);
    const existing: Term | undefined = (
      await this.#select().where(
        and(eq(schema.terms.slug, slug), eq(schema.termTaxonomy.taxonomy, taxonomy)),
      )
    )[0];
    if (existing && (requested !== '' || existing.name.toLowerCase() === name.toLowerCase())) {
      throw new TermError(
        'term_exists',
        'A term with the name provided already exists in this taxonomy.',
        400,
        {
          term_id: existing.id,
        },
      );
    }

    const parentTtId = input.parent ? await this.#ttIdFor(taxonomy, input.parent) : null;
    const uniqueSlug = await this.#uniqueSlug(taxonomy, slug);
    const id = await this.#db.transaction(async (tx) => {
      const [term] = await tx
        .insert(schema.terms)
        .values({ name, slug: uniqueSlug })
        .returning({ id: schema.terms.id });
      if (!term)
        throw new TermError('db_insert_error', 'Could not insert term into the database.', 500);
      await tx.insert(schema.termTaxonomy).values({
        termId: term.id,
        taxonomy,
        description: stripTags(input.description ?? ''),
        parentId: parentTtId,
      });
      return term.id;
    });
    await this.kernel.hooks.doAction('created_term', id, taxonomy);
    return (await this.get(taxonomy, id)) as Term;
  }

  /** wp_update_term() */
  async update(
    taxonomy: string,
    id: number,
    input: { name?: string; slug?: string; description?: string; parent?: number },
  ): Promise<Term> {
    const current = await this.get(taxonomy, id);
    if (!current) throw new TermError('rest_term_invalid', 'Term does not exist.', 404);
    const tax = this.kernel.taxonomies.get(taxonomy);

    const termSet: { name?: string; slug?: string } = {};
    if (input.name !== undefined) {
      termSet.name = stripTags(input.name);
      if (!termSet.name)
        throw new TermError('empty_term_name', 'A name is required for this term.');
    }
    if (input.slug !== undefined) {
      const slug = sanitizeSlug(input.slug) || sanitizeSlug(termSet.name ?? current.name);
      const [clash] = await this.#select().where(
        and(
          eq(schema.terms.slug, slug),
          eq(schema.termTaxonomy.taxonomy, taxonomy),
          sql`${schema.terms.id} <> ${id}`,
        ),
      );
      if (clash)
        throw new TermError(
          'duplicate_term_slug',
          `The slug "${slug}" is already in use by another term.`,
        );
      termSet.slug = slug;
    }

    const ttSet: { description?: string; parentId?: number | null } = {};
    if (input.description !== undefined) ttSet.description = stripTags(input.description);
    if (input.parent !== undefined) {
      if (!tax?.hierarchical && input.parent) {
        throw new TermError(
          'rest_taxonomy_not_hierarchical',
          'Cannot set parent term, taxonomy is not hierarchical.',
        );
      }
      if (input.parent === id)
        throw new TermError('rest_term_invalid_parent', 'A term cannot be its own parent.');
      ttSet.parentId = input.parent ? await this.#ttIdFor(taxonomy, input.parent) : null;
    }

    await this.#db.transaction(async (tx) => {
      if (Object.keys(termSet).length)
        await tx.update(schema.terms).set(termSet).where(eq(schema.terms.id, id));
      if (Object.keys(ttSet).length) {
        await tx
          .update(schema.termTaxonomy)
          .set(ttSet)
          .where(eq(schema.termTaxonomy.id, current.ttId));
      }
    });
    await this.kernel.hooks.doAction('edited_term', id, taxonomy);
    return (await this.get(taxonomy, id)) as Term;
  }

  /**
   * wp_delete_term(): children move up to the deleted term's parent, and posts
   * left without a category fall back to the default category.
   */
  async delete(taxonomy: string, id: number): Promise<Term> {
    const term = await this.get(taxonomy, id);
    if (!term) throw new TermError('rest_term_invalid', 'Term does not exist.', 404);
    const fallback =
      taxonomy === 'category' ? await this.kernel.options.get<number>('default_category', 0) : 0;
    if (taxonomy === 'category' && id === fallback) {
      throw new TermError('rest_cannot_delete', 'The default category cannot be deleted.', 400);
    }

    const { termTaxonomy, termRelationships } = schema;
    const objectIds = (
      await this.#db
        .select({ id: termRelationships.objectId })
        .from(termRelationships)
        .where(eq(termRelationships.termTaxonomyId, term.ttId))
    ).map((r) => r.id);
    const parentTt = term.parent ? await this.#ttIdFor(taxonomy, term.parent) : null;

    await this.#db.transaction(async (tx) => {
      await tx
        .update(termTaxonomy)
        .set({ parentId: parentTt })
        .where(eq(termTaxonomy.parentId, term.ttId));
      await tx.delete(schema.terms).where(eq(schema.terms.id, id));
    });

    if (fallback && objectIds.length) {
      const fallbackTt = await this.#ttIdFor('category', fallback);
      for (const objectId of objectIds) {
        const remaining = await this.objectTermIds([objectId], 'category');
        if (!remaining.get(objectId)?.length) {
          await this.#db
            .insert(termRelationships)
            .values({ objectId, termTaxonomyId: fallbackTt })
            .onConflictDoNothing();
        }
      }
      await this.recount([fallbackTt]);
    }
    await this.kernel.hooks.doAction('delete_term', id, taxonomy, term);
    return term;
  }

  /** Term IDs per object for one taxonomy, in term_order. */
  async objectTermIds(objectIds: number[], taxonomy: string): Promise<Map<number, number[]>> {
    const result = new Map<number, number[]>(objectIds.map((id) => [id, []]));
    if (!objectIds.length) return result;
    const { termTaxonomy, termRelationships } = schema;
    const rows = await this.#db
      .select({ objectId: termRelationships.objectId, termId: termTaxonomy.termId })
      .from(termRelationships)
      .innerJoin(termTaxonomy, eq(termTaxonomy.id, termRelationships.termTaxonomyId))
      .where(
        and(inArray(termRelationships.objectId, objectIds), eq(termTaxonomy.taxonomy, taxonomy)),
      )
      .orderBy(asc(termRelationships.termOrder), asc(termTaxonomy.termId));
    for (const row of rows) result.get(row.objectId)?.push(row.termId);
    return result;
  }

  /** wp_set_object_terms(): replaces the object's terms in one taxonomy. */
  async setObjectTerms(objectId: number, taxonomy: string, termIds: number[]): Promise<void> {
    const { termTaxonomy, termRelationships } = schema;
    const wanted = termIds.length
      ? await this.#db
          .select({ ttId: termTaxonomy.id, termId: termTaxonomy.termId })
          .from(termTaxonomy)
          .where(and(eq(termTaxonomy.taxonomy, taxonomy), inArray(termTaxonomy.termId, termIds)))
      : [];
    if (wanted.length !== new Set(termIds).size) {
      throw new TermError('rest_invalid_term', 'One or more terms do not exist in this taxonomy.');
    }
    const current = await this.#db
      .select({ ttId: termRelationships.termTaxonomyId })
      .from(termRelationships)
      .innerJoin(termTaxonomy, eq(termTaxonomy.id, termRelationships.termTaxonomyId))
      .where(and(eq(termRelationships.objectId, objectId), eq(termTaxonomy.taxonomy, taxonomy)));

    const touched = new Set([...current.map((r) => r.ttId), ...wanted.map((w) => w.ttId)]);
    await this.#db.transaction(async (tx) => {
      if (current.length) {
        await tx.delete(termRelationships).where(
          and(
            eq(termRelationships.objectId, objectId),
            inArray(
              termRelationships.termTaxonomyId,
              current.map((r) => r.ttId),
            ),
          ),
        );
      }
      if (wanted.length) {
        const order = new Map(termIds.map((id, i) => [id, i]));
        await tx.insert(termRelationships).values(
          wanted.map((w) => ({
            objectId,
            termTaxonomyId: w.ttId,
            termOrder: order.get(w.termId) ?? 0,
          })),
        );
      }
    });
    await this.recount([...touched]);
    // set_object_terms ($object_id, $terms, $tt_ids, $taxonomy, $append, $old_tt_ids)
    await this.kernel.hooks.doAction(
      'set_object_terms',
      objectId,
      termIds,
      wanted.map((w) => w.ttId),
      taxonomy,
      false,
      current.map((r) => r.ttId),
    );
  }

  /** Removes every relationship of an object (on permanent post deletion). */
  async clearObject(objectId: number): Promise<void> {
    const removed = await this.#db
      .delete(schema.termRelationships)
      .where(eq(schema.termRelationships.objectId, objectId))
      .returning({ ttId: schema.termRelationships.termTaxonomyId });
    await this.recount(removed.map((r) => r.ttId));
  }

  /** _update_post_term_count(): counts published objects of the taxonomy's types. */
  async recount(ttIds: number[]): Promise<void> {
    if (!ttIds.length) return;
    await this.#db.execute(sql`
      update term_taxonomy tt set count = (
        select count(*) from term_relationships tr
        join posts p on p.id = tr.object_id
        where tr.term_taxonomy_id = tt.id and p.status = 'publish'
      )
      where tt.id in (${sql.join(
        ttIds.map((id) => sql`${id}`),
        sql`, `,
      )})`);
  }

  /** Recounts every term attached to the given objects (after a status change). */
  async recountForObject(objectId: number): Promise<void> {
    const rows = await this.#db
      .select({ ttId: schema.termRelationships.termTaxonomyId })
      .from(schema.termRelationships)
      .where(eq(schema.termRelationships.objectId, objectId));
    await this.recount(rows.map((r) => r.ttId));
  }
}
