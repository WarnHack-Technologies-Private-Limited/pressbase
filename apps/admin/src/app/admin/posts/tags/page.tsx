import type { Metadata } from 'next';
import { TermsScreen } from '@/components/content/terms-screen';
import { TAXONOMY_SCREENS } from '@/lib/content';

export const metadata: Metadata = { title: 'Tags' };

export default function TagsPage() {
  return <TermsScreen screen={TAXONOMY_SCREENS.tags} />;
}
