<?php
/**
 * Title: Newsletter and contact
 * Slug: pressbase/newsletter
 * Categories: pressbase, call-to-action, contact
 * Keywords: newsletter, subscribe, contact, email, feed
 * Viewport Width: 1400
 * Description: A glass card inviting readers to follow along by feed or email, over the animated gradient.
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:group {"metadata":{"name":"Newsletter"},"align":"full","className":"is-style-gradient","style":{"spacing":{"padding":{"top":"var:preset|spacing|70","bottom":"var:preset|spacing|70"}}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull is-style-gradient" style="padding-top:var(--wp--preset--spacing--70);padding-bottom:var(--wp--preset--spacing--70)">
	<!-- wp:group {"className":"is-style-glass","style":{"spacing":{"padding":{"top":"var:preset|spacing|60","bottom":"var:preset|spacing|60","left":"var:preset|spacing|50","right":"var:preset|spacing|50"},"blockGap":"var:preset|spacing|30"}},"layout":{"type":"constrained","contentSize":"560px"}} -->
	<div class="wp-block-group is-style-glass" style="padding-top:var(--wp--preset--spacing--60);padding-right:var(--wp--preset--spacing--50);padding-bottom:var(--wp--preset--spacing--60);padding-left:var(--wp--preset--spacing--50)">
		<!-- wp:paragraph {"align":"center","className":"is-style-pill"} -->
		<p class="has-text-align-center is-style-pill"><?php esc_html_e( 'Newsletter', 'pressbase' ); ?></p>
		<!-- /wp:paragraph -->

		<!-- wp:heading {"textAlign":"center"} -->
		<h2 class="wp-block-heading has-text-align-center"><?php echo wp_kses_post( __( 'Notes, <em>once a month</em>.', 'pressbase' ) ); ?></h2>
		<!-- /wp:heading -->

		<!-- wp:paragraph {"align":"center"} -->
		<p class="has-text-align-center"><?php esc_html_e( 'One short letter with what we shipped, what we learned and what we are reading. No tracking, no spam, unsubscribe in one click.', 'pressbase' ); ?></p>
		<!-- /wp:paragraph -->

		<!-- wp:buttons {"layout":{"type":"flex","justifyContent":"center"},"style":{"spacing":{"margin":{"top":"var:preset|spacing|30"}}}} -->
		<div class="wp-block-buttons" style="margin-top:var(--wp--preset--spacing--30)">
			<!-- wp:button -->
			<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="mailto:hello@example.com"><?php esc_html_e( 'Subscribe by email', 'pressbase' ); ?></a></div>
			<!-- /wp:button -->

			<!-- wp:button {"className":"is-style-outline"} -->
			<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="/feed/"><?php esc_html_e( 'Follow the feed', 'pressbase' ); ?></a></div>
			<!-- /wp:button -->
		</div>
		<!-- /wp:buttons -->
	</div>
	<!-- /wp:group -->
</div>
<!-- /wp:group -->
