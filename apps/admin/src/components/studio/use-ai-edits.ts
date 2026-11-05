'use client';

import { type Block as BlockInstance, parse, serialize } from '@wordpress/blocks';
import { useRegistry } from '@wordpress/data';
import { useCallback, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/context';
import {
  type ApplyProblem,
  type BlockCodec,
  type EditPattern,
  type EditPlan,
  planEdits,
} from './ai-edits-model';
import { pageKey } from './changes-model';
import { newPageEntry, newPageLink, pageRefKey } from './pages-model';
import { isNewPage, type PageRef, type StudioPage } from './site-model';
import type { Draft } from './use-draft';

/**
 * Applying AI edits in Studio (#57): a set of operations, planned against
 * the canvas and the draft (ai-edits-model.ts), goes in as one step — the
 * canvas's regions in one undo step named after the set, other pages, new
 * pages and the site styles as draft entries, the header menu in core-data
 * as the Navigation block edits it. The changed blocks are highlighted, and
 * the set waits for Keep or Undo. Nothing is written anywhere but the
 * draft, which saves itself as for any edit. See docs/architecture/ai-edits.md.
 */

/** What the applier needs from the open canvas (StudioEditor gives it). */
export interface AiCanvas {
  /** The canvas's identity: another page opens a new canvas, with new block IDs. */
  key: string;
  /** Each region's blocks now, by draft key (`page:12`, `wp_template_part:header`). */
  regions(): Map<string, BlockInstance[]>;
  /** Replaces regions' blocks as one undo step, named `label`; the step's place in History. */
  replace(next: ReadonlyMap<string, BlockInstance[]>, label: string): number | null;
  /** Where History is now. */
  step(): number;
  undo(): void;
  /** The menu the header shows: its Navigation block's, or the site's fallback menu. */
  menuId(): number | null;
}

/** A set of changes to apply: from the AI panel, or a command. */
export interface AiProposal {
  /** The assistant message it came with, to tell core what the person did. */
  id?: string;
  summary: string;
  operations: unknown;
  /** The draft entry its style changes make, as core resolved it. */
  styles?: { key: string; value: Record<string, unknown> } | null;
}

export interface PendingSet {
  id?: string;
  summary: string;
  canvasKey: string | null;
  /** Blocks to highlight on the canvas. */
  highlight: string[];
  /** The History step the set made on the canvas, if it changed it. */
  step: number | null;
  /** Content replaced sections had no place for. */
  unused: string[];
  before: {
    regions: Map<string, BlockInstance[]>;
    entries: Map<string, unknown>;
    menu: { id: number; content: string } | null;
  };
}

export type ApplyResult = { ok: true; pending: PendingSet } | { ok: false; problem: ApplyProblem };

const codec: BlockCodec<BlockInstance> = {
  toMarkup: (blocks) => serialize(blocks),
  fromMarkup: (markup) => parse(markup),
};

let patternsRequest: Promise<Map<string, EditPattern>> | null = null;
/** The site's patterns, once per visit (they don't change while Studio is open). */
function loadPatterns(): Promise<Map<string, EditPattern>> {
  patternsRequest ??= api<EditPattern[]>('/wp/v2/block-patterns/patterns')
    .then((list) => new Map(list.map((p) => [p.name, p])))
    .catch((error) => {
      patternsRequest = null;
      throw error;
    });
  return patternsRequest;
}

interface CoreData {
  getEditedEntityRecord: (kind: string, name: string, key: unknown) => Record<string, unknown>;
}
interface CoreDataActions {
  editEntityRecord: (
    kind: string,
    name: string,
    key: unknown,
    edits: Record<string, unknown>,
    options?: { undoIgnore?: boolean },
  ) => void;
}

const raw = (value: unknown) =>
  value && typeof value === 'object' && 'raw' in value ? (value as { raw: unknown }).raw : value;

const sameRef = (a: PageRef, b: PageRef) => String(a) === String(b);

export interface AiEdits {
  pending: PendingSet | null;
  /** What the person did with each set this visit, by message ID. */
  outcomes: Readonly<Record<string, 'kept' | 'undone'>>;
  /** Applies a set (when another is waiting, that one is kept first). */
  apply(canvas: AiCanvas | null, proposal: AiProposal): Promise<ApplyResult>;
  keep(): void;
  undo(canvas: AiCanvas | null): void;
}

export function useAiEdits({
  draft,
  pages,
  siteUrl,
  open,
  can,
}: {
  draft: Draft;
  /** The pages as the draft leaves them. */
  pages: readonly StudioPage[];
  siteUrl: string;
  /** The page on the canvas. */
  open: { id: PageRef; slug: string } | null;
  can: { styles: boolean; parts: boolean; pages: boolean };
}): AiEdits {
  const { __, sprintf } = useI18n();
  const registry = useRegistry();
  const [pending, setPending] = useState<PendingSet | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, 'kept' | 'undone'>>({});
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const latest = useRef({ draft, pages, siteUrl, open, can });
  latest.current = { draft, pages, siteUrl, open, can };

  const report = useCallback((id: string | undefined, outcome: 'kept' | 'undone') => {
    if (!id) return;
    setOutcomes((current) => ({ ...current, [id]: outcome }));
    const uuid = latest.current.draft.changeset?.uuid;
    api(`/pressbase/v1/studio/ai/messages/${id}`, {
      method: 'POST',
      body: { outcome, ...(uuid ? { changeset_uuid: uuid } : {}) },
    }).catch(() => {});
  }, []);

  const core = useCallback(() => {
    try {
      return {
        select: registry.select('core') as unknown as CoreData,
        dispatch: registry.dispatch('core') as unknown as CoreDataActions,
        resolve: registry.resolveSelect('core') as unknown as {
          getEntityRecord: (kind: string, name: string, key: unknown) => Promise<unknown>;
        },
      };
    } catch {
      return null;
    }
  }, [registry]);

  const keep = useCallback(() => {
    const set = pendingRef.current;
    if (!set) return;
    setPending(null);
    report(set.id, 'kept');
  }, [report]);

  const undo = useCallback(
    (canvas: AiCanvas | null) => {
      const set = pendingRef.current;
      if (!set) return;
      setPending(null);
      const { draft: current } = latest.current;
      if (set.before.regions.size && canvas && canvas.key === set.canvasKey) {
        if (set.step !== null && canvas.step() === set.step) canvas.undo();
        else canvas.replace(set.before.regions, __('Undid the changes from AI', 'pressbase-admin'));
      }
      if (set.before.entries.size) {
        current.want(
          new Map([...set.before.entries].map(([key, value]) => [key, value ?? null] as const)),
        );
      }
      if (set.before.menu) {
        const { id, content } = set.before.menu;
        core()?.dispatch.editEntityRecord('postType', 'wp_navigation', id, {
          content,
          blocks: parse(content),
        });
      }
      report(set.id, 'undone');
    },
    [__, core, report],
  );

  const apply = useCallback(
    async (canvas: AiCanvas | null, proposal: AiProposal): Promise<ApplyResult> => {
      // A set still waiting is kept: the person moved on to the next request.
      if (pendingRef.current) keep();
      const {
        draft: current,
        pages: all,
        siteUrl: site,
        open: page,
        can: allowed,
      } = latest.current;
      const patterns = await loadPatterns();
      const regions = canvas?.regions() ?? new Map<string, BlockInstance[]>();
      const pageRegion = page ? pageKey(page.id) : null;

      // Other pages the set changes: their content as the draft leaves it.
      const others = new Map<PageRef, { key: string; content: string }>();
      const operations = Array.isArray(proposal.operations) ? proposal.operations : [];
      for (const operation of operations as { page?: PageRef; type?: string }[]) {
        const ref = operation?.page;
        if (ref === undefined || (page && (sameRef(ref, page.id) || sameRef(ref, page.slug)))) {
          continue;
        }
        const found = all.find((p) => sameRef(p.id, ref) || p.slug === String(ref));
        if (!found || others.has(ref)) continue;
        const key = pageRefKey(found.id);
        const drafted = (current.entries[key]?.value as { content?: unknown } | undefined)?.content;
        let content = typeof drafted === 'string' ? drafted : '';
        if (typeof drafted !== 'string' && !isNewPage(found.id)) {
          const fetched = await api<{ content: { raw?: string } }>(
            `/wp/v2/pages/${found.id}?context=edit`,
          );
          content = fetched.content.raw ?? '';
        }
        others.set(ref, { key, content });
      }

      const parts = new Map<string, { key: string; blocks: BlockInstance[] }>();
      for (const [key, blocks] of regions) {
        if (key.startsWith('wp_template_part:')) {
          parts.set(key.slice('wp_template_part:'.length), { key, blocks });
        }
      }
      const result = planEdits(proposal.operations, {
        codec,
        patterns,
        open:
          page && pageRegion && regions.has(pageRegion)
            ? {
                id: page.id,
                slug: page.slug,
                key: pageRegion,
                sections: regions.get(pageRegion) ?? [],
              }
            : null,
        parts,
        pages: others,
        pageUrl: (slug) => {
          const found = all.find((p) => p.slug === slug);
          if (!found) return null;
          const link = isNewPage(found.id) ? newPageLink(site, all, found.id) : found.link;
          try {
            const url = new URL(link, site);
            return `${url.pathname}${url.search}`;
          } catch {
            return null;
          }
        },
        newPage: (title, slug) => {
          const entry = newPageEntry(title, all);
          const free = slug && !all.some((p) => p.slug === slug) ? slug : entry.slug;
          return {
            key: pageRefKey(free),
            slug: free,
            fields: entry.value as unknown as Record<string, unknown>,
          };
        },
        can: allowed,
      });
      if ('problem' in result) return { ok: false, problem: result.problem };
      const plan: EditPlan<BlockInstance> = result.plan;

      // Everything the set needs, before anything changes.
      if (plan.regions.size && !canvas) {
        return { ok: false, problem: { code: 'no_page', page: String(page?.slug ?? '') } };
      }
      let styles = proposal.styles ?? null;
      if (plan.styles && !styles) {
        // A set made elsewhere (a command): core works out the styles it makes.
        const input = {
          summary: proposal.summary || 'Style changes',
          operations: operations.filter(
            (o) => (o as { type?: string })?.type === 'setGlobalStyles',
          ),
          ...(current.changeset?.uuid ? { changeset_uuid: current.changeset.uuid } : {}),
        };
        try {
          const checked = await api<{ styles?: AiProposal['styles'] }>(
            `/wp-abilities/v1/abilities/core/propose-site-edits/run?input=${encodeURIComponent(JSON.stringify(input))}`,
          );
          styles = checked.styles ?? null;
        } catch (error) {
          return {
            ok: false,
            problem: { code: 'invalid', message: error instanceof Error ? error.message : '' },
          };
        }
      }
      let menu: { id: number; content: string } | null = null;
      const data = plan.menu !== null ? core() : null;
      if (plan.menu !== null) {
        const id = canvas?.menuId() ?? null;
        if (!id || !data) return { ok: false, problem: { code: 'no_menu' } };
        await data.resolve.getEntityRecord('postType', 'wp_navigation', id).catch(() => null);
        const record = data.select.getEditedEntityRecord('postType', 'wp_navigation', id) ?? {};
        const blocks = record.blocks as BlockInstance[] | undefined;
        menu = {
          id,
          content: Array.isArray(blocks) ? serialize(blocks) : String(raw(record.content) ?? ''),
        };
      }

      // Apply: the canvas first (one undo step), then the draft and the menu.
      const before: PendingSet['before'] = { regions: new Map(), entries: new Map(), menu };
      for (const key of plan.regions.keys()) before.regions.set(key, regions.get(key) ?? []);
      const label = sprintf(__('Changes from AI: %s', 'pressbase-admin'), proposal.summary);
      const step = plan.regions.size && canvas ? canvas.replace(plan.regions, label) : null;
      const entries = new Map<string, unknown>();
      for (const [key, fields] of plan.fields) {
        before.entries.set(key, current.entries[key]?.value ?? null);
        const previous = current.entries[key]?.value;
        entries.set(key, {
          ...(previous && typeof previous === 'object' ? previous : {}),
          ...fields,
        });
      }
      if (styles) {
        before.entries.set(styles.key, current.entries[styles.key]?.value ?? null);
        entries.set(styles.key, styles.value);
      }
      if (entries.size) current.want(entries);
      if (menu && plan.menu !== null) {
        data?.dispatch.editEntityRecord('postType', 'wp_navigation', menu.id, {
          content: plan.menu,
          blocks: parse(plan.menu),
        });
      }
      const set: PendingSet = {
        id: proposal.id,
        summary: proposal.summary,
        canvasKey: canvas?.key ?? null,
        highlight: plan.highlight,
        step,
        unused: plan.unused,
        before,
      };
      setPending(set);
      return { ok: true, pending: set };
    },
    [__, sprintf, core, keep],
  );

  return { pending, outcomes, apply, keep, undo };
}
