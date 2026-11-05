'use client';

import {
  BlockIcon,
  BlockStyles,
  store as blockEditorStore,
  InspectorControls,
  useBlockDisplayInformation,
} from '@wordpress/block-editor';
import { store as blocksStore } from '@wordpress/blocks';
import { PanelBody, __experimentalUseSlotFills as useSlotFills } from '@wordpress/components';
import { useDispatch, useSelect } from '@wordpress/data';
import { __ as wp__ } from '@wordpress/i18n';
import { LayoutTemplate, Lock, RotateCcw, X } from 'lucide-react';
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useId, useRef } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { lightScope } from '../block-editor';
import { Button } from '../ui/button';
import { TEMPLATE_PART } from './canvas-model';
import { INSPECTOR_TABS, type InspectorTab, type InspectorTabId } from './layout-model';
import { MODES, modeTabs, type StudioMode, showsControl } from './mode-model';
import { type PartInfo, useSelectedPart } from './regions';
import { ResponsiveSettings, useStudioDevice } from './responsive';
import { deviceTabs } from './responsive-model';
import { contentRootId } from './sections-panel';
import styles from './studio.module.css';
import { SwapLayoutBox } from './swap-layout';

export interface PageSummary {
  /** "Home", "About us"… or "Latest posts". */
  title: string;
  isHome: boolean;
  /** The page's status for people ("Published", "Draft"), when it's a page. */
  status?: string;
  /** The template showing it ("Page"). */
  template?: string;
  /** Where its details (title, address, parent) are edited. */
  editLink?: string;
  /** False for the latest posts, which have no content of their own. */
  hasContent: boolean;
  /** The custom template chosen ('' for the default), and the ones the page may use (#29). */
  templateSlug?: string;
  templates?: { slug: string; title: string }[];
  /** Picks another template; absent when the page can't change it here. */
  onTemplate?: (slug: string) => void;
}

interface InspectorProps {
  page: PageSummary;
  parts: ReadonlyMap<string, PartInfo>;
  tab: InspectorTabId;
  onTab: (tab: InspectorTabId) => void;
  /** Whether a part can go back to the theme's design, and doing it. */
  canReset: (slug: string) => boolean;
  onReset: (slug: string) => void;
  /** Narrow screens: the inspector is a drawer with a close button. */
  onClose?: () => void;
  /** The header and footer can't be changed by this person (no `edit_theme_options`, #29). */
  partsLocked?: boolean;
  /** Simple or Advanced (#32): which settings show. */
  mode: StudioMode;
  onMode: (mode: StudioMode) => void;
}

const select = (s: unknown) =>
  s as {
    getSelectedBlockClientId: () => string | null;
    getBlockName: (id: string) => string | null;
    getBlockAttributes: (id: string) => Record<string, unknown> | null;
    getBlockRootClientId: (id: string) => string | null;
    getBlocks: () => import('@wordpress/blocks').Block[];
  };

/**
 * The inspector: what's selected and its settings, in Content, Style and
 * Layout tabs (layout-model.ts lists which WordPress control groups each tab
 * holds). With nothing selected it describes the page; a template part says
 * that it's on every page, with Reset to theme for a customised one (#30).
 */
