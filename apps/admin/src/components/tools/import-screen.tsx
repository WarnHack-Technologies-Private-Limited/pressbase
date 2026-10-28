'use client';

import { FileUp } from 'lucide-react';
import { type DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import {
  type AuthorValue,
  authorChoices,
  contentSummary,
  countLabel,
  defaultAuthorValue,
  fileSize,
  type ImportSession,
  importedLines,
  itemKind,
  percent,
  type ReportItem,
  type UploadedSession,
} from '@/lib/import-export';
import { PageHeader } from '../shell/page-header';
import { Button, ButtonLink } from '../ui/button';
import { Checkbox, SelectField } from '../ui/field';
import { Card, Notice } from '../ui/surface';
import { useToast } from '../ui/toast';
import styles from './tools.module.css';

/**
 * Tools → Import: the WordPress Importer's steps (upload, assign authors,
 * import), with the import itself running as a background job that this
 * screen follows. See docs/architecture/import-export.md.
 */

const POLL_MS = 1500;

/** POST /pressbase/v1/import with the file as the body, streamed by the browser. */
async function uploadFile(file: File): Promise<UploadedSession> {
  let res: Response;
  try {
    res = await fetch('/wp-json/pressbase/v1/import', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/xml',
        'content-disposition': `attachment; filename="${encodeURIComponent(file.name)}"`,
        'x-pressbase-request': '1',
      },
      body: file,
    });
  } catch {
    throw new ApiError(
      0,
      'pressbase_network_error',
      'Pressbase could not be reached. Check your connection and try again.',
    );
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.code ?? 'pressbase_unknown_error',
      data?.message ?? 'The file couldn’t be uploaded. Please try again.',
      data?.data ?? {},
    );
  }
  return data as UploadedSession;
}

function StepHeading({ children }: { children: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  // Multi-step flows move focus to the new step's heading (docs/design/accessibility.md).
  // Rendered inside the Card's <h2>, so it is focusable text, not a second heading.
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <span ref={ref} tabIndex={-1} className={styles.stepHeading}>
      {children}
    </span>
  );
}

export function ImportScreen({ meId, resume }: { meId: number; resume: ImportSession | null }) {
  const toast = useToast();
  const [session, setSession] = useState<ImportSession | UploadedSession | null>(resume);

  const restart = useCallback(() => setSession(null), []);

  let body: React.ReactNode;
  if (!session) {
    body = <UploadStep onUploaded={setSession} />;
  } else if (session.status === 'uploaded' && 'users' in session) {
    body = (
      <OptionsStep
        session={session}
        meId={meId}
        onStarted={setSession}
        onCancel={async () => {
          try {
            await api(`/pressbase/v1/import/${session.id}`, { method: 'DELETE' });
          } catch {
            // The upload is cleaned up after a week anyway.
          }
          restart();
        }}
      />
    );
  } else if (session.status === 'completed' || session.status === 'failed') {
    body = <ResultStep session={session} onAgain={restart} />;
  } else {
    body = (
      <ProgressStep
        session={session}
        onUpdate={(next) => {
          if (next.status === 'completed') {
            toast(
              next.report?.errors.total
                ? 'Import finished, with some problems.'
                : 'Import finished.',
              {
                tone: next.report?.errors.total ? 'danger' : 'success',
              },
            );
          } else if (next.status === 'failed') {
            toast('The import stopped.', { tone: 'danger' });
          }
          setSession(next);
        }}
      />
    );
  }

  return (
    <div className={styles.screen}>
      <PageHeader
        title="Import"
        description="Bring posts, pages, comments, categories, tags, menus and media from a WordPress site."
      />
      {body}
    </div>
  );
}

/* ------------------------------------------------------------- 1: upload */

