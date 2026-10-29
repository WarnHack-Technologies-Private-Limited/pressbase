<?php
/**
 * Title: Post navigation
 * Slug: pressbase/hidden-post-navigation
 * Inserter: no
 * Description: Links to the previous and next posts.
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:group {"tagName":"nav","ariaLabel":"<?php esc_attr_e( 'Post navigation', 'pressbase' ); ?>","style":{"border":{"top":{"color":"var:preset|color|border","style":"solid","width":"1px"}},"spacing":{"padding":{"top":"var:preset|spacing|40"},"margin":{"top":"var:preset|spacing|60"}}},"layout":{"type":"flex","flexWrap":"nowrap","justifyContent":"space-between"}} -->
<nav class="wp-block-group" aria-label="<?php esc_attr_e( 'Post navigation', 'pressbase' ); ?>" style="border-top-color:var(--wp--preset--color--border);border-top-style:solid;border-top-width:1px;margin-top:var(--wp--preset--spacing--60);padding-top:var(--wp--preset--spacing--40)">
	<!-- wp:post-navigation-link {"type":"previous","showTitle":true,"arrow":"arrow"} /-->

	<!-- wp:post-navigation-link {"showTitle":true,"arrow":"arrow"} /-->
</nav>
<!-- /wp:group -->
