import { type Database, schema } from '@pressbase/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { DEFAULT_ROLES } from '../auth/capabilities';
import { hashPassword } from '../auth/password';
import { writeSiteConfig } from '../config';
import type { Kernel } from '../kernel';
import { DEFAULT_THEME } from '../themes/service';
import { DB_VERSION, PRESSBASE_VERSION } from '../version';
import { describeDatabaseError } from './database';

/** The "About your site" step — WordPress's install.php form. */
export const siteInput = z.object({
  title: z.string().trim().min(1, 'Give your site a name. You can change it later.').max(200),
  username: z
    .string()
    .trim()
    .min(1, 'Choose a username.')
    .max(60, 'Usernames can be at most 60 characters.')
    .regex(
      /^[A-Za-z0-9 _.\-@]+$/,
      'Usernames can contain letters, numbers, spaces and these characters: _ . - @',
    ),
  password: z.string().min(8, 'Use at least 8 characters.').max(1024),
  email: z.email('Enter a valid email address.'),
  url: z.url({ protocol: /^https?$/, message: 'The site address must start with http or https.' }),
  timezone: z.string().optional(),
  discourageSearchEngines: z.boolean().default(false),
});

export type SiteInput = z.infer<typeof siteInput>;

function slugify(value: string): string {
  return (
    value
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'user'
  );
}

function validTimezone(value: string | undefined): string {
  if (!value) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value;
  } catch {
    return 'UTC';
  }
}

/**
 * Default options, mirroring the ones WordPress's populate_options() sets that
 * Pressbase already uses or will use in the next phases.
 */
function defaultOptions(site: SiteInput): Record<string, unknown> {
  const url = site.url.replace(/\/+$/, '');
  return {
    siteurl: url,
    home: url,
    blogname: site.title,
    blogdescription: '',
    admin_email: site.email,
    users_can_register: false,
    default_role: 'subscriber',
    timezone_string: validTimezone(site.timezone),
    date_format: 'F j, Y',
    time_format: 'g:i a',
    start_of_week: 1,
    locale: 'en_US',
    posts_per_page: 10,
    show_on_front: 'posts',
    page_on_front: 0,
    page_for_posts: 0,
    default_category: 1,
    default_comment_status: 'open',
    default_ping_status: 'closed',
    comment_moderation: false,
    comment_registration: false,
    thread_comments: true,
    thread_comments_depth: 5,
    comments_per_page: 50,
    blog_public: !site.discourageSearchEngines,
    permalink_structure: '/%year%/%monthnum%/%day%/%postname%/',
    uploads_use_yearmonth_folders: true,
    thumbnail_size_w: 150,
    thumbnail_size_h: 150,
    thumbnail_crop: true,
    medium_size_w: 300,
    medium_size_h: 300,
    medium_large_size_w: 768,
    medium_large_size_h: 0,
    large_size_w: 1024,
    large_size_h: 1024,
    active_plugins: [],
    // The bundled block theme (themes/pressbase), as WordPress installs its default theme.
    template: DEFAULT_THEME,
    stylesheet: DEFAULT_THEME,
    user_roles: DEFAULT_ROLES,
    fresh_site: true,
    pressbase_version: PRESSBASE_VERSION,
    pressbase_installed_at: new Date().toISOString(),
    initial_db_version: DB_VERSION,
    // Written last: its presence is what marks the site as installed.
    pressbase_db_version: DB_VERSION,
  };
}

/** The single row an INSERT … RETURNING produced; throws if there is none. */
function only<T>(rows: T[], what: string): T {
  const [row] = rows;
  if (!row) throw new Error(`Could not create ${what}.`);
  return row;
}

/**
 * Creates the first user, default options and sample content in one
 * transaction, like wp_install(). Returns the new administrator's ID.
 * The schema must already be migrated.
 */
