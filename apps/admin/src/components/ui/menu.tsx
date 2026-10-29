'use client';

import { MoreVertical } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import styles from './menu.module.css';

export interface MenuAction {
  label: string;
  icon?: ReactNode;
  tone?: 'danger';
  onSelect: () => void;
}

/**
 * A menu button (WAI-ARIA menu button pattern) for an item's secondary
 * actions: Enter, Space or ↓ opens it on the first item, ↑ on the last; arrow
 * keys, Home and End move; Escape closes it and Tab leaves it, both
 * returning focus to the button. Choosing an item closes the menu first, so
 * a dialog the item opens can return focus to the button.
 */
export function ActionMenu({ label, actions }: { label: string; actions: MenuAction[] }) {
  const [open, setOpen] = useState<false | 'first' | 'last'>(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const items = () => [
    ...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
  ];

  useEffect(() => {
    if (!open) return;
    const list = items();
    (open === 'last' ? list[list.length - 1] : list[0])?.focus();
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onButtonKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(event.key === 'ArrowUp' ? 'last' : 'first');
    }
  };

  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const next = {
      ArrowDown: (index + 1) % list.length,
      ArrowUp: (index - 1 + list.length) % list.length,
      Home: 0,
      End: list.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    list[next]?.focus();
  };

  return (
    <div ref={wrapRef} className={styles.wrap}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.button}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={Boolean(open)}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? setOpen(false) : setOpen('first'))}
        onKeyDown={onButtonKey}
      >
        <MoreVertical size={18} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={menuId}
          ref={menuRef}
          role="menu"
          aria-label={label}
          className={styles.menu}
          onKeyDown={onMenuKey}
        >
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={styles.item}
              data-tone={action.tone}
              onClick={() => {
                close();
                action.onSelect();
              }}
            >
              {action.icon}
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
