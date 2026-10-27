import { Lock } from 'lucide-react';
import { PageHeader } from '../shell/page-header';
import { ButtonLink } from '../ui/button';
import { Card, EmptyState } from '../ui/surface';

/** Shown when someone opens a People screen their role doesn't allow. */
export function NotAllowed({ title, children }: { title: string; children: string }) {
  return (
    <>
      <PageHeader title={title} />
      <Card>
        <EmptyState
          icon={<Lock size={28} />}
          title="You don’t have access to this"
          action={
            <ButtonLink href="/admin/profile" variant="secondary">
              Go to your profile
            </ButtonLink>
          }
        >
          <p>{children}</p>
        </EmptyState>
      </Card>
    </>
  );
}
