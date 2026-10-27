import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/shell/page-header';
import { ButtonLink } from '@/components/ui/button';
import { Badge, Card, EmptyState } from '@/components/ui/surface';
import { findSection } from '@/lib/sections';

type Props = { params: Promise<{ section: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const section = findSection((await params).section);
  return { title: section?.label ?? 'Not found' };
}

/** Sections that are on the roadmap but not built yet. */
export default async function UpcomingSection({ params }: Props) {
  const section = findSection((await params).section);
  if (!section?.release) notFound();
  const Icon = section.icon;

  return (
    <>
      <PageHeader title={section.label} />
      <Card>
        <EmptyState
          icon={<Icon size={28} />}
          title={
            <>
              {section.label} is on the way <Badge tone="accent">{section.release}</Badge>
            </>
          }
          action={
            <ButtonLink href="/admin" variant="secondary">
              Back to the dashboard
            </ButtonLink>
          }
        >
          <p>{section.summary}</p>
        </EmptyState>
      </Card>
    </>
  );
}
