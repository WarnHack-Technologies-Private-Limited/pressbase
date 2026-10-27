import type { Metadata } from 'next';
import { Suspense } from 'react';
import { NotAllowed } from '@/components/people/not-allowed';
import { UserList } from '@/components/people/user-list';
import { coreGet, type Me } from '@/lib/core';

export const metadata: Metadata = { title: 'Users' };

export default async function UsersPage() {
  const { data: me } = await coreGet<Me>('/wp/v2/users/me');
  if (!me.capabilities?.list_users) {
    return (
      <NotAllowed title="Users">
        Only administrators can see the list of people on this site.
      </NotAllowed>
    );
  }
  return (
    <Suspense>
      <UserList />
    </Suspense>
  );
}
