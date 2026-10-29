<?php
/**
 * Title: Testimonials
 * Slug: pressbase/testimonials
 * Categories: pressbase, testimonials
 * Keywords: quotes, reviews, customers, testimonials
 * Viewport Width: 1400
 * Description: Three quotes in lifted cards, each with a placeholder portrait, a name and a role.
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:group {"metadata":{"name":"Testimonials"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|80","bottom":"var:preset|spacing|70"},"blockGap":"var:preset|spacing|60"}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull" style="padding-top:var(--wp--preset--spacing--80);padding-bottom:var(--wp--preset--spacing--70)">
	<!-- wp:heading {"textAlign":"center","className":"is-style-reveal"} -->
	<h2 class="wp-block-heading has-text-align-center is-style-reveal"><?php echo wp_kses_post( __( 'Loved by people who <em>write</em> for a living.', 'pressbase' ) ); ?></h2>
	<!-- /wp:heading -->

	<!-- wp:columns {"align":"wide","className":"is-style-reveal"} -->
	<div class="wp-block-columns alignwide is-style-reveal">
		<!-- wp:column {"className":"is-style-lift","style":{"spacing":{"padding":{"top":"var:preset|spacing|40","bottom":"var:preset|spacing|40","left":"var:preset|spacing|40","right":"var:preset|spacing|40"},"blockGap":"var:preset|spacing|40"}}} -->
		<div class="wp-block-column is-style-lift" style="padding-top:var(--wp--preset--spacing--40);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--40)">
			<!-- wp:paragraph {"fontSize":"large","fontFamily":"platypi"} -->
			<p class="has-platypi-font-family has-large-font-size"><?php esc_html_e( '“We moved our newsroom over in an afternoon. Pages load instantly and the editors stopped asking me for help.”', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->

			<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|30"}},"layout":{"type":"flex","flexWrap":"nowrap"}} -->
			<div class="wp-block-group">
				<!-- wp:image {"width":"48px","height":"48px","scale":"cover","sizeSlug":"full","linkDestination":"none","style":{"border":{"radius":"var:preset|border-radius|full"}}} -->
				<figure class="wp-block-image size-full is-resized has-custom-border"><img src="<?php echo esc_url( get_template_directory_uri() ); ?>/assets/images/portrait-1.svg" alt="" style="border-radius:var(--wp--preset--border-radius--full);object-fit:cover;width:48px;height:48px"/></figure>
				<!-- /wp:image -->

				<!-- wp:group {"style":{"spacing":{"blockGap":"0"}},"layout":{"type":"flex","orientation":"vertical"}} -->
				<div class="wp-block-group">
					<!-- wp:paragraph {"fontSize":"small","style":{"typography":{"fontWeight":"600"}}} -->
					<p class="has-small-font-size" style="font-weight:600"><?php esc_html_e( 'Customer name', 'pressbase' ); ?></p>
					<!-- /wp:paragraph -->

					<!-- wp:paragraph {"textColor":"muted","fontSize":"small"} -->
					<p class="has-muted-color has-text-color has-small-font-size"><?php esc_html_e( 'Managing editor, Company name', 'pressbase' ); ?></p>
					<!-- /wp:paragraph -->
				</div>
				<!-- /wp:group -->
			</div>
			<!-- /wp:group -->
		</div>
		<!-- /wp:column -->

		<!-- wp:column {"className":"is-style-lift","style":{"spacing":{"padding":{"top":"var:preset|spacing|40","bottom":"var:preset|spacing|40","left":"var:preset|spacing|40","right":"var:preset|spacing|40"},"blockGap":"var:preset|spacing|40"}}} -->
		<div class="wp-block-column is-style-lift" style="padding-top:var(--wp--preset--spacing--40);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--40)">
			<!-- wp:paragraph {"fontSize":"large","fontFamily":"platypi"} -->
			<p class="has-platypi-font-family has-large-font-size"><?php esc_html_e( '“The first platform where the defaults already look the way I would have designed them.”', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->

			<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|30"}},"layout":{"type":"flex","flexWrap":"nowrap"}} -->
			<div class="wp-block-group">
				<!-- wp:image {"width":"48px","height":"48px","scale":"cover","sizeSlug":"full","linkDestination":"none","style":{"border":{"radius":"var:preset|border-radius|full"}}} -->
				<figure class="wp-block-image size-full is-resized has-custom-border"><img src="<?php echo esc_url( get_template_directory_uri() ); ?>/assets/images/portrait-2.svg" alt="" style="border-radius:var(--wp--preset--border-radius--full);object-fit:cover;width:48px;height:48px"/></figure>
				<!-- /wp:image -->

				<!-- wp:group {"style":{"spacing":{"blockGap":"0"}},"layout":{"type":"flex","orientation":"vertical"}} -->
				<div class="wp-block-group">
					<!-- wp:paragraph {"fontSize":"small","style":{"typography":{"fontWeight":"600"}}} -->
					<p class="has-small-font-size" style="font-weight:600"><?php esc_html_e( 'Customer name', 'pressbase' ); ?></p>
					<!-- /wp:paragraph -->

					<!-- wp:paragraph {"textColor":"muted","fontSize":"small"} -->
					<p class="has-muted-color has-text-color has-small-font-size"><?php esc_html_e( 'Designer, Studio name', 'pressbase' ); ?></p>
					<!-- /wp:paragraph -->
				</div>
				<!-- /wp:group -->
			</div>
			<!-- /wp:group -->
		</div>
		<!-- /wp:column -->

		<!-- wp:column {"className":"is-style-lift","style":{"spacing":{"padding":{"top":"var:preset|spacing|40","bottom":"var:preset|spacing|40","left":"var:preset|spacing|40","right":"var:preset|spacing|40"},"blockGap":"var:preset|spacing|40"}}} -->
		<div class="wp-block-column is-style-lift" style="padding-top:var(--wp--preset--spacing--40);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--40);padding-left:var(--wp--preset--spacing--40)">
			<!-- wp:paragraph {"fontSize":"large","fontFamily":"platypi"} -->
			<p class="has-platypi-font-family has-large-font-size"><?php esc_html_e( '“Our docs, blog and changelog finally live in one place, and it is fast everywhere our readers are.”', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->

			<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|30"}},"layout":{"type":"flex","flexWrap":"nowrap"}} -->
			<div class="wp-block-group">
				<!-- wp:image {"width":"48px","height":"48px","scale":"cover","sizeSlug":"full","linkDestination":"none","style":{"border":{"radius":"var:preset|border-radius|full"}}} -->
				<figure class="wp-block-image size-full is-resized has-custom-border"><img src="<?php echo esc_url( get_template_directory_uri() ); ?>/assets/images/portrait-3.svg" alt="" style="border-radius:var(--wp--preset--border-radius--full);object-fit:cover;width:48px;height:48px"/></figure>
				<!-- /wp:image -->

				<!-- wp:group {"style":{"spacing":{"blockGap":"0"}},"layout":{"type":"flex","orientation":"vertical"}} -->
				<div class="wp-block-group">
					<!-- wp:paragraph {"fontSize":"small","style":{"typography":{"fontWeight":"600"}}} -->
					<p class="has-small-font-size" style="font-weight:600"><?php esc_html_e( 'Customer name', 'pressbase' ); ?></p>
					<!-- /wp:paragraph -->

					<!-- wp:paragraph {"textColor":"muted","fontSize":"small"} -->
					<p class="has-muted-color has-text-color has-small-font-size"><?php esc_html_e( 'Head of docs, Company name', 'pressbase' ); ?></p>
					<!-- /wp:paragraph -->
				</div>
				<!-- /wp:group -->
			</div>
			<!-- /wp:group -->
		</div>
		<!-- /wp:column -->
	</div>
	<!-- /wp:columns -->
</div>
<!-- /wp:group -->