export function Inspector(props: InspectorProps) {
  const { __ } = useI18n();
  const clientId = useSelect((s) => select(s(blockEditorStore)).getSelectedBlockClientId(), []);
  const name = useSelect(
    (s) => (clientId ? select(s(blockEditorStore)).getBlockName(clientId) : null),
    [clientId],
  );
  const partSlug = useSelect(
    (s) =>
      clientId && name === TEMPLATE_PART
        ? String(select(s(blockEditorStore)).getBlockAttributes(clientId)?.slug ?? '')
        : '',
    [clientId, name],
  );

  // A section of the page (a direct child of its content) can swap its layout (#45).
  const isSection = useSelect(
    (s) => {
      if (!clientId) return false;
      const store = select(s(blockEditorStore));
      const root = contentRootId(store);
      return Boolean(root && store.getBlockRootClientId(clientId) === root);
    },
    [clientId],
  );

  const inPart = useSelectedPart();
  const { selectBlock } = useDispatch(blockEditorStore) as unknown as {
    selectBlock: (clientId: string) => void;
  };

  let body: ReactNode;
  if (!clientId) body = <PageInfo page={props.page} />;
  else if (name === TEMPLATE_PART) {
    body = (
      <PartInfoView
        info={props.parts.get(partSlug)}
        slug={partSlug}
        canReset={!props.partsLocked && props.canReset(partSlug)}
        onReset={() => props.onReset(partSlug)}
        locked={props.partsLocked}
      />
    );
  } else {
    body = (
      <>
        {inPart && (
          <PartNote
            title={props.parts.get(inPart.slug)?.title ?? inPart.slug}
            onSelectPart={() => selectBlock(inPart.clientId)}
          />
        )}
        {isSection && showsControl(props.mode, 'swap-layout') && (
          <SwapLayoutBox clientId={clientId} />
        )}
        <BlockSettings
          clientId={clientId}
          tab={props.tab}
          onTab={props.onTab}
          mode={props.mode}
          onMode={props.onMode}
        />
      </>
    );
  }

  return (
    <aside
      id="studio-inspector"
      className={styles.inspector}
      aria-label={__('Settings', 'pressbase-admin')}
      onKeyDown={(event: ReactKeyboardEvent) => {
        if (event.key === 'Escape' && props.onClose && !event.defaultPrevented) props.onClose();
      }}
    >
      {props.onClose && (
        <Button
          size="sm"
          variant="ghost"
          className={`${styles.iconButton} ${styles.inspectorClose}`}
          aria-label={__('Close settings', 'pressbase-admin')}
          icon={<X size={16} aria-hidden="true" />}
          onClick={props.onClose}
        />
      )}
      <div className={styles.inspectorBody}>{body}</div>
      <ModeSwitch mode={props.mode} onMode={props.onMode} />
    </aside>
  );
}

/**
 * Simple ◉ Advanced (#32), at the foot of the inspector: a segmented
 * control (toggle buttons with `aria-pressed`) and what the mode shows.
 */
export function ModeSwitch({
  mode,
  onMode,
}: {
  mode: StudioMode;
  onMode: (mode: StudioMode) => void;
}) {
  const { __ } = useI18n();
  const hintId = useId();
  const current = MODES.find((m) => m.id === mode) ?? MODES[0];
  return (
    <fieldset className={styles.modeSwitch} aria-describedby={hintId}>
      <legend className="visually-hidden">{__('Settings to show', 'pressbase-admin')}</legend>
      <div className={styles.modeButtons}>
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={styles.modeButton}
            aria-pressed={m.id === mode}
            onClick={() => onMode(m.id)}
          >
            {__(m.label, 'pressbase-admin')}
          </button>
        ))}
      </div>
      <p id={hintId} className={styles.modeHint}>
        {current && __(current.hint, 'pressbase-admin')}
      </p>
    </fieldset>
  );
}

