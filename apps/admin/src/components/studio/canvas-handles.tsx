'use client';

import { store as blockEditorStore } from '@wordpress/block-editor';
import { type Block as BlockInstance, getBlockSupport, getBlockType } from '@wordpress/blocks';
import { useDispatch, useRegistry, useSelect } from '@wordpress/data';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useI18n } from '@/lib/i18n/context';
import { blockElement, useCanvasIframe } from './canvas-frame';
import styles from './canvas-tools.module.css';
import {
  columnWidth,
  fractionLabel,
  MAX_SPACING,
  resizeColumns,
  type Side,
  type SpacingKind,
  type SpacingPreset,
  type SpacingValue,
  shares,
  snapSpacing,
  spacingPx,
  spacingSides,
  stepColumns,
  stepSpacing,
  storedSpacing,
  withSpacing,
} from './handles-model';
import type { Device } from './layout-model';
import type { StudioMode } from './mode-model';
import type { Style } from './responsive-model';
import { useCanvasEvents } from './swap-layout';

/**
 * Handles on the canvas (#37), Elementor's: drag a selected section's or
 * group's padding and margin, and the gap between columns. Spacing snaps to
 * the theme's presets in Simple and takes exact pixels in Advanced; column
 * widths snap to common fractions. A label shows the value while dragging.
 * On Tablet and Mobile, spacing is that size's (`style["@tablet"]`,
 * `["@mobile"]`), as in the inspector.
 *
 * Every handle is a focusable WAI-ARIA slider (spacing) or separator
 * (columns): the arrow keys move it a preset or a fraction (a pixel or a
 * percent in Advanced; ten with Shift), Home and End to the ends. A drag,
 * or a run of key presses, is one undo step (the block editor joins
 * changes to the same attribute). Drawn in Studio's document over the
 * canvas, after the section toolbar in the tab order. The inspector's
 * Dimensions panel and the Column block's width do the same.
 *
 * See docs/architecture/studio.md#handles-on-the-canvas.
 */

type Selectors = {
  getBlocks: () => BlockInstance[];
  getBlock: (id: string) => BlockInstance | null;
  getBlockName: (id: string) => string | null;
  getBlockAttributes: (id: string) => Record<string, unknown> | null;
  getBlockOrder: (root?: string) => string[];
  getBlockRootClientId: (id: string) => string | null;
  getBlockEditingMode: (id: string) => string;
  getSelectedBlockClientId: () => string | null;
  getSettings: () => Record<string, unknown>;
  isTyping: () => boolean;
  isDraggingBlocks: () => boolean;
};

type Actions = {
  updateBlockAttributes: (
    ids: string | string[],
    attributes: Record<string, unknown>,
    options?: { uniqueByBlock: boolean },
  ) => void;
};

/** Container blocks only: a selected heading has padding too, but handles would crowd its text. */
const REGIONS = new Set(['core/post-content', 'core/template-part']);

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface Measured {
  /** The block's border box, relative to the canvas frame. */
  box: Rect;
  /** The iframe's visible area, relative to the frame. */
  view: Rect;
  padding: Record<Side, number>;
  margin: Record<Side, number>;
  /** Columns side by side (not stacked), relative to the frame. */
  columns: { clientId: string; rect: Rect }[];
}

/** The theme's spacing presets (custom, then theme, then WordPress's), by slug. */
function presetList(settings: Record<string, unknown>): { slug: string; name: string }[] {
  const features = settings.__experimentalFeatures as
    | {
        spacing?: {
          spacingSizes?: Record<string, { slug: string; name: string }[]>;
          defaultSpacingSizes?: boolean;
        };
      }
    | undefined;
  const sizes = features?.spacing?.spacingSizes ?? {};
  const out = new Map<string, { slug: string; name: string }>();
  // WordPress's own sizes only when the theme keeps them (`defaultSpacingSizes`).
  const origins =
    features?.spacing?.defaultSpacingSizes === false
      ? ['theme', 'custom']
      : ['default', 'theme', 'custom'];
  for (const origin of origins) {
    for (const size of sizes[origin] ?? []) out.set(size.slug, size);
  }
  return [...out.values()];
}

