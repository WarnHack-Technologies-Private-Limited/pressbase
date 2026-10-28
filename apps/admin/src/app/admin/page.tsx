import { Circle, CircleCheck, EyeOff } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { DashboardWidgets } from '@/components/extensions/dashboard-widgets';
import styles from '@/components/shell/page.module.css';
import { PageHeader } from '@/components/shell/page-header';
import { SiteHealthSummary } from '@/components/site-health/site-health-summary';
import { Badge, Card, Notice } from '@/components/ui/surface';
import { commentPlainText, type RestComment } from '@/lib/comments';
import { coreGet, type Me, type SiteIndex } from '@/lib/core';
import { formatNumber } from '@/lib/i18n/locale';
import { getI18n } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { __ } = await getI18n();
  return { title: __('Dashboard', 'pressbase-admin') };
}

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

function relativeTime(iso: string, lang: string, justNow: string): string {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
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
  return justNow;
}

export default async function DashboardPage() {
  const [dashboard, current, index, { __, _x, _n, sprintf, lang }] = await Promise.all([
    coreGet<Dashboard>('/pressbase/v1/dashboard'),
    coreGet<Me>('/wp/v2/users/me'),
    coreGet<SiteIndex>('/'),
    getI18n(),
  ]);
  const ago = (iso: string) => relativeTime(iso, lang, __('just now', 'pressbase-admin'));
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
    { label: __('Install Pressbase', 'pressbase-admin'), done: true },
    {
      label: __('Give your site a name', 'pressbase-admin'),
      done: Boolean(site.name),
      href: '/admin/settings/general',
      capability: 'manage_options',
    },
    {
      label: __('Add a tagline', 'pressbase-admin'),
      done: Boolean(site.description),
      href: '/admin/settings/general',
      capability: 'manage_options',
    },
    {
      // The installer's "Hello world!" doesn't count.
      label: __('Write your first post', 'pressbase-admin'),
      done: data.counts.posts + data.counts.drafts > 1,
      href: '/admin/posts/new',
      capability: 'edit_posts',
    },
    {
      label: __('Invite your team', 'pressbase-admin'),
      done: data.counts.users > 1,
      href: '/admin/users/new',
      capability: 'create_users',
    },
    {
      label: __('Make the site look like yours', 'pressbase-admin'),
      done: data.appearance.customized,
      href: '/admin/appearance/styles',
      capability: 'edit_theme_options',
    },
  ];
  const completed = steps.filter((s) => s.done).length;

  const stats: { label: string; value: number; meta?: string; href?: string }[] = [
    { label: __('Published posts', 'pressbase-admin'), value: data.counts.posts },
    { label: __('Drafts', 'pressbase-admin'), value: data.counts.drafts },
    { label: __('Pages', 'pressbase-admin'), value: data.counts.pages },
    {
      label: __('Comments', 'pressbase-admin'),
      value: data.counts.comments,
      meta: data.counts.pendingComments
        ? sprintf(
            // translators: %s: a number of comments.
            _n(
              '%s awaiting moderation',
              '%s awaiting moderation',
              data.counts.pendingComments,
              'pressbase-admin',
            ),
            formatNumber(data.counts.pendingComments, lang),
          )
        : undefined,
      href: canModerate ? '/admin/comments?comment_status=moderated' : undefined,
    },
  ];

  // " · " between list details, as in "Post · Draft · 2 hours ago".
  const details = (...parts: string[]) => parts.filter(Boolean).join(__(' · ', 'pressbase-admin'));

  return (
    <>
      <PageHeader
        title={
          // translators: %s: the user's first name.
          sprintf(__('Welcome, %s', 'pressbase-admin'), firstName ?? '')
        }
        description={sprintf(
          // translators: %s: the site's title.
          __('Here’s what’s happening on %s.', 'pressbase-admin'),
          data.site.title || __('your site', 'pressbase-admin'),
        )}
      />

      <div className={styles.grid}>
        {!data.site.public && canManage && (
          <div className={styles.span12}>
            <Notice
              tone="warning"
              title={__('Search engines are asked not to index this site', 'pressbase-admin')}
            >
              {__(
                'That’s useful while you build. Remember to change it before you launch.',
                'pressbase-admin',
              )}
            </Notice>
          </div>
        )}

        <div className={styles.span12}>
          <section aria-label={__('At a glance', 'pressbase-admin')} className={styles.stats}>
            {stats.map((stat) => (
              <div key={stat.label} className={styles.stat}>
                <span className={styles.statValue}>{formatNumber(stat.value, lang)}</span>
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
            title={__('Get your site ready', 'pressbase-admin')}
            description={sprintf(
              // translators: 1: steps done, 2: all steps.
              __('%1$s of %2$s done', 'pressbase-admin'),
              formatNumber(completed, lang),
              formatNumber(steps.length, lang),
            )}
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
                    <CircleCheck
                      size={20}
                      className={styles.checkDone}
                      aria-label={__('Done', 'pressbase-admin')}
                    />
                  ) : (
                    <Circle
                      size={20}
                      className={styles.checkTodo}
                      aria-label={__('To do', 'pressbase-admin')}
                    />
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
                  {!step.done && step.release && (
                    <Badge>
                      {
                        // translators: %s: a version number.
                        sprintf(__('Coming in %s', 'pressbase-admin'), step.release)
                      }
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className={styles.span4}>
          <Card title={__('Site health', 'pressbase-admin')}>
            {/* Site Health (v0.6): the last check's rating, and a link to the screen. */}
            <SiteHealthSummary />
            <dl className={styles.facts}>
              <div>
                <dt>Pressbase</dt>
                <dd>{data.system.version}</dd>
              </div>
              <div>
                <dt>{__('Database', 'pressbase-admin')}</dt>
                <dd>
                  {data.system.database === 'postgres'
                    ? 'PostgreSQL'
                    : _x('Built-in', 'database', 'pressbase-admin')}
                </dd>
              </div>
              <div>
                <dt>Node.js</dt>
                <dd>{data.system.node}</dd>
              </div>
              <div>
                <dt>{__('Search engines', 'pressbase-admin')}</dt>
                <dd>
                  {data.site.public ? (
                    _x('Allowed', 'search engines', 'pressbase-admin')
                  ) : (
                    <Badge tone="warning">
                      <EyeOff size={12} aria-hidden="true" />{' '}
                      {_x('Discouraged', 'search engines', 'pressbase-admin')}
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
                {__(
                  'The built-in database is for trying Pressbase. Use PostgreSQL for a live site.',
                  'pressbase-admin',
                )}
              </p>
            )}
          </Card>
        </div>

        <div className={canModerate ? styles.span8 : styles.span12}>
          <Card title={__('Recently edited', 'pressbase-admin')}>
            {data.recent.length === 0 ? (
              <p style={{ color: 'var(--color-text-muted)' }}>
                {__('Nothing yet. Your latest posts and pages will show here.', 'pressbase-admin')}
              </p>
            ) : (
              <ul className={styles.list}>
                {data.recent.map((item) => (
                  <li key={item.id}>
                    <Link
                      href={`/admin/${item.type === 'page' ? 'pages' : 'posts'}/${item.id}`}
                      className={styles.listTitle}
                    >
                      {item.title || __('(no title)', 'pressbase-admin')}
                    </Link>
                    <span className={styles.listMeta}>
                      {details(
                        item.type === 'page'
                          ? _x('Page', 'post type singular name', 'pressbase-admin')
                          : _x('Post', 'post type singular name', 'pressbase-admin'),
                        item.status === 'draft'
                          ? _x('Draft', 'post status', 'pressbase-admin')
                          : '',
                        ago(item.modified),
                      )}
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
              title={__('Recent comments', 'pressbase-admin')}
              actions={
                <Link href="/admin/comments" className={styles.cardLink}>
                  {__('View all', 'pressbase-admin')}
                </Link>
              }
            >
              {recentComments.length === 0 ? (
                <p style={{ color: 'var(--color-text-muted)' }}>
                  {__(
                    'No comments yet. When readers comment, they’ll show here.',
                    'pressbase-admin',
                  )}
                </p>
              ) : (
                <ul className={styles.list}>
                  {recentComments.map((comment) => (
                    <li key={comment.id} className={styles.commentItem}>
                      <Link href={`/admin/comments?c=${comment.id}`} className={styles.listTitle}>
                        {commentPlainText(comment.content.rendered) ||
                          __('(empty)', 'pressbase-admin')}
                      </Link>
                      <span className={styles.listMeta}>
                        {details(
                          comment.author_name || __('Anonymous', 'pressbase-admin'),
                          comment.status === 'hold'
                            ? _x('Pending', 'comment status', 'pressbase-admin')
                            : '',
                          comment.status === 'spam'
                            ? _x('Spam', 'comment status', 'pressbase-admin')
                            : '',
                          ago(`${comment.date_gmt}Z`),
                        )}
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
