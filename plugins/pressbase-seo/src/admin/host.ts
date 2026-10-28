/**
 * The parts of the admin's host API (`window.pressbase`, ADR 0011) that
 * Pressbase SEO uses, typed loosely: the SDK types the server API only.
 */
import type { ComponentType, ReactNode } from 'react';

// biome-ignore lint/suspicious/noExplicitAny: host components take their documented props.
type Component<P = any> = ComponentType<P>;

export interface EditorPost {
  id: number | null;
  type: string;
  status: string;
  title: string;
  content: string;
  excerpt: string;
  slug: string;
  link: string;
  permalink: string;
  featured_media: number;
  meta: Record<string, unknown>;
  terms: { categories?: { id: number; name: string }[]; tags?: { id: number; name: string }[] };
  isDirty: boolean;
}

export interface Host {
  api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
  ApiError: new (...args: never[]) => Error & { code: string; status: number; data?: unknown };
  registerPlugin(name: string, settings: { render: () => ReactNode; icon?: unknown }): void;
  PluginSidebar: Component;
  PluginSidebarMoreMenuItem: Component;
  PluginPrePublishPanel: Component;
  PostsListColumn: Component;
  PostsListFilter: Component;
  TermEditFields: Component;
  editor: {
    usePost<T>(selector: (post: EditorPost) => T): T | undefined;
    getPost(): EditorPost | null;
    editPost(edits: { meta?: Record<string, unknown>; slug?: string; excerpt?: string }): boolean;
  };
  components: {
    Button: Component;
    Spinner: Component;
    Card: Component;
    Notice: Component;
    Badge: Component;
    EmptyState: Component;
    TextField: Component;
    TextAreaField: Component;
    SelectField: Component;
    Checkbox: Component;
    MediaPicker?: Component;
  };
  useToast(): (message: string, options?: { tone?: 'danger' | 'success' }) => void;
  useCurrentUser(): { capabilities?: Record<string, boolean> } | null;
}

export const host = (globalThis as unknown as { pressbase: Host }).pressbase;
