<?php
/**
 * Title: No results
 * Slug: pressbase/hidden-no-results
 * Inserter: no
 * Description: The message shown when a query finds nothing.
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:group {"className":"is-style-lift","style":{"spacing":{"padding":{"top":"var:preset|spacing|50","bottom":"var:preset|spacing|50","left":"var:preset|spacing|40","right":"var:preset|spacing|40"},"blockGap":"var:preset|spacing|30"}},"layout":{"type":"constrained","contentSize":"520px"}} -->
<div class="wp-block-group is-style-lift" style="padding-top:var(--wp--preset--spacing--50);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--50);padding-left:var(--wp--preset--spacing--40)">
	<!-- wp:heading {"textAlign":"center","level":2,"fontSize":"x-large"} -->
	<h2 class="wp-block-heading has-text-align-center has-x-large-font-size"><?php esc_html_e( 'Nothing here yet', 'pressbase' ); ?></h2>
	<!-- /wp:heading -->

	<!-- wp:paragraph {"align":"center","textColor":"muted"} -->
	<p class="has-text-align-center has-muted-color has-text-color"><?php echo esc_html_x( 'Sorry, nothing matched. Try a search with different words.', 'Message shown when a query has no results.', 'pressbase' ); ?></p>
	<!-- /wp:paragraph -->

	<!-- wp:pattern {"slug":"pressbase/hidden-search"} /-->
</div>
<!-- /wp:group -->
