import type { BlockTypeArgs } from '@pressbase/blocks';

/**
 * block.json metadata of the server-rendered comment blocks, copied from
 * WordPress 7.1.3 (wordpress/wp-includes/blocks/{name}/block.json, GPL-2.0-or-later).
 * Kept apart from metadata.ts so the comment blocks can be regenerated as one
 * set. Generated; don't edit by hand.
 */
export const COMMENT_BLOCK_METADATA: Record<string, BlockTypeArgs & { name: string }> = {
  'core/comment-author-name': {
    apiVersion: 3,
    name: 'core/comment-author-name',
    title: 'Comment Author Name',
    category: 'theme',
    ancestor: ['core/comment-template'],
    description: 'Displays the name of the author of the comment.',
    textdomain: 'default',
    attributes: {
      isLink: {
        type: 'boolean',
        default: true,
      },
      linkTarget: {
        type: 'string',
        default: '_self',
      },
    },
    usesContext: ['commentId'],
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
  },
  'core/comment-content': {
    apiVersion: 3,
    name: 'core/comment-content',
    title: 'Comment Content',
    category: 'theme',
    ancestor: ['core/comment-template'],
    description: 'Displays the contents of a comment.',
    textdomain: 'default',
    usesContext: ['commentId'],
    supports: {
      anchor: true,
      color: {
        gradients: true,
        link: true,
        __experimentalDefaultControls: {
          background: true,
          text: true,
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
      spacing: {
        padding: ['horizontal', 'vertical'],
        __experimentalDefaultControls: {
          padding: true,
        },
      },
      html: false,
    },
  },
  'core/comment-date': {
    apiVersion: 3,
    name: 'core/comment-date',
    title: 'Comment Date',
    category: 'theme',
    ancestor: ['core/comment-template'],
    description: 'Displays the date on which the comment was posted.',
    textdomain: 'default',
    attributes: {
      format: {
        type: 'string',
      },
      isLink: {
        type: 'boolean',
        default: true,
      },
    },
    usesContext: ['commentId'],
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
  },
  'core/comment-edit-link': {
    apiVersion: 3,
    name: 'core/comment-edit-link',
    title: 'Comment Edit Link',
    category: 'theme',
    ancestor: ['core/comment-template'],
    description:
      'Displays a link to edit the comment in the WordPress Dashboard. This link is only visible to users with the edit comment capability.',
    textdomain: 'default',
    usesContext: ['commentId'],
    attributes: {
      linkTarget: {
        type: 'string',
        default: '_self',
      },
    },
    supports: {
      anchor: true,
      html: false,
      color: {
        link: true,
        gradients: true,
        text: false,
        __experimentalDefaultControls: {
          background: true,
          link: true,
        },
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
      },
    },
  },
  'core/comment-reply-link': {
    apiVersion: 3,
    name: 'core/comment-reply-link',
    title: 'Comment Reply Link',
    category: 'theme',
    ancestor: ['core/comment-template'],
    description: 'Displays a link to reply to a comment.',
    textdomain: 'default',
    usesContext: ['commentId'],
    supports: {
      anchor: true,
      color: {
        gradients: true,
        link: true,
        text: false,
        __experimentalDefaultControls: {
          background: true,
          link: true,
        },
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
      __experimentalBorder: {
        radius: true,
        color: true,
        width: true,
        style: true,
      },
      html: false,
    },
  },
  'core/comment-template': {
    apiVersion: 3,
    name: 'core/comment-template',
    title: 'Comment Template',
    category: 'design',
    parent: ['core/comments'],
    description:
      'Contains the block elements used to display a comment, like the title, date, author, avatar and more.',
    textdomain: 'default',
    usesContext: ['postId'],
    supports: {
      anchor: true,
      align: true,
      html: false,
      reusable: false,
      spacing: {
        margin: true,
        padding: true,
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
  'core/comments': {
    apiVersion: 3,
    name: 'core/comments',
    title: 'Comments',
    category: 'theme',
    description:
      'An advanced block that allows displaying post comments using different visual configurations.',
    textdomain: 'default',
    attributes: {
      tagName: {
        type: 'string',
        default: 'div',
      },
      legacy: {
        type: 'boolean',
        default: false,
      },
    },
    supports: {
      anchor: true,
      align: ['wide', 'full'],
      html: false,
      color: {
        gradients: true,
        heading: true,
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
    },
    usesContext: ['postId', 'postType'],
  },
  'core/comments-pagination': {
    apiVersion: 3,
    name: 'core/comments-pagination',
    title: 'Comments Pagination',
    category: 'theme',
    parent: ['core/comments'],
    allowedBlocks: [
      'core/comments-pagination-previous',
      'core/comments-pagination-numbers',
      'core/comments-pagination-next',
    ],
    description:
      'Displays a paginated navigation to next/previous set of comments, when applicable.',
    textdomain: 'default',
    attributes: {
      paginationArrow: {
        type: 'string',
        default: 'none',
      },
    },
    example: {
      attributes: {
        paginationArrow: 'none',
      },
    },
    providesContext: {
      'comments/paginationArrow': 'paginationArrow',
    },
    supports: {
      anchor: true,
      align: true,
      reusable: false,
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
      layout: {
        allowSwitching: false,
        allowInheriting: false,
        default: {
          type: 'flex',
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
      interactivity: {
        clientNavigation: true,
      },
    },
  },
  'core/comments-pagination-next': {
    apiVersion: 3,
    name: 'core/comments-pagination-next',
    title: 'Comments Next Page',
    category: 'theme',
    parent: ['core/comments-pagination'],
    description: "Displays the next comment's page link.",
    textdomain: 'default',
    attributes: {
      label: {
        type: 'string',
      },
    },
    usesContext: ['postId', 'comments/paginationArrow'],
    supports: {
      anchor: true,
      reusable: false,
      html: false,
      color: {
        gradients: true,
        text: false,
        __experimentalDefaultControls: {
          background: true,
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
      interactivity: {
        clientNavigation: true,
      },
    },
  },
  'core/comments-pagination-numbers': {
    apiVersion: 3,
    name: 'core/comments-pagination-numbers',
    title: 'Comments Page Numbers',
    category: 'theme',
    parent: ['core/comments-pagination'],
    description: 'Displays a list of page numbers for comments pagination.',
    textdomain: 'default',
    usesContext: ['postId'],
    supports: {
      anchor: true,
      reusable: false,
      html: false,
      color: {
        gradients: true,
        text: false,
        __experimentalDefaultControls: {
          background: true,
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
      interactivity: {
        clientNavigation: true,
      },
      spacing: {
        margin: true,
        padding: true,
        __experimentalDefaultControls: {
          padding: true,
        },
      },
    },
  },
  'core/comments-pagination-previous': {
    apiVersion: 3,
    name: 'core/comments-pagination-previous',
    title: 'Comments Previous Page',
    category: 'theme',
    parent: ['core/comments-pagination'],
    description: "Displays the previous comment's page link.",
    textdomain: 'default',
    attributes: {
      label: {
        type: 'string',
      },
    },
    usesContext: ['postId', 'comments/paginationArrow'],
    supports: {
      anchor: true,
      reusable: false,
      html: false,
      color: {
        gradients: true,
        text: false,
        __experimentalDefaultControls: {
          background: true,
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
      interactivity: {
        clientNavigation: true,
      },
    },
  },
  'core/comments-title': {
    apiVersion: 3,
    name: 'core/comments-title',
    title: 'Comments Title',
    category: 'theme',
    ancestor: ['core/comments'],
    description: 'Displays a title with the number of comments.',
    textdomain: 'default',
    usesContext: ['postId', 'postType'],
    attributes: {
      showPostTitle: {
        type: 'boolean',
        default: true,
      },
      showCommentsCount: {
        type: 'boolean',
        default: true,
      },
      level: {
        type: 'number',
        default: 2,
      },
      levelOptions: {
        type: 'array',
      },
    },
    supports: {
      anchor: true,
      align: true,
      html: false,
      __experimentalBorder: {
        radius: true,
        color: true,
        width: true,
        style: true,
      },
      color: {
        gradients: true,
        __experimentalDefaultControls: {
          background: true,
          text: true,
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
          __experimentalFontFamily: true,
          __experimentalFontStyle: true,
          __experimentalFontWeight: true,
        },
      },
      interactivity: {
        clientNavigation: true,
      },
    },
  },
  'core/latest-comments': {
    apiVersion: 3,
    name: 'core/latest-comments',
    title: 'Latest Comments',
    category: 'widgets',
    description: 'Display a list of your most recent comments.',
    keywords: ['recent comments'],
    textdomain: 'default',
    attributes: {
      commentsToShow: {
        type: 'number',
        default: 5,
        minimum: 1,
        maximum: 100,
      },
      displayAvatar: {
        type: 'boolean',
        default: true,
      },
      displayDate: {
        type: 'boolean',
        default: true,
      },
      displayContent: {
        type: 'string',
        default: 'excerpt',
        enum: ['none', 'excerpt', 'full'],
      },
    },
    supports: {
      anchor: true,
      align: true,
      color: {
        gradients: true,
        link: true,
        __experimentalDefaultControls: {
          background: true,
          text: true,
          link: true,
        },
      },
      html: false,
      spacing: {
        margin: true,
        padding: true,
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
      interactivity: {
        clientNavigation: true,
      },
    },
  },
  'core/post-comments-form': {
    apiVersion: 3,
    name: 'core/post-comments-form',
    title: 'Comments Form',
    category: 'theme',
    description: "Display a post's comments form.",
    textdomain: 'default',
    usesContext: ['postId', 'postType'],
    supports: {
      anchor: true,
      html: false,
      color: {
        gradients: true,
        heading: true,
        link: true,
        __experimentalDefaultControls: {
          background: true,
          text: true,
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
        __experimentalFontStyle: true,
        __experimentalFontWeight: true,
        __experimentalLetterSpacing: true,
        __experimentalTextTransform: true,
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
    },
    example: {
      attributes: {
        style: {
          typography: {
            textAlign: 'center',
          },
        },
      },
    },
  },
};
