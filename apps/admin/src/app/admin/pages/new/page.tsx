import type { Metadata } from 'next';
import { PostEditor } from '@/components/content/post-editor';
import { CONTENT_TYPES } from '@/lib/content';

export const metadata: Metadata = { title: 'Add new page' };

export default function NewPagePage() {
  return <PostEditor config={CONTENT_TYPES.pages} />;
}
