<?php
/**
 * Title: Comments
 * Slug: pressbase/hidden-comments
 * Inserter: no
 * Block Types: core/comments
 * Description: The comments of a post, their pagination and the comment form.
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:comments {"style":{"spacing":{"margin":{"top":"var:preset|spacing|60"}}}} -->
<div class="wp-block-comments" style="margin-top:var(--wp--preset--spacing--60)">
	<!-- wp:comments-title {"level":2,"fontSize":"x-large"} /-->

	<!-- wp:comment-template -->
	<!-- wp:group {"style":{"spacing":{"margin":{"top":"0","bottom":"var:preset|spacing|40"}}},"layout":{"type":"flex","flexWrap":"nowrap","verticalAlignment":"top"}} -->
	<div class="wp-block-group" style="margin-top:0;margin-bottom:var(--wp--preset--spacing--40)">
		<!-- wp:avatar {"size":40} /-->

		<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|20"}},"layout":{"type":"default"}} -->
		<div class="wp-block-group">
			<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|20"}},"layout":{"type":"flex","flexWrap":"wrap"}} -->
			<div class="wp-block-group">
				<!-- wp:comment-author-name {"fontSize":"small"} /-->

				<!-- wp:comment-date {"fontSize":"small"} /-->
			</div>
			<!-- /wp:group -->

			<!-- wp:comment-content /-->

			<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|30"}},"fontSize":"small","layout":{"type":"flex","flexWrap":"nowrap"}} -->
			<div class="wp-block-group has-small-font-size">
				<!-- wp:comment-edit-link /-->

				<!-- wp:comment-reply-link /-->
			</div>
			<!-- /wp:group -->
		</div>
		<!-- /wp:group -->
	</div>
	<!-- /wp:group -->
	<!-- /wp:comment-template -->

	<!-- wp:comments-pagination {"layout":{"type":"flex","justifyContent":"space-between"}} -->
	<!-- wp:comments-pagination-previous /-->
	<!-- wp:comments-pagination-next /-->
	<!-- /wp:comments-pagination -->

	<!-- wp:post-comments-form /-->
</div>
<!-- /wp:comments -->
