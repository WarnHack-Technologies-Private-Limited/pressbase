'use client';

import {
  ArrowLeft,
  ChevronDown,
  Eye,
  Monitor,
  Redo2,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Tablet,
  Undo2,
} from 'lucide-react';
import { useId } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { Button } from '../ui/button';
import { DEVICES, type Device } from './layout-model';
import { type CanvasTarget, pageTitle, pageTree, type StudioPage } from './site-model';
import styles from './studio.module.css';

const DEVICE_ICONS = { desktop: Monitor, tablet: Tablet, mobile: Smartphone } as const;

export interface TopBarProps {
  pages: StudioPage[];
  target: CanvasTarget;
  /** The site shows its latest posts on the home page (no static front page). */
  postsOnFront: boolean;
  frontPageId: number;
  onTarget: (target: CanvasTarget) => void;
  device: Device;
  onDevice: (device: Device) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onAskAi: () => void;
  /** Preview and Publish: what they can do now. */
  canPublish: boolean;
  busy: 'preview' | 'publish' | null;
  onPreview: () => void;
  onPublish: () => void;
  /** Narrow screens: the inspector is a drawer this button opens. */
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  disabled?: boolean;
}

const targetValue = (target: CanvasTarget) => (target.kind === 'posts' ? 'posts' : String(target.id));

/**
 * Studio's top bar: back to the admin, the page being edited, the preview
 * size, undo and redo, Ask AI, Preview and Publish. Publish N with the list
 * of changes, and Discard, are #31; Ask AI is #63.
 */
export function TopBar(props: TopBarProps) {
  const { __, sprintf } = useI18n();
  const pickerId = useId();
  const tree = pageTree(props.pages);
  return (
    <header className={styles.topBar}>
      <a href="/admin" className={styles.back} title={__('Back to the dashboard', 'pressbase-admin')}>
        <ArrowLeft size={18} aria-hidden="true" />
        <span className={styles.backLabel}>{__('Dashboard', 'pressbase-admin')}</span>
      </a>
      <h1 className="visually-hidden">{__('Studio', 'pressbase-admin')}</h1>

      <div className={styles.picker}>
        <label htmlFor={pickerId} className="visually-hidden">
          {__('Page', 'pressbase-admin')}
        </label>
        <select
          id={pickerId}
          className={styles.pickerSelect}
          value={targetValue(props.target)}
          disabled={props.disabled}
          onChange={(event) => {
            const value = event.target.value;
            props.onTarget(value === 'posts' ? { kind: 'posts' } : { kind: 'page', id: Number(value) });
          }}
        >
          {props.postsOnFront && (
            <option value="posts">{__('Home (latest posts)', 'pressbase-admin')}</option>
          )}
          {tree.map(({ page, depth }) => {
            const title = pageTitle(page);
            const label =
              page.id === props.frontPageId && !props.postsOnFront
                ? sprintf(__('%s (home page)', 'pressbase-admin'), title)
                : page.status === 'publish'
                  ? title
                  : sprintf(__('%s (draft)', 'pressbase-admin'), title);
            return (
              <option key={page.id} value={page.id}>
                {`${' '.repeat(depth)}${label}`}
              </option>
            );
          })}
        </select>
        <ChevronDown size={16} aria-hidden="true" className={styles.pickerIcon} />
      </div>

      <fieldset className={styles.devices} disabled={props.disabled}>
        <legend className="visually-hidden">{__('Preview size', 'pressbase-admin')}</legend>
        {DEVICES.map((device) => {
          const Icon = DEVICE_ICONS[device.id];
          const label = __(device.label, 'pressbase-admin');
          return (
            <button
              key={device.id}
              type="button"
              className={styles.deviceButton}
              aria-pressed={props.device === device.id}
              aria-label={label}
              title={label}
              onClick={() => props.onDevice(device.id)}
            >
              <Icon size={18} aria-hidden="true" />
            </button>
          );
        })}
      </fieldset>

      <div className={styles.history}>
        <Button
          size="sm"
          variant="ghost"
          className={styles.iconButton}
          icon={<Undo2 size={18} aria-hidden="true" />}
          aria-label={__('Undo', 'pressbase-admin')}
          title={__('Undo (Ctrl+Z)', 'pressbase-admin')}
          aria-disabled={!props.canUndo}
          onClick={() => props.canUndo && props.onUndo()}
        />
        <Button
          size="sm"
          variant="ghost"
          className={styles.iconButton}
          icon={<Redo2 size={18} aria-hidden="true" />}
          aria-label={__('Redo', 'pressbase-admin')}
          title={__('Redo (Ctrl+Shift+Z)', 'pressbase-admin')}
          aria-disabled={!props.canRedo}
          onClick={() => props.canRedo && props.onRedo()}
        />
      </div>

      <span className={styles.spacer} />

      <Button
        size="sm"
        variant="ghost"
        className={styles.askAi}
        icon={<Sparkles size={16} aria-hidden="true" />}
        aria-disabled="true"
        onClick={props.onAskAi}
      >
        <span className={styles.collapsible}>{__('Ask AI', 'pressbase-admin')}</span>
        <span className={styles.soon}>
          {__('Coming soon', 'pressbase-admin')}
        </span>
      </Button>
      <Button
        size="sm"
        variant="secondary"
        icon={<Eye size={16} aria-hidden="true" />}
        loading={props.busy === 'preview'}
        disabled={props.disabled}
        onClick={props.onPreview}
        aria-label={__('Preview (opens in a new tab)', 'pressbase-admin')}
      >
        <span className={styles.collapsible}>{__('Preview', 'pressbase-admin')}</span>
      </Button>
      <Button
        size="sm"
        variant="primary"
        loading={props.busy === 'publish'}
        aria-disabled={!props.canPublish}
        disabled={props.disabled}
        title={props.canPublish ? undefined : __('No changes to publish yet', 'pressbase-admin')}
        onClick={() => props.canPublish && props.onPublish()}
      >
        {__('Publish', 'pressbase-admin')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className={`${styles.iconButton} ${styles.inspectorToggle}`}
        icon={<SlidersHorizontal size={18} aria-hidden="true" />}
        aria-label={__('Settings', 'pressbase-admin')}
        aria-expanded={props.inspectorOpen}
        aria-controls="studio-inspector"
        onClick={props.onToggleInspector}
      />
    </header>
  );
}
