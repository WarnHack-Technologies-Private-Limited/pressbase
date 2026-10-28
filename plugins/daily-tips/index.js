// Daily Tips: the example plugin that ships with Pressbase.
// It shows what most plugins do: a filter, REST routes, a custom post type,
// settings (declared in plugin.json and registered here) and an admin module
// with a dashboard widget and an editor panel (admin/index.js).
// See docs/architecture/plugins.md.

/** Tips written for this example. */
export const TIPS = [
  'Write the headline last: you will know what the post is about by then.',
  'Cut the first paragraph and see whether the post still makes sense.',
  'One idea per paragraph keeps readers moving.',
  'Read your draft aloud; your ear catches what your eye skips.',
  'Prefer a concrete example to an abstract rule.',
  'Link to your sources so readers can go deeper.',
  'Short sentences carry weight. Use them for the points that matter.',
];

/** At most this many of your own tips. */
const MAX_OWN_TIPS = 20;

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/** Your tips, one per line, without blank lines or stray spaces. */
export function parseTips(text) {
  return String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Runs every time the plugin loads: on boot and right after activation. */
export default function register(api) {
  api.postTypes.register('daily_tip', {
    label: 'Tips',
    singularLabel: 'Tip',
    public: false,
    showInRest: true,
    restBase: 'daily-tips',
    supports: ['title', 'editor'],
  });

  // plugin.json declares the simple settings; this one needs a sanitize callback.
  // The post's one-line focus, edited in the editor's Writing sidebar
  // (window.pressbase.editor.editPost({ meta })) and shown in the posts list.
  api.meta.registerPostMeta('post', 'daily_tips_focus', {
    type: 'string',
    single: true,
    default: '',
    label: 'Focus',
    description: 'What the post should leave the reader with, in one line.',
    showInRest: true,
    sanitizeCallback: (value) =>
      String(value ?? '')
        .trim()
        .slice(0, 200),
  });

  api.settings.register('own_tips', {
    control: 'textarea',
    label: 'Your tips',
    description: `One per line, at most ${MAX_OWN_TIPS}. Tips you save in the Tips post type count too.`,
    placeholder: 'Start with the point, then explain it.',
    maxLength: 4000,
    section: 'tips',
    sanitize: (value) => {
      const tips = parseTips(value);
      if (tips.length > MAX_OWN_TIPS) {
        throw new Error(`Keep it to ${MAX_OWN_TIPS} tips; you have ${tips.length}.`);
      }
      return tips.join('\n');
    },
  });

  /** The tips to choose from, following the "Which tips to show" setting. */
  async function tips() {
    const source = await api.settings.get('source');
    if (source === 'builtin') return TIPS;
    const saved = await api.content.query({
      post_type: 'daily_tip',
      post_status: 'publish',
      posts_per_page: 50,
    });
    const own = [
      ...parseTips(await api.settings.get('own_tips')),
      ...saved.posts.map((post) => post.title).filter(Boolean),
    ];
    if (source === 'own') return own.length ? own : TIPS;
    return [...TIPS, ...own];
  }

  api.hooks.addFilter('rest_prepare_post', async (item) => {
    if (!(await api.settings.get('show_in_posts'))) return item;
    return { ...item, daily_tip: pick(TIPS) };
  });

  api.rest.registerRoute('daily-tips/v1', '/tip', {
    permission: () => true,
    handler: async () => ({ tip: pick(await tips()) }),
  });

  // A block: "Daily tip", rendered on the server on every view (a dynamic block,
  // like WordPress's render_callback). Its editor module, admin/tip.js, gives it
  // a colour setting and a live preview. Its stylesheet loads only on pages that
  // show it. Deactivating the plugin removes it from the site; the editor keeps
  // the block in the post with a notice.
  api.blocks.register('daily-tips/tip', {
    title: 'Daily tip',
    description: 'A writing tip that changes every day.',
    category: 'widgets',
    icon: 'lightbulb',
    keywords: ['writing', 'advice'],
    attributes: {
      accent: { type: 'string', default: '#3858e9' },
    },
    supports: { align: ['wide', 'full'], anchor: true },
    editorScript: 'admin/tip.js',
    style: 'tip.css',
    render: async (attributes, content, block) => {
      const list = await tips();
      const tip = list[Math.floor(Date.now() / 86_400_000) % list.length];
      // Attributes are checked against the schema above; the colour still needs its own check.
      const accent = /^#[0-9a-f]{3,8}$/i.test(attributes.accent) ? attributes.accent : '#3858e9';
      const wrapper = api.blocks.getBlockWrapperAttributes(block, {
        style: `--daily-tip-accent: ${accent}`,
      });
      return `<aside ${wrapper}><p class="wp-block-daily-tips-tip__label">${api.blocks.escHtml(
        api.i18n.__('Tip of the day'),
      )}</p><p class="wp-block-daily-tips-tip__text">${api.blocks.escHtml(tip)}</p></aside>`;
    },
  });

  // What the dashboard widget shows: a tip and the widget's colour.
  api.rest.registerRoute('daily-tips/v1', '/widget', {
    permission: (c) => api.rest.userCan(c, 'read'),
    handler: async () => ({
      tip: pick(await tips()),
      accent: (await api.settings.get('accent')) || '#3858e9',
    }),
  });
}

/** Runs once when an administrator activates the plugin. */
export function activate(api) {
  api.logger.info('Activated.');
}

/** Runs when the plugin is deactivated. Registrations are removed for you. */
export function deactivate(api) {
  api.logger.info('Deactivated.');
}

/** Runs before the plugin is deleted: remove what it stored. */
export async function uninstall(api) {
  for (const name of ['show_in_posts', 'accent', 'source', 'own_tips']) {
    await api.options.delete(name);
  }
}
