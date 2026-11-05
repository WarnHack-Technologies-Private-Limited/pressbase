'use client';

/**
 * Responsive editing in Studio (#49). The block editor (WordPress 7.1)
 * already edits a style state: its style panels read and write
 * `style["@mobile"]` when the store's style state viewport is `@mobile`,
 * and the canvas prints those values in their media queries. Studio:
 *
 * - points the store at the device the top bar shows (`StudioResponsive`);
 * - keeps "values inherit downward" true on every edit (an `editor.BlockEdit`
 *   filter around `setAttributes`, `inheritDown()` in responsive-model.ts);
 * - shows what a block changes on this device, with a reset, and where it
 *   shows (`ResponsiveSettings`, in the inspector, and `VisibilityChoice`,
 *   in Layers too).
 *
 * See docs/architecture/studio.md#responsive-editing.
 */

import {
  privateApis as blockEditorPrivateApis,
  store as blockEditorStore,
} from '@wordpress/block-editor';
import { hasBlockSupport } from '@wordpress/blocks';
import { createHigherOrderComponent } from '@wordpress/compose';
import { useDispatch, useRegistry, useSelect } from '@wordpress/data';
import { addFilter } from '@wordpress/hooks';
import { Monitor, RotateCcw, Smartphone, Tablet } from 'lucide-react';
import { type ComponentType, useEffect, useId, useMemo } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { msgid } from '../../lib/i18n/locale';
import { unlock } from '../block-editor/private-apis';
import { Button } from '../ui/button';
import { isRegionBlock } from './layers-model';
import { DEVICES, type Device } from './layout-model';
import styles from './responsive.module.css';
import {
  blockVisibility,
  type DeviceFrame,
  type DeviceVisibility,
  deviceFrames,
  deviceState,
  deviceValues,
  displayValue,
  inheritDown,
  propertyLabel,
  resetDeviceValue,
  type Style,
  withBlockVisibility,
} from './responsive-model';

export const DEVICE_ICONS = { desktop: Monitor, tablet: Tablet, mobile: Smartphone } as const;

/** The block editor's settings key for the device the canvas shows (a private symbol). */
export const deviceTypeKey = unlock<{ deviceTypeKey: symbol }>(
  blockEditorPrivateApis,
).deviceTypeKey;

/**
 * The device whose styles the editor edits: the block editor's style state
 * viewport, which `StudioResponsive` sets. Desktop outside Studio.
 */
export function useStudioDevice(): Device {
  return useSelect((select) => {
    const viewport = unlock<{ getStyleStateViewport: () => string }>(
      select(blockEditorStore),
    ).getStyleStateViewport();
    if (viewport === '@tablet') return 'tablet';
    if (viewport === '@mobile') return 'mobile';
    return 'desktop';
  }, []);
}

type BlockEditorSelect = {
  getSelectedBlockClientId: () => string | null;
  getBlockName: (id: string) => string | null;
  getBlockAttributes: (id: string) => Record<string, unknown> | null;
  getBlockEditingMode: (id: string) => string;
  getSettings: () => Record<string, unknown>;
};
type BlockEditorDispatch = {
  updateBlockAttributes: (id: string, attributes: Record<string, unknown>) => void;
};

/** The theme's breakpoints, from the editor's settings (defaults outside an editor). */
export function useDeviceFrames(): Record<Device, DeviceFrame> {
  const viewport = useSelect(
    (select) =>
      (
        (select(blockEditorStore) as unknown as BlockEditorSelect).getSettings()
          .__experimentalFeatures as { viewport?: unknown } | undefined
      )?.viewport,
    [],
  );
  return useMemo(() => deviceFrames(viewport), [viewport]);
}

/**
 * Inside the editor: tells the block editor which device's styles the
 * inspector edits (Studio's components read it back with useStudioDevice()).
 */
export function StudioResponsive({ device }: { device: Device }) {
  const dispatch = unlock<{
    setStyleStateViewport: (viewport: string) => void;
    setResponsiveEditing: (enabled: boolean) => void;
  }>(useDispatch(blockEditorStore));
  useEffect(() => {
    dispatch.setStyleStateViewport(deviceState(device) ?? 'default');
    dispatch.setResponsiveEditing(device !== 'desktop');
  }, [device, dispatch]);
  return null;
}

/* ------------------------------------------------------- the edit filter */

type EditProps = {
  clientId: string;
  setAttributes: (next: unknown) => void;
  [key: string]: unknown;
};

/**
 * On Tablet and Mobile, every style change a block makes goes through
 * inheritDown(): a Tablet value reaches Mobile, and a Mobile reset goes
 * back to Tablet's value. The block's own controls and the style panels
 * both get this setAttributes (the filter is added after the block
 * editor's, so it wraps them).
 */
