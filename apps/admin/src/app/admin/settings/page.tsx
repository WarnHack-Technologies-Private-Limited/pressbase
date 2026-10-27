import { redirect } from 'next/navigation';

export default function SettingsIndex() {
  redirect('/admin/settings/general');
}
