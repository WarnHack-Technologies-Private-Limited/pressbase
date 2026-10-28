import { Wrench } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import styles from '@/components/extensions/extensions.module.css';
import { PageHeader } from '@/components/shell/page-header';
import { ButtonLink } from '@/components/ui/button';
import { Card, EmptyState } from '@/components/ui/surface';
import { coreGet, type Me } from '@/lib/core';
import { type AdminExtensions, pageHref, pagesUnder } from '@/lib/extensions/pages';
import { toolsFor } from '@/lib/tools';

export const metadata: Metadata = { title: 'Tools' };

/**
 * Tools (wp-admin/tools.php): Pressbase's own tools (lib/tools.ts), then the
 * pages plugins add with add_management_page().
 */
export default async function ToolsPage() {
  const [me, extensions] = await Promise.all([
    coreGet<Me>('/wp/v2/users/me'),
    coreGet<AdminExtensions>('/pressbase/v1/admin-extensions'),
  ]);
  const tools = me.status === 200 ? toolsFor(me.data.capabilities) : [];
  const pages = extensions.status === 200 ? pagesUnder(extensions.data, 'tools') : [];

  if (!tools.length && !pages.length) {
    return (
      <>
        <PageHeader title="Tools" />
        <Card>
          <EmptyState
            icon={<Wrench size={28} />}
            title="No tools for you yet"
            action={
              <ButtonLink href="/admin" variant="secondary">
                Back to the dashboard
              </ButtonLink>
            }
          >
            <p>Tools from Pressbase and your plugins show up here when your role can use them.</p>
          </EmptyState>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Tools" description="Move content in and out, and look after your site." />
      {tools.length > 0 && (
        <Card title="Pressbase tools">
          <ul className={styles.toolList}>
            {tools.map((tool) => (
              <li key={tool.slug}>
                <Link href={`/admin/tools/${tool.slug}`}>
                  <span className={styles.toolTitle}>{tool.title}</span>
                  <span className={styles.toolMeta}>{tool.description}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {pages.length > 0 && (
        <Card title="Plugin tools" description="Tools your plugins add.">
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
      )}
    </>
  );
}
