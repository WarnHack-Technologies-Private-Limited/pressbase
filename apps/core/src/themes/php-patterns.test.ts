import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluatePatternFile, loadPhpPattern, phpSprintf } from './php-patterns';

const context = {
  templateUri: 'https://example.com/wp-content/themes/parent',
  stylesheetUri: 'https://example.com/wp-content/themes/child',
};
const PATTERNS = path.resolve(import.meta.dirname, '../../../../themes/pressbase/patterns');

const file = (body: string, headers = 'Title: Test\n * Slug: theme/test') =>
  `<?php\n/**\n * ${headers}\n */\n\n?>\n${body}`;

describe('PHP pattern loader', () => {
  it('reads the headers WordPress reads', () => {
    const result = loadPhpPattern(
      file(
        '<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->',
        'Title: Hero\n * Slug: theme/hero\n * Categories: banner, featured\n * Keywords: intro, hello\n * Block Types: core/template-part/header\n * Post Types: page, wp_template\n * Template Types: front-page\n * Viewport width: 1400\n * Inserter: no\n * Description: A big hello.',
      ),
      context,
    );
    expect(result).toEqual({
      ok: true,
      pattern: {
        slug: 'theme/hero',
        title: 'Hero',
        description: 'A big hello.',
        content: '<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->',
        categories: ['banner', 'featured'],
        keywords: ['intro', 'hello'],
        blockTypes: ['core/template-part/header'],
        postTypes: ['page', 'wp_template'],
        templateTypes: ['front-page'],
        viewportWidth: 1400,
        inserter: false,
      },
    });
  });

  it('converts translation, escaping, URL and printf calls to text', () => {
    const out = evaluatePatternFile(
      [
        `<h1><?php esc_html_e( 'Tom & "Jerry"', 'theme' ); ?></h1>`,
        `<p><?php echo esc_html_x( 'It\\'s <b>', 'context', 'theme' ); ?></p>`,
        `<img alt="<?php esc_attr_e( 'A "quote"', 'theme' ); ?>" src="<?php echo esc_url( get_template_directory_uri() ); ?>/assets/a.webp"/>`,
        `<img src="<?php echo esc_url( get_template_directory_uri() . '/assets/b.webp' ); ?>"/>`,
        `<p><?php
          printf(
            /* translators: %s: WordPress link. */
            esc_html__( 'Designed with %s', 'theme' ),
            '<a href="' . esc_url( __( 'https://wordpress.org', 'theme' ) ) . '" rel="nofollow">WordPress</a>'
          );
        ?></p>`,
        `<p><?php echo wp_kses_post( _x( 'Hi <em>you</em><script>x</script>', 'c', 'theme' ) ); ?></p>`,
        `<p><?php _e( "Two\\tparts", 'theme' ); echo sprintf( '%2$s %1$s %%', 'a', 'b' ); ?></p>`,
      ].join('\n'),
      context,
    );
    expect(out).toBe(
      [
        '<h1>Tom &amp; &quot;Jerry&quot;</h1>',
        '<p>It&#039;s &lt;b&gt;</p>',
        '<img alt="A &quot;quote&quot;" src="https://example.com/wp-content/themes/parent/assets/a.webp"/>',
        '<img src="https://example.com/wp-content/themes/parent/assets/b.webp"/>',
        '<p>Designed with <a href="https://wordpress.org" rel="nofollow">WordPress</a></p>',
        '<p>Hi <em>you</em></p>',
        '<p>Two\tpartsb a %</p>',
      ].join('\n'),
    );
  });

  it('swallows the newline after a closing tag, as PHP does', () => {
    expect(evaluatePatternFile("a<?php echo 'b'; ?>\nc", context)).toBe('abc');
  });

  it.each([
    ['a variable', '<?php echo $title; ?>'],
    ['an unknown function', '<?php echo get_bloginfo( "name" ); ?>'],
    ['interpolation', '<?php echo "Hello {$name}"; ?>'],
    ['code with side effects', "<?php include 'other.php'; ?>"],
    ['a short echo tag', '<?= 1 ?>'],
    ['shell execution', '<?php echo `ls`; ?>'],
    ['a function definition', '<?php function x() {} ?>'],
    ['missing arguments', "<?php echo sprintf( '%s %s', 'a' ); ?>"],
  ])('skips a pattern using %s', (_label, body) => {
    const result = loadPhpPattern(file(body), context);
    expect(result.ok).toBe(false);
  });

  it('refuses patterns without a slug or title', () => {
    expect(loadPhpPattern(file('x', 'Title: No slug'), context)).toEqual({
      ok: false,
      reason: 'the "Slug" header is missing',
    });
    expect(loadPhpPattern(file('x', 'Slug: theme/x'), context).ok).toBe(false);
  });

  it('loads every pattern of the Pressbase theme', () => {
    const files = readdirSync(PATTERNS).filter((f) => f.endsWith('.php'));
    const failed = files
      .map(
        (f) => [f, loadPhpPattern(readFileSync(path.join(PATTERNS, f), 'utf8'), context)] as const,
      )
      .filter(([, result]) => !result.ok);
    expect(failed).toEqual([]);
    expect(files.length).toBeGreaterThan(20);
    // sprintf(), wp_kses_post(), a comment and esc_url( get_template_directory_uri() ).
    const powered = loadPhpPattern(
      readFileSync(path.join(PATTERNS, 'hidden-powered-by.php'), 'utf8'),
      context,
    );
    expect(powered.ok && powered.pattern.content).toContain(
      'Powered by <a href="https://github.com/WarnHack-Technologies-Private-Limited/pressbase" rel="nofollow">Pressbase</a>',
    );
    expect(powered.ok && powered.pattern.content).toContain(
      `src="${context.templateUri}/assets/images/pressbase-mark.svg"`,
    );
  });

  it('formats like PHP sprintf', () => {
    expect(phpSprintf('%s is %d%%', ['x', '42abc'])).toBe('x is 42%');
  });
});
