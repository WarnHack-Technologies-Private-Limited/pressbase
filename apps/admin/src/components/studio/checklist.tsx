'use client';

import { store as blockEditorStore } from '@wordpress/block-editor';
import { useRegistry, useSelect } from '@wordpress/data';
import { CircleAlert, CircleCheck, ImageOff, RefreshCw, SquareDashed } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/context';
import { Button, Spinner } from '../ui/button';
import { ConfirmDialog } from '../ui/dialog';
import styles from './checklist.module.css';
import {
  blockAtPath,
  type Checklist,
  type ChecklistItem,
  type ChecklistKind,
  groupItems,
  holdsPlaceholder,
  itemKey,
  itemPlace,
  itemRegion,
  itemText,
  namedItems,
  totalLeft,
} from './checklist-model';
import type { Changeset } from './changes-model';
import type { AiCanvas } from './use-ai-edits';

/**
 * "Before you publish" (#61): the checklist of what's left in the draft —
 * placeholders to fill, images to choose, checks that failed — from
 * `GET /pressbase/v1/studio/checklist` (core/check-page over every page and
 * part in the changeset). Each item opens its page and selects its block.
 * Publishing with items left asks first and names them. Placeholders are
 * marked on the canvas (editor only; the public site is unchanged).
 * See docs/architecture/quality-checks.md#before-you-publish.
 */

export interface StudioChecklist {
  data: Checklist | null;
  loading: boolean;
  error: string | null;
  /** Saves the canvas to the draft, then checks it. */
  refresh(): Promise<Checklist | null>;
  /** Wraps Publish: with items left, asks first (resolves false when the person stays). */
  guard(publish: () => Promise<boolean>): Promise<boolean>;
  /** The confirmation waiting for an answer. */
  confirming: Checklist | null;
  answer(publish: boolean): void;
  /** The item to select once its page is on the canvas. */
  selecting: ChecklistItem | null;
  select(item: ChecklistItem | null): void;
}

export function useChecklist({
  saveNow,
  changesetUuid,
}: {
  saveNow: () => Promise<Changeset | null>;
  changesetUuid: string | null;
}): StudioChecklist {
  const [data, setData] = useState<Checklist | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Checklist | null>(null);
  const [selecting, setSelecting] = useState<ChecklistItem | null>(null);
  const answerRef = useRef<((publish: boolean) => void) | null>(null);
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const n = ++request.current;
    setLoading(true);
    try {
      const changeset = await saveNow();
      const uuid = changeset?.uuid ?? null;
      const next = uuid
        ? await api<Checklist>(`/pressbase/v1/studio/checklist?changeset_uuid=${uuid}`)
        : { changeset_uuid: null, items: [], counts: { placeholder: 0, image: 0, check: 0 }, checked: [] };
      if (n === request.current) {
        setData(next);
        setError(null);
      }
      return next;
    } catch (e) {
      if (n === request.current) setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      if (n === request.current) setLoading(false);
    }
  }, [saveNow]);

  // Published or discarded: nothing left to check.
  useEffect(() => {
    if (!changesetUuid) setData(null);
  }, [changesetUuid]);

  const guard = useCallback(
    async (publish: () => Promise<boolean>) => {
      const list = await refresh();
      // The check couldn't run: publishing stays the person's call, as without the checklist.
      if (!list || totalLeft(list) === 0) return publish();
      const go = await new Promise<boolean>((resolve) => {
        answerRef.current = resolve;
        setConfirming(list);
      });
      return go ? publish() : false;
    },
    [refresh],
  );

  const answer = useCallback((publish: boolean) => {
    setConfirming(null);
    answerRef.current?.(publish);
    answerRef.current = null;
  }, []);

  return {
    data,
    loading,
    error,
    refresh,
    guard,
    confirming,
    answer,
    selecting,
    select: setSelecting,
  };
}

const KIND_ICONS: Record<ChecklistKind, ReactNode> = {
  placeholder: <SquareDashed size={16} aria-hidden="true" />,
  image: <ImageOff size={16} aria-hidden="true" />,
  check: <CircleAlert size={16} aria-hidden="true" />,
};

