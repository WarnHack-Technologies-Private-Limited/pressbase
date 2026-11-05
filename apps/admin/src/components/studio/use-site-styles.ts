'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import {
  configsEqual,
  type GlobalStylesConfig,
  type RestGlobalStyles,
  type StyleVariation,
} from '@/lib/global-styles';
import { isForeignEntry, pickConfig, stylesEntry, stylesKey } from './styles-model';
import type { Draft } from './use-draft';

/**
 * The site's styles in Studio (#46): the user's global styles as the draft
 * leaves them, the theme's own (`base`) and its style variations, and the
 * block editor settings that draw them on the canvas.
 *
 * An edit shows in the panel at once; a moment later core turns it into the
 * editor's stylesheet (POST /pressbase/v1/global-styles/editor-settings,
 * which also checks Additional CSS with validate_custom_css()), the canvas
 * and the style book redraw with it, and the draft gets the entry
 * `wp_global_styles:{stylesheet}`. Entries written elsewhere (History
 * restoring a version, AI edits, a draft prompt-to-site made) are taken up
 * the same way, so the canvas always shows the draft's styles.
 */

/** How long the panel waits after an edit before redrawing the canvas. */
export const STYLES_DELAY = 150;

/** What core returns: the editor's `styles` and the feature settings derived from them. */
export interface StylesEditorSettings {
  styles: { css: string; __unstableType: string; isGlobalStyles: boolean }[];
  fontFaces?: string;
  config?: GlobalStylesConfig;
  [setting: string]: unknown;
}

export interface SiteStyles {
  /** Loaded and editable (the person can change the design, and the theme has styles). */
  ready: boolean;
  /** Couldn't load: the reason. */
  failed: string | null;
  stylesheet: string;
  themeName: string;
  base: GlobalStylesConfig;
  variations: StyleVariation[];
  /** What visitors see now. */
  live: GlobalStylesConfig;
  /** The styles as the draft leaves them, with the panel's latest edit. */
  config: GlobalStylesConfig;
  change(next: GlobalStylesConfig): void;
  /** Additional CSS that core refused, and why; nothing reaches the draft until it's fixed. */
  cssError: string | null;
  /** The canvas's editor settings for the draft's styles; null while they're what was loaded. */
  editorSettings: StylesEditorSettings | null;
  /** Studio's library with the draft's styles laid over its theme settings (for the canvas). */
  withStyles<T extends { theme: object }>(library: T): T;
}

type ThemeWithLinks = {
  stylesheet: string;
  name?: { raw?: string; rendered?: string } | string;
  _links?: Record<string, { href: string }[]>;
};

const EMPTY: GlobalStylesConfig = { settings: {}, styles: {} };

