import { AuthLayout } from '@/components/install/auth-layout';
import { ButtonLink } from '@/components/ui/button';

export default function NotFound() {
  return (
    <AuthLayout narrow>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <h1 style={{ fontSize: 'var(--text-2xl)' }}>Page not found</h1>
        <p style={{ color: 'var(--color-text-muted)' }}>
          The page you’re looking for doesn’t exist or has moved.
        </p>
        <ButtonLink href="/admin" variant="primary">
          Go to the dashboard
        </ButtonLink>
      </div>
    </AuthLayout>
  );
}
