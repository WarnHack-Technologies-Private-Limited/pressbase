'use client';

import { Search, Tag } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import type { RestTerm, TaxonomyScreen } from '@/lib/content';
import { mergeMeta, metaChanges } from '@/lib/extensions/editor';
import { appliesTo, SLOTS } from '@/lib/extensions/registry';
import { RenderFill, useFills } from '../extensions/host';
import { useCan } from '../shell/current-user';
import { PageHeader } from '../shell/page-header';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/dialog';
import { SelectField, TextField } from '../ui/field';
import { Badge, Card, EmptyState, Notice } from '../ui/surface';
import { useToast } from '../ui/toast';
import styles from './list.module.css';
import { PostsSubnav } from './posts-subnav';

interface Draft {
  name: string;
  slug: string;
  parent: number;
  description: string;
}

const BLANK: Draft = { name: '', slug: '', parent: 0, description: '' };

function ordered(terms: RestTerm[], hierarchical: boolean): (RestTerm & { depth: number })[] {
  if (!hierarchical) return terms.map((t) => ({ ...t, depth: 0 }));
  const ids = new Set(terms.map((t) => t.id));
  const out: (RestTerm & { depth: number })[] = [];
  const walk = (parent: number, depth: number) => {
    for (const t of terms.filter(
      (x) => (x.parent && ids.has(x.parent) ? x.parent : 0) === parent,
    )) {
      out.push({ ...t, depth });
      walk(t.id, depth + 1);
    }
  };
  walk(0, 0);
  return out;
}

/** Fields shared by the "Add new" form and inline editing. */
function TermFields({
  draft,
  onChange,
  errors,
  screen,
  parents,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  errors: Record<string, string>;
  screen: TaxonomyScreen;
  parents: RestTerm[];
}) {
  return (
    <>
      <TextField
        label="Name"
        value={draft.name}
        onChange={(e) => onChange({ ...draft, name: e.target.value })}
        error={errors.name}
        hint="How it appears on your site."
      />
      <TextField
        label="Slug"
        optional
        value={draft.slug}
        onChange={(e) => onChange({ ...draft, slug: e.target.value })}
        error={errors.slug}
        hint="The URL-friendly version of the name. Leave empty to generate it."
        spellCheck={false}
      />
      {screen.hierarchical && (
        <SelectField
          label="Parent category"
          optional
          value={draft.parent}
          onChange={(e) => onChange({ ...draft, parent: Number(e.target.value) })}
        >
          <option value={0}>None</option>
          {ordered(parents, true).map((p) => (
            <option key={p.id} value={p.id}>
              {'  '.repeat(p.depth)}
              {p.name}
            </option>
          ))}
        </SelectField>
      )}
      <TextField
        label="Description"
        optional
        value={draft.description}
        onChange={(e) => onChange({ ...draft, description: e.target.value })}
      />
    </>
  );
}

