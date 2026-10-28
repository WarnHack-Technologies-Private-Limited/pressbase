// Daily Tips: the example plugin that ships with Pressbase.
// It shows the three things most plugins do: a filter, a REST route and a
// custom post type. See docs/architecture/plugins.md.

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

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
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

  api.hooks.addFilter('rest_prepare_post', async (item) => {
    if (!(await api.options.get('show_in_posts', true))) return item;
    return { ...item, daily_tip: pick(TIPS) };
  });

  api.rest.registerRoute('daily-tips/v1', '/tip', {
    permission: () => true,
    handler: async () => {
      // Tips saved in the Tips post type join the built-in ones.
      const saved = await api.content.query({
        post_type: 'daily_tip',
        post_status: 'publish',
        posts_per_page: 50,
      });
      const own = saved.posts.map((post) => post.title).filter(Boolean);
      return { tip: pick([...TIPS, ...own]) };
    },
  });
}

/** Runs once when an administrator activates the plugin. */
export async function activate(api) {
  await api.options.set('show_in_posts', await api.options.get('show_in_posts', true));
  api.logger.info('Activated.');
}

/** Runs when the plugin is deactivated. Registrations are removed for you. */
export function deactivate(api) {
  api.logger.info('Deactivated.');
}

/** Runs before the plugin is deleted: remove what it stored. */
export async function uninstall(api) {
  await api.options.delete('show_in_posts');
}
