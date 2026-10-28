'use client';

/**
 * Runtime UI extensions: the host side of plugins' browser modules.
 *
 * - `window.pressbase` is the stable host API modules use instead of bundling
 *   their own React (see HOST_API below and docs/architecture/plugins.md#ui-modules).
 * - <ExtensionsProvider> holds the plugin pages and modules from
 *   /pressbase/v1/admin-extensions, imports the modules, and renders every
 *   registered plugin (<PluginArea>, as in @wordpress/plugins).
 * - <Fill> / <Slot> place plugin UI in named slots, as @wordpress/components'
 *   SlotFill does; every fill renders inside an error boundary that names
 *   the plugin, so one broken extension can't take a screen down.
 */

import { AlertTriangle, Puzzle } from 'lucide-react';
import * as React from 'react';
import {
  Component,
  createContext,
  type ErrorInfo,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import * as ReactDOM from 'react-dom';
import { ApiError, api } from '@/lib/api';
import { EditorStore } from '@/lib/extensions/editor';
import type { ListFilterOption, QueryValue } from '@/lib/extensions/lists';
import { type AdminExtensions, activeOwners, NO_EXTENSIONS } from '@/lib/extensions/pages';
import { ExtensionStore, type FillEntry, pageSlot, SLOTS } from '@/lib/extensions/registry';
import { useCurrentUser } from '../shell/current-user';
import { Button, Spinner } from '../ui/button';
import { Checkbox, SelectField, TextAreaField, TextField } from '../ui/field';
import { Badge, Card, EmptyState, Notice } from '../ui/surface';
import { useToast } from '../ui/toast';
import styles from './extensions.module.css';

/** One registry for the page's lifetime: modules can't be unloaded, so neither can it. */
export const extensionStore = new ExtensionStore();

/** The post being edited, published by the post editor (see lib/extensions/editor.ts). */
export const editorStore = new EditorStore();

type EditorPost = NonNullable<ReturnType<EditorStore['getPost']>>;

/**
 * The post being edited, live: `usePost()` for the whole snapshot or
 * `usePost((post) => post.title)` for one part (re-renders only when it
 * changes). null (undefined with a selector) outside the editor.
 */
export function usePost(): EditorPost | null;
export function usePost<T>(selector: (post: EditorPost) => T): T | undefined;
export function usePost<T>(selector?: (post: EditorPost) => T): unknown {
  const last = useRef<{ post: unknown; selector: unknown; value: unknown } | null>(null);
  const read = () => {
    const post = editorStore.getPost();
    if (!selector) return post;
    if (!post) return undefined;
    const cached = last.current;
    if (cached && cached.post === post && cached.selector === selector) return cached.value;
    const value = selector(post);
    // Keep the previous value when it's the same, so an inline selector can't loop.
    const keep = cached && Object.is(cached.value, value) ? cached.value : value;
    last.current = { post, selector, value: keep };
    return keep;
  };
  return useSyncExternalStore(editorStore.subscribe, read, () => (selector ? undefined : null));
}

/* ------------------------------------------------------------ plugin context */

interface PluginContextValue {
  /** The registerPlugin() name. */
  name: string;
  /** The Pressbase plugin that owns it. */
  owner: string | null;
}

const PluginContext = createContext<PluginContextValue | null>(null);

/** Inside a plugin's render: which plugin it is (usePluginContext in @wordpress/plugins). */
export function usePluginContext(): PluginContextValue | null {
  return useContext(PluginContext);
}

/** Marks a subtree as the plugin's, so its Fills are attributed to it. */
export function PluginScope({ owner, children }: { owner: string; children: ReactNode }) {
  return <PluginContext.Provider value={{ name: owner, owner }}>{children}</PluginContext.Provider>;
}

/* ------------------------------------------------------------ error boundary */

interface BoundaryProps {
  owner: string | null;
  /** Where it broke, for the message: "dashboard widget". */
  place?: string;
  /** Report to the store instead of showing a message (PluginArea renders nothing visible). */
  silent?: boolean;
  children: ReactNode;
}

/** Contains an extension that throws while rendering, naming the plugin. */
export class ExtensionBoundary extends Component<BoundaryProps, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `[plugin:${this.props.owner ?? 'unknown'}] ${this.props.place ?? 'extension'} failed:`,
      error,
      info.componentStack,
    );
    if (this.props.silent) {
      extensionStore.setError(this.props.owner, `It stopped with an error: ${error.message}`);
    }
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.silent) return null;
    return <ExtensionError owner={this.props.owner} message={error.message} />;
  }
}

