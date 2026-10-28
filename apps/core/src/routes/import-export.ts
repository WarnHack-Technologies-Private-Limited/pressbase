import { schema } from '@pressbase/db';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { stream } from 'hono/streaming';
import { z } from 'zod';
import { userCan } from '../auth/users';
import { type AppEnv, invalidParams, readJson, requireCapability, restError } from '../http';
import {
  type ExportOptions,
  exportablePostTypes,
  exportFilename,
  generateWxr,
} from '../import-export/exporter';
import {
  createImportSession,
  deleteImportSession,
  getSession,
  type ImportSession,
  ImportSessionError,
  listImportSessions,
  maxImportBytes,
  sessionStatus,
  startImportSession,
} from '../import-export/service';
import type { Kernel } from '../kernel';

/**
 * Tools → Import and Tools → Export.
 *
 * /pressbase/v1/import (capability `import`), the WordPress Importer's steps:
 *   POST   /                upload a WXR file (raw body) → what's in it, its authors
 *   GET    /                recent imports
 *   GET    /{id}            an import: summary, status, progress, report
 *   POST   /{id}/start      { authors, fetch_attachments } → queued as a job
 *   DELETE /{id}            cancel (before it runs) and delete the upload
 *
 * /pressbase/v1/export (capability `export`), wp-admin/export.php:
 *   GET    /                what the form offers: types, authors, categories, statuses, months
 *   GET    /download        the WXR file, streamed (export_wp())
 */

function sessionError(c: Context<AppEnv>, error: unknown) {
  if (error instanceof ImportSessionError)
    return restError(c, error.status, error.code, error.message);
  throw error;
}

async function present(kernel: Kernel, session: ImportSession) {
  const status = await sessionStatus(kernel, session);
  const { summary } = session;
  return {
    id: session.id,
    filename: session.filename,
    size: session.size,
    created: session.createdAt,
    started: session.startedAt ?? null,
    site: {
      title: summary.site.title,
      url: summary.site.base_blog_url || summary.site.link,
      wxr_version: summary.site.wxr_version,
    },
    authors: summary.authors.map((a) => ({
      login: a.author_login,
      email: a.author_email,
      display_name: a.author_display_name || a.author_login,
    })),
    counts: {
      posts: summary.posts,
      terms: summary.terms,
      comments: summary.comments,
      items: summary.items,
    },
    // Post types in the file this site doesn't have: their items will be skipped.
    unsupported_types: Object.keys(summary.posts).filter(
      (type) => type !== 'nav_menu_item' && (type === 'revision' || !kernel.postTypes.get(type)),
    ),
    options: session.options
      ? { authors: session.options.authors, fetch_attachments: session.options.fetchAttachments }
      : null,
    ...status,
  };
}

const authorChoice = z.discriminatedUnion('action', [
  z.object({ action: z.literal('map'), user_id: z.number().int().positive() }),
  z.object({ action: z.literal('create'), login: z.string().trim().max(60).optional() }),
]);

const startBody = z.object({
  authors: z.record(z.string(), authorChoice).default({}),
  fetch_attachments: z.boolean().default(false),
});

export function importRoutes() {
  const app = new Hono<AppEnv>();
  app.use(requireCapability('import'));

  // WP_Import::handle_upload() / wp_import_handle_upload(): the body is the file.
  app.post('/', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    if (!user) return restError(c, 401, 'rest_forbidden', 'Sorry, you are not allowed to do that.');
    const length = Number(c.req.header('content-length') ?? 0);
    const max = maxImportBytes(kernel);
    if (length > max) {
      return restError(
        c,
        413,
        'import_file_too_big',
        `This file is too big. Export files must be smaller than ${Math.round(max / 1024 / 1024)} MB.`,
      );
    }
    const body = c.req.raw.body;
    if (!body) {
      return restError(c, 400, 'import_empty_file', 'Choose the .xml file from Tools → Export.');
    }
    const disposition = c.req.header('content-disposition') ?? '';
    const filename = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1] ?? 'import.xml';
    try {
      const session = await createImportSession(kernel, {
        body,
        filename: decodeURIComponent(filename),
        userId: user.id,
      });
      // The users posts can be given to (WordPress's wp_dropdown_users()).
      const users = await kernel.db
        .select({ id: schema.users.id, login: schema.users.login, name: schema.users.displayName })
        .from(schema.users)
        .orderBy(asc(schema.users.displayName))
        .limit(500);
      return c.json(
        {
          ...(await present(kernel, session)),
          users,
          can_create_users: userCan(user, 'create_users'),
          can_fetch_attachments: userCan(user, 'upload_files'),
        },
        201,
      );
    } catch (error) {
      return sessionError(c, error);
    }
  });

  app.get('/', async (c) => {
    const kernel = c.get('kernel');
    const sessions = await listImportSessions(kernel);
    return c.json(await Promise.all(sessions.map((s) => present(kernel, s))));
  });

  app.get('/:id', async (c) => {
    const kernel = c.get('kernel');
    try {
      return c.json(await present(kernel, await getSession(kernel, c.req.param('id'))));
    } catch (error) {
      return sessionError(c, error);
    }
  });

  app.post('/:id/start', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    if (!user) return restError(c, 401, 'rest_forbidden', 'Sorry, you are not allowed to do that.');
    const parsed = startBody.safeParse((await readJson(c)) ?? {});
    if (!parsed.success) return invalidParams(c, parsed.error);
    const authors = Object.fromEntries(
      Object.entries(parsed.data.authors).map(([login, choice]) => [
        login,
        choice.action === 'map'
          ? { action: 'map' as const, userId: choice.user_id }
          : { action: 'create' as const, login: choice.login },
      ]),
    );
    if (
      Object.values(authors).some((a) => a.action === 'create') &&
      !userCan(user, 'create_users')
    ) {
      return restError(
        c,
        403,
        'import_cannot_create_users',
        'Sorry, you are not allowed to create users.',
      );
    }
    if (parsed.data.fetch_attachments && !userCan(user, 'upload_files')) {
      return restError(
        c,
        403,
        'import_cannot_upload',
        'Sorry, you are not allowed to upload files.',
      );
    }
    try {
      const session = await startImportSession(kernel, c.req.param('id'), {
        authors,
        fetchAttachments: parsed.data.fetch_attachments,
        userId: user.id,
      });
      return c.json(await present(kernel, session), 202);
    } catch (error) {
      return sessionError(c, error);
    }
  });

  app.delete('/:id', async (c) => {
    const kernel = c.get('kernel');
    try {
      await deleteImportSession(kernel, c.req.param('id'));
      return c.json({ deleted: true });
    } catch (error) {
      return sessionError(c, error);
    }
  });

  return app;
}

