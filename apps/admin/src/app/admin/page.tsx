import { Circle, CircleCheck, EyeOff } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import styles from '@/components/shell/page.module.css';
import { PageHeader } from '@/components/shell/page-header';
import { Badge, Card, Notice } from '@/components/ui/surface';
import { coreGet, type Me, type SiteIndex } from '@/lib/core';

export const metadata: Metadata = { title: 'Dashboard' };

interface Dashboard {
  site: { title: string; url: string; public: boolean };
  counts: {
    posts: number;
    drafts: number;
    pages: number;
    comments: number;
    pendingComments: number;
  };
  recent: { id: number; title: string; type: string; status: string; modified: string }[];
  system: { version: string; database: 'postgres' | 'pglite'; node: string };
}

function relativeTime(iso: string): string {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

export default async function DashboardPage() {
  const [{ data }, { data: me }, { data: site }] = await Promise.all([
    coreGet<Dashboard>('/pressbase/v1/dashboard'),
    coreGet<Me>('/wp/v2/users/me'),
    coreGet<SiteIndex>('/'),
  ]);
  const firstName = me.name.split(/\s+/)[0];
  const canManage = Boolean(me.capabilities.manage_options);

  const steps = [
    { label: 'Install Pressbase', done: true },
    { label: 'Give your site a name', done: Boolean(site.name), href: '/admin/settings/general' },
    { label: 'Add a tagline', done: Boolean(site.description), href: '/admin/settings/general' },
    { label: 'Write your first post', done: false, release: 'v0.2' },
    { label: 'Invite your team', done: false, release: 'v0.2' },
    { label: 'Choose a theme', done: false, release: 'v0.4' },
  ];
  const completed = steps.filter((s) => s.done).length;

  const stats = [
    { label: 'Published posts', value: data.counts.posts },
    { label: 'Drafts', value: data.counts.drafts },
    { label: 'Pages', value: data.counts.pages },
    {
      label: 'Comments',
      value: data.counts.comments,
      meta: data.counts.pendingComments
        ? `${data.counts.pendingComments} awaiting moderation`
        : undefined,
    },
  ];

  return (
    <>
      <PageHeader
        title={`Welcome, ${firstName}`}
        description={`Here’s what’s happening on ${data.site.title || 'your site'}.`}
      />

      <div className={styles.grid}>
        {!data.site.public && canManage && (
          <div className={styles.span12}>
            <Notice tone="warning" title="Search engines are asked not to index this site">
              That’s useful while you build. Remember to change it before you launch.
            </Notice>
          </div>
        )}

        <div className={styles.span12}>
          <section aria-label="At a glance" className={styles.stats}>
            {stats.map((stat) => (
              <div key={stat.label} className={styles.stat}>
                <span className={styles.statValue}>{stat.value.toLocaleString('en')}</span>
                <span className={styles.statLabel}>{stat.label}</span>
                {stat.meta && <span className={styles.statMeta}>{stat.meta}</span>}
              </div>
            ))}
          </section>
        </div>

        <div className={styles.span8}>
          <Card
            title="Get your site ready"
            description={`${completed} of ${steps.length} done`}
            actions={
              <Badge tone={completed === steps.length ? 'success' : 'accent'}>
                {Math.round((completed / steps.length) * 100)}%
              </Badge>
            }
          >
            <ul className={styles.checklist}>
              {steps.map((step) => (
                <li key={step.label}>
                  {step.done ? (
                    <CircleCheck size={20} className={styles.checkDone} aria-label="Done" />
                  ) : (
                    <Circle size={20} className={styles.checkTodo} aria-label="To do" />
                  )}
                  <span className={styles.checkLabel} data-done={step.done}>
                    {!step.done && step.href && canManage ? (
                      <Link href={step.href}>{step.label}</Link>
                    ) : (
                      step.label
                    )}
                  </span>
                  {!step.done && step.release && <Badge>Coming in {step.release}</Badge>}
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className={styles.span4}>
          <Card title="Site health">
            <dl className={styles.facts}>
              <div>
                <dt>Pressbase</dt>
                <dd>{data.system.version}</dd>
              </div>
              <div>
                <dt>Database</dt>
                <dd>{data.system.database === 'postgres' ? 'PostgreSQL' : 'Built-in'}</dd>
              </div>
              <div>
                <dt>Node.js</dt>
                <dd>{data.system.node}</dd>
              </div>
              <div>
                <dt>Search engines</dt>
                <dd>
                  {data.site.public ? (
                    'Allowed'
                  ) : (
                    <Badge tone="warning">
                      <EyeOff size={12} aria-hidden="true" /> Discouraged
                    </Badge>
                  )}
                </dd>
              </div>
            </dl>
            {data.system.database === 'pglite' && (
              <p
                style={{
                  marginTop: 'var(--space-3)',
                  fontSize: 'var(--text-sm)',
                  color: 'var(--color-text-muted)',
                }}
              >
                The built-in database is for trying Pressbase. Use PostgreSQL for a live site.
              </p>
            )}
          </Card>
        </div>

        <div className={styles.span12}>
          <Card title="Recently edited">
            {data.recent.length === 0 ? (
              <p style={{ color: 'var(--color-text-muted)' }}>
                Nothing yet. Your latest posts and pages will show here.
              </p>
            ) : (
              <ul className={styles.list}>
                {data.recent.map((item) => (
                  <li key={item.id}>
                    <span className={styles.listTitle}>{item.title || '(no title)'}</span>
                    <span className={styles.listMeta}>
                      {item.type === 'page' ? 'Page' : 'Post'}
                      {item.status === 'draft' ? ' · Draft' : ''} · {relativeTime(item.modified)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
