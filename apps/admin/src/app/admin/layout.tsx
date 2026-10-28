import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AdminShell } from '@/components/shell/admin-shell';
import { coreGet, type Me, type SiteIndex } from '@/lib/core';

/** The admin's favicon is the site icon, when there is one (as wp-admin uses wp_site_icon()). */
export async function generateMetadata(): Promise<Metadata> {
  const site = await coreGet<SiteIndex>('/').catch(() => null);
  const icon = site?.data.site_icon_url;
  return icon ? { icons: { icon: [{ url: icon }], apple: [{ url: icon }] } } : {};
}

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const [me, site] = await Promise.all([coreGet<Me>('/wp/v2/users/me'), coreGet<SiteIndex>('/')]);
  if (site.data.pressbase.state !== 'ready') redirect('/install');
  if (me.status !== 200) redirect('/login');

  return (
    <AdminShell
      user={me.data}
      siteName={site.data.name}
      siteUrl={site.data.url}
      siteIcon={site.data.site_icon_url}
      version={site.data.pressbase.version}
    >
      {children}
    </AdminShell>
  );
}