export function CanvasHandles({
  frameRef,
  device,
  mode,
}: {
  frameRef: RefObject<HTMLDivElement | null>;
  device: Device;
  mode: StudioMode;
}) {
  const { __, sprintf } = useI18n();
  const iframe = useCanvasIframe(frameRef);
  const registry = useRegistry();
  const actions = useDispatch(blockEditorStore) as unknown as Actions;
  const events = useCanvasEvents();
  const [measured, setMeasured] = useState<Measured | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const gesture = useRef<{ id: string; labelled: boolean } | null>(null);

  const { target, columnsId, blocks, hidden, settings } = useSelect((select) => {
    const s = select(blockEditorStore) as unknown as Selectors;
    const selected = s.getSelectedBlockClientId();
    const name = selected ? (s.getBlockName(selected) ?? '') : '';
    const editable = Boolean(selected) && s.getBlockEditingMode(selected ?? '') === 'default';
    // Spacing handles: a selected container (a section, a group, a column…).
    const container =
      selected &&
      editable &&
      !REGIONS.has(name) &&
      (s.getBlock(selected)?.innerBlocks.length ?? 0) > 0
        ? selected
        : null;
    // Column handles: the Columns block, selected or holding the selected column.
    let columns: string | null = null;
    if (selected && editable && name === 'core/columns') columns = selected;
    else if (selected && name === 'core/column') {
      const parent = s.getBlockRootClientId(selected);
      if (parent && s.getBlockEditingMode(parent) === 'default') columns = parent;
    }
    return {
      target: container,
      columnsId: columns,
      blocks: s.getBlocks(),
      hidden: s.isTyping() || s.isDraggingBlocks(),
      settings: s.getSettings(),
    };
  }, []);

  const presetNames = useMemo(() => presetList(settings), [settings]);
  const [presets, setPresets] = useState<SpacingPreset[]>([]);

  // Each preset's size on the canvas now (they're often clamp() or rem).
  useLayoutEffect(() => {
    const doc = iframe?.contentDocument;
    if (!doc?.body) return;
    const probe = doc.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;';
    doc.body.appendChild(probe);
    const out = presetNames.map(({ slug, name }) => {
      probe.style.paddingTop = `var(--wp--preset--spacing--${slug})`;
      return { slug, name, px: Number.parseFloat(getComputedStyle(probe).paddingTop) || 0 };
    });
    probe.remove();
    setPresets(out);
  }, [iframe, presetNames, device]);

  // Where the block and its columns are: again on scroll, resize and every change.
  useLayoutEffect(() => {
    const doc = iframe?.contentDocument;
    const frame = frameRef.current;
    const ids = [target, columnsId].filter(Boolean) as string[];
    if (!doc || !frame || !iframe || !ids.length) {
      setMeasured(null);
      return;
    }
    let raf = 0;
    const measure = () => {
      raf = 0;
      const frameRect = frame.getBoundingClientRect();
      const iframeRect = iframe.getBoundingClientRect();
      const dx = iframeRect.left - frameRect.left;
      const dy = iframeRect.top - frameRect.top;
      const rel = (r: DOMRect): Rect => ({
        top: r.top + dy,
        left: r.left + dx,
        width: r.width,
        height: r.height,
      });
      const view = { top: dy, left: dx, width: iframeRect.width, height: iframeRect.height };
      const sides = (style: CSSStyleDeclaration, kind: 'padding' | 'margin') =>
        Object.fromEntries(
          (['top', 'right', 'bottom', 'left'] as const).map((side) => [
            side,
            Number.parseFloat(style.getPropertyValue(`${kind}-${side}`)) || 0,
          ]),
        ) as Record<Side, number>;
      const element = target ? blockElement(iframe, target) : null;
      const computed = element ? getComputedStyle(element) : null;
      const select = registry.select(blockEditorStore) as unknown as Selectors;
      let columns: Measured['columns'] = [];
      if (columnsId && device === 'desktop') {
        columns = select.getBlockOrder(columnsId).flatMap((clientId) => {
          const column = blockElement(iframe, clientId);
          return column ? [{ clientId, rect: rel(column.getBoundingClientRect()) }] : [];
        });
        // Stacked (a phone's layout): no gaps to drag.
        const stacked = columns.some(
          (column, i) =>
            i > 0 &&
            column.rect.top >=
              (columns[i - 1]?.rect.top ?? 0) + (columns[i - 1]?.rect.height ?? 0) - 1,
        );
        if (stacked || columns.length < 2) columns = [];
      }
      setMeasured({
        box: element
          ? rel(element.getBoundingClientRect())
          : { top: 0, left: 0, width: 0, height: 0 },
        view,
        padding: computed ? sides(computed, 'padding') : { top: 0, right: 0, bottom: 0, left: 0 },
        margin: computed ? sides(computed, 'margin') : { top: 0, right: 0, bottom: 0, left: 0 },
        columns,
      });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    const win = iframe.contentWindow;
    win?.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(doc.body);
    observer.observe(iframe);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      win?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      observer.disconnect();
    };
  }, [iframe, target, columnsId, blocks, frameRef, device, registry]);

  if (!measured || hidden) return null;

  const select = () => registry.select(blockEditorStore) as unknown as Selectors;
  const titleOf = (clientId: string) => {
    const name = select().getBlockName(clientId) ?? '';
    return getBlockType(name)?.title ?? name;
  };

  /** A handle taken up (hovered, focused, grabbed): its next change starts a new named step. */
  const activate = (key: string | null) => {
    if (key && key !== active) gesture.current = null;
    setActive(key);
  };

  /** Names the step once per drag or run of key presses, then writes. */
  const write = (id: string, label: string, apply: () => void) => {
    if (gesture.current?.id !== id || !gesture.current.labelled) {
      events?.labelNext(label);
      gesture.current = { id, labelled: true };
    }
    apply();
  };

  /* ---------------------------------------------------- spacing handles */

  const spacingHandles = [];
  if (target && measured.box.width > 0) {
    const name = select().getBlockName(target) ?? '';
    const support = getBlockSupport(name, 'spacing');
    const blockTitle = titleOf(target);
    for (const kind of ['padding', 'margin'] as const) {
      for (const side of spacingSides(support, kind)) {
        spacingHandles.push(
          <SpacingHandle
            key={`${kind}-${side}`}
            id={`${kind}-${side}`}
            kind={kind}
            side={side}
            measured={measured}
            active={active === `${kind}-${side}`}
            onActive={(on) => activate(on ? `${kind}-${side}` : null)}
            label={spacingLabel(kind, side)}
            current={() => {
              const style = select().getBlockAttributes(target)?.style as Style | undefined;
              const stored = spacingPx(storedSpacing(style, device, kind, side), presets);
              return stored ?? measured[kind][side];
            }}
            snap={(px) => snapSpacing(px, mode, presets)}
            step={(px, by, big) => stepSpacing(px, by, mode, presets, big)}
            max={
              mode === 'simple' && presets.length
                ? Math.max(...presets.map((p) => p.px))
                : MAX_SPACING
            }
            valueText={(value) => valueText(value)}
            onChange={(value) =>
              write(
                `${target}-${kind}-${side}`,
                sprintf(
                  kind === 'padding'
                    ? __('Changed padding of “%s”', 'pressbase-admin')
                    : __('Changed margin of “%s”', 'pressbase-admin'),
                  blockTitle,
                ),
                () => {
                  const style = select().getBlockAttributes(target)?.style as Style | undefined;
                  actions.updateBlockAttributes(target, {
                    style: withSpacing(style, device, kind, side, value.value),
                  });
                },
              )
            }
          />,
        );
      }
    }
  }

  /* ------------------------------------------------------- column gaps */

  const columnHandles = [];
  if (columnsId && measured.columns.length > 1) {
    const { columns } = measured;
    const widths = shares(columns.map((c) => c.rect.width));
    const total = columns.reduce((sum, c) => sum + c.rect.width, 0);
    const apply = (next: number[]) =>
      write(`${columnsId}-widths`, __('Resized columns', 'pressbase-admin'), () => {
        const attributes: Record<string, { width: string }> = {};
        columns.forEach((column, i) => {
          attributes[column.clientId] = { width: columnWidth(next[i] ?? 0) };
        });
        actions.updateBlockAttributes(Object.keys(attributes), attributes, {
          uniqueByBlock: true,
        });
      });
    for (let i = 0; i < columns.length - 1; i++) {
      const left = columns[i] as (typeof columns)[number];
      const right = columns[i + 1] as (typeof columns)[number];
      columnHandles.push(
        <ColumnHandle
          key={left.clientId}
          index={i}
          left={left.rect}
          right={right.rect}
          view={measured.view}
          shares={widths}
          total={total}
          mode={mode}
          active={active === `column-${i}`}
          onActive={(on) => activate(on ? `column-${i}` : null)}
          label={sprintf(__('Width of columns %1$d and %2$d', 'pressbase-admin'), i + 1, i + 2)}
          onChange={apply}
        />,
      );
    }
  }

  return (
    <div className={styles.handleLayer} data-studio-handles>
      <div
        className={styles.handleClip}
        style={{
          top: measured.view.top,
          left: measured.view.left,
          width: measured.view.width,
          height: measured.view.height,
        }}
      >
        <div
          className={styles.handleOrigin}
          style={{ top: -measured.view.top, left: -measured.view.left }}
        >
          {spacingHandles}
          {columnHandles}
        </div>
      </div>
    </div>
  );

  function spacingLabel(kind: SpacingKind, side: Side): string {
    const labels: Record<SpacingKind, Record<Side, string>> = {
      padding: {
        top: __('Padding (top)', 'pressbase-admin'),
        right: __('Padding (right)', 'pressbase-admin'),
        bottom: __('Padding (bottom)', 'pressbase-admin'),
        left: __('Padding (left)', 'pressbase-admin'),
      },
      margin: {
        top: __('Margin (top)', 'pressbase-admin'),
        right: __('Margin (right)', 'pressbase-admin'),
        bottom: __('Margin (bottom)', 'pressbase-admin'),
        left: __('Margin (left)', 'pressbase-admin'),
      },
    };
    return labels[kind][side];
  }

  function valueText(value: SpacingValue): string {
    if (value.px === 0) return __('None', 'pressbase-admin');
    const px = sprintf(__('%spx', 'pressbase-admin'), String(Math.round(value.px)));
    return value.preset ? `${value.preset.name} · ${px}` : px;
  }
}

