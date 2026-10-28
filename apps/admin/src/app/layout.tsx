import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { colorSchemeScript } from '@/lib/color-scheme';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Pressbase', template: '%s ‹ Pressbase' },
  description: 'Pressbase admin',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f6f3' },
    { media: '(prefers-color-scheme: dark)', color: '#121211' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The inline script sets data-theme before React hydrates.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: colorSchemeScript() }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
