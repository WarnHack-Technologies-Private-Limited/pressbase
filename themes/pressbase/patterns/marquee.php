<?php
/**
 * Title: Marquee strip
 * Slug: pressbase/marquee
 * Categories: pressbase, banner
 * Keywords: logos, marquee, strip, ticker, clients
 * Viewport Width: 1400
 * Description: A strip of words that glides sideways as the page scrolls. It wraps, and stays still, where scroll-driven animation isn't available or motion is reduced.
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:group {"metadata":{"name":"Marquee"},"align":"full","className":"is-style-marquee","style":{"spacing":{"padding":{"top":"var:preset|spacing|50","bottom":"var:preset|spacing|50"},"blockGap":"var:preset|spacing|30"},"border":{"top":{"color":"var:preset|color|border","style":"solid","width":"1px"},"bottom":{"color":"var:preset|color|border","style":"solid","width":"1px"}}},"layout":{"type":"default"}} -->
<div class="wp-block-group alignfull is-style-marquee" style="border-top-color:var(--wp--preset--color--border);border-top-style:solid;border-top-width:1px;border-bottom-color:var(--wp--preset--color--border);border-bottom-style:solid;border-bottom-width:1px;padding-top:var(--wp--preset--spacing--50);padding-bottom:var(--wp--preset--spacing--50)">
	<!-- wp:paragraph {"align":"center","textColor":"muted","fontSize":"small"} -->
	<p class="has-text-align-center has-muted-color has-text-color has-small-font-size"><?php esc_html_e( 'One platform for every kind of site', 'pressbase' ); ?></p>
	<!-- /wp:paragraph -->

	<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|50"}},"fontSize":"xx-large","fontFamily":"platypi","layout":{"type":"flex","flexWrap":"wrap"}} -->
	<div class="wp-block-group has-platypi-font-family has-xx-large-font-size">
		<!-- wp:paragraph -->
		<p><em><?php esc_html_e( 'Magazines', 'pressbase' ); ?></em></p>
		<!-- /wp:paragraph -->

		<!-- wp:paragraph {"textColor":"accent"} -->
		<p class="has-accent-color has-text-color">/</p>
		<!-- /wp:paragraph -->

		<!-- wp:paragraph -->
		<p><?php esc_html_e( 'Newsletters', 'pressbase' ); ?></p>
		<!-- /wp:paragraph -->

		<!-- wp:paragraph {"textColor":"accent"} -->
		<p class="has-accent-color has-text-color">/</p>
		<!-- /wp:paragraph -->

		<!-- wp:paragraph -->
		<p><em><?php esc_html_e( 'Portfolios', 'pressbase' ); ?></em></p>
		<!-- /wp:paragraph -->

		<!-- wp:paragraph {"textColor":"accent"} -->
		<p class="has-accent-color has-text-color">/</p>
		<!-- /wp:paragraph -->

		<!-- wp:paragraph -->
		<p><?php esc_html_e( 'Documentation', 'pressbase' ); ?></p>
		<!-- /wp:paragraph -->

		<!-- wp:paragraph {"textColor":"accent"} -->
		<p class="has-accent-color has-text-color">/</p>
		<!-- /wp:paragraph -->

		<!-- wp:paragraph -->
		<p><em><?php esc_html_e( 'Shops', 'pressbase' ); ?></em></p>
		<!-- /wp:paragraph -->

		<!-- wp:paragraph {"textColor":"accent"} -->
		<p class="has-accent-color has-text-color">/</p>
		<!-- /wp:paragraph -->

		<!-- wp:paragraph -->
		<p><?php esc_html_e( 'Podcasts', 'pressbase' ); ?></p>
		<!-- /wp:paragraph -->

		<!-- wp:paragraph {"textColor":"accent"} -->
		<p class="has-accent-color has-text-color">/</p>
		<!-- /wp:paragraph -->

		<!-- wp:paragraph -->
		<p><em><?php esc_html_e( 'Landing pages', 'pressbase' ); ?></em></p>
		<!-- /wp:paragraph -->

		<!-- wp:paragraph {"textColor":"accent"} -->
		<p class="has-accent-color has-text-color">/</p>
		<!-- /wp:paragraph -->

		<!-- wp:paragraph -->
		<p><?php esc_html_e( 'Personal blogs', 'pressbase' ); ?></p>
		<!-- /wp:paragraph -->
	</div>
	<!-- /wp:group -->
</div>
<!-- /wp:group -->
