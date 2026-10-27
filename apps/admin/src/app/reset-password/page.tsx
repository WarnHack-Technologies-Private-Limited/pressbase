import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthLayout } from '@/components/install/auth-layout';
import { ResetPasswordForm } from '@/components/people/reset-password-form';
import { coreGet, type SiteIndex } from '@/lib/core';

export const metadata: Metadata = {
  title: 'Choose a new password',
  // The URL carries a secret key: keep it out of other sites' logs.
  referrer: 'no-referrer',
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ key?: string; login?: string }>;
}) {
  const { data: site } = await coreGet<SiteIndex>('/');
  if (site.pressbase.state !== 'ready') redirect('/install');
  const { key = '', login = '' } = await searchParams;
  return (
    <AuthLayout narrow>
      <ResetPasswordForm login={login} resetKey={key} />
    </AuthLayout>
  );
}
