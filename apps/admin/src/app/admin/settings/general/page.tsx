import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import {
  type GeneralSettings,
  GeneralSettingsForm,
} from '@/components/settings/general-settings-form';
import { coreGet } from '@/lib/core';
import { getI18n } from '@/lib/i18n/server';
import type { Languages } from '@/lib/languages';

export async function generateMetadata(): Promise<Metadata> {
  const { __ } = await getI18n();
  return { title: __('General Settings', 'pressbase-admin') };
}

export default async function GeneralSettingsPage() {
  const [{ status, data }, languages] = await Promise.all([
    coreGet<GeneralSettings>('/wp/v2/settings'),
    coreGet<Languages>('/pressbase/v1/languages?_locale=user'),
  ]);
  if (status === 401) redirect('/login');
  if (status === 403) redirect('/admin');

  const timezones = ['UTC', ...Intl.supportedValuesOf('timeZone').filter((zone) => zone !== 'UTC')];
  if (!timezones.includes(data.timezone)) timezones.unshift(data.timezone);

  return (
    <GeneralSettingsForm
      initial={{ ...data, language: data.language || 'en_US' }}
      timezones={timezones}
      languages={
        languages.status === 200
          ? languages.data
          : {
              site_language: data.language || 'en_US',
              installed: [
                {
                  language: 'en_US',
                  english_name: 'English (United States)',
                  native_name: 'English (United States)',
                  dir: 'ltr',
                  wordpress: true,
                },
              ],
              can_install: false,
            }
      }
    />
  );
}
