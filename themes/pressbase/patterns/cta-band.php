<?php
/**
 * Title: Call to action band
 * Slug: pressbase/cta-band
 * Categories: pressbase, call-to-action
 * Keywords: cta, call to action, banner, sign up
 * Viewport Width: 1400
 * Description: A rounded ink band with a large headline and two buttons.
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:group {"metadata":{"name":"Call to action"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|60","bottom":"var:preset|spacing|60"}}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull" style="padding-top:var(--wp--preset--spacing--60);padding-bottom:var(--wp--preset--spacing--60)">
	<!-- wp:group {"align":"wide","className":"is-style-section-ink","style":{"border":{"radius":"var:preset|border-radius|xl"},"spacing":{"padding":{"top":"var:preset|spacing|70","bottom":"var:preset|spacing|70","left":"var:preset|spacing|50","right":"var:preset|spacing|50"},"blockGap":"var:preset|spacing|40"},"shadow":"var:preset|shadow|deep"},"layout":{"type":"constrained","contentSize":"760px"}} -->
	<div class="wp-block-group alignwide is-style-section-ink" style="border-radius:var(--wp--preset--border-radius--xl);padding-top:var(--wp--preset--spacing--70);padding-right:var(--wp--preset--spacing--50);padding-bottom:var(--wp--preset--spacing--70);padding-left:var(--wp--preset--spacing--50);box-shadow:var(--wp--preset--shadow--deep)">
		<!-- wp:heading {"textAlign":"center","fontSize":"xxx-large"} -->
		<h2 class="wp-block-heading has-text-align-center has-xxx-large-font-size"><?php echo wp_kses_post( __( 'Your next idea deserves a <em>beautiful</em> home.', 'pressbase' ) ); ?></h2>
		<!-- /wp:heading -->

		<!-- wp:paragraph {"align":"center","fontSize":"large"} -->
		<p class="has-text-align-center has-large-font-size"><?php esc_html_e( 'Start in minutes. Stay for years. Move on whenever you want, with everything you made.', 'pressbase' ); ?></p>
		<!-- /wp:paragraph -->

		<!-- wp:buttons {"layout":{"type":"flex","justifyContent":"center"},"style":{"spacing":{"margin":{"top":"var:preset|spacing|40"}}}} -->
		<div class="wp-block-buttons" style="margin-top:var(--wp--preset--spacing--40)">
			<!-- wp:button -->
			<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="#"><?php esc_html_e( 'Start for free', 'pressbase' ); ?></a></div>
			<!-- /wp:button -->

			<!-- wp:button {"className":"is-style-outline"} -->
			<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="#"><?php esc_html_e( 'Book a demo', 'pressbase' ); ?></a></div>
			<!-- /wp:button -->
		</div>
		<!-- /wp:buttons -->
	</div>
	<!-- /wp:group -->
</div>
<!-- /wp:group -->
