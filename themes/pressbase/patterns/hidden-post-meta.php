<?php
/**
 * Title: Post meta
 * Slug: pressbase/hidden-post-meta
 * Inserter: no
 * Description: The author's avatar and name, and the date, under a post's title.
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|20","margin":{"top":"var:preset|spacing|30"}}},"layout":{"type":"flex","flexWrap":"wrap","verticalAlignment":"center"}} -->
<div class="wp-block-group" style="margin-top:var(--wp--preset--spacing--30)">
	<!-- wp:avatar {"size":36} /-->

	<!-- wp:post-author-name {"isLink":true} /-->

	<!-- wp:paragraph {"textColor":"muted","fontSize":"small"} -->
	<p class="has-muted-color has-text-color has-small-font-size">·</p>
	<!-- /wp:paragraph -->

	<!-- wp:post-date /-->
</div>
<!-- /wp:group -->
