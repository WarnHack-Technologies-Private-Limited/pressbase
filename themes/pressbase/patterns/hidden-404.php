<?php
/**
 * Title: Page not found
 * Slug: pressbase/hidden-404
 * Inserter: no
 * Description: The 404 page: a large serif "404" over the animated gradient, a message, a search field and a way home.
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:group {"align":"full","className":"is-style-gradient","style":{"spacing":{"padding":{"top":"var:preset|spacing|80","bottom":"var:preset|spacing|80"},"blockGap":"var:preset|spacing|40"}},"layout":{"type":"constrained","contentSize":"640px"}} -->
<div class="wp-block-group alignfull is-style-gradient" style="padding-top:var(--wp--preset--spacing--80);padding-bottom:var(--wp--preset--spacing--80)">
	<!-- wp:paragraph {"align":"center","className":"is-style-pill"} -->
	<p class="has-text-align-center is-style-pill"><?php echo esc_html_x( 'Error 404', '404 error label', 'pressbase' ); ?></p>
	<!-- /wp:paragraph -->

	<!-- wp:heading {"textAlign":"center","level":1,"fontSize":"display"} -->
	<h1 class="wp-block-heading has-text-align-center has-display-font-size"><?php echo wp_kses_post( _x( 'This page took <em>another</em> road.', '404 error message', 'pressbase' ) ); ?></h1>
	<!-- /wp:heading -->

	<!-- wp:paragraph {"align":"center","fontSize":"large"} -->
	<p class="has-text-align-center has-large-font-size"><?php echo esc_html_x( 'The page you are looking for does not exist, or it has moved. Try a search, or start again from the home page.', '404 error message', 'pressbase' ); ?></p>
	<!-- /wp:paragraph -->

	<!-- wp:pattern {"slug":"pressbase/hidden-search"} /-->

	<!-- wp:buttons {"layout":{"type":"flex","justifyContent":"center"}} -->
	<div class="wp-block-buttons">
		<!-- wp:button {"className":"is-style-outline"} -->
		<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="/"><?php esc_html_e( 'Back to the home page', 'pressbase' ); ?></a></div>
		<!-- /wp:button -->
	</div>
	<!-- /wp:buttons -->
</div>
<!-- /wp:group -->
