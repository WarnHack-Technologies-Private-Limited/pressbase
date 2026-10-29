<?php
/**
 * Title: Powered by Pressbase
 * Slug: pressbase/hidden-powered-by
 * Inserter: no
 * Description: The small "Powered by Pressbase" line used in the footers.
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:group {"className":"is-style-links","style":{"spacing":{"blockGap":"var:preset|spacing|20"}},"layout":{"type":"flex","flexWrap":"nowrap"}} -->
<div class="wp-block-group is-style-links">
	<!-- wp:image {"width":"20px","height":"20px","sizeSlug":"full","linkDestination":"none"} -->
	<figure class="wp-block-image size-full is-resized"><img src="<?php echo esc_url( get_template_directory_uri() ); ?>/assets/images/pressbase-mark.svg" alt="" style="width:20px;height:20px"/></figure>
	<!-- /wp:image -->

	<!-- wp:paragraph {"fontSize":"small"} -->
	<p class="has-small-font-size"><?php /* translators: %s: Pressbase, linked to its website. */ echo wp_kses_post( sprintf( __( 'Powered by %s', 'pressbase' ), '<a href="https://github.com/WarnHack-Technologies-Private-Limited/pressbase" rel="nofollow">Pressbase</a>' ) ); ?></p>
	<!-- /wp:paragraph -->
</div>
<!-- /wp:group -->
