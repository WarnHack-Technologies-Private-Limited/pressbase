/**
 * get_file_data() (wordpress/wp-includes/functions.php): reads `Name: value`
 * headers from the first 8 KB of a theme's style.css or a pattern file.
 */

/** _cleanup_header_comment() */
function cleanup(value: string): string {
  return value.replace(/\s*(?:\*\/|\?>).*/, '').trim();
}

export function readFileHeaders<K extends string>(
  source: string,
  headers: Record<K, string>,
): Record<K, string> {
  const head = source.slice(0, 8192).replace(/\r/g, '\n');
  const out = {} as Record<K, string>;
  for (const [key, label] of Object.entries(headers) as [K, string][]) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`^(?:[ \\t]*<\\?php)?[ \\t/*#@]*${escaped}:(.*)$`, 'mi').exec(head);
    out[key] = match?.[1] ? cleanup(match[1]) : '';
  }
  return out;
}

/** WP_Theme::$file_headers */
export const THEME_HEADERS = {
  name: 'Theme Name',
  themeUri: 'Theme URI',
  description: 'Description',
  author: 'Author',
  authorUri: 'Author URI',
  version: 'Version',
  template: 'Template',
  status: 'Status',
  tags: 'Tags',
  textDomain: 'Text Domain',
  domainPath: 'Domain Path',
  requiresWp: 'Requires at least',
  testedUpTo: 'Tested up to',
  requiresPhp: 'Requires PHP',
  updateUri: 'Update URI',
  license: 'License',
} as const;

/** The pattern headers _register_theme_block_patterns() reads. */
export const PATTERN_HEADERS = {
  title: 'Title',
  slug: 'Slug',
  description: 'Description',
  viewportWidth: 'Viewport Width',
  inserter: 'Inserter',
  categories: 'Categories',
  keywords: 'Keywords',
  blockTypes: 'Block Types',
  postTypes: 'Post Types',
  templateTypes: 'Template Types',
} as const;
