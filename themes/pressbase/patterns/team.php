<?php
/**
 * Title: Team
 * Slug: pressbase/team
 * Categories: pressbase, team, about
 * Keywords: team, people, staff, about us
 * Viewport Width: 1400
 * Description: A heading and four people in lifted cards, with placeholder portraits, names and roles.
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:group {"metadata":{"name":"Team"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|70","bottom":"var:preset|spacing|70"},"blockGap":"var:preset|spacing|60"}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull" style="padding-top:var(--wp--preset--spacing--70);padding-bottom:var(--wp--preset--spacing--70)">
	<!-- wp:group {"className":"is-style-reveal","style":{"spacing":{"blockGap":"var:preset|spacing|30"}},"layout":{"type":"constrained","contentSize":"640px"}} -->
	<div class="wp-block-group is-style-reveal">
		<!-- wp:heading {"textAlign":"center"} -->
		<h2 class="wp-block-heading has-text-align-center"><?php echo wp_kses_post( __( 'A small team with <em>big</em> opinions.', 'pressbase' ) ); ?></h2>
		<!-- /wp:heading -->

		<!-- wp:paragraph {"align":"center","textColor":"muted"} -->
		<p class="has-text-align-center has-muted-color has-text-color"><?php esc_html_e( 'We write, design and ship from four time zones, and read every message ourselves.', 'pressbase' ); ?></p>
		<!-- /wp:paragraph -->
	</div>
	<!-- /wp:group -->

	<!-- wp:group {"align":"wide","className":"is-style-reveal","style":{"spacing":{"blockGap":"var:preset|spacing|40"}},"layout":{"type":"grid","columnCount":4,"minimumColumnWidth":"12rem"}} -->
	<div class="wp-block-group alignwide is-style-reveal">
		<!-- wp:group {"className":"is-style-lift","style":{"spacing":{"padding":{"top":"var:preset|spacing|30","bottom":"var:preset|spacing|40","left":"var:preset|spacing|30","right":"var:preset|spacing|30"},"blockGap":"var:preset|spacing|20"}},"layout":{"type":"default"}} -->
		<div class="wp-block-group is-style-lift" style="padding-top:var(--wp--preset--spacing--30);padding-right:var(--wp--preset--spacing--30);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--30)">
			<!-- wp:image {"aspectRatio":"1","scale":"cover","sizeSlug":"full","linkDestination":"none","style":{"border":{"radius":"var:preset|border-radius|md"},"spacing":{"margin":{"bottom":"var:preset|spacing|30"}}}} -->
			<figure class="wp-block-image size-full has-custom-border" style="margin-bottom:var(--wp--preset--spacing--30)"><img src="<?php echo esc_url( get_template_directory_uri() ); ?>/assets/images/portrait-1.svg" alt="<?php esc_attr_e( 'Placeholder portrait', 'pressbase' ); ?>" style="border-radius:var(--wp--preset--border-radius--md);aspect-ratio:1;object-fit:cover"/></figure>
			<!-- /wp:image -->

			<!-- wp:heading {"level":3,"fontSize":"large"} -->
			<h3 class="wp-block-heading has-large-font-size"><?php esc_html_e( 'Team member name', 'pressbase' ); ?></h3>
			<!-- /wp:heading -->

			<!-- wp:paragraph {"textColor":"muted","fontSize":"small"} -->
			<p class="has-muted-color has-text-color has-small-font-size"><?php esc_html_e( 'Founder and editor', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->
		</div>
		<!-- /wp:group -->

		<!-- wp:group {"className":"is-style-lift","style":{"spacing":{"padding":{"top":"var:preset|spacing|30","bottom":"var:preset|spacing|40","left":"var:preset|spacing|30","right":"var:preset|spacing|30"},"blockGap":"var:preset|spacing|20"}},"layout":{"type":"default"}} -->
		<div class="wp-block-group is-style-lift" style="padding-top:var(--wp--preset--spacing--30);padding-right:var(--wp--preset--spacing--30);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--30)">
			<!-- wp:image {"aspectRatio":"1","scale":"cover","sizeSlug":"full","linkDestination":"none","style":{"border":{"radius":"var:preset|border-radius|md"},"spacing":{"margin":{"bottom":"var:preset|spacing|30"}}}} -->
			<figure class="wp-block-image size-full has-custom-border" style="margin-bottom:var(--wp--preset--spacing--30)"><img src="<?php echo esc_url( get_template_directory_uri() ); ?>/assets/images/portrait-2.svg" alt="<?php esc_attr_e( 'Placeholder portrait', 'pressbase' ); ?>" style="border-radius:var(--wp--preset--border-radius--md);aspect-ratio:1;object-fit:cover"/></figure>
			<!-- /wp:image -->

			<!-- wp:heading {"level":3,"fontSize":"large"} -->
			<h3 class="wp-block-heading has-large-font-size"><?php esc_html_e( 'Team member name', 'pressbase' ); ?></h3>
			<!-- /wp:heading -->

			<!-- wp:paragraph {"textColor":"muted","fontSize":"small"} -->
			<p class="has-muted-color has-text-color has-small-font-size"><?php esc_html_e( 'Head of design', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->
		</div>
		<!-- /wp:group -->

		<!-- wp:group {"className":"is-style-lift","style":{"spacing":{"padding":{"top":"var:preset|spacing|30","bottom":"var:preset|spacing|40","left":"var:preset|spacing|30","right":"var:preset|spacing|30"},"blockGap":"var:preset|spacing|20"}},"layout":{"type":"default"}} -->
		<div class="wp-block-group is-style-lift" style="padding-top:var(--wp--preset--spacing--30);padding-right:var(--wp--preset--spacing--30);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--30)">
			<!-- wp:image {"aspectRatio":"1","scale":"cover","sizeSlug":"full","linkDestination":"none","style":{"border":{"radius":"var:preset|border-radius|md"},"spacing":{"margin":{"bottom":"var:preset|spacing|30"}}}} -->
			<figure class="wp-block-image size-full has-custom-border" style="margin-bottom:var(--wp--preset--spacing--30)"><img src="<?php echo esc_url( get_template_directory_uri() ); ?>/assets/images/portrait-3.svg" alt="<?php esc_attr_e( 'Placeholder portrait', 'pressbase' ); ?>" style="border-radius:var(--wp--preset--border-radius--md);aspect-ratio:1;object-fit:cover"/></figure>
			<!-- /wp:image -->

			<!-- wp:heading {"level":3,"fontSize":"large"} -->
			<h3 class="wp-block-heading has-large-font-size"><?php esc_html_e( 'Team member name', 'pressbase' ); ?></h3>
			<!-- /wp:heading -->

			<!-- wp:paragraph {"textColor":"muted","fontSize":"small"} -->
			<p class="has-muted-color has-text-color has-small-font-size"><?php esc_html_e( 'Lead engineer', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->
		</div>
		<!-- /wp:group -->

		<!-- wp:group {"className":"is-style-lift","style":{"spacing":{"padding":{"top":"var:preset|spacing|30","bottom":"var:preset|spacing|40","left":"var:preset|spacing|30","right":"var:preset|spacing|30"},"blockGap":"var:preset|spacing|20"}},"layout":{"type":"default"}} -->
		<div class="wp-block-group is-style-lift" style="padding-top:var(--wp--preset--spacing--30);padding-right:var(--wp--preset--spacing--30);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--30)">
			<!-- wp:image {"aspectRatio":"1","scale":"cover","sizeSlug":"full","linkDestination":"none","style":{"border":{"radius":"var:preset|border-radius|md"},"spacing":{"margin":{"bottom":"var:preset|spacing|30"}}}} -->
			<figure class="wp-block-image size-full has-custom-border" style="margin-bottom:var(--wp--preset--spacing--30)"><img src="<?php echo esc_url( get_template_directory_uri() ); ?>/assets/images/portrait-4.svg" alt="<?php esc_attr_e( 'Placeholder portrait', 'pressbase' ); ?>" style="border-radius:var(--wp--preset--border-radius--md);aspect-ratio:1;object-fit:cover"/></figure>
			<!-- /wp:image -->

			<!-- wp:heading {"level":3,"fontSize":"large"} -->
			<h3 class="wp-block-heading has-large-font-size"><?php esc_html_e( 'Team member name', 'pressbase' ); ?></h3>
			<!-- /wp:heading -->

			<!-- wp:paragraph {"textColor":"muted","fontSize":"small"} -->
			<p class="has-muted-color has-text-color has-small-font-size"><?php esc_html_e( 'Community and support', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->
		</div>
		<!-- /wp:group -->
	</div>
	<!-- /wp:group -->
</div>
<!-- /wp:group -->
