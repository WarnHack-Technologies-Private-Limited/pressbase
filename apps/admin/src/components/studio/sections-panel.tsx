'use client';

import { BlockPreview, store as blockEditorStore } from '@wordpress/block-editor';
import { type Block as BlockInstance, getBlockType, parse } from '@wordpress/blocks';
import { useDispatch, useRegistry, useSelect } from '@wordpress/data';
import { LayoutPanelTop, X } from 'lucide-react';
import { type DragEvent, memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/context';
import { Button } from '../ui/button';
import { type CanvasBlock, findRegions } from './canvas-model';
import {
  groupSections,
  type RestPattern,
  type RestPatternCategory,
  type Section,
  sectionCategories,
  sectionsOf,
} from './sections-model';
import styles from './studio.module.css';

/** The patterns and their categories, loaded once per visit (they change only with the theme or plugins). */
let library: Promise<{ sections: Section[]; categories: RestPatternCategory[] }> | null = null;
export function loadSectionLibrary() {
  library ??= Promise.all([
    api<RestPattern[]>('/wp/v2/block-patterns/patterns'),
    api<RestPatternCategory[]>('/wp/v2/block-patterns/categories'),
  ])
    .then(([patterns, categories]) => ({ sections: sectionsOf(patterns), categories }))
    .catch((error) => {
      library = null;
      throw error;
    });
  return library;
}

interface StoreSelectors {
  getBlocks: () => BlockInstance[];
  getBlockName: (clientId: string) => string | null;
  getBlockAttributes: (clientId: string) => Record<string, unknown> | null;
  getBlockOrder: (rootClientId?: string) => string[];
  getBlockParents: (clientId: string) => string[];
  getSelectedBlockClientId: () => string | null;
}

/** The page's content block (core/post-content) on the canvas, whose children are its sections. */
export function contentRootId(select: Pick<StoreSelectors, 'getBlocks'>): string | null {
  const tree = select.getBlocks() as unknown as CanvasBlock[];
  return findRegions(tree).find((region) => region.kind === 'content')?.clientId ?? null;
}

/** The top-level section a block sits in (or is), if it's in the page's content. */
export function sectionOf(
  select: Pick<StoreSelectors, 'getBlockParents'>,
  root: string,
  clientId: string,
): string | null {
  const chain = [...select.getBlockParents(clientId), clientId];
  const at = chain.indexOf(root);
  return at >= 0 ? (chain[at + 1] ?? null) : null;
}

/** What a section is called: its name in Layers (`metadata.name`), else its block's title. */
export function sectionLabel(
  select: Pick<StoreSelectors, 'getBlockName' | 'getBlockAttributes'>,
  clientId: string,
): string {
  const name = (select.getBlockAttributes(clientId)?.metadata as { name?: unknown } | undefined)
    ?.name;
  if (typeof name === 'string' && name) return name;
  const type = select.getBlockName(clientId);
  return (type && getBlockType(type)?.title) || type || '';
}

/**
 * Adds a section to the page: at `insertAt` among the page's sections, else
 * after the selected section, else last. One undo step. Null when the
 * canvas has no page content (the latest posts). Shared by the Sections
 * panel and the command palette (#33).
 */
export function useAddSection(): ((section: Section, insertAt?: number | null) => void) | null {
  const registry = useRegistry();
  const { insertBlocks } = useDispatch(blockEditorStore) as unknown as {
    insertBlocks: (
      blocks: BlockInstance[],
      index?: number,
      rootClientId?: string,
      updateSelection?: boolean,
    ) => void;
  };
  const root = useSelect(
    (select) => contentRootId(select(blockEditorStore) as unknown as StoreSelectors),
    [],
  );
  if (!root) return null;
  return (section, insertAt = null) => {
    const select = registry.select(blockEditorStore) as unknown as StoreSelectors;
    const order = select.getBlockOrder(root);
    let index = order.length;
    if (insertAt !== null) index = Math.min(insertAt, order.length);
    else {
      const selected = select.getSelectedBlockClientId();
      const current = selected ? sectionOf(select, root, selected) : null;
      if (current) index = order.indexOf(current) + 1;
    }
    insertBlocks(parse(section.content), index, root, true);
  };
}

export interface SectionsPanelProps {
  /** Where the next section goes among the page's sections; null: after the selected one, or last. */
  insertAt: number | null;
  /** Forgets the position (the person cleared it, or a section went there). */
  onClearInsertAt: () => void;
  /** Just before a section goes in (History names the step after it). */
  onInserting?: (title: string) => void;
  onInserted: (title: string) => void;
}

/**
 * The Sections panel (#44): the pattern library by category, the Pressbase
 * library first, then the theme's, then plugins'. Each shows in the site's
 * own styles (BlockPreview, drawn only once it scrolls into view). Search
 * narrows by title, category and keywords. Click a section, or press Enter
 * on it, to add it; or drag it onto the page.
 */
export function SectionsPanel(props: SectionsPanelProps) {
  const { __, sprintf } = useI18n();
  const [data, setData] = useState<{ sections: Section[]; categories: RestPatternCategory[] }>();
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const searchId = useId();
  const categoryId = useId();
  const addSection = useAddSection();
  const root = useSelect(
    (select) => contentRootId(select(blockEditorStore) as unknown as StoreSelectors),
    [],
  );
  const count = useSelect(
    (select) =>
      root ? (select(blockEditorStore) as unknown as StoreSelectors).getBlockOrder(root).length : 0,
    [root],
  );
  // The section the next one goes after, by the name people see in the toolbar.
  const after = useSelect(
    (select) => {
      if (!root || !props.insertAt) return '';
      const s = select(blockEditorStore) as unknown as StoreSelectors;
      const clientId = s.getBlockOrder(root)[props.insertAt - 1];
      return clientId ? sectionLabel(s, clientId) : '';
    },
    [root, props.insertAt],
  );

  useEffect(() => {
    let live = true;
    loadSectionLibrary()
      .then((loaded) => live && setData(loaded))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  const groups = useMemo(
    () => (data ? groupSections(data.sections, data.categories, { search, category }) : []),
    [data, search, category],
  );
  const categories = useMemo(
    () => (data ? sectionCategories(data.sections, data.categories) : []),
    [data],
  );

  const add = (section: Section) => {
    if (!addSection) return;
    props.onInserting?.(section.title);
    addSection(section, props.insertAt);
    props.onClearInsertAt();
    props.onInserted(section.title);
  };

  if (!root) {
    return (
      <p className={styles.panelNote}>
        <LayoutPanelTop size={16} aria-hidden="true" />
        <span>
          {__(
            'This page shows your latest posts, so it has no sections of its own. Open a page to add sections to it.',
            'pressbase-admin',
          )}
        </span>
      </p>
    );
  }

  return (
    <div className={styles.sectionsPanel}>
      <div className={styles.sectionsFilters}>
        <label htmlFor={searchId} className="visually-hidden">
          {__('Search sections', 'pressbase-admin')}
        </label>
        <input
          id={searchId}
          type="search"
          className={styles.sectionsSearch}
          placeholder={__('Search sections', 'pressbase-admin')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <label htmlFor={categoryId} className="visually-hidden">
          {__('Kind of section', 'pressbase-admin')}
        </label>
        <select
          id={categoryId}
          className={styles.select}
          value={category}
          onChange={(event) => setCategory(event.target.value)}
        >
          <option value="">{__('All sections', 'pressbase-admin')}</option>
          {categories.map((c) => (
            <option key={c.name} value={c.name}>
              {`${c.label} (${c.count})`}
            </option>
          ))}
        </select>
      </div>

      {props.insertAt !== null && (
        <div className={styles.sectionsPosition} role="status">
          <span>
            {props.insertAt === 0
              ? __('Adding at the top of the page.', 'pressbase-admin')
              : props.insertAt >= count
                ? __('Adding at the end of the page.', 'pressbase-admin')
                : sprintf(__('Adding after “%s”.', 'pressbase-admin'), after)}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className={styles.iconButton}
            aria-label={__('Add at the usual place instead', 'pressbase-admin')}
            icon={<X size={14} aria-hidden="true" />}
            onClick={props.onClearInsertAt}
          />
        </div>
      )}

      {failed && (
        <p className={styles.pagesEmpty} role="alert">
          {__('The sections couldn’t load. Close the panel and open it again.', 'pressbase-admin')}
        </p>
      )}
      {!data && !failed && (
        <p className={styles.pagesEmpty} aria-busy="true">
          {__('Loading sections…', 'pressbase-admin')}
        </p>
      )}
      {data && groups.length === 0 && (
        <p className={styles.pagesEmpty} role="status">
          {__('No sections match. Try another word.', 'pressbase-admin')}
        </p>
      )}

      {groups.map((group) => (
        <section key={group.category} className={styles.sectionGroup} aria-label={group.label}>
          <h3 className={styles.sectionGroupTitle}>{group.label}</h3>
          <ul className={styles.sectionList}>
            {group.sections.map((section) => (
              <SectionTile key={section.name} section={section} onAdd={add} />
            ))}
          </ul>
        </section>
      ))}
      <p className={styles.pagesHint}>
        {__(
          'Click a section to add it to the page, or drag it to the place you want.',
          'pressbase-admin',
        )}
      </p>
    </div>
  );
}

/** True once the element has come near the visible part of the panel. */
function useSeen(ref: { current: Element | null }): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (seen || !element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: '200px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, seen]);
  return seen;
}

const PREVIEW_STYLES = [{ css: 'body { padding: 0; }' }];

/** One section: its preview (drawn when it scrolls into view), its name, and the way to add it. */
const SectionTile = memo(function SectionTile({
  section,
  onAdd,
}: {
  section: Section;
  onAdd: (section: Section) => void;
}) {
  const { __, sprintf } = useI18n();
  const ref = useRef<HTMLLIElement>(null);
  const seen = useSeen(ref);
  const blocks = useMemo(() => (seen ? parse(section.content) : []), [seen, section.content]);
  const descriptionId = useId();

  const onDragStart = (event: DragEvent) => {
    // What WordPress's inserter hands the canvas's drop zones (InserterDraggableBlocks).
    const parsed = parse(section.content);
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('wp-blocks', JSON.stringify({ type: 'inserter', blocks: parsed }));
    for (const name of new Set(parsed.map((block) => block.name))) {
      event.dataTransfer.items.add('', `wp-block:${name}`);
    }
  };

  return (
    <li ref={ref} className={styles.sectionTile} draggable onDragStart={onDragStart}>
      <div className={styles.sectionPreview} aria-hidden="true" inert>
        {seen && blocks.length > 0 && (
          <BlockPreview
            blocks={blocks}
            viewportWidth={section.viewportWidth}
            additionalStyles={PREVIEW_STYLES}
          />
        )}
      </div>
      <button
        type="button"
        className={styles.sectionAdd}
        aria-label={sprintf(__('Add section: %s', 'pressbase-admin'), section.title)}
        aria-describedby={section.description ? descriptionId : undefined}
        onClick={() => onAdd(section)}
      >
        <span className={styles.sectionTitle}>{section.title}</span>
        {section.source === 'theme' && (
          <span className={styles.pageNote}>{__('Theme', 'pressbase-admin')}</span>
        )}
        {section.source === 'plugin' && (
          <span className={styles.pageNote}>{__('Plugin', 'pressbase-admin')}</span>
        )}
      </button>
      {section.description && (
        <span id={descriptionId} className="visually-hidden">
          {section.description}
        </span>
      )}
    </li>
  );
});
