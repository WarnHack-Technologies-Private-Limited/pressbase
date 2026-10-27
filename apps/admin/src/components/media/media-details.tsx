'use client';

import { Check, ChevronLeft, ChevronRight, Copy, ExternalLink, X } from 'lucide-react';
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { formatLocalDate, plainTitle, type RestUser } from '@/lib/content';
import { fileName, formatBytes, type RestMedia, typeLabel } from '@/lib/media';
import { useCurrentUser } from '../shell/current-user';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/dialog';
import { TextAreaField, TextField } from '../ui/field';
import { Notice } from '../ui/surface';
import { useToast } from '../ui/toast';
import styles from './media.module.css';
import { FileIcon } from './media-grid';

interface Draft {
  alt_text: string;
  title: string;
  caption: string;
  description: string;
}

const draftOf = (media: RestMedia): Draft => ({
  alt_text: media.alt_text ?? '',
  title: media.title.raw ?? plainTitle(media.title.rendered),
  caption: media.caption.raw ?? '',
  description: media.description.raw ?? '',
});

/** Mirrors map_meta_cap() for attachments, to show or hide actions. The server decides. */
function useAttachmentCaps(media: RestMedia) {
  const me = useCurrentUser();
  const own = media.author === me.id;
  return {
    edit: Boolean(me.capabilities[own ? 'edit_posts' : 'edit_others_posts']),
    delete: Boolean(me.capabilities[own ? 'delete_posts' : 'delete_others_posts']),
  };
}

/**
 * The attachment details dialog: a preview, facts about the file, the URL to
 * copy, editable text fields with an explicit Save, and permanent deletion.
 * Closing with unsaved changes asks first.
 */
