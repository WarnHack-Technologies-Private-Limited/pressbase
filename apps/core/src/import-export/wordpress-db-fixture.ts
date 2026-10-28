import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { phpSerialize } from './php-serialize';
import type {
  PostFilter,
  WordPressCounts,
  WordPressDatabase,
  WpCommentRow,
  WpMetaRow,
  WpPostRow,
  WpTermRow,
  WpUserRow,
} from './wordpress-db';

/**
 * A small WordPress 7.1 site's database, written by hand for the migration
 * tests: rows as WordPress stores them in the tables of
 * wp-admin/includes/schema.php (WordPress 7.1.3). An admin, an author with an
 * old phpass hash and an editor with a WordPress 6.8+ `$wp$` bcrypt hash;
 * nested categories, tags, a sticky post with Yoast SEO meta and a featured
 * image, a classic gallery with Rank Math meta and threaded comments, a draft,
 * a page tree whose child comes before its parent, a classic menu, a block
 * menu, an attachment whose file is in fixtures/wp-uploads, and what a
 * migration leaves out (a revision, an auto-draft, a spam comment, a
 * WooCommerce product).
 *
 * The same rows are loaded into a real MySQL in CI (wordpress-db.mysql.test.ts).
 */

/** Passwords for the hashes below. */
export const FIXTURE_PASSWORDS = {
  admin: 'harbour-master-2026',
  nadia: 'tide-tables-at-dawn',
  theo: 'rope-and-varnish',
};

/** fixtures/wp-uploads: a copy of the site's wp-content/uploads. */
export const FIXTURE_UPLOADS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'wp-uploads',
);

export const FIXTURE_SITE = 'https://harbour.example';
const UPLOADS = `${FIXTURE_SITE}/wp-content/uploads`;
const ZERO = '0000-00-00 00:00:00';

type Row = Record<string, string | number | null>;

/** Every column of wp_posts, with the defaults schema.php gives. */
function post(fields: Row & { ID: number; post_date: string; post_date_gmt: string }): Row {
  return {
    post_author: 1,
    post_content: '',
    post_title: '',
    post_excerpt: '',
    post_status: 'publish',
    comment_status: 'closed',
    ping_status: 'closed',
    post_password: '',
    post_name: '',
    to_ping: '',
    pinged: '',
    post_modified: fields.post_date,
    post_modified_gmt: fields.post_date_gmt,
    post_content_filtered: '',
    post_parent: 0,
    guid: `${FIXTURE_SITE}/?p=${fields.ID}`,
    menu_order: 0,
    post_type: 'post',
    post_mime_type: '',
    comment_count: 0,
    ...fields,
  };
}

function comment(fields: Row & { comment_ID: number; comment_post_ID: number }): Row {
  return {
    comment_author: '',
    comment_author_email: '',
    comment_author_url: '',
    comment_author_IP: '192.0.2.10',
    comment_date: '2026-03-05 10:00:00',
    comment_date_gmt: '2026-03-05 10:00:00',
    comment_content: '',
    comment_karma: 0,
    comment_approved: '1',
    comment_agent: 'Mozilla/5.0',
    comment_type: 'comment',
    comment_parent: 0,
    user_id: 0,
    ...fields,
  };
}

let metaId = 0;
function meta(owner: string, id: number, entries: Record<string, string>): Row[] {
  return Object.entries(entries).map(([meta_key, meta_value]) => ({
    meta_id: ++metaId,
    [owner]: id,
    meta_key,
    meta_value,
  }));
}

function userMeta(id: number, entries: Record<string, string>): Row[] {
  return meta('user_id', id, entries).map(({ meta_id, ...rest }) => ({
    umeta_id: meta_id ?? null,
    ...rest,
  }));
}

const caps = (role: string) => phpSerialize({ [role]: true });

