'use client';

import { BlockPreview } from '@wordpress/block-editor';
import { getBlockType, parse, serialize } from '@wordpress/blocks';
import { FileText, History, Palette, RotateCcw } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { GlobalStylesConfig, GlobalStylesRevision } from '@/lib/global-styles';
import { configsEqual } from '@/lib/global-styles';
import { useI18n } from '@/lib/i18n/context';
import { StylePreview } from '../appearance/style-preview';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import type { CanvasBlock } from './canvas-model';
import { blockNoun, describeEdit, editLabel, type HistoryEntry } from './history-model';
import styles from './studio.module.css';

/** What a history point holds: the canvas's blocks and selection (StudioEditor). */
export interface CanvasValue {
  blocks: unknown[];
  selection?: unknown;
}

/** A page revision as /wp/v2/pages/{id}/revisions gives it (the fields History reads). */
interface PageRevision {
  id: number;
  author: number;
  date_gmt: string;
  content: { raw: string };
}

export interface HistoryPanelProps {
  entries: readonly HistoryEntry<CanvasValue>[];
  index: number;
  onGo: (index: number) => void;
  /** Template part names, by slug ("Header"). */
  partTitle: (slug: string) => string;
  /** The page on the canvas, when it's saved (a page the draft adds has no versions yet). */
  page?: { id: number; title: string; live: string };
  /** Puts a version of the page on the canvas, as one step; the draft saves it. */
  onRestorePage: (content: string, when: string) => void;
  /** Whether this person may change the site's styles (`edit_theme_options`). */
  canEditStyles: boolean;
  /** Puts a version of the site's styles in the draft. */
  onRestoreStyles: (stylesheet: string, config: GlobalStylesConfig, when: string) => void;
  /** The site's address, for the styles preview. */
  siteUrl: string;
  userId: number;
}

const selectedOf = (value: CanvasValue | undefined) =>
  (value?.selection as { selectionStart?: { clientId?: string } } | undefined)?.selectionStart
    ?.clientId;

/** Names worked out once per pair of points. */
const labels = new WeakMap<object, string>();

/**
 * The History panel (#34): this session's steps on this page, newest
 * first, each in plain words; click one to go back (or forward) to it.
 * Below, the published versions of the page and of the site's styles, each
 * with Preview and Restore. Restoring puts that version in the draft, so
 * nothing changes for visitors until Publish.
 */
