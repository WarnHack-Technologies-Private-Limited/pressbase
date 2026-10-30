<?php
/**
 * Title: How it works
 * Slug: pressbase/steps
 * Categories: pressbase, services, text
 * Keywords: steps, process, how it works, onboarding
 * Viewport Width: 1400
 * Description: Three numbered steps in glass cards, revealed one after another.
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:group {"metadata":{"name":"How it works"},"align":"full","className":"is-style-gradient","style":{"spacing":{"padding":{"top":"var:preset|spacing|80","bottom":"var:preset|spacing|80"},"blockGap":"var:preset|spacing|60"}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull is-style-gradient" style="padding-top:var(--wp--preset--spacing--80);padding-bottom:var(--wp--preset--spacing--80)">
	<!-- wp:heading {"textAlign":"center"} -->
	<h2 class="wp-block-heading has-text-align-center"><?php echo wp_kses_post( __( 'Live in <em>three</em> steps.', 'pressbase' ) ); ?></h2>
	<!-- /wp:heading -->

	<!-- wp:columns {"align":"wide","className":"is-style-reveal"} -->
	<div class="wp-block-columns alignwide is-style-reveal">
		<!-- wp:column {"className":"is-style-glass","style":{"spacing":{"padding":{"top":"var:preset|spacing|40","bottom":"var:preset|spacing|40","left":"var:preset|spacing|40","right":"var:preset|spacing|40"},"blockGap":"var:preset|spacing|30"}}} -->
		<div class="wp-block-column is-style-glass" style="padding-top:var(--wp--preset--spacing--40);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--40)">
			<!-- wp:paragraph {"textColor":"accent-text","fontSize":"small","fontFamily":"fira-code"} -->
			<p class="has-accent-text-color has-text-color has-fira-code-font-family has-small-font-size"><?php esc_html_e( '01', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->

			<!-- wp:heading {"level":3,"fontSize":"x-large"} -->
			<h3 class="wp-block-heading has-x-large-font-size"><?php esc_html_e( 'Pick a look', 'pressbase' ); ?></h3>
			<!-- /wp:heading -->

			<!-- wp:paragraph -->
			<p><?php esc_html_e( 'Choose a style variation, then make the colours and type your own.', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->
		</div>
		<!-- /wp:column -->

		<!-- wp:column {"className":"is-style-glass","style":{"spacing":{"padding":{"top":"var:preset|spacing|40","bottom":"var:preset|spacing|40","left":"var:preset|spacing|40","right":"var:preset|spacing|40"},"blockGap":"var:preset|spacing|30"}}} -->
		<div class="wp-block-column is-style-glass" style="padding-top:var(--wp--preset--spacing--40);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--40)">
			<!-- wp:paragraph {"textColor":"accent-text","fontSize":"small","fontFamily":"fira-code"} -->
			<p class="has-accent-text-color has-text-color has-fira-code-font-family has-small-font-size"><?php esc_html_e( '02', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->

			<!-- wp:heading {"level":3,"fontSize":"x-large"} -->
			<h3 class="wp-block-heading has-x-large-font-size"><?php esc_html_e( 'Write and arrange', 'pressbase' ); ?></h3>
			<!-- /wp:heading -->

			<!-- wp:paragraph -->
			<p><?php esc_html_e( 'Drop in patterns, type over the placeholders and preview as you go.', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->
		</div>
		<!-- /wp:column -->

		<!-- wp:column {"className":"is-style-glass","style":{"spacing":{"padding":{"top":"var:preset|spacing|40","bottom":"var:preset|spacing|40","left":"var:preset|spacing|40","right":"var:preset|spacing|40"},"blockGap":"var:preset|spacing|30"}}} -->
		<div class="wp-block-column is-style-glass" style="padding-top:var(--wp--preset--spacing--40);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--40)">
			<!-- wp:paragraph {"textColor":"accent-text","fontSize":"small","fontFamily":"fira-code"} -->
			<p class="has-accent-text-color has-text-color has-fira-code-font-family has-small-font-size"><?php esc_html_e( '03', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->

			<!-- wp:heading {"level":3,"fontSize":"x-large"} -->
			<h3 class="wp-block-heading has-x-large-font-size"><?php esc_html_e( 'Publish', 'pressbase' ); ?></h3>
			<!-- /wp:heading -->

			<!-- wp:paragraph -->
			<p><?php esc_html_e( 'One click and it is live, cached and fast for every reader.', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->
		</div>
		<!-- /wp:column -->
	</div>
	<!-- /wp:columns -->
</div>
<!-- /wp:group -->
