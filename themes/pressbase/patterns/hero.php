<?php
/**
 * Title: Hero with animated gradient
 * Slug: pressbase/hero
 * Categories: pressbase, banner, featured
 * Keywords: hero, header, intro, gradient, aurora
 * Viewport Width: 1400
 * Description: A large headline over a drifting indigo and violet aurora, with two buttons and a glass card showing a terminal.
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:group {"metadata":{"name":"Hero"},"align":"full","className":"is-style-gradient","style":{"spacing":{"padding":{"top":"var:preset|spacing|80","bottom":"var:preset|spacing|70"},"blockGap":"var:preset|spacing|40"}},"layout":{"type":"constrained","contentSize":"920px"}} -->
<div class="wp-block-group alignfull is-style-gradient" style="padding-top:var(--wp--preset--spacing--80);padding-bottom:var(--wp--preset--spacing--70)">
	<!-- wp:paragraph {"align":"center","className":"is-style-pill"} -->
	<p class="has-text-align-center is-style-pill"><?php esc_html_e( 'New: version 2.0 is here', 'pressbase' ); ?></p>
	<!-- /wp:paragraph -->

	<!-- wp:heading {"textAlign":"center","level":1,"fontSize":"display","style":{"typography":{"lineHeight":"1.02"}}} -->
	<h1 class="wp-block-heading has-text-align-center has-display-font-size" style="line-height:1.02"><?php echo wp_kses_post( __( 'Publish ideas that <em>move</em> people.', 'pressbase' ) ); ?></h1>
	<!-- /wp:heading -->

	<!-- wp:paragraph {"align":"center","fontSize":"large"} -->
	<p class="has-text-align-center has-large-font-size"><?php esc_html_e( 'A calm, fast home for everything you write. Draft together, launch in a click and watch every page load before your readers can blink.', 'pressbase' ); ?></p>
	<!-- /wp:paragraph -->

	<!-- wp:buttons {"layout":{"type":"flex","justifyContent":"center"},"style":{"spacing":{"margin":{"top":"var:preset|spacing|40"}}}} -->
	<div class="wp-block-buttons" style="margin-top:var(--wp--preset--spacing--40)">
		<!-- wp:button -->
		<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="#"><?php esc_html_e( 'Start for free', 'pressbase' ); ?></a></div>
		<!-- /wp:button -->

		<!-- wp:button {"className":"is-style-outline"} -->
		<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="#"><?php esc_html_e( 'See how it works', 'pressbase' ); ?></a></div>
		<!-- /wp:button -->
	</div>
	<!-- /wp:buttons -->

	<!-- wp:paragraph {"align":"center","textColor":"muted","fontSize":"small"} -->
	<p class="has-text-align-center has-muted-color has-text-color has-small-font-size"><?php esc_html_e( 'No credit card. Free for personal sites, forever.', 'pressbase' ); ?></p>
	<!-- /wp:paragraph -->

	<!-- wp:group {"className":"is-style-glass","style":{"spacing":{"margin":{"top":"var:preset|spacing|60"},"padding":{"top":"var:preset|spacing|30","bottom":"var:preset|spacing|30","left":"var:preset|spacing|30","right":"var:preset|spacing|30"},"blockGap":"var:preset|spacing|20"}},"layout":{"type":"default"}} -->
	<div class="wp-block-group is-style-glass" style="margin-top:var(--wp--preset--spacing--60);padding-top:var(--wp--preset--spacing--30);padding-right:var(--wp--preset--spacing--30);padding-bottom:var(--wp--preset--spacing--30);padding-left:var(--wp--preset--spacing--30)">
		<!-- wp:paragraph {"textColor":"muted","fontSize":"small","fontFamily":"fira-code"} -->
		<p class="has-muted-color has-text-color has-fira-code-font-family has-small-font-size"><?php esc_html_e( '~/my-site — terminal', 'pressbase' ); ?></p>
		<!-- /wp:paragraph -->

		<!-- wp:code {"style":{"spacing":{"margin":{"top":"0","bottom":"0"}}}} -->
		<pre class="wp-block-code" style="margin-top:0;margin-bottom:0"><code><?php esc_html_e( '$ site new "Field Notes"', 'pressbase' ); ?><br><?php esc_html_e( '  Creating your site…  done in 1.2s', 'pressbase' ); ?><br><?php esc_html_e( '$ site publish', 'pressbase' ); ?><br><?php esc_html_e( '  Live at https://fieldnotes.example', 'pressbase' ); ?></code></pre>
		<!-- /wp:code -->
	</div>
	<!-- /wp:group -->
</div>
<!-- /wp:group -->
