<?php
/**
 * Title: Footer
 * Slug: pressbase/footer
 * Categories: footer
 * Block Types: core/template-part/footer
 * Description: A call-to-action card, four columns of links with the site's name and tagline, and a small "Powered by Pressbase".
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:group {"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|70","bottom":"var:preset|spacing|50"},"blockGap":"var:preset|spacing|60"}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull" style="padding-top:var(--wp--preset--spacing--70);padding-bottom:var(--wp--preset--spacing--50)">
	<!-- wp:group {"anchor":"get-started","align":"wide","className":"is-style-glass","style":{"spacing":{"padding":{"top":"var:preset|spacing|50","bottom":"var:preset|spacing|50","left":"var:preset|spacing|50","right":"var:preset|spacing|50"}}},"layout":{"type":"flex","flexWrap":"wrap","justifyContent":"space-between","verticalAlignment":"center"}} -->
	<div id="get-started" class="wp-block-group alignwide is-style-glass" style="padding-top:var(--wp--preset--spacing--50);padding-right:var(--wp--preset--spacing--50);padding-bottom:var(--wp--preset--spacing--50);padding-left:var(--wp--preset--spacing--50)">
		<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|20"}},"layout":{"type":"flex","orientation":"vertical"}} -->
		<div class="wp-block-group">
			<!-- wp:heading {"fontSize":"xx-large"} -->
			<h2 class="wp-block-heading has-xx-large-font-size"><?php echo wp_kses_post( __( 'Ready when <em>you</em> are.', 'pressbase' ) ); ?></h2>
			<!-- /wp:heading -->

			<!-- wp:paragraph {"textColor":"muted"} -->
			<p class="has-muted-color has-text-color"><?php esc_html_e( 'Set up a site in minutes. Bring your words, we will handle the rest.', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->
		</div>
		<!-- /wp:group -->

		<!-- wp:buttons -->
		<div class="wp-block-buttons">
			<!-- wp:button -->
			<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="#"><?php esc_html_e( 'Start for free', 'pressbase' ); ?></a></div>
			<!-- /wp:button -->

			<!-- wp:button {"className":"is-style-outline"} -->
			<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="#"><?php esc_html_e( 'Talk to us', 'pressbase' ); ?></a></div>
			<!-- /wp:button -->
		</div>
		<!-- /wp:buttons -->
	</div>
	<!-- /wp:group -->

	<!-- wp:columns {"align":"wide","className":"is-style-links","style":{"spacing":{"blockGap":{"top":"var:preset|spacing|50","left":"var:preset|spacing|50"}}}} -->
	<div class="wp-block-columns alignwide is-style-links">
		<!-- wp:column {"width":"40%"} -->
		<div class="wp-block-column" style="flex-basis:40%">
			<!-- wp:site-title {"level":0,"fontSize":"x-large"} /-->
			<!-- wp:site-tagline /-->
		</div>
		<!-- /wp:column -->

		<!-- wp:column -->
		<div class="wp-block-column">
			<!-- wp:heading {"level":2,"fontSize":"small","style":{"typography":{"textTransform":"uppercase","letterSpacing":"0.08em"}},"fontFamily":"manrope"} -->
			<h2 class="wp-block-heading has-manrope-font-family has-small-font-size" style="letter-spacing:0.08em;text-transform:uppercase"><?php esc_html_e( 'Product', 'pressbase' ); ?></h2>
			<!-- /wp:heading -->

			<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|20"}},"fontSize":"small","layout":{"type":"flex","orientation":"vertical"}} -->
			<div class="wp-block-group has-small-font-size">
				<!-- wp:paragraph -->
				<p><a href="#"><?php esc_html_e( 'Features', 'pressbase' ); ?></a></p>
				<!-- /wp:paragraph -->

				<!-- wp:paragraph -->
				<p><a href="#"><?php esc_html_e( 'Pricing', 'pressbase' ); ?></a></p>
				<!-- /wp:paragraph -->

				<!-- wp:paragraph -->
				<p><a href="#"><?php esc_html_e( 'Changelog', 'pressbase' ); ?></a></p>
				<!-- /wp:paragraph -->
			</div>
			<!-- /wp:group -->
		</div>
		<!-- /wp:column -->

		<!-- wp:column -->
		<div class="wp-block-column">
			<!-- wp:heading {"level":2,"fontSize":"small","style":{"typography":{"textTransform":"uppercase","letterSpacing":"0.08em"}},"fontFamily":"manrope"} -->
			<h2 class="wp-block-heading has-manrope-font-family has-small-font-size" style="letter-spacing:0.08em;text-transform:uppercase"><?php esc_html_e( 'Resources', 'pressbase' ); ?></h2>
			<!-- /wp:heading -->

			<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|20"}},"fontSize":"small","layout":{"type":"flex","orientation":"vertical"}} -->
			<div class="wp-block-group has-small-font-size">
				<!-- wp:paragraph -->
				<p><a href="#"><?php esc_html_e( 'Blog', 'pressbase' ); ?></a></p>
				<!-- /wp:paragraph -->

				<!-- wp:paragraph -->
				<p><a href="#"><?php esc_html_e( 'Guides', 'pressbase' ); ?></a></p>
				<!-- /wp:paragraph -->

				<!-- wp:paragraph -->
				<p><a href="#"><?php esc_html_e( 'Help center', 'pressbase' ); ?></a></p>
				<!-- /wp:paragraph -->
			</div>
			<!-- /wp:group -->
		</div>
		<!-- /wp:column -->

		<!-- wp:column -->
		<div class="wp-block-column">
			<!-- wp:heading {"level":2,"fontSize":"small","style":{"typography":{"textTransform":"uppercase","letterSpacing":"0.08em"}},"fontFamily":"manrope"} -->
			<h2 class="wp-block-heading has-manrope-font-family has-small-font-size" style="letter-spacing:0.08em;text-transform:uppercase"><?php esc_html_e( 'Company', 'pressbase' ); ?></h2>
			<!-- /wp:heading -->

			<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|20"}},"fontSize":"small","layout":{"type":"flex","orientation":"vertical"}} -->
			<div class="wp-block-group has-small-font-size">
				<!-- wp:paragraph -->
				<p><a href="#"><?php esc_html_e( 'About', 'pressbase' ); ?></a></p>
				<!-- /wp:paragraph -->

				<!-- wp:paragraph -->
				<p><a href="#"><?php esc_html_e( 'Careers', 'pressbase' ); ?></a></p>
				<!-- /wp:paragraph -->

				<!-- wp:paragraph -->
				<p><a href="#"><?php esc_html_e( 'Contact', 'pressbase' ); ?></a></p>
				<!-- /wp:paragraph -->
			</div>
			<!-- /wp:group -->
		</div>
		<!-- /wp:column -->
	</div>
	<!-- /wp:columns -->

	<!-- wp:group {"align":"wide","style":{"border":{"top":{"color":"var:preset|color|border","style":"solid","width":"1px"}},"spacing":{"padding":{"top":"var:preset|spacing|40"}}},"fontSize":"small","layout":{"type":"flex","flexWrap":"wrap","justifyContent":"space-between"}} -->
	<div class="wp-block-group alignwide has-small-font-size" style="border-top-color:var(--wp--preset--color--border);border-top-style:solid;border-top-width:1px;padding-top:var(--wp--preset--spacing--40)">
		<!-- wp:paragraph {"textColor":"muted"} -->
		<p class="has-muted-color has-text-color"><?php esc_html_e( 'Made for people who publish.', 'pressbase' ); ?></p>
		<!-- /wp:paragraph -->

		<!-- wp:pattern {"slug":"pressbase/hidden-powered-by"} /-->
	</div>
	<!-- /wp:group -->
</div>
<!-- /wp:group -->
