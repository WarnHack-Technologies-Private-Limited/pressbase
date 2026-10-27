import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AdminShell } from '@/components/shell/admin-shell';
import { coreGet, type Me, type SiteIndex } from '@/lib/core';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const [me, site] = await Promise.all([coreGet<Me>('/wp/v2/users/me'), coreGet<SiteIndex>('/')]);
  if (site.data.pressbase.state !== 'ready') redirect('/install');
  if (me.status !== 200) redirect('/login');

  return (
    <AdminShell user={me.data} siteName={site.data.name} version={site.data.pressbase.version}>
      {children}
    </AdminShell>
  );
}
