<?php
/**
 * Title: Bento grid
 * Slug: pressbase/bento-grid
 * Categories: pressbase, services, featured
 * Keywords: bento, grid, features, cards
 * Viewport Width: 1400
 * Description: Seven cards of different sizes in a responsive grid, led by a large ink card. Spans collapse to full width on narrow screens.
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:group {"metadata":{"name":"Bento grid"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|70","bottom":"var:preset|spacing|70"},"blockGap":"var:preset|spacing|60"}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull" style="padding-top:var(--wp--preset--spacing--70);padding-bottom:var(--wp--preset--spacing--70)">
	<!-- wp:group {"align":"wide","className":"is-style-reveal","style":{"spacing":{"blockGap":"var:preset|spacing|30"}},"layout":{"type":"flex","flexWrap":"wrap","justifyContent":"space-between","verticalAlignment":"bottom"}} -->
	<div class="wp-block-group alignwide is-style-reveal">
		<!-- wp:heading {"style":{"layout":{"selfStretch":"fixed","flexSize":"640px"}}} -->
		<h2 class="wp-block-heading"><?php echo wp_kses_post( __( 'Built for the way <em>teams</em> actually publish.', 'pressbase' ) ); ?></h2>
		<!-- /wp:heading -->

		<!-- wp:paragraph {"textColor":"muted","style":{"layout":{"selfStretch":"fixed","flexSize":"380px"}}} -->
		<p class="has-muted-color has-text-color"><?php esc_html_e( 'From the first draft to the thousandth post, the details are already handled.', 'pressbase' ); ?></p>
		<!-- /wp:paragraph -->
	</div>
	<!-- /wp:group -->

	<!-- wp:group {"align":"wide","className":"is-style-reveal","style":{"spacing":{"blockGap":"var:preset|spacing|30"}},"layout":{"type":"grid","columnCount":4,"minimumColumnWidth":"14rem"}} -->
	<div class="wp-block-group alignwide is-style-reveal">
		<!-- wp:group {"className":"is-style-section-ink","style":{"layout":{"columnSpan":2,"rowSpan":2},"border":{"radius":"var:preset|border-radius|xl"},"spacing":{"padding":{"top":"var:preset|spacing|50","bottom":"var:preset|spacing|50","left":"var:preset|spacing|50","right":"var:preset|spacing|50"},"blockGap":"var:preset|spacing|30"}},"layout":{"type":"flex","orientation":"vertical","justifyContent":"left","verticalAlignment":"space-between"}} -->
		<div class="wp-block-group is-style-section-ink" style="border-radius:var(--wp--preset--border-radius--xl);padding-top:var(--wp--preset--spacing--50);padding-right:var(--wp--preset--spacing--50);padding-bottom:var(--wp--preset--spacing--50);padding-left:var(--wp--preset--spacing--50)">
			<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|30"}},"layout":{"type":"default"}} -->
			<div class="wp-block-group">
				<!-- wp:heading {"level":3,"fontSize":"xxx-large"} -->
				<h3 class="wp-block-heading has-xxx-large-font-size"><?php echo wp_kses_post( __( 'A writing room, <em>not</em> a cockpit.', 'pressbase' ) ); ?></h3>
				<!-- /wp:heading -->

				<!-- wp:paragraph {"fontSize":"large"} -->
				<p class="has-large-font-size"><?php esc_html_e( 'Blocks, patterns and revisions, laid out so the words come first. Everything else waits a click away.', 'pressbase' ); ?></p>
				<!-- /wp:paragraph -->
			</div>
			<!-- /wp:group -->

			<!-- wp:code -->
			<pre class="wp-block-code"><code><?php esc_html_e( 'Draft saved · 2 collaborators · 1,284 words', 'pressbase' ); ?></code></pre>
			<!-- /wp:code -->
		</div>
		<!-- /wp:group -->

		<!-- wp:group {"className":"is-style-lift","style":{"spacing":{"padding":{"top":"var:preset|spacing|40","bottom":"var:preset|spacing|40","left":"var:preset|spacing|40","right":"var:preset|spacing|40"},"blockGap":"var:preset|spacing|20"}},"layout":{"type":"default"}} -->
		<div class="wp-block-group is-style-lift" style="padding-top:var(--wp--preset--spacing--40);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--40)">
			<!-- wp:paragraph {"fontSize":"xxx-large","fontFamily":"platypi","style":{"typography":{"lineHeight":"1","fontStyle":"italic","fontWeight":"600"}}} -->
			<p class="has-platypi-font-family has-xxx-large-font-size" style="font-style:italic;font-weight:600;line-height:1"><?php esc_html_e( '0.4s', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->

			<!-- wp:paragraph {"textColor":"muted","fontSize":"small"} -->
			<p class="has-muted-color has-text-color has-small-font-size"><?php esc_html_e( 'Median time to a fully loaded page, cached or not.', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->
		</div>
		<!-- /wp:group -->

		<!-- wp:group {"className":"is-style-lift","style":{"spacing":{"padding":{"top":"var:preset|spacing|40","bottom":"var:preset|spacing|40","left":"var:preset|spacing|40","right":"var:preset|spacing|40"},"blockGap":"var:preset|spacing|20"}},"layout":{"type":"default"}} -->
		<div class="wp-block-group is-style-lift" style="padding-top:var(--wp--preset--spacing--40);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--40)">
			<!-- wp:image {"width":"40px","height":"40px","sizeSlug":"full","linkDestination":"none"} -->
			<figure class="wp-block-image size-full is-resized"><img src="<?php echo esc_url( get_template_directory_uri() ); ?>/assets/images/icons/spark.svg" alt="" style="width:40px;height:40px"/></figure>
			<!-- /wp:image -->

			<!-- wp:heading {"level":3,"fontSize":"large"} -->
			<h3 class="wp-block-heading has-large-font-size"><?php esc_html_e( 'Global styles', 'pressbase' ); ?></h3>
			<!-- /wp:heading -->

			<!-- wp:paragraph {"textColor":"muted","fontSize":"small"} -->
			<p class="has-muted-color has-text-color has-small-font-size"><?php esc_html_e( 'Change a colour or a typeface once. Every page follows.', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->
		</div>
		<!-- /wp:group -->

		<!-- wp:group {"className":"is-style-lift","style":{"layout":{"columnSpan":2},"spacing":{"padding":{"top":"var:preset|spacing|40","bottom":"var:preset|spacing|40","left":"var:preset|spacing|40","right":"var:preset|spacing|40"},"blockGap":"var:preset|spacing|20"}},"layout":{"type":"default"}} -->
		<div class="wp-block-group is-style-lift" style="padding-top:var(--wp--preset--spacing--40);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--40)">
			<!-- wp:image {"width":"40px","height":"40px","sizeSlug":"full","linkDestination":"none"} -->
			<figure class="wp-block-image size-full is-resized"><img src="<?php echo esc_url( get_template_directory_uri() ); ?>/assets/images/icons/layers.svg" alt="" style="width:40px;height:40px"/></figure>
			<!-- /wp:image -->

			<!-- wp:heading {"level":3,"fontSize":"large"} -->
			<h3 class="wp-block-heading has-large-font-size"><?php esc_html_e( 'Twenty-plus patterns', 'pressbase' ); ?></h3>
			<!-- /wp:heading -->

			<!-- wp:paragraph {"textColor":"muted","fontSize":"small"} -->
			<p class="has-muted-color has-text-color has-small-font-size"><?php esc_html_e( 'Heroes, pricing tables, questions and answers: ready to drop in and make your own.', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->
		</div>
		<!-- /wp:group -->

		<!-- wp:group {"className":"is-style-lift","style":{"spacing":{"padding":{"top":"var:preset|spacing|40","bottom":"var:preset|spacing|40","left":"var:preset|spacing|40","right":"var:preset|spacing|40"},"blockGap":"var:preset|spacing|20"}},"layout":{"type":"default"}} -->
		<div class="wp-block-group is-style-lift" style="padding-top:var(--wp--preset--spacing--40);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--40)">
			<!-- wp:image {"width":"40px","height":"40px","sizeSlug":"full","linkDestination":"none"} -->
			<figure class="wp-block-image size-full is-resized"><img src="<?php echo esc_url( get_template_directory_uri() ); ?>/assets/images/icons/code.svg" alt="" style="width:40px;height:40px"/></figure>
			<!-- /wp:image -->

			<!-- wp:heading {"level":3,"fontSize":"large"} -->
			<h3 class="wp-block-heading has-large-font-size"><?php esc_html_e( 'Open source', 'pressbase' ); ?></h3>
			<!-- /wp:heading -->

			<!-- wp:paragraph {"textColor":"muted","fontSize":"small"} -->
			<p class="has-muted-color has-text-color has-small-font-size"><?php esc_html_e( 'Licensed under the GPL and built in the open. Read every line.', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->
		</div>
		<!-- /wp:group -->

		<!-- wp:group {"className":"is-style-section-soft","style":{"layout":{"columnSpan":2},"border":{"radius":"var:preset|border-radius|lg"},"spacing":{"padding":{"top":"var:preset|spacing|40","bottom":"var:preset|spacing|40","left":"var:preset|spacing|40","right":"var:preset|spacing|40"},"blockGap":"var:preset|spacing|20"}},"layout":{"type":"default"}} -->
		<div class="wp-block-group is-style-section-soft" style="border-radius:var(--wp--preset--border-radius--lg);padding-top:var(--wp--preset--spacing--40);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--40)">
			<!-- wp:heading {"level":3,"fontSize":"x-large"} -->
			<h3 class="wp-block-heading has-x-large-font-size"><?php esc_html_e( 'Bring your WordPress site along', 'pressbase' ); ?></h3>
			<!-- /wp:heading -->

			<!-- wp:paragraph -->
			<p><?php esc_html_e( 'Import posts, pages, media and people from a WordPress export file in one go. Your old links keep working.', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->
		</div>
		<!-- /wp:group -->

		<!-- wp:group {"className":"is-style-lift","style":{"spacing":{"padding":{"top":"var:preset|spacing|40","bottom":"var:preset|spacing|40","left":"var:preset|spacing|40","right":"var:preset|spacing|40"},"blockGap":"var:preset|spacing|20"}},"layout":{"type":"default"}} -->
		<div class="wp-block-group is-style-lift" style="padding-top:var(--wp--preset--spacing--40);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--40)">
			<!-- wp:image {"width":"40px","height":"40px","sizeSlug":"full","linkDestination":"none"} -->
			<figure class="wp-block-image size-full is-resized"><img src="<?php echo esc_url( get_template_directory_uri() ); ?>/assets/images/icons/globe.svg" alt="" style="width:40px;height:40px"/></figure>
			<!-- /wp:image -->

			<!-- wp:heading {"level":3,"fontSize":"large"} -->
			<h3 class="wp-block-heading has-large-font-size"><?php esc_html_e( 'Any language', 'pressbase' ); ?></h3>
			<!-- /wp:heading -->

			<!-- wp:paragraph {"textColor":"muted","fontSize":"small"} -->
			<p class="has-muted-color has-text-color has-small-font-size"><?php esc_html_e( 'Translated screens and right-to-left layouts, out of the box.', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->
		</div>
		<!-- /wp:group -->
	</div>
	<!-- /wp:group -->
</div>
<!-- /wp:group -->
