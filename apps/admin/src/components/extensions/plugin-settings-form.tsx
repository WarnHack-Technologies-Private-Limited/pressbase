'use client';

import { AlertCircle } from 'lucide-react';
import { useId } from 'react';
import {
  colorInputValue,
  fromInput,
  initialValues,
  type PluginPageDetails,
  pageEndpoint,
  type SettingField,
  sectionTitle,
  toInput,
} from '@/lib/extensions/settings';
import { SettingsForm } from '../settings/settings-form';
import { Checkbox, SelectField, TextAreaField, TextField } from '../ui/field';
import fieldStyles from '../ui/field.module.css';
import { Card } from '../ui/surface';
import styles from './extensions.module.css';

/**
 * A plugin's settings page, drawn from the schema its settings registered
 * (the Settings API's do_settings_sections()): one card per section, the
 * shared save bar, toast and field errors of every settings screen.
 */
export function PluginSettingsForm({ page }: { page: PluginPageDetails }) {
  return (
    <SettingsForm
      initial={initialValues(page)}
      endpoint={pageEndpoint(page.plugin, page.slug)}
      savedValues={(result) => (result.values as Record<string, unknown>) ?? {}}
    >
      {({ values, set, errors }) =>
        page.sections.map((section, index) => (
          <Card
            key={section.id}
            title={sectionTitle(section, page.title, index)}
            description={section.description || undefined}
          >
            <div className={styles.fields}>
              {section.fields.map((field) => (
                <SettingInput
                  key={field.name}
                  field={field}
                  value={values[field.name]}
                  error={errors[field.name]}
                  onChange={(value) => set(field.name, value)}
                />
              ))}
            </div>
          </Card>
        ))
      }
    </SettingsForm>
  );
}

function SettingInput({
  field,
  value,
  error,
  onChange,
}: {
  field: SettingField;
  value: unknown;
  error?: string;
  onChange: (value: unknown) => void;
}) {
  const hint = field.description || undefined;
  const common = {
    label: field.label,
    hint,
    error,
    optional: !field.required,
    name: field.name,
  };
  switch (field.control) {
    case 'toggle':
      return (
        <div>
          <Checkbox
            label={field.label}
            description={hint}
            name={field.name}
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          {error && <FieldError message={error} />}
        </div>
      );
    case 'textarea':
      return (
        <TextAreaField
          {...common}
          rows={5}
          value={toInput(value)}
          placeholder={field.placeholder || undefined}
          maxLength={field.max_length ?? undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'number':
      return (
        <div className={styles.short}>
          <TextField
            {...common}
            type="number"
            inputMode={field.type === 'integer' ? 'numeric' : 'decimal'}
            value={toInput(value)}
            min={field.min ?? undefined}
            max={field.max ?? undefined}
            step={field.step ?? (field.type === 'integer' ? 1 : 'any')}
            placeholder={field.placeholder || undefined}
            onChange={(e) => onChange(fromInput(field, e.target.value))}
          />
        </div>
      );
    case 'select':
      return (
        <div className={styles.short}>
          <SelectField
            {...common}
            value={toInput(value)}
            onChange={(e) => onChange(fromInput(field, e.target.value))}
          >
            {field.options.map((option) => (
              <option key={String(option.value)} value={String(option.value)}>
                {option.label}
              </option>
            ))}
          </SelectField>
        </div>
      );
    case 'radio':
      return <RadioField field={field} value={value} error={error} onChange={onChange} />;
    case 'color':
      return <ColorField field={field} value={value} error={error} onChange={onChange} />;
    default:
      return (
        <TextField
          {...common}
          type={field.control === 'url' ? 'url' : field.control === 'email' ? 'email' : 'text'}
          autoComplete="off"
          spellCheck={field.control === 'text'}
          value={toInput(value)}
          placeholder={field.placeholder || undefined}
          maxLength={field.max_length ?? undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

function FieldError({ message, id }: { message: string; id?: string }) {
  return (
    <p id={id} className={fieldStyles.error}>
      <AlertCircle size={14} aria-hidden="true" />
      {message}
    </p>
  );
}

function RadioField({
  field,
  value,
  error,
  onChange,
}: {
  field: SettingField;
  value: unknown;
  error?: string;
  onChange: (value: unknown) => void;
}) {
  const id = useId();
  return (
    <fieldset
      className={styles.radios}
      aria-describedby={
        [field.description && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') ||
        undefined
      }
      aria-invalid={Boolean(error) || undefined}
    >
      <legend>{field.label}</legend>
      {field.options.map((option) => (
        <label key={String(option.value)} className={styles.radio}>
          <input
            type="radio"
            name={field.name}
            value={String(option.value)}
            checked={toInput(value) === String(option.value)}
            onChange={(e) => onChange(fromInput(field, e.target.value))}
          />
          {option.label}
        </label>
      ))}
      {field.description && (
        <p id={`${id}-hint`} className={styles.hint}>
          {field.description}
        </p>
      )}
      {error && <FieldError id={`${id}-error`} message={error} />}
    </fieldset>
  );
}

function ColorField({
  field,
  value,
  error,
  onChange,
}: {
  field: SettingField;
  value: unknown;
  error?: string;
  onChange: (value: unknown) => void;
}) {
  const id = useId();
  const describedBy =
    [field.description && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') ||
    undefined;
  return (
    <div className={fieldStyles.field}>
      <label htmlFor={id} className={fieldStyles.label}>
        {field.label}
        {!field.required && <span className={fieldStyles.optional}>(optional)</span>}
      </label>
      <div className={`${styles.color} ${styles.short}`}>
        <input
          type="color"
          aria-label={`${field.label}: pick a colour`}
          value={colorInputValue(value)}
          onChange={(e) => onChange(e.target.value)}
        />
        <input
          id={id}
          name={field.name}
          className={fieldStyles.control}
          value={toInput(value)}
          placeholder={field.placeholder || '#000000'}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      {field.description && (
        <p id={`${id}-hint`} className={fieldStyles.hint}>
          {field.description}
        </p>
      )}
      {error && <FieldError id={`${id}-error`} message={error} />}
    </div>
  );
}
