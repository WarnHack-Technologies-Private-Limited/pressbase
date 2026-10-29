<?php
/**
 * Title: Footer, ink with a big sign-off
 * Slug: pressbase/footer-ink
 * Categories: footer
 * Block Types: core/template-part/footer
 * Description: A dark footer with an oversized italic sign-off, the site's tagline, a few links and "Powered by Pressbase".
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:group {"align":"full","className":"is-style-section-ink","style":{"spacing":{"padding":{"top":"var:preset|spacing|70","bottom":"var:preset|spacing|50"},"blockGap":"var:preset|spacing|60"}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull is-style-section-ink" style="padding-top:var(--wp--preset--spacing--70);padding-bottom:var(--wp--preset--spacing--50)">
	<!-- wp:group {"align":"wide","style":{"spacing":{"blockGap":"var:preset|spacing|30"}},"layout":{"type":"default"}} -->
	<div class="wp-block-group alignwide">
		<!-- wp:paragraph {"fontSize":"display","fontFamily":"platypi","style":{"typography":{"lineHeight":"1","fontStyle":"italic","fontWeight":"600","letterSpacing":"-0.03em"}}} -->
		<p class="has-platypi-font-family has-display-font-size" style="font-style:italic;font-weight:600;letter-spacing:-0.03em;line-height:1"><?php esc_html_e( 'Keep writing.', 'pressbase' ); ?></p>
		<!-- /wp:paragraph -->

		<!-- wp:site-tagline {"style":{"color":{"text":"var:preset|color|base"}},"fontSize":"large"} /-->
	</div>
	<!-- /wp:group -->

	<!-- wp:group {"align":"wide","className":"is-style-links","style":{"border":{"top":{"color":"color-mix(in srgb, currentColor 25%, transparent)","style":"solid","width":"1px"}},"spacing":{"padding":{"top":"var:preset|spacing|40"},"blockGap":"var:preset|spacing|40"}},"fontSize":"small","layout":{"type":"flex","flexWrap":"wrap","justifyContent":"space-between"}} -->
	<div class="wp-block-group alignwide is-style-links has-small-font-size" style="border-top-color:color-mix(in srgb, currentColor 25%, transparent);border-top-style:solid;border-top-width:1px;padding-top:var(--wp--preset--spacing--40)">
		<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|40"}},"layout":{"type":"flex","flexWrap":"wrap"}} -->
		<div class="wp-block-group">
			<!-- wp:site-title {"level":0,"fontSize":"medium"} /-->

			<!-- wp:paragraph -->
			<p><a href="#"><?php esc_html_e( 'About', 'pressbase' ); ?></a></p>
			<!-- /wp:paragraph -->

			<!-- wp:paragraph -->
			<p><a href="#"><?php esc_html_e( 'Contact', 'pressbase' ); ?></a></p>
			<!-- /wp:paragraph -->

			<!-- wp:paragraph -->
			<p><a href="/feed/"><?php esc_html_e( 'Feed', 'pressbase' ); ?></a></p>
			<!-- /wp:paragraph -->
		</div>
		<!-- /wp:group -->

		<!-- wp:pattern {"slug":"pressbase/hidden-powered-by"} /-->
	</div>
	<!-- /wp:group -->
</div>
<!-- /wp:group -->