/* ------------------------------------------------------------ a spacing */

/** Where a side's handle sits, and which way dragging grows the value. */
function handleGeometry(kind: SpacingKind, side: Side, m: Measured) {
  const { box } = m;
  const inner = m.padding[side];
  const outer = m.margin[side];
  const vertical = side === 'top' || side === 'bottom';
  // Padding handles sit on the inner edge (at least 6px inside); margin handles on the outer edge (6px outside).
  const reach = kind === 'padding' ? Math.max(6, inner) : -Math.max(6, outer);
  // Side by side, so a padding and a margin handle on one edge never overlap.
  const shift = kind === 'padding' ? -18 : 18;
  let x = box.left + box.width / 2 + shift;
  let y = box.top + box.height / 2 + shift;
  if (side === 'top') y = box.top + reach;
  if (side === 'bottom') y = box.top + box.height - reach;
  if (side === 'left') x = box.left + reach;
  if (side === 'right') x = box.left + box.width - reach;
  // Dragging away from the block's centre grows a margin; towards it, padding.
  const sign = (side === 'top' || side === 'left' ? 1 : -1) * (kind === 'padding' ? 1 : -1);
  // The area the value covers, shaded while the handle is in use.
  const size = kind === 'padding' ? inner : outer;
  const area: Rect = vertical
    ? {
        left: box.left,
        width: box.width,
        height: size,
        top:
          side === 'top'
            ? kind === 'padding'
              ? box.top
              : box.top - size
            : kind === 'padding'
              ? box.top + box.height - size
              : box.top + box.height,
      }
    : {
        top: box.top,
        height: box.height,
        width: size,
        left:
          side === 'left'
            ? kind === 'padding'
              ? box.left
              : box.left - size
            : kind === 'padding'
              ? box.left + box.width - size
              : box.left + box.width,
      };
  return { x, y, vertical, sign, area };
}

