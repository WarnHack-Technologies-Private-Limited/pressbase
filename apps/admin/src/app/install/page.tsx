import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthLayout } from '@/components/install/auth-layout';
import { Installer } from '@/components/install/installer';
import { coreGet, type InstallStatus } from '@/lib/core';

export const metadata: Metadata = { title: 'Install' };

export default async function InstallPage() {
  const { data: status } = await coreGet<InstallStatus>('/pressbase/v1/install');
  if (status.state === 'ready') redirect('/admin');

  return (
    <AuthLayout footer={<>Pressbase {status.version} · Free and open source under the GPL</>}>
      <Installer status={status} />
    </AuthLayout>
  );
}