const withInheritance = createHigherOrderComponent(
  (BlockEdit: ComponentType<EditProps>) => (props: EditProps) => {
    const device = useStudioDevice();
    const registry = useRegistry();
    const { setAttributes, clientId } = props;
    const wrapped = useMemo(() => {
      if (device === 'desktop') return setAttributes;
      const apply = (next: unknown) => {
        if (!next || typeof next !== 'object' || !('style' in next)) return next;
        const select = registry.select(blockEditorStore) as unknown as BlockEditorSelect;
        const prev = select.getBlockAttributes(clientId)?.style as Style | undefined;
        const style = (next as { style?: Style }).style;
        return { ...next, style: inheritDown(device, prev, style) };
      };
      return (next: unknown) =>
        setAttributes(
          typeof next === 'function'
            ? (current: unknown) => apply((next as (c: unknown) => unknown)(current))
            : apply(next),
        );
    }, [device, setAttributes, clientId, registry]);
    if (wrapped === setAttributes) return <BlockEdit {...props} />;
    return <BlockEdit {...props} setAttributes={wrapped} />;
  },
  'withStudioResponsive',
);

let registered = false;
/** Adds the filter once; it only acts while Studio shows Tablet or Mobile. */
export function registerStudioResponsive(): void {
  if (registered) return;
  registered = true;
  addFilter('editor.BlockEdit', 'pressbase/studio/responsive', withInheritance);
}
registerStudioResponsive();

/* ------------------------------------------------------------ inspector */

/** Whether people can hide this block per device: its support, the theme's setting, its editing mode. */
function useCanHide(clientId: string | null): boolean {
  return useSelect(
    (select) => {
      if (!clientId) return false;
      const store = select(blockEditorStore) as unknown as BlockEditorSelect;
      const name = store.getBlockName(clientId);
      const features = store.getSettings().__experimentalFeatures as
        | { blockVisibility?: { allowEditing?: boolean } }
        | undefined;
      return Boolean(
        name &&
          !isRegionBlock(name) &&
          hasBlockSupport(name, 'visibility', true) &&
          features?.blockVisibility?.allowEditing !== false &&
          store.getBlockEditingMode(clientId) === 'default',
      );
    },
    [clientId],
  );
}

function useBlockAttribute<T>(clientId: string, key: string): T | undefined {
  return useSelect(
    (select) =>
      (select(blockEditorStore) as unknown as BlockEditorSelect).getBlockAttributes(clientId)?.[
        key
      ] as T | undefined,
    [clientId, key],
  );
}

/**
 * The inspector's responsive part, above a block's tabs: on Tablet and
 * Mobile, which size the changes apply to and what this block changes
 * there (each with a dot and a reset); on every device, where the block
 * shows.
 */
export function ResponsiveSettings({ clientId }: { clientId: string }) {
  const device = useStudioDevice();
  return (
    <>
      {device !== 'desktop' && <DeviceChanges clientId={clientId} device={device} />}
      <VisibilityChoice clientId={clientId} />
    </>
  );
}

function DeviceChanges({ clientId, device }: { clientId: string; device: Device }) {
  const { __, sprintf } = useI18n();
  const style = useBlockAttribute<Style>(clientId, 'style');
  const { updateBlockAttributes } = useDispatch(blockEditorStore) as unknown as BlockEditorDispatch;
  const frames = useDeviceFrames();
  const headingId = useId();
  const values = deviceValues(style, device);
  const own = values.filter((v) => !v.inherited);
  const inherited = values.filter((v) => v.inherited);
  const name = deviceName(device, __);
  const small = device === 'tablet' ? 'tablet' : 'mobile';
  const Icon = DEVICE_ICONS[device];
  const range = frameRange(frames[device], __, sprintf);

  const reset = (path?: string[]) =>
    updateBlockAttributes(clientId, { style: resetDeviceValue(style, device, path) });

  return (
    <section className={styles.device} aria-labelledby={headingId} data-device-changes={device}>
      <h3 id={headingId} className={styles.deviceTitle}>
        <Icon size={16} aria-hidden="true" />
        {sprintf(__('Editing for %s', 'pressbase-admin'), name)}
      </h3>
      <p className={styles.muted}>
        {range && `${range}. `}
        {device === 'tablet'
          ? __(
              'Style changes apply to tablets and carry down to phones. Desktop’s values show until you change them.',
              'pressbase-admin',
            )
          : __(
              'Style changes apply to phones only. Values from Tablet and Desktop show until you change them.',
              'pressbase-admin',
            )}
      </p>
      {own.length > 0 && (
        <>
          <p className={styles.listTitle}>{__(DEVICE_TEXT.changed[small], 'pressbase-admin')}</p>
          <ul className={styles.changes}>
            {own.map((v) => {
              const what = describe(v.path, __);
              return (
                <li key={v.path.join('.')} className={styles.change}>
                  <span className={styles.dot} aria-hidden="true" />
                  <span className={styles.changeText}>
                    <span>{what}</span>
                    <span className={styles.changeValue}>{displayValue(v.value)}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className={styles.iconButton}
                    icon={<RotateCcw size={14} aria-hidden="true" />}
                    aria-label={sprintf(__(DEVICE_TEXT.reset[small], 'pressbase-admin'), what)}
                    title={__('Reset', 'pressbase-admin')}
                    onClick={() => reset(v.path)}
                  />
                </li>
              );
            })}
          </ul>
        </>
      )}
      {inherited.length > 0 && (
        <p className={styles.muted} data-inherited>
          {sprintf(
            __('From Tablet: %s', 'pressbase-admin'),
            inherited.map((v) => `${describe(v.path, __)} ${displayValue(v.value)}`).join(', '),
          )}
        </p>
      )}
      {own.length > 1 && (
        <Button size="sm" variant="secondary" onClick={() => reset()}>
          {__(DEVICE_TEXT.resetAll[small], 'pressbase-admin')}
        </Button>
      )}
    </section>
  );
}

