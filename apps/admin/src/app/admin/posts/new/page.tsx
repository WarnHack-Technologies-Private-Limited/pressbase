import type { Metadata } from 'next';
import { PostEditor } from '@/components/content/post-editor';
import { CONTENT_TYPES } from '@/lib/content';

export const metadata: Metadata = { title: 'Add new post' };

export default function NewPostPage() {
  return <PostEditor config={CONTENT_TYPES.posts} />;
}
