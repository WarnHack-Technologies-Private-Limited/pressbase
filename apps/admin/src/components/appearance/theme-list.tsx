'use client';

import { Paintbrush } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useCan } from '@/components/shell/current-user';
import { Button, ButtonLink } from '@/components/ui/button';
import { Badge, Card, EmptyState } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import { type RestTheme, themeAuthor, themeName } from '@/lib/themes';
import styles from './theme-list.module.css';

/** The installed themes as cards, with "Activate" on the inactive ones. */
export function ThemeList({ themes }: { themes: RestTheme[] }) {
  const router = useRouter();
  const toast = useToast();
  const canSwitch = useCan('switch_themes');
  const canEditStyles = useCan('edit_theme_options');
  const [busy, setBusy] = useState<string | null>(null);

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

  if (!themes.length) {
    return (
      <Card>
        <EmptyState icon={<Paintbrush size={28} />} title="No themes installed">
          <p>Add a block theme folder to the themes directory, then reload this page.</p>
        </EmptyState>
      </Card>
    );
  }

  return (
    <ul className={styles.grid}>
      {themes.map((theme) => {
        const name = themeName(theme);
        const author = themeAuthor(theme);
        const active = theme.status === 'active';
        return (
          <li key={theme.stylesheet} className={styles.theme} data-active={active}>
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
                {active && <Badge tone="success">Active</Badge>}
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
                  <ButtonLink href="/admin/appearance/styles" size="sm">
                    Edit styles
                  </ButtonLink>
                </div>
              )}
              {!active && canSwitch && (
                <div className={styles.actions}>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={busy === theme.stylesheet}
                    disabled={busy !== null}
                    onClick={() => activate(theme)}
                    aria-label={`Activate ${name}`}
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
  );
}