/** Sentences that name a device, whole so translators see each one. */
const DEVICE_TEXT = {
  changed: {
    tablet: msgid('Changed for tablet'),
    mobile: msgid('Changed for mobile'),
  },
  /* translators: %s: a setting ("Font size"). */
  reset: {
    tablet: msgid('Reset %s for tablet'),
    mobile: msgid('Reset %s for mobile'),
  },
  resetAll: {
    tablet: msgid('Reset all for tablet'),
    mobile: msgid('Reset all for mobile'),
  },
  hiddenHere: {
    desktop: msgid('Hidden on desktop. It shows here while it’s selected.'),
    tablet: msgid('Hidden on tablet. It shows here while it’s selected.'),
    mobile: msgid('Hidden on mobile. It shows here while it’s selected.'),
  },
} as const;

type Translate = (text: string, domain: string) => string;
type Format = (format: string, ...args: (string | number)[]) => string;

const deviceName = (device: Device, __: Translate) =>
  __(DEVICES.find((d) => d.id === device)?.label ?? device, 'pressbase-admin');

function describe(path: readonly string[], __: Translate): string {
  const { label, detail } = propertyLabel(path);
  const name = __(label, 'pressbase-admin');
  return detail ? `${name} (${__(detail, 'pressbase-admin')})` : name;
}

/** "480px and narrower", "481px to 782px", "wider than 782px". */
export function frameRange(frame: DeviceFrame, __: Translate, sprintf: Format): string {
  const { min, max } = frame.range;
  if (min && max) {
    return sprintf(__('Wider than %1$s, up to %2$s', 'pressbase-admin'), min, max);
  }
  if (max) return sprintf(__('%s and narrower', 'pressbase-admin'), max);
  if (min) return sprintf(__('Wider than %s', 'pressbase-admin'), min);
  return '';
}

/**
 * Show on: Desktop, Tablet, Mobile. Unticking one hides the block there
 * (`metadata.blockVisibility`); the published page doesn't send it to
 * that size. On the canvas, a block hidden on the device shown is left out
 * unless it's selected.
 */
export function VisibilityChoice({ clientId, compact }: { clientId: string; compact?: boolean }) {
  const { __ } = useI18n();
  const device = useStudioDevice();
  const metadata = useBlockAttribute<Record<string, unknown>>(clientId, 'metadata');
  const { updateBlockAttributes } = useDispatch(blockEditorStore) as unknown as BlockEditorDispatch;
  const frames = useDeviceFrames();
  const hintId = useId();
  const canHide = useCanHide(clientId);
  const visible: DeviceVisibility = blockVisibility(metadata);
  const devices = DEVICES.filter((d) => frames[d.id].available);
  const hiddenEverywhere = devices.every((d) => !visible[d.id]);

  let hint: string | null = null;
  if (hiddenEverywhere) {
    hint = __('Hidden on every size: visitors won’t see this block.', 'pressbase-admin');
  } else if (!visible[device]) {
    hint = __(DEVICE_TEXT.hiddenHere[device], 'pressbase-admin');
  }

  if (!canHide) return null;
  return (
    <fieldset
      className={styles.visibility}
      data-compact={compact || undefined}
      aria-describedby={hint ? hintId : undefined}
    >
      <legend className={styles.listTitle}>{__('Show on', 'pressbase-admin')}</legend>
      <div className={styles.visibilityOptions}>
        {devices.map((d) => {
          return (
            <label key={d.id} className={styles.visibilityOption}>
              <input
                type="checkbox"
                checked={visible[d.id]}
                data-show-on={d.id}
                onChange={(event) =>
                  updateBlockAttributes(clientId, {
                    metadata: withBlockVisibility(metadata, d.id, event.target.checked),
                  })
                }
              />
              <span>{__(d.label, 'pressbase-admin')}</span>
            </label>
          );
        })}
      </div>
      {hint && (
        <p id={hintId} className={styles.muted} role="status">
          {hint}
        </p>
      )}
    </fieldset>
  );
}

/**
 * Atop the Styles panel on Tablet and Mobile: the site's styles are the
 * same on every size (per-device site styles aren't in Studio yet), and
 * where to change one size.
 */
export function SiteStylesDeviceNote() {
  const { __ } = useI18n();
  const device = useStudioDevice();
  if (device === 'desktop') return null;
  return (
    <p className={styles.siteNote}>
      {__(
        'Site styles apply to every screen size. To change one size, select a block on the page and change it in Settings.',
        'pressbase-admin',
      )}
    </p>
  );
}