/** The rail's Checklist panel. */
export function ChecklistPanel({
  checklist,
  onGo,
}: {
  checklist: StudioChecklist;
  onGo: (item: ChecklistItem) => void;
}) {
  const { __, _n, sprintf } = useI18n();
  const { data, loading, error, refresh } = checklist;

  // Checked when the panel opens.
  useEffect(() => {
    refresh();
  }, [refresh]);

  const headings: Record<ChecklistKind, (n: number) => string> = {
    placeholder: (n) =>
      sprintf(_n('%d placeholder to fill in', '%d placeholders to fill in', n, 'pressbase-admin'), n),
    image: (n) => sprintf(_n('%d image to choose', '%d images to choose', n, 'pressbase-admin'), n),
    check: (n) => sprintf(_n('%d check failed', '%d checks failed', n, 'pressbase-admin'), n),
  };
  const groups = data ? groupItems(data.items) : new Map();
  const left = totalLeft(data);

  return (
    <div className={styles.panel} aria-busy={loading || undefined}>
      <p className={styles.intro}>
        {__(
          'What’s left in your draft before visitors see it: gaps in [square brackets] that Pressbase left instead of guessing, images to choose, and checks that failed.',
          'pressbase-admin',
        )}
      </p>
      <div className={styles.toolbar}>
        <p role="status" className={styles.status}>
          {loading && !data
            ? __('Checking your draft…', 'pressbase-admin')
            : data && data.checked.length === 0
              ? __('Nothing in your draft yet.', 'pressbase-admin')
              : data && left === 0
                ? __('All clear: nothing left to fill in.', 'pressbase-admin')
                : data
                  ? sprintf(
                      _n(
                        '%d thing to look at before you publish',
                        '%d things to look at before you publish',
                        left,
                        'pressbase-admin',
                      ),
                      left,
                    )
                  : ''}
        </p>
        <Button
          size="sm"
          variant="ghost"
          icon={loading ? <Spinner /> : <RefreshCw size={16} aria-hidden="true" />}
          disabled={loading}
          onClick={() => refresh()}
        >
          {__('Check again', 'pressbase-admin')}
        </Button>
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {data && left === 0 && data.checked.length > 0 && (
        <p className={styles.clear}>
          <CircleCheck size={20} aria-hidden="true" />
          {sprintf(
            _n(
              'Checked %d page or part in your draft.',
              'Checked %d pages and parts in your draft.',
              data.checked.length,
              'pressbase-admin',
            ),
            data.checked.length,
          )}
        </p>
      )}
      {[...groups].map(([kind, items]: [ChecklistKind, ChecklistItem[]]) => (
        <section key={kind} className={styles.group} data-checklist-group={kind}>
          <h3 className={styles.groupTitle}>
            {KIND_ICONS[kind]}
            {headings[kind](items.length)}
          </h3>
          <ul className={styles.list}>
            {items.map((item, i) => (
              <li key={itemKey(item, i)}>
                <button
                  type="button"
                  className={styles.item}
                  data-kind={item.kind}
                  disabled={!item.block}
                  onClick={() => onGo(item)}
                >
                  <span className={styles.itemText}>{itemText(item, __, sprintf)}</span>
                  <span className={styles.itemPlace}>{itemPlace(item, __, sprintf)}</span>
                  {item.block && (
                    <span className="visually-hidden">
                      {__('Go to it on the page', 'pressbase-admin')}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Publish with items left: asks first, naming them. */
export function PublishCheckDialog({
  checklist,
  onGo,
}: {
  checklist: StudioChecklist;
  onGo: (item: ChecklistItem) => void;
}) {
  const { __, _n, sprintf } = useI18n();
  const list = checklist.confirming;
  const left = totalLeft(list);
  const { shown, more } = namedItems(list?.items ?? []);
  return (
    <ConfirmDialog
      open={Boolean(list)}
      tone="primary"
      title={sprintf(
        _n(
          'Publish with %d thing left to fill in?',
          'Publish with %d things left to fill in?',
          left,
          'pressbase-admin',
        ),
        left,
      )}
      confirmLabel={__('Publish anyway', 'pressbase-admin')}
      onCancel={() => checklist.answer(false)}
      onConfirm={() => checklist.answer(true)}
    >
      <p>
        {__(
          'Visitors will see these as they are. Fill them in first, or publish now and come back to them.',
          'pressbase-admin',
        )}
      </p>
      <ul className={styles.confirmList} data-publish-checklist>
        {shown.map((item, i) => (
          <li key={itemKey(item, i)}>
            {item.block ? (
              <button
                type="button"
                className={styles.confirmItem}
                onClick={() => {
                  checklist.answer(false);
                  onGo(item);
                }}
              >
                {itemText(item, __, sprintf)}
              </button>
            ) : (
              itemText(item, __, sprintf)
            )}{' '}
            <span className={styles.itemPlace}>{itemPlace(item, __, sprintf)}</span>
          </li>
        ))}
        {more > 0 && (
          <li>{sprintf(_n('and %d more', 'and %d more', more, 'pressbase-admin'), more)}</li>
        )}
      </ul>
    </ConfirmDialog>
  );
}

/** A line in the Publish list: what's left, and a way to the checklist. */
export function PublishChecklistNote({
  checklist,
  onOpen,
}: {
  checklist: StudioChecklist;
  onOpen: () => void;
}) {
  const { __, _n, sprintf } = useI18n();
  const left = totalLeft(checklist.data);
  if (!checklist.data || left === 0) return null;
  return (
    <p className={styles.publishNote}>
      <CircleAlert size={16} aria-hidden="true" />
      <span>
        {sprintf(
          _n(
            '%d thing to fill in before you publish.',
            '%d things to fill in before you publish.',
            left,
            'pressbase-admin',
          ),
          left,
        )}{' '}
        <button type="button" className={styles.link} onClick={onOpen}>
          {__('See the checklist', 'pressbase-admin')}
        </button>
      </span>
    </p>
  );
}

/* ------------------------------------------------------------ the canvas */

const PLACEHOLDER_STYLE = 'pressbase-placeholders';
const canvasDocument = () =>
  document.querySelector<HTMLIFrameElement>('iframe[name="editor-canvas"]')?.contentDocument ?? null;

/**
 * Marks blocks holding a placeholder (`[Add a customer quote]`) on the
 * canvas, so none is missed. A stylesheet in the editor's iframe only:
 * nothing is added to the blocks, so the public site never shows it.
 */
export function PlaceholderMarks() {
  const ids = useSelect((select) => {
    const s = select(blockEditorStore) as unknown as {
      getClientIdsWithDescendants: () => string[];
      getBlockName: (id: string) => string | null;
      getBlockAttributes: (id: string) => Record<string, unknown> | null;
    };
    return s
      .getClientIdsWithDescendants()
      .filter((id) => holdsPlaceholder(s.getBlockName(id) ?? '', s.getBlockAttributes(id) ?? {}))
      .join(',');
  }, []);
  useEffect(() => {
    const list = ids ? ids.split(',') : [];
    const paint = () => {
      const doc = canvasDocument();
      if (!doc?.head) return;
      let style = doc.getElementById(PLACEHOLDER_STYLE);
      if (!list.length) {
        style?.remove();
        return;
      }
      if (!style) {
        style = doc.createElement('style');
        style.id = PLACEHOLDER_STYLE;
        doc.head.append(style);
      }
      const selectors = list.map((id) => `[data-block="${CSS.escape(id)}"]`);
      style.textContent = `${selectors.join(',\n')} {
  outline: 2px dashed #b26200 !important;
  outline-offset: 2px;
  background-color: rgb(240 184 73 / 0.22) !important;
  border-radius: 2px;
}`;
    };
    paint();
    // The canvas iframe may be redrawn (another page, a device).
    const timer = list.length ? setInterval(paint, 1000) : undefined;
    return () => {
      if (timer) clearInterval(timer);
      canvasDocument()?.getElementById(PLACEHOLDER_STYLE)?.remove();
    };
  }, [ids]);
  return null;
}

/**
 * Selects the checklist's chosen block once its page is on the canvas, and
 * scrolls it into view. Inside the editor (it uses the canvas's store).
 */
export function ChecklistSelect({
  checklist,
  canvas,
  onNotFound,
}: {
  checklist: StudioChecklist;
  canvas: AiCanvas | null;
  onNotFound: () => void;
}) {
  const registry = useRegistry();
  const item = checklist.selecting;
  const { select } = checklist;
  useEffect(() => {
    if (!item || !canvas) return;
    const blocks = canvas.regions().get(itemRegion(item));
    // Another page is opening: wait for its canvas.
    if (!blocks) return;
    select(null);
    const found = item.block ? blockAtPath(blocks, item.block.path) : null;
    if (!found) {
      onNotFound();
      return;
    }
    (registry.dispatch(blockEditorStore) as unknown as { selectBlock: (id: string) => void })
      .selectBlock(found.clientId);
    let tries = 0;
    const scroll = () => {
      const element = canvasDocument()?.querySelector(`[data-block="${CSS.escape(found.clientId)}"]`);
      if (element) element.scrollIntoView({ block: 'center', behavior: 'smooth' });
      else if (tries++ < 10) setTimeout(scroll, 200);
    };
    scroll();
  }, [item, canvas, registry, select, onNotFound]);
  return null;
}