export function TermsScreen({
  screen,
  defaultCategory,
}: {
  screen: TaxonomyScreen;
  defaultCategory?: number;
}) {
  const toast = useToast();
  const canManage = useCan('manage_categories');
  const [terms, setTerms] = useState<RestTerm[] | null>(null);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{
    id: number;
    draft: Draft;
    errors: Record<string, string>;
    /** The term's meta with plugins' edits (TermEditFields). */
    meta: Record<string, unknown>;
  } | null>(null);
  const [deleting, setDeleting] = useState<RestTerm | null>(null);
  const [problem, setProblem] = useState<string>();

  const load = useCallback(async () => {
    const q = new URLSearchParams({ per_page: '100', orderby: 'name', hide_empty: 'false' });
    if (search) q.set('search', search);
    try {
      setTerms(await api<RestTerm[]>(`/wp/v2/${screen.base}?${q}`));
    } catch {
      setProblem(`Could not load ${screen.plural.toLowerCase()}.`);
      setTerms([]);
    }
  }, [screen, search]);

  useEffect(() => {
    const timer = setTimeout(load, search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  const fieldErrors = (err: unknown): Record<string, string> => {
    if (err instanceof ApiError) {
      if (err.data.params) return err.data.params;
      if (err.code === 'term_exists' || err.code === 'duplicate_term_slug')
        return { name: err.message };
      return { name: err.message };
    }
    return { name: 'Something went wrong. Please try again.' };
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.name.trim()) {
      setErrors({ name: `Give the ${screen.singular.toLowerCase()} a name.` });
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = { name: draft.name, description: draft.description };
      if (draft.slug.trim()) body.slug = draft.slug;
      if (screen.hierarchical && draft.parent) body.parent = draft.parent;
      const created = await api<RestTerm>(`/wp/v2/${screen.base}`, { method: 'POST', body });
      setDraft(BLANK);
      setErrors({});
      toast(`${screen.singular} “${created.name}” added.`);
      await load();
    } catch (err) {
      setErrors(fieldErrors(err));
    } finally {
      setBusy(false);
    }
  };

  const update = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      const { name, slug, description, parent } = editing.draft;
      const meta = metaChanges(terms?.find((t) => t.id === editing.id)?.meta, editing.meta);
      await api(`/wp/v2/${screen.base}/${editing.id}`, {
        method: 'POST',
        body: {
          name,
          slug,
          description,
          ...(screen.hierarchical ? { parent } : {}),
          ...(Object.keys(meta).length ? { meta } : {}),
        },
      });
      setEditing(null);
      toast(`${screen.singular} updated.`);
      await load();
    } catch (err) {
      setEditing({ ...editing, errors: fieldErrors(err) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/wp/v2/${screen.base}/${deleting.id}?force=true`, { method: 'DELETE' });
      toast(`${screen.singular} “${deleting.name}” deleted.`);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not delete.', { tone: 'danger' });
    } finally {
      setBusy(false);
      setDeleting(null);
    }
  };

  const rows = terms ? ordered(terms, screen.hierarchical && !search) : null;

  return (
    <>
      <PageHeader title={screen.plural} />
      <PostsSubnav />
      {problem && <Notice tone="danger" title={problem} />}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 18rem), 1fr))',
          gap: 'var(--space-6)',
          alignItems: 'start',
        }}
      >
        {canManage && (
          <Card title={`Add new ${screen.singular.toLowerCase()}`}>
            <form
              onSubmit={create}
              noValidate
              style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
            >
              <TermFields
                draft={draft}
                onChange={setDraft}
                errors={errors}
                screen={screen}
                parents={terms ?? []}
              />
              <div>
                <Button type="submit" variant="primary" loading={busy && !editing && !deleting}>
                  Add {screen.singular.toLowerCase()}
                </Button>
              </div>
            </form>
          </Card>
        )}

        <div style={{ gridColumn: 'span 2', minWidth: 0 }}>
          <div className={styles.toolbar}>
            <div className={styles.search}>
              <Search size={16} aria-hidden="true" />
              <input
                className={styles.input}
                type="search"
                aria-label={`Search ${screen.plural.toLowerCase()}`}
                placeholder={`Search ${screen.plural.toLowerCase()}`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          <div className={styles.card}>
            {rows && rows.length === 0 ? (
              <EmptyState
                icon={<Tag size={28} />}
                title={search ? 'No matches' : `No ${screen.plural.toLowerCase()} yet`}
              >
                <p>
                  {search
                    ? 'Try a different search.'
                    : `${screen.plural} help readers find related posts. Add your first one here or while writing.`}
                </p>
              </EmptyState>
            ) : (
              <table className={styles.table} aria-busy={rows === null}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th className={styles.hideNarrow}>Slug</th>
                    <th style={{ textAlign: 'right' }}>Posts</th>
                  </tr>
                </thead>
                <tbody>
                  {(rows ?? []).map((term) =>
                    editing?.id === term.id ? (
                      <tr key={term.id}>
                        <td colSpan={3}>
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              update();
                            }}
                            noValidate
                            style={{
                              display: 'grid',
                              gap: 'var(--space-4)',
                              padding: 'var(--space-2) 0',
                            }}
                          >
                            <TermFields
                              draft={editing.draft}
                              onChange={(d) => setEditing({ ...editing, draft: d })}
                              errors={editing.errors}
                              screen={screen}
                              parents={(terms ?? []).filter((t) => t.id !== term.id)}
                            />
                            <TermPluginFields
                              term={term}
                              meta={editing.meta}
                              editMeta={(edits) =>
                                setEditing((e) => e && { ...e, meta: mergeMeta(e.meta, edits) })
                              }
                            />
                            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                              <Button type="submit" variant="primary" size="sm" loading={busy}>
                                Save
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                                Cancel
                              </Button>
                            </div>
                          </form>
                        </td>
                      </tr>
                    ) : (
                      <tr key={term.id}>
                        <td className={styles.titleCell}>
                          {term.depth > 0 && (
                            <span className={styles.depth}>{'— '.repeat(term.depth)}</span>
                          )}
                          <strong>{term.name}</strong>
                          {screen.base === 'categories' && term.id === defaultCategory && (
                            <>
                              {' '}
                              <Badge>Default</Badge>
                            </>
                          )}
                          {term.description && (
                            <div className={styles.meta}>{term.description}</div>
                          )}
                          {canManage && (
                            <div className={styles.rowActions}>
                              <button
                                type="button"
                                className={styles.rowAction}
                                onClick={() =>
                                  setEditing({
                                    id: term.id,
                                    errors: {},
                                    meta: term.meta ?? {},
                                    draft: {
                                      name: term.name,
                                      slug: term.slug,
                                      parent: term.parent ?? 0,
                                      description: term.description,
                                    },
                                  })
                                }
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className={styles.rowAction}
                                data-tone="danger"
                                onClick={() => setDeleting(term)}
                              >
                                Delete
                              </button>
                            </div>
                          )}
                        </td>
                        <td className={`${styles.meta} ${styles.hideNarrow}`}>{term.slug}</td>
                        <td className={styles.meta} style={{ textAlign: 'right' }}>
                          {screen.postsFilter && term.count > 0 ? (
                            <Link href={`/admin/posts?${screen.postsFilter}=${term.id}`}>
                              {term.count}
                            </Link>
                          ) : (
                            term.count
                          )}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete “${deleting?.name ?? ''}”?`}
        confirmLabel="Delete"
        busy={busy}
        onCancel={() => setDeleting(null)}
        onConfirm={remove}
      >
        {screen.hierarchical
          ? 'Posts only in this category move to the default category. Subcategories move up a level.'
          : 'The tag is removed from every post that uses it.'}
      </ConfirmDialog>
    </>
  );
}

/** Plugins' fields in the edit form (slot `term.edit-fields`, `{taxonomy}_edit_form_fields`). */
function TermPluginFields({
  term,
  meta,
  editMeta,
}: {
  term: RestTerm;
  meta: Record<string, unknown>;
  editMeta: (edits: Record<string, unknown>) => void;
}) {
  const fills = useFills(SLOTS.termEditFields).filter((fill) => appliesTo(fill, term.taxonomy));
  return (
    <>
      {fills.map((fill) => (
        <RenderFill
          key={fill.id}
          fill={fill}
          place="term fields"
          fillProps={{ taxonomy: term.taxonomy, term, meta, editMeta }}
        />
      ))}
    </>
  );
}
