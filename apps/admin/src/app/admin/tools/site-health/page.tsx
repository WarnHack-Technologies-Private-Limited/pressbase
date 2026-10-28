import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/shell/page-header';
import { SiteHealthTabs } from '@/components/site-health/site-health-tabs';
import { StatusScreen } from '@/components/site-health/status-screen';
import { coreGet } from '@/lib/core';
import type { SiteStatus } from '@/lib/site-health';

export const metadata: Metadata = { title: 'Site Health' };

/** Tools → Site Health → Status (wp-admin/site-health.php). */
export default async function SiteHealthPage() {
  const status = await coreGet<SiteStatus>('/pressbase/v1/site-health');
  if (status.status === 401) redirect('/login?redirect_to=/admin/tools/site-health');
  if (status.status !== 200) redirect('/admin/tools');
  return (
    <>
      <PageHeader
        title="Site health"
        description="Check your site’s security and performance, and find what to improve."
      />
      <SiteHealthTabs />
      <StatusScreen initial={status.data} />
    </>
  );
}
