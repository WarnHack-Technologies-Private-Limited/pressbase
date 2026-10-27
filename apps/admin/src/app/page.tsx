import { redirect } from 'next/navigation';
import { coreGet, type InstallStatus } from '@/lib/core';

// The public site arrives with themes in v0.4. Until then the root routes to
// the installer or the dashboard.
export default async function Home() {
  const { data } = await coreGet<InstallStatus>('/pressbase/v1/install');
  redirect(data.state === 'ready' ? '/admin' : '/install');
}
