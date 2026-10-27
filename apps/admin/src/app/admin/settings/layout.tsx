import type { ReactNode } from 'react';
import styles from '@/components/settings/settings.module.css';
import { SettingsNav } from '@/components/settings/settings-nav';
import { PageHeader } from '@/components/shell/page-header';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Control how your site works and looks to the world."
      />
      <div className={styles.layout}>
        <SettingsNav />
        <div>{children}</div>
      </div>
    </>
  );
}
