import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { EDITOR_STYLESHEETS, type EditorStylesheet } from '@/components/block-editor/assets';

/**
 * The block editor's stylesheets (see components/block-editor/assets.ts),
 * read from the installed @wordpress packages and written out as static files
 * at build time. They're public, GPL-licensed CSS.
 */

export const dynamic = 'force-static';
export const dynamicParams = false;

export function generateStaticParams() {
  return Object.keys(EDITOR_STYLESHEETS).map((name) => ({ name }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const file = EDITOR_STYLESHEETS[name as EditorStylesheet];
  if (!file) return new Response('Not found', { status: 404 });
  const css = await readFile(path.join(/* turbopackIgnore: true */ process.cwd(), file), 'utf8');
  return new Response(css, {
    headers: {
      'content-type': 'text/css; charset=utf-8',
      // URLs carry a version (assets.ts), so a cached copy never goes stale.
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}
