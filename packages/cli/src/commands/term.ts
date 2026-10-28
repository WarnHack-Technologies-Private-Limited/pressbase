import type { Taxonomy } from '@pressbase/core/src/content/taxonomies';
import type { Term } from '@pressbase/core/src/content/terms';
import type { CommandSpec, Context } from '../command';
import { service } from './shared';

/**
 * `pressbase term`: wp-cli's entity-command for terms, on kernel.terms
 * (get_terms(), wp_insert_term(), wp_delete_term()).
 */

const FIELDS = [
  'term_id',
  'term_taxonomy_id',
  'name',
  'slug',
  'description',
  'parent',
  'count',
  'taxonomy',
];
const LIST_FIELDS = [
  'term_id',
  'term_taxonomy_id',
  'name',
  'slug',
  'description',
  'parent',
  'count',
];

function toRow(term: Term) {
  return {
    term_id: term.id,
    term_taxonomy_id: term.ttId,
    name: term.name,
    slug: term.slug,
    description: term.description,
    parent: term.parent,
    count: term.count,
    taxonomy: term.taxonomy,
  };
}

function taxonomy(ctx: Context, name: string): Taxonomy {
  const tax = ctx.kernel.taxonomies.get(name);
  if (!tax) {
    const names = ctx.kernel.taxonomies.all().map((t) => t.name);
    ctx.error(`There’s no taxonomy “${name}”. Taxonomies: ${names.join(', ')}.`);
  }
  return tax;
}

async function findTerm(ctx: Context, tax: Taxonomy, value: string, by: string): Promise<Term> {
  const term =
    by === 'slug'
      ? (await ctx.kernel.terms.list(tax.name, { slug: [value], perPage: 1 })).terms[0]
      : /^\d+$/.test(value)
        ? await ctx.kernel.terms.get(tax.name, Number(value))
        : undefined;
  if (!term) ctx.error(`There’s no ${tax.name} term “${value}”.`);
  return term;
}

export const termCommands: CommandSpec[] = [
  {
    name: 'term list',
    shortdesc: 'Lists the terms of one or more taxonomies.',
    synopsis:
      '<taxonomy>... [--search=<text>] [--slug=<slug>] [--parent=<term-id>] [--hide_empty] [--fields=<fields>] [--field=<field>] [--format=<format>]',
    options: {
      taxonomy: 'Taxonomy names: category, post_tag, or a plugin’s.',
      search: 'Only terms whose name or slug contains this text.',
      slug: 'Only terms with these slugs, comma-separated.',
      parent: 'Only children of this term (0: top-level terms).',
      hide_empty: 'Leave out terms no published post uses.',
    },
    examples: [
      ['pressbase term list category --fields=term_id,name,count', 'List categories'],
      ['pressbase term list post_tag --format=count', 'Count tags'],
    ],
    needs: 'installed',
    async run(ctx) {
      const rows = [];
      for (const name of ctx.args) {
        const tax = taxonomy(ctx, name);
        const { terms } = await ctx.kernel.terms.list(tax.name, {
          search: ctx.string('search'),
          slug: ctx.list('slug'),
          parent: ctx.int('parent'),
          hideEmpty: ctx.flag('hide_empty'),
          orderby: 'name',
          order: 'asc',
          perPage: 1_000_000,
        });
        rows.push(...terms.map(toRow));
      }
      ctx.formatItems(rows, LIST_FIELDS, { all: FIELDS, idField: 'term_id' });
    },
  },
  {
    name: 'term create',
    shortdesc: 'Creates a term.',
    synopsis:
      '<taxonomy> <term> [--slug=<slug>] [--description=<description>] [--parent=<term-id>] [--porcelain]',
    options: {
      taxonomy: 'The taxonomy.',
      term: 'The term’s name.',
      parent: 'The parent term’s ID (hierarchical taxonomies, like categories).',
      porcelain: 'Print only the new term’s ID.',
    },
    examples: [
      [
        'pressbase term create category Travel --description="Trips and places"',
        'Create a category',
      ],
    ],
    needs: 'installed',
    async run(ctx) {
      const [name = '', termName = ''] = ctx.args;
      const tax = taxonomy(ctx, name);
      // As the REST API: hierarchical taxonomies need edit_terms, flat ones assign_terms.
      const cap = tax.hierarchical ? tax.cap.edit_terms : tax.cap.assign_terms;
      await ctx.require(
        cap,
        undefined,
        `${ctx.user?.login} isn’t allowed to create ${tax.name} terms.`,
      );
      const term = await service(() =>
        ctx.kernel.terms.insert(tax.name, {
          name: termName,
          slug: ctx.string('slug'),
          description: ctx.string('description'),
          parent: ctx.int('parent'),
        }),
      );
      if (ctx.flag('porcelain')) ctx.line(String(term.id));
      else ctx.success(`Created ${tax.name} ${term.id}.`);
    },
  },
  {
    name: 'term delete',
    shortdesc: 'Deletes terms. Posts keep existing; they just lose the term.',
    synopsis: '<taxonomy> <term>... [--by=<field>]',
    options: {
      taxonomy: 'The taxonomy.',
      term: 'Term IDs, or slugs with --by=slug.',
      by: 'How the terms are given.',
    },
    choices: { by: ['id', 'slug'] },
    defaults: { by: 'id' },
    examples: [
      ['pressbase term delete post_tag 14 15', 'Delete two tags'],
      [
        'pressbase term delete category travel --by=slug --yes',
        'Delete a category by slug, without asking',
      ],
    ],
    needs: 'installed',
    async run(ctx) {
      const [name = '', ...values] = ctx.args;
      const tax = taxonomy(ctx, name);
      const terms: Term[] = [];
      for (const value of values) {
        const term = await findTerm(ctx, tax, value, ctx.string('by') ?? 'id');
        await ctx.require(
          'delete_term',
          term.id,
          `${ctx.user?.login} isn’t allowed to delete “${term.name}”.`,
        );
        terms.push(term);
      }
      if (!terms.length) ctx.error('Give the terms to delete.');
      await ctx.confirm(`Delete ${terms.map((t) => `“${t.name}”`).join(', ')} from ${tax.name}?`);
      for (const term of terms) {
        await service(() => ctx.kernel.terms.delete(tax.name, term.id));
        ctx.success(`Deleted ${tax.name} ${term.id}.`);
      }
    },
  },
];