function PageInfo({ page }: { page: PageSummary }) {
  const { __ } = useI18n();
  const templateId = useId();
  return (
    <div className={styles.inspectorIntro}>
      <p className={styles.eyebrow}>
        {page.isHome ? __('Home page', 'pressbase-admin') : __('Page', 'pressbase-admin')}
      </p>
      <h2 className={styles.inspectorTitle}>{page.title}</h2>
      <dl className={styles.facts}>
        {page.status && (
          <>
            <dt>{__('Status', 'pressbase-admin')}</dt>
            <dd>{page.status}</dd>
          </>
        )}
        {page.template && !page.onTemplate && (
          <>
            <dt>{__('Template', 'pressbase-admin')}</dt>
            <dd>{page.template}</dd>
          </>
        )}
      </dl>
      {page.onTemplate && (
        <div className={styles.templateField}>
          <label htmlFor={templateId}>{__('Template', 'pressbase-admin')}</label>
          <select
            id={templateId}
            className={styles.select}
            value={page.templateSlug ?? ''}
            aria-describedby={`${templateId}-hint`}
            onChange={(event) => page.onTemplate?.(event.target.value)}
          >
            <option value="">{__('Default', 'pressbase-admin')}</option>
            {(page.templates ?? []).map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.title}
              </option>
            ))}
          </select>
          <p id={`${templateId}-hint`} className={styles.muted}>
            {__('How the page is laid out around its sections.', 'pressbase-admin')}
          </p>
        </div>
      )}
      {page.hasContent ? (
        <p>
          {__(
            'Click any text on the page to change it. Choose a block to see its settings here.',
            'pressbase-admin',
          )}
        </p>
      ) : (
        <p>
          {__(
            'Your home page lists your latest posts, so it has no text of its own to edit. Choose a page from the menu at the top to edit it.',
            'pressbase-admin',
          )}
        </p>
      )}
      <p className={styles.muted}>
        {__(
          'Nothing goes live until you press Publish. Undo with Ctrl+Z (⌘Z on a Mac).',
          'pressbase-admin',
        )}
      </p>
      {page.editLink && (
        <a href={page.editLink} className={styles.inlineLink}>
          {__('Edit the title, address and other details', 'pressbase-admin')}
        </a>
      )}
    </div>
  );
}