export function HistoryPanel(props: HistoryPanelProps) {
  const { __, _n, sprintf, locale } = useI18n();
  const time = useMemo(
    () => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }),
    [],
  );

  const stepLabel = (i: number): string => {
    const entry = props.entries[i] as HistoryEntry<CanvasValue>;
    if (i === 0) return __('Opened the page', 'pressbase-admin');
    if (entry.label) return entry.label;
    const cached = labels.get(entry);
    if (cached) return cached;
    const before = props.entries[i - 1]?.value.blocks as CanvasBlock[];
    const label = editLabel(
      describeEdit(before, entry.value.blocks as CanvasBlock[], selectedOf(entry.value)),
      {
        block: (name) => blockNoun(getBlockType(name)?.title ?? name, locale),
        part: props.partTitle,
      },
      { __, _n, sprintf },
    );
    labels.set(entry, label);
    return label;
  };

  const steps = props.entries.map((entry, i) => ({ i, at: entry.at })).reverse();

  return (
    <div className={styles.historyPanel}>
      <section aria-labelledby="studio-history-steps">
        <h3 id="studio-history-steps" className={styles.historyHeading}>
          {__('This session', 'pressbase-admin')}
        </h3>
        <p className={styles.muted}>
          {props.entries.length > 1
            ? __(
                'Your changes to this page since you opened it. Choose one to go back to that point.',
                'pressbase-admin',
              )
            : __('Your changes to this page show here as you make them.', 'pressbase-admin')}
        </p>
        <ol className={styles.historySteps}>
          {steps.map(({ i, at }) => {
            const current = i === props.index;
            const undone = i > props.index;
            const label = stepLabel(i);
            return (
              <li key={`${i}-${at}`}>
                <button
                  type="button"
                  className={styles.historyStep}
                  data-undone={undone || undefined}
                  aria-current={current ? 'step' : undefined}
                  aria-label={
                    current
                      ? sprintf(__('%s (now)', 'pressbase-admin'), label)
                      : undone
                        ? sprintf(__('%s (undone)', 'pressbase-admin'), label)
                        : sprintf(__('Go back to: %s', 'pressbase-admin'), label)
                  }
                  onClick={() => props.onGo(i)}
                >
                  <span className={styles.historyLabel}>{label}</span>
                  <span className={styles.historyMeta}>
                    {current
                      ? __('Now', 'pressbase-admin')
                      : undone
                        ? __('Undone', 'pressbase-admin')
                        : time.format(at)}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </section>

      {props.page && (
        <PageVersions page={props.page} userId={props.userId} onRestore={props.onRestorePage} />
      )}
      {props.canEditStyles && (
        <StyleVersions
          siteUrl={props.siteUrl}
          userId={props.userId}
          onRestore={props.onRestoreStyles}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------- shared bits */

const gmt = (date: string) => new Date(date.endsWith('Z') ? date : `${date}Z`);

function useWhen() {
  return useMemo(() => {
    const format = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    return (date: string) => format.format(gmt(date));
  }, []);
}

/** Names of the people who published versions, other than the person here. */
function useAuthors(ids: readonly number[], userId: number): Record<number, string> {
  const [names, setNames] = useState<Record<number, string>>({});
  const key = [...new Set(ids)].filter((id) => id && id !== userId).join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    api<{ id: number; name: string }[]>(`/wp/v2/users?include=${key}&per_page=100`)
      .then((users) => live && setNames(Object.fromEntries(users.map((u) => [u.id, u.name]))))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key]);
  return names;
}

function VersionList({
  id,
  title,
  icon,
  intro,
  state,
  onRetry,
  children,
  dialog,
}: {
  /** The preview, outside the list. */
  dialog: ReactNode;
  id: string;
  title: string;
  icon: ReactNode;
  intro: string;
  state: 'loading' | 'failed' | 'empty' | 'ready';
  onRetry: () => void;
  children: ReactNode;
}) {
  const { __ } = useI18n();
  return (
    <section aria-labelledby={id} className={styles.historyVersions}>
      <h3 id={id} className={styles.historyHeading}>
        {icon}
        {title}
      </h3>
      <p className={styles.muted}>{intro}</p>
      {state === 'loading' && (
        <p className={styles.muted} aria-busy="true">
          {__('Loading…', 'pressbase-admin')}
        </p>
      )}
      {state === 'failed' && (
        <p className={styles.historyFailed} role="alert">
          {__('The published versions couldn’t load.', 'pressbase-admin')}{' '}
          <button type="button" className={styles.partNoteLink} onClick={onRetry}>
            {__('Try again', 'pressbase-admin')}
          </button>
        </p>
      )}
      {state === 'empty' && (
        <p className={styles.muted}>{__('Nothing published yet.', 'pressbase-admin')}</p>
      )}
      {state === 'ready' && <ol className={styles.versionList}>{children}</ol>}
      {dialog}
    </section>
  );
}

function VersionRow({
  when,
  meta,
  live,
  onPreview,
  onRestore,
  name,
}: {
  when: string;
  meta: string;
  live: boolean;
  onPreview: () => void;
  onRestore: () => void;
  /** What the buttons are about, for screen readers ("the version from May 2, 10:04"). */
  name: string;
}) {
  const { __, sprintf } = useI18n();
  return (
    <li className={styles.version}>
      <History size={16} aria-hidden="true" className={styles.versionIcon} />
      <span className={styles.versionText}>
        <span className={styles.versionDate}>{when}</span>
        <span className={styles.versionMeta}>{meta}</span>
      </span>
      <span className={styles.versionActions}>
        <Button
          size="sm"
          variant="ghost"
          aria-label={sprintf(__('Preview %s', 'pressbase-admin'), name)}
          onClick={onPreview}
        >
          {__('Preview', 'pressbase-admin')}
        </Button>
        {live ? (
          <span className={styles.versionLive}>{__('Live now', 'pressbase-admin')}</span>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            icon={<RotateCcw size={14} aria-hidden="true" />}
            aria-label={sprintf(__('Restore %s', 'pressbase-admin'), name)}
            onClick={onRestore}
          >
            {__('Restore', 'pressbase-admin')}
          </Button>
        )}
      </span>
    </li>
  );
}

const by = (
  author: number,
  userId: number,
  names: Record<number, string>,
  __: (text: string, domain: string) => string,
  sprintf: (format: string, ...args: string[]) => string,
) =>
  author === userId
    ? __('Published by you', 'pressbase-admin')
    : names[author]
      ? sprintf(__('Published by %s', 'pressbase-admin'), names[author] as string)
      : __('Published by someone else', 'pressbase-admin');

/* ---------------------------------------------------------------- the page */

const normalized = (markup: string) => serialize(parse(markup));

function PageVersions({
  page,
  userId,
  onRestore,
}: {
  page: { id: number; title: string; live: string };
  userId: number;
  onRestore: (content: string, when: string) => void;
}) {
  const { __, sprintf } = useI18n();
  const when = useWhen();
  const [revisions, setRevisions] = useState<PageRevision[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<PageRevision | null>(null);

  const load = useCallback(() => {
    setFailed(false);
    setRevisions(null);
    api<PageRevision[]>(`/wp/v2/pages/${page.id}/revisions?context=edit`)
      .then(setRevisions)
      .catch(() => setFailed(true));
  }, [page.id]);
  useEffect(load, [load]);
  const names = useAuthors(revisions?.map((r) => r.author) ?? [], userId);
  const live = useMemo(() => normalized(page.live), [page.live]);
  const previewBlocks = useMemo(() => (preview ? parse(preview.content.raw) : []), [preview]);

  return (
    <VersionList
      id="studio-history-page"
      title={sprintf(__('Versions of %s', 'pressbase-admin'), page.title)}
      icon={<FileText size={16} aria-hidden="true" />}
      intro={__(
        'Each time the page was published. Restore one to put it back on the canvas; visitors see it once you publish.',
        'pressbase-admin',
      )}
      state={failed ? 'failed' : !revisions ? 'loading' : revisions.length ? 'ready' : 'empty'}
      onRetry={load}
      dialog={
        <Dialog
          open={preview !== null}
          size="large"
          title={
            preview
              ? sprintf(
                  __('%1$s, as published %2$s', 'pressbase-admin'),
                  page.title,
                  when(preview.date_gmt),
                )
              : ''
          }
          onClose={() => setPreview(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPreview(null)}>
                {__('Close', 'pressbase-admin')}
              </Button>
              {preview && (
                <Button
                  variant="primary"
                  icon={<RotateCcw size={16} aria-hidden="true" />}
                  onClick={() => {
                    onRestore(preview.content.raw, when(preview.date_gmt));
                    setPreview(null);
                  }}
                >
                  {__('Restore this version', 'pressbase-admin')}
                </Button>
              )}
            </>
          }
        >
          <div className={styles.versionPreview}>
            <BlockPreview blocks={previewBlocks} viewportWidth={1200} />
          </div>
        </Dialog>
      }
    >
      {revisions?.map((revision, i) => {
        const date = when(revision.date_gmt);
        const isLive = i === 0 && normalized(revision.content.raw) === live;
        return (
          <VersionRow
            key={revision.id}
            when={date}
            meta={by(revision.author, userId, names, __, sprintf)}
            live={isLive}
            name={sprintf(__('the version from %s', 'pressbase-admin'), date)}
            onPreview={() => setPreview(revision)}
            onRestore={() => onRestore(revision.content.raw, date)}
          />
        );
      })}
    </VersionList>
  );
}

/* -------------------------------------------------------- the site's styles */

type ThemeWithLinks = { stylesheet: string; _links?: Record<string, { href: string }[]> };

function StyleVersions({
  siteUrl,
  userId,
  onRestore,
}: {
  siteUrl: string;
  userId: number;
  onRestore: (stylesheet: string, config: GlobalStylesConfig, when: string) => void;
}) {
  const { __, sprintf } = useI18n();
  const when = useWhen();
  const [data, setData] = useState<{
    stylesheet: string;
    revisions: GlobalStylesRevision[];
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<GlobalStylesRevision | null>(null);

  const load = useCallback(() => {
    setFailed(false);
    setData(null);
    (async () => {
      const [theme] = await api<ThemeWithLinks[]>('/wp/v2/themes?status=active');
      const href = theme?._links?.['wp:user-global-styles']?.[0]?.href;
      const id = href ? Number(href.split('/').pop()) : 0;
      if (!theme || !id) return { stylesheet: theme?.stylesheet ?? '', revisions: [] };
      const revisions = await api<GlobalStylesRevision[]>(
        `/wp/v2/global-styles/${id}/revisions?per_page=20`,
      );
      return { stylesheet: theme.stylesheet, revisions };
    })()
      .then(setData)
      .catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);
  const names = useAuthors(data?.revisions.map((r) => r.author) ?? [], userId);
  const restore = (revision: GlobalStylesRevision) =>
    data &&
    onRestore(
      data.stylesheet,
      { styles: revision.styles ?? {}, settings: revision.settings ?? {} },
      when(revision.date_gmt),
    );

  return (
    <VersionList
      id="studio-history-styles"
      title={__('Versions of the site’s styles', 'pressbase-admin')}
      icon={<Palette size={16} aria-hidden="true" />}
      intro={__(
        'Colours, fonts and spacing, each time they were saved. Restoring one puts it in your draft for every page.',
        'pressbase-admin',
      )}
      state={failed ? 'failed' : !data ? 'loading' : data.revisions.length ? 'ready' : 'empty'}
      onRetry={load}
      dialog={
        <Dialog
          open={preview !== null}
          size="large"
          title={
            preview
              ? sprintf(__('The site’s styles from %s', 'pressbase-admin'), when(preview.date_gmt))
              : ''
          }
          onClose={() => setPreview(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPreview(null)}>
                {__('Close', 'pressbase-admin')}
              </Button>
              {preview && data?.revisions[0]?.id !== preview.id && (
                <Button
                  variant="primary"
                  icon={<RotateCcw size={16} aria-hidden="true" />}
                  onClick={() => {
                    restore(preview);
                    setPreview(null);
                  }}
                >
                  {__('Restore these styles', 'pressbase-admin')}
                </Button>
              )}
            </>
          }
        >
          <div className={styles.versionPreview}>
            {preview && <StylePreview config={preview} home={siteUrl} />}
          </div>
        </Dialog>
      }
    >
      {data?.revisions.map((revision, i) => {
        const date = when(revision.date_gmt);
        const empty = configsEqual(revision, {});
        return (
          <VersionRow
            key={revision.id}
            when={date}
            meta={`${empty ? __('Theme defaults', 'pressbase-admin') : __('Custom styles', 'pressbase-admin')} · ${by(revision.author, userId, names, __, sprintf)}`}
            live={i === 0}
            name={sprintf(__('the styles from %s', 'pressbase-admin'), date)}
            onPreview={() => setPreview(revision)}
            onRestore={() => restore(revision)}
          />
        );
      })}
    </VersionList>
  );
}
