import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/shell/page-header';
import { InfoScreen } from '@/components/site-health/info-screen';
import { SiteHealthTabs } from '@/components/site-health/site-health-tabs';
import { coreGet } from '@/lib/core';
import type { SiteInfo } from '@/lib/site-health';

export const metadata: Metadata = { title: 'Site Health Info' };

/** Tools → Site Health → Info (wp-admin/site-health-info.php). */
export default async function SiteHealthInfoPage() {
  const info = await coreGet<SiteInfo>('/pressbase/v1/site-health/info');
  if (info.status === 401) redirect('/login?redirect_to=/admin/tools/site-health/info');
  if (info.status !== 200) redirect('/admin/tools');
  return (
    <>
      <PageHeader
        title="Site health"
        description="Check your site’s security and performance, and find what to improve."
      />
      <SiteHealthTabs />
      <InfoScreen initial={info.data} />
    </>
  );
}
