import {
  type BlockAttributes,
  escAttr,
  escHtml,
  escUrl,
  getBlockWrapperAttributes,
} from '@pressbase/blocks';
import { sanitizePostTitle } from '../../content/sanitize';
import type { Term } from '../../content/terms';
import { type CoreBlock, type SiteInfo, siteInfo, taxonomyQueryVar, termLink } from '../helpers';

/**
 * core/categories (render_block_core_categories(), wordpress/wp-includes/blocks/categories.php)
 * and core/tag-cloud (render_block_core_tag_cloud(), tag-cloud.php), with the
 * markup of wp_list_categories() / Walker_Category, wp_dropdown_categories() /
 * Walker_CategoryDropdown and wp_tag_cloud() / wp_generate_tag_cloud()
 * (wordpress/wp-includes/category-template.php).
 */

const ALL = 1000;

/**
 * get_terms() with hide_empty: with `hierarchical`, an empty term stays when
 * one of its descendants has posts, as WordPress does.
 */
function visibleTerms(terms: Term[], hideEmpty: boolean, hierarchical: boolean): Term[] {
  if (!hideEmpty) return terms;
  if (!hierarchical) return terms.filter((t) => t.count > 0);
  const byParent = new Map<number, Term[]>();
  for (const t of terms) byParent.set(t.parent, [...(byParent.get(t.parent) ?? []), t]);
  const busy = (t: Term, depth = 0): boolean =>
    t.count > 0 || (depth < 50 && (byParent.get(t.id) ?? []).some((c) => busy(c, depth + 1)));
  return terms.filter((t) => busy(t));
}

/** Walker_Category::start_el() … end_el(), with start_lvl() for children. */
function listItems(
  site: SiteInfo,
  terms: Term[],
  parent: number,
  depth: number,
  options: { hierarchical: boolean; showCount: boolean },
): string {
  let out = '';
  const level = options.hierarchical ? terms.filter((t) => t.parent === parent) : terms;
  for (const term of level) {
    const name = escAttr(term.name);
    if (name === '') continue;
    let link = `<a href="${escUrl(termLink(site, term))}">${name}</a>`;
    if (options.showCount) link += ` (${term.count.toLocaleString('en-US')})`;
    out += `\t<li class="${escAttr(`cat-item cat-item-${term.id}`)}">${link}\n`;
    if (options.hierarchical && depth < 50) {
      const children = listItems(site, terms, term.id, depth + 1, options);
      if (children) {
        const indent = '\t'.repeat(depth);
        out += `${indent}<ul class='children'>\n${children}${indent}</ul>\n`;
      }
    }
    out += '</li>\n';
  }
  return out;
}

/** Walker_CategoryDropdown, depth-first when hierarchical. */
function dropdownOptions(
  terms: Term[],
  parent: number,
  depth: number,
  options: { hierarchical: boolean; showCount: boolean },
): string {
  let out = '';
  const level = options.hierarchical ? terms.filter((t) => t.parent === parent) : terms;
  for (const term of level) {
    out += `\t<option class="level-${depth}" value="${escAttr(term.slug)}">${'&nbsp;'.repeat(depth * 3)}${escHtml(term.name)}`;
    if (options.showCount) out += `&nbsp;&nbsp;(${term.count.toLocaleString('en-US')})`;
    out += '</option>\n';
    if (options.hierarchical && depth < 50) {
      out += dropdownOptions(terms, term.id, depth + 1, options);
    }
  }
  return out;
}

/** The inline script WordPress adds after a navigation dropdown. */
export function dropdownScript(
  id: string,
  home: string,
  mode: 'term' | 'url',
  source: string,
): string {
  const exports = JSON.stringify([id, home]).replace(/</g, '\\u003C').replace(/>/g, '\\u003E');
  const navigate =
    mode === 'term'
      ? `if ( dropdown.value && dropdown.value !== '-1' && dropdown instanceof HTMLSelectElement ) {
					const url = new URL( homeUrl );
					url.searchParams.set( dropdown.name, dropdown.value );
					location.href = url.href;
				}`
      : `if ( dropdown.value ) {
					location.href = dropdown.value;
				}`;
  return `<script>
( ( [ dropdownId, homeUrl ] ) => {
		const dropdown = document.getElementById( dropdownId );
		function onSelectChange() {
			setTimeout( () => {
				if ( 'escape' === dropdown.dataset.lastkey ) {
					return;
				}
				${navigate}
			}, 250 );
		}
		function onKeyUp( event ) {
			if ( 'Escape' === event.key ) {
				dropdown.dataset.lastkey = 'escape';
			} else {
				delete dropdown.dataset.lastkey;
			}
		}
		function onClick() {
			delete dropdown.dataset.lastkey;
		}
		dropdown.addEventListener( 'keyup', onKeyUp );
		dropdown.addEventListener( 'click', onClick );
		dropdown.addEventListener( 'change', onSelectChange );
	} )( ${exports} );
//# sourceURL=${source}
</script>
`;
}

