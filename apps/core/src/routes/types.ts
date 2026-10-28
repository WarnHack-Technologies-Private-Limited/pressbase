import { Hono } from 'hono';
import { userCan } from '../auth/users';
import type { PostType } from '../content/post-types';
import type { Taxonomy } from '../content/taxonomies';
import { type AppEnv, restError } from '../http';

/**
 * /wp/v2/types, /wp/v2/taxonomies, /wp/v2/statuses — WordPress's
 * WP_REST_Post_Types_Controller, WP_REST_Taxonomies_Controller and
 * WP_REST_Post_Statuses_Controller. The admin reads labels and capabilities
 * from here, so plugin-registered types appear without admin changes.
 */

function prepareType(type: PostType, edit: boolean, taxonomies: string[]) {
  return {
    description: type.description,
    hierarchical: type.hierarchical,
    has_archive: false,
    name: type.label,
    slug: type.name,
    taxonomies,
    rest_base: type.restBase,
    rest_namespace: 'wp/v2',
    viewable: type.public,
    ...(edit
      ? {
          capabilities: type.cap,
          labels: { name: type.label, singular_name: type.singularLabel },
          supports: Object.fromEntries([...type.supports].map((s) => [s, true])),
        }
      : {}),
  };
}

function prepareTaxonomy(taxonomy: Taxonomy, edit: boolean) {
  return {
    name: taxonomy.label,
    slug: taxonomy.name,
    description: taxonomy.description,
    types: [...taxonomy.objectTypes],
    hierarchical: taxonomy.hierarchical,
    rest_base: taxonomy.restBase,
    rest_namespace: 'wp/v2',
    ...(edit
      ? {
          capabilities: taxonomy.cap,
          labels: { name: taxonomy.label, singular_name: taxonomy.singularLabel },
          visibility: { public: taxonomy.public, show_ui: true },
        }
      : {}),
  };
}

export function typeRoutes() {
  const app = new Hono<AppEnv>({ strict: false });

  app.get('/types', (c) => {
    const kernel = c.get('kernel');
    const edit = c.req.query('context') === 'edit';
    const types = kernel.postTypes.all().filter((t) => t.showInRest);
    return c.json(
      Object.fromEntries(
        types.map((t) => [
          t.name,
          prepareType(
            t,
            edit && userCan(c.get('user'), t.cap.edit_posts),
            kernel.taxonomies.forObjectType(t.name).filter((x) => x.showInRest).map((x) => x.name),
          ),
        ]),
      ),
    );
  });

  app.get('/types/:type', (c) => {
    const kernel = c.get('kernel');
    const type = kernel.postTypes.get(c.req.param('type'));
    if (!type?.showInRest) return restError(c, 404, 'rest_type_invalid', 'Invalid post type.');
    const edit = c.req.query('context') === 'edit' && userCan(c.get('user'), type.cap.edit_posts);
    return c.json(
      prepareType(
        type,
        edit,
        kernel.taxonomies.forObjectType(type.name).filter((x) => x.showInRest).map((x) => x.name),
      ),
    );
  });

  app.get('/taxonomies', (c) => {
    const kernel = c.get('kernel');
    const forType = c.req.query('type');
    const taxonomies = (
      forType ? kernel.taxonomies.forObjectType(forType) : kernel.taxonomies.all()
    ).filter((t) => t.showInRest);
    const edit = c.req.query('context') === 'edit';
    return c.json(
      Object.fromEntries(
        taxonomies.map((t) => [
          t.name,
          prepareTaxonomy(t, edit && userCan(c.get('user'), t.cap.manage_terms)),
        ]),
      ),
    );
  });

  app.get('/taxonomies/:taxonomy', (c) => {
    const taxonomy = c.get('kernel').taxonomies.get(c.req.param('taxonomy'));
    if (!taxonomy?.showInRest)
      return restError(c, 404, 'rest_taxonomy_invalid', 'Invalid taxonomy.');
    const edit =
      c.req.query('context') === 'edit' && userCan(c.get('user'), taxonomy.cap.manage_terms);
    return c.json(prepareTaxonomy(taxonomy, edit));
  });

  app.get('/statuses', (c) => {
    const kernel = c.get('kernel');
    // Non-public statuses are only listed for people who can edit something.
    const canEdit = kernel.postTypes
      .all()
      .some((t) => t.showInRest && userCan(c.get('user'), t.cap.edit_posts));
    const statuses = kernel.postStatuses.all().filter((s) => !s.internal && (s.public || canEdit));
    return c.json(
      Object.fromEntries(
        statuses.map((s) => [
          s.name,
          {
            name: s.label,
            private: s.private,
            protected: s.protected,
            public: s.public,
            queryable: s.public,
            show_in_list: s.showInAdminStatusList,
            slug: s.name,
            date_floating: s.name === 'draft' || s.name === 'pending',
          },
        ]),
      ),
    );
  });

  return app;
}
