import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ImportScreen } from '@/components/tools/import-screen';
import { coreGet, type Me } from '@/lib/core';
import type { ImportSession } from '@/lib/import-export';

export const metadata: Metadata = { title: 'Import' };

/** Tools → Import (wp-admin/import.php and the WordPress Importer). */
export default async function ImportPage() {
  const [me, imports] = await Promise.all([
    coreGet<Me>('/wp/v2/users/me'),
    coreGet<ImportSession[]>('/pressbase/v1/import'),
  ]);
  if (imports.status === 401) redirect('/login');
  if (imports.status === 403) redirect('/admin/tools');
  // An import that is queued or running: follow it.
  const resume = imports.data.find((s) => s.status === 'queued' || s.status === 'running') ?? null;
  return <ImportScreen meId={me.data.id} resume={resume} />;
}
