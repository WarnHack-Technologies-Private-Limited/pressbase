import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PostList } from '@/components/content/post-list';
import { CONTENT_TYPES } from '@/lib/content';

export const metadata: Metadata = { title: 'Pages' };

export default function PagesPage() {
  return (
    <Suspense>
      <PostList config={CONTENT_TYPES.pages} />
    </Suspense>
  );
}