export function useSiteStyles({
  draft,
  enabled,
}: {
  draft: Pick<Draft, 'entries' | 'want'>;
  /** The person may change the site's design (`edit_theme_options`). */
  enabled: boolean;
}): SiteStyles {
  const [loaded, setLoaded] = useState<{
    id: number;
    stylesheet: string;
    themeName: string;
    base: GlobalStylesConfig;
    variations: StyleVariation[];
  } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [live, setLive] = useState<GlobalStylesConfig>(EMPTY);
  const [config, setConfig] = useState<GlobalStylesConfig>(EMPTY);
  const [cssError, setCssError] = useState<string | null>(null);
  const [editorSettings, setEditorSettings] = useState<StylesEditorSettings | null>(null);
  const lastSent = useRef<GlobalStylesConfig | null>(null);
  const sequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  const configRef = useRef(config);
  configRef.current = config;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const key = loaded ? stylesKey(loaded.stylesheet) : null;
  const entry = key ? draft.entries[key]?.value : undefined;
  const entryJson = entry === undefined ? '' : JSON.stringify(entry);

  // The active theme, its styles and variations, and the user's styles: once.
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    (async () => {
      const [theme] = await api<ThemeWithLinks[]>('/wp/v2/themes?status=active');
      const href = theme?._links?.['wp:user-global-styles']?.[0]?.href;
      const id = href ? Number(href.split('/').pop()) : 0;
      if (!theme || !id) throw new Error('This theme has no styles to edit.');
      const stylesheet = encodeURIComponent(theme.stylesheet);
      const [user, base, variations] = await Promise.all([
        api<RestGlobalStyles>(`/wp/v2/global-styles/${id}?context=edit`),
        api<GlobalStylesConfig>(`/wp/v2/global-styles/themes/${stylesheet}`),
        api<StyleVariation[]>(`/wp/v2/global-styles/themes/${stylesheet}/variations`).catch(
          () => [] as StyleVariation[],
        ),
      ]);
      if (!current) return;
      const name =
        typeof theme.name === 'string' ? theme.name : (theme.name?.raw ?? theme.name?.rendered);
      const userConfig = pickConfig(user);
      setLive(userConfig);
      setConfig((now) => (now === EMPTY ? userConfig : now));
      setLoaded({
        id,
        stylesheet: theme.stylesheet,
        themeName: name || theme.stylesheet,
        base: pickConfig(base),
        variations,
      });
    })().catch(
      (error) => current && setFailed(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      current = false;
    };
  }, [enabled]);

  /** Asks core for the editor settings of these styles; writes the draft when they're valid. */
  const render = useCallback(
    async (next: GlobalStylesConfig, { save }: { save: boolean }) => {
      const id = ++sequence.current;
      try {
        const settings = await api<StylesEditorSettings>(
          '/pressbase/v1/global-styles/editor-settings',
          { method: 'POST', body: pickConfig(next) },
        );
        if (id !== sequence.current) return;
        setEditorSettings(settings);
        setCssError(null);
        if (save && key) {
          const value = stylesEntry(next, liveRef.current);
          lastSent.current = value;
          draftRef.current.want(new Map([[key, value]]));
        }
      } catch (error) {
        if (id !== sequence.current) return;
        if (error instanceof ApiError && /^rest_custom_css_/.test(error.code ?? '')) {
          setCssError(error.message);
        } else if (save && key) {
          // The canvas couldn't redraw; the draft still keeps the edit.
          const value = stylesEntry(next, liveRef.current);
          lastSent.current = value;
          draftRef.current.want(new Map([[key, value]]));
        }
      }
    },
    [key],
  );

  const change = useCallback(
    (next: GlobalStylesConfig) => {
      setConfig(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void render(next, { save: true });
      }, STYLES_DELAY);
    },
    [render],
  );

  // The draft's entry changed elsewhere (History, AI, a resumed draft, Publish, Discard).
  useEffect(() => {
    if (!loaded || timer.current) return;
    if (entry === undefined) {
      // No entry: what visitors see. After Publish that's the draft's styles, so read it again.
      if (!lastSent.current && configsEqual(configRef.current, liveRef.current)) return;
      lastSent.current = null;
      let current = true;
      api<RestGlobalStyles>(`/wp/v2/global-styles/${loaded.id}?context=edit`)
        .then((user) => {
          if (!current) return;
          const userConfig = pickConfig(user);
          setLive(userConfig);
          setConfig(userConfig);
          void render(userConfig, { save: false });
        })
        .catch(() => {});
      return () => {
        current = false;
      };
    }
    if (!isForeignEntry(entry, configRef.current, lastSent.current)) return;
    const next = pickConfig(entry);
    lastSent.current = next;
    setConfig(next);
    void render(next, { save: false });
  }, [loaded, entryJson, render]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // Lays the draft's styles over the theme settings the canvas opened with.
  const cache = useRef<{ library: unknown; settings: unknown; result: unknown } | null>(null);
  const withStyles = useCallback(
    <T extends { theme: object }>(library: T): T => {
      if (!editorSettings) return library;
      if (cache.current?.library === library && cache.current.settings === editorSettings) {
        return cache.current.result as T;
      }
      const { styles, fontFaces, config: _config, ...features } = editorSettings;
      const result = {
        ...library,
        theme: {
          ...library.theme,
          ...features,
          // The variation's web fonts too (the canvas loaded the theme's when it opened).
          styles: fontFaces
            ? [...styles, { css: fontFaces, __unstableType: 'theme', isGlobalStyles: false }]
            : styles,
        },
      };
      cache.current = { library, settings: editorSettings, result };
      return result;
    },
    [editorSettings],
  );

  return {
    ready: Boolean(loaded),
    failed,
    stylesheet: loaded?.stylesheet ?? '',
    themeName: loaded?.themeName ?? '',
    base: loaded?.base ?? EMPTY,
    variations: loaded?.variations ?? [],
    live,
    config,
    change,
    cssError,
    editorSettings,
    withStyles,
  };
}
