'use client';

import { Monitor, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { Card } from '../ui/surface';
import styles from './menus.module.css';

/** Viewports the preview renders the site at, before scaling it into the card. */
const VIEWPORTS = {
  desktop: { width: 1280, height: 150, label: 'Desktop', icon: Monitor },
  mobile: { width: 390, height: 640, label: 'Mobile', icon: Smartphone },
} as const;
type Viewport = keyof typeof VIEWPORTS;

/**
 * Stops the preview from navigating: links open nothing, forms don't submit.
 * The menu button and submenus still work, so the mobile overlay can be tried.
 */
const FREEZE =
  '<script>document.addEventListener("click",e=>{const a=e.target.closest("a");if(a){e.preventDefault()}},true);document.addEventListener("submit",e=>e.preventDefault(),true);</script>';

interface Frame {
  id: number;
  html: string;
  loaded: boolean;
}

let frameIds = 0;

/**
 * The site's header with the menu as it is now, saved or not: core renders
 * the home page with this menu in place of the header's
 * (POST /pressbase/v1/navigation-preview), shown in a sandboxed frame
 * (scripts, but no same-origin access to the admin). A new render loads
 * behind the current one and replaces it once ready, so editing never
 * flashes an empty frame.
 */
export function MenuPreview({ content, title }: { content: string; title: string }) {
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [frames, setFrames] = useState<Frame[]>([]);
  const [problem, setProblem] = useState<string>();
  const [width, setWidth] = useState(0);
  const frameWrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const page = await api<{ html: string }>('/pressbase/v1/navigation-preview', {
          method: 'POST',
          body: { content, title },
        });
        if (!live) return;
        // Root-relative theme and upload URLs resolve against the admin, which proxies them.
        const html = page.html.replace('</body>', `${FREEZE}</body>`);
        frameIds += 1;
        const id = frameIds;
        setFrames((list) => [
          ...list.filter((f) => f.loaded).slice(-1),
          { id, html, loaded: false },
        ]);
        setProblem(undefined);
      } catch (error) {
        if (live) {
          setProblem(error instanceof ApiError ? error.message : 'The preview couldn’t be loaded.');
        }
      }
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [content, title]);

  // On a phone, start with the phone-sized preview.
  useEffect(() => {
    if (window.innerWidth < 700) setViewport('mobile');
  }, []);

  useEffect(() => {
    const el = frameWrap.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const size = VIEWPORTS[viewport];
  const available = viewport === 'mobile' ? Math.min(width, 320) : width;
  const scale = available ? Math.min(1, available / size.width) : 0;
  const ready = frames.some((f) => f.loaded);

  return (
    <Card
      title="Preview"
      description="Your header with this menu, unsaved changes included."
      actions={
        <fieldset className={styles.segmented}>
          <legend className="visually-hidden">Preview size</legend>
          {(Object.keys(VIEWPORTS) as Viewport[]).map((key) => {
            const { label, icon: Icon } = VIEWPORTS[key];
            return (
              <button
                key={key}
                type="button"
                aria-pressed={viewport === key}
                onClick={() => setViewport(key)}
              >
                <Icon size={14} aria-hidden="true" />
                {label}
              </button>
            );
          })}
        </fieldset>
      }
    >
      <div ref={frameWrap} className={styles.previewArea} data-viewport={viewport}>
        {problem ? (
          <p className={styles.help}>{problem}</p>
        ) : frames.length && scale ? (
          <div
            className={styles.previewFrame}
            style={{ width: size.width * scale, height: size.height * scale }}
            aria-busy={!ready}
          >
            {frames.map((frame) => (
              <iframe
                key={frame.id}
                title={`Preview of your header (${size.label.toLowerCase()})`}
                srcDoc={frame.html}
                sandbox="allow-scripts"
                data-loading={frame.loaded ? undefined : ''}
                aria-hidden={frame.loaded ? undefined : true}
                onLoad={() =>
                  setFrames((list) =>
                    list
                      .map((f) => (f.id === frame.id ? { ...f, loaded: true } : f))
                      .filter((f) => f.id >= frame.id),
                  )
                }
                style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}
              />
            ))}
          </div>
        ) : (
          <p className={styles.help}>Loading the preview…</p>
        )}
      </div>
    </Card>
  );
}
