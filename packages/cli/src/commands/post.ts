import { userCan } from '@pressbase/core/src/auth/users';
import { parseRestDate } from '@pressbase/core/src/content/dates';
import type { Post, PostInput } from '@pressbase/core/src/content/posts';
import { type OrderBy, type QueryArgs, queryPosts } from '@pressbase/core/src/content/query';
import { deleteAttachment, setMeta } from '@pressbase/core/src/media/service';
import { postBodySchema } from '@pressbase/core/src/routes/posts';
import { schema } from '@pressbase/db';
import { eq } from 'drizzle-orm';
import type { CommandSpec, Context } from '../command';
import { gmtDate, localDate, service, siteTimeZone } from './shared';

/**
 * `pressbase post`: wp-cli's entity-command for posts, on kernel.posts
 * (wp_insert_post(), wp_update_post(), wp_trash_post(), wp_delete_post())
 * and queryPosts() (WP_Query). Fields use WP_Post's names. Writes are
 * validated with the REST API's schema and follow its permission rules
 * when --user is given.
 */

const FIELDS = [
  'ID',
  'post_author',
  'post_date',
  'post_date_gmt',
  'post_content',
  'post_title',
  'post_excerpt',
  'post_status',
  'comment_status',
  'ping_status',
  'post_password',
  'post_name',
  'post_modified',
  'post_modified_gmt',
  'post_parent',
  'guid',
  'menu_order',
  'post_type',
  'post_mime_type',
  'comment_count',
];
const LIST_FIELDS = ['ID', 'post_title', 'post_name', 'post_date', 'post_status'];

function toRow(post: Post, timeZone: string) {
  return {
    ID: post.id,
    post_author: post.authorId ?? 0,
    post_date: localDate(post.date, timeZone),
    post_date_gmt: gmtDate(post.date),
    post_content: post.content,
    post_title: post.title,
    post_excerpt: post.excerpt,
    post_status: post.status,
    comment_status: post.commentStatus,
    ping_status: post.pingStatus,
    post_password: post.password,
    post_name: post.slug,
    post_modified: localDate(post.modified, timeZone),
    post_modified_gmt: gmtDate(post.modified),
    post_parent: post.parentId ?? 0,
    guid: post.guid,
    menu_order: post.menuOrder,
    post_type: post.type,
    post_mime_type: post.mimeType,
    comment_count: post.commentCount,
  };
}

/** The WP_Query arguments `post list` passes through (`--<field>=<value>`). */
const QUERY_ARGS: Record<string, (ctx: Context, key: string, args: QueryArgs) => void> = {
  posts_per_page: (ctx, key, a) => {
    a.posts_per_page = ctx.int(key);
  },
  paged: (ctx, key, a) => {
    a.paged = ctx.int(key);
  },
  offset: (ctx, key, a) => {
    a.offset = ctx.int(key);
  },
  s: (ctx, key, a) => {
    a.s = ctx.string(key);
  },
  author: (ctx, key, a) => {
    a.author__in = ctx.ids(key);
  },
  author__in: (ctx, key, a) => {
    a.author__in = ctx.ids(key);
  },
  author__not_in: (ctx, key, a) => {
    a.author__not_in = ctx.ids(key);
  },
  post__in: (ctx, key, a) => {
    a.post__in = ctx.ids(key);
  },
  post__not_in: (ctx, key, a) => {
    a.post__not_in = ctx.ids(key);
  },
  name: (ctx, key, a) => {
    a.name = ctx.string(key);
  },
  post_parent: (ctx, key, a) => {
    a.post_parent = ctx.int(key);
  },
  post_mime_type: (ctx, key, a) => {
    a.post_mime_type = ctx.list(key);
  },
  menu_order: (ctx, key, a) => {
    a.menu_order = ctx.int(key);
  },
  has_password: (ctx, key, a) => {
    a.has_password = ctx.flag(key);
  },
  orderby: (ctx, key, a) => {
    const value = (ctx.string(key) ?? 'date').replace(/^ID$/, 'id');
    const allowed = [
      'date',
      'modified',
      'title',
      'name',
      'id',
      'author',
      'parent',
      'menu_order',
      'comment_count',
    ];
    if (!allowed.includes(value)) ctx.error(`--orderby can be ${allowed.join(', ')}.`);
    a.orderby = value as OrderBy;
  },
  order: (ctx, key, a) => {
    const value = (ctx.string(key) ?? 'DESC').toUpperCase();
    if (value !== 'ASC' && value !== 'DESC') ctx.error('--order can be ASC or DESC.');
    a.order = value as 'ASC' | 'DESC';
  },
};