const month = z
  .string()
  .regex(/^\d{4}-\d{2}(-\d{2})?$/, 'Use a date like 2026-10.')
  .optional()
  .or(z.literal('').transform(() => undefined));

const downloadQuery = z.object({
  content: z.string().max(20).default('all'),
  author: z.coerce.number().int().nonnegative().optional(),
  category: z.string().max(200).optional(),
  start_date: month,
  end_date: month,
  status: z.string().max(20).optional(),
});

export function exportRoutes() {
  const app = new Hono<AppEnv>();
  app.use(requireCapability('export'));

  /** What wp-admin/export.php offers: types, and per type the authors, statuses and months. */
  app.get('/', async (c) => {
    const kernel = c.get('kernel');
    const timeZone = await kernel.options.get<string>('timezone_string', 'UTC');
    const p = schema.posts;
    const types = exportablePostTypes(kernel).map((name) => kernel.postTypes.get(name));
    const months = await kernel.db
      .select({
        type: p.type,
        month: sql<string>`to_char(${p.date} at time zone ${timeZone}, 'YYYY-MM')`,
      })
      .from(p)
      .where(ne(p.status, 'auto-draft'))
      .groupBy(p.type, sql`2`)
      .orderBy(sql`2 desc`);
    const authorRows = await kernel.db
      .selectDistinct({ type: p.type, id: schema.users.id, name: schema.users.displayName })
      .from(p)
      .innerJoin(schema.users, eq(schema.users.id, p.authorId))
      .where(and(inArray(p.type, ['post', 'page', 'attachment']), ne(p.status, 'auto-draft')));
    const { terms: categories } = await kernel.terms.list('category', {
      perPage: 1000,
      orderby: 'name',
    });
    return c.json({
      types: types
        .filter((t) => t !== undefined)
        .map((t) => ({ name: t.name, label: t.label, builtin: t.builtin })),
      authors: Object.fromEntries(
        ['post', 'page', 'attachment'].map((type) => [
          type,
          authorRows
            .filter((r) => r.type === type)
            .map((r) => ({ id: r.id, name: r.name }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        ]),
      ),
      categories: categories.map((t) => ({ id: t.id, name: t.name, count: t.count })),
      statuses: kernel.postStatuses
        .all()
        .filter((s) => !s.internal)
        .map((s) => ({ name: s.name, label: s.label })),
      months: Object.fromEntries(
        ['post', 'page', 'attachment'].map((type) => [
          type,
          months.filter((m) => m.type === type).map((m) => m.month),
        ]),
      ),
    });
  });

  // wp-admin/export.php?download: export_wp() streamed as a file.
  app.get('/download', async (c) => {
    const kernel = c.get('kernel');
    const parsed = downloadQuery.safeParse(c.req.query());
    if (!parsed.success) return invalidParams(c, parsed.error);
    const q = parsed.data;
    const args = (await kernel.hooks.applyFilters('export_args', {
      content: q.content === 'posts' ? 'post' : q.content === 'pages' ? 'page' : q.content,
      author: q.author || undefined,
      category: q.category
        ? /^\d+$/.test(q.category)
          ? Number(q.category)
          : q.category
        : undefined,
      start_date: q.start_date,
      end_date: q.end_date,
      status: q.status || undefined,
    } satisfies ExportOptions)) as ExportOptions;
    const filename = await exportFilename(kernel);
    c.header('Content-Description', 'File Transfer');
    c.header('Content-Disposition', `attachment; filename="${filename.replace(/["\\\r\n]/g, '')}"`);
    c.header('Content-Type', 'text/xml; charset=UTF-8');
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    return stream(c, async (out) => {
      for await (const chunk of generateWxr(kernel, args)) {
        if (out.aborted) break;
        await out.write(chunk);
      }
    });
  });

  return app;
}