function ExtensionError({ owner, message }: { owner: string | null; message: string }) {
  const title = extensionStore.title(owner);
  return (
    <div className={styles.error} role="alert">
      <AlertTriangle size={16} aria-hidden="true" />
      <div>
        <p className={styles.errorTitle}>
          The {title} plugin ran into a problem, so this part can’t be shown.
        </p>
        <details className={styles.errorDetails}>
          <summary>Details</summary>
          <code>{message}</code>
        </details>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- slotfill */

export interface FillProps {
  name: string;
  /** Lower comes first (default 10). */
  order?: number;
  /** Elements, or a function of the slot's fill props. */
  children?: ReactNode | ((fillProps: Record<string, unknown>) => ReactNode);
  [prop: string]: unknown;
}

/** Renders its children into the Slot of the same name, wherever that is. */
export function Fill({ name, children, ...props }: FillProps) {
  const plugin = useContext(PluginContext);
  const id = useRef<number | null>(null);
  const owner = plugin?.owner ?? null;
  // Every render passes the latest children to the slot.
  useLayoutEffect(() => {
    if (id.current === null) id.current = extensionStore.addFill(name, owner, props, children);
    else extensionStore.updateFill(id.current, props, children);
  });
  useLayoutEffect(
    () => () => {
      if (id.current !== null) extensionStore.removeFill(id.current);
      id.current = null;
    },
    [],
  );
  return null;
}

export function useFills(name: string): FillEntry[] {
  return useSyncExternalStore(
    extensionStore.subscribe,
    () => extensionStore.fills(name),
    () => NO_FILLS,
  );
}

const NO_FILLS: FillEntry[] = [];

function fillContent(fill: FillEntry, fillProps: Record<string, unknown>): ReactNode {
  return typeof fill.children === 'function'
    ? (fill.children as (p: Record<string, unknown>) => ReactNode)(fillProps)
    : (fill.children as ReactNode);
}

/**
 * Where fills appear. `wrap` puts each fill in the slot's chrome (a card, a
 * sidebar panel); the fill itself always renders inside an error boundary.
 */
export function Slot({
  name,
  fillProps = EMPTY,
  wrap,
  place,
}: {
  name: string;
  fillProps?: Record<string, unknown>;
  wrap?: (fill: FillEntry, content: ReactNode) => ReactNode;
  place?: string;
}) {
  const fills = useFills(name);
  return (
    <>
      {fills.map((fill) => {
        const content = (
          <ExtensionBoundary owner={fill.owner} place={place ?? name}>
            <FillContent fill={fill} fillProps={fillProps} />
          </ExtensionBoundary>
        );
        return (
          <React.Fragment key={fill.id}>{wrap ? wrap(fill, content) : content}</React.Fragment>
        );
      })}
    </>
  );
}

const EMPTY: Record<string, unknown> = {};

/** Calls a function child inside the boundary, so a throw there is contained too. */
function FillContent({ fill, fillProps }: { fill: FillEntry; fillProps: Record<string, unknown> }) {
  return <>{fillContent(fill, fillProps)}</>;
}

/** One fill with its own props (a list cell, a sidebar tab), inside an error boundary. */
export function RenderFill({
  fill,
  fillProps = EMPTY,
  place,
}: {
  fill: FillEntry;
  fillProps?: Record<string, unknown>;
  place: string;
}) {
  return (
    <ExtensionBoundary owner={fill.owner} place={place}>
      <FillContent fill={fill} fillProps={fillProps} />
    </ExtensionBoundary>
  );
}

/** A plugin's icon: an element, a component (lucide-style `size`), or a short string. */
export function PluginIcon({ icon, size = 16 }: { icon: unknown; size?: number }) {
  if (React.isValidElement(icon)) return icon;
  if (typeof icon === 'function') {
    return React.createElement(icon as React.ComponentType<Record<string, unknown>>, {
      size,
      'aria-hidden': true,
    });
  }
  if (typeof icon === 'string' && icon) return <span aria-hidden="true">{icon}</span>;
  return <Puzzle size={size} aria-hidden="true" />;
}

/** A dashboard widget: a card on the Dashboard (slot `dashboard`). */
export function DashboardWidget({
  title,
  size = 'small',
  order,
  children,
}: {
  title: string;
  size?: 'small' | 'large';
  order?: number;
  children?: ReactNode;
}) {
  return (
    <Fill name={SLOTS.dashboard} title={title} size={size} order={order}>
      {children}
    </Fill>
  );
}

/**
 * A panel in the post editor's Post tab (slot `editor.document-settings`),
 * like PluginDocumentSettingPanel in @wordpress/editor. A function child gets
 * { postId, postType }.
 */
export function PluginDocumentSettingPanel({
  title,
  order,
  children,
}: {
  title: string;
  order?: number;
  name?: string;
  children?: FillProps['children'];
}) {
  return (
    <Fill name={SLOTS.editorDocumentSettings} title={title} order={order}>
      {children}
    </Fill>
  );
}

/** The id of a plugin's sidebar: `{registerPlugin name}/{name}`, as Gutenberg's complementary areas. */
function useSidebarId(name: string): string {
  const plugin = useContext(PluginContext);
  return `${plugin?.name ?? 'plugin'}/${name}`;
}

/**
 * A whole tab in the post editor's sidebar, beside Post and Block (slot
 * `editor.sidebar`), like PluginSidebar in @wordpress/editor. `name` is unique
 * within the plugin. A function child gets { postId, postType }.
 */
export function PluginSidebar({
  name,
  title,
  icon,
  order,
  children,
}: {
  name: string;
  title: string;
  icon?: unknown;
  order?: number;
  children?: FillProps['children'];
}) {
  const sidebar = useSidebarId(name);
  return (
    <Fill name={SLOTS.editorSidebar} sidebar={sidebar} title={title} icon={icon} order={order}>
      {children}
    </Fill>
  );
}

/**
 * A button in the editor's top bar that opens a plugin's sidebar (slot
 * `editor.sidebar-more-menu`), like PluginSidebarMoreMenuItem. `target` is
 * the PluginSidebar's `name`; the children are its label.
 */
export function PluginSidebarMoreMenuItem({
  target,
  icon,
  order,
  children,
}: {
  target: string;
  icon?: unknown;
  order?: number;
  children?: ReactNode;
}) {
  const sidebar = useSidebarId(target);
  return (
    <Fill name={SLOTS.editorSidebarMoreMenu} target={sidebar} icon={icon} order={order}>
      {children}
    </Fill>
  );
}

/**
 * A panel in the "Ready to publish?" step that opens before a first publish
 * (slot `editor.pre-publish`), like PluginPrePublishPanel. It informs; it
 * can't block publishing. A function child gets { postId, postType }.
 */
export function PluginPrePublishPanel({
  title,
  initialOpen = true,
  order,
  children,
}: {
  title?: string;
  initialOpen?: boolean;
  icon?: unknown;
  order?: number;
  children?: FillProps['children'];
}) {
  return (
    <Fill name={SLOTS.editorPrePublish} title={title} initialOpen={initialOpen} order={order}>
      {children}
    </Fill>
  );
}

type ListPost = Record<string, unknown>;

/**
 * A column in the posts and pages lists (slot `posts-list.columns`), as
 * `manage_posts_columns` and `manage_posts_custom_column`. The child is a
 * function of { post, postType }: `post` is the row's REST post in the edit
 * context, `meta` included. `postTypes` limits it (default: every list).
 */
export function PostsListColumn({
  title,
  postTypes,
  order,
  children,
}: {
  title: string;
  postTypes?: string | string[];
  order?: number;
  children: (props: { post: ListPost; postType: string }) => ReactNode;
}) {
  return (
    <Fill name={SLOTS.postsListColumns} title={title} postTypes={postTypes} order={order}>
      {children as FillProps['children']}
    </Fill>
  );
}

/**
 * A row action in the posts and pages lists (slot `posts-list.row-actions`),
 * as `post_row_actions`: a link (`href(post)`) or a button
 * (`onClick(post, { reload })`). `isVisible(post)` hides it on some rows.
 */
export function PostsListRowAction(props: {
  label: string | ((post: ListPost) => string);
  href?: (post: ListPost) => string;
  onClick?: (post: ListPost, list: { reload: () => Promise<void> }) => unknown;
  isVisible?: (post: ListPost) => boolean;
  postTypes?: string | string[];
  order?: number;
}) {
  return <Fill name={SLOTS.postsListRowActions} {...props} />;
}

/**
 * A filter above the posts and pages lists (slot `posts-list.filters`), as
 * `restrict_manage_posts`: a select of `options`. The chosen value goes in the
 * URL as `?{id}=value`, and `query(value)` returns REST parameters to add;
 * the plugin reads them on the server with the `rest_{post_type}_query` filter.
 */
export function PostsListFilter(props: {
  id: string;
  label: string;
  options: ListFilterOption[];
  query: (value: string) => Record<string, QueryValue>;
  postTypes?: string | string[];
  order?: number;
}) {
  return <Fill name={SLOTS.postsListFilters} {...props} />;
}

/**
 * Fields in a category's or tag's edit form (slot `term.edit-fields`), as
 * `{taxonomy}_edit_form_fields`. A function child gets { taxonomy, term,
 * meta, editMeta }; edits save with the term. `taxonomies` limits it.
 */
export function TermEditFields({
  taxonomies,
  order,
  children,
}: {
  taxonomies?: string | string[];
  order?: number;
  children?: FillProps['children'];
}) {
  return (
    <Fill name={SLOTS.termEditFields} taxonomies={taxonomies} order={order}>
      {children}
    </Fill>
  );
}

/**
 * A card on the profile and user edit screens (slot `user.profile-fields`),
 * as `show_user_profile` and `edit_user_profile`. A function child gets
 * { user, isSelf, meta, editMeta }; edits save with the form.
 */
export function UserProfileFields({
  title,
  description,
  order,
  children,
}: {
  title: string;
  description?: string;
  order?: number;
  children?: FillProps['children'];
}) {
  return (
    <Fill name={SLOTS.userProfileFields} title={title} description={description} order={order}>
      {children}
    </Fill>
  );
}

/* --------------------------------------------------------------- plugin area */

/** Renders every registered plugin (their Fills), each in its own boundary. */
export function PluginArea() {
  const plugins = useSyncExternalStore(
    extensionStore.subscribe,
    () => extensionStore.plugins(),
    () => NO_PLUGINS,
  );
  return (
    <>
      {plugins.map((plugin) => {
        const Render = plugin.render as () => ReactNode;
        return (
          <PluginContext.Provider
            key={plugin.name}
            value={{ name: plugin.name, owner: plugin.owner }}
          >
            <ExtensionBoundary owner={plugin.owner} silent>
              <Render />
            </ExtensionBoundary>
          </PluginContext.Provider>
        );
      })}
    </>
  );
}

const NO_PLUGINS: ReturnType<ExtensionStore['plugins']> = [];

/* ------------------------------------------------------------- module loading */

/**
 * Imports a plugin's module from its same-origin URL (served by core under
 * /wp-content/plugins/, see next.config.ts). The bundler must leave this
 * import() alone: the URL only exists at runtime.
 */
export function importModule(url: string): Promise<Record<string, unknown>> {
  return import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url);
}

export function loadPluginModule(owner: string, url: string) {
  installHostApi();
  return extensionStore.load(owner, url, importModule);
}

/* ------------------------------------------------------------------ provider */

const ExtensionsContext = createContext<AdminExtensions>(NO_EXTENSIONS);

/** The plugin pages and modules the current user has. */
export function useAdminExtensions(): AdminExtensions {
  return useContext(ExtensionsContext);
}

export function ExtensionsProvider({
  extensions,
  children,
}: {
  extensions: AdminExtensions;
  children: ReactNode;
}) {
  // Owners first, so modules' registrations are attributed and shown.
  const owners = JSON.stringify(activeOwners(extensions));
  useEffect(() => {
    extensionStore.setPlugins(JSON.parse(owners));
  }, [owners]);

  const modules = JSON.stringify(extensions.modules);
  useEffect(() => {
    for (const module of JSON.parse(modules) as AdminExtensions['modules']) {
      if (extensionStore.isImported(module.url)) continue;
      loadPluginModule(module.plugin, module.url).catch((error) =>
        console.error(`[plugin:${module.plugin}] admin module failed to load:`, error),
      );
    }
  }, [modules]);

  return <ExtensionsContext.Provider value={extensions}>{children}</ExtensionsContext.Provider>;
}

/** Problems loading or running plugins' admin modules, above the screen's content. */
export function ExtensionErrors() {
  const errors = useSyncExternalStore(
    extensionStore.subscribe,
    () => extensionStore.errors(),
    () => NO_ERRORS,
  );
  if (!errors.length) return null;
  return (
    <div className={styles.errors}>
      {errors.map((error) => (
        <Notice
          key={error.owner ?? ''}
          tone="warning"
          title={`The ${error.title} plugin’s admin extensions aren’t working`}
        >
          <p>{error.message}</p>
        </Notice>
      ))}
    </div>
  );
}

const NO_ERRORS: ReturnType<ExtensionStore['errors']> = [];

/* ------------------------------------------------------------------ host API */

/**
 * window.pressbase: what a plugin's browser module may use. Versioned by
 * `apiVersion`; additions are backwards compatible, removals bump it.
 */
export const HOST_API = Object.freeze({
  apiVersion: 1,
  /** The admin's own React: modules must not bundle another copy. */
  React,
  ReactDOM,
  /** For JSX compiled with the automatic runtime (`jsx`, `jsxs`, `Fragment`). */
  jsxRuntime,
  /** @wordpress/element's shape: createElement and the hooks. */
  element: Object.freeze({
    createElement: React.createElement,
    Fragment: React.Fragment,
    cloneElement: React.cloneElement,
    createContext: React.createContext,
    createPortal: ReactDOM.createPortal,
    memo: React.memo,
    forwardRef: React.forwardRef,
    lazy: React.lazy,
    Suspense: React.Suspense,
    StrictMode: React.StrictMode,
    useState: React.useState,
    useEffect: React.useEffect,
    useLayoutEffect: React.useLayoutEffect,
    useMemo: React.useMemo,
    useCallback: React.useCallback,
    useRef: React.useRef,
    useReducer: React.useReducer,
    useContext: React.useContext,
    useId: React.useId,
    useTransition: React.useTransition,
    useDeferredValue: React.useDeferredValue,
    useSyncExternalStore: React.useSyncExternalStore,
  }),
  /** fetch for /wp-json, with the session cookie and the X-Pressbase-Request header. */
  api,
  ApiError,
  /** @wordpress/plugins */
  registerPlugin: (name: string, settings: { render: () => ReactNode; icon?: unknown }) =>
    extensionStore.registerPlugin(name, settings),
  unregisterPlugin: (name: string) => extensionStore.unregisterPlugin(name),
  getPlugins: () => extensionStore.plugins(),
  usePluginContext,
  /** SlotFill */
  Fill,
  Slot,
  slots: Object.freeze({ ...SLOTS, page: pageSlot }),
  DashboardWidget,
  PluginDocumentSettingPanel,
  PluginSidebar,
  PluginSidebarMoreMenuItem,
  PluginPrePublishPanel,
  PostsListColumn,
  PostsListRowAction,
  PostsListFilter,
  TermEditFields,
  UserProfileFields,
  /**
   * The post being edited, live, like `select('core/editor')` and `editPost()`
   * in Gutenberg. See docs/architecture/plugins.md#live-editor-data and ADR 0018.
   */
  editor: Object.freeze({
    usePost,
    getPost: editorStore.getPost,
    getEditedPostAttribute: editorStore.getEditedPostAttribute,
    editPost: editorStore.editPost,
    subscribe: editorStore.subscribe,
  }),
  /** The admin's UI kit, so extensions look like the rest of the admin. */
  components: Object.freeze({
    Button,
    Spinner,
    Card,
    Notice,
    Badge,
    EmptyState,
    TextField,
    TextAreaField,
    SelectField,
    Checkbox,
  }),
  /** Hooks for the admin's state. */
  useToast,
  useCurrentUser,
});

export type HostApi = typeof HOST_API;

declare global {
  interface Window {
    pressbase?: HostApi;
  }
}

/** Puts the host API on window, once, before the first module is imported. */
export function installHostApi() {
  if (typeof window === 'undefined' || window.pressbase) return;
  Object.defineProperty(window, 'pressbase', {
    value: HOST_API,
    writable: false,
    configurable: false,
    enumerable: true,
  });
}

export { pageSlot, SLOTS };