function UploadStep({ onUploaded }: { onUploaded: (session: UploadedSession) => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const choose = (next: File | null) => {
    setFile(next);
    setError('');
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped) choose(dropped);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file) {
      setError('Choose the .xml file you downloaded from Tools → Export.');
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const session = await uploadFile(file);
      toast('Export file read.');
      onUploaded(session);
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : 'The file couldn’t be uploaded. Please try again.',
      );
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Upload a WordPress export file"
      description="On the other site, go to Tools → Export and download “All content”. Then choose that .xml file here."
    >
      <form className={styles.fields} onSubmit={submit} noValidate>
        <label
          className={[styles.drop, dragging && styles.dropActive].filter(Boolean).join(' ')}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <FileUp size={28} aria-hidden="true" />
          <span className={styles.dropTitle}>
            {file ? 'Choose a different file' : 'Choose a file, or drop it here'}
          </span>
          {file ? (
            <span className={styles.chosen}>
              {file.name} · {fileSize(file.size)}
            </span>
          ) : (
            <span>WordPress eXtended RSS (.xml)</span>
          )}
          <input
            ref={inputRef}
            type="file"
            name="import"
            accept=".xml,application/xml,text/xml"
            aria-label="WordPress export file"
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? 'import-file-error' : undefined}
            onChange={(e) => choose(e.target.files?.[0] ?? null)}
          />
        </label>
        {error && (
          <Notice tone="danger" id="import-file-error" title="That file can’t be imported.">
            {error}
          </Notice>
        )}
        <div className={styles.actions}>
          <Button type="submit" variant="primary" loading={busy}>
            {busy ? 'Reading the file…' : 'Upload file'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/* ------------------------------------------------------ 2: authors, media */

function OptionsStep({
  session,
  meId,
  onStarted,
  onCancel,
}: {
  session: UploadedSession;
  meId: number;
  onStarted: (session: ImportSession) => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [authors, setAuthors] = useState<Record<string, AuthorValue>>(() =>
    Object.fromEntries(
      session.authors.map((a) => [
        a.login,
        defaultAuthorValue(a, session.users, session.can_create_users, meId),
      ]),
    ),
  );
  const [fetchAttachments, setFetchAttachments] = useState(session.can_fetch_attachments);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const summary = contentSummary(session.counts);
  const media = session.counts.posts.attachment ?? 0;

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const started = await api<ImportSession>(`/pressbase/v1/import/${session.id}/start`, {
        method: 'POST',
        body: { authors: authorChoices(authors), fetch_attachments: fetchAttachments },
      });
      toast('Import started.');
      onStarted(started);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The import couldn’t start. Please try again.');
      setBusy(false);
    }
  };

  return (
    <>
      <Card title={<StepHeading>Check what will be imported</StepHeading>}>
        <div className={styles.fields}>
          <ul className={styles.facts}>
            <li>
              From <strong>{session.site.title || session.site.url || 'a WordPress site'}</strong>
              {session.site.url && session.site.title ? ` (${session.site.url})` : ''}
            </li>
            <li>
              <strong>{session.filename}</strong> · {fileSize(session.size)}
            </li>
          </ul>
          <p>{summary.length ? summary.join(' · ') : 'This file has no posts or pages.'}</p>
          {session.unsupported_types.length > 0 && (
            <Notice tone="warning" title="Some content has nowhere to go.">
              This site has no{' '}
              {session.unsupported_types.map((t, i) => (
                <span key={t}>
                  {i > 0 && (i === session.unsupported_types.length - 1 ? ' or ' : ', ')}“{t}”
                </span>
              ))}{' '}
              post type, so{' '}
              {session.unsupported_types
                .map((t) => countLabel(session.counts.posts[t] ?? 0, t))
                .join(' and ')}{' '}
              will be skipped. A plugin that adds the type may help; you can import the same file
              again afterwards.
            </Notice>
          )}
        </div>
      </Card>

      {session.authors.length > 0 && (
        <Card
          title="Assign authors"
          description={
            session.can_create_users
              ? 'Give each author’s posts to someone on this site, or create a user for them. New users get a random password and can reset it.'
              : 'Give each author’s posts to someone on this site.'
          }
        >
          <div className={styles.authors}>
            {session.authors.map((author) => (
              <SelectField
                key={author.login}
                label={`Posts by ${author.display_name}`}
                hint={
                  author.display_name === author.login ? undefined : `Username: ${author.login}`
                }
                value={authors[author.login]}
                onChange={(e) =>
                  setAuthors((current) => ({
                    ...current,
                    [author.login]: e.target.value as AuthorValue,
                  }))
                }
              >
                {session.can_create_users &&
                  !session.users.some(
                    (u) => u.login.toLowerCase() === author.login.toLowerCase(),
                  ) && <option value="new">New user: {author.login}</option>}
                {session.users.map((user) => (
                  <option key={user.id} value={String(user.id)}>
                    {user.name || user.login}
                    {user.id === meId ? ' (you)' : ''}
                  </option>
                ))}
              </SelectField>
            ))}
          </div>
        </Card>
      )}

      <Card title="Media">
        <Checkbox
          label="Download and import file attachments"
          description={
            session.can_fetch_attachments
              ? `Copies ${media ? countLabel(media, 'attachment') : 'images and files'} from the old site into your media library, and points your content at the copies. The old site must still be online.`
              : 'You can’t upload files on this site, so attachments can’t be downloaded.'
          }
          checked={fetchAttachments}
          disabled={!session.can_fetch_attachments}
          onChange={(e) => setFetchAttachments(e.target.checked)}
        />
      </Card>

      {error && (
        <Notice tone="danger" title="The import couldn’t start.">
          {error}
        </Notice>
      )}
      <div className={styles.actions}>
        <Button variant="primary" loading={busy} onClick={start}>
          {busy ? 'Starting…' : 'Start import'}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Choose a different file
        </Button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------ 3: progress */

function ProgressStep({
  session,
  onUpdate,
}: {
  session: ImportSession;
  onUpdate: (session: ImportSession) => void;
}) {
  const [current, setCurrent] = useState(session);
  const [stalled, setStalled] = useState(false);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    const poll = async () => {
      try {
        const next = await api<ImportSession>(`/pressbase/v1/import/${session.id}`);
        if (stopped) return;
        setCurrent(next);
        // Still queued after a while: the worker may be off in this process.
        setStalled(next.status === 'queued' && Date.now() - started > 20_000);
        if (next.status === 'completed' || next.status === 'failed') {
          onUpdateRef.current(next);
          return;
        }
      } catch {
        // A blip: try again on the next tick.
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    };
    timer = setTimeout(poll, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [session.id]);

  const progress = current.progress;
  const value = percent(progress);
  const label =
    current.status === 'queued'
      ? 'Waiting to start…'
      : progress?.phase === 'finishing'
        ? 'Linking everything up…'
        : progress
          ? `${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} items`
          : 'Starting…';

  return (
    <Card title={<StepHeading>Importing…</StepHeading>}>
      <div className={styles.fields}>
        <div className={styles.progressWrap}>
          <progress
            className={styles.progress}
            max={100}
            value={value}
            aria-label="Import progress"
            aria-valuetext={`${value}%`}
          />
          <div className={styles.progressMeta}>
            <span role="status">{label}</span>
            {progress?.current && current.status === 'running' && (
              <span className={styles.current} title={progress.current}>
                {progress.current}
              </span>
            )}
          </div>
        </div>
        <p>
          You can leave this page: the import carries on in the background, and this page shows
          where it is when you come back.
        </p>
        {stalled && (
          <Notice tone="warning" title="The import hasn’t started yet.">
            Background tasks may be turned off in this Pressbase process (PRESSBASE_WORKER=off). It
            starts as soon as a process with a worker picks it up.
          </Notice>
        )}
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------- 4: result */

function ItemList({ items, total }: { items: ReportItem[]; total: number }) {
  return (
    <>
      <ul className={styles.itemList}>
        {items.map((item, i) => (
          <li key={`${item.kind}:${item.id ?? item.title}:${i}`}>
            <span className={styles.itemKind}>{itemKind(item)}</span>
            <span className={styles.itemTitle}>{item.title || 'Untitled'}</span>
            <span className={styles.itemReason}>{item.reason}</span>
          </li>
        ))}
      </ul>
      {total > items.length && (
        <p className={styles.more}>
          And {(total - items.length).toLocaleString()} more, not listed here.
        </p>
      )}
    </>
  );
}

function ResultStep({ session, onAgain }: { session: ImportSession; onAgain: () => void }) {
  const report = session.report;
  if (session.status === 'failed' || !report) {
    return (
      <Card title={<StepHeading>The import stopped</StepHeading>}>
        <div className={styles.fields}>
          <Notice tone="danger" title="Pressbase couldn’t finish importing this file.">
            {session.error || 'Something went wrong while importing.'} Anything imported before it
            stopped is kept; importing the same file again skips it and carries on.
          </Notice>
          <div className={styles.actions}>
            <Button variant="primary" onClick={onAgain}>
              Import a file
            </Button>
          </div>
        </div>
      </Card>
    );
  }
  const lines = importedLines(report);
  const posts = report.imported.posts.post ?? 0;
  return (
    <Card title={<StepHeading>Import finished</StepHeading>}>
      <div className={styles.fields}>
        {report.errors.total > 0 ? (
          <Notice
            tone="warning"
            title={`${report.errors.total.toLocaleString()} ${report.errors.total === 1 ? 'item' : 'items'} couldn’t be imported.`}
          >
            The reasons are listed below. Everything else is in place.
          </Notice>
        ) : (
          <Notice tone="success" title="Everything in the file is in place.">
            {report.skipped.total > 0
              ? 'Some items were skipped on purpose; they’re listed below.'
              : 'Have a look around.'}
          </Notice>
        )}
        {lines.length > 0 ? (
          <ul className={styles.results} aria-label="Imported">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <p>Nothing new was imported.</p>
        )}
        {report.errors.total > 0 && (
          <details className={styles.details} open>
            <summary>Problems ({report.errors.total.toLocaleString()})</summary>
            <ItemList items={report.errors.items} total={report.errors.total} />
          </details>
        )}
        {report.skipped.total > 0 && (
          <details className={styles.details}>
            <summary>Skipped ({report.skipped.total.toLocaleString()})</summary>
            <ItemList items={report.skipped.items} total={report.skipped.total} />
          </details>
        )}
        <div className={styles.actions}>
          <ButtonLink href={posts ? '/admin/posts' : '/admin/pages'} variant="primary">
            {posts ? 'View posts' : 'View pages'}
          </ButtonLink>
          <Button variant="ghost" onClick={onAgain}>
            Import another file
          </Button>
        </div>
      </div>
    </Card>
  );
}
