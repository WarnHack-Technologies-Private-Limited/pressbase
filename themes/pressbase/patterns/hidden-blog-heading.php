<?php
/**
 * Title: Blog heading
 * Slug: pressbase/hidden-blog-heading
 * Inserter: no
 * Description: The heading of the blog's list of posts, over the animated gradient.
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:group {"align":"full","className":"is-style-gradient","style":{"spacing":{"padding":{"top":"var:preset|spacing|70","bottom":"var:preset|spacing|60"},"blockGap":"var:preset|spacing|30"}},"layout":{"type":"constrained","contentSize":"760px"}} -->
<div class="wp-block-group alignfull is-style-gradient" style="padding-top:var(--wp--preset--spacing--70);padding-bottom:var(--wp--preset--spacing--60)">
	<!-- wp:paragraph {"align":"center","className":"is-style-pill"} -->
	<p class="has-text-align-center is-style-pill"><?php esc_html_e( 'Journal', 'pressbase' ); ?></p>
	<!-- /wp:paragraph -->

	<!-- wp:heading {"textAlign":"center","level":1,"fontSize":"display"} -->
	<h1 class="wp-block-heading has-text-align-center has-display-font-size"><?php echo wp_kses_post( __( 'Notes, essays and <em>news</em>.', 'pressbase' ) ); ?></h1>
	<!-- /wp:heading -->

	<!-- wp:paragraph {"align":"center","fontSize":"large"} -->
	<p class="has-text-align-center has-large-font-size"><?php esc_html_e( 'What we are building, what we are learning, and the stories behind both.', 'pressbase' ); ?></p>
	<!-- /wp:paragraph -->
</div>
<!-- /wp:group -->
