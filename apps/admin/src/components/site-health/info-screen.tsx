'use client';

import { Copy } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, Card } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { applySizes, type DirectorySize, displayValue, type SiteInfo } from '@/lib/site-health';
import { AccordionItem } from './accordion-item';
import styles from './site-health.module.css';

/** Puts text on the clipboard, with a fallback for browsers without the async API. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

/**
 * Tools → Site Health → Info (wp-admin/site-health-info.php): every section
 * of the debug data, collapsed, and "Copy site info to clipboard", which
 * copies the text core prepared without private values. Directory sizes
 * arrive after the page, as in WordPress.
 */
export function InfoScreen({ initial }: { initial: SiteInfo }) {
  const [data, setData] = useState(initial);
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    let cancelled = false;
    api<Record<string, DirectorySize | number>>('/wp-site-health/v1/directory-sizes')
      .then((sizes) => {
        if (!cancelled) setData((current) => applySizes(current, sizes));
      })
      .catch(() => {
        if (cancelled) return;
        const unavailable = { size: 'Not available', debug: 'not available', raw: -1 };
        setData((current) =>
          applySizes(
            current,
            Object.fromEntries(
              Object.keys(current.info['wp-paths-sizes']?.fields ?? {})
                .filter((name) => name.endsWith('_size'))
                .map((name) => [name, unavailable]),
            ),
          ),
        );
      });
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
    };
  }, []);

  const copy = async () => {
    if (await copyText(data.copy)) {
      toast('Site information has been copied to your clipboard.');
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 3000);
    } else {
      toast('Couldn’t copy. Select the details below and copy them instead.', { tone: 'danger' });
    }
  };

  return (
    <div className={styles.stack}>
      <Card title="Site health info">
        <p className={styles.groupIntro}>
          This page can show you every detail about the configuration of your Pressbase site. For
          any improvements that could be made, see the{' '}
          <Link href="/admin/tools/site-health">Site health status</Link> page.
        </p>
        <p className={styles.groupIntro}>
          To share these details with a support engineer or a plugin developer, copy them to the
          clipboard and paste them into an email or a text file. Values marked “Not copied” stay out
          of the copy.
        </p>
        <div className={styles.copyRow}>
          <Button icon={<Copy size={16} aria-hidden="true" />} onClick={copy}>
            Copy site info to clipboard
          </Button>
          {copied && (
            <span className={styles.copied} aria-hidden="true">
              Copied!
            </span>
          )}
        </div>
      </Card>

      <div className={styles.accordion}>
        {Object.entries(data.info).map(([key, section]) => {
          const fields = Object.entries(section.fields ?? {});
          if (!fields.length) return null;
          return (
            <AccordionItem
              key={key}
              headingLevel="h2"
              title={`${section.label}${section.show_count ? ` (${fields.length.toLocaleString('en')})` : ''}`}
            >
              {section.description && (
                <p
                  className={styles.sectionDescription}
                  // Plugins may use inline HTML here, as WordPress allows.
                  dangerouslySetInnerHTML={{ __html: section.description }}
                />
              )}
              <table className={styles.table}>
                <tbody>
                  {fields.map(([name, field]) => {
                    const value = displayValue(field.value);
                    return (
                      <tr key={name}>
                        <th scope="row">{field.label}</th>
                        <td>
                          {Array.isArray(value) ? (
                            <ul>
                              {value.map(([k, v]) => (
                                <li key={k}>
                                  {k}: {v}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            value
                          )}
                          {field.private && (
                            <span className={styles.private}>
                              <Badge>Not copied</Badge>
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </AccordionItem>
          );
        })}
      </div>
    </div>
  );
}
