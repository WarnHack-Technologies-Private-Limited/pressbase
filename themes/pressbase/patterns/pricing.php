<?php
/**
 * Title: Pricing, three tiers
 * Slug: pressbase/pricing
 * Categories: pressbase, call-to-action, services
 * Keywords: pricing, plans, tiers, subscription
 * Viewport Width: 1400
 * Description: Three plans side by side; the middle one is highlighted on an ink card.
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:group {"metadata":{"name":"Pricing"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|80","bottom":"var:preset|spacing|70"},"blockGap":"var:preset|spacing|60"}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull" style="padding-top:var(--wp--preset--spacing--80);padding-bottom:var(--wp--preset--spacing--70)">
	<!-- wp:group {"className":"is-style-reveal","style":{"spacing":{"blockGap":"var:preset|spacing|30"}},"layout":{"type":"constrained","contentSize":"640px"}} -->
	<div class="wp-block-group is-style-reveal">
		<!-- wp:heading {"textAlign":"center"} -->
		<h2 class="wp-block-heading has-text-align-center"><?php echo wp_kses_post( __( 'Simple plans that <em>grow</em> with you.', 'pressbase' ) ); ?></h2>
		<!-- /wp:heading -->

		<!-- wp:paragraph {"align":"center","textColor":"muted"} -->
		<p class="has-text-align-center has-muted-color has-text-color"><?php esc_html_e( 'Start free, upgrade when you need to, cancel whenever you like.', 'pressbase' ); ?></p>
		<!-- /wp:paragraph -->
	</div>
	<!-- /wp:group -->

	<!-- wp:columns {"align":"wide","className":"is-style-reveal","style":{"spacing":{"blockGap":{"top":"var:preset|spacing|40","left":"var:preset|spacing|40"}}}} -->
	<div class="wp-block-columns alignwide is-style-reveal">
		<!-- wp:column {"className":"is-style-lift","style":{"spacing":{"padding":{"top":"var:preset|spacing|50","bottom":"var:preset|spacing|50","left":"var:preset|spacing|40","right":"var:preset|spacing|40"},"blockGap":"var:preset|spacing|30"}}} -->
		<div class="wp-block-column is-style-lift" style="padding-top:var(--wp--preset--spacing--50);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--50);padding-left:var(--wp--preset--spacing--40)">
			<!-- wp:heading {"level":3,"fontSize":"large","fontFamily":"manrope","style":{"typography":{"fontWeight":"700"}}} -->
			<h3 class="wp-block-heading has-manrope-font-family has-large-font-size" style="font-weight:700"><?php esc_html_e( 'Starter', 'pressbase' ); ?></h3>
			<!-- /wp:heading -->

			<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|20"}},"layout":{"type":"flex","flexWrap":"nowrap","verticalAlignment":"bottom"}} -->
			<div class="wp-block-group">
				<!-- wp:paragraph {"fontSize":"xxx-large","fontFamily":"platypi","style":{"typography":{"lineHeight":"1","fontWeight":"600"}}} -->
				<p class="has-platypi-font-family has-xxx-large-font-size" style="font-weight:600;line-height:1"><?php esc_html_e( 'Free', 'pressbase' ); ?></p>
				<!-- /wp:paragraph -->

				<!-- wp:paragraph {"fontSize":"small"} -->
				<p class="has-small-font-size"><?php esc_html_e( 'forever', 'pressbase' ); ?></p>
				<!-- /wp:paragraph -->
			</div>
			<!-- /wp:group -->

			<!-- wp:paragraph -->
			<p><?php esc_html_e( 'For personal sites and first experiments.', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->

			<!-- wp:separator {"className":"is-style-wide"} -->
			<hr class="wp-block-separator has-alpha-channel-opacity is-style-wide"/>
			<!-- /wp:separator -->

			<!-- wp:list {"fontSize":"small"} -->
			<ul class="wp-block-list has-small-font-size">
				<!-- wp:list-item -->
				<li><?php esc_html_e( 'One site', 'pressbase' ); ?></li>
				<!-- /wp:list-item -->

				<!-- wp:list-item -->
				<li><?php esc_html_e( 'Every theme and pattern', 'pressbase' ); ?></li>
				<!-- /wp:list-item -->

				<!-- wp:list-item -->
				<li><?php esc_html_e( 'Community support', 'pressbase' ); ?></li>
				<!-- /wp:list-item -->
			</ul>
			<!-- /wp:list -->

			<!-- wp:buttons {"style":{"spacing":{"margin":{"top":"var:preset|spacing|40"}}}} -->
			<div class="wp-block-buttons" style="margin-top:var(--wp--preset--spacing--40)">
				<!-- wp:button {"width":100,"className":"is-style-outline"} -->
				<div class="wp-block-button has-custom-width wp-block-button__width-100 is-style-outline"><a class="wp-block-button__link wp-element-button" href="#"><?php esc_html_e( 'Start for free', 'pressbase' ); ?></a></div>
				<!-- /wp:button -->
			</div>
			<!-- /wp:buttons -->
		</div>
		<!-- /wp:column -->

		<!-- wp:column {"className":"is-style-section-ink","style":{"spacing":{"padding":{"top":"var:preset|spacing|50","bottom":"var:preset|spacing|50","left":"var:preset|spacing|40","right":"var:preset|spacing|40"},"blockGap":"var:preset|spacing|30"},"border":{"radius":"var:preset|border-radius|lg"}}} -->
		<div class="wp-block-column is-style-section-ink" style="border-radius:var(--wp--preset--border-radius--lg);padding-top:var(--wp--preset--spacing--50);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--50);padding-left:var(--wp--preset--spacing--40)">
			<!-- wp:paragraph {"className":"is-style-pill"} -->
			<p class="is-style-pill"><?php esc_html_e( 'Most popular', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->

			<!-- wp:heading {"level":3,"fontSize":"large","fontFamily":"manrope","style":{"typography":{"fontWeight":"700"}}} -->
			<h3 class="wp-block-heading has-manrope-font-family has-large-font-size" style="font-weight:700"><?php esc_html_e( 'Studio', 'pressbase' ); ?></h3>
			<!-- /wp:heading -->

			<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|20"}},"layout":{"type":"flex","flexWrap":"nowrap","verticalAlignment":"bottom"}} -->
			<div class="wp-block-group">
				<!-- wp:paragraph {"fontSize":"xxx-large","fontFamily":"platypi","style":{"typography":{"lineHeight":"1","fontWeight":"600"}}} -->
				<p class="has-platypi-font-family has-xxx-large-font-size" style="font-weight:600;line-height:1"><?php esc_html_e( '$12', 'pressbase' ); ?></p>
				<!-- /wp:paragraph -->

				<!-- wp:paragraph {"fontSize":"small"} -->
				<p class="has-small-font-size"><?php esc_html_e( 'per month', 'pressbase' ); ?></p>
				<!-- /wp:paragraph -->
			</div>
			<!-- /wp:group -->

			<!-- wp:paragraph -->
			<p><?php esc_html_e( 'For creators who publish every week.', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->

			<!-- wp:separator {"className":"is-style-wide"} -->
			<hr class="wp-block-separator has-alpha-channel-opacity is-style-wide"/>
			<!-- /wp:separator -->

			<!-- wp:list {"fontSize":"small"} -->
			<ul class="wp-block-list has-small-font-size">
				<!-- wp:list-item -->
				<li><?php esc_html_e( 'Five sites', 'pressbase' ); ?></li>
				<!-- /wp:list-item -->

				<!-- wp:list-item -->
				<li><?php esc_html_e( 'Custom domains', 'pressbase' ); ?></li>
				<!-- /wp:list-item -->

				<!-- wp:list-item -->
				<li><?php esc_html_e( 'Newsletters and analytics', 'pressbase' ); ?></li>
				<!-- /wp:list-item -->

				<!-- wp:list-item -->
				<li><?php esc_html_e( 'Priority support', 'pressbase' ); ?></li>
				<!-- /wp:list-item -->
			</ul>
			<!-- /wp:list -->

			<!-- wp:buttons {"style":{"spacing":{"margin":{"top":"var:preset|spacing|40"}}}} -->
			<div class="wp-block-buttons" style="margin-top:var(--wp--preset--spacing--40)">
				<!-- wp:button {"width":100} -->
				<div class="wp-block-button has-custom-width wp-block-button__width-100"><a class="wp-block-button__link wp-element-button" href="#"><?php esc_html_e( 'Choose Studio', 'pressbase' ); ?></a></div>
				<!-- /wp:button -->
			</div>
			<!-- /wp:buttons -->
		</div>
		<!-- /wp:column -->

		<!-- wp:column {"className":"is-style-lift","style":{"spacing":{"padding":{"top":"var:preset|spacing|50","bottom":"var:preset|spacing|50","left":"var:preset|spacing|40","right":"var:preset|spacing|40"},"blockGap":"var:preset|spacing|30"}}} -->
		<div class="wp-block-column is-style-lift" style="padding-top:var(--wp--preset--spacing--50);padding-right:var(--wp--preset--spacing--40);padding-bottom:var(--wp--preset--spacing--50);padding-left:var(--wp--preset--spacing--40)">
			<!-- wp:heading {"level":3,"fontSize":"large","fontFamily":"manrope","style":{"typography":{"fontWeight":"700"}}} -->
			<h3 class="wp-block-heading has-manrope-font-family has-large-font-size" style="font-weight:700"><?php esc_html_e( 'Team', 'pressbase' ); ?></h3>
			<!-- /wp:heading -->

			<!-- wp:group {"style":{"spacing":{"blockGap":"var:preset|spacing|20"}},"layout":{"type":"flex","flexWrap":"nowrap","verticalAlignment":"bottom"}} -->
			<div class="wp-block-group">
				<!-- wp:paragraph {"fontSize":"xxx-large","fontFamily":"platypi","style":{"typography":{"lineHeight":"1","fontWeight":"600"}}} -->
				<p class="has-platypi-font-family has-xxx-large-font-size" style="font-weight:600;line-height:1"><?php esc_html_e( '$39', 'pressbase' ); ?></p>
				<!-- /wp:paragraph -->

				<!-- wp:paragraph {"fontSize":"small"} -->
				<p class="has-small-font-size"><?php esc_html_e( 'per month', 'pressbase' ); ?></p>
				<!-- /wp:paragraph -->
			</div>
			<!-- /wp:group -->

			<!-- wp:paragraph -->
			<p><?php esc_html_e( 'For newsrooms, docs teams and agencies.', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->

			<!-- wp:separator {"className":"is-style-wide"} -->
			<hr class="wp-block-separator has-alpha-channel-opacity is-style-wide"/>
			<!-- /wp:separator -->

			<!-- wp:list {"fontSize":"small"} -->
			<ul class="wp-block-list has-small-font-size">
				<!-- wp:list-item -->
				<li><?php esc_html_e( 'Unlimited sites', 'pressbase' ); ?></li>
				<!-- /wp:list-item -->

				<!-- wp:list-item -->
				<li><?php esc_html_e( 'Roles and review flows', 'pressbase' ); ?></li>
				<!-- /wp:list-item -->

				<!-- wp:list-item -->
				<li><?php esc_html_e( 'Single sign-on', 'pressbase' ); ?></li>
				<!-- /wp:list-item -->
			</ul>
			<!-- /wp:list -->

			<!-- wp:buttons {"style":{"spacing":{"margin":{"top":"var:preset|spacing|40"}}}} -->
			<div class="wp-block-buttons" style="margin-top:var(--wp--preset--spacing--40)">
				<!-- wp:button {"width":100,"className":"is-style-outline"} -->
				<div class="wp-block-button has-custom-width wp-block-button__width-100 is-style-outline"><a class="wp-block-button__link wp-element-button" href="#"><?php esc_html_e( 'Talk to us', 'pressbase' ); ?></a></div>
				<!-- /wp:button -->
			</div>
			<!-- /wp:buttons -->
		</div>
		<!-- /wp:column -->
	</div>
	<!-- /wp:columns -->
</div>
<!-- /wp:group -->
