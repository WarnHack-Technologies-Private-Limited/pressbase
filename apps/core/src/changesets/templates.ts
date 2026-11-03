import { z } from 'zod';
import { type CurrentUser, userCan } from '../auth/users';
import type { Post } from '../content/posts';
import { sanitizePostContent, sanitizePostTitle } from '../content/sanitize';
import type { Kernel } from '../kernel';
import { rawText } from '../routes/rest-util';
import {
  type BlockTemplate,
  canEditTemplates,
  getBlockTemplate,
  parseTemplateId,
  saveBlockTemplate,
  TEMPLATE_PART_AREA_TAXONOMY,
  TEMPLATE_PART_AREA_UNCATEGORIZED,
  TEMPLATE_PART_POST_TYPE,
  type TemplateType,
  THEME_TAXONOMY,
} from '../themes/templates';
import { type ChangesetEntityHandler, ChangesetEntryError } from './entities';

/**
 * Templates and template parts in a changeset (v0.8, ADR 0021 and 0022):
 * `wp_template:{id}` and `wp_template_part:{id}`, where `{id}` is the REST
 * id (`pressbase//header`) or the slug alone (`header`, in the active theme).
 *
 * Publishing saves through saveBlockTemplate(), as POST /wp/v2/templates/{id}
 * does: the first edit of a theme file makes its customised copy (meta
 * `origin: theme`, the file's title and area), later edits update the copy
 * and keep a revision. A slug with neither file nor copy makes a new template.
 * A preview lays the edit over the copy, or shows the copy-to-be with a
 * negative ID, so the renderer's ordinary post lookups find it.
 */

const templateValue = z
  .object({
    content: rawText.optional(),
    title: rawText.optional(),
    description: rawText.optional(),
    /** Template parts only: header, footer, navigation-overlay, uncategorized. */
    area: z.string().max(40).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Give at least one field to change.' });

export type TemplateEntryValue = z.infer<typeof templateValue>;

const SLUG = /^[a-z0-9_-]{1,190}$/;

/** The entry id as `{stylesheet}//{slug}` in the active theme, or undefined when it names another theme. */
async function templateId(kernel: Kernel, id: string): Promise<string | undefined> {
  const stylesheet = (await kernel.themes.active()).info.stylesheet;
  const parts = parseTemplateId(id);
  if (parts) return parts.theme === stylesheet && SLUG.test(parts.slug) ? id : undefined;
  return SLUG.test(id) ? `${stylesheet}//${id}` : undefined;
}

export function templateEntityHandler(
  type: TemplateType,
): ChangesetEntityHandler<TemplateEntryValue> {
  const resolve = async (kernel: Kernel, id: string) => {
    const full = await templateId(kernel, id);
    if (!full) {
      throw new ChangesetEntryError(
        'rest_template_not_found',
        'Templates in a changeset belong to the active theme.',
      );
    }
    return { id: full, template: await getBlockTemplate(kernel, full, type) };
  };

  return {
    type,
    // With the other posts, before global styles and options.
    order: 10,

    async validate(kernel, id, value, user) {
      await resolve(kernel, id);
      const parsed = templateValue.safeParse(value);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new ChangesetEntryError(
          'rest_invalid_param',
          `${issue?.path.join('.') || 'value'}: ${issue?.message ?? 'Invalid value.'}`,
        );
      }
      const v = { ...parsed.data };
      if (type !== TEMPLATE_PART_POST_TYPE) delete v.area;
      if (!userCan(user, 'unfiltered_html')) {
        if (v.title !== undefined) v.title = sanitizePostTitle(v.title);
        if (v.description !== undefined) v.description = sanitizePostTitle(v.description);
        if (v.content !== undefined) v.content = sanitizePostContent(v.content);
      }
      return v;
    },

    async canEdit(_kernel, _id, _value, user) {
      return canEditTemplates(user);
    },

    async apply(kernel, id, value, author: CurrentUser | null) {
      const { id: full, template } = await resolve(kernel, id);
      const slug = full.split('//')[1];
      await saveBlockTemplate(
        kernel,
        type,
        template ? full : null,
        { ...value, ...(template ? {} : { slug }) },
        { userId: author?.id, filterHtml: !userCan(author, 'unfiltered_html') },
      );
    },

    async preview(kernel, id, value, preview) {
      const { id: full, template } = await resolve(kernel, id);
      if (template?.source === 'custom' && template.wpId) {
        const post = preview.posts.get(template.wpId) ?? (await kernel.posts.get(template.wpId));
        if (!post) return;
        preview.posts.set(post.id, {
          ...post,
          ...(value.content !== undefined ? { content: value.content } : {}),
          ...(value.title !== undefined ? { title: value.title } : {}),
          ...(value.description !== undefined ? { excerpt: value.description } : {}),
          modified: new Date(),
        });
        return;
      }
      // The customised copy (or new template) publishing will create.
      const [stylesheet, slug] = full.split('//') as [string, string];
      const now = new Date();
      const post: Post = {
        id: preview.nextId(),
        authorId: preview.user.id,
        date: now,
        modified: now,
        content: value.content ?? fileValue(template, 'content'),
        title: value.title ?? fileValue(template, 'title'),
        excerpt: value.description ?? fileValue(template, 'description'),
        status: 'publish',
        commentStatus: 'closed',
        pingStatus: 'closed',
        password: '',
        slug,
        contentFiltered: '',
        parentId: null,
        guid: '',
        menuOrder: 0,
        type,
        mimeType: '',
        commentCount: 0,
      };
      const terms: Record<string, string[]> = { [THEME_TAXONOMY]: [stylesheet] };
      if (type === TEMPLATE_PART_POST_TYPE) {
        terms[TEMPLATE_PART_AREA_TAXONOMY] = [
          value.area ?? template?.area ?? TEMPLATE_PART_AREA_UNCATEGORIZED,
        ];
      }
      preview.created.set(post.id, { post, terms });
    },
  };
}

const fileValue = (template: BlockTemplate | null, key: 'content' | 'title' | 'description') =>
  template?.[key] ?? '';
