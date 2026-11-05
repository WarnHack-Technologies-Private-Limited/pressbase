import { Hono } from 'hono';
import { AbilityError } from '../abilities/registry';
import { type AppEnv, requireCapability, restError } from '../http';
import { changesetChecklist } from '../quality/checklist';
import { changesetFor, entriesOf } from '../site-building/changeset';

/**
 * `GET /pressbase/v1/studio/checklist` (#61), `edit_pages`: Studio's
 * "Before you publish" checklist for the person's changeset
 * (`?changeset_uuid=`, else their open one): the quality checks over every
 * page and template part in it, sorted into placeholders, images to choose
 * and checks that failed, each with the block it's about. Reads only.
 * See docs/architecture/quality-checks.md#before-you-publish.
 */
export function studioChecklistRoutes() {
  const app = new Hono<AppEnv>({ strict: false });
  app.use(requireCapability('edit_pages'));

  app.get('/', async (c) => {
    const kernel = c.get('kernel');
    const uuid = c.req.query('changeset_uuid') || undefined;
    try {
      const changeset = await changesetFor(kernel, c.get('user'), uuid, false);
      const checklist = await changesetChecklist(kernel, entriesOf(kernel, changeset));
      return c.json({ changeset_uuid: changeset?.slug ?? null, ...checklist });
    } catch (error) {
      if (!(error instanceof AbilityError)) throw error;
      return restError(c, (error.status ?? 400) as 400, error.code, error.message);
    }
  });

  return app;
}
