<?php
/**
 * Title: Big statement
 * Slug: pressbase/statement
 * Categories: pressbase, text, about
 * Keywords: quote, statement, manifesto, mission
 * Viewport Width: 1400
 * Description: One large italic serif sentence, centred, with a short attribution.
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:group {"metadata":{"name":"Statement"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|80","bottom":"var:preset|spacing|80"},"blockGap":"var:preset|spacing|40"}},"layout":{"type":"constrained","contentSize":"980px"}} -->
<div class="wp-block-group alignfull" style="padding-top:var(--wp--preset--spacing--80);padding-bottom:var(--wp--preset--spacing--80)">
	<!-- wp:paragraph {"align":"center","className":"is-style-reveal","fontSize":"xxx-large","fontFamily":"platypi","style":{"typography":{"lineHeight":"1.15","fontStyle":"italic","fontWeight":"500","letterSpacing":"-0.02em"}}} -->
	<p class="has-text-align-center is-style-reveal has-platypi-font-family has-xxx-large-font-size" style="font-style:italic;font-weight:500;letter-spacing:-0.02em;line-height:1.15"><?php esc_html_e( 'We believe the web is better when publishing is calm, fast and owned by the people who write.', 'pressbase' ); ?></p>
	<!-- /wp:paragraph -->

	<!-- wp:paragraph {"align":"center","textColor":"muted","fontSize":"small"} -->
	<p class="has-text-align-center has-muted-color has-text-color has-small-font-size"><?php esc_html_e( 'From our founding notes', 'pressbase' ); ?></p>
	<!-- /wp:paragraph -->
</div>
<!-- /wp:group -->
