<?php
/**
 * Pressbase functions and definitions.
 *
 * Pressbase itself never runs this file: core reproduces its effects from the
 * `pressbase` entry in apps/core/src/themes/compat.ts. Keep the two in sync.
 *
 * @package Pressbase
 * @since 1.0.0
 */

if ( ! function_exists( 'pressbase_setup' ) ) :
	/**
	 * Loads the theme's stylesheet in the editors, so block styles look the same there.
	 *
	 * @since 1.0.0
	 *
	 * @return void
	 */
	function pressbase_setup() {
		add_editor_style( 'style.css' );
	}
endif;
add_action( 'after_setup_theme', 'pressbase_setup' );

if ( ! function_exists( 'pressbase_enqueue_styles' ) ) :
	/**
	 * Enqueues the theme stylesheet (motion, block styles) on the front.
	 *
	 * @since 1.0.0
	 *
	 * @return void
	 */
	function pressbase_enqueue_styles() {
		wp_enqueue_style(
			'pressbase-style',
			get_parent_theme_file_uri( 'style.css' ),
			array(),
			wp_get_theme()->get( 'Version' )
		);
		wp_style_add_data( 'pressbase-style', 'path', get_parent_theme_file_path( 'style.css' ) );
	}
endif;
add_action( 'wp_enqueue_scripts', 'pressbase_enqueue_styles' );

if ( ! function_exists( 'pressbase_block_styles' ) ) :
	/**
	 * Registers the theme's block styles. Their CSS is in style.css.
	 *
	 * @since 1.0.0
	 *
	 * @return void
	 */
	function pressbase_block_styles() {
		$styles = array(
			'core/group'     => array(
				'reveal'   => _x( 'Reveal', 'Block style name', 'pressbase' ),
				'lift'     => _x( 'Lift', 'Block style name', 'pressbase' ),
				'glass'    => _x( 'Glass', 'Block style name', 'pressbase' ),
				'gradient' => _x( 'Gradient', 'Block style name', 'pressbase' ),
				'marquee'  => _x( 'Marquee', 'Block style name', 'pressbase' ),
				'links'    => _x( 'Animated links', 'Block style name', 'pressbase' ),
			),
			'core/columns'   => array(
				'reveal' => _x( 'Reveal', 'Block style name', 'pressbase' ),
			),
			'core/column'    => array(
				'lift'  => _x( 'Lift', 'Block style name', 'pressbase' ),
				'glass' => _x( 'Glass', 'Block style name', 'pressbase' ),
			),
			'core/image'     => array(
				'reveal' => _x( 'Reveal', 'Block style name', 'pressbase' ),
			),
			'core/cover'     => array(
				'gradient' => _x( 'Gradient', 'Block style name', 'pressbase' ),
			),
			'core/paragraph' => array(
				'pill' => _x( 'Pill', 'Block style name', 'pressbase' ),
			),
		);

		foreach ( $styles as $block => $block_styles ) {
			foreach ( $block_styles as $name => $label ) {
				register_block_style(
					$block,
					array(
						'name'  => $name,
						'label' => $label,
					)
				);
			}
		}
	}
endif;
add_action( 'init', 'pressbase_block_styles' );

if ( ! function_exists( 'pressbase_pattern_categories' ) ) :
	/**
	 * Registers the theme's pattern categories.
	 *
	 * @since 1.0.0
	 *
	 * @return void
	 */
	function pressbase_pattern_categories() {
		register_block_pattern_category(
			'pressbase',
			array(
				'label'       => __( 'Pressbase', 'pressbase' ),
				'description' => __( 'Sections from the Pressbase theme: heroes, features, pricing and more.', 'pressbase' ),
			)
		);

		register_block_pattern_category(
			'pressbase_page',
			array(
				'label'       => __( 'Pages', 'pressbase' ),
				'description' => __( 'Full page layouts.', 'pressbase' ),
			)
		);
	}
endif;
add_action( 'init', 'pressbase_pattern_categories' );
