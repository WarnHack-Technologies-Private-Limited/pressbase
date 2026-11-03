'use client';

import { store as blockEditorStore } from '@wordpress/block-editor';
import { __experimentalGetBlockLabel as getBlockLabel, getBlockType } from '@wordpress/blocks';
import { useDispatch, useSelect } from '@wordpress/data';
import { ChevronRight } from 'lucide-react';
import { useMemo } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { breadcrumbTrail, type ChainLink, TEMPLATE_PART } from './canvas-model';
import type { PartInfo } from './regions';
import styles from './studio.module.css';

interface EditorSelectors {
  getSelectedBlockClientId: () => string | null;
  getBlockParents: (id: string) => string[];
  getBlockName: (id: string) => string | null;
  getBlockAttributes: (id: string) => Record<string, unknown> | null;
}

/** What people call a block: its name in Layers ("Hero"), else its label or type. */
function blockLabel(name: string, attributes: Record<string, unknown>): string {
  const custom = (attributes.metadata as { name?: string } | undefined)?.name;
  if (custom) return custom;
  const type = getBlockType(name);
  if (!type) return name;
  const label = getBlockLabel(type as never, attributes, 'breadcrumb');
  // Labels can be long (a heading's text): keep the trail short.
  return label.length > 40 ? `${label.slice(0, 39)}…` : label;
}

/** Site › Page › Section › Block, for the selection (breadcrumbTrail()). */
export function Breadcrumb({
  site,
  page,
  parts,
}: {
  site: string;
  page: string;
  parts: ReadonlyMap<string, PartInfo>;
}) {
  const { __ } = useI18n();
  // A string, so the selector's result compares equal while nothing changes.
  const chainJson = useSelect(
    (select) => {
      const editor = select(blockEditorStore) as unknown as EditorSelectors;
      const selected = editor.getSelectedBlockClientId();
      if (!selected) return '[]';
      const links = [...editor.getBlockParents(selected), selected].map((clientId): ChainLink => {
        const name = editor.getBlockName(clientId) ?? '';
        const attributes = editor.getBlockAttributes(clientId) ?? {};
        const label =
          name === TEMPLATE_PART
            ? (parts.get(String(attributes.slug ?? ''))?.title ?? String(attributes.slug ?? ''))
            : blockLabel(name, attributes);
        return { clientId, name, label };
      });
      return JSON.stringify(links);
    },
    [parts],
  );
  const chain = useMemo(() => JSON.parse(chainJson) as ChainLink[], [chainJson]);
  const { selectBlock, clearSelectedBlock } = useDispatch(blockEditorStore) as unknown as {
    selectBlock: (clientId: string) => void;
    clearSelectedBlock: () => void;
  };
  const trail = breadcrumbTrail({ site, page, chain });
  const levelName = {
    site: __('Site', 'pressbase-admin'),
    page: __('Page', 'pressbase-admin'),
    section: __('Section', 'pressbase-admin'),
    block: __('Block', 'pressbase-admin'),
  };

  return (
    <nav className={styles.breadcrumb} aria-label={__('Breadcrumb', 'pressbase-admin')}>
      <ol>
        {trail.map((crumb, index) => {
          const last = index === trail.length - 1;
          const content = (
            <>
              <span className="visually-hidden">{levelName[crumb.level]}: </span>
              {crumb.label}
            </>
          );
          return (
            <li key={`${crumb.level}-${crumb.clientId ?? ''}`}>
              {index > 0 && <ChevronRight size={14} aria-hidden="true" className={styles.crumbSep} />}
              {last ? (
                <span className={styles.crumbCurrent} aria-current="location">
                  {content}
                </span>
              ) : crumb.level === 'site' ? (
                <span className={styles.crumbText}>{content}</span>
              ) : (
                <button
                  type="button"
                  className={styles.crumb}
                  onClick={() =>
                    crumb.clientId ? selectBlock(crumb.clientId) : clearSelectedBlock()
                  }
                >
                  {content}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
