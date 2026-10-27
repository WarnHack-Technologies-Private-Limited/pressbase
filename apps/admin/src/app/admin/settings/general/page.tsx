import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import {
  type GeneralSettings,
  GeneralSettingsForm,
} from '@/components/settings/general-settings-form';
import { coreGet } from '@/lib/core';

export const metadata: Metadata = { title: 'General Settings' };

export default async function GeneralSettingsPage() {
  const { status, data } = await coreGet<GeneralSettings>('/wp/v2/settings');
  if (status === 401) redirect('/login');
  if (status === 403) redirect('/admin');

  const timezones = ['UTC', ...Intl.supportedValuesOf('timeZone').filter((zone) => zone !== 'UTC')];
  if (!timezones.includes(data.timezone)) timezones.unshift(data.timezone);

  return <GeneralSettingsForm initial={data} timezones={timezones} />;
}
