'use client';

import { useBlockProps, useInnerBlocksProps } from '@wordpress/block-editor';
import { createHigherOrderComponent } from '@wordpress/compose';
import { addFilter } from '@wordpress/hooks';
import { type ComponentType, createContext, type ElementType, useContext } from 'react';
import { POST_CONTENT, TEMPLATE_PART } from './canvas-model';

/**
 * How `core/template-part` and `core/post-content` edit inside Studio.
 *
 * WordPress's own edit components load their content as separate
 * core-data entities, each with its own undo history. Studio keeps the
 * whole canvas as one block tree instead (canvas-model.ts), so one undo
 * stack covers every edit and the canvas splits back into entities on
 * save. Inside Studio, both blocks simply render their inner blocks, with
 * the wrapper and classes the public site renders. Outside Studio (the
 * post editor), WordPress's components are used as before.
 */

export interface PartInfo {
  title: string;
  area: string;
}

export interface StudioRegionsValue {
  /** The template parts, by slug, from /wp/v2/template-parts. */
  parts: ReadonlyMap<string, PartInfo>;
  /** "Header · every page", for the outline label and screen readers. */
  partLabel: (slug: string) => string;
}

const StudioRegions = createContext<StudioRegionsValue | null>(null);
export const StudioRegionsProvider = StudioRegions.Provider;

/** The tag WordPress renders a part's area with (the template-part block's area definitions). */
export function partTagName(area: string | undefined): 'header' | 'footer' | 'div' {
  return area === 'header' ? 'header' : area === 'footer' ? 'footer' : 'div';
}

interface EditProps {
  name: string;
  clientId: string;
  attributes: Record<string, unknown>;
}

function TemplatePartEdit({ attributes, regions }: EditProps & { regions: StudioRegionsValue }) {
  const slug = String(attributes.slug ?? '');
  const info = regions.parts.get(slug);
  const TagName = ((attributes.tagName as string | undefined) ||
    partTagName(info?.area ?? (attributes.area as string | undefined))) as ElementType;
  const blockProps = useBlockProps({
    className: 'pressbase-studio-part',
    'data-studio-label': regions.partLabel(slug),
  });
  const innerBlocksProps = useInnerBlocksProps(blockProps, { renderAppender: false });
  return <TagName {...innerBlocksProps} />;
}

function PostContentEdit({ attributes }: EditProps) {
  const TagName = ((attributes.tagName as string | undefined) || 'div') as ElementType;
  const blockProps = useBlockProps({ className: 'entry-content' });
  const innerBlocksProps = useInnerBlocksProps(blockProps);
  return <TagName {...innerBlocksProps} />;
}

const withStudioRegions = createHigherOrderComponent(
  (BlockEdit: ComponentType<EditProps>) => (props: EditProps) => {
    const regions = useContext(StudioRegions);
    if (regions && props.name === TEMPLATE_PART) {
      return <TemplatePartEdit {...props} regions={regions} />;
    }
    if (regions && props.name === POST_CONTENT) return <PostContentEdit {...props} />;
    return <BlockEdit {...props} />;
  },
  'withStudioRegions',
);

let registered = false;
/** Adds the filter once; it only acts inside <StudioRegionsProvider>. */
export function registerStudioRegions(): void {
  if (registered) return;
  registered = true;
  addFilter('editor.BlockEdit', 'pressbase/studio/regions', withStudioRegions);
}