/** The tables, without the prefix. */
export function wordpressFixture(): Record<string, Row[]> {
  metaId = 0;
  return {
    options: Object.entries({
      siteurl: FIXTURE_SITE,
      home: FIXTURE_SITE,
      blogname: 'Harbour Notes',
      blogdescription: 'A boatyard’s logbook',
      admin_email: 'admin@harbour.example',
      permalink_structure: '/%postname%/',
      category_base: '',
      tag_base: '/topic',
      timezone_string: 'Europe/Lisbon',
      gmt_offset: '0',
      date_format: 'j F Y',
      time_format: 'H:i',
      start_of_week: '1',
      posts_per_page: '6',
      posts_per_rss: '10',
      rss_use_excerpt: '0',
      show_on_front: 'page',
      page_on_front: '2',
      page_for_posts: '4',
      default_category: '1',
      default_comment_status: 'open',
      default_ping_status: 'open',
      comment_moderation: '',
      comment_registration: '',
      thread_comments: '1',
      thread_comments_depth: '5',
      comments_per_page: '50',
      blog_public: '1',
      WPLANG: '',
      upload_path: '',
      upload_url_path: '',
      uploads_use_yearmonth_folders: '1',
      thumbnail_size_w: '150',
      thumbnail_size_h: '150',
      thumbnail_crop: '1',
      medium_size_w: '300',
      medium_size_h: '300',
      medium_large_size_w: '768',
      medium_large_size_h: '0',
      large_size_w: '1024',
      large_size_h: '1024',
      sticky_posts: phpSerialize([10]),
      active_plugins: phpSerialize(['wordpress-seo/wp-seo.php']),
      template: 'twentytwentyfive',
      stylesheet: 'twentytwentyfive',
      db_version: '61833',
      wpseo_taxonomy_meta: phpSerialize({
        category: {
          '3': {
            wpseo_title: 'Repairs we do %%sep%% %%sitename%%',
            wpseo_desc: 'Hull, deck and engine repairs at the yard.',
          },
        },
      }),
    }).map(([option_name, option_value], i) => ({
      option_id: i + 1,
      option_name,
      option_value,
      autoload: 'on',
    })),

    users: [
      {
        ID: 1,
        user_login: 'admin',
        user_pass: '$wp$2y$10$ZTyx/e/4b349FggqzzTgX.Lv.q9ai.DNb0C6A.wvfqMOUtX8zvzsq',
        user_nicename: 'admin',
        user_email: 'admin@harbour.example',
        user_url: FIXTURE_SITE,
        user_registered: '2025-11-02 09:14:00',
        user_activation_key: '',
        user_status: 0,
        display_name: 'Harbour Master',
      },
      {
        ID: 2,
        user_login: 'nadia',
        user_pass: '$P$Bk3Lm9QxZiAtJpueUSI7OkoPHsAg9A.',
        user_nicename: 'nadia-rahman',
        user_email: 'nadia@harbour.example',
        user_url: '',
        user_registered: '2025-11-20 16:40:12',
        user_activation_key: '',
        user_status: 0,
        display_name: 'Nadia Rahman',
      },
      {
        ID: 3,
        user_login: 'theo',
        user_pass: '$wp$2y$10$pj/3VHMWF8iFDSj08aYxse1c0pZgTL65Tv3FeIGaAdeiYV0S7GrBa',
        user_nicename: 'theo',
        user_email: 'theo@harbour.example',
        user_url: 'https://theo.example',
        user_registered: '2026-01-08 08:00:00',
        user_activation_key: '',
        user_status: 0,
        display_name: 'Theo Marsh',
      },
    ],
    usermeta: [
      ...userMeta(1, {
        nickname: 'admin',
        first_name: '',
        last_name: '',
        description: '',
        locale: '',
        wp_capabilities: caps('administrator'),
        wp_user_level: '10',
        session_tokens: phpSerialize({ abc: { expiration: 1 } }),
      }),
      ...userMeta(2, {
        nickname: 'Nadia',
        first_name: 'Nadia',
        last_name: 'Rahman',
        description: 'Writes the yard’s logbook.',
        locale: 'en_GB',
        wp_capabilities: caps('author'),
        wp_user_level: '2',
      }),
      ...userMeta(3, {
        nickname: 'Theo',
        first_name: 'Theo',
        last_name: 'Marsh',
        description: '',
        locale: '',
        wp_capabilities: caps('editor'),
        wp_user_level: '7',
      }),
    ],

    terms: [
      { term_id: 1, name: 'Uncategorized', slug: 'uncategorized', term_group: 0 },
      { term_id: 2, name: 'Boats', slug: 'boats', term_group: 0 },
      { term_id: 3, name: 'Repairs', slug: 'repairs', term_group: 0 },
      { term_id: 4, name: 'Winter', slug: 'winter', term_group: 0 },
      { term_id: 5, name: 'Paint', slug: 'paint', term_group: 0 },
      { term_id: 6, name: 'Main menu', slug: 'main-menu', term_group: 0 },
    ],
    term_taxonomy: [
      [1, 'category', '', 0, 1],
      [2, 'category', 'Boats we look after.', 0, 1],
      [3, 'category', '', 2, 1],
      [4, 'post_tag', '', 0, 1],
      [5, 'post_tag', '', 0, 2],
      [6, 'nav_menu', '', 0, 3],
    ].map(([id, taxonomy, description, parent, count]) => ({
      term_taxonomy_id: id as number,
      term_id: id as number,
      taxonomy: taxonomy as string,
      description: description as string,
      parent: parent as number,
      count: count as number,
    })),
    termmeta: [
      ...meta('term_id', 2, {
        rank_math_title: 'Boats we look after %sep% %sitename%',
        rank_math_description: 'The boats in our yard this winter.',
      }),
    ],
    term_relationships: [
      [10, 3],
      [10, 4],
      [10, 5],
      [11, 2],
      [11, 5],
      [12, 1],
      [13, 3],
      [30, 6],
      [31, 6],
      [32, 6],
    ].map(([object_id, term_taxonomy_id]) => ({
      object_id: object_id as number,
      term_taxonomy_id: term_taxonomy_id as number,
      term_order: 0,
    })),

    posts: [
      post({
        ID: 2,
        post_title: 'About the yard',
        post_name: 'about-the-yard',
        post_type: 'page',
        post_content: '<!-- wp:paragraph -->\n<p>We look after wooden boats.</p>\n<!-- /wp:paragraph -->',
        post_date: '2026-01-05 10:00:00',
        post_date_gmt: '2026-01-05 10:00:00',
        guid: `${FIXTURE_SITE}/?page_id=2`,
      }),
      post({
        ID: 3,
        post_author: 2,
        post_title: 'Our crew',
        post_name: 'our-crew',
        post_type: 'page',
        post_parent: 2,
        menu_order: 1,
        post_content: '<!-- wp:paragraph -->\n<p>Five people and a dog.</p>\n<!-- /wp:paragraph -->',
        post_date: '2026-01-06 10:00:00',
        post_date_gmt: '2026-01-06 10:00:00',
        guid: `${FIXTURE_SITE}/?page_id=3`,
      }),
      post({
        ID: 4,
        post_title: 'Logbook',
        post_name: 'logbook',
        post_type: 'page',
        post_date: '2026-01-06 11:00:00',
        post_date_gmt: '2026-01-06 11:00:00',
        guid: `${FIXTURE_SITE}/?page_id=4`,
      }),
      // A child page whose parent (9) comes after it.
      post({
        ID: 5,
        post_title: 'Winter rates',
        post_name: 'winter-rates',
        post_type: 'page',
        post_parent: 9,
        post_content: '<!-- wp:paragraph -->\n<p>€12 a foot.</p>\n<!-- /wp:paragraph -->',
        post_date: '2026-01-07 10:00:00',
        post_date_gmt: '2026-01-07 10:00:00',
        guid: `${FIXTURE_SITE}/?page_id=5`,
      }),
      post({
        ID: 9,
        post_title: 'Services',
        post_name: 'services',
        post_type: 'page',
        post_date: '2026-01-07 11:00:00',
        post_date_gmt: '2026-01-07 11:00:00',
        guid: `${FIXTURE_SITE}/?page_id=9`,
      }),
      post({
        ID: 10,
        post_author: 2,
        post_title: 'Hauling out for winter',
        post_name: 'hauling-out-for-winter',
        post_excerpt: 'How the yard fills up in November.',
        comment_status: 'open',
        post_content: [
          '<!-- wp:paragraph -->\n<p>Every November the yard fills up.</p>\n<!-- /wp:paragraph -->',
          `<!-- wp:image {"id":20,"sizeSlug":"large"} -->\n<figure class="wp-block-image size-large"><img src="${UPLOADS}/2026/02/hull-on-stands.png" alt="A blue hull on stands" class="wp-image-20"/></figure>\n<!-- /wp:image -->`,
          `<!-- wp:paragraph -->\n<p>See <a href="${FIXTURE_SITE}/?page_id=9">our services</a>.</p>\n<!-- /wp:paragraph -->`,
        ].join('\n\n'),
        post_date: '2026-03-01 09:30:00',
        post_date_gmt: '2026-03-01 09:30:00',
        post_modified: '2026-03-02 12:00:00',
        post_modified_gmt: '2026-03-02 12:00:00',
      }),
      post({
        ID: 11,
        post_author: 3,
        post_title: 'Antifouling, a gallery',
        post_name: 'antifouling-a-gallery',
        comment_status: 'open',
        post_content: '<p>Two coats this year.</p>\n\n[gallery ids="20" columns="2"]',
        post_date: '2026-03-04 15:00:00',
        post_date_gmt: '2026-03-04 15:00:00',
        comment_count: 2,
      }),
      // A draft: WordPress leaves post_date_gmt at the zero date until it's published.
      post({
        ID: 12,
        post_author: 2,
        post_title: 'Notes for spring',
        post_name: '',
        post_status: 'draft',
        post_content: '<!-- wp:paragraph -->\n<p>Masts go back up in April.</p>\n<!-- /wp:paragraph -->',
        post_date: '2026-03-10 18:00:00',
        post_date_gmt: ZERO,
      }),
      post({
        ID: 13,
        post_author: 2,
        post_title: 'Hauling out for winter',
        post_name: '10-revision-v1',
        post_status: 'inherit',
        post_type: 'revision',
        post_parent: 10,
        post_date: '2026-03-01 09:29:00',
        post_date_gmt: '2026-03-01 09:29:00',
      }),
      post({
        ID: 14,
        post_title: 'Auto Draft',
        post_status: 'auto-draft',
        post_date: '2026-03-11 08:00:00',
        post_date_gmt: ZERO,
      }),
      post({
        ID: 15,
        post_title: 'Tin of varnish',
        post_name: 'tin-of-varnish',
        post_type: 'product',
        post_date: '2026-02-01 08:00:00',
        post_date_gmt: '2026-02-01 08:00:00',
      }),
      // Uploaded in March while editing post 10, into the folder of February (its first draft).
      post({
        ID: 20,
        post_author: 2,
        post_title: 'Hull on stands',
        post_name: 'hull-on-stands',
        post_excerpt: 'Ready for scraping.',
        post_status: 'inherit',
        post_type: 'attachment',
        post_parent: 10,
        post_mime_type: 'image/png',
        guid: `${UPLOADS}/2026/02/hull-on-stands.png`,
        post_date: '2026-03-01 09:00:00',
        post_date_gmt: '2026-03-01 09:00:00',
      }),
      ...[30, 31, 32].map((ID, i) =>
        post({
          ID,
          post_title: ID === 32 ? 'WordPress' : '',
          post_name: String(ID),
          post_type: 'nav_menu_item',
          menu_order: i + 1,
          post_date: '2026-01-10 10:00:00',
          post_date_gmt: '2026-01-10 10:00:00',
        }),
      ),
      post({
        ID: 40,
        post_title: 'Footer',
        post_name: 'footer',
        post_type: 'wp_navigation',
        post_content: `<!-- wp:navigation-link {"label":"About","type":"page","id":2,"url":"${FIXTURE_SITE}/about-the-yard/","kind":"post-type"} /-->`,
        post_date: '2026-01-11 10:00:00',
        post_date_gmt: '2026-01-11 10:00:00',
      }),
    ],
    postmeta: [
      ...meta('post_id', 2, { _wp_page_template: 'default' }),
      ...meta('post_id', 10, {
        _edit_lock: '1772360000:2',
        _edit_last: '2',
        _thumbnail_id: '20',
        _yoast_wpseo_title: '%%title%% %%sep%% %%sitename%%',
        _yoast_wpseo_metadesc: 'How we haul boats out for the winter.',
        _yoast_wpseo_focuskw: 'haul out',
        _yoast_wpseo_primary_category: '3',
      }),
      ...meta('post_id', 11, {
        rank_math_title: '%title% %sep% %sitename%',
        rank_math_description: 'Antifouling, coat by coat.',
        rank_math_primary_category: '2',
      }),
      ...meta('post_id', 15, { _price: '9.50' }),
      ...meta('post_id', 20, {
        _wp_attached_file: '2026/02/hull-on-stands.png',
        _wp_attachment_metadata: phpSerialize({
          width: 400,
          height: 300,
          file: '2026/02/hull-on-stands.png',
          filesize: 2476,
          sizes: {},
          image_meta: {},
        }),
        _wp_attachment_image_alt: 'A blue hull on stands',
      }),
      ...meta('post_id', 30, {
        _menu_item_type: 'post_type',
        _menu_item_menu_item_parent: '0',
        _menu_item_object_id: '2',
        _menu_item_object: 'page',
        _menu_item_target: '',
        _menu_item_classes: phpSerialize(['']),
        _menu_item_xfn: '',
        _menu_item_url: '',
      }),
      ...meta('post_id', 31, {
        _menu_item_type: 'taxonomy',
        _menu_item_menu_item_parent: '0',
        _menu_item_object_id: '2',
        _menu_item_object: 'category',
        _menu_item_target: '',
        _menu_item_classes: phpSerialize(['']),
        _menu_item_xfn: '',
        _menu_item_url: '',
      }),
      ...meta('post_id', 32, {
        _menu_item_type: 'custom',
        _menu_item_menu_item_parent: '0',
        _menu_item_object_id: '32',
        _menu_item_object: 'custom',
        _menu_item_target: '',
        _menu_item_classes: phpSerialize(['']),
        _menu_item_xfn: '',
        _menu_item_url: 'https://wordpress.org/',
      }),
    ],

    comments: [
      comment({
        comment_ID: 1,
        comment_post_ID: 11,
        comment_author: 'Inês Costa',
        comment_author_email: 'ines@example.org',
        comment_content: 'Which brand do you use?',
        comment_date: '2026-03-05 10:00:00',
        comment_date_gmt: '2026-03-05 10:00:00',
      }),
      comment({
        comment_ID: 2,
        comment_post_ID: 11,
        comment_author: 'Nadia Rahman',
        comment_author_email: 'nadia@harbour.example',
        comment_content: 'A copper-free one, this year.',
        comment_parent: 1,
        user_id: 2,
        comment_date: '2026-03-05 11:30:00',
        comment_date_gmt: '2026-03-05 11:30:00',
      }),
      comment({
        comment_ID: 3,
        comment_post_ID: 11,
        comment_author: 'cheap-pills',
        comment_content: 'Buy now',
        comment_approved: 'spam',
        comment_date: '2026-03-05 12:00:00',
        comment_date_gmt: '2026-03-05 12:00:00',
      }),
      comment({
        comment_ID: 4,
        comment_post_ID: 10,
        comment_author: 'Sam',
        comment_author_email: 'sam@example.org',
        comment_content: 'Is there space for a 30-footer?',
        comment_approved: '0',
        comment_date: '2026-03-06 08:00:00',
        comment_date_gmt: '2026-03-06 08:00:00',
      }),
    ],
    commentmeta: [...meta('comment_id', 1, { akismet_result: 'false' })],
  };
}

