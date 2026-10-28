import type { CSSProperties, ReactNode } from 'react';
import { useState } from 'react';
import { host } from './host';
import { __ } from './l10n';

/** Small shared pieces for the admin modules, built on the admin's tokens and kit. */

export const stack = (gap = 'var(--space-4)'): CSSProperties => ({
  display: 'flex',
  flexDirection: 'column',
  gap,
});

export const muted: CSSProperties = {
  color: 'var(--color-text-muted)',
  fontSize: 'var(--text-sm)',
  margin: 0,
};

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ ...stack('var(--space-3)'), paddingBlock: 'var(--space-2)' }}>
      <h3
        style={{
          margin: 0,
          fontSize: 'var(--text-md)',
          fontWeight: 'var(--weight-semibold)' as never,
        }}
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

/** A segmented control: buttons with aria-pressed. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const { Button } = host.components;
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', gap: 'var(--space-1)' }}>
      <legend className="sr-only" style={srOnly}>
        {label}
      </legend>
      {options.map((o) => (
        <Button
          key={o.value}
          size="sm"
          variant={o.value === value ? 'primary' : 'ghost'}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          type="button"
        >
          {o.label}
        </Button>
      ))}
    </fieldset>
  );
}

export const srOnly: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

/** A measure under a field: "430 px of 600 px", with a bar that never carries meaning alone. */
export function WidthMeter({ width, max, label }: { width: number; max: number; label: string }) {
  const ratio = Math.min(width / max, 1);
  const over = width > max;
  const empty = width === 0;
  const color = over
    ? 'var(--color-warning)'
    : empty
      ? 'var(--color-border)'
      : 'var(--color-success)';
  return (
    <div style={stack('var(--space-1)')}>
      <div
        aria-hidden="true"
        style={{
          height: 4,
          borderRadius: 'var(--radius-full)',
          background: 'var(--color-surface-sunken)',
        }}
      >
        <div
          style={{
            width: `${ratio * 100}%`,
            height: '100%',
            borderRadius: 'inherit',
            background: color,
          }}
        />
      </div>
      <p style={muted}>
        {`${Math.round(width)} px ${__('of')} ${max} px ${label}`}
        {over ? ` · ${__('will be cut short')}` : ''}
      </p>
    </div>
  );
}

/** Buttons that insert %%variables%% into a field. */
export function VariableChips({
  vars,
  onInsert,
}: {
  vars: readonly string[];
  onInsert: (token: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)' }}>
      {vars.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onInsert(`%%${v}%%`)}
          aria-label={`${__('Insert variable')} ${v}`}
          style={{
            font: 'inherit',
            fontSize: 'var(--text-xs)',
            padding: '2px 8px',
            borderRadius: 'var(--radius-full)',
            border: '1px solid var(--color-border)',
            background: 'var(--color-surface-sunken)',
            color: 'var(--color-text)',
            cursor: 'pointer',
          }}
        >
          + {v.replace(/_/g, ' ')}
        </button>
      ))}
    </div>
  );
}

/** Two or three AI options to pick from; nothing is applied until one is chosen. */
export function SuggestButton({
  ability,
  input,
  onPick,
  label,
}: {
  ability: 'suggest-meta' | 'suggest-alt-text';
  input: () => Record<string, unknown>;
  onPick: (text: string) => void;
  label: string;
}) {
  const { Button, Spinner } = host.components;
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ready'; options: string[]; provider: string; model: string }
    | { status: 'failed'; message: string }
  >({ status: 'idle' });
  const run = async () => {
    setState({ status: 'loading' });
    try {
      const res = await host.api<{ options: string[]; provider: string; model: string }>(
        `/wp-abilities/v1/abilities/pressbase-seo/${ability}/run`,
        { method: 'POST', body: { input: input() } },
      );
      setState({ status: 'ready', ...res });
    } catch (error) {
      setState({
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return (
    <div style={stack('var(--space-2)')} data-seo-suggest={ability}>
      <div>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          onClick={run}
          disabled={state.status === 'loading'}
        >
          {state.status === 'loading' ? (
            <>
              <Spinner /> {__('Suggesting…')}
            </>
          ) : (
            `${__('Suggest')} ${label}`
          )}
        </Button>
      </div>
      {state.status === 'failed' && (
        <p role="alert" style={{ ...muted, color: 'var(--color-danger)' }}>
          {state.message}
        </p>
      )}
      {state.status === 'ready' && (
        <div style={stack('var(--space-2)')} aria-live="polite">
          <ul style={{ ...stack('var(--space-2)'), listStyle: 'none', padding: 0, margin: 0 }}>
            {state.options.map((option) => (
              <li
                key={option}
                style={{
                  display: 'flex',
                  gap: 'var(--space-2)',
                  alignItems: 'start',
                  justifyContent: 'space-between',
                  padding: 'var(--space-2)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                }}
              >
                <span style={{ fontSize: 'var(--text-sm)' }}>{option}</span>
                <Button
                  size="sm"
                  type="button"
                  onClick={() => {
                    onPick(option);
                    setState({ status: 'idle' });
                  }}
                >
                  {__('Use this')}
                </Button>
              </li>
            ))}
          </ul>
          <p style={muted}>
            {`${__('Suggestions from')} ${state.provider} (${state.model}). ${__('Check them before you use one.')}`}{' '}
            <button
              type="button"
              onClick={() => setState({ status: 'idle' })}
              style={{
                font: 'inherit',
                background: 'none',
                border: 0,
                padding: 0,
                color: 'var(--color-accent-text)',
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              {__('Dismiss')}
            </button>
          </p>
        </div>
      )}
    </div>
  );
}
