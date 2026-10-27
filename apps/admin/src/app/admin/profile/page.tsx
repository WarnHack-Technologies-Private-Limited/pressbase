import type { Metadata } from 'next';
import { UserEditor } from '@/components/people/user-editor';
import { coreGet, type Me } from '@/lib/core';

export const metadata: Metadata = { title: 'Profile' };

export default async function ProfilePage() {
  const { data: me } = await coreGet<Me>('/wp/v2/users/me');
  return <UserEditor id={me.id} self />;
}
