'use client';

/**
 * Edits blocks make outside Studio's block tree (#30). The site title,
 * tagline and logo blocks edit the `root/site` record in core-data (as
 * `/wp/v2/settings` fields), and the Navigation block edits its menu
 * (`wp_navigation`) there. Studio turns those edits into changeset entries
 * (`option:blogname`, `wp_navigation:5`…) instead of saving them to REST,
 * lays a resumed draft's entries back over core-data, and clears the edits
 * after Publish or Discard. See docs/architecture/studio.md#saving-the-draft-publish-preview-discard.
 */

import { __unstableSerializeAndClean, type Block, parse } from '@wordpress/blocks';
import { useRegistry } from '@wordpress/data';
import { useCallback, useEffect, useRef } from 'react';
import {
  type EntryValue,
  FIELD_OF_OPTION,
  parseKey,
  type StoredEntry,
  siteEdits,
  siteEntries,
} from './changes-model';

/* ------------------------------------------------------------------- hook */

interface CoreSelectors {
  getEntityRecordNonTransientEdits: (
    kind: string,
    name: string,
    key?: unknown,
  ) => Record<string, unknown>;
  __experimentalGetDirtyEntityRecords: () => { kind: string; name: string; key: unknown }[];
  getEditedEntityRecord: (kind: string, name: string, key?: unknown) => Record<string, unknown>;
  getRawEntityRecord: (
    kind: string,
    name: string,
    key?: unknown,
  ) => Record<string, unknown> | undefined;
}

interface CoreActions {
  editEntityRecord: (
    kind: string,
    name: string,
    key: unknown,
    edits: Record<string, unknown>,
    options?: { undoIgnore?: boolean },
  ) => void;
  invalidateResolutionForStoreSelector: (selector: string) => void;
}

const raw = (value: unknown) =>
  value && typeof value === 'object' && 'raw' in value ? (value as { raw: unknown }).raw : value;

/** A menu's markup from its edited record (blocks first, as core-data saves it). */
function menuContent(record: Record<string, unknown>): string {
  if (Array.isArray(record.blocks)) return __unstableSerializeAndClean(record.blocks as Block[]);
  const content = record.content;
  if (typeof content === 'function') return content(record) as string;
  return String(raw(content) ?? '');
}

export interface EntityEdits {
  /** The entries core-data's edits need now (null: no longer edited). */
  wants(): Map<string, EntryValue | null>;
  /** Puts every edited record back to what's saved (Discard). */
  clear(): void;
  /** Puts back one entry's record (`option:blogname`, `wp_navigation:5`); false if it isn't one. */
  revert(key: string): boolean;
  /** Reloads the records after a publish, which also clears the edits now saved. */
  refresh(): Promise<void>;
}

/**
 * Inside Studio's editor: reports core-data edits through `onChange` (call
 * `wants()` for the entries), and lays `draft`'s entries over the records
 * once they load.
 */
