'use client';

import { BlockPreview } from '@wordpress/block-editor';
import {
  type Block as BlockInstance,
  createBlock,
  getBlockFromExample,
  getBlockType,
  getBlockTypes,
} from '@wordpress/blocks';
import { X } from 'lucide-react';
import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { type Json, palette } from '@/lib/global-styles';
import { useI18n } from '@/lib/i18n/context';
import { Button } from '../ui/button';
import studioStyles from './studio.module.css';
import {
  exampleAttributes,
  exampleInnerBlocks,
  type StylesScreen,
  styleBookSections,
  styleTarget,
} from './styles-model';
import panelStyles from './styles-panel.module.css';
import type { SiteStyles } from './use-site-styles';

/**
 * The style book (#47): every kind of block the site uses, drawn with the
 * site's current styles (the draft's, as the canvas shows them), by
 * category, over the canvas. WordPress's style book (StyleBookPreview in
 * @wordpress/editor) with its names in plain words. Choosing an example
 * opens that block's styles in the panel, and the book stays open so the
 * change shows on it at once. Escape or *Back to the page* closes it.
 */
export function StyleBook({
  site,
  selected,
  onOpen,
  onClose,
}: {
  site: SiteStyles;
  /** The block (or panel screen) open in the panel now. */
  selected: string;
  onOpen: (screen: StylesScreen) => void;
  onClose: () => void;
}) {
  const { __ } = useI18n();
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [filter, setFilter] = useState('all');
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Drawn over the canvas: a container in Studio's canvas area, the page behind it inert.
  useLayoutEffect(() => {
    const stage = document.getElementById('studio-canvas');
    if (!stage) return;
    const container = document.createElement('div');
    container.className = panelStyles.bookHost ?? '';
    const covered = [...stage.children].filter((child) => !child.hasAttribute('inert'));
    for (const child of covered) child.setAttribute('inert', '');
    stage.appendChild(container);
    setHost(container);
    return () => {
      for (const child of covered) child.removeAttribute('inert');
      container.remove();
      setHost(null);
    };
  }, []);

  useEffect(() => {
    if (host) requestAnimationFrame(() => headingRef.current?.focus());
  }, [host]);

  const sections = useMemo(() => {
    const types = (getBlockTypes() as Json[]).map((t) => ({
      name: t.name as string,
      title: (t.title as string | undefined) ?? (t.name as string),
      category: t.category as string | undefined,
      example: Boolean(t.example),
      inserter: t.supports?.inserter !== false,
    }));
    return styleBookSections(types).map((section) => ({
      ...section,
      title: __(section.title, 'pressbase-admin'),
    }));
  }, [__]);

  if (!host) return null;

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.stopPropagation();
      onClose();
    }
  };

  const colors = palette(site.base, site.config);
  const filters = [
    { slug: 'all', title: __('Everything', 'pressbase-admin') },
    { slug: 'colors', title: __('Colours', 'pressbase-admin') },
    ...sections.map((s) => ({ slug: s.slug, title: s.title })),
  ];
  const shows = (slug: string) => filter === 'all' || filter === slug;

  return createPortal(
    <section
      className={panelStyles.book}
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
      data-style-book
    >
      <header className={panelStyles.bookHeader}>
        <div>
          <h2 id={headingId} ref={headingRef} tabIndex={-1}>
            {__('Style book', 'pressbase-admin')}
          </h2>
          <p>
            {__(
              'Every kind of block, in your site’s styles as they are in your draft. Choose one to change how it looks everywhere.',
              'pressbase-admin',
            )}
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          icon={<X size={16} aria-hidden="true" />}
          onClick={onClose}
        >
          {__('Back to the page', 'pressbase-admin')}
        </Button>
      </header>
      <fieldset className={panelStyles.bookFilters}>
        <legend className="visually-hidden">{__('Show', 'pressbase-admin')}</legend>
        {filters.map((f) => (
          <button
            key={f.slug}
            type="button"
            aria-pressed={filter === f.slug}
            onClick={() => setFilter(f.slug)}
          >
            {f.title}
          </button>
        ))}
      </fieldset>
      <div className={panelStyles.bookBody}>
        {shows('colors') && colors.length > 0 && (
          <BookSection id={`${headingId}-colors`} title={__('Colours', 'pressbase-admin')}>
            <li className={panelStyles.bookColors}>
              <button
                type="button"
                className={panelStyles.bookExample}
                aria-pressed={selected === 'colors'}
                aria-label={__('Your palette, change your colours', 'pressbase-admin')}
                onClick={() => onOpen({ id: 'colors' })}
              >
                <span className={panelStyles.bookLabel}>
                  {__('Your palette', 'pressbase-admin')}
                </span>
              </button>
              <ul className={panelStyles.swatchGrid} aria-hidden="true">
                {colors.map((c) => (
                  <li key={c.slug}>
                    <span style={{ background: c.color }} />
                    <span>{c.name}</span>
                    <code>{/^#/.test(c.color) ? c.color.toUpperCase() : ''}</code>
                  </li>
                ))}
              </ul>
            </li>
          </BookSection>
        )}
        {sections
          .filter((section) => shows(section.slug))
          .map((section) => (
            <BookSection
              key={section.slug}
              id={`${headingId}-${section.slug}`}
              title={section.title}
            >
              {section.blocks.map((name) => (
                <Example
                  key={name}
                  name={name}
                  selected={selected === styleTarget(name)}
                  onOpen={() => onOpen({ id: 'block', name: styleTarget(name) })}
                />
              ))}
            </BookSection>
          ))}
      </div>
    </section>,
    host,
  );
}

function BookSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className={panelStyles.bookSection}>
      <h3 id={id} className={studioStyles.sectionGroupTitle}>
        {title}
      </h3>
      <ul className={panelStyles.bookList}>{children}</ul>
    </section>
  );
}

/** True once the element comes near the visible part of the style book. */
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
      { rootMargin: '300px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, seen]);
  return seen;
}

const PREVIEW_STYLES = [{ css: 'body { padding: 16px 24px; }' }];

/** The blocks an example shows: the block type's example, or headings at each level. */
function exampleBlocks(name: string, __: ReturnType<typeof useI18n>['__']): BlockInstance[] {
  if (name === 'core/heading') {
    return [1, 2, 3, 4].map((level) =>
      createBlock('core/heading', {
        level,
        content: __('Fresh bread, every morning', 'pressbase-admin'),
      }),
    );
  }
  const type = getBlockType(name) as Json;
  if (!type) return [];
  if (!type.example) return [createBlock(name)];
  const block = getBlockFromExample(name, {
    ...type.example,
    attributes: exampleAttributes(type.example.attributes ?? {}),
    innerBlocks: exampleInnerBlocks(type.example.innerBlocks),
  });
  return [block];
}

/** One example: the block drawn in the site's styles, and a button that opens its styles. */
const Example = memo(function Example({
  name,
  selected,
  onOpen,
}: {
  name: string;
  selected: boolean;
  onOpen: () => void;
}) {
  const { __, sprintf } = useI18n();
  const ref = useRef<HTMLLIElement>(null);
  const seen = useSeen(ref);
  const blocks = useMemo(() => (seen ? exampleBlocks(name, __) : []), [seen, name, __]);
  const title =
    name === 'core/heading'
      ? __('Headings', 'pressbase-admin')
      : ((getBlockType(name) as Json)?.title ?? name);
  return (
    <li ref={ref} className={panelStyles.bookItem}>
      <button
        type="button"
        className={panelStyles.bookExample}
        aria-pressed={selected}
        data-example={name}
        aria-label={sprintf(
          /* translators: %s: a kind of block, such as Quote. */
          __('%s, change how it looks everywhere', 'pressbase-admin'),
          title,
        )}
        onClick={onOpen}
      >
        <span className={panelStyles.bookLabel}>{title}</span>
      </button>
      <div className={panelStyles.bookPreview} aria-hidden="true" inert>
        {blocks.length > 0 && (
          <BlockPreview blocks={blocks} viewportWidth={760} additionalStyles={PREVIEW_STYLES} />
        )}
      </div>
    </li>
  );
});
