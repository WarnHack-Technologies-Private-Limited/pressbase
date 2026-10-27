import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PostEditor } from '@/components/content/post-editor';
import { CONTENT_TYPES } from '@/lib/content';

export const metadata: Metadata = { title: 'Edit post' };

export default async function EditPostPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id < 1) notFound();
  // Keyed by id so moving between items starts from a fresh editor.
  return <PostEditor key={id} config={CONTENT_TYPES.posts} id={id} />;
}
