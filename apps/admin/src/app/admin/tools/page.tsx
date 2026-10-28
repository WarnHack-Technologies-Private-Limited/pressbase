import { Wrench } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import styles from '@/components/extensions/extensions.module.css';
import { PageHeader } from '@/components/shell/page-header';
import { ButtonLink } from '@/components/ui/button';
import { Badge, Card, EmptyState } from '@/components/ui/surface';
import { coreGet } from '@/lib/core';
import { type AdminExtensions, pageHref, pagesUnder } from '@/lib/extensions/pages';
import { findSection } from '@/lib/sections';

export const metadata: Metadata = { title: 'Tools' };

/**
 * Tools (wp-admin/tools.php). Pressbase's own tools (import, export, site
 * health) come in a later release; plugins' tools pages are listed here now.
 */
export default async function ToolsPage() {
  const section = findSection('tools');
  const extensions = await coreGet<AdminExtensions>('/pressbase/v1/admin-extensions');
  const pages = extensions.status === 200 ? pagesUnder(extensions.data, 'tools') : [];

  if (!pages.length) {
    return (
      <>
        <PageHeader title="Tools" />
        <Card>
          <EmptyState
            icon={<Wrench size={28} />}
            title={
              <>
                Tools is on the way <Badge tone="accent">{section?.release}</Badge>
              </>
            }
            action={
              <ButtonLink href="/admin" variant="secondary">
                Back to the dashboard
              </ButtonLink>
            }
          >
            <p>{section?.summary}</p>
          </EmptyState>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Tools" description="Tools your plugins add." />
      <Card
        title="Plugin tools"
        description={`Importing, exporting and site health checks are coming in ${section?.release}.`}
      >
        <ul className={styles.toolList}>
          {pages.map((page) => (
            <li key={`${page.plugin}/${page.slug}`}>
              <Link href={pageHref(page)}>
                <span className={styles.toolTitle}>{page.title}</span>
                <span className={styles.toolMeta}>
                  {page.description || `From ${page.plugin_title}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
