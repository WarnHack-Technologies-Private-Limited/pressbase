'use client';

import { Paintbrush, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useCan } from '@/components/shell/current-user';
import { Button, ButtonLink } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { ActionMenu } from '@/components/ui/menu';
import { Badge, Card, EmptyState } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { canDeleteTheme, type RestTheme, themeAuthor, themeName } from '@/lib/themes';
import styles from './theme-list.module.css';

/**
 * The installed themes as cards: "Activate" on the inactive ones, and a menu
 * with "Delete" on the ones that can go (uploaded, not in use). A theme just
 * uploaded (`?installed=`) is marked "New" and its Activate button focused.
 */
export function ThemeList({
  themes,
  installed = null,
}: {
  themes: RestTheme[];
  /** The stylesheet of a theme just uploaded. */
  installed?: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const canSwitch = useCan('switch_themes');
  const canEditStyles = useCan('edit_theme_options');
  const canDelete = useCan('delete_themes');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<RestTheme | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // After an upload, bring the new theme into view and focus its first action.
  const present = themes.some((t) => t.stylesheet === installed);
  useEffect(() => {
    if (!installed || !present) return;
    const card = listRef.current?.querySelector<HTMLElement>(
      `[data-stylesheet="${CSS.escape(installed)}"]`,
    );
    if (!card) return;
    card.scrollIntoView({ block: 'nearest' });
    (card.querySelector<HTMLElement>('[data-primary-action]') ?? card).focus();
  }, [installed, present]);

  async function activate(theme: RestTheme) {
    setBusy(theme.stylesheet);
    try {
      await api(`/pressbase/v1/themes/${encodeURIComponent(theme.stylesheet)}/activate`, {
        method: 'POST',
      });
      toast(`${themeName(theme)} is now your site’s theme.`);
      router.refresh();
    } catch (error) {
      toast(
        error instanceof ApiError ? error.message : 'The theme couldn’t be activated. Try again.',
        { tone: 'danger' },
      );
    } finally {
      setBusy(null);
    }
  }

  async function remove(theme: RestTheme) {
    setBusy(theme.stylesheet);
    try {
      await api(`/pressbase/v1/themes/${encodeURIComponent(theme.stylesheet)}`, {
        method: 'DELETE',
      });
      toast(`${themeName(theme)} was deleted.`);
      setConfirmDelete(null);
      // Focus would otherwise fall to the page: keep it in the list.
      listRef.current?.querySelector<HTMLElement>('li')?.focus();
      if (installed === theme.stylesheet) router.replace('?', { scroll: false });
      router.refresh();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'The theme couldn’t be deleted.', {
        tone: 'danger',
      });
      setConfirmDelete(null);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (!themes.length) {
    return (
      <Card>
        <EmptyState icon={<Paintbrush size={28} />} title="No themes installed">
          <p>Upload a block theme’s .zip file to give your site a look.</p>
        </EmptyState>
      </Card>
    );
  }

  return (
    <>
      <ul ref={listRef} className={styles.grid}>
        {themes.map((theme) => {
          const name = themeName(theme);
          const author = themeAuthor(theme);
          const active = theme.status === 'active';
          const deletable = canDelete && canDeleteTheme(theme);
          return (
            <li
              key={theme.stylesheet}
              className={styles.theme}
              data-active={active}
              data-stylesheet={theme.stylesheet}
              tabIndex={-1}
              aria-label={name}
            >
              <div className={styles.shot}>
                {theme.screenshot ? (
                  <img src={theme.screenshot} alt={`Screenshot of ${name}`} loading="lazy" />
                ) : (
                  <span className={styles.noShot} aria-hidden="true">
                    <Paintbrush size={32} />
                  </span>
                )}
              </div>
              <div className={styles.body}>
                <div className={styles.titleRow}>
                  <h2 className={styles.name}>{name}</h2>
                  <div className={styles.badges}>
                    {active && <Badge tone="success">Active</Badge>}
                    {!active && installed === theme.stylesheet && <Badge tone="accent">New</Badge>}
                    {deletable && (
                      <ActionMenu
                        label={`More actions for ${name}`}
                        actions={[
                          {
                            label: 'Delete',
                            tone: 'danger',
                            icon: <Trash2 size={16} aria-hidden="true" />,
                            onSelect: () => setConfirmDelete(theme),
                          },
                        ]}
                      />
                    )}
                  </div>
                </div>
                <p className={styles.meta}>
                  Version {theme.version || '—'}
                  {author && <> · By {author}</>}
                </p>
                {theme.description.raw && (
                  <p className={styles.description}>{theme.description.raw}</p>
                )}
                {active && theme.is_block_theme && canEditStyles && (
                  <div className={styles.actions}>
                    <ButtonLink href="/admin/appearance/styles" size="sm" data-primary-action>
                      Edit styles
                    </ButtonLink>
                  </div>
                )}
                {!active && canSwitch && (
                  <div className={styles.actions}>
                    <Button
                      variant="primary"
                      size="sm"
                      loading={busy === theme.stylesheet && !confirmDelete}
                      disabled={busy !== null}
                      onClick={() => activate(theme)}
                      aria-label={`Activate ${name}`}
                      data-primary-action
                    >
                      Activate
                    </Button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete ? themeName(confirmDelete) : 'theme'}?`}
        confirmLabel="Delete theme"
        busy={busy !== null}
        onConfirm={() => confirmDelete && remove(confirmDelete)}
        onCancel={() => setConfirmDelete(null)}
      >
        <p>
          Its files are removed from the server. Your saved styles for it stay, so they come back if
          you install it again. This can’t be undone.
        </p>
      </ConfirmDialog>
    </>
  );
}
