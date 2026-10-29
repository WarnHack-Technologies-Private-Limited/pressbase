<?php
/**
 * Title: Questions and answers
 * Slug: pressbase/faq
 * Categories: pressbase, text, about
 * Keywords: faq, questions, answers, details, accordion
 * Viewport Width: 1400
 * Description: A heading beside a list of questions that open to show their answers.
 *
 * @package Pressbase
 * @since 1.0.0
 */

?>
<!-- wp:group {"metadata":{"name":"Questions and answers"},"align":"full","style":{"spacing":{"padding":{"top":"var:preset|spacing|70","bottom":"var:preset|spacing|70"}}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull" style="padding-top:var(--wp--preset--spacing--70);padding-bottom:var(--wp--preset--spacing--70)">
	<!-- wp:columns {"align":"wide","style":{"spacing":{"blockGap":{"top":"var:preset|spacing|50","left":"var:preset|spacing|60"}}}} -->
	<div class="wp-block-columns alignwide">
		<!-- wp:column {"width":"38%"} -->
		<div class="wp-block-column" style="flex-basis:38%">
			<!-- wp:heading -->
			<h2 class="wp-block-heading"><?php echo wp_kses_post( __( 'Questions, <em>answered</em>.', 'pressbase' ) ); ?></h2>
			<!-- /wp:heading -->

			<!-- wp:paragraph {"textColor":"muted"} -->
			<p class="has-muted-color has-text-color"><?php esc_html_e( 'Something else on your mind? Write to us and a person will reply.', 'pressbase' ); ?></p>
			<!-- /wp:paragraph -->
		</div>
		<!-- /wp:column -->

		<!-- wp:column {"width":"62%"} -->
		<div class="wp-block-column" style="flex-basis:62%">
			<!-- wp:details -->
			<details class="wp-block-details"><summary><?php esc_html_e( 'Is there really a free plan?', 'pressbase' ); ?></summary><!-- wp:paragraph -->
			<p><?php esc_html_e( 'Yes. Personal sites are free for as long as you like, with every theme and pattern included. Paid plans add more sites, custom domains and team features.', 'pressbase' ); ?></p>
			<!-- /wp:paragraph --></details>
			<!-- /wp:details -->

			<!-- wp:details -->
			<details class="wp-block-details"><summary><?php esc_html_e( 'Can I bring my existing site?', 'pressbase' ); ?></summary><!-- wp:paragraph -->
			<p><?php esc_html_e( 'Export your content from WordPress and import the file. Posts, pages, media, categories and people come across, and old links redirect to their new homes.', 'pressbase' ); ?></p>
			<!-- /wp:paragraph --></details>
			<!-- /wp:details -->

			<!-- wp:details -->
			<details class="wp-block-details"><summary><?php esc_html_e( 'Do I need to know how to code?', 'pressbase' ); ?></summary><!-- wp:paragraph -->
			<p><?php esc_html_e( 'Not at all. Everything here is built from blocks you can click, type into and rearrange. Developers get a full API when they want one.', 'pressbase' ); ?></p>
			<!-- /wp:paragraph --></details>
			<!-- /wp:details -->

			<!-- wp:details -->
			<details class="wp-block-details"><summary><?php esc_html_e( 'How fast will my pages be?', 'pressbase' ); ?></summary><!-- wp:paragraph -->
			<p><?php esc_html_e( 'Pages are rendered on the server, cached, and ship without theme JavaScript, so most load in well under a second, even on a phone.', 'pressbase' ); ?></p>
			<!-- /wp:paragraph --></details>
			<!-- /wp:details -->

			<!-- wp:details -->
			<details class="wp-block-details"><summary><?php esc_html_e( 'Who owns my content?', 'pressbase' ); ?></summary><!-- wp:paragraph -->
			<p><?php esc_html_e( 'You do. Export everything at any time, in formats other tools understand.', 'pressbase' ); ?></p>
			<!-- /wp:paragraph --></details>
			<!-- /wp:details -->
		</div>
		<!-- /wp:column -->
	</div>
	<!-- /wp:columns -->
</div>
<!-- /wp:group -->
