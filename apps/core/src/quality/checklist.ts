import { type ParsedBlock, parseBlocks } from '@pressbase/blocks';
import type { ChangesetData } from '../changesets/service';
import type { Kernel } from '../kernel';
import { pageView, templatePartView } from '../site-building/abilities';
import { findEntry } from '../site-building/changeset';
import { globalStylesKey } from '../site-building/styles';
import { runCheckPage } from './ability';
import type { CheckRule, PageFinding } from './check-page';

/**
 * Studio's "Before you publish" checklist (#61): the quality checks
 * (`core/check-page`) run over every page and template part a changeset
 * changes, as the changeset leaves them and with its styles, sorted into
 * what a person acts on:
 *
 * - `placeholder`: text in [square brackets] and buttons that link nowhere;
 * - `image`: images not chosen yet;
 * - `check`: checks that failed (errors: contrast, alt text, headings…).
 *
 * Warnings that aren't placeholders (vague link text, raw colours) are left
 * to the inspector: the checklist is what stands between a draft and a site
 * a person would be glad to show. See docs/architecture/quality-checks.md.
 */

export type ChecklistKind = 'placeholder' | 'image' | 'check';

export interface ChecklistItem {
  /** The changeset entry the item is in: `page:12`, `page:catering`, `wp_template_part:header`. */
  key: string;
  kind: ChecklistKind;
  /** Where it is: a page (ID, or slug for a page the changeset adds) or a template part (slug). */
  page: number | string | null;
  part: string | null;
  /** The page's or part's title. */
  title: string;
  rule: CheckRule;
  severity: PageFinding['severity'];
  message: string;
  /** For placeholders: the text in brackets, or the button's label. */
  text: string;
  /** The block, by its path among the page's (or part's) blocks; null for the whole page. */
  block: PageFinding['block'];
}

export interface Checklist {
  items: ChecklistItem[];
  counts: Record<ChecklistKind, number>;
  /** What was checked, in order. */
  checked: { key: string; title: string; kind: 'page' | 'part' }[];
}

/** Rules that don't apply to a header or footer on its own: its headings sit around the page's. */
const PART_SKIPPED: ReadonlySet<CheckRule> = new Set([
  'heading_multiple_h1',
  'heading_no_h1',
  'heading_skipped',
]);

/** Which list a finding goes on, or none. */
export function checklistKind(finding: PageFinding): ChecklistKind | null {
  if (finding.rule === 'placeholder') {
    return finding.data?.reason === 'image' ? 'image' : 'placeholder';
  }
  return finding.severity === 'error' ? 'check' : null;
}

const isWhitespace = (block: ParsedBlock) =>
  block.blockName === null && block.innerHTML.trim() === '';

/**
 * A finding's path (as `parse_blocks()` counts, whitespace between blocks
 * included) as the block editor counts: whitespace isn't a block there.
 */
export function editorPath(blocks: ParsedBlock[], path: number[]): number[] {
  const out: number[] = [];
  let level = blocks;
  for (const index of path) {
    const block = level[index];
    if (!block) return out;
    out.push(level.slice(0, index).filter((b) => !isWhitespace(b)).length);
    level = block.innerBlocks;
  }
  return out;
}

/** Page order: by path, a block before the blocks inside it. */
function byPath(a: ChecklistItem, b: ChecklistItem): number {
  const x = a.block?.path ?? [];
  const y = b.block?.path ?? [];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return x.length - y.length;
}

/** Pages first (in the changeset's order), then template parts. */
function targets(data: ChangesetData) {
  const pages: { key: string; ref: { id?: number; slug?: string } }[] = [];
  const parts: { key: string; slug: string }[] = [];
  for (const key of Object.keys(data)) {
    const [type, id = ''] = key.split(/:(.*)/s);
    if (type === 'page' && id) {
      pages.push({ key, ref: /^\d+$/.test(id) ? { id: Number(id) } : { slug: id } });
    } else if (type === 'wp_template_part' && id) {
      const value = data[key]?.value as { content?: unknown } | null;
      // A part going back to the theme's file (`source: theme`) is the theme's design: not checked.
      if (typeof value?.content === 'string') parts.push({ key, slug: id.split('//').pop() ?? id });
    }
  }
  return { pages, parts };
}

/** The checklist for a changeset's entries (`data`). Reads only. */
export async function changesetChecklist(kernel: Kernel, data: ChangesetData): Promise<Checklist> {
  const stylesheet = await kernel.themes.activeStylesheet();
  const styles = findEntry(data, [globalStylesKey(stylesheet)])?.value;
  const globalStyles = styles
    ? { version: 3, isGlobalStylesUserThemeJSON: true, ...styles }
    : undefined;
  const items: ChecklistItem[] = [];
  const checked: Checklist['checked'] = [];
  const { pages, parts } = targets(data);

  const run = async (
    content: string,
    where: { key: string; title: string; page: number | string | null; part: string | null },
    skip?: ReadonlySet<CheckRule>,
  ) => {
    const result = await runCheckPage(kernel, {
      content,
      ...(globalStyles ? { global_styles: globalStyles } : {}),
    });
    const blocks = parseBlocks(content);
    const found: ChecklistItem[] = [];
    for (const finding of result.findings) {
      if (skip?.has(finding.rule)) continue;
      const kind = checklistKind(finding);
      if (!kind) continue;
      found.push({
        ...where,
        kind,
        rule: finding.rule,
        severity: finding.severity,
        message: finding.message,
        text: typeof finding.data?.text === 'string' ? finding.data.text : '',
        block: finding.block
          ? { ...finding.block, path: editorPath(blocks, finding.block.path) }
          : null,
      });
    }
    items.push(...found.sort(byPath));
  };

  for (const { key, ref } of pages) {
    let view: Awaited<ReturnType<typeof pageView>>;
    try {
      view = await pageView(kernel, data, ref);
    } catch {
      continue; // A page gone from the site since: nothing to check.
    }
    const page = view.id ?? view.slug;
    checked.push({ key, title: view.title, kind: 'page' });
    await run(view.content, { key, title: view.title, page, part: null });
  }
  for (const { key, slug } of parts) {
    let view: Awaited<ReturnType<typeof templatePartView>>;
    try {
      view = await templatePartView(kernel, data, slug);
    } catch {
      continue;
    }
    checked.push({ key, title: view.title, kind: 'part' });
    await run(view.content, { key, title: view.title, page: null, part: slug }, PART_SKIPPED);
  }

  const counts: Record<ChecklistKind, number> = { placeholder: 0, image: 0, check: 0 };
  for (const item of items) counts[item.kind]++;
  return { items, counts, checked };
}
