'use client';

import { X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { RestTerm } from '@/lib/content';
import styles from './editor.module.css';

/** A tag being edited: id 0 means "new — create it on save". */
export interface TagToken {
  id: number;
  name: string;
}

/**
 * Tag entry, like WordPress's: type and press Enter or comma to add, pick
 * from suggestions with the arrow keys, Backspace removes the last tag.
 * Implements the ARIA combobox pattern.
 */
export function TagInput({
  value,
  onChange,
}: {
  value: TagToken[];
  onChange: (tags: TagToken[]) => void;
}) {
  const [text, setText] = useState('');
  const [suggestions, setSuggestions] = useState<RestTerm[]>([]);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const labelId = useId();

  useEffect(() => {
    const q = text.trim();
    if (!q) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(() => {
      api<RestTerm[]>(
        `/wp/v2/tags?search=${encodeURIComponent(q)}&per_page=8&orderby=count&order=desc`,
      )
        .then((found) => {
          const chosen = new Set(value.map((t) => t.name.toLowerCase()));
          setSuggestions(found.filter((t) => !chosen.has(t.name.toLowerCase())));
          setActive(-1);
        })
        .catch(() => setSuggestions([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [text, value]);

  const add = (token: TagToken) => {
    const name = token.name.trim();
    if (!name || value.some((t) => t.name.toLowerCase() === name.toLowerCase())) return;
    onChange([...value, { ...token, name }]);
    setText('');
    setSuggestions([]);
  };

  const commit = () => {
    const pick = suggestions[active];
    if (pick) return add({ id: pick.id, name: pick.name });
    const exact = suggestions.find((s) => s.name.toLowerCase() === text.trim().toLowerCase());
    add(exact ? { id: exact.id, name: exact.name } : { id: 0, name: text });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      if (text.trim()) {
        e.preventDefault();
        commit();
      }
    } else if (e.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1));
    } else if (e.key === 'ArrowDown' && suggestions.length) {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp' && suggestions.length) {
      e.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === 'Escape') {
      setSuggestions([]);
    }
  };

  return (
    <div className={styles.field}>
      <span id={labelId} className={styles.label}>
        Add tags
      </span>
      <div className={styles.tokenWrap}>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: clicking the frame focuses the real input. */}
        <div className={styles.tokens} onClick={() => inputRef.current?.focus()}>
          {value.map((tag) => (
            <span key={tag.name} className={styles.token}>
              {tag.name}
              <button
                type="button"
                aria-label={`Remove tag ${tag.name}`}
                onClick={() => onChange(value.filter((t) => t !== tag))}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            className={styles.tokenInput}
            value={text}
            onChange={(e) => setText(e.target.value.replace(',', ''))}
            onKeyDown={onKeyDown}
            onBlur={() => setTimeout(() => setSuggestions([]), 150)}
            role="combobox"
            aria-labelledby={labelId}
            aria-expanded={suggestions.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          />
        </div>
        {suggestions.length > 0 && (
          <div id={listId} className={styles.suggestions} role="listbox" aria-labelledby={labelId}>
            {suggestions.map((s, i) => (
              // Options are reached with aria-activedescendant from the input, so they need no tab stop.
              // biome-ignore lint/a11y/useFocusableInteractive: combobox pattern.
              <div
                key={s.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={styles.suggestion}
                onMouseDown={(e) => {
                  e.preventDefault();
                  add({ id: s.id, name: s.name });
                }}
              >
                {s.name}
              </div>
            ))}
          </div>
        )}
      </div>
      <span className={styles.hint}>Separate tags with commas or the Enter key.</span>
    </div>
  );
}
