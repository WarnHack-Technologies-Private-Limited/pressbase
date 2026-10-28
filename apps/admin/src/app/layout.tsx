import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { colorSchemeScript } from '@/lib/color-scheme';
import { I18nProvider } from '@/lib/i18n/context';
import { getAdminLocale } from '@/lib/i18n/server';
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

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The user's language (or the site's): `lang`, the text direction (is_rtl()) and
  // the admin's translations for client components.
  const locale = await getAdminLocale();
  return (
    // The inline script sets data-theme before React hydrates.
    <html lang={locale.lang} dir={locale.dir} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: colorSchemeScript() }} />
      </head>
      <body>
        <I18nProvider locale={locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