export async function installSite(db: Database, site: SiteInput): Promise<{ userId: number }> {
  const pass = await hashPassword(site.password);
  const url = site.url.replace(/\/+$/, '');

  return db.transaction(async (tx) => {
    const admin = only(
      await tx
        .insert(schema.users)
        .values({
          login: site.username,
          pass,
          nicename: slugify(site.username),
          email: site.email,
          displayName: site.username,
        })
        .returning({ id: schema.users.id }),
      'the administrator account',
    );

    await tx.insert(schema.usermeta).values([
      { userId: admin.id, key: 'capabilities', value: { administrator: true } },
      { userId: admin.id, key: 'show_welcome_panel', value: true },
    ]);

    const term = only(
      await tx
        .insert(schema.terms)
        .values({ name: 'Uncategorized', slug: 'uncategorized' })
        .returning({ id: schema.terms.id }),
      'the default category',
    );
    const category = only(
      await tx
        .insert(schema.termTaxonomy)
        .values({ termId: term.id, taxonomy: 'category', count: 1 })
        .returning({ id: schema.termTaxonomy.id }),
      'the default category',
    );

    const now = new Date();
    const helloWorld = only(
      await tx
        .insert(schema.posts)
        .values({
          authorId: admin.id,
          date: now,
          modified: now,
          title: 'Hello world!',
          slug: 'hello-world',
          content:
            '<!-- wp:paragraph -->\n<p>Welcome to Pressbase. This is your first post. Edit or delete it, then start writing!</p>\n<!-- /wp:paragraph -->',
          type: 'post',
          status: 'publish',
          commentCount: 1,
        })
        .returning({ id: schema.posts.id }),
      'the first post',
    );
    await tx
      .update(schema.posts)
      .set({ guid: `${url}/?p=${helloWorld.id}` })
      .where(eq(schema.posts.id, helloWorld.id));

    await tx
      .insert(schema.termRelationships)
      .values({ objectId: helloWorld.id, termTaxonomyId: category.id });

    await tx.insert(schema.comments).values({
      postId: helloWorld.id,
      author: 'A Pressbase Commenter',
      authorEmail: 'commenter@pressbase.example',
      date: now,
      content:
        'Hi, this is a comment.\nTo get started with moderating, editing, and deleting comments, visit the Comments screen in the dashboard.',
    });

    const samplePage = only(
      await tx
        .insert(schema.posts)
        .values({
          authorId: admin.id,
          date: now,
          modified: now,
          title: 'Sample Page',
          slug: 'sample-page',
          content:
            '<!-- wp:paragraph -->\n<p>This is an example page. It is different from a blog post because it stays in one place and shows up in your site navigation. Most people start with an About page that introduces them to potential site visitors.</p>\n<!-- /wp:paragraph -->',
          type: 'page',
          status: 'publish',
          commentStatus: 'closed',
        })
        .returning({ id: schema.posts.id }),
      'the sample page',
    );
    await tx
      .update(schema.posts)
      .set({ guid: `${url}/?page_id=${samplePage.id}` })
      .where(eq(schema.posts.id, samplePage.id));

    const options = Object.entries(defaultOptions(site)).map(([name, value]) => ({ name, value }));
    await tx.insert(schema.options).values(options);

    return { userId: admin.id };
  });
}

/** Why an installation didn't happen, with WordPress-style codes. `hint` says what to do next. */
export class InstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 409,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/**
 * The installer's last step (WordPress's install.php `step=2`), shared by
 * POST /pressbase/v1/install and `pressbase core install`: connect and
 * migrate when no database was configured yet, refuse a database that
 * already holds a site, run installSite(), save config.json and mark the
 * site ready. Throws InstallError.
 */
export async function installPressbase(
  kernel: Kernel,
  args: { site: SiteInput; databaseUrl?: string },
): Promise<{ userId: number }> {
  if (kernel.state === 'ready') {
    throw new InstallError(
      'pressbase_already_installed',
      'Pressbase is already installed. Log in instead.',
      409,
    );
  }
  let newDatabaseUrl: string | undefined;
  if (kernel.state === 'needs-database') {
    if (!args.databaseUrl) {
      throw new InstallError('rest_invalid_param', 'Choose a database.', 400);
    }
    newDatabaseUrl = args.databaseUrl;
    let state: string;
    try {
      state = await kernel.useDatabase(newDatabaseUrl);
    } catch (error) {
      const problem = describeDatabaseError(error);
      throw new InstallError(problem.code, problem.message, 400, problem.hint);
    }
    if (state === 'ready') {
      await writeSiteConfig(kernel.config.dataDir, { databaseUrl: newDatabaseUrl });
      throw new InstallError(
        'pressbase_already_installed',
        'This database already holds a Pressbase site. Log in instead.',
        409,
      );
    }
  }
  const { userId } = await installSite(kernel.db, args.site);
  if (newDatabaseUrl) await writeSiteConfig(kernel.config.dataDir, { databaseUrl: newDatabaseUrl });
  await kernel.refreshState();
  return { userId };
}
