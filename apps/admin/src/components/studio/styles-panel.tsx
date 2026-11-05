'use client';

import { BlockIcon } from '@wordpress/block-editor';
import { getBlockType, getBlockTypes } from '@wordpress/blocks';
import { ArrowLeft, BookOpen, ChevronRight, RotateCcw } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  configsEqual,
  fontFamilies,
  fontSizes,
  getPath,
  type Json,
  type PaletteColor,
  palette,
  presetRef,
  presetSlug,
  resolveColor,
  setPath,
} from '@/lib/global-styles';
import { useI18n } from '@/lib/i18n/context';
import {
  ColorsTab,
  groupVariations,
  LayoutTab,
  Section,
  StylesTab,
  TypographyTab,
  variationFontFaces,
} from '../appearance/styles-editor';
import editorStyles from '../appearance/styles-editor.module.css';
import { Button } from '../ui/button';
import { type StudioMode, showsControl } from './mode-model';
import studioStyles from './studio.module.css';
import { StyleBook } from './style-book';
import {
  BLOCK_ELEMENTS,
  BUTTON_PATH,
  BUTTON_SIZES,
  blockPath,
  blockStyleSupports,
  buttonSize,
  CORNER_SCALES,
  cornerScale,
  hasBlockStyles,
  hasStyleControls,
  paddingPreset,
  radiusSizes,
  resetBlockStyles,
  STYLES_SCREENS,
  type StylesScreen,
  setButtonColor,
  setCornerScale,
  setPadding,
  shadowPresets,
  spacingSizes,
} from './styles-model';
import panelStyles from './styles-panel.module.css';
import type { SiteStyles } from './use-site-styles';

/**
 * Studio's Styles panel (#46): the site's design system in Simple mode
 * (looks, colours, fonts, spacing and corners, buttons), each block's
 * styles, and in Advanced, borders, shadows, hover colours and Additional
 * CSS. The colour, font and layout parts are Appearance → Styles' own
 * (styles-editor.tsx). Every change shows on the canvas at once and goes
 * into the draft (use-site-styles.ts). The style book (#47) opens over the
 * canvas from here.
 */
