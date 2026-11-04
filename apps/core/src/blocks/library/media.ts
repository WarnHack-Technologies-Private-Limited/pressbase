import type { BlockAttributes } from '@pressbase/blocks';
import { stylesheetFromRules } from '@pressbase/theme-json';
import { currentPage } from '../../frontend/page';

/**
 * The parts of WordPress's Image and Gallery render callbacks that change
 * what a page shows. Both blocks save their own HTML; these adjust it.
 */

/**
 * render_block_core_image() (wordpress/wp-includes/blocks/image.php): an
 * image without a source renders as nothing, so a pattern's image that
 * hasn't been chosen yet isn't a broken image on the page. (Lightbox and
 * block bindings aren't ported.)
 */
export function renderImage(_attributes: BlockAttributes, content: string): string {
  const img = /<img\b[^>]*>/i.exec(content)?.[0];
  if (!img) return '';
  const src = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(img);
  if (!src || !(src[1] ?? src[2] ?? src[3] ?? '')) return '';
  return content;
}

/** block_core_gallery_get_column_gap_value() */
function columnGap(gap: unknown, fallback: string): string {
  let value = gap;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    value = (value as Record<string, unknown>).left ?? fallback;
  }
  let text = typeof value === 'string' ? value : '';
  if (text && /[\\(&=}]|\/\*/.test(text)) text = '';
  if (text.includes('var:preset|spacing|')) {
    const slug = text.slice(text.lastIndexOf('|') + 1).replace(/[^a-z0-9]+/gi, '-');
    text = `var(--wp--preset--spacing--${slug.toLowerCase()})`;
  }
  const column = text !== '' ? text : fallback;
  return column === '0' ? '0px' : column;
}

/**
 * block_core_gallery_render() (wordpress/wp-includes/blocks/gallery.php):
 * a unique class and `--wp--style--unstable-gallery-gap` for it, the gap the
 * gallery's stylesheet subtracts when it sizes the images. Without it a
 * theme whose block gap is wider than the stylesheet's 16px default gets one
 * column fewer than the block asks for. (Global Gallery styles, random
 * order and the lightbox aren't ported.)
 */
export function renderGallery(attributes: BlockAttributes, content: string): string {
  const page = currentPage();
  if (!page) return content;
  const open = /^(\s*<[a-z][a-z0-9]*\b[^>]*?\bclass\s*=\s*")([^"]*)"/i.exec(content);
  if (!open) return content;
  const className = page.uniqueId('wp-block-gallery-');
  const fallback =
    'var( --wp--style--gallery-gap-default, var( --gallery-block--gutter-size, var( --wp--style--block-gap, 0.5em ) ) )';
  const style = attributes.style as { spacing?: Record<string, unknown> } | undefined;
  const hasGap =
    !!style?.spacing && typeof style.spacing === 'object' && 'blockGap' in style.spacing;
  const gap = columnGap(hasGap ? style?.spacing?.blockGap : fallback, fallback);
  page.addSupportStyle(
    stylesheetFromRules([
      {
        selector: `.wp-block-gallery.${className}`,
        declarations: { '--wp--style--unstable-gallery-gap': gap },
      },
    ]),
  );
  return `${open[1]}${open[2]} ${className}"${content.slice(open[0].length)}`;
}
