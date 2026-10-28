import {
  type BlockAttributes,
  escAttr,
  escHtml,
  escUrl,
  getBlockWrapperAttributes,
} from '@pressbase/blocks';
import { schema } from '@pressbase/db';
import { and, count, eq, sql } from 'drizzle-orm';
import { addCacheTags, CacheTag } from '../../cache/tags';
import { type CoreBlock, monthLink, type SiteInfo, siteInfo } from '../helpers';
import { monthName } from '../php-date';
import { dropdownScript } from './terms';

/**
 * core/archives — render_block_core_archives() (wordpress/wp-includes/blocks/archives.php)
 * with the markup of wp_get_archives() and get_archives_link()
 * (wordpress/wp-includes/general-template.php). Monthly and yearly archives;
 * other types fall back to monthly.
 */

interface ArchiveRow {
  year: number;
  month: number;
  posts: number;
}

async function archiveRows(
  block: CoreBlock,
  site: SiteInfo,
  yearly: boolean,
): Promise<ArchiveRow[]> {
  const { kernel } = block.services;
  const { posts } = schema;
  await kernel.posts.publishDue();
  addCacheTags(CacheTag.posts('post'));
  // post_date is the site's local time in WordPress; group on the local calendar.
  const local = sql`(${posts.date} at time zone ${site.timeZone})`;
  return kernel.db
    .select({
      year: sql<number>`extract(year from ${local})::int`.mapWith(Number),
      month: (yearly ? sql<number>`1` : sql<number>`extract(month from ${local})::int`).mapWith(
        Number,
      ),
      posts: count(),
    })
    .from(posts)
    .where(and(eq(posts.type, 'post'), eq(posts.status, 'publish')))
    .groupBy(sql`1`, sql`2`)
    .orderBy(sql`1 desc`, sql`2 desc`);
}

/** get_archives_link() */
function archivesLink(url: string, text: string, format: 'html' | 'option', after: string): string {
  const href = escUrl(url);
  return format === 'option'
    ? `\t<option value='${href}'> ${text} ${after}</option>\n`
    : `\t<li><a href='${href}'>${text}</a>${after}</li>\n`;
}

export async function renderArchives(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const site = await siteInfo(block.services.kernel);
  const yearly = attributes.type === 'yearly';
  const showCount = Boolean(attributes.showPostCounts);
  const rows = await archiveRows(block, site, yearly);
  const format = attributes.displayAsDropdown ? 'option' : 'html';

  let archives = '';
  for (const row of rows) {
    const url = yearly
      ? site.pretty
        ? `${site.home}/${row.year}/`
        : `${site.home}/?m=${row.year}`
      : monthLink(site, row.year, row.month);
    const text = yearly ? String(row.year) : `${monthName(row.month, site.dateWords)} ${row.year}`;
    archives += archivesLink(url, text, format, showCount ? `&nbsp;(${row.posts})` : '');
  }

  if (attributes.displayAsDropdown) {
    const wrapper = getBlockWrapperAttributes(block, { class: 'wp-block-archives-dropdown' });
    const id = block.uniqueId('wp-block-archives-');
    const label = yearly ? 'Select Year' : 'Select Month';
    const showLabel = attributes.showLabel === false ? ' screen-reader-text' : '';
    let content = `<label for="${id}" class="wp-block-archives__label${showLabel}">${escHtml('Archives')}</label>
		<select id="${escAttr(id)}" name="archive-dropdown">
		<option value="">${escHtml(label)}</option>${archives}</select>`;
    content += dropdownScript(id, site.home, 'url', 'block_core_archives_build_dropdown_script');
    return `<div ${wrapper}>${content}</div>`;
  }

  const wrapper = getBlockWrapperAttributes(block, { class: 'wp-block-archives-list' });
  if (!archives) return `<div ${wrapper}>No archives to show.</div>`;
  return `<ul ${wrapper}>${archives}</ul>`;
}
