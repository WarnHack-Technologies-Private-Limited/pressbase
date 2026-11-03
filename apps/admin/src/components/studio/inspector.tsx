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
import { useSelect } from '@wordpress/data';
import { __ as wp__ } from '@wordpress/i18n';
import { Lock, X } from 'lucide-react';
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useId, useRef } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { lightScope } from '../block-editor';
import { Button } from '../ui/button';
import { TEMPLATE_PART } from './canvas-model';
import { INSPECTOR_TABS, type InspectorTab, type InspectorTabId } from './layout-model';
import type { PartInfo } from './regions';
import styles from './studio.module.css';

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
}

interface InspectorProps {
  page: PageSummary;
  parts: ReadonlyMap<string, PartInfo>;
  tab: InspectorTabId;
  onTab: (tab: InspectorTabId) => void;
  /** Narrow screens: the inspector is a drawer with a close button. */
  onClose?: () => void;
}

const select = (s: unknown) =>
  s as {
    getSelectedBlockClientId: () => string | null;
    getBlockName: (id: string) => string | null;
    getBlockAttributes: (id: string) => Record<string, unknown> | null;
  };

/**
 * The inspector: what's selected and its settings, in Content, Style and
 * Layout tabs (layout-model.ts lists which WordPress control groups each tab
 * holds). With nothing selected it describes the page; a template part
 * says what it is and when it becomes editable (#30).
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

  let body: ReactNode;
  if (!clientId) body = <PageInfo page={props.page} />;
  else if (name === TEMPLATE_PART) {
    body = <PartInfoView info={props.parts.get(partSlug)} slug={partSlug} />;
  } else {
    body = <BlockSettings clientId={clientId} tab={props.tab} onTab={props.onTab} />;
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
      {body}
    </aside>
  );
}

function PageInfo({ page }: { page: PageSummary }) {
  const { __ } = useI18n();
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
        {page.template && (
          <>
            <dt>{__('Template', 'pressbase-admin')}</dt>
            <dd>{page.template}</dd>
          </>
        )}
      </dl>
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

function PartInfoView({ info, slug }: { info?: PartInfo; slug: string }) {
  const { __ } = useI18n();
  return (
    <div className={styles.inspectorIntro}>
      <p className={styles.eyebrow}>{__('Shown on every page', 'pressbase-admin')}</p>
      <h2 className={styles.inspectorTitle}>{info?.title || slug}</h2>
      <p className={styles.lockNote}>
        <Lock size={16} aria-hidden="true" />
        <span>
          {__(
            'Editing the header and footer here arrives with #30. Until then they show exactly as visitors see them, and changes to this page leave them as they are.',
            'pressbase-admin',
          )}
        </span>
      </p>
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
}: {
  clientId: string;
  tab: InspectorTabId;
  onTab: (tab: InspectorTabId) => void;
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
  const active = INSPECTOR_TABS.find((t) => t.id === tab) ?? (INSPECTOR_TABS[0] as InspectorTab);
  const activeHas = hasControls(active) || (active.id === 'style' && hasStyles);

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
        {active.id === 'style' && hasStyles && (
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
        {!activeHas && <p className={styles.tabEmpty}>{__(active.empty, 'pressbase-admin')}</p>}
      </div>
    </div>
  );
}
