import { serializeBlockAttributes } from '@pressbase/blocks';
import { maybeUnserialize } from './php-serialize';
import type { ImportPost } from './records';

/**
 * Classic menus → block menus. A WordPress site's classic menus arrive as a
 * `nav_menu` term per menu and a `nav_menu_item` post per item, with the
 * item's target in `_menu_item_*` meta. Block themes show `wp_navigation`
 * posts instead, so each menu becomes one, made of navigation-link and
 * navigation-submenu blocks the way WP_Classic_To_Block_Menu_Converter::convert()
 * builds them (wp-includes/class-wp-classic-to-block-menu-converter.php).
 * See docs/architecture/navigation.md.
 */

export interface ClassicMenuItem {
  /** The nav_menu_item's ID in the source. */
  id: number;
  /** The menu's slug (the item's nav_menu term). */
  menu: string;
  order: number;
  /** The item's own label; empty means "use the target's title". */
  title: string;
  description: string;
  /** The link's title attribute (post_excerpt). */
  attrTitle: string;
  /** `_menu_item_type`: post_type, taxonomy, custom, post_type_archive. */
  type: string;
  /** `_menu_item_object`: page, post, category, post_tag, custom… */
  object: string;
  /** `_menu_item_object_id`, in the source. */
  objectId: number;
  /** `_menu_item_menu_item_parent`: the parent item's ID in the source, 0 at the top. */
  parent: number;
  target: string;
  classes: string[];
  xfn: string;
  url: string;
}

/** Reads a nav_menu_item post. Returns undefined when it belongs to no menu. */
export function menuItemFromPost(post: ImportPost): ClassicMenuItem | undefined {
  const menu = post.terms.find((t) => t.domain === 'nav_menu')?.slug;
  if (!menu) return undefined;
  const meta = new Map(post.postmeta.map((m) => [m.key, m.value]));
  const classes = maybeUnserialize(meta.get('_menu_item_classes') ?? '');
  return {
    id: post.post_id,
    menu,
    order: post.menu_order,
    title: post.post_title,
    description: post.post_content.trim(),
    attrTitle: post.post_excerpt,
    type: meta.get('_menu_item_type') ?? 'custom',
    object: meta.get('_menu_item_object') ?? 'custom',
    objectId: Number(meta.get('_menu_item_object_id') ?? 0) || 0,
    parent: Number(meta.get('_menu_item_menu_item_parent') ?? 0) || 0,
    target: meta.get('_menu_item_target') ?? '',
    classes: Array.isArray(classes)
      ? classes.filter((c): c is string => typeof c === 'string' && c !== '')
      : [],
    xfn: meta.get('_menu_item_xfn') ?? '',
    url: meta.get('_menu_item_url') ?? '',
  };
}

/** Where an item points on this site, or undefined when its target wasn't imported. */
export interface ResolvedTarget {
  /** The new post or term ID (none for custom links). */
  id?: number;
  url: string;
  /** The target's title, used when the item has no label of its own. */
  title: string;
}

export interface ConvertedMenu {
  content: string;
  /** Items left out because their target isn't on this site. */
  missing: ClassicMenuItem[];
  /** How many links the menu has. */
  links: number;
}

/**
 * Builds the block markup of one menu. `resolve` gives each item's target on
 * this site. An item whose target is missing is left out and its children
 * move up to its place, so nothing below it is lost.
 */
export function convertClassicMenu(
  items: ClassicMenuItem[],
  resolved: Map<number, ResolvedTarget | undefined>,
): ConvertedMenu {
  const byId = new Map(items.map((item) => [item.id, item]));
  const missing = items.filter((item) => !resolved.get(item.id));
  const present = (id: number) => Boolean(byId.get(id) && resolved.get(id));
  /** The nearest ancestor that is in the menu, or 0. */
  const effectiveParent = (item: ClassicMenuItem): number => {
    let parent = item.parent;
    const seen = new Set<number>();
    while (parent && !present(parent) && !seen.has(parent)) {
      seen.add(parent);
      parent = byId.get(parent)?.parent ?? 0;
    }
    return parent && present(parent) ? parent : 0;
  };

  const children = new Map<number, ClassicMenuItem[]>();
  for (const item of items) {
    if (!resolved.get(item.id)) continue;
    const parent = effectiveParent(item);
    const list = children.get(parent) ?? [];
    list.push(item);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.order - b.order || a.id - b.id);

  let links = 0;
  const render = (parent: number, depth: number, trail: Set<number>): string[] =>
    (children.get(parent) ?? []).flatMap((item) => {
      if (trail.has(item.id)) return [];
      const target = resolved.get(item.id) as ResolvedTarget;
      links += 1;
      const kind = (item.type || 'custom').replace(/_/g, '-');
      const attrs: Record<string, unknown> = {
        label: item.title || target.title,
        ...(item.object && item.object !== 'custom' ? { type: item.object } : {}),
        ...(target.id ? { id: target.id } : {}),
        url: target.url,
        kind,
        ...(item.description ? { description: item.description } : {}),
        ...(item.target === '_blank' ? { opensInNewTab: true } : {}),
        ...(item.xfn ? { rel: item.xfn } : {}),
        ...(item.attrTitle ? { title: item.attrTitle } : {}),
        ...(item.classes.length ? { className: item.classes.join(' ') } : {}),
      };
      const nested = render(item.id, depth + 1, new Set([...trail, item.id]));
      if (nested.length && depth < 4) {
        if (depth === 0) attrs.isTopLevelItem = true;
        return [
          `<!-- wp:navigation-submenu ${serializeBlockAttributes(attrs)} -->`,
          ...nested,
          '<!-- /wp:navigation-submenu -->',
        ];
      }
      if (depth === 0) attrs.isTopLevelLink = true;
      // Deeper than the block's maxNestingLevel (5): the rest follow as siblings.
      return [`<!-- wp:navigation-link ${serializeBlockAttributes(attrs)} /-->`, ...nested];
    });

  return { content: render(0, 0, new Set()).join('\n'), missing, links };
}
