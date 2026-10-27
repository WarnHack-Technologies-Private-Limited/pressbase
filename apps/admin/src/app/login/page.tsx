import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthLayout } from '@/components/install/auth-layout';
import { LoginForm } from '@/components/install/login-form';
import { coreGet, type SiteIndex } from '@/lib/core';

export const metadata: Metadata = { title: 'Log in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_to?: string }>;
}) {
  const { data: site } = await coreGet<SiteIndex>('/');
  if (site.pressbase.state !== 'ready') redirect('/install');
  if ((await coreGet('/wp/v2/users/me')).status === 200) redirect('/admin');

  const { redirect_to } = await searchParams;
  return (
    <AuthLayout narrow>
      <LoginForm siteName={site.name} redirectTo={redirect_to} />
    </AuthLayout>
  );
}