function PartInfoView({
  info,
  slug,
  canReset,
  onReset,
  locked,
}: {
  info?: PartInfo;
  slug: string;
  canReset: boolean;
  onReset: () => void;
  locked?: boolean;
}) {
  const { __ } = useI18n();
  return (
    <div className={styles.inspectorIntro}>
      <p className={styles.eyebrow}>{__('On all pages', 'pressbase-admin')}</p>
      <h2 className={styles.inspectorTitle}>{info?.title || slug}</h2>
      <p className={styles.lockNote}>
        {locked ? (
          <Lock size={16} aria-hidden="true" />
        ) : (
          <LayoutTemplate size={16} aria-hidden="true" />
        )}
        <span>
          {locked
            ? __(
                'This part of your design is on every page, so only people who can change the site’s design can edit it. Ask an administrator if it needs a change.',
                'pressbase-admin',
              )
            : __(
                'This part of your design is on every page. Click any text in it to change it; your changes show on every page once you publish.',
                'pressbase-admin',
              )}
        </span>
      </p>
      {canReset && (
        <div className={styles.resetBox}>
          <p className={styles.muted}>
            {info?.customised
              ? __('You’ve changed this from the theme’s design.', 'pressbase-admin')
              : __('Your draft changes this.', 'pressbase-admin')}
          </p>
          <Button
            size="sm"
            variant="secondary"
            icon={<RotateCcw size={16} aria-hidden="true" />}
            onClick={onReset}
          >
            {__('Reset to theme', 'pressbase-admin')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Above a block's settings when it sits in a template part. */
function PartNote({ title, onSelectPart }: { title: string; onSelectPart: () => void }) {
  const { __, sprintf } = useI18n();
  return (
    <div className={styles.partNote}>
      <LayoutTemplate size={14} aria-hidden="true" />
      <span>
        {sprintf(__('In the %s: changes show on every page.', 'pressbase-admin'), title)}{' '}
        <button type="button" className={styles.partNoteLink} onClick={onSelectPart}>
          {sprintf(__('Select the whole %s', 'pressbase-admin'), title)}
        </button>
      </span>
    </div>
  );
}

/** Every inspector group's fills, so a tab can tell whether it has anything to show. */
function useTabsWithControls(): (tab: InspectorTab) => boolean {
  const filled = new Set<string>();
  for (const tab of INSPECTOR_TABS) {
    for (const group of tab.groups) {
      // The tabs and their groups are constant, so the hooks always run in the same order.
      const fills = useSlotFills(group.slot) as unknown[] | undefined;
      if (fills?.length) filled.add(group.slot);
    }
  }
  return (tab) => tab.groups.some((group) => filled.has(group.slot));
}

function BlockSettings({
  clientId,
  tab,
  onTab,
  mode,
  onMode,
}: {
  clientId: string;
  tab: InspectorTabId;
  onTab: (tab: InspectorTabId) => void;
  mode: StudioMode;
  onMode: (mode: StudioMode) => void;
}) {
  const { __ } = useI18n();
  const info = useBlockDisplayInformation(clientId) as {
    title?: string;
    icon?: unknown;
    description?: string;
  } | null;
  const hasStyles = useSelect(
    (s) => {
      const name = select(s(blockEditorStore)).getBlockName(clientId);
      const getStyles = (s(blocksStore) as { getBlockStyles: (n: string) => unknown[] | undefined })
        .getBlockStyles;
      return Boolean(name && getStyles(name)?.length);
    },
    [clientId],
  );
  const hasControls = useTabsWithControls();
  const baseId = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // The tabs with only the groups this mode and device show (mode-model.ts, responsive-model.ts).
  const device = useStudioDevice();
  const tabs = deviceTabs(modeTabs(mode), device);
  const showStyles = hasStyles && device === 'desktop';
  const active = tabs.find((t) => t.id === tab) ?? (tabs[0] as InspectorTab);
  const activeHas = hasControls(active) || (active.id === 'style' && showStyles);
  // In Simple, a tab can be empty while Advanced has settings for the block.
  const moreInAdvanced =
    !activeHas &&
    mode === 'simple' &&
    hasControls(deviceTabs(INSPECTOR_TABS, device).find((t) => t.id === active.id) as InspectorTab);

  const onTabKey = (event: ReactKeyboardEvent, index: number) => {
    const last = INSPECTOR_TABS.length - 1;
    const next = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    onTab((INSPECTOR_TABS[next] as InspectorTab).id);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className={styles.blockSettings}>
      <div className={styles.blockCard}>
        <span className={styles.blockIcon}>
          <BlockIcon icon={info?.icon as never} showColors />
        </span>
        <div>
          <h2 className={styles.inspectorTitle}>{info?.title}</h2>
          {info?.description && <p className={styles.muted}>{info.description}</p>}
        </div>
      </div>
      {/* Responsive editing (#49): what this block changes on the device shown, and where it shows. */}
      <ResponsiveSettings clientId={clientId} />
      <div className={styles.tabs} role="tablist" aria-label={__('Settings', 'pressbase-admin')}>
        {INSPECTOR_TABS.map((t, index) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`${baseId}-${t.id}`}
            aria-selected={t.id === active.id}
            aria-controls={`${baseId}-${t.id}-panel`}
            tabIndex={t.id === active.id ? 0 : -1}
            className={styles.tab}
            onClick={() => onTab(t.id)}
            onKeyDown={(event) => onTabKey(event, index)}
          >
            {__(t.label, 'pressbase-admin')}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-${active.id}-panel`}
        aria-labelledby={`${baseId}-${active.id}`}
        className={`${lightScope} ${styles.tabPanel}`}
      >
        {active.id === 'style' && showStyles && (
          <PanelBody title={wp__('Styles')}>
            <BlockStyles clientId={clientId} />
          </PanelBody>
        )}
        {active.groups.map((group) =>
          group.group === 'advanced' ? (
            hasControls({ ...active, groups: [group] }) && (
              <PanelBody key={group.group} title={wp__('Advanced')} initialOpen={false}>
                <InspectorControls.Slot group="advanced" />
              </PanelBody>
            )
          ) : (
            <InspectorControls.Slot
              key={group.group}
              group={group.group}
              label={group.label ? wp__(group.label) : undefined}
            />
          ),
        )}
        {!activeHas && !moreInAdvanced && (
          <p className={styles.tabEmpty}>{__(active.empty, 'pressbase-admin')}</p>
        )}
        {moreInAdvanced && (
          <div className={styles.tabEmpty}>
            <p>{__('More settings for this block are in Advanced.', 'pressbase-admin')}</p>
            <Button size="sm" variant="secondary" onClick={() => onMode('advanced')}>
              {__('Show Advanced settings', 'pressbase-admin')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
