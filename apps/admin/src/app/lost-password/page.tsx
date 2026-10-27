import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthLayout } from '@/components/install/auth-layout';
import { LostPasswordForm } from '@/components/people/lost-password-form';
import { coreGet, type SiteIndex } from '@/lib/core';

export const metadata: Metadata = { title: 'Forgot your password?' };

export default async function LostPasswordPage() {
  const { data: site } = await coreGet<SiteIndex>('/');
  if (site.pressbase.state !== 'ready') redirect('/install');
  return (
    <AuthLayout narrow>
      <LostPasswordForm siteName={site.name} />
    </AuthLayout>
  );
}
