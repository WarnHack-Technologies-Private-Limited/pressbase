import { redirect } from 'next/navigation';

/** Appearance → Editor, WordPress's site editor (site-editor.php), is Studio in Pressbase. */
export default function AppearanceEditorPage() {
  redirect('/admin/studio');
}
