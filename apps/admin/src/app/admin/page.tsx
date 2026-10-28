import { Circle, CircleCheck, EyeOff } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { DashboardWidgets } from '@/components/extensions/dashboard-widgets';
import styles from '@/components/shell/page.module.css';
import { PageHeader } from '@/components/shell/page-header';
import { Badge, Card, Notice } from '@/components/ui/surface';
import { commentPlainText, type RestComment } from '@/lib/comments';
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
    users: number;
  };
  appearance: { customized: boolean };
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
  const [dashboard, current, index] = await Promise.all([
    coreGet<Dashboard>('/pressbase/v1/dashboard'),
    coreGet<Me>('/wp/v2/users/me'),
    coreGet<SiteIndex>('/'),
  ]);
  // Logged out or not installed: the admin layout is already redirecting, and
  // the error bodies have none of the fields below.
  if (dashboard.status !== 200 || current.status !== 200) return null;
  const { data } = dashboard;
  const { data: me } = current;
  const { data: site } = index;
  const firstName = me.name.split(/\s+/)[0];
  const canManage = Boolean(me.capabilities.manage_options);
  const canModerate = Boolean(me.capabilities.moderate_comments);
  // Recent comments, for people who moderate them (WordPress's Activity widget).
  const comments = canModerate
    ? await coreGet<RestComment[]>('/wp/v2/comments?per_page=5&status=all&context=edit')
    : undefined;
  const recentComments = comments?.status === 200 ? comments.data : [];

  const steps: {
    label: string;
    done: boolean;
    href?: string;
    capability?: string;
    release?: string;
  }[] = [
    { label: 'Install Pressbase', done: true },
    {
      label: 'Give your site a name',
      done: Boolean(site.name),
      href: '/admin/settings/general',
      capability: 'manage_options',
    },
    {
      label: 'Add a tagline',
      done: Boolean(site.description),
      href: '/admin/settings/general',
      capability: 'manage_options',
    },
    {
      // The installer's "Hello world!" doesn't count.
      label: 'Write your first post',
      done: data.counts.posts + data.counts.drafts > 1,
      href: '/admin/posts/new',
      capability: 'edit_posts',
    },
    {
      label: 'Invite your team',
      done: data.counts.users > 1,
      href: '/admin/users/new',
      capability: 'create_users',
    },
    {
      label: 'Make the site look like yours',
      done: data.appearance.customized,
      href: '/admin/appearance/styles',
      capability: 'edit_theme_options',
    },
  ];
  const completed = steps.filter((s) => s.done).length;

  const stats: { label: string; value: number; meta?: string; href?: string }[] = [
    { label: 'Published posts', value: data.counts.posts },
    { label: 'Drafts', value: data.counts.drafts },
    { label: 'Pages', value: data.counts.pages },
    {
      label: 'Comments',
      value: data.counts.comments,
      meta: data.counts.pendingComments
        ? `${data.counts.pendingComments} awaiting moderation`
        : undefined,
      href: canModerate ? '/admin/comments?comment_status=moderated' : undefined,
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
                {stat.meta &&
                  (stat.href ? (
                    <Link href={stat.href} className={styles.statMeta}>
                      {stat.meta}
                    </Link>
                  ) : (
                    <span className={styles.statMeta}>{stat.meta}</span>
                  ))}
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
                    {!step.done &&
                    step.href &&
                    step.capability &&
                    me.capabilities[step.capability] ? (
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

        <div className={canModerate ? styles.span8 : styles.span12}>
          <Card title="Recently edited">
            {data.recent.length === 0 ? (
              <p style={{ color: 'var(--color-text-muted)' }}>
                Nothing yet. Your latest posts and pages will show here.
              </p>
            ) : (
              <ul className={styles.list}>
                {data.recent.map((item) => (
                  <li key={item.id}>
                    <Link
                      href={`/admin/${item.type === 'page' ? 'pages' : 'posts'}/${item.id}`}
                      className={styles.listTitle}
                    >
                      {item.title || '(no title)'}
                    </Link>
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

        {canModerate && (
          <div className={styles.span4}>
            <Card
              title="Recent comments"
              actions={
                <Link href="/admin/comments" className={styles.cardLink}>
                  View all
                </Link>
              }
            >
              {recentComments.length === 0 ? (
                <p style={{ color: 'var(--color-text-muted)' }}>
                  No comments yet. When readers comment, they’ll show here.
                </p>
              ) : (
                <ul className={styles.list}>
                  {recentComments.map((comment) => (
                    <li key={comment.id} className={styles.commentItem}>
                      <Link href={`/admin/comments?c=${comment.id}`} className={styles.listTitle}>
                        {commentPlainText(comment.content.rendered) || '(empty)'}
                      </Link>
                      <span className={styles.listMeta}>
                        {comment.author_name || 'Anonymous'}
                        {comment.status === 'hold' ? ' · Pending' : ''}
                        {comment.status === 'spam' ? ' · Spam' : ''} ·{' '}
                        {relativeTime(`${comment.date_gmt}Z`)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}

        {/* Plugins' dashboard widgets (the `dashboard` slot). */}
        <DashboardWidgets />
      </div>
    </>
  );
}