export function MediaDetails({
  media,
  onClose,
  onSaved,
  onDeleted,
  onPrevious,
  onNext,
}: {
  media: RestMedia;
  onClose: () => void;
  onSaved: (media: RestMedia) => void;
  onDeleted: (id: number) => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const toast = useToast();
  const caps = useAttachmentCaps(media);
  const ref = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const [draft, setDraft] = useState<Draft>(() => draftOf(media));
  const [saved, setSaved] = useState<Draft>(() => draftOf(media));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'delete' | 'discard' | null>(null);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [author, setAuthor] = useState<string>();
  const [copied, setCopied] = useState(false);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved]);

  // A different item (previous / next): reset the form.
  useEffect(() => {
    setDraft(draftOf(media));
    setSaved(draftOf(media));
    setErrors({});
    setProblem(undefined);
    setCopied(false);
    headingRef.current?.focus();
  }, [media]);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setAuthor(undefined);
    if (media.author) {
      api<RestUser>(`/wp/v2/users/${media.author}`)
        .then((u) => !cancelled && setAuthor(u.name))
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [media.author]);

  /** Runs `action` now, or after confirming that unsaved changes may be lost. */
  const guard = (action: () => void) => {
    if (dirty) {
      setPending(() => action);
      setConfirm('discard');
    } else action();
  };

  const set = (key: keyof Draft, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors(({ [key]: _, ...rest }) => rest);
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(undefined);
    try {
      const updated = await api<RestMedia>(`/wp/v2/media/${media.id}`, {
        method: 'POST',
        body: draft,
      });
      setSaved(draftOf(updated));
      setDraft(draftOf(updated));
      onSaved(updated);
      toast('Changes saved.');
    } catch (error) {
      if (error instanceof ApiError && error.data.params) setErrors(error.data.params);
      else setProblem(error instanceof ApiError ? error.message : 'Could not save your changes.');
    } finally {
      setBusy(false);
    }
  }

  async function destroy() {
    setBusy(true);
    try {
      await api(`/wp/v2/media/${media.id}?force=true`, { method: 'DELETE' });
      setConfirm(null);
      toast(`“${plainTitle(media.title.rendered) || fileName(media)}” was deleted.`);
      onDeleted(media.id);
    } catch (error) {
      setConfirm(null);
      setProblem(error instanceof ApiError ? error.message : 'Could not delete the file.');
    } finally {
      setBusy(false);
    }
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(media.source_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure origin): select the text so it can be copied by hand.
      const input = document.getElementById(`${titleId}-url`) as HTMLInputElement | null;
      input?.select();
    }
  }

  const details = media.media_details;
  const isImage = media.media_type === 'image';
  const kind = media.mime_type.split('/')[0];
  const title = plainTitle(media.title.rendered) || fileName(media);
  const preview =
    details.sizes.large?.source_url ?? details.sizes.full?.source_url ?? media.source_url;

  return (
    <dialog
      ref={ref}
      className={styles.details}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy && !confirm) guard(onClose);
      }}
      onKeyDown={(e) => {
        // Arrow keys page between items, unless typing in a field.
        const target = e.target as HTMLElement;
        if (confirm || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
        if (e.key === 'ArrowLeft' && onPrevious) guard(onPrevious);
        if (e.key === 'ArrowRight' && onNext) guard(onNext);
      }}
    >
      <header className={styles.detailsHeader}>
        <h2 id={titleId} ref={headingRef} tabIndex={-1} className={styles.detailsTitle}>
          {title}
        </h2>
        <div className={styles.detailsNav}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => onPrevious && guard(onPrevious)}
            disabled={!onPrevious}
            aria-label="Previous item"
            title="Previous item"
          >
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => onNext && guard(onNext)}
            disabled={!onNext}
            aria-label="Next item"
            title="Next item"
          >
            <ChevronRight size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => guard(onClose)}
            aria-label="Close"
            title="Close"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className={styles.detailsBody}>
        <div className={styles.preview}>
          {isImage ? (
            <img src={preview} alt={media.alt_text} className={styles.previewImage} />
          ) : kind === 'video' ? (
            // biome-ignore lint/a11y/useMediaCaption: uploaded videos have no caption track yet.
            <video
              src={media.source_url}
              controls
              preload="metadata"
              className={styles.previewVideo}
            />
          ) : kind === 'audio' ? (
            <div className={styles.previewFile}>
              <FileIcon mime={media.mime_type} size={48} />
              {/* biome-ignore lint/a11y/useMediaCaption: audio files have no caption track. */}
              <audio src={media.source_url} controls preload="metadata" />
            </div>
          ) : (
            <div className={styles.previewFile}>
              <FileIcon mime={media.mime_type} size={48} />
              <span className={styles.previewType}>{typeLabel(media)}</span>
            </div>
          )}
        </div>

        <div className={styles.side}>
          <dl className={styles.facts}>
            <div>
              <dt>File name</dt>
              <dd className={styles.breakAll}>{fileName(media)}</dd>
            </div>
            <div>
              <dt>File type</dt>
              <dd>{media.mime_type}</dd>
            </div>
            <div>
              <dt>File size</dt>
              <dd>{formatBytes(details.filesize)}</dd>
            </div>
            {isImage && details.width && details.height && (
              <div>
                <dt>Dimensions</dt>
                <dd>
                  {details.width.toLocaleString('en-US')} × {details.height.toLocaleString('en-US')}{' '}
                  pixels
                </dd>
              </div>
            )}
            <div>
              <dt>Uploaded on</dt>
              <dd>{formatLocalDate(media.date)}</dd>
            </div>
            <div>
              <dt>Uploaded by</dt>
              <dd>{author ?? '—'}</dd>
            </div>
          </dl>

          <div className={styles.urlRow}>
            <label htmlFor={`${titleId}-url`} className={styles.urlLabel}>
              File URL
            </label>
            <div className={styles.urlControls}>
              <input
                id={`${titleId}-url`}
                className={styles.urlInput}
                value={media.source_url}
                readOnly
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                size="sm"
                onClick={copyUrl}
                icon={
                  copied ? (
                    <Check size={14} aria-hidden="true" />
                  ) : (
                    <Copy size={14} aria-hidden="true" />
                  )
                }
              >
                {copied ? 'Copied' : 'Copy URL'}
              </Button>
            </div>
            <span className="visually-hidden" aria-live="polite">
              {copied ? 'URL copied to the clipboard.' : ''}
            </span>
            <a href={media.source_url} target="_blank" rel="noreferrer" className={styles.viewLink}>
              View file <ExternalLink size={13} aria-hidden="true" />
              <span className="visually-hidden"> (opens in a new tab)</span>
            </a>
          </div>

          <form id={`${titleId}-form`} className={styles.form} onSubmit={save} noValidate>
            {problem && <Notice tone="danger" title={problem} />}
            {isImage && (
              <TextAreaField
                label="Alternative text"
                optional
                rows={2}
                value={draft.alt_text}
                onChange={(e) => set('alt_text', e.target.value)}
                error={errors.alt_text}
                disabled={!caps.edit}
                hint={
                  <>
                    Describe what the image shows for people who can’t see it. Leave it empty if the
                    image is purely decorative.
                  </>
                }
              />
            )}
            <TextField
              label="Title"
              optional
              value={draft.title}
              onChange={(e) => set('title', e.target.value)}
              error={errors.title}
              disabled={!caps.edit}
            />
            <TextAreaField
              label="Caption"
              optional
              rows={2}
              value={draft.caption}
              onChange={(e) => set('caption', e.target.value)}
              error={errors.caption}
              disabled={!caps.edit}
            />
            <TextAreaField
              label="Description"
              optional
              rows={3}
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
              error={errors.description}
              disabled={!caps.edit}
            />
          </form>
        </div>
      </div>

      {(caps.edit || caps.delete) && (
        <footer className={styles.detailsFooter}>
          {caps.delete && (
            <Button variant="danger" size="sm" onClick={() => setConfirm('delete')} disabled={busy}>
              Delete permanently
            </Button>
          )}
          <span className={styles.spacer} />
          {caps.edit && (
            <>
              {dirty && <span className={styles.unsaved}>Unsaved changes</span>}
              <Button
                type="submit"
                form={`${titleId}-form`}
                variant="primary"
                loading={busy && confirm === null}
                disabled={!dirty}
              >
                {busy && confirm === null ? 'Saving…' : 'Save changes'}
              </Button>
            </>
          )}
        </footer>
      )}

      <ConfirmDialog
        open={confirm === 'delete'}
        title="Delete permanently?"
        confirmLabel="Delete permanently"
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={destroy}
      >
        “{title}” and all its sizes will be deleted. Posts that use it will show a broken image.
        This can’t be undone.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'discard'}
        title="Discard unsaved changes?"
        confirmLabel="Discard changes"
        onCancel={() => {
          setConfirm(null);
          setPending(null);
        }}
        onConfirm={() => {
          setConfirm(null);
          setDraft(saved);
          const action = pending;
          setPending(null);
          action?.();
        }}
      >
        Your edits to this file’s details haven’t been saved.
      </ConfirmDialog>
    </dialog>
  );
}
