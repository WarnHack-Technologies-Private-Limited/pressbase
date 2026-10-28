'use client';

import { AlertCircle, Check, Copy, Eye, EyeOff, RefreshCw } from 'lucide-react';
import {
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
  useState,
} from 'react';
import { useI18n } from '@/lib/i18n/context';
import { generatePassword, passwordStrength, STRENGTH_LABELS } from '@/lib/password';
import styles from './field.module.css';

interface ShellProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
}

/**
 * Label, control, hint and error, wired together for assistive tech:
 * the control is described by the hint and the error, and marked invalid.
 */
function FieldShell({
  id,
  label,
  hint,
  error,
  optional,
  children,
}: ShellProps & { id: string; children: ReactNode }) {
  const { __ } = useI18n();
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
        {optional && <span className={styles.optional}>{__('(optional)', 'pressbase-admin')}</span>}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className={styles.hint}>
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className={styles.error}>
          <AlertCircle size={14} aria-hidden="true" />
          {error}
        </p>
      )}
    </div>
  );
}

function describedBy(id: string, hint: unknown, error: unknown) {
  return [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
}

type TextFieldProps = ShellProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>;

export function TextField({ label, hint, error, optional, ...input }: TextFieldProps) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} optional={optional}>
      <input
        id={id}
        className={styles.control}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={describedBy(id, hint, error)}
        required={!optional}
        {...input}
      />
    </FieldShell>
  );
}

type TextAreaFieldProps = ShellProps & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'>;

export function TextAreaField({ label, hint, error, optional, ...textarea }: TextAreaFieldProps) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} optional={optional}>
      <textarea
        id={id}
        className={styles.control}
        rows={3}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={describedBy(id, hint, error)}
        required={!optional}
        {...textarea}
      />
    </FieldShell>
  );
}

type SelectFieldProps = ShellProps & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'>;

export function SelectField({
  label,
  hint,
  error,
  optional,
  children,
  ...select
}: SelectFieldProps) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} optional={optional}>
      <select
        id={id}
        className={styles.control}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...select}
      >
        {children}
      </select>
    </FieldShell>
  );
}

const METER_COLORS = [
  'var(--color-danger)',
  'var(--color-danger)',
  'var(--color-warning)',
  'var(--color-success)',
  'var(--color-success)',
];

interface PasswordFieldProps extends ShellProps {
  value: string;
  onChange: (value: string) => void;
  /** Shows the strength meter and the "generate" button — for new passwords. */
  isNew?: boolean;
  /** Words that make a password guessable, such as the username and email. */
  context?: string[];
  autoComplete?: string;
  name?: string;
}

export function PasswordField({
  label,
  hint,
  error,
  optional,
  value,
  onChange,
  isNew,
  context,
  autoComplete,
  name,
}: PasswordFieldProps) {
  const id = useId();
  const [visible, setVisible] = useState(Boolean(isNew));
  const [copied, setCopied] = useState(false);
  const strength = passwordStrength(value, context);

  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <FieldShell id={id} label={label} hint={hint} error={error} optional={optional}>
      <div className={styles.withAddon}>
        <input
          id={id}
          name={name}
          className={styles.control}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete ?? (isNew ? 'new-password' : 'current-password')}
          spellCheck={false}
          autoCapitalize="off"
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={
            [describedBy(id, hint, error), isNew && value && `${id}-strength`]
              .filter(Boolean)
              .join(' ') || undefined
          }
          required={!optional}
        />
        <div className={styles.addon}>
          {isNew && (
            <button
              type="button"
              className={styles.addonButton}
              onClick={() => {
                onChange(generatePassword());
                setVisible(true);
              }}
              aria-label="Generate a new password"
              title="Generate a new password"
            >
              <RefreshCw size={16} aria-hidden="true" />
            </button>
          )}
          {isNew && value && (
            <button
              type="button"
              className={styles.addonButton}
              onClick={copy}
              aria-label={copied ? 'Copied' : 'Copy password'}
              title={copied ? 'Copied' : 'Copy password'}
            >
              {copied ? (
                <Check size={16} aria-hidden="true" />
              ) : (
                <Copy size={16} aria-hidden="true" />
              )}
            </button>
          )}
          <button
            type="button"
            className={styles.addonButton}
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? 'Hide password' : 'Show password'}
            aria-pressed={visible}
            title={visible ? 'Hide password' : 'Show password'}
          >
            {visible ? (
              <EyeOff size={16} aria-hidden="true" />
            ) : (
              <Eye size={16} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
      {isNew && value && (
        <div id={`${id}-strength`} className={styles.field} style={{ gap: 'var(--space-1)' }}>
          <div className={styles.meter} aria-hidden="true">
            {[1, 2, 3, 4].map((step) => (
              <span
                key={step}
                className={styles.meterBar}
                style={step <= strength ? { background: METER_COLORS[strength] } : undefined}
              />
            ))}
          </div>
          <p className={styles.meterRow}>
            <span>
              Strength: <strong>{STRENGTH_LABELS[strength]}</strong>
            </span>
            {strength < 3 && <span>Longer is stronger. Try a short sentence.</span>}
          </p>
        </div>
      )}
    </FieldShell>
  );
}

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  description?: ReactNode;
}

export function Checkbox({ label, description, ...input }: CheckboxProps) {
  const id = useId();
  return (
    <label htmlFor={id} className={styles.checkbox}>
      <input
        id={id}
        type="checkbox"
        aria-describedby={description ? `${id}-desc` : undefined}
        {...input}
      />
      <span className={styles.checkboxText}>
        <span>{label}</span>
        {description && (
          <span id={`${id}-desc`} className={styles.hint}>
            {description}
          </span>
        )}
      </span>
    </label>
  );
}
