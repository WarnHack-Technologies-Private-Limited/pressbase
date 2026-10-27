import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { CommentsScreen } from '@/components/comments/comments-screen';
import { coreGet, type Me } from '@/lib/core';

export const metadata: Metadata = { title: 'Comments' };

export default async function CommentsPage() {
  const { status, data: me } = await coreGet<Me>('/wp/v2/users/me');
  if (status === 401) redirect('/login?redirect_to=/admin/comments');
  // The menu item and every action on this screen need moderate_comments.
  if (!me.capabilities.moderate_comments) redirect('/admin');
  return (
    <Suspense>
      <CommentsScreen />
    </Suspense>
  );
}