/* ----------------------------------------------------- the in-memory fake */

const num = (v: unknown) => Number(v ?? 0);
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

function byId<T>(rows: T[], id: (row: T) => number, after: number, limit: number): T[] {
  return rows
    .filter((r) => id(r) > after)
    .sort((a, b) => id(a) - id(b))
    .slice(0, limit);
}

function metaRows(rows: Row[], owner: string, ids: number[]): WpMetaRow[] {
  const wanted = new Set(ids);
  return rows
    .filter((r) => wanted.has(num(r[owner])))
    .sort((a, b) => num(a.meta_id ?? a.umeta_id) - num(b.meta_id ?? b.umeta_id))
    .map((r) => ({ owner: num(r[owner]), key: s(r.meta_key), value: s(r.meta_value) }));
}

/**
 * The query interface answered from fixture tables in memory, as the SQL in
 * wordpress-db.ts answers it from MySQL. `extraTables` are names that exist
 * without rows (`blogs`, to look like a multisite network).
 */
export function memoryWordPressDatabase(
  tables: Record<string, Row[]> = wordpressFixture(),
  options: { prefix?: string; extraTables?: string[] } = {},
): WordPressDatabase & { queries: string[] } {
  const t = (name: string) => tables[name] ?? [];
  const queries: string[] = [];
  const posts = (filter: PostFilter) =>
    t('posts').filter(
      (p) =>
        !['revision', ...filter.excludeTypes].includes(s(p.post_type)) &&
        p.post_status !== 'auto-draft',
    );
  const login = (id: unknown) => t('users').find((u) => num(u.ID) === num(id))?.user_login;
  return {
    prefix: options.prefix ?? 'wp_',
    queries,
    async hasTable(name) {
      queries.push(`hasTable ${name}`);
      return name in tables || (options.extraTables ?? []).includes(name);
    },
    async options(names) {
      queries.push('options');
      return t('options')
        .filter((o) => names.includes(s(o.option_name)))
        .map((o) => ({ option_name: s(o.option_name), option_value: s(o.option_value) }));
    },
    async users(after, limit) {
      queries.push(`users ${after}`);
      return byId(t('users'), (u) => num(u.ID), after, limit) as unknown as WpUserRow[];
    },
    async usermeta(ids, keys) {
      return metaRows(t('usermeta'), 'user_id', ids).filter((m) => keys.includes(m.key));
    },
    async terms(after, limit) {
      queries.push(`terms ${after}`);
      return byId(t('term_taxonomy'), (r) => num(r.term_taxonomy_id), after, limit).map((tt) => {
        const term = t('terms').find((x) => num(x.term_id) === num(tt.term_id)) ?? {};
        const parent = t('terms').find((x) => num(x.term_id) === num(tt.parent));
        return {
          term_taxonomy_id: num(tt.term_taxonomy_id),
          term_id: num(tt.term_id),
          name: s(term.name),
          slug: s(term.slug),
          taxonomy: s(tt.taxonomy),
          description: s(tt.description),
          parent: num(tt.parent),
          parent_slug: num(tt.parent) && parent ? s(parent.slug) : null,
        } satisfies WpTermRow;
      });
    },
    async termmeta(ids) {
      return metaRows(t('termmeta'), 'term_id', ids);
    },
    async posts(after, limit, filter) {
      queries.push(`posts ${after}`);
      return byId(posts(filter), (p) => num(p.ID), after, limit).map(
        (p) => ({ ...p, author_login: login(p.post_author) ?? null }) as unknown as WpPostRow,
      );
    },
    async postmeta(ids) {
      return metaRows(t('postmeta'), 'post_id', ids);
    },
    async postTerms(ids) {
      return t('term_relationships')
        .filter((r) => ids.includes(num(r.object_id)))
        .flatMap((r) => {
          const tt = t('term_taxonomy').find(
            (x) => num(x.term_taxonomy_id) === num(r.term_taxonomy_id),
          );
          const term = tt && t('terms').find((x) => num(x.term_id) === num(tt.term_id));
          if (!tt || !term || tt.taxonomy === 'link_category') return [];
          return [
            {
              object_id: num(r.object_id),
              taxonomy: s(tt.taxonomy),
              slug: s(term.slug),
              name: s(term.name),
            },
          ];
        });
    },
    async comments(postIds, after, limit) {
      queries.push(`comments ${after}`);
      return byId(
        t('comments').filter(
          (c) => postIds.includes(num(c.comment_post_ID)) && c.comment_approved !== 'spam',
        ),
        (c) => num(c.comment_ID),
        after,
        limit,
      ) as unknown as WpCommentRow[];
    },
    async commentmeta(ids) {
      return metaRows(t('commentmeta'), 'comment_id', ids);
    },
    async counts(filter): Promise<WordPressCounts> {
      const kept = posts(filter);
      const keptIds = new Set(kept.map((p) => num(p.ID)));
      const tally = (rows: Row[], key: string) => {
        const out: Record<string, number> = {};
        for (const row of rows) out[s(row[key])] = (out[s(row[key])] ?? 0) + 1;
        return out;
      };
      return {
        users: t('users').length,
        terms: tally(t('term_taxonomy'), 'taxonomy'),
        posts: tally(kept, 'post_type'),
        comments: filter.comments
          ? t('comments').filter(
              (c) => keptIds.has(num(c.comment_post_ID)) && c.comment_approved !== 'spam',
            ).length
          : 0,
      };
    },
    async close() {},
  };
}
