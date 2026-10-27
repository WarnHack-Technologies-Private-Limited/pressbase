'use client';

import { SelectField } from '../ui/field';
import { Card } from '../ui/surface';
import { SettingsForm } from './settings-form';

export interface WritingSettings extends Record<string, unknown> {
  default_category: number;
}

/** Settings → Writing, as in WordPress's options-writing.php. */
export function WritingSettingsForm({
  initial,
  categories,
}: {
  initial: WritingSettings;
  categories: { id: number; name: string }[];
}) {
  return (
    <SettingsForm initial={initial}>
      {({ values, set, errors }) => (
        <Card title="Defaults" description="Applied to new posts until you choose otherwise.">
          <SelectField
            label="Default post category"
            value={values.default_category}
            onChange={(e) => set('default_category', Number(e.target.value))}
            error={errors.default_category}
            hint="Posts saved without a category go here. This category can’t be deleted."
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </SelectField>
        </Card>
      )}
    </SettingsForm>
  );
}