async function loadPost(ctx: Context, id: number): Promise<Post> {
  const post = await ctx.kernel.posts.get(id);
  if (!post || post.type === 'revision') ctx.error(`There’s no post with the ID ${id}.`);
  return post;
}

const WRITE_FLAGS = [
  'post_title',
  'post_content',
  'post_excerpt',
  'post_status',
  'post_name',
  'post_author',
  'post_date',
  'post_date_gmt',
  'post_parent',
  'menu_order',
  'comment_status',
  'ping_status',
  'post_password',
  'post_category',
  'tags_input',
  'meta_input',
];

/**
 * The flags → kernel.posts input, validated by the REST schema and, with
 * --user, the REST API's permission rules (handle_status_param() & co).
 */
async function toInput(
  ctx: Context,
  type: string,
  content: string | undefined,
  existing?: Post,
): Promise<{ input: PostInput; meta?: Record<string, unknown>; tags?: string[] }> {
  const kernel = ctx.kernel;
  const postType = kernel.postTypes.get(type);
  if (!postType) ctx.error(`There’s no post type “${type}”.`);
  const body: Record<string, unknown> = {};
  const set = (flag: string, field: string, transform: (v: string) => unknown = (v) => v) => {
    const value = ctx.string(flag);
    if (value !== undefined) body[field] = transform(value);
  };
  const int = (v: string) => (/^-?\d+$/.test(v) ? Number(v) : v);
  set('post_title', 'title');
  set('post_excerpt', 'excerpt');
  set('post_status', 'status');
  set('post_name', 'slug');
  set('post_author', 'author', int);
  set('post_date', 'date');
  set('post_date_gmt', 'date_gmt');
  set('post_parent', 'parent', int);
  set('menu_order', 'menu_order', int);
  set('comment_status', 'comment_status');
  set('ping_status', 'ping_status');
  set('post_password', 'password');
  if (content !== undefined) body.content = content;
  else set('post_content', 'content');

  const parsed = postBodySchema().safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = String(issue?.path[0] ?? '');
    const flag =
      field === 'content' ||
      field === 'title' ||
      field === 'excerpt' ||
      field === 'status' ||
      field === 'password' ||
      field === 'author' ||
      field === 'parent' ||
      field === 'date' ||
      field === 'date_gmt'
        ? `post_${field}`
        : field === 'slug'
          ? 'post_name'
          : field;
    ctx.error(`--${flag}: ${issue?.message ?? 'This value isn’t valid.'}`);
  }
  const data = parsed.data;

  // The REST API's rules, for --user.
  const user = ctx.user;
  if (user) {
    if (data.author !== undefined && data.author !== (existing?.authorId ?? user.id)) {
      await ctx.require(
        postType.cap.edit_others_posts,
        undefined,
        `${user.login} isn’t allowed to post as someone else.`,
      );
    }
    if (data.status && ['publish', 'future', 'private'].includes(data.status)) {
      if (existing)
        await ctx.require(
          'publish_post',
          existing.id,
          `${user.login} isn’t allowed to publish this.`,
        );
      else
        await ctx.require(
          postType.cap.publish_posts,
          undefined,
          `${user.login} isn’t allowed to publish ${postType.label.toLowerCase()}.`,
        );
    }
  }
  if (data.author !== undefined) {
    const [author] = await kernel.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, data.author));
    if (!author) ctx.error(`There’s no user with the ID ${data.author} to be the author.`);
  }

  const timeZone = await siteTimeZone(kernel);
  let date: Date | undefined;
  if (data.date_gmt) date = parseRestDate(data.date_gmt, timeZone, true);
  else if (data.date) date = parseRestDate(data.date, timeZone, false);
  if ((data.date || data.date_gmt) && !date) {
    ctx.error('That date isn’t valid. Use the form 2026-10-28 13:45:00.');
  }

  const terms: Record<string, number[]> = {};
  const categories = ctx.list('post_category');
  if (categories) {
    const ids: number[] = [];
    for (const value of categories) {
      const term = /^\d+$/.test(value)
        ? await kernel.terms.get('category', Number(value))
        : (await kernel.terms.list('category', { slug: [value], perPage: 1 })).terms[0];
      if (!term) ctx.error(`There’s no category “${value}”.`);
      if (!(await ctx.can('assign_term', term.id)))
        ctx.error(`${user?.login} isn’t allowed to assign “${term.name}”.`);
      ids.push(term.id);
    }
    terms.category = ids;
  }

  let meta: Record<string, unknown> | undefined;
  const metaInput = ctx.string('meta_input');
  if (metaInput !== undefined) {
    try {
      meta = JSON.parse(metaInput) as Record<string, unknown>;
    } catch {
      meta = undefined;
    }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      ctx.error('--meta_input takes a JSON object, like --meta_input=\'{"key":"value"}\'.');
    }
  }

  return {
    input: {
      title: data.title,
      content: data.content,
      excerpt: data.excerpt,
      status: data.status,
      slug: data.slug,
      date,
      authorId: data.author ?? (existing ? undefined : (user?.id ?? null)),
      parentId: data.parent === undefined ? undefined : data.parent || null,
      menuOrder: data.menu_order,
      commentStatus: data.comment_status,
      pingStatus: data.ping_status,
      password: data.password,
      terms: Object.keys(terms).length ? terms : undefined,
      // kses for users without unfiltered_html, as in the admin; the command line itself is trusted.
      filterHtml: user ? !userCan(user, 'unfiltered_html') : false,
    },
    meta,
    tags: ctx.list('tags_input'),
  };
}

