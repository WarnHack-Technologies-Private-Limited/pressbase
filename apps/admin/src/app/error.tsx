'use client';

import { AuthLayout } from '@/components/install/auth-layout';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/surface';

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <AuthLayout narrow>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <h1 style={{ fontSize: 'var(--text-2xl)' }}>Something went wrong</h1>
        <Notice tone="danger" title="Pressbase couldn’t load this page.">
          If you run this site yourself, check that the Pressbase core server is running (
          <code>pnpm dev</code> starts it) and look at its log for details.
        </Notice>
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
      </div>
    </AuthLayout>
  );
}
