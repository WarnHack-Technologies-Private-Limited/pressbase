import type { Metadata } from 'next';
import { Suspense } from 'react';
import { MediaLibrary } from '@/components/media/media-library';

export const metadata: Metadata = { title: 'Media' };

export default function MediaPage() {
  return (
    <Suspense>
      <MediaLibrary />
    </Suspense>
  );
}
