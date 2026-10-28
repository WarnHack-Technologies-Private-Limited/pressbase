// Daily Tips in the admin: a dashboard widget, a panel in the post editor, a
// "Writing" sidebar that follows the post as you type (window.pressbase.editor)
// and a "Words" column in the posts and pages lists.
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
  PluginSidebar,
  PluginSidebarMoreMenuItem,
  PostsListColumn,
  editor,
  components: { Button, Spinner },
} = window.pressbase;

/** Words in block markup: tags and block comments aren't words. */
export function countWords(markup) {
  const text = String(markup ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** The first sentence of the post's text, for the excerpt. */
function firstSentence(markup) {
  const text = String(markup ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (text.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? text).slice(0, 300);
}

/** Lucide's lightbulb, as a component so the editor can size it. */
function LightbulbIcon({ size = 16 }) {
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
    h('path', {
      d: 'M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5',
    }),
    h('path', { d: 'M9 18h6' }),
    h('path', { d: 'M10 22h4' }),
  );
}

const muted = { color: 'var(--color-text-muted)', margin: 0, fontSize: 'var(--text-sm)' };

/** The Writing sidebar: live counts from the post being edited, and one edit. */
function WritingSidebar() {
  // Selectors re-render this only when their part of the post changes.
  const title = editor.usePost((post) => post.title) ?? '';
  const content = editor.usePost((post) => post.content) ?? '';
  const excerpt = editor.usePost((post) => post.excerpt) ?? '';
  const words = countWords(content);
  const minutes = Math.max(1, Math.round(words / 200));
  const advice = !title.trim()
    ? 'Give the post a title: it’s the first thing readers see.'
    : title.length > 60
      ? 'Long titles get cut short in search results. Try to keep it under 60 characters.'
      : words < 50
        ? 'Keep going: say the main point in the first paragraph.'
        : 'Read it aloud once before you publish.';
  const sentence = firstSentence(content);

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' } },
    h(
      'dl',
      {
        style: {
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: 'var(--space-2) var(--space-4)',
          margin: 0,
        },
      },
      h('dt', { style: muted }, 'Title'),
      h('dd', { style: { margin: 0 }, 'data-daily-tips-title': '' }, `${title.length} characters`),
      h('dt', { style: muted }, 'Words'),
      h('dd', { style: { margin: 0 }, 'data-daily-tips-words': '' }, String(words)),
      h('dt', { style: muted }, 'Reading time'),
      h('dd', { style: { margin: 0 } }, words ? `About ${minutes} min` : '—'),
    ),
    h('p', { style: { margin: 0 }, 'aria-live': 'polite', 'data-daily-tips-advice': '' }, advice),
    // A write through editor.editPost(): it marks the post as changed and saves with it.
    !excerpt.trim() && sentence
      ? h(
          'div',
          null,
          h(
            Button,
            { size: 'sm', onClick: () => editor.editPost({ excerpt: sentence }) },
            'Use the first sentence as the excerpt',
          ),
        )
      : null,
  );
}


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
      h(
        PluginSidebar,
        { name: 'writing', title: 'Writing', icon: LightbulbIcon },
        h(WritingSidebar),
      ),
      h(PluginSidebarMoreMenuItem, { target: 'writing', icon: LightbulbIcon }, 'Writing'),
      h(PostsListColumn, { title: 'Words', postTypes: ['post', 'page'] }, ({ post }) =>
        String(countWords(post.content?.raw ?? '')),
      ),
    ),
});