export function useEntityEdits({
  draft,
  onChange,
}: {
  draft: Readonly<Record<string, StoredEntry>>;
  onChange: () => void;
}): EntityEdits {
  const registry = useRegistry();
  const touched = useRef(new Set<string>());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const core = useCallback(() => {
    try {
      return {
        select: registry.select('core') as unknown as CoreSelectors | undefined,
        dispatch: registry.dispatch('core') as unknown as CoreActions | undefined,
      };
    } catch {
      return { select: undefined, dispatch: undefined }; // core-data isn't loaded: nothing edited.
    }
  }, [registry]);

  // A resumed draft: its site and menu entries become edits again.
  useEffect(() => {
    const { dispatch } = core();
    if (!dispatch) return;
    const resolve = registry.resolveSelect('core') as unknown as {
      getEntityRecord: (kind: string, name: string, key?: unknown) => Promise<unknown>;
    };
    const edits = siteEdits(draft);
    if (Object.keys(edits).length) {
      resolve
        .getEntityRecord('root', 'site')
        .then(() =>
          dispatch.editEntityRecord('root', 'site', undefined, edits, { undoIgnore: true }),
        )
        .catch(() => {});
    }
    for (const [key, entry] of Object.entries(draft)) {
      const { type, id } = parseKey(key);
      const content = (entry.value as { content?: unknown } | null)?.content;
      if (type !== 'wp_navigation' || typeof content !== 'string') continue;
      const menuId = Number(id);
      resolve
        .getEntityRecord('postType', 'wp_navigation', menuId)
        .then(() =>
          dispatch.editEntityRecord(
            'postType',
            'wp_navigation',
            menuId,
            { content, blocks: parse(content) },
            { undoIgnore: true },
          ),
        )
        .catch(() => {});
    }
  }, []);

  // Edits arrive as core-data changes; the caller works out entries after its pause.
  useEffect(() => {
    let last = '';
    return registry.subscribe(() => {
      const { select } = core();
      if (!select) return;
      const dirty = JSON.stringify(select.__experimentalGetDirtyEntityRecords?.() ?? []);
      const site = JSON.stringify(select.getEntityRecordNonTransientEdits?.('root', 'site') ?? {});
      const key = dirty + site;
      if (key === last) return;
      last = key;
      onChangeRef.current();
    }, 'core' as never);
  }, [registry, core]);

  const wants = useCallback(() => {
    const out = new Map<string, EntryValue | null>();
    const { select } = core();
    if (!select) return out;
    const before = [...touched.current];
    for (const [key, value] of siteEntries(
      select.getEntityRecordNonTransientEdits('root', 'site') ?? {},
      before.filter((k) => k.startsWith('option:')),
    )) {
      out.set(key, value);
    }
    for (const key of before) if (key.startsWith('wp_navigation:')) out.set(key, null);
    for (const record of select.__experimentalGetDirtyEntityRecords() ?? []) {
      if (record.kind !== 'postType' || record.name !== 'wp_navigation') continue;
      const edited = select.getEditedEntityRecord('postType', 'wp_navigation', record.key);
      const content = menuContent(edited);
      // The Navigation block can mark a menu edited just by loading it; unchanged isn't an edit.
      const saved = select.getRawEntityRecord('postType', 'wp_navigation', record.key);
      if (saved && raw(saved.content) === content) continue;
      out.set(`wp_navigation:${record.key}`, { content });
    }
    for (const [key, value] of out) {
      if (value === null) touched.current.delete(key);
      else touched.current.add(key);
    }
    // Keys never edited and still not edited: nothing to say.
    for (const [key, value] of [...out]) {
      if (value === null && !before.includes(key)) out.delete(key);
    }
    return out;
  }, [core]);

  const clear = useCallback(() => {
    const { select, dispatch } = core();
    if (!select || !dispatch) return;
    const site = select.getEntityRecordNonTransientEdits('root', 'site') ?? {};
    const persisted = select.getRawEntityRecord('root', 'site') ?? {};
    const back = Object.fromEntries(Object.keys(site).map((field) => [field, persisted[field]]));
    if (Object.keys(back).length) {
      dispatch.editEntityRecord('root', 'site', undefined, back, { undoIgnore: true });
    }
    for (const record of select.__experimentalGetDirtyEntityRecords() ?? []) {
      if (record.kind !== 'postType' || record.name !== 'wp_navigation') continue;
      const saved = select.getRawEntityRecord('postType', 'wp_navigation', record.key) ?? {};
      dispatch.editEntityRecord(
        'postType',
        'wp_navigation',
        record.key,
        // `blocks: undefined` drops the block edits, so the menu reads its saved content again.
        { content: raw(saved.content), blocks: undefined },
        { undoIgnore: true },
      );
    }
    touched.current.clear();
  }, [core]);

  const revert = useCallback(
    (key: string) => {
      const { select, dispatch } = core();
      if (!select || !dispatch) return false;
      const { type, id } = parseKey(key);
      if (type === 'option' && FIELD_OF_OPTION[id]) {
        const field = FIELD_OF_OPTION[id] as string;
        const persisted = select.getRawEntityRecord('root', 'site') ?? {};
        dispatch.editEntityRecord(
          'root',
          'site',
          undefined,
          { [field]: persisted[field] },
          {
            undoIgnore: true,
          },
        );
        return true;
      }
      if (type === 'wp_navigation') {
        const saved = select.getRawEntityRecord('postType', 'wp_navigation', Number(id));
        if (!saved) return false;
        dispatch.editEntityRecord(
          'postType',
          'wp_navigation',
          Number(id),
          { content: raw(saved.content), blocks: undefined },
          { undoIgnore: true },
        );
        return true;
      }
      return false;
    },
    [core],
  );

  const refresh = useCallback(async () => {
    const { select, dispatch } = core();
    if (!select || !dispatch) return;
    const edited = select.__experimentalGetDirtyEntityRecords() ?? [];
    dispatch.invalidateResolutionForStoreSelector('getEntityRecord');
    const resolve = registry.resolveSelect('core') as unknown as {
      getEntityRecord: (kind: string, name: string, key?: unknown) => Promise<unknown>;
    };
    await Promise.all(
      edited.map((r) =>
        resolve.getEntityRecord(r.kind, r.name, r.key ?? undefined).catch(() => {}),
      ),
    );
    touched.current.clear();
  }, [core, registry]);

  return { wants, clear, revert, refresh };
}