export async function renderCategories(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const { kernel } = block.services;
  const taxonomyName = String(attributes.taxonomy || 'category');
  const taxonomy = kernel.taxonomies.get(taxonomyName);
  if (!taxonomy) return '';
  const site = await siteInfo(kernel);

  const hierarchical = Boolean(attributes.showHierarchy) && taxonomy.hierarchical;
  const showCount = Boolean(attributes.showPostCounts);
  const { terms: all } = await kernel.terms.list(taxonomyName, { orderby: 'name', perPage: ALL });
  let terms = visibleTerms(all, !attributes.showEmpty, hierarchical);
  if (attributes.showOnlyTopLevel) terms = terms.filter((t) => t.parent === 0);
  // Children of hidden terms have nowhere to hang in a hierarchical list.
  if (hierarchical) {
    const ids = new Set(terms.map((t) => t.id));
    terms = terms.filter((t) => t.parent === 0 || ids.has(t.parent));
  }

  const type = attributes.displayAsDropdown ? 'dropdown' : 'list';
  const wrapper = getBlockWrapperAttributes(block, {
    class: `wp-block-categories-${type} wp-block-categories-taxonomy-${taxonomyName}`,
  });

  if (type === 'dropdown') {
    const id = block.uniqueId('wp-block-categories-');
    const showLabel = attributes.showLabel === false ? ' screen-reader-text' : '';
    const label =
      typeof attributes.label === 'string' && attributes.label
        ? sanitizePostTitle(attributes.label)
        : escHtml(taxonomy.label);
    const none = `Select ${escHtml(taxonomy.singularLabel)}`;
    let select = `<select  name='${escAttr(taxonomyQueryVar(taxonomyName))}' id='${escAttr(id)}' class='postform'>\n`;
    select += terms.length
      ? `\t<option value='-1'>${none}</option>\n${dropdownOptions(terms, 0, 0, { hierarchical, showCount })}`
      : `\t<option value='-1' selected='selected'>${none}</option>\n`;
    select += '</select>\n';
    select += dropdownScript(id, site.home, 'term', 'build_dropdown_script_block_core_categories');
    return `<div ${wrapper}><label class="wp-block-categories__label${showLabel}" for="${escAttr(id)}">${label}</label>${select}</div>`;
  }

  const items = terms.length
    ? listItems(site, terms, 0, 0, { hierarchical, showCount })
    : `<li class="cat-item-none">No ${escHtml(taxonomy.label.toLowerCase())}</li>`;
  return `<ul ${wrapper}>${items}</ul>`;
}

/** default_topic_count_scale() */
const scale = (count: number) => Math.round(Math.log10(count + 1) * 100);

/** PHP prints floats with 14 significant digits. */
const phpFloat = (n: number) => String(Number(n.toPrecision(14)));

export async function renderTagCloud(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const { kernel } = block.services;
  const taxonomy = String(attributes.taxonomy || 'post_tag');
  if (!kernel.taxonomies.get(taxonomy)) return '';
  const site = await siteInfo(kernel);

  const smallestRaw = String(attributes.smallestFontSize ?? '8pt');
  const unit = /^[0-9.]+([a-z%]+)$/i.exec(smallestRaw)?.[1] ?? 'pt';
  const smallest = Number.parseFloat(smallestRaw) || 0;
  const largest = Number.parseFloat(String(attributes.largestFontSize ?? '22pt')) || 0;
  const number = Math.max(1, Math.min(100, Number(attributes.numberOfTags) || 45));

  // wp_tag_cloud(): the most used terms, then sorted by name.
  const { terms } = await kernel.terms.list(taxonomy, {
    hideEmpty: true,
    orderby: 'count',
    order: 'desc',
    perPage: number,
  });
  terms.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

  let cloud = '';
  if (terms.length) {
    const counts = terms.map((t) => scale(t.count));
    const min = Math.min(...counts);
    const spread = Math.max(...counts) - min || 1;
    const fontSpread = largest - smallest < 0 ? 1 : largest - smallest;
    const step = fontSpread / spread;
    const showCount = Boolean(attributes.showTagCounts);
    const ariaLabel = showCount || fontSpread !== 0;
    cloud = terms
      .map((term, i) => {
        const items = `${term.count.toLocaleString('en-US')} ${term.count === 1 ? 'item' : 'items'}`;
        const size = phpFloat(smallest + ((counts[i] ?? min) - min) * step);
        const label = ariaLabel ? ` aria-label="${escAttr(term.name)} (${escAttr(items)})"` : '';
        const count = showCount ? `<span class="tag-link-count"> (${term.count})</span>` : '';
        return `<a href="${escUrl(termLink(site, term))}" class="${escAttr(`tag-cloud-link tag-link-${term.id} tag-link-position-${i + 1}`)}" style="font-size: ${escAttr(size + unit)};"${label}>${escHtml(term.name)}${count}</a>`;
      })
      .join('\n');
  }

  if (!cloud) {
    // Placeholder for the editor only (wp_is_serving_rest_request()).
    if (!block.services.rest) return '';
    cloud = 'There&#8217;s no content to show here yet.';
  }
  return `<p ${getBlockWrapperAttributes(block)}>${cloud}</p>`;
}
