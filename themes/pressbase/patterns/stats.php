<?php
/**
 * Title: Stats
 * Slug: pressbase/stats
 * Categories: pressbase, about
 * Keywords: numbers, stats, metrics, figures
 * Viewport Width: 1400
 * Description: Four large figures with short labels on a soft indigo band.
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:group {"metadata":{"name":"Stats"},"align":"full","className":"is-style-section-soft","style":{"spacing":{"padding":{"top":"var:preset|spacing|70","bottom":"var:preset|spacing|70"}}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull is-style-section-soft" style="padding-top:var(--wp--preset--spacing--70);padding-bottom:var(--wp--preset--spacing--70)">
	<!-- wp:columns {"align":"wide","className":"is-style-reveal"} -->
	<div class="wp-block-columns alignwide is-style-reveal">
		<!-- wp:column -->
		<div class="wp-block-column">
			<!-- wp:paragraph {"fontSize":"display","fontFamily":"platypi","style":{"typography":{"lineHeight":"1","fontWeight":"600","letterSpacing":"-0.03em"}}} -->
			<p class="has-platypi-font-family has-display-font-size" style="font-weight:600;letter-spacing:-0.03em;line-height:1"><?php esc_html_e( '12k', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->

			<!-- wp:paragraph -->
			<p><?php esc_html_e( 'Sites published in the first year', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->
		</div>
		<!-- /wp:column -->

		<!-- wp:column -->
		<div class="wp-block-column">
			<!-- wp:paragraph {"fontSize":"display","fontFamily":"platypi","style":{"typography":{"lineHeight":"1","fontWeight":"600","letterSpacing":"-0.03em"}}} -->
			<p class="has-platypi-font-family has-display-font-size" style="font-weight:600;letter-spacing:-0.03em;line-height:1"><?php esc_html_e( '99.9%', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->

			<!-- wp:paragraph -->
			<p><?php esc_html_e( 'Uptime, measured every minute', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->
		</div>
		<!-- /wp:column -->

		<!-- wp:column -->
		<div class="wp-block-column">
			<!-- wp:paragraph {"fontSize":"display","fontFamily":"platypi","style":{"typography":{"lineHeight":"1","fontWeight":"600","letterSpacing":"-0.03em"}}} -->
			<p class="has-platypi-font-family has-display-font-size" style="font-weight:600;letter-spacing:-0.03em;line-height:1"><?php esc_html_e( '0.4s', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->

			<!-- wp:paragraph -->
			<p><?php esc_html_e( 'Median page load on a phone', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->
		</div>
		<!-- /wp:column -->

		<!-- wp:column -->
		<div class="wp-block-column">
			<!-- wp:paragraph {"fontSize":"display","fontFamily":"platypi","style":{"typography":{"lineHeight":"1","fontWeight":"600","letterSpacing":"-0.03em"}}} -->
			<p class="has-platypi-font-family has-display-font-size" style="font-weight:600;letter-spacing:-0.03em;line-height:1"><?php esc_html_e( '40+', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->

			<!-- wp:paragraph -->
			<p><?php esc_html_e( 'Languages, right to left included', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->
		</div>
		<!-- /wp:column -->
	</div>
	<!-- /wp:columns -->
</div>
<!-- /wp:group -->
