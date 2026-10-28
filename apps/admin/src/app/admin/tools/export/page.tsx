import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ExportScreen } from '@/components/tools/export-screen';
import { coreGet } from '@/lib/core';
import type { ExportChoices } from '@/lib/import-export';

export const metadata: Metadata = { title: 'Export' };

/** Tools → Export (wp-admin/export.php). */
export default async function ExportPage() {
  const { status, data } = await coreGet<ExportChoices>('/pressbase/v1/export');
  if (status === 401) redirect('/login');
  if (status === 403) redirect('/admin/tools');
  return <ExportScreen choices={data} />;
}
