<?php
/**
 * Title: Latest posts grid
 * Slug: pressbase/posts-grid
 * Categories: pressbase, query, posts
 * Keywords: blog, posts, query, loop, grid, latest
 * Block Types: core/query
 * Viewport Width: 1400
 * Description: A heading and the three latest posts in lifted cards, with images, categories, excerpts and dates.
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:group {"metadata":{"name":"Latest posts"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|70","bottom":"var:preset|spacing|70"},"blockGap":"var:preset|spacing|50"}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull" style="padding-top:var(--wp--preset--spacing--70);padding-bottom:var(--wp--preset--spacing--70)">
	<!-- wp:heading {"align":"wide"} -->
	<h2 class="wp-block-heading alignwide"><?php echo wp_kses_post( __( 'From the <em>journal</em>', 'pressbase' ) ); ?></h2>
	<!-- /wp:heading -->

	<!-- wp:query {"queryId":10,"query":{"perPage":3,"pages":0,"offset":0,"postType":"post","order":"desc","orderBy":"date","author":"","search":"","exclude":[],"sticky":"","inherit":false},"align":"wide","layout":{"type":"default"}} -->
	<div class="wp-block-query alignwide">
	<!-- wp:post-template {"className":"is-style-reveal","layout":{"type":"grid","columnCount":3,"minimumColumnWidth":"18rem"}} -->
		<!-- wp:group {"className":"is-style-lift","style":{"dimensions":{"minHeight":"100%"},"spacing":{"padding":{"top":"var:preset|spacing|30","bottom":"var:preset|spacing|40","left":"var:preset|spacing|30","right":"var:preset|spacing|30"},"blockGap":"var:preset|spacing|30"}},"layout":{"type":"flex","orientation":"vertical","justifyContent":"stretch"}} -->
		<div class="wp-block-group is-style-lift" style="min-height:100%;padding-top:var(--wp--preset--spacing--30);padding-right:var(--wp--preset--spacing--30);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--30)">
			<!-- wp:post-featured-image {"isLink":true,"aspectRatio":"16/10","style":{"border":{"radius":"var:preset|border-radius|md"}}} /-->

			<!-- wp:group {"style":{"spacing":{"padding":{"left":"var:preset|spacing|20","right":"var:preset|spacing|20"},"blockGap":"var:preset|spacing|20"}},"layout":{"type":"default"}} -->
			<div class="wp-block-group" style="padding-right:var(--wp--preset--spacing--20);padding-left:var(--wp--preset--spacing--20)">
				<!-- wp:post-terms {"term":"category","fontSize":"small"} /-->

				<!-- wp:post-title {"level":3,"isLink":true,"fontSize":"x-large"} /-->

				<!-- wp:post-excerpt {"excerptLength":22,"fontSize":"medium"} /-->

				<!-- wp:post-date {"fontSize":"small"} /-->
			</div>
			<!-- /wp:group -->
		</div>
		<!-- /wp:group -->
	<!-- /wp:post-template -->

	<!-- wp:query-no-results -->
	<!-- wp:pattern {"slug":"pressbase/hidden-no-results"} /-->
	<!-- /wp:query-no-results -->
	</div>
	<!-- /wp:query -->
</div>
<!-- /wp:group -->
