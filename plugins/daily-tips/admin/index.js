// Daily Tips in the admin: a dashboard widget and a panel in the post editor.
//
// A browser module the admin imports at runtime (plugin.json "admin.module").
// It uses the admin's own React through window.pressbase instead of bundling
// one, and plain createElement calls so it needs no build step. With a
// bundler you can write JSX and map "react/jsx-runtime" to
// window.pressbase.jsxRuntime. See docs/architecture/plugins.md#ui-modules.

const {
  element: { createElement: h, Fragment, useCallback, useEffect, useState },
  api,
  registerPlugin,
  DashboardWidget,
  PluginDocumentSettingPanel,
  components: { Button, Spinner },
} = window.pressbase;

/** Loads a tip (and the widget colour) from the plugin's REST route. */
function useTip() {
  const [state, setState] = useState({ status: 'loading' });
  const load = useCallback(() => {
    setState((s) => ({ ...s, status: 'loading' }));
    api('/daily-tips/v1/widget').then(
      (data) => setState({ status: 'ready', tip: data.tip, accent: data.accent }),
      () => setState({ status: 'failed' }),
    );
  }, []);
  useEffect(load, []);
  return [state, load];
}

function Tip({ compact }) {
  const [state, load] = useTip();
  if (state.status === 'failed') {
    return h(
      'p',
      { style: { color: 'var(--color-text-muted)', margin: 0 } },
      'The tip couldn’t load.',
    );
  }
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' } },
    h(
      'blockquote',
      {
        'data-daily-tip': '',
        'aria-live': 'polite',
        style: {
          margin: 0,
          padding: compact
            ? '0 0 0 var(--space-3)'
            : 'var(--space-1) 0 var(--space-1) var(--space-4)',
          borderLeft: `3px solid ${state.accent || 'var(--color-accent)'}`,
          fontSize: compact ? 'var(--text-sm)' : 'var(--text-md)',
          lineHeight: 1.5,
          minHeight: '3em',
        },
      },
      state.tip ?? h(Spinner),
    ),
    h(
      'div',
      null,
      h(
        Button,
        { size: 'sm', variant: 'secondary', onClick: load, loading: state.status === 'loading' },
        'Another tip',
      ),
    ),
  );
}

registerPlugin('daily-tips', {
  render: () =>
    h(
      Fragment,
      null,
      h(DashboardWidget, { title: 'Writing tip' }, h(Tip)),
      h(PluginDocumentSettingPanel, { title: 'Writing tip' }, h(Tip, { compact: true })),
    ),
});
