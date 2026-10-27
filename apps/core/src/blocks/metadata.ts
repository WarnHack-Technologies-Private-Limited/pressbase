import type { BlockTypeArgs } from '@pressbase/blocks';

/**
 * block.json metadata of the server-rendered core blocks, copied from
 * WordPress 7.1.3 (wordpress/wp-includes/blocks/{name}/block.json, GPL-2.0-or-later).
 * The block-types endpoint returns it so the editor and the server agree on
 * attributes, context and supports. Generated; keep it in sync when updating
 * the WordPress reference rather than editing by hand.
 */
export const CORE_BLOCK_METADATA: Record<string, BlockTypeArgs & { name: string }> = {
  'core/archives': {
    apiVersion: 3,
    name: 'core/archives',
    title: 'Archives',
    category: 'widgets',
    description: 'Display a date archive of your posts.',
    textdomain: 'default',
    attributes: {
      displayAsDropdown: {
        type: 'boolean',
        default: false,
      },
      showLabel: {
        type: 'boolean',
        default: true,
      },
      showPostCounts: {
        type: 'boolean',
        default: false,
      },
      type: {
        type: 'string',
        default: 'monthly',
      },
    },
    supports: {
      anchor: true,
      align: true,
      __experimentalBorder: {
        radius: true,
        color: true,
        width: true,
        style: true,
      },
      html: false,
      spacing: {
        margin: true,
        padding: true,
        __experimentalDefaultControls: {
          margin: false,
          padding: false,
        },
      },
      typography: {
        fontSize: true,
        lineHeight: true,
        __experimentalFontFamily: true,
        __experimentalFontWeight: true,
        __experimentalFontStyle: true,
        __experimentalTextTransform: true,
        __experimentalTextDecoration: true,
        __experimentalLetterSpacing: true,
        __experimentalDefaultControls: {
          fontSize: true,
        },
      },
      color: {
        gradients: true,
        link: true,
        __experimentalDefaultControls: {
          background: true,
          text: true,
          link: true,
        },
      },
      interactivity: {
        clientNavigation: true,
      },
    },
  },
  'core/block': {
    apiVersion: 3,
    name: 'core/block',
    title: 'Pattern',
    category: 'reusable',
    description: 'Reuse this design across your site.',
    keywords: ['reusable'],
    textdomain: 'default',
    attributes: {
      ref: {
        type: 'number',
      },
      content: {
        type: 'object',
        default: {},
      },
    },
    providesContext: {
      'pattern/overrides': 'content',
    },
    supports: {
      customClassName: false,
      html: false,
      inserter: false,
      renaming: false,
      interactivity: {
        clientNavigation: true,
      },
      customCSS: false,
    },
  },
  'core/categories': {
    apiVersion: 3,
    name: 'core/categories',
    title: 'Terms List',
    category: 'widgets',
    description: 'Display a list of all terms of a given taxonomy.',
    keywords: ['categories'],
    textdomain: 'default',
    attributes: {
      taxonomy: {
        type: 'string',
        default: 'category',
      },
      displayAsDropdown: {
        type: 'boolean',
        default: false,
      },
      showHierarchy: {
        type: 'boolean',
        default: false,
      },
      showPostCounts: {
        type: 'boolean',
        default: false,
      },
      showOnlyTopLevel: {
        type: 'boolean',
        default: false,
      },
      showEmpty: {
        type: 'boolean',
        default: false,
      },
      label: {
        type: 'string',
        role: 'content',
      },
      showLabel: {
        type: 'boolean',
        default: true,
      },
    },
    usesContext: ['enhancedPagination'],
    supports: {
      anchor: true,
      align: true,
      html: false,
      spacing: {
        margin: true,
        padding: true,
        __experimentalDefaultControls: {
          margin: false,
          padding: false,
        },
      },
      typography: {
        fontSize: true,
        lineHeight: true,
        __experimentalFontFamily: true,
        __experimentalFontWeight: true,
        __experimentalFontStyle: true,
        __experimentalTextTransform: true,
        __experimentalTextDecoration: true,
        __experimentalLetterSpacing: true,
        __experimentalDefaultControls: {
          fontSize: true,
        },
      },
      color: {
        gradients: true,
        link: true,
        __experimentalDefaultControls: {
          background: true,
          text: true,
          link: true,
        },
      },
      interactivity: {
        clientNavigation: true,
      },
      __experimentalBorder: {
        radius: true,
        color: true,
        width: true,
        style: true,
        __experimentalDefaultControls: {
          radius: true,
          color: true,
          width: true,
          style: true,
        },
      },
    },
  },
  'core/latest-posts': {
    apiVersion: 3,
    name: 'core/latest-posts',
    title: 'Latest Posts',
    category: 'widgets',
    description: 'Display a list of your most recent posts.',
    keywords: ['recent posts'],
    textdomain: 'default',
    attributes: {
      categories: {
        type: 'array',
        items: {
          type: 'object',
        },
      },
      selectedAuthor: {
        type: 'number',
      },
      postsToShow: {
        type: 'number',
        default: 5,
      },
      displayPostContent: {
        type: 'boolean',
        default: false,
      },
      displayPostContentRadio: {
        type: 'string',
        default: 'excerpt',
      },
      excerptLength: {
        type: 'number',
        default: 55,
      },
      displayAuthor: {
        type: 'boolean',
        default: false,
      },
      displayPostDate: {
        type: 'boolean',
        default: false,
      },
      order: {
        type: 'string',
        default: 'desc',
      },
      orderBy: {
        type: 'string',
        default: 'date',
      },
      displayFeaturedImage: {
        type: 'boolean',
        default: false,
      },
      featuredImageAlign: {
        type: 'string',
        enum: ['left', 'center', 'right'],
      },
      featuredImageSizeSlug: {
        type: 'string',
        default: 'thumbnail',
      },
      featuredImageSizeWidth: {
        type: 'number',
        default: null,
      },
      featuredImageSizeHeight: {
        type: 'number',
        default: null,
      },
      addLinkToFeaturedImage: {
        type: 'boolean',
        default: false,
      },
    },
    supports: {
      anchor: true,
      align: true,
      html: false,
      layout: true,
      color: {
        gradients: true,
        link: true,
        __experimentalDefaultControls: {
          background: true,
          text: true,
          link: true,
        },
      },
      spacing: {
        margin: true,
        padding: true,
        blockGap: {
          __experimentalDefault: '1.25em',
        },
        __experimentalDefaultControls: {
          blockGap: true,
        },
      },
      typography: {
        fontSize: true,
        lineHeight: true,
        __experimentalFontFamily: true,
        __experimentalFontWeight: true,
        __experimentalFontStyle: true,
        __experimentalTextTransform: true,
        __experimentalTextDecoration: true,
        __experimentalLetterSpacing: true,
        __experimentalDefaultControls: {
          fontSize: true,
        },
      },
      __experimentalBorder: {
        radius: true,
        color: true,
        width: true,
        style: true,
        __experimentalDefaultControls: {
          radius: true,
          color: true,
          width: true,
          style: true,
        },
      },
      interactivity: {
        clientNavigation: true,
      },
    },
  },
  'core/loginout': {
    apiVersion: 3,
    name: 'core/loginout',
    title: 'Login/out',
    category: 'theme',
    description: 'Show login & logout links.',
    keywords: ['login', 'logout', 'form'],
    textdomain: 'default',
    attributes: {
      displayLoginAsForm: {
        type: 'boolean',
        default: false,
      },
      redirectToCurrent: {
        type: 'boolean',
        default: true,
      },
    },
    supports: {
      anchor: true,
      className: true,
      color: {
        background: true,
        text: false,
        gradients: true,
        link: true,
      },
      spacing: {
        margin: true,
        padding: true,
        __experimentalDefaultControls: {
          margin: false,
          padding: false,
        },
      },
      typography: {
        fontSize: true,
        lineHeight: true,
        __experimentalFontFamily: true,
        __experimentalFontWeight: true,
        __experimentalFontStyle: true,
        __experimentalTextTransform: true,
        __experimentalTextDecoration: true,
        __experimentalLetterSpacing: true,
        __experimentalDefaultControls: {
          fontSize: true,
        },
      },
      __experimentalBorder: {
        radius: true,
        color: true,
        width: true,
        style: true,
      },
      interactivity: {
        clientNavigation: true,
      },
    },
    example: {
      viewportWidth: 350,
    },
  },
  'core/page-list': {
    apiVersion: 3,
    name: 'core/page-list',
    title: 'Page List',
    category: 'widgets',
    allowedBlocks: ['core/page-list-item'],
    description: 'Display a list of all pages.',
    keywords: ['menu', 'navigation'],
    textdomain: 'default',
    attributes: {
      parentPageID: {
        type: 'integer',
        default: 0,
      },
    },
    usesContext: [
      'textColor',
      'customTextColor',
      'backgroundColor',
      'customBackgroundColor',
      'overlayTextColor',
      'customOverlayTextColor',
      'overlayBackgroundColor',
      'customOverlayBackgroundColor',
      'fontSize',
      'customFontSize',
      'showSubmenuIcon',
      'style',
      'openSubmenusOnClick',
      'submenuVisibility',
      'core/isInsideSubmenu',
    ],
    supports: {
      anchor: true,
      reusable: false,
      html: false,
      typography: {
        fontSize: true,
        lineHeight: true,
        __experimentalFontFamily: true,
        __experimentalFontWeight: true,
        __experimentalFontStyle: true,
        __experimentalTextTransform: true,
        __experimentalTextDecoration: true,
        __experimentalLetterSpacing: true,
        __experimentalDefaultControls: {
          fontSize: true,
        },
      },
      interactivity: {
        clientNavigation: true,
      },
      color: {
        text: true,
        background: true,
        link: true,
        gradients: true,
        __experimentalDefaultControls: {
          background: true,
          text: true,
          link: true,
        },
      },
      __experimentalBorder: {
        radius: true,
        color: true,
        width: true,
        style: true,
      },
      spacing: {
        padding: true,
        margin: true,
        __experimentalDefaultControls: {
          padding: false,
          margin: false,
        },
      },
      contentRole: true,
    },
  },
  'core/post-author-name': {
    apiVersion: 3,
    name: 'core/post-author-name',
    title: 'Author Name',
    category: 'theme',
    description: 'The author name.',
    textdomain: 'default',
    attributes: {
      isLink: {
        type: 'boolean',
        default: false,
        role: 'content',
      },
      linkTarget: {
        type: 'string',
        default: '_self',
        role: 'content',
      },
    },
    usesContext: ['postType', 'postId'],
    supports: {
      anchor: true,
      html: false,
      spacing: {
        margin: true,
        padding: true,
      },
      color: {
        gradients: true,
        link: true,
        __experimentalDefaultControls: {
          background: true,
          text: true,
          link: true,
        },
      },
      typography: {
        fontSize: true,
        lineHeight: true,
        textAlign: true,
        __experimentalFontFamily: true,
        __experimentalFontWeight: true,
        __experimentalFontStyle: true,
        __experimentalTextTransform: true,
        __experimentalTextDecoration: true,
        __experimentalLetterSpacing: true,
        __experimentalDefaultControls: {
          fontSize: true,
        },
      },
      interactivity: {
        clientNavigation: true,
      },
      __experimentalBorder: {
        radius: true,
        color: true,
        width: true,
        style: true,
        __experimentalDefaultControls: {
          radius: true,
          color: true,
          width: true,
          style: true,
        },
      },
    },
    example: {
      viewportWidth: 350,
    },
  },
  'core/post-date': {
    apiVersion: 3,
    name: 'core/post-date',
    title: 'Date',
    category: 'theme',
    description: 'Display a custom date.',
    textdomain: 'default',
    attributes: {
      datetime: {
        type: 'string',
        role: 'content',
      },
      format: {
        type: 'string',
      },
      isLink: {
        type: 'boolean',
        default: false,
        role: 'content',
      },
    },
    usesContext: ['postId', 'postType', 'queryId'],
    supports: {
      anchor: true,
      html: false,
      color: {
        gradients: true,
        link: true,
        __experimentalDefaultControls: {
          background: true,
          text: true,
          link: true,
        },
      },
      spacing: {
        margin: true,
        padding: true,
      },
      typography: {
        fontSize: true,
        lineHeight: true,
        textAlign: true,
        __experimentalFontFamily: true,
        __experimentalFontWeight: true,
        __experimentalFontStyle: true,
        __experimentalTextTransform: true,
        __experimentalTextDecoration: true,
        __experimentalLetterSpacing: true,
        __experimentalDefaultControls: {
          fontSize: true,
        },
      },
      interactivity: {
        clientNavigation: true,
      },
      __experimentalBorder: {
        radius: true,
        color: true,
        width: true,
        style: true,
        __experimentalDefaultControls: {
          radius: true,
          color: true,
          width: true,
          style: true,
        },
      },
    },
    example: {
      viewportWidth: 350,
    },
  },
  'core/post-excerpt': {
    apiVersion: 3,
    name: 'core/post-excerpt',
    title: 'Excerpt',
    category: 'theme',
    description: 'Display the excerpt.',
    textdomain: 'default',
    attributes: {
      moreText: {
        type: 'string',
        role: 'content',
      },
      showMoreOnNewLine: {
        type: 'boolean',
        default: true,
      },
      excerptLength: {
        type: 'number',
        default: 55,
      },
    },
    usesContext: ['postId', 'postType', 'queryId'],
    supports: {
      anchor: true,
      html: false,
      color: {
        gradients: true,
        link: true,
        __experimentalDefaultControls: {
          background: true,
          text: true,
          link: true,
        },
      },
      spacing: {
        margin: true,
        padding: true,
      },
      typography: {
        fontSize: true,
        lineHeight: true,
        textAlign: true,
        textColumns: true,
        __experimentalFontFamily: true,
        __experimentalFontWeight: true,
        __experimentalFontStyle: true,
        __experimentalTextTransform: true,
        __experimentalTextDecoration: true,
        __experimentalLetterSpacing: true,
        __experimentalDefaultControls: {
          fontSize: true,
        },
      },
      interactivity: {
        clientNavigation: true,
      },
      __experimentalBorder: {
        radius: true,
        color: true,
        width: true,
        style: true,
        __experimentalDefaultControls: {
          radius: true,
          color: true,
          width: true,
          style: true,
        },
      },
    },
    example: {
      viewportWidth: 350,
    },
  },
  'core/post-terms': {
    apiVersion: 3,
    name: 'core/post-terms',
    title: 'Post Terms',
    category: 'theme',
    description: 'Post terms.',
    textdomain: 'default',
    attributes: {
      term: {
        type: 'string',
      },
      separator: {
        type: 'string',
        default: ', ',
      },
      prefix: {
        type: 'string',
        default: '',
        role: 'content',
      },
      suffix: {
        type: 'string',
        default: '',
        role: 'content',
      },
    },
    usesContext: ['postId', 'postType'],
    supports: {
      anchor: true,
      html: false,
      color: {
        gradients: true,
        link: true,
        __experimentalDefaultControls: {
          background: true,
          text: true,
          link: true,
        },
      },
      spacing: {
        margin: true,
        padding: true,
      },
      typography: {
        fontSize: true,
        lineHeight: true,
        textAlign: true,
        __experimentalFontFamily: true,
        __experimentalFontWeight: true,
        __experimentalFontStyle: true,
        __experimentalTextTransform: true,
        __experimentalTextDecoration: true,
        __experimentalLetterSpacing: true,
        __experimentalDefaultControls: {
          fontSize: true,
        },
      },
      interactivity: {
        clientNavigation: true,
      },
      __experimentalBorder: {
        radius: true,
        color: true,
        width: true,
        style: true,
        __experimentalDefaultControls: {
          radius: true,
          color: true,
          width: true,
          style: true,
        },
      },
    },
    example: {
      viewportWidth: 350,
    },
  },
  'core/post-title': {
    apiVersion: 3,
    name: 'core/post-title',
    title: 'Title',
    category: 'theme',
    description: 'Displays the title of a post, page, or any other content-type.',
    textdomain: 'default',
    attributes: {
      level: {
        type: 'number',
        default: 2,
      },
      levelOptions: {
        type: 'array',
      },
      isLink: {
        type: 'boolean',
        default: false,
        role: 'content',
      },
      rel: {
        type: 'string',
        attribute: 'rel',
        default: '',
        role: 'content',
      },
      linkTarget: {
        type: 'string',
        default: '_self',
        role: 'content',
      },
      placeholder: {
        type: 'string',
      },
    },
    usesContext: ['postId', 'postType', 'queryId'],
    supports: {
      anchor: true,
      align: ['wide', 'full'],
      html: false,
      color: {
        gradients: true,
        link: true,
        __experimentalDefaultControls: {
          background: true,
          text: true,
          link: true,
        },
      },
      spacing: {
        margin: true,
        padding: true,
      },
      typography: {
        fontSize: true,
        lineHeight: true,
        textAlign: true,
        __experimentalFontFamily: true,
        __experimentalFontWeight: true,
        __experimentalFontStyle: true,
        __experimentalTextTransform: true,
        __experimentalTextDecoration: true,
        __experimentalLetterSpacing: true,
        __experimentalDefaultControls: {
          fontSize: true,
        },
      },
      interactivity: {
        clientNavigation: true,
      },
      __experimentalBorder: {
        radius: true,
        color: true,
        width: true,
        style: true,
        __experimentalDefaultControls: {
          radius: true,
          color: true,
          width: true,
          style: true,
        },
      },
    },
    example: {
      viewportWidth: 350,
    },
  },
  'core/search': {
    apiVersion: 3,
    name: 'core/search',
    title: 'Search',
    category: 'widgets',
    description: 'Help visitors find your content.',
    keywords: ['find'],
    textdomain: 'default',
    attributes: {
      label: {
        type: 'string',
        role: 'content',
      },
      showLabel: {
        type: 'boolean',
        default: true,
      },
      placeholder: {
        type: 'string',
        default: '',
        role: 'content',
      },
      width: {
        type: 'number',
      },
      widthUnit: {
        type: 'string',
      },
      buttonText: {
        type: 'string',
        role: 'content',
      },
      buttonPosition: {
        type: 'string',
        default: 'button-outside',
      },
      buttonUseIcon: {
        type: 'boolean',
        default: false,
      },
      query: {
        type: 'object',
        default: {},
      },
      tagName: {
        type: 'string',
        default: '',
      },
    },
    selectors: {
      color:
        '.wp-block-search .wp-block-search__button, .wp-block-search.wp-block-search__no-button .wp-block-search__input',
      border:
        '.wp-block-search.wp-block-search__button-outside .wp-block-search__input, .wp-block-search.wp-block-search__button-outside .wp-block-search__button, .wp-block-search.wp-block-search__no-button .wp-block-search__input, .wp-block-search.wp-block-search__button-only .wp-block-search__input, .wp-block-search.wp-block-search__button-only .wp-block-search__button, .wp-block-search.wp-block-search__button-inside .wp-block-search__inside-wrapper',
    },
    supports: {
      anchor: true,
      align: ['left', 'center', 'right'],
      color: {
        gradients: true,
        __experimentalSkipSerialization: true,
        __experimentalDefaultControls: {
          background: true,
          text: true,
        },
      },
      interactivity: true,
      typography: {
        __experimentalSkipSerialization: true,
        __experimentalSelector:
          '.wp-block-search__label, .wp-block-search__input, .wp-block-search__button',
        fontSize: true,
        lineHeight: true,
        __experimentalFontFamily: true,
        __experimentalFontWeight: true,
        __experimentalFontStyle: true,
        __experimentalTextTransform: true,
        __experimentalTextDecoration: true,
        __experimentalLetterSpacing: true,
        __experimentalDefaultControls: {
          fontSize: true,
        },
      },
      __experimentalBorder: {
        color: true,
        radius: true,
        width: true,
        __experimentalSkipSerialization: true,
        __experimentalDefaultControls: {
          color: true,
          radius: true,
          width: true,
        },
      },
      spacing: {
        margin: true,
      },
      html: false,
    },
  },
  'core/site-tagline': {
    apiVersion: 3,
    name: 'core/site-tagline',
    title: 'Site Tagline',
    category: 'theme',
    description:
      'Describe in a few words what this site is about. This is important for search results, sharing on social media, and gives overall clarity to visitors.',
    keywords: ['description'],
    textdomain: 'default',
    attributes: {
      level: {
        type: 'number',
        default: 0,
      },
      levelOptions: {
        type: 'array',
        default: [0, 1, 2, 3, 4, 5, 6],
      },
    },
    supports: {
      anchor: true,
      align: ['wide', 'full'],
      html: false,
      color: {
        gradients: true,
        __experimentalDefaultControls: {
          background: true,
          text: true,
        },
      },
      contentRole: true,
      spacing: {
        margin: true,
        padding: true,
        __experimentalDefaultControls: {
          margin: false,
          padding: false,
        },
      },
      typography: {
        fontSize: true,
        lineHeight: true,
        textAlign: true,
        __experimentalFontFamily: true,
        __experimentalTextTransform: true,
        __experimentalTextDecoration: true,
        __experimentalFontStyle: true,
        __experimentalFontWeight: true,
        __experimentalLetterSpacing: true,
        __experimentalWritingMode: true,
        __experimentalDefaultControls: {
          fontSize: true,
        },
      },
      interactivity: {
        clientNavigation: true,
      },
      __experimentalBorder: {
        radius: true,
        color: true,
        width: true,
        style: true,
      },
    },
    example: {
      viewportWidth: 350,
      attributes: {
        style: {
          typography: {
            textAlign: 'center',
          },
        },
      },
    },
  },
  'core/site-title': {
    apiVersion: 3,
    name: 'core/site-title',
    title: 'Site Title',
    category: 'theme',
    description:
      'Displays the name of this site. Update the block, and the changes apply everywhere it’s used. This will also appear in the browser title bar and in search results.',
    textdomain: 'default',
    attributes: {
      level: {
        type: 'number',
        default: 1,
      },
      levelOptions: {
        type: 'array',
        default: [0, 1, 2, 3, 4, 5, 6],
      },
      isLink: {
        type: 'boolean',
        default: true,
        role: 'content',
      },
      linkTarget: {
        type: 'string',
        default: '_self',
        role: 'content',
      },
    },
    supports: {
      anchor: true,
      align: ['wide', 'full'],
      html: false,
      color: {
        gradients: true,
        link: true,
        __experimentalDefaultControls: {
          background: true,
          text: true,
          link: true,
        },
      },
      spacing: {
        padding: true,
        margin: true,
        __experimentalDefaultControls: {
          margin: false,
          padding: false,
        },
      },
      typography: {
        fontSize: true,
        lineHeight: true,
        textAlign: true,
        __experimentalFontFamily: true,
        __experimentalTextTransform: true,
        __experimentalTextDecoration: true,
        __experimentalFontStyle: true,
        __experimentalFontWeight: true,
        __experimentalLetterSpacing: true,
        __experimentalWritingMode: true,
        __experimentalDefaultControls: {
          fontSize: true,
        },
      },
      interactivity: {
        clientNavigation: true,
      },
      __experimentalBorder: {
        radius: true,
        color: true,
        width: true,
        style: true,
      },
    },
    example: {
      viewportWidth: 500,
    },
  },
  'core/tag-cloud': {
    apiVersion: 3,
    name: 'core/tag-cloud',
    title: 'Tag Cloud',
    category: 'widgets',
    description: 'A cloud of popular keywords, each sized by how often it appears.',
    textdomain: 'default',
    attributes: {
      numberOfTags: {
        type: 'number',
        default: 45,
        minimum: 1,
        maximum: 100,
      },
      taxonomy: {
        type: 'string',
        default: 'post_tag',
      },
      showTagCounts: {
        type: 'boolean',
        default: false,
      },
      smallestFontSize: {
        type: 'string',
        default: '8pt',
      },
      largestFontSize: {
        type: 'string',
        default: '22pt',
      },
    },
    supports: {
      anchor: true,
      html: false,
      align: true,
      spacing: {
        margin: true,
        padding: true,
      },
      typography: {
        lineHeight: true,
        __experimentalFontFamily: true,
        __experimentalFontWeight: true,
        __experimentalFontStyle: true,
        __experimentalTextTransform: true,
        __experimentalLetterSpacing: true,
      },
      interactivity: {
        clientNavigation: true,
      },
      __experimentalBorder: {
        radius: true,
        color: true,
        width: true,
        style: true,
        __experimentalDefaultControls: {
          radius: true,
          color: true,
          width: true,
          style: true,
        },
      },
    },
    styles: [
      {
        name: 'default',
        label: 'Default',
        isDefault: true,
      },
      {
        name: 'outline',
        label: 'Outline',
      },
    ],
  },
};
