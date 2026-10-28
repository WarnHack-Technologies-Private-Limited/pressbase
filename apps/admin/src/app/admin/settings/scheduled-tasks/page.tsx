import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ScheduledTasks } from '@/components/settings/scheduled-tasks';
import { coreGet } from '@/lib/core';
import type { CronOverview } from '@/lib/cron';

export const metadata: Metadata = { title: 'Scheduled Tasks' };

export default async function ScheduledTasksPage() {
  const [cron, settings] = await Promise.all([
    coreGet<CronOverview>('/pressbase/v1/cron'),
    coreGet<{ timezone?: string }>('/wp/v2/settings'),
  ]);
  if (cron.status === 401) redirect('/login');
  if (cron.status === 403) redirect('/admin');
  return <ScheduledTasks data={cron.data} timeZone={settings.data.timezone ?? 'UTC'} />;
}
