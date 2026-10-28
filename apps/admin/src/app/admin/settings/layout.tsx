import type { ReactNode } from 'react';
import styles from '@/components/settings/settings.module.css';
import { SettingsNav } from '@/components/settings/settings-nav';
import { PageHeader } from '@/components/shell/page-header';
import { getI18n } from '@/lib/i18n/server';

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const { __ } = await getI18n();
  return (
    <>
      <PageHeader
        title={__('Settings', 'pressbase-admin')}
        description={__('Control how your site works and looks to the world.', 'pressbase-admin')}
      />
      <div className={styles.layout}>
        <SettingsNav />
        <div>{children}</div>
      </div>
    </>
  );
}