function SpacingHandle(props: {
  id: string;
  kind: SpacingKind;
  side: Side;
  measured: Measured;
  active: boolean;
  onActive: (on: boolean) => void;
  label: string;
  current: () => number;
  snap: (px: number) => SpacingValue;
  step: (px: number, by: 1 | -1 | 'min' | 'max', big: boolean) => SpacingValue;
  max: number;
  valueText: (value: SpacingValue) => string;
  onChange: (value: SpacingValue) => void;
}) {
  const { kind, side, measured } = props;
  const geometry = handleGeometry(kind, side, measured);
  const drag = useRef<{ start: number; from: number; last: string } | null>(null);
  const [shown, setShown] = useState<SpacingValue | null>(null);
  const now = props.snap(props.current());
  const value = shown ?? now;

  const set = (next: SpacingValue) => {
    setShown(next);
    if (drag.current?.last === next.value) return;
    if (drag.current) drag.current.last = next.value;
    props.onChange(next);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    drag.current = {
      start: geometry.vertical ? event.clientY : event.clientX,
      from: props.current(),
      last: now.value,
    };
    props.onActive(true);
    setShown(now);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const moved = (geometry.vertical ? event.clientY : event.clientX) - d.start;
    set(props.snap(d.from + moved * geometry.sign));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const by = (
      {
        ArrowUp: 1,
        ArrowRight: 1,
        PageUp: 1,
        ArrowDown: -1,
        ArrowLeft: -1,
        PageDown: -1,
        Home: 'min',
        End: 'max',
      } as const
    )[event.key];
    if (by === undefined) return;
    event.preventDefault();
    const base = shown?.px ?? props.current();
    const next = props.step(base, by, event.shiftKey || event.key.startsWith('Page'));
    if (next.value === (shown ?? now).value) return;
    setShown(next);
    props.onChange(next);
  };

  return (
    <>
      {props.active && geometry.area.width > 0 && geometry.area.height > 0 && (
        <div
          className={styles.spacingArea}
          data-kind={kind}
          style={geometry.area}
          aria-hidden="true"
        />
      )}
      <div
        role="slider"
        tabIndex={0}
        aria-label={props.label}
        aria-orientation={geometry.vertical ? 'vertical' : 'horizontal'}
        aria-valuemin={0}
        aria-valuemax={Math.round(props.max)}
        aria-valuenow={Math.round(value.px)}
        aria-valuetext={props.valueText(value)}
        className={styles.spacingHandle}
        data-kind={kind}
        data-side={side}
        data-active={props.active || undefined}
        style={{ left: geometry.x, top: geometry.y }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onFocus={() => props.onActive(true)}
        onBlur={() => {
          props.onActive(false);
          setShown(null);
        }}
        onPointerEnter={() => !drag.current && props.onActive(true)}
        onPointerLeave={(event) => {
          if (!drag.current && document.activeElement !== event.currentTarget) {
            props.onActive(false);
          }
        }}
      />
      {props.active && (
        <span
          className={styles.handleLabel}
          style={{ left: geometry.x, top: geometry.y }}
          data-side={side}
          aria-hidden="true"
        >
          {`${props.label}: ${props.valueText(value)}`}
        </span>
      )}
    </>
  );
}

/* ------------------------------------------------------------ a column gap */

function ColumnHandle(props: {
  index: number;
  left: Rect;
  right: Rect;
  view: Rect;
  shares: number[];
  total: number;
  mode: StudioMode;
  active: boolean;
  onActive: (on: boolean) => void;
  label: string;
  onChange: (shares: number[]) => void;
}) {
  const { index, left, right } = props;
  const drag = useRef<{ start: number; from: number[]; last: string } | null>(null);
  const [shown, setShown] = useState<number[] | null>(null);
  const current = shown ?? props.shares;
  const x = (left.left + left.width + right.left) / 2;
  const top = Math.min(left.top, right.top);
  const height = Math.max(left.top + left.height, right.top + right.height) - top;
  const key = (values: number[]) => values.map((v) => v.toFixed(4)).join(',');
  const text = `${fractionLabel(current[index] ?? 0)} · ${fractionLabel(current[index + 1] ?? 0)}`;

  const set = (next: number[]) => {
    setShown(next);
    const k = key(next);
    if (drag.current?.last === k) return;
    if (drag.current) drag.current.last = k;
    props.onChange(next);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    drag.current = { start: event.clientX, from: props.shares, last: key(props.shares) };
    props.onActive(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !props.total) return;
    const share = (d.from[index] ?? 0) + (event.clientX - d.start) / props.total;
    set(resizeColumns(d.from, index, share, props.mode));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let next: number[] | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      next = stepColumns(
        current,
        index,
        event.key === 'ArrowRight' ? 1 : -1,
        props.mode,
        event.shiftKey,
      );
    } else if (event.key === 'Home' || event.key === 'End') {
      const pair = (current[index] ?? 0) + (current[index + 1] ?? 0);
      next = resizeColumns(current, index, event.key === 'Home' ? 0 : pair, 'exact');
    }
    if (!next) return;
    event.preventDefault();
    if (key(next) === key(current)) return;
    setShown(next);
    props.onChange(next);
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: a focusable splitter (WAI-ARIA window splitter), which <hr> can't be. */}
      <div
        role="separator"
        tabIndex={0}
        aria-label={props.label}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round((current[index] ?? 0) * 100)}
        aria-valuetext={text}
        className={styles.columnHandle}
        data-active={props.active || undefined}
        style={{ left: x, top, height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onFocus={() => props.onActive(true)}
        onBlur={() => {
          props.onActive(false);
          setShown(null);
        }}
        onPointerEnter={() => !drag.current && props.onActive(true)}
        onPointerLeave={(event) => {
          if (!drag.current && document.activeElement !== event.currentTarget) {
            props.onActive(false);
          }
        }}
      />
      {props.active && (
        <span
          className={styles.handleLabel}
          style={{ left: x, top: top + Math.min(height / 2, 40) }}
          data-side="column"
          aria-hidden="true"
        >
          {text}
        </span>
      )}
    </>
  );
}
