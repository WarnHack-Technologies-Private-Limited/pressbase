'use client';

import { type ComponentType, useEffect, useState } from 'react';
import { pageSlot } from '@/lib/extensions/registry';
import { Spinner } from '../ui/button';
import styles from './extensions.module.css';
import { ExtensionBoundary, loadPluginModule, PluginScope, Slot } from './host';

type State =
  | { status: 'loading' }
  | { status: 'ready'; Page: ComponentType<PageProps> | null }
  | { status: 'failed'; message: string };

interface PageProps {
  plugin: string;
  page: string;
}

/**
 * The body of a plugin page with a browser module: the module's default
 * export (a React component), then anything filling `plugin-page/{plugin}/{page}`.
 */
export function PluginPageBody({
  plugin,
  page,
  title,
  module,
}: {
  plugin: string;
  page: string;
  /** The plugin's title, for messages. */
  title: string;
  module: string;
}) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    loadPluginModule(plugin, module).then(
      (loaded) => {
        if (!live) return;
        const Page = typeof loaded.default === 'function' ? loaded.default : null;
        setState({ status: 'ready', Page: Page as ComponentType<PageProps> | null });
      },
      (error: unknown) => {
        if (live) {
          setState({
            status: 'failed',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [plugin, module]);

  if (state.status === 'loading') {
    return (
      <p className={styles.loading} aria-busy="true">
        <Spinner /> Loading…
      </p>
    );
  }
  if (state.status === 'failed') {
    return (
      <div className={styles.error} role="alert">
        <div>
          <p className={styles.errorTitle}>
            This page couldn’t load: the {title} plugin’s script didn’t start.
          </p>
          <details className={styles.errorDetails}>
            <summary>Details</summary>
            <code>{state.message}</code>
          </details>
        </div>
      </div>
    );
  }
  const { Page } = state;
  return (
    <div className={styles.pageBody}>
      {Page && (
        <PluginScope owner={plugin}>
          <ExtensionBoundary owner={plugin} place="page">
            <Page plugin={plugin} page={page} />
          </ExtensionBoundary>
        </PluginScope>
      )}
      <Slot name={pageSlot(plugin, page)} fillProps={{ plugin, page }} place="page" />
    </div>
  );
}
