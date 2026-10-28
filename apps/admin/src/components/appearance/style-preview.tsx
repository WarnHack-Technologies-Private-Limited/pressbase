'use client';

import { ExternalLink, Monitor, RotateCw, Smartphone, Tablet } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { GlobalStylesConfig } from '@/lib/global-styles';
import styles from './styles-editor.module.css';

const DEVICES = [
  { id: 'desktop', label: 'Desktop', width: 1280, icon: Monitor },
  { id: 'tablet', label: 'Tablet', width: 768, icon: Tablet },
  { id: 'phone', label: 'Phone', width: 390, icon: Smartphone },
] as const;
type Device = (typeof DEVICES)[number]['id'];

interface PreviewResponse {
  status: number;
  html: string;
}

/**
 * The live preview: the real public page, rendered by core with the unsaved
 * styles (POST /pressbase/v1/global-styles/preview), in a sandboxed frame
 * without scripts. Two frames take turns so an update never flashes white;
 * links and the search form inside the preview load the next page in the
 * preview instead of leaving the screen.
 */
export function StylePreview({ config, home }: { config: GlobalStylesConfig; home: string }) {
  const [path, setPath] = useState('/');
  const [device, setDevice] = useState<Device>('desktop');
  // On a phone, preview the phone layout first: a scaled-down desktop page is unreadable there.
  useEffect(() => {
    if (window.matchMedia('(max-width: 700px)').matches) setDevice('phone');
  }, []);
  const [docs, setDocs] = useState<[string, string]>(['', '']);
  const [visible, setVisible] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const frames = [useRef<HTMLIFrameElement>(null), useRef<HTMLIFrameElement>(null)];
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const sequence = useRef(0);
  const pending = useRef<{ index: number; samePath: boolean } | null>(null);
  const lastPath = useRef(path);
  const visibleRef = useRef(0);
  visibleRef.current = visible;

  // Fit the device width into the stage, scaled down when it doesn't fit.
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Render (debounced) whenever the styles, the page or a retry change.
  const body = JSON.stringify({
    url: path,
    settings: config.settings ?? {},
    styles: config.styles ?? {},
  });
  useEffect(() => {
    const id = ++sequence.current;
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/wp-json/pressbase/v1/global-styles/preview', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-pressbase-request': '1' },
          body,
        });
        if (!res.ok) throw new Error(String(res.status));
        const page = (await res.json()) as PreviewResponse;
        if (id !== sequence.current) return;
        const target = visibleRef.current === 0 ? 1 : 0;
        const samePath = lastPath.current === path;
        lastPath.current = path;
        pending.current = { index: target, samePath };
        setDocs((current) => {
          const next: [string, string] = [...current];
          // The frame runs no scripts; leaving them out keeps the console quiet.
          next[target] = page.html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
          return next;
        });
        setFailed(false);
      } catch {
        if (id === sequence.current) {
          setFailed(true);
          setBusy(false);
        }
      }
    }, 280);
    return () => clearTimeout(timer);
  }, [body, reload]);

  /** Same-site links and the search form load in the preview; nothing leaves it. */
  const intercept = useCallback(
    (doc: Document) => {
      const site = new URL(home || '/', window.location.href);
      const toPath = (url: URL) =>
        url.origin === site.origin ? `${url.pathname}${url.search}` : undefined;
      doc.addEventListener('click', (event) => {
        const link = (event.target as Element | null)?.closest?.('a[href]');
        if (!link) return;
        event.preventDefault();
        const href = link.getAttribute('href') ?? '';
        if (href.startsWith('#')) {
          doc.getElementById(href.slice(1))?.scrollIntoView();
          return;
        }
        const next = toPath(new URL(href, site));
        if (next) setPath(next);
      });
      doc.addEventListener('submit', (event) => {
        event.preventDefault();
        const form = event.target as HTMLFormElement;
        if ((form.method || 'get').toLowerCase() !== 'get') return;
        const url = new URL(form.getAttribute('action') || '/', site);
        for (const [key, value] of new FormData(form)) {
          if (typeof value === 'string') url.searchParams.set(key, value);
        }
        const next = toPath(url);
        if (next) setPath(next);
      });
    },
    [home],
  );

  const onLoad = (index: number) => {
    const frame = frames[index]?.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc || !docs[index]) return;
    intercept(doc);
    if (pending.current?.index !== index) return;
    // Keep the reader's place when only the styles changed.
    const previous = frames[visible]?.current?.contentWindow;
    if (pending.current.samePath && previous) {
      frame.contentWindow?.scrollTo(0, previous.scrollY);
    }
    pending.current = null;
    setVisible(index);
    setBusy(false);
  };

  const current = DEVICES.find((d) => d.id === device) ?? DEVICES[0];
  const scale = box.width
    ? Math.min(1, (box.width - (device === 'desktop' ? 0 : 32)) / current.width)
    : 1;
  const frameHeight = box.height
    ? box.height / scale - (device === 'desktop' ? 0 : 32 / scale)
    : 800;
  const publicUrl = `${(home || '').replace(/\/+$/, '')}${path}`;

  return (
    <section className={styles.preview} aria-label="Preview">
      <div className={styles.previewBar}>
        <fieldset className={styles.devices}>
          <legend className="visually-hidden">Preview size</legend>
          {DEVICES.map((d) => (
            <button
              key={d.id}
              type="button"
              aria-pressed={device === d.id}
              aria-label={d.label}
              title={d.label}
              onClick={() => setDevice(d.id)}
            >
              <d.icon size={16} aria-hidden="true" />
            </button>
          ))}
        </fieldset>
        <span className={styles.previewPath} title={publicUrl}>
          {path === '/' ? 'Home page' : path}
        </span>
        <span className={styles.previewStatus} data-busy={busy} aria-hidden={!busy}>
          Updating…
        </span>
        {path !== '/' && (
          <button type="button" className={styles.previewLink} onClick={() => setPath('/')}>
            Back to home
          </button>
        )}
        <a className={styles.previewLink} href={publicUrl} target="_blank" rel="noreferrer">
          Open page
          <ExternalLink size={13} aria-hidden="true" />
          <span className="visually-hidden">(opens in a new tab, with your saved styles)</span>
        </a>
      </div>
      <div ref={stage} className={styles.stage} data-device={device} aria-busy={busy}>
        {failed && (
          <div className={styles.previewError} role="status">
            <p>The preview couldn’t be loaded.</p>
            <button
              type="button"
              className={styles.previewLink}
              onClick={() => setReload((n) => n + 1)}
            >
              <RotateCw size={14} aria-hidden="true" />
              Try again
            </button>
          </div>
        )}
        {[0, 1].map((index) => (
          <iframe
            key={index}
            ref={frames[index]}
            className={styles.frame}
            data-visible={visible === index}
            title={
              visible === index ? 'Preview of your site with these styles' : 'Preview (loading)'
            }
            aria-hidden={visible !== index}
            tabIndex={visible === index ? 0 : -1}
            // Same origin (for fonts and to keep links inside), but no scripts.
            sandbox="allow-same-origin"
            srcDoc={docs[index]}
            onLoad={() => onLoad(index)}
            style={{
              width: current.width,
              height: Math.max(frameHeight, 200),
              transform: `scale(${scale})`,
            }}
          />
        ))}
      </div>
    </section>
  );
}
