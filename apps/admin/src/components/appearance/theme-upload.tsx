'use client';

import { FileArchive, Upload } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { type DragEvent, useEffect, useRef, useState } from 'react';
import { useCan } from '@/components/shell/current-user';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import {
  fileSize,
  isZipFile,
  type ThemeConflict,
  ThemeUploadError,
  uploadTheme,
} from '@/lib/themes';
import styles from './theme-upload.module.css';

type Phase = 'choose' | 'uploading' | 'conflict';

/**
 * Appearance → Themes → Upload theme (wp-admin/theme-install.php?upload and
 * update.php?action=upload-theme): a dialog with a drop zone for one .zip,
 * upload progress, the server's errors in plain words, and WordPress's
 * "Replace current with uploaded" step when the theme is already installed.
 * After an install the list shows the theme with its Activate button focused.
 */
export function ThemeUploadButton({ activeStylesheet }: { activeStylesheet: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const canInstall = useCan('install_themes');
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('choose');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  const [conflict, setConflict] = useState<ThemeConflict | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (phase === 'conflict') backRef.current?.focus();
  }, [phase]);

  if (!canInstall) return null;

  const reset = () => {
    setPhase('choose');
    setFile(null);
    setError('');
    setProgress(0);
    setConflict(null);
  };

  const close = () => {
    abort.current?.abort();
    setOpen(false);
    reset();
  };

  const choose = (next: File | null) => {
    setConflict(null);
    setPhase('choose');
    if (next && !isZipFile(next)) {
      setFile(null);
      setError(`“${next.name}” isn’t a .zip file. Choose the theme’s .zip download.`);
      return;
    }
    setFile(next);
    setError('');
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 1) {
      setError('Drop one .zip file at a time.');
      return;
    }
    choose(event.dataTransfer.files[0] ?? null);
  };

  const install = async (overwrite = false) => {
    if (!file) {
      setError('Choose a theme’s .zip file first.');
      inputRef.current?.focus();
      return;
    }
    setPhase('uploading');
    setError('');
    setProgress(0);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const theme = await uploadTheme(file, {
        overwrite,
        onProgress: setProgress,
        signal: controller.signal,
      });
      const name = theme.name.raw || theme.stylesheet;
      toast(
        overwrite
          ? `${name} was replaced with version ${theme.version}.`
          : `${name} was installed.`,
      );
      setOpen(false);
      reset();
      router.replace(`${pathname}?installed=${encodeURIComponent(theme.stylesheet)}`, {
        scroll: false,
      });
      router.refresh();
    } catch (e) {
      if (e instanceof ThemeUploadError && e.code === 'pressbase_upload_cancelled') return;
      if (e instanceof ThemeUploadError && e.conflict && !overwrite) {
        setConflict(e.conflict);
        setPhase('conflict');
        return;
      }
      setPhase('choose');
      setError(
        e instanceof ThemeUploadError ? e.message : 'The theme couldn’t be installed. Try again.',
      );
      inputRef.current?.focus();
    } finally {
      abort.current = null;
    }
  };

  const percent = Math.round(progress * 100);
  const uploading = phase === 'uploading';

  const footer =
    phase === 'conflict' ? (
      <>
        <Button ref={backRef} variant="ghost" onClick={() => choose(null)}>
          Choose another file
        </Button>
        <Button variant="primary" onClick={() => install(true)}>
          {conflict?.current.stylesheet === activeStylesheet
            ? 'Replace the active theme'
            : 'Replace the installed theme'}
        </Button>
      </>
    ) : (
      <>
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" loading={uploading} onClick={() => install(false)}>
          {uploading ? 'Installing…' : 'Install theme'}
        </Button>
      </>
    );

  return (
    <>
      <Button
        variant="primary"
        icon={<Upload size={16} aria-hidden="true" />}
        onClick={() => setOpen(true)}
      >
        Upload theme
      </Button>
      <Dialog
        open={open}
        title={phase === 'conflict' ? 'Replace the installed theme?' : 'Upload a theme'}
        footer={footer}
        initialFocus={inputRef}
        onClose={close}
      >
        {phase === 'conflict' && conflict ? (
          <ConflictDetails conflict={conflict} activeStylesheet={activeStylesheet} />
        ) : (
          <div className={styles.fields}>
            <p className={styles.intro}>
              Choose a block theme’s .zip file. Pressbase runs block themes only: themes with a
              templates/index.html file. Classic PHP themes won’t install.
            </p>
            <label
              className={[styles.drop, dragging && styles.dropActive].filter(Boolean).join(' ')}
              data-disabled={uploading || undefined}
              onDragOver={(e) => {
                e.preventDefault();
                if (!uploading) setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => (uploading ? e.preventDefault() : onDrop(e))}
            >
              <FileArchive size={28} aria-hidden="true" />
              <span className={styles.dropTitle}>
                {file ? 'Choose a different file' : 'Choose a .zip file, or drop it here'}
              </span>
              {file ? (
                <span className={styles.chosen}>
                  {file.name} · {fileSize(file.size)}
                </span>
              ) : (
                <span>One theme at a time</span>
              )}
              <input
                ref={inputRef}
                type="file"
                accept=".zip,application/zip"
                aria-label="Theme .zip file"
                aria-invalid={Boolean(error) || undefined}
                aria-describedby={error ? 'theme-upload-error' : undefined}
                disabled={uploading}
                onChange={(e) => {
                  choose(e.target.files?.[0] ?? null);
                  e.target.value = '';
                }}
              />
            </label>
            {uploading && (
              <div className={styles.progressWrap}>
                <progress
                  className={styles.progress}
                  max={100}
                  value={percent}
                  aria-label="Upload progress"
                  aria-valuetext={`${percent}%`}
                />
                <div className={styles.progressMeta}>
                  <span role="status">
                    {percent < 100 ? 'Uploading…' : 'Checking and installing the theme…'}
                  </span>
                  <span aria-hidden="true">{percent}%</span>
                </div>
              </div>
            )}
            {error && (
              <Notice tone="danger" id="theme-upload-error" title="The theme wasn’t installed.">
                {error}
              </Notice>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}

/** Theme_Installer_Skin::do_overwrite(): the installed and uploaded copies side by side. */
function ConflictDetails({
  conflict,
  activeStylesheet,
}: {
  conflict: ThemeConflict;
  activeStylesheet: string;
}) {
  const { current, uploaded } = conflict;
  const active = current.stylesheet === activeStylesheet;
  const rows: [string, string, string][] = [
    ['Theme name', current.name, uploaded.name],
    ['Version', current.version || '—', uploaded.version || '—'],
    ['Author', current.author || '—', uploaded.author || '—'],
  ];
  if (current.template || uploaded.template) {
    rows.push(['Parent theme', current.template || '—', uploaded.template || '—']);
  }
  return (
    <div className={styles.fields}>
      <p className={styles.intro}>
        A theme is already installed in the “{current.stylesheet}” folder. Replacing it swaps its
        files for the uploaded ones; your saved styles stay.
        {active && ' It’s your active theme, so visitors see the new version straight away.'}
      </p>
      {current.source === 'bundled' && (
        <Notice tone="info">
          The installed copy ships with Pressbase. Your upload is used instead of it, and deleting
          the upload later brings the bundled copy back.
        </Notice>
      )}
      <table className={styles.compare}>
        <thead>
          <tr>
            <td />
            <th scope="col">Installed</th>
            <th scope="col">Uploaded</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, now, next]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{now}</td>
              <td data-changed={now !== next || undefined}>{next}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
