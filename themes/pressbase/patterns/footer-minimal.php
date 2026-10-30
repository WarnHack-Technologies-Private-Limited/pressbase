<?php
/**
 * Title: Footer, minimal
 * Slug: pressbase/footer-minimal
 * Categories: footer
 * Block Types: core/template-part/footer
 * Description: One quiet row: the site title, a few links and "Powered by Pressbase".
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:group {"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|50","bottom":"var:preset|spacing|50"}}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull" style="padding-top:var(--wp--preset--spacing--50);padding-bottom:var(--wp--preset--spacing--50)">
	<!-- wp:group {"align":"wide","className":"is-style-links","style":{"border":{"top":{"color":"var:preset|color|border","style":"solid","width":"1px"}},"spacing":{"padding":{"top":"var:preset|spacing|40"},"blockGap":"var:preset|spacing|40"}},"fontSize":"small","layout":{"type":"flex","flexWrap":"wrap","justifyContent":"space-between"}} -->
	<div class="wp-block-group alignwide is-style-links has-small-font-size" style="border-top-color:var(--wp--preset--color--border);border-top-style:solid;border-top-width:1px;padding-top:var(--wp--preset--spacing--40)">
		<!-- wp:site-title {"level":0,"fontSize":"medium"} /-->

		<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|40"}},"layout":{"type":"flex","flexWrap":"wrap"}} -->
		<div class="wp-block-group">
			<!-- wp:paragraph -->
			<p><a href="#"><?php esc_html_e( 'About', 'pressbase' ); ?></a></p>
			<!-- /wp:paragraph -->

			<!-- wp:paragraph -->
			<p><a href="#"><?php esc_html_e( 'Privacy', 'pressbase' ); ?></a></p>
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
