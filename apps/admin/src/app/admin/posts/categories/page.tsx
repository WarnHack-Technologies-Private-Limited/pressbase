import type { Metadata } from 'next';
import { TermsScreen } from '@/components/content/terms-screen';
import { TAXONOMY_SCREENS } from '@/lib/content';
import { coreGet } from '@/lib/core';

export const metadata: Metadata = { title: 'Categories' };

export default async function CategoriesPage() {
  // Only administrators can read settings; others simply don't see the "Default" badge.
  const settings = await coreGet<{ default_category?: number }>('/wp/v2/settings');
  const defaultCategory = settings.status === 200 ? settings.data.default_category : undefined;
  return <TermsScreen screen={TAXONOMY_SCREENS.categories} defaultCategory={defaultCategory} />;
}
