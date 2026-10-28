import { regenerateImageSizes } from '@pressbase/core/src/media/service';
import { RESIZABLE_IMAGE_TYPES } from '@pressbase/core/src/media/mime';
import { schema } from '@pressbase/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { CommandSpec } from '../command';
import { service } from './shared';

/** `pressbase media regenerate`: wp-cli's media-command, on regenerateImageSizes(). */
export const mediaCommands: CommandSpec[] = [
  {
    name: 'media regenerate',
    shortdesc: 'Remakes image sub-sizes, after the sizes in Settings → Media change.',
    synopsis: '[<attachment-id>...] [--only-missing] [--skip-delete]',
    options: {
      'attachment-id': 'Only these attachments. Left out, every image (asks first, unless --yes).',
      'only-missing': 'Only images missing a size or one of its files.',
      'skip-delete': 'Keep files of sizes that are no longer used.',
    },
    examples: [
      ['pressbase media regenerate --yes', 'Regenerate every image'],
      ['pressbase media regenerate 42 43', 'Regenerate two images'],
      ['pressbase media regenerate --only-missing --yes', 'Fill in missing sizes only'],
    ],
    needs: 'installed',
    async run(ctx) {
      const { posts } = schema;
      const ids = ctx.args.length ? ctx.positionalIds() : undefined;
      const images = await ctx.kernel.db
        .select()
        .from(posts)
        .where(
          and(
            eq(posts.type, 'attachment'),
            ids ? inArray(posts.id, ids) : inArray(posts.mimeType, [...RESIZABLE_IMAGE_TYPES]),
          ),
        )
        .orderBy(asc(posts.id));
      for (const id of ids ?? []) {
        if (!images.some((p) => p.id === id)) ctx.error(`There’s no attachment with the ID ${id}.`);
      }
      if (!images.length) {
        ctx.success('There are no images to regenerate.');
        return;
      }
      if (!ids) await ctx.confirm(`Regenerate the sizes of all ${images.length} images?`);
      let done = 0;
      let skipped = 0;
      for (const [i, image] of images.entries()) {
        const position = `${i + 1}/${images.length}`;
        if (!(await ctx.can('edit_post', image.id))) {
          ctx.warning(`${position} ${ctx.user?.login} isn’t allowed to edit attachment ${image.id}.`);
          continue;
        }
        try {
          const result = await service(() =>
            regenerateImageSizes(ctx.kernel, image, {
              onlyMissing: ctx.flag('only-missing'),
              skipDelete: ctx.flag('skip-delete'),
            }),
          );
          if (!result.regenerated) {
            skipped += 1;
            ctx.log(`${position} No missing sizes for "${image.title}" (ID ${image.id}).`);
          } else {
            ctx.log(`${position} Regenerated thumbnails for "${image.title}" (ID ${image.id}).`);
          }
          done += 1;
        } catch (error) {
          ctx.warning(`${position} ${(error as Error).message}`);
        }
      }
      const message = `Regenerated ${done - skipped} of ${images.length} images${skipped ? ` (${skipped} already complete)` : ''}.`;
      if (done < images.length) ctx.error(message);
      ctx.success(message);
    },
  },
];