/** wp_set_post_tags(): tags by name, created when missing. */
async function setTags(ctx: Context, postId: number, names: string[]) {
  const ids: number[] = [];
  for (const name of names) {
    const found = (
      await ctx.kernel.terms.list('post_tag', { search: name, perPage: 100 })
    ).terms.find((t) => t.name.toLowerCase() === name.toLowerCase());
    const term = found ?? (await service(() => ctx.kernel.terms.insert('post_tag', { name })));
    ids.push(term.id);
  }
  await ctx.kernel.terms.setObjectTerms(postId, 'post_tag', ids);
}

async function afterWrite(
  ctx: Context,
  post: Post,
  meta?: Record<string, unknown>,
  tags?: string[],
) {
  if (tags) await setTags(ctx, post.id, tags);
  for (const [key, value] of Object.entries(meta ?? {}))
    await setMeta(ctx.kernel, post.id, key, value);
}

/** `<file>` or `-` for the content, as wp-cli reads it. */
async function contentFrom(ctx: Context, file: string | undefined): Promise<string | undefined> {
  if (file === undefined) return undefined;
  return ctx.readInput(file);
}

export const postCommands: CommandSpec[] = [
  {
    name: 'post list',
    shortdesc: 'Lists posts.',
    synopsis:
      '[--<field>=<value>] [--post_type=<post_type>] [--post_status=<post_status>] [--fields=<fields>] [--field=<field>] [--format=<format>]',
    options: {
      '<field>':
        'WP_Query arguments: posts_per_page, paged, offset, s, author, author__in, author__not_in, post__in, post__not_in, name, post_parent, post_mime_type, menu_order, has_password, orderby, order.',
      post_type: 'One or more post types, comma-separated, or any.',
      post_status:
        'One or more statuses, comma-separated, or any (everything but trash and auto-drafts).',
    },
    defaults: { post_type: 'post', post_status: 'any' },
    examples: [
      ['pressbase post list --post_status=publish --fields=ID,post_title', 'List published posts'],
      ['pressbase post list --post_type=page --format=ids', 'IDs of all pages'],
      ['pressbase post list --s=launch --format=count', 'Count posts mentioning “launch”'],
    ],
    needs: 'installed',
    async run(ctx) {
      const kernel = ctx.kernel;
      const types = ctx.list('post_type') ?? ['post'];
      for (const type of types) {
        if (type !== 'any' && !kernel.postTypes.get(type))
          ctx.error(`There’s no post type “${type}”.`);
      }
      const statuses = ctx.list('post_status') ?? ['any'];
      const args: QueryArgs = {
        post_type: types,
        post_status: statuses,
        posts_per_page: -1,
        orderby: 'date',
        order: 'DESC',
      };
      for (const key of Object.keys(ctx.assoc)) {
        if (
          [
            'post_type',
            'post_status',
            'format',
            'fields',
            'field',
            'user',
            'quiet',
            'yes',
            'data-dir',
            'debug',
          ].includes(key)
        )
          continue;
        const apply = QUERY_ARGS[key];
        if (!apply)
          return ctx.error(
            `--${key} isn’t a query argument “pressbase post list” understands. See “pressbase help post list”.`,
          );
        apply(ctx, key, args);
      }
      if (ctx.user && statuses.some((s) => s !== 'publish')) {
        for (const type of types.filter((t) => t !== 'any')) {
          const cap = kernel.postTypes.get(type)?.cap.edit_posts ?? 'edit_posts';
          await ctx.require(
            cap,
            undefined,
            `${ctx.user.login} can only list published posts. Add --post_status=publish.`,
          );
        }
      }
      const result = await queryPosts(kernel, args);
      const readable: Post[] = [];
      for (const post of result.posts) {
        if (post.status === 'publish' || (await ctx.can('read_post', post.id))) readable.push(post);
      }
      const timeZone = await siteTimeZone(kernel);
      ctx.formatItems(
        readable.map((p) => toRow(p, timeZone)),
        LIST_FIELDS,
        { all: FIELDS },
      );
    },
  },
  {
    name: 'post get',
    shortdesc: 'Shows a post.',
    synopsis: '<id> [--field=<field>] [--fields=<fields>] [--format=<format>]',
    options: { id: 'The post’s ID.' },
    examples: [
      ['pressbase post get 12', 'Show every field'],
      ['pressbase post get 12 --field=post_content > post.html', 'Save the content to a file'],
    ],
    needs: 'installed',
    async run(ctx) {
      const [id] = ctx.positionalIds();
      const post = await loadPost(ctx, id as number);
      if (post.status !== 'publish')
        await ctx.require(
          'read_post',
          post.id,
          `${ctx.user?.login} isn’t allowed to read this post.`,
        );
      ctx.formatItem(toRow(post, await siteTimeZone(ctx.kernel)), FIELDS, { all: FIELDS });
    },
  },
  {
    name: 'post create',
    shortdesc: 'Creates a post.',
    synopsis:
      '[<file>] [--post_type=<post_type>] [--post_title=<title>] [--post_content=<content>] [--post_excerpt=<excerpt>] [--post_status=<status>] [--post_name=<slug>] [--post_author=<user-id>] [--post_date=<date>] [--post_date_gmt=<date>] [--post_parent=<id>] [--menu_order=<number>] [--comment_status=<status>] [--ping_status=<status>] [--post_password=<password>] [--post_category=<categories>] [--tags_input=<tags>] [--meta_input=<json>] [--porcelain]',
    options: {
      file: 'Read the content from this file; - reads standard input. Wins over --post_content.',
      post_type: 'The post type.',
      post_status: 'draft, pending, private, publish or future.',
      post_category: 'Category IDs or slugs, comma-separated.',
      tags_input: 'Tag names, comma-separated; missing tags are created.',
      meta_input: 'Post meta as a JSON object.',
      post_date:
        'In the site’s time zone: 2026-10-28 13:45:00. A future date with publish schedules the post.',
      porcelain: 'Print only the new post’s ID.',
    },
    defaults: { post_type: 'post' },
    examples: [
      ['pressbase post create --post_title="Launch notes" --post_status=publish', 'Publish a post'],
      [
        'pressbase post create ./draft.html --post_title="From a file"',
        'Create a draft from a file',
      ],
      [
        'cat body.html | pressbase post create - --post_type=page --post_title=About --porcelain',
        'Create a page from standard input',
      ],
    ],
    needs: 'installed',
    async run(ctx) {
      const type = ctx.string('post_type') ?? 'post';
      const postType = ctx.kernel.postTypes.get(type);
      if (!postType) return ctx.error(`There’s no post type “${type}”.`);
      await ctx.require(
        postType.cap.create_posts,
        undefined,
        `${ctx.user?.login} isn’t allowed to create ${postType.label.toLowerCase()}.`,
      );
      const { input, meta, tags } = await toInput(
        ctx,
        type,
        await contentFrom(ctx, ctx.args[0]),
        undefined,
      );
      const post = await service(() => ctx.kernel.posts.insert(type, input));
      await afterWrite(ctx, post, meta, tags);
      if (ctx.flag('porcelain')) ctx.line(String(post.id));
      else ctx.success(`Created post ${post.id}.`);
    },
  },
  {
    name: 'post update',
    shortdesc: 'Updates one or more posts.',
    synopsis:
      '<id>... [<file>] [--post_title=<title>] [--post_content=<content>] [--post_excerpt=<excerpt>] [--post_status=<status>] [--post_name=<slug>] [--post_author=<user-id>] [--post_date=<date>] [--post_date_gmt=<date>] [--post_parent=<id>] [--menu_order=<number>] [--comment_status=<status>] [--ping_status=<status>] [--post_password=<password>] [--post_category=<categories>] [--tags_input=<tags>] [--meta_input=<json>]',
    options: {
      id: 'The posts’ IDs.',
      file: 'Read the content from this file; - reads standard input.',
    },
    examples: [
      ['pressbase post update 12 --post_status=draft', 'Unpublish a post'],
      ['pressbase post update 12 ./revised.html', 'Replace the content from a file'],
    ],
    needs: 'installed',
    async run(ctx) {
      // A last argument that isn't a number is the content file, as in wp-cli.
      const last = ctx.args[ctx.args.length - 1];
      const file = last !== undefined && !/^\d+$/.test(last) ? last : undefined;
      const ids = (file ? ctx.args.slice(0, -1) : ctx.args).map((v) => {
        if (!/^\d+$/.test(v)) ctx.error(`“${v}” isn’t a post ID.`);
        return Number(v);
      });
      if (!ids.length) ctx.error('Give the IDs of the posts to update.');
      const content = await contentFrom(ctx, file);
      if (content === undefined && !WRITE_FLAGS.some((f) => ctx.has(f))) {
        ctx.error('Give at least one field to change, such as --post_title=<title>.');
      }
      for (const id of ids) {
        const existing = await loadPost(ctx, id);
        await ctx.require('edit_post', id, `${ctx.user?.login} isn’t allowed to edit post ${id}.`);
        const { input, meta, tags } = await toInput(ctx, existing.type, content, existing);
        if (existing.status === 'trash' && input.status)
          await service(() => ctx.kernel.posts.untrash(id));
        const post = await service(() => ctx.kernel.posts.update(id, input));
        await afterWrite(ctx, post, meta, tags);
        ctx.success(`Updated post ${id}.`);
      }
    },
  },
  {
    name: 'post delete',
    shortdesc: 'Moves posts to the Trash, or deletes them with --force.',
    synopsis: '<id>... [--force]',
    options: {
      id: 'The posts’ IDs.',
      force: 'Delete permanently instead of moving to the Trash. Asks first, unless --yes.',
    },
    examples: [
      ['pressbase post delete 12', 'Move a post to the Trash'],
      [
        'pressbase post delete $(pressbase post list --post_status=trash --format=ids) --force --yes',
        'Empty the Trash',
      ],
    ],
    needs: 'installed',
    async run(ctx) {
      const ids = ctx.positionalIds();
      const force = ctx.flag('force');
      const posts: Post[] = [];
      for (const id of ids) {
        posts.push(await loadPost(ctx, id));
        await ctx.require(
          'delete_post',
          id,
          `${ctx.user?.login} isn’t allowed to delete post ${id}.`,
        );
      }
      if (force)
        await ctx.confirm(
          `Permanently delete ${posts.length === 1 ? `post ${ids[0]}` : `${posts.length} posts`}? This can’t be undone.`,
        );
      let failed = 0;
      for (const post of posts) {
        if (!force && post.type !== 'attachment') {
          if (post.status === 'trash') {
            ctx.warning(
              `Post ${post.id} is already in the Trash. Add --force to delete it permanently.`,
            );
            failed += 1;
            continue;
          }
          await service(() => ctx.kernel.posts.trash(post.id));
          ctx.success(`Trashed post ${post.id}.`);
          continue;
        }
        if (!force) {
          ctx.warning(
            `Post ${post.id} is an attachment, which has no Trash. Add --force to delete it.`,
          );
          failed += 1;
          continue;
        }
        if (post.type === 'attachment') await deleteAttachment(ctx.kernel, post);
        else await service(() => ctx.kernel.posts.delete(post.id));
        const sticky = await ctx.kernel.options.get<number[]>('sticky_posts', []);
        if (sticky.includes(post.id)) {
          await ctx.kernel.options.set(
            'sticky_posts',
            sticky.filter((id) => id !== post.id),
          );
        }
        ctx.success(`Deleted post ${post.id}.`);
      }
      if (failed) ctx.error(`${failed} of ${posts.length} posts weren’t deleted.`);
    },
  },
];
