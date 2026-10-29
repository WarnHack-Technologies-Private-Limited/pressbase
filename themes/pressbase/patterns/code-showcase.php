<?php
/**
 * Title: Text and code card
 * Slug: pressbase/code-showcase
 * Categories: pressbase, featured, text
 * Keywords: code, developers, api, split, media
 * Viewport Width: 1400
 * Description: A heading, a short list and a button beside a glass card holding a code sample.
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:group {"metadata":{"name":"Text and code"},"align":"full","className":"is-style-gradient","style":{"spacing":{"padding":{"top":"var:preset|spacing|80","bottom":"var:preset|spacing|80"}}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull is-style-gradient" style="padding-top:var(--wp--preset--spacing--80);padding-bottom:var(--wp--preset--spacing--80)">
	<!-- wp:columns {"verticalAlignment":"center","align":"wide","style":{"spacing":{"blockGap":{"top":"var:preset|spacing|50","left":"var:preset|spacing|60"}}}} -->
	<div class="wp-block-columns alignwide are-vertically-aligned-center">
		<!-- wp:column {"verticalAlignment":"center"} -->
		<div class="wp-block-column is-vertically-aligned-center">
			<!-- wp:paragraph {"className":"is-style-pill"} -->
			<p class="is-style-pill"><?php esc_html_e( 'For developers', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->

			<!-- wp:heading -->
			<h2 class="wp-block-heading"><?php echo wp_kses_post( __( 'An API that feels <em>familiar</em>.', 'pressbase' ) ); ?></h2>
			<!-- /wp:heading -->

			<!-- wp:paragraph {"fontSize":"large"} -->
			<p class="has-large-font-size"><?php esc_html_e( 'Read and write everything over a clean REST API, extend it with typed plugins, and keep your content in plain, portable blocks.', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->

			<!-- wp:list -->
			<ul class="wp-block-list">
				<!-- wp:list-item -->
				<li><?php esc_html_e( 'Typed hooks and filters', 'pressbase' ); ?></li>
				<!-- /wp:list-item -->

				<!-- wp:list-item -->
				<li><?php esc_html_e( 'Webhooks for every change', 'pressbase' ); ?></li>
				<!-- /wp:list-item -->

				<!-- wp:list-item -->
				<li><?php esc_html_e( 'A command line for the busy days', 'pressbase' ); ?></li>
				<!-- /wp:list-item -->
			</ul>
			<!-- /wp:list -->

			<!-- wp:buttons -->
			<div class="wp-block-buttons">
				<!-- wp:button {"className":"is-style-outline"} -->
				<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="#"><?php esc_html_e( 'Read the docs', 'pressbase' ); ?></a></div>
				<!-- /wp:button -->
			</div>
			<!-- /wp:buttons -->
		</div>
		<!-- /wp:column -->

		<!-- wp:column {"verticalAlignment":"center","className":"is-style-glass","style":{"spacing":{"padding":{"top":"var:preset|spacing|40","bottom":"var:preset|spacing|40","left":"var:preset|spacing|40","right":"var:preset|spacing|40"}}}} -->
		<div class="wp-block-column is-vertically-aligned-center is-style-glass" style="padding-top:var(--wp--preset--spacing--40);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--40)">
			<!-- wp:paragraph {"textColor":"muted","fontSize":"small","fontFamily":"fira-code"} -->
			<p class="has-muted-color has-text-color has-fira-code-font-family has-small-font-size"><?php esc_html_e( 'publish.ts', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->

			<!-- wp:code -->
			<pre class="wp-block-code"><code><?php esc_html_e( 'const post = await site.posts.create({', 'pressbase' ); ?><br><?php esc_html_e( '  title: "Hello, world",', 'pressbase' ); ?><br><?php esc_html_e( '  status: "publish",', 'pressbase' ); ?><br><?php esc_html_e( '});', 'pressbase' ); ?><br><br><?php esc_html_e( 'console.log(post.link);', 'pressbase' ); ?></code></pre>
			<!-- /wp:code -->
		</div>
		<!-- /wp:column -->
	</div>
	<!-- /wp:columns -->
</div>
<!-- /wp:group -->
