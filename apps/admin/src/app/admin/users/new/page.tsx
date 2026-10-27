import type { Metadata } from 'next';
import { NewUserForm } from '@/components/people/new-user-form';
import { NotAllowed } from '@/components/people/not-allowed';
import { coreGet, type Me } from '@/lib/core';

export const metadata: Metadata = { title: 'Add user' };

export default async function NewUserPage() {
  const { data: me } = await coreGet<Me>('/wp/v2/users/me');
  if (!me.capabilities?.create_users) {
    return (
      <NotAllowed title="Add user">Only administrators can add people to this site.</NotAllowed>
    );
  }
  return <NewUserForm defaultRole="subscriber" />;
}
