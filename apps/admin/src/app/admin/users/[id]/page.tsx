import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { NotAllowed } from '@/components/people/not-allowed';
import { UserEditor } from '@/components/people/user-editor';
import { coreGet, type Me } from '@/lib/core';

export const metadata: Metadata = { title: 'Edit user' };

export default async function EditUserPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id < 1) notFound();
  const { data: me } = await coreGet<Me>('/wp/v2/users/me');
  // Your own account is edited on the Profile screen, as in WordPress.
  if (me.id === id) redirect('/admin/profile');
  if (!me.capabilities?.edit_users) {
    return <NotAllowed title="Edit user">Only administrators can edit other people.</NotAllowed>;
  }
  return <UserEditor key={id} id={id} />;
}
