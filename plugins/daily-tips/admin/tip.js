// The Daily tip block in the editor. The server code (index.js) registers the
// block with api.blocks.register() and names this file as its editorScript;
// the editor imports it before it opens a post.
//
// The block is dynamic: the server renders it, so there's no save function and
// the post stores only <!-- wp:daily-tips/tip {"accent":"#…"} /-->. The edit
// function shows the server's rendering (ServerSideRender) and a colour field
// in the block's settings. Gutenberg comes from window.pressbase.blocks, so
// this file needs no build step and bundles nothing.
// See docs/architecture/plugins.md#blocks.

const {
  element: { createElement: h, Fragment },
  blocks: {
    registerBlockType,
    useBlockProps,
    InspectorControls,
    ServerSideRender,
    components: { PanelBody, TextControl },
  },
} = window.pressbase;

function Edit({ attributes, setAttributes }) {
  const blockProps = useBlockProps();
  return h(
    Fragment,
    null,
    h(
      InspectorControls,
      null,
      h(
        PanelBody,
        { title: 'Colour' },
        h(TextControl, {
          __next40pxDefaultSize: true,
          __nextHasNoMarginBottom: true,
          type: 'color',
          label: 'Accent colour',
          help: 'The stripe and the label beside the tip.',
          value: attributes.accent,
          onChange: (accent) => setAttributes({ accent }),
        }),
      ),
    ),
    h('div', blockProps, h(ServerSideRender, { block: 'daily-tips/tip', attributes })),
  );
}

registerBlockType('daily-tips/tip', { edit: Edit });
