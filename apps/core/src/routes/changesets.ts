import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { CurrentUser } from '../auth/users';
import { ChangesetError, ChangesetValidationError, OPEN_STATUSES } from '../changesets/service';
import { parseRestDate, toGmtString } from '../content/dates';
import type { Post } from '../content/posts';
import { type AppEnv, invalidParams, readJson, restError } from '../http';
import type { Kernel } from '../kernel';
import { authStatus, rawText } from './rest-util';

/**
 * Changesets over REST (v0.8, ADR 0022), under /pressbase/v1/changesets.
 * WordPress saves changesets through admin-ajax (`customize_save`); Studio
 * uses these routes instead, with the Customizer's error codes:
 *
 * - GET    /changesets             — your open changesets, newest first;
 * - POST   /changesets             — start one (or get your open one), with optional entries;
 * - GET    /changesets/{uuid}      — one changeset;
 * - POST   /changesets/{uuid}      — set entries (`null` removes one), title, status, date;
 * - POST   /changesets/{uuid}/publish — write every entry, in one transaction;
 * - DELETE /changesets/{uuid}      — discard (trash) it.
 *
 * Invalid or forbidden entries answer 400 `transaction_fail` with
 * `data.entries` — per entry `{ code, message }` — and nothing is saved.
 * See docs/architecture/changesets.md.
 */

const entries = z.record(z.string(), z.unknown());

const createBody = z.object({ title: rawText.optional(), entries: entries.optional() }).strict();

const updateBody = z
  .object({
    title: rawText.optional(),
    entries: entries.optional(),
    status: z.enum(OPEN_STATUSES).optional(),
    /** When to publish (save_changeset_post()'s `date_gmt`), with status `future`. */
    date_gmt: z
      .string()
      .transform((value, ctx) => {
        const date = parseRestDate(value, 'UTC', true);
        if (!date) ctx.addIssue({ code: 'custom', message: 'Invalid date.' });
        return date ?? new Date(Number.NaN);
      })
      .optional(),
  })
  .strict();

async function item(kernel: Kernel, changeset: Post) {
  const home = (await kernel.options.get<string>('home', '')).replace(/\/+$/, '');
  const data = kernel.changesets.data(changeset);
  const self = `${home}/wp-json/pressbase/v1/changesets/${changeset.slug}`;
  return {
    id: changeset.id,
    uuid: changeset.slug,
    status: changeset.status,
    date_gmt: toGmtString(changeset.date),
    modified_gmt: toGmtString(changeset.modified),
    author: changeset.authorId ?? 0,
    title: changeset.title,
    entries: data,
    count: Object.keys(data).length,
    preview_link: `${home}/?changeset_uuid=${changeset.slug}`,
    _links: { self: [{ href: self }], publish: [{ href: `${self}/publish` }] },
  };
}

function failure(c: Context<AppEnv>, error: unknown) {
  if (error instanceof ChangesetValidationError) {
    return restError(c, 400, 'transaction_fail', error.message, { entries: error.entries });
  }
  if (error instanceof ChangesetError) return restError(c, error.status, error.code, error.message);
  throw error;
}

export function changesetsRoutes() {
  const app = new Hono<AppEnv>({ strict: false });

  const forbidden = (c: Context<AppEnv>) =>
    restError(
      c,
      authStatus(c),
      'rest_cannot_edit',
      'Sorry, you are not allowed to edit this changeset.',
    );

  /** The changeset in the URL, when the user may manage it. */
  const load = async (
    c: Context<AppEnv>,
  ): Promise<{ changeset: Post; user: CurrentUser } | Response> => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    if (!user) return forbidden(c);
    const changeset = await kernel.changesets.find(c.req.param('uuid') ?? '');
    if (!changeset || changeset.status === 'trash') {
      return restError(c, 404, 'changeset_invalid_uuid', 'Invalid changeset UUID.');
    }
    if (!kernel.changesets.canManage(changeset, user)) return forbidden(c);
    return { changeset, user };
  };

  app.get('/', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    if (!user || !kernel.changesets.canCreate(user)) return forbidden(c);
    const open = await kernel.changesets.openFor(user.id);
    return c.json(await Promise.all(open.map((post) => item(kernel, post))));
  });

  app.post('/', async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    if (!user || !kernel.changesets.canCreate(user)) {
      return restError(
        c,
        authStatus(c),
        'rest_cannot_create',
        'Sorry, you are not allowed to create changesets.',
      );
    }
    const body = createBody.safeParse((await readJson(c)) ?? {});
    if (!body.success) return invalidParams(c, body.error);
    const { changeset, created } = await kernel.changesets.create(user, body.data.title ?? '');
    try {
      const saved = body.data.entries
        ? await kernel.changesets.update(changeset, user, { entries: body.data.entries })
        : changeset;
      return c.json(await item(kernel, saved), created ? 201 : 200);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.get('/:uuid', async (c) => {
    const loaded = await load(c);
    if (loaded instanceof Response) return loaded;
    return c.json(await item(c.get('kernel'), loaded.changeset));
  });

  app.post('/:uuid', async (c) => {
    const loaded = await load(c);
    if (loaded instanceof Response) return loaded;
    const body = updateBody.safeParse((await readJson(c)) ?? {});
    if (!body.success) return invalidParams(c, body.error);
    const kernel = c.get('kernel');
    try {
      const { date_gmt: date, ...rest } = body.data;
      const saved = await kernel.changesets.update(loaded.changeset, loaded.user, {
        ...rest,
        ...(date ? { date } : {}),
      });
      return c.json(await item(kernel, saved));
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post('/:uuid/publish', async (c) => {
    const loaded = await load(c);
    if (loaded instanceof Response) return loaded;
    const kernel = c.get('kernel');
    try {
      const published = await kernel.changesets.publish(loaded.changeset, loaded.user);
      return c.json(await item(kernel, published));
    } catch (error) {
      if (error instanceof ChangesetValidationError || error instanceof ChangesetError) {
        return failure(c, error);
      }
      console.error(error);
      return restError(
        c,
        500,
        'changeset_post_save_failure',
        'The changes could not be published. Nothing was changed.',
      );
    }
  });

  app.delete('/:uuid', async (c) => {
    const loaded = await load(c);
    if (loaded instanceof Response) return loaded;
    const kernel = c.get('kernel');
    try {
      const trashed = await kernel.changesets.discard(loaded.changeset);
      return c.json(await item(kernel, trashed));
    } catch (error) {
      return failure(c, error);
    }
  });

  return app;
}