export function StylesPanel({
  site,
  mode,
  onMode,
  canEditCss,
  canPreview,
}: {
  site: SiteStyles;
  mode: StudioMode;
  onMode: (mode: StudioMode) => void;
  /** `edit_css` (WordPress maps it to `unfiltered_html`). */
  canEditCss: boolean;
  /** The canvas is open, so the style book can draw blocks. */
  canPreview: boolean;
}) {
  const { __ } = useI18n();
  const [screen, setScreen] = useState<StylesScreen>({ id: 'home' });
  const [bookOpen, setBookOpen] = useState(false);
  const from = useRef<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // A new screen starts at its heading; going back returns to the button that opened it.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (screen.id === 'home') {
        const target = from.current
          ? bodyRef.current?.querySelector<HTMLElement>(`[data-screen="${from.current}"]`)
          : null;
        target?.focus();
      } else headingRef.current?.focus();
      bodyRef.current?.scrollTo?.({ top: 0 });
    });
    return () => cancelAnimationFrame(frame);
  }, [screen]);

  if (site.failed) {
    return <p className={studioStyles.pagesEmpty}>{site.failed}</p>;
  }
  if (!site.ready) {
    return (
      <p className={studioStyles.pagesEmpty} aria-busy="true">
        {__('Loading your site’s styles…', 'pressbase-admin')}
      </p>
    );
  }

  const go = (next: StylesScreen) => {
    if (next.id === 'home') {
      // Back from a block goes to the list of blocks.
      if (screen.id === 'block') {
        from.current = screen.name;
        setScreen({ id: 'blocks' });
        return;
      }
      from.current = screen.id;
    }
    setScreen(next);
  };

  const screens = STYLES_SCREENS.filter(
    (s) => (!s.control || showsControl(mode, s.control)) && (!s.css || canEditCss),
  );
  const changed = !configsEqual(site.config, site.live);

  return (
    <div className={panelStyles.panel} ref={bodyRef}>
      {screen.id === 'home' ? (
        <div className={panelStyles.home}>
          <p className={panelStyles.intro}>
            {__(
              'Change how your whole site looks. Every change shows on the page straight away, and goes live when you publish.',
              'pressbase-admin',
            )}
          </p>
          <ul className={panelStyles.nav}>
            {screens.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={panelStyles.navItem}
                  data-screen={s.id}
                  onClick={() => go({ id: s.id })}
                >
                  <span>
                    <span className={panelStyles.navLabel}>{__(s.label, 'pressbase-admin')}</span>
                    <span className={panelStyles.navSummary}>
                      {__(s.summary, 'pressbase-admin')}
                    </span>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <div className={panelStyles.homeActions}>
            <Button
              size="sm"
              variant="secondary"
              icon={<BookOpen size={15} aria-hidden="true" />}
              aria-pressed={bookOpen}
              disabled={!canPreview}
              data-style-book-toggle
              onClick={() => setBookOpen((open) => !open)}
            >
              {bookOpen
                ? __('Close the style book', 'pressbase-admin')
                : __('Open the style book', 'pressbase-admin')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw size={15} aria-hidden="true" />}
              disabled={configsEqual(site.config, {})}
              onClick={() => site.change({ settings: {}, styles: {} })}
            >
              {__('Use the theme’s styles', 'pressbase-admin')}
            </Button>
          </div>
          {mode === 'simple' && canEditCss && (
            <p className={panelStyles.note}>
              {__('Additional CSS is in Advanced.', 'pressbase-admin')}{' '}
              <button type="button" className={panelStyles.link} onClick={() => onMode('advanced')}>
                {__('Switch to Advanced', 'pressbase-admin')}
              </button>
            </p>
          )}
          {changed && (
            <p className={panelStyles.note} role="status">
              {__('Your style changes are in your draft.', 'pressbase-admin')}
            </p>
          )}
          {site.cssError && (
            <p className={panelStyles.error} role="alert">
              {__(
                'Your Additional CSS has a problem, so your latest style changes aren’t saved yet.',
                'pressbase-admin',
              )}{' '}
              <button type="button" className={panelStyles.link} onClick={() => go({ id: 'css' })}>
                {__('Fix it', 'pressbase-admin')}
              </button>
            </p>
          )}
        </div>
      ) : (
        <Screen
          screen={screen}
          headingRef={headingRef}
          onBack={() => go({ id: 'home' })}
          site={site}
          mode={mode}
          onMode={onMode}
          canEditCss={canEditCss}
          onOpenBlock={(name) => {
            from.current = null;
            setScreen({ id: 'block', name });
          }}
        />
      )}
      {bookOpen && canPreview && (
        <StyleBook
          site={site}
          selected={screen.id === 'block' ? screen.name : screen.id}
          onClose={() => {
            setBookOpen(false);
            // Back to the button that opened it, or to the screen open in the panel now.
            requestAnimationFrame(() => {
              const toggle = document.querySelector<HTMLElement>('[data-style-book-toggle]');
              (toggle ?? headingRef.current)?.focus();
            });
          }}
          onOpen={(target) => {
            from.current = null;
            setScreen(target);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------ the screens */

interface ScreenProps {
  site: SiteStyles;
  mode: StudioMode;
  onMode: (mode: StudioMode) => void;
  canEditCss: boolean;
}

function Screen({
  screen,
  headingRef,
  onBack,
  onOpenBlock,
  ...props
}: ScreenProps & {
  screen: Exclude<StylesScreen, { id: 'home' }>;
  headingRef: { current: HTMLHeadingElement | null };
  onBack: () => void;
  onOpenBlock: (name: string) => void;
}) {
  const { __ } = useI18n();
  const { site } = props;
  const groups = useMemo(() => groupVariations(site.variations), [site.variations]);
  const faces = useMemo(
    () => variationFontFaces(site.stylesheet, site.base, site.variations),
    [site.stylesheet, site.base, site.variations],
  );
  const title =
    screen.id === 'block'
      ? (getBlockType(screen.name)?.title ?? screen.name)
      : __(STYLES_SCREENS.find((s) => s.id === screen.id)?.label ?? '', 'pressbase-admin');
  const tab = { base: site.base, draft: site.config, setDraft: site.change };

  return (
    <div className={panelStyles.screen}>
      <style>{faces}</style>
      <div className={panelStyles.screenHeader}>
        <Button
          size="sm"
          variant="ghost"
          className={studioStyles.iconButton}
          icon={<ArrowLeft size={16} aria-hidden="true" />}
          aria-label={
            screen.id === 'block'
              ? __('Back to Blocks', 'pressbase-admin')
              : __('Back to Styles', 'pressbase-admin')
          }
          onClick={onBack}
        />
        <h3 ref={headingRef} tabIndex={-1} className={panelStyles.screenTitle}>
          {title}
        </h3>
      </div>
      <div className={panelStyles.screenBody}>
        {screen.id === 'looks' && (
          <StylesTab {...tab} themeName={site.themeName} variations={groups.full} />
        )}
        {screen.id === 'colors' && <ColorsTab {...tab} palettes={groups.color} />}
        {screen.id === 'fonts' && <TypographyTab {...tab} pairings={groups.typography} />}
        {screen.id === 'spacing' && <SpacingScreen {...props} />}
        {screen.id === 'buttons' && <ButtonsScreen {...props} />}
        {screen.id === 'blocks' && <BlocksScreen {...props} onOpen={onOpenBlock} />}
        {screen.id === 'block' && <BlockScreen {...props} name={screen.name} />}
        {screen.id === 'css' && <CssScreen {...props} />}
      </div>
    </div>
  );
}

/* ---------------------------------------------------- spacing and corners */

function SpacingScreen({ site }: ScreenProps) {
  const { __ } = useI18n();
  const { base, config } = site;
  const sizes = spacingSizes(base, config);
  const radii = radiusSizes(base, {});
  const scale = cornerScale(base, config);
  const gap = styleValue(site, ['spacing', 'blockGap']);
  const edges = styleValue(site, ['spacing', 'padding', 'left']);
  const sizeOptions = sizes.map((s) => ({ value: s.slug, label: s.name ?? s.slug }));
  return (
    <>
      <Section
        title={__('Spacing', 'pressbase-admin')}
        description={__('Room between blocks, and at the edges of the page.', 'pressbase-admin')}
      >
        <PresetChoice
          label={__('Between blocks', 'pressbase-admin')}
          options={sizeOptions}
          value={presetSlug(gap, 'spacing')}
          custom={gap && !presetSlug(gap, 'spacing') ? gap : undefined}
          userSet={getPath(config, ['styles', 'spacing', 'blockGap']) !== undefined}
          onChange={(slug) =>
            site.change(
              setPath(
                config,
                ['styles', 'spacing', 'blockGap'],
                slug ? presetRef('spacing', slug) : undefined,
              ),
            )
          }
        />
        <PresetChoice
          label={__('Page edges', 'pressbase-admin')}
          hint={__(
            'Space on the left and right, so text never touches the screen’s edge.',
            'pressbase-admin',
          )}
          options={sizeOptions}
          value={presetSlug(edges, 'spacing')}
          custom={edges && !presetSlug(edges, 'spacing') ? edges : undefined}
          userSet={getPath(config, ['styles', 'spacing', 'padding', 'left']) !== undefined}
          onChange={(slug) => {
            const value = slug ? presetRef('spacing', slug) : undefined;
            let next = setPath(config, ['styles', 'spacing', 'padding', 'left'], value);
            next = setPath(next, ['styles', 'spacing', 'padding', 'right'], value);
            site.change(next);
          }}
        />
      </Section>
      {radii.length > 0 && (
        <Section
          title={__('Corners', 'pressbase-admin')}
          description={__(
            'How round the corners of cards, images and boxes are, across the whole site.',
            'pressbase-admin',
          )}
        >
          <fieldset className={editorStyles.segmented}>
            <legend className="visually-hidden">{__('Corners', 'pressbase-admin')}</legend>
            {CORNER_SCALES.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={scale === c.id}
                onClick={() => site.change(setCornerScale(base, config, c.factor))}
              >
                {__(c.label, 'pressbase-admin')}
              </button>
            ))}
          </fieldset>
          <CornerSamples sizes={radiusSizes(base, config)} />
        </Section>
      )}
      <LayoutTab base={base} draft={config} setDraft={site.change} />
    </>
  );
}

function CornerSamples({ sizes }: { sizes: { slug: string; name?: string; size: string }[] }) {
  return (
    <ul className={panelStyles.corners} aria-hidden="true">
      {sizes
        .filter((s) => !/^9{3,}px$/.test(s.size))
        .map((s) => (
          <li key={s.slug} style={{ borderRadius: s.size }} title={s.name}>
            {s.name ?? s.slug}
          </li>
        ))}
    </ul>
  );
}

/* ---------------------------------------------------------------- buttons */

function ButtonsScreen({ site, mode, onMode }: ScreenProps) {
  const { __ } = useI18n();
  const { base, config } = site;
  const colors = palette(base, config);
  const path = [...BUTTON_PATH].slice(1);
  const value = (...p: string[]) => styleValue(site, [...path, ...p]);
  const userValue = (...p: string[]) => getPath(config, ['styles', ...path, ...p]);
  const size = buttonSize(config);
  return (
    <>
      <ButtonSample site={site} />
      <Section title={__('Colours', 'pressbase-admin')}>
        <ColorChoice
          label={__('Button', 'pressbase-admin')}
          colors={colors}
          value={value('color', 'background')}
          userSet={userValue('color', 'background') !== undefined}
          allowCustom={showsControl(mode, 'custom-values')}
          onChange={(next) => site.change(setButtonColor(config, 'background', next))}
        />
        <ColorChoice
          label={__('Button text', 'pressbase-admin')}
          colors={colors}
          value={value('color', 'text')}
          userSet={userValue('color', 'text') !== undefined}
          allowCustom={showsControl(mode, 'custom-values')}
          onChange={(next) => site.change(setButtonColor(config, 'text', next))}
        />
      </Section>
      <Section title={__('Shape and size', 'pressbase-admin')}>
        <RadiusChoice site={site} path={path} />
        <fieldset className={panelStyles.field}>
          <legend className={panelStyles.fieldLabel}>{__('Size', 'pressbase-admin')}</legend>
          <div className={editorStyles.segmented}>
            {BUTTON_SIZES.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={size === s.id}
                onClick={() =>
                  site.change(setPath(config, [...BUTTON_PATH, 'spacing', 'padding'], s.padding))
                }
              >
                {__(s.label, 'pressbase-admin')}
              </button>
            ))}
          </div>
          {userValue('spacing', 'padding') !== undefined && (
            <ThemeDefault
              onClick={() =>
                site.change(setPath(config, [...BUTTON_PATH, 'spacing', 'padding'], undefined))
              }
            />
          )}
        </fieldset>
      </Section>
      {showsControl(mode, 'states') ? (
        <Section
          title={__('When pointed at', 'pressbase-admin')}
          description={__(
            'Colours while the pointer is over a button, or it has focus.',
            'pressbase-admin',
          )}
        >
          {(['background', 'text'] as const).map((which) => (
            <ColorChoice
              key={which}
              label={
                which === 'background'
                  ? __('Button', 'pressbase-admin')
                  : __('Button text', 'pressbase-admin')
              }
              colors={colors}
              value={hoverValue(value(':hover', 'color', which))}
              userSet={userValue(':hover', 'color', which) !== undefined}
              allowCustom
              onChange={(next) => {
                let updated = setPath(config, [...BUTTON_PATH, ':hover', 'color', which], next);
                updated = setPath(updated, [...BUTTON_PATH, ':focus', 'color', which], next);
                site.change(updated);
              }}
            />
          ))}
        </Section>
      ) : null}
      <AdvancedStyles site={site} mode={mode} onMode={onMode} path={path} border shadow />
    </>
  );
}

/** A colour-mix() hover colour isn't a palette colour: shown as the theme's. */
const hoverValue = (value: string | undefined) =>
  value && /^color-mix\(/.test(value) ? undefined : value;

function ButtonSample({ site }: { site: SiteStyles }) {
  const { __ } = useI18n();
  const colors = palette(site.base, site.config);
  const families = fontFamilies(site.base, site.config);
  const path = ['elements', 'button'];
  const color = (p: string[]) => resolveColor(styleValue(site, [...path, ...p]), colors);
  const radius = styleValue(site, [...path, 'border', 'radius']);
  const radii = radiusSizes(site.base, site.config);
  const radiusCss = presetSlug(radius, 'border-radius')
    ? radii.find((r) => r.slug === presetSlug(radius, 'border-radius'))?.size
    : radius;
  const family = styleValue(site, [...path, 'typography', 'fontFamily']);
  const familySlug = presetSlug(family, 'font-family');
  return (
    <div
      className={panelStyles.sample}
      style={{ background: resolveColor(styleValue(site, ['color', 'background']), colors) }}
      aria-hidden="true"
    >
      <span
        className={panelStyles.sampleButton}
        style={{
          background: color(['color', 'background']),
          color: color(['color', 'text']),
          borderRadius: radiusCss,
          fontFamily: familySlug ? families.find((f) => f.slug === familySlug)?.fontFamily : family,
        }}
      >
        {__('Book a table', 'pressbase-admin')}
      </span>
    </div>
  );
}

/* ----------------------------------------------------------------- blocks */

interface BlockListItem {
  name: string;
  title: string;
  icon: unknown;
  category: string;
}

const BLOCK_GROUPS: { id: string; label: string; categories: string[] }[] = [
  { id: 'text', label: 'Text', categories: ['text'] },
  { id: 'media', label: 'Media', categories: ['media', 'embed'] },
  { id: 'design', label: 'Layout', categories: ['design'] },
  { id: 'site', label: 'Site', categories: ['theme', 'widgets'] },
];

function BlocksScreen({ site, onOpen }: ScreenProps & { onOpen: (name: string) => void }) {
  const { __ } = useI18n();
  const [search, setSearch] = useState('');
  const id = useId();
  const items = useMemo<BlockListItem[]>(
    () =>
      (getBlockTypes() as Json[])
        // As WordPress's Styles → Blocks: child blocks too (a Button lives in Buttons).
        .filter(
          (type) =>
            type.supports?.inserter !== false &&
            hasStyleControls(blockStyleSupports(type.supports)),
        )
        .map((type) => ({
          name: type.name as string,
          title: type.title as string,
          icon: type.icon,
          category: type.category as string,
        })),
    [],
  );
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = items.filter((item) =>
    words.every((w) => `${item.title} ${item.name}`.toLowerCase().includes(w)),
  );
  const labels: Record<string, string> = {
    text: __('Text', 'pressbase-admin'),
    media: __('Media', 'pressbase-admin'),
    design: __('Layout', 'pressbase-admin'),
    site: __('Site', 'pressbase-admin'),
    more: __('More', 'pressbase-admin'),
  };
  const grouped = new Map<string, BlockListItem[]>();
  for (const item of shown) {
    const group = BLOCK_GROUPS.find((g) => g.categories.includes(item.category))?.id ?? 'more';
    grouped.set(group, [...(grouped.get(group) ?? []), item]);
  }
  const order = [...BLOCK_GROUPS.map((g) => g.id), 'more'].filter((g) => grouped.has(g));
  return (
    <div className={panelStyles.blocks}>
      <p className={panelStyles.intro}>
        {__(
          'Choose a kind of block to change how it looks everywhere on your site. A block you styled on its own keeps its own look.',
          'pressbase-admin',
        )}
      </p>
      <label htmlFor={id} className="visually-hidden">
        {__('Search blocks', 'pressbase-admin')}
      </label>
      <input
        id={id}
        type="search"
        className={studioStyles.sectionsSearch}
        placeholder={__('Search blocks', 'pressbase-admin')}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {shown.length === 0 && (
        <p className={panelStyles.note}>
          {__('No blocks match. Try another word.', 'pressbase-admin')}
        </p>
      )}
      {order.map((group) => (
        <section key={group} aria-labelledby={`${id}-${group}`} className={panelStyles.blockGroup}>
          <h4 id={`${id}-${group}`} className={studioStyles.sectionGroupTitle}>
            {labels[group]}
          </h4>
          <ul className={panelStyles.blockList}>
            {(grouped.get(group) ?? []).map((item) => (
              <li key={item.name}>
                <button
                  type="button"
                  className={panelStyles.blockItem}
                  data-screen={item.name}
                  onClick={() => onOpen(item.name)}
                >
                  <span className={panelStyles.blockIcon} aria-hidden="true">
                    <BlockIcon icon={item.icon as never} />
                  </span>
                  <span className={panelStyles.blockTitle}>{item.title}</span>
                  {hasBlockStyles(site.config, item.name) && (
                    <span className={panelStyles.badge}>{__('Changed', 'pressbase-admin')}</span>
                  )}
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function BlockScreen({ site, mode, onMode, name }: ScreenProps & { name: string }) {
  const { __ } = useI18n();
  const type = getBlockType(name) as Json;
  const supports = blockStyleSupports(type?.supports);
  const { base, config } = site;
  const colors = palette(base, config);
  const families = fontFamilies(base, config);
  const sizes = fontSizes(base, config);
  const spacing = spacingSizes(base, config);
  const path = ['blocks', name];
  const element = BLOCK_ELEMENTS[name];
  // The block's own value, else the element it's styled through (a Button's is the button element's).
  const value = (...p: string[]) =>
    styleValue(site, [...path, ...p]) ??
    (element ? styleValue(site, [...element, ...p]) : undefined);
  const userValue = (...p: string[]) => getPath(config, ['styles', ...path, ...p]);
  const set = (p: string[], next: Json) =>
    site.change(setPath(config, blockPath(name, ...p), next));
  const custom = showsControl(mode, 'custom-values');
  if (!type) {
    return (
      <p className={panelStyles.note}>{__('This block isn’t available.', 'pressbase-admin')}</p>
    );
  }
  const familySlug = presetSlug(value('typography', 'fontFamily'), 'font-family');
  return (
    <>
      <p className={panelStyles.intro}>
        {__(
          'Changes here apply to every block of this kind on your site, except where one was styled on its own.',
          'pressbase-admin',
        )}
      </p>
      {(supports.text || supports.background || supports.link) && (
        <Section title={__('Colours', 'pressbase-admin')}>
          {supports.text && (
            <ColorChoice
              label={__('Text', 'pressbase-admin')}
              colors={colors}
              value={value('color', 'text')}
              userSet={userValue('color', 'text') !== undefined}
              allowCustom={custom}
              onChange={(next) => set(['color', 'text'], next)}
            />
          )}
          {supports.background && (
            <ColorChoice
              label={__('Background', 'pressbase-admin')}
              colors={colors}
              value={value('color', 'background')}
              userSet={userValue('color', 'background') !== undefined}
              allowCustom={custom}
              onChange={(next) => set(['color', 'background'], next)}
            />
          )}
          {supports.link && (
            <ColorChoice
              label={__('Links', 'pressbase-admin')}
              colors={colors}
              value={value('elements', 'link', 'color', 'text')}
              userSet={userValue('elements', 'link', 'color', 'text') !== undefined}
              allowCustom={custom}
              onChange={(next) => set(['elements', 'link', 'color', 'text'], next)}
            />
          )}
        </Section>
      )}
      {(supports.fontFamily || supports.fontSize) && (
        <Section title={__('Type', 'pressbase-admin')}>
          {supports.fontFamily && families.length > 0 && (
            <SelectChoice
              label={__('Font', 'pressbase-admin')}
              value={familySlug ?? ''}
              userSet={userValue('typography', 'fontFamily') !== undefined}
              options={families.map((f) => ({ value: f.slug, label: f.name }))}
              onChange={(slug) =>
                set(['typography', 'fontFamily'], slug ? presetRef('font-family', slug) : undefined)
              }
            />
          )}
          {supports.fontSize && sizes.length > 0 && (
            <PresetChoice
              label={__('Size', 'pressbase-admin')}
              options={sizes.map((s) => ({ value: s.slug, label: s.name ?? s.slug }))}
              value={presetSlug(value('typography', 'fontSize'), 'font-size')}
              custom={
                value('typography', 'fontSize') &&
                !presetSlug(value('typography', 'fontSize'), 'font-size')
                  ? value('typography', 'fontSize')
                  : undefined
              }
              userSet={userValue('typography', 'fontSize') !== undefined}
              onChange={(slug) =>
                set(['typography', 'fontSize'], slug ? presetRef('font-size', slug) : undefined)
              }
            />
          )}
        </Section>
      )}
      {(supports.padding || supports.radius) && (
        <Section title={__('Shape and spacing', 'pressbase-admin')}>
          {supports.padding && spacing.length > 0 && (
            <PresetChoice
              label={__('Space inside', 'pressbase-admin')}
              options={spacing.map((s) => ({ value: s.slug, label: s.name ?? s.slug }))}
              value={paddingPreset(
                userValue('spacing', 'padding') ??
                  getPath(site.base, ['styles', ...path, 'spacing', 'padding']),
              )}
              userSet={userValue('spacing', 'padding') !== undefined}
              onChange={(slug) => site.change(setPadding(config, ['styles', ...path], slug))}
            />
          )}
          {supports.radius && <RadiusChoice site={site} path={path} fallback={element} />}
        </Section>
      )}
      <AdvancedStyles
        site={site}
        mode={mode}
        onMode={onMode}
        path={path}
        border={supports.border}
        shadow={supports.shadow}
        css
      />
      <div className={panelStyles.resetRow}>
        <Button
          size="sm"
          variant="ghost"
          icon={<RotateCcw size={15} aria-hidden="true" />}
          disabled={!hasBlockStyles(config, name)}
          onClick={() => site.change(resetBlockStyles(config, name))}
        >
          {__('Use the theme’s design for this block', 'pressbase-admin')}
        </Button>
      </div>
    </>
  );
}

/* ---------------------------------------------- borders, shadows, block CSS */

function AdvancedStyles({
  site,
  mode,
  onMode,
  path,
  border,
  shadow,
  css,
}: {
  site: SiteStyles;
  mode: StudioMode;
  onMode: (mode: StudioMode) => void;
  path: string[];
  border?: boolean;
  shadow?: boolean;
  /** Additional CSS for this block (shown with edit_css). */
  css?: boolean;
}) {
  const { __ } = useI18n();
  const { base, config } = site;
  const showBorder = border && showsControl(mode, 'borders');
  const showShadow = shadow && showsControl(mode, 'shadows');
  const showCss = css && showsControl(mode, 'additional-css');
  const hidden = (border && !showBorder) || (shadow && !showShadow) || (css && !showCss);
  const colors = palette(base, config);
  const shadows = shadowPresets(base, config);
  const value = (...p: string[]) => styleValue(site, [...path, ...p]);
  const userValue = (...p: string[]) => getPath(config, ['styles', ...path, ...p]);
  const set = (p: string[], next: Json) =>
    site.change(setPath(config, ['styles', ...path, ...p], next));
  const shadowValue = value('shadow');
  return (
    <>
      {showBorder && (
        <Section title={__('Border', 'pressbase-admin')}>
          <div className={panelStyles.row}>
            <NumberChoice
              label={__('Width', 'pressbase-admin')}
              unit="px"
              value={value('border', 'width')}
              onChange={(next) => set(['border', 'width'], next)}
            />
            <SelectChoice
              label={__('Style', 'pressbase-admin')}
              value={value('border', 'style') ?? ''}
              userSet={false}
              options={[
                { value: 'solid', label: __('Solid', 'pressbase-admin') },
                { value: 'dashed', label: __('Dashed', 'pressbase-admin') },
                { value: 'dotted', label: __('Dotted', 'pressbase-admin') },
              ]}
              onChange={(next) => set(['border', 'style'], next || undefined)}
            />
          </div>
          <ColorChoice
            label={__('Border colour', 'pressbase-admin')}
            colors={colors}
            value={value('border', 'color')}
            userSet={userValue('border', 'color') !== undefined}
            allowCustom
            onChange={(next) => set(['border', 'color'], next)}
          />
          {userValue('border') !== undefined && (
            <ThemeDefault
              label={__('No border of my own', 'pressbase-admin')}
              onClick={() => set(['border'], undefined)}
            />
          )}
        </Section>
      )}
      {showShadow && shadows.length > 0 && (
        <Section title={__('Shadow', 'pressbase-admin')}>
          <fieldset className={panelStyles.field}>
            <legend className="visually-hidden">{__('Shadow', 'pressbase-admin')}</legend>
            <div className={panelStyles.shadows}>
              <button
                type="button"
                className={panelStyles.shadow}
                aria-pressed={shadowValue === 'none'}
                onClick={() => set(['shadow'], 'none')}
              >
                <span aria-hidden="true" />
                {__('None', 'pressbase-admin')}
              </button>
              {shadows.map((s) => (
                <button
                  key={s.slug}
                  type="button"
                  className={panelStyles.shadow}
                  aria-pressed={presetSlug(shadowValue, 'shadow') === s.slug}
                  onClick={() => set(['shadow'], presetRef('shadow', s.slug))}
                >
                  <span aria-hidden="true" style={{ boxShadow: s.shadow }} />
                  {s.name ?? s.slug}
                </button>
              ))}
            </div>
            {userValue('shadow') !== undefined && (
              <ThemeDefault onClick={() => set(['shadow'], undefined)} />
            )}
          </fieldset>
        </Section>
      )}
      {showCss && (
        <Section
          title={__('Additional CSS', 'pressbase-admin')}
          description={__(
            'CSS for this block only. Start rules with & for the block itself.',
            'pressbase-admin',
          )}
        >
          <CssField
            site={site}
            label={__('Additional CSS for this block', 'pressbase-admin')}
            path={['styles', ...path, 'css']}
            placeholder="& { letter-spacing: 0.02em; }"
          />
        </Section>
      )}
      {hidden && mode === 'simple' && (
        <p className={panelStyles.note}>
          {__('Borders, shadows and Additional CSS are in Advanced.', 'pressbase-admin')}{' '}
          <button type="button" className={panelStyles.link} onClick={() => onMode('advanced')}>
            {__('Switch to Advanced', 'pressbase-admin')}
          </button>
        </p>
      )}
    </>
  );
}

/* ---------------------------------------------------------- Additional CSS */

function CssScreen({ site }: ScreenProps) {
  const { __ } = useI18n();
  return (
    <Section
      title={__('Additional CSS', 'pressbase-admin')}
      description={__(
        'Your own CSS, added after the theme’s styles on every page. Mistakes can change how the whole site looks, so check Preview before you publish.',
        'pressbase-admin',
      )}
    >
      <CssField
        site={site}
        label={__('Additional CSS for the whole site', 'pressbase-admin')}
        path={['styles', 'css']}
        placeholder=".site-note { font-style: italic; }"
        rows={14}
      />
    </Section>
  );
}

function CssField({
  site,
  label,
  path,
  placeholder,
  rows = 6,
}: {
  site: SiteStyles;
  label: string;
  path: string[];
  placeholder: string;
  rows?: number;
}) {
  const { __ } = useI18n();
  const id = useId();
  const stored = getPath(site.config, path);
  const [text, setText] = useState(typeof stored === 'string' ? stored : '');
  // Taken up when the styles change elsewhere (History, Discard).
  useEffect(() => {
    setText((now) =>
      typeof stored === 'string' ? stored : now && stored === undefined ? '' : now,
    );
  }, [stored]);
  const error = site.cssError;
  return (
    <div className={panelStyles.cssField}>
      <label htmlFor={id} className={panelStyles.fieldLabel}>
        {label}
      </label>
      <textarea
        id={id}
        className={panelStyles.css}
        value={text}
        rows={rows}
        spellCheck={false}
        placeholder={placeholder}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error ? `${id}-error` : `${id}-hint`}
        onChange={(event) => {
          setText(event.target.value);
          site.change(setPath(site.config, path, event.target.value || undefined));
        }}
      />
      {error ? (
        <p id={`${id}-error`} className={panelStyles.error} role="alert">
          {sprintfCss(__, error)}
        </p>
      ) : (
        <p id={`${id}-hint`} className={panelStyles.hint}>
          {__('Shows on the page as you type. Goes live when you publish.', 'pressbase-admin')}
        </p>
      )}
    </div>
  );
}

/** Core's message, with what to do about it. */
function sprintfCss(__: ReturnType<typeof useI18n>['__'], message: string): string {
  return `${message} ${__('Remove it to save your styles.', 'pressbase-admin')}`;
}

/* ------------------------------------------------------- shared controls */

/** A style value: the user's, else the theme's. */
function styleValue(site: SiteStyles, path: readonly string[]): string | undefined {
  for (const config of [site.config, site.base]) {
    const value = getPath(config.styles, path);
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return undefined;
}

function ThemeDefault({ onClick, label }: { onClick: () => void; label?: string }) {
  const { __ } = useI18n();
  return (
    <button type="button" className={panelStyles.link} onClick={onClick}>
      {label ?? __('Use the theme’s', 'pressbase-admin')}
    </button>
  );
}

const isHex6 = (value: string | undefined) => /^#[0-9a-f]{6}$/i.test(value ?? '');

/** Palette swatches (and, in Advanced, any colour), showing what the theme uses until one is chosen. */
function ColorChoice({
  label,
  colors,
  value,
  userSet,
  allowCustom,
  onChange,
}: {
  label: string;
  colors: PaletteColor[];
  value: string | undefined;
  userSet: boolean;
  allowCustom: boolean;
  onChange: (value: string | undefined) => void;
}) {
  const { __ } = useI18n();
  const name = useId();
  const slug = presetSlug(value, 'color');
  const resolved = resolveColor(value, colors);
  const custom = !slug && value ? value : undefined;
  const current = slug
    ? (colors.find((c) => c.slug === slug)?.name ?? slug)
    : custom
      ? __('Custom', 'pressbase-admin')
      : __('None', 'pressbase-admin');
  return (
    <fieldset className={panelStyles.field}>
      <legend className={panelStyles.fieldLabel}>
        <span>{label}</span>
        <span className={panelStyles.fieldValue}>
          {current}
          {!userSet && value ? ` · ${__('theme', 'pressbase-admin')}` : ''}
        </span>
      </legend>
      <div className={editorStyles.swatches}>
        {colors.map((c) => (
          <label key={c.slug} className={editorStyles.swatch} title={c.name}>
            <input
              type="radio"
              name={name}
              checked={slug === c.slug}
              onChange={() => onChange(presetRef('color', c.slug))}
            />
            <span style={{ background: c.color }} aria-hidden="true" />
            <span className="visually-hidden">{c.name}</span>
          </label>
        ))}
        {allowCustom && (
          <label
            className={`${editorStyles.swatch} ${editorStyles.customSwatch}`}
            title={__('Any colour', 'pressbase-admin')}
          >
            <input
              type="color"
              value={isHex6(resolved) ? (resolved as string) : '#888888'}
              onChange={(e) => onChange(e.target.value)}
              aria-label={`${label}: ${__('any colour', 'pressbase-admin')}`}
            />
            <span
              aria-hidden="true"
              data-active={Boolean(custom)}
              style={custom ? { background: custom } : undefined}
            />
          </label>
        )}
      </div>
      {userSet && <ThemeDefault onClick={() => onChange(undefined)} />}
    </fieldset>
  );
}

/** One of the theme's presets (sizes, spacing), as a row of choices. */
function PresetChoice({
  label,
  hint,
  options,
  value,
  custom,
  userSet,
  onChange,
}: {
  label: string;
  hint?: string;
  options: { value: string; label: string }[];
  value: string | undefined;
  custom?: string;
  userSet: boolean;
  onChange: (value: string | undefined) => void;
}) {
  const { __ } = useI18n();
  return (
    <fieldset className={panelStyles.field}>
      <legend className={panelStyles.fieldLabel}>
        <span>{label}</span>
        {custom && <span className={panelStyles.fieldValue}>{custom}</span>}
      </legend>
      {hint && <p className={panelStyles.hint}>{hint}</p>}
      <div className={panelStyles.presets}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {userSet && <ThemeDefault onClick={() => onChange(undefined)} />}
      {!userSet && !value && !custom && (
        <p className={panelStyles.hint}>{__('The theme decides.', 'pressbase-admin')}</p>
      )}
    </fieldset>
  );
}

function RadiusChoice({
  site,
  path,
  fallback,
}: {
  site: SiteStyles;
  path: string[];
  /** Where the value comes from when this path has none (BLOCK_ELEMENTS). */
  fallback?: readonly string[];
}) {
  const { __ } = useI18n();
  const radii = radiusSizes(site.base, site.config);
  const value =
    styleValue(site, [...path, 'border', 'radius']) ??
    (fallback ? styleValue(site, [...fallback, 'border', 'radius']) : undefined);
  const user = getPath(site.config, ['styles', ...path, 'border', 'radius']);
  if (!radii.length) return null;
  return (
    <PresetChoice
      label={__('Corners', 'pressbase-admin')}
      options={[
        { value: '0', label: __('Square', 'pressbase-admin') },
        ...radii.map((r) => ({ value: r.slug, label: r.name ?? r.slug })),
      ]}
      value={value === '0' || value === '0px' ? '0' : presetSlug(value, 'border-radius')}
      custom={value && value !== '0' && !presetSlug(value, 'border-radius') ? value : undefined}
      userSet={user !== undefined}
      onChange={(slug) =>
        site.change(
          setPath(
            site.config,
            ['styles', ...path, 'border', 'radius'],
            slug === undefined ? undefined : slug === '0' ? '0' : presetRef('border-radius', slug),
          ),
        )
      }
    />
  );
}

function SelectChoice({
  label,
  value,
  userSet,
  options,
  onChange,
}: {
  label: string;
  value: string;
  userSet: boolean;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const { __ } = useI18n();
  const id = useId();
  return (
    <div className={panelStyles.field}>
      <label htmlFor={id} className={panelStyles.fieldLabel}>
        {label}
      </label>
      <select
        id={id}
        className={panelStyles.select}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{__('Theme default', 'pressbase-admin')}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {userSet && <ThemeDefault onClick={() => onChange('')} />}
    </div>
  );
}

function NumberChoice({
  label,
  unit,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  const id = useId();
  const number = value ? Number.parseFloat(value) : Number.NaN;
  return (
    <div className={panelStyles.field}>
      <label htmlFor={id} className={panelStyles.fieldLabel}>
        {label}
      </label>
      <span className={panelStyles.number}>
        <input
          id={id}
          type="number"
          min={0}
          max={40}
          step={1}
          value={Number.isFinite(number) ? number : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : `${e.target.value}${unit}`)}
        />
        <span aria-hidden="true">{unit}</span>
      </span>
    </div>
  );
}
