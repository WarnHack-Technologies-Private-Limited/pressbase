'use client';

import { CornerDownLeft, Search } from 'lucide-react';
import {
  type DependencyList,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useI18n } from '@/lib/i18n/context';
import {
  COMMAND_GROUPS,
  filterCommands,
  type StudioCommand,
  studioCommands,
} from './commands-model';
import styles from './studio.module.css';

/**
 * Adds commands to the palette while the calling component is mounted. The
 * list is rebuilt (and registered again) when `deps` change.
 */
export function useStudioCommands(build: () => StudioCommand[], deps: DependencyList): void {
  const commands = useMemo(build, deps);
  useEffect(() => studioCommands.register(commands), [commands]);
}

/** ⌘K on a Mac, Ctrl+K elsewhere, without Shift or Alt. */
export function isPaletteShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
) {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'k'
  );
}

/** "⌘K" or "Ctrl+K", for the person's keyboard. */
export function paletteShortcutLabel(): string {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return mac ? '⌘K' : 'Ctrl+K';
}

/**
 * Opens the palette on ⌘K / Ctrl+K anywhere in Studio's own document. Key
 * presses inside the canvas iframe don't reach this window; the editor
 * passes those on (StudioEditor, `isPaletteShortcut`). A shortcut something
 * else used first (Ctrl+K adds a link while typing in text) is left alone,
 * as in WordPress.
 */
export function usePaletteShortcut(open: () => void): void {
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isPaletteShortcut(event)) return;
      event.preventDefault();
      openRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/**
 * The command palette (#33): a modal dialog holding a WAI-ARIA combobox
 * (an input with `aria-activedescendant`) and its listbox of commands, by
 * group. ↑/↓ move, Enter runs, Escape closes; focus goes back where it was,
 * then the command runs. How many commands match is announced politely.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { __, _n, sprintf } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const commands = useSyncExternalStore(
    studioCommands.subscribe,
    studioCommands.list,
    studioCommands.list,
  );

  const groupLabels = useMemo(
    () => new Map(COMMAND_GROUPS.map((g) => [g.id as string, __(g.label, 'pressbase-admin')])),
    [__],
  );
  const sections = useMemo(
    () => (open ? filterCommands(commands, query, { groupLabels }) : []),
    [open, commands, query, groupLabels],
  );
  const flat = useMemo(() => sections.flatMap((s) => s.commands), [sections]);
  const activeIndex = Math.min(active, Math.max(flat.length - 1, 0));
  const optionId = (index: number) => `${baseId}-option-${index}`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setQuery('');
      setActive(0);
      dialog.showModal();
      inputRef.current?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Keep the active option in view.
  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: 'nearest' });
  });

  const run = (command: StudioCommand | undefined) => {
    if (!command || command.disabled) return;
    onClose();
    // After the dialog has closed and focus is back, so the command can move it.
    requestAnimationFrame(() => {
      void command.run();
    });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!flat.length) return;
    const last = flat.length - 1;
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 5, PageUp: -5 }[event.key];
    if (step !== undefined) {
      event.preventDefault();
      const next = activeIndex + step;
      setActive(
        Math.abs(step) === 1
          ? next > last
            ? 0
            : next < 0
              ? last
              : next
          : Math.max(0, Math.min(last, next)),
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(flat[activeIndex]);
    }
  };

  let index = -1;
  return (
    <dialog
      ref={dialogRef}
      className={styles.palette}
      aria-label={__('Command palette', 'pressbase-admin')}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        // A click on the backdrop (the dialog itself, outside its box) closes it.
        if (event.target === dialogRef.current) onClose();
      }}
    >
      {open && (
        <div className={styles.paletteBox}>
          <div className={styles.paletteSearch}>
            <Search size={18} aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded={flat.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={flat.length ? optionId(activeIndex) : undefined}
              aria-label={__('Search commands', 'pressbase-admin')}
              placeholder={__('Go to a page, add a section, open a panel…', 'pressbase-admin')}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
            />
            <kbd className={styles.paletteKey}>Esc</kbd>
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label={__('Commands', 'pressbase-admin')}
            className={styles.paletteList}
          >
            {sections.map((section) => {
              const headingId = `${baseId}-group-${section.group}`;
              return (
                // biome-ignore lint/a11y/useSemanticElements: a listbox's group of options, not a form's fieldset.
                <div
                  key={section.group}
                  role="group"
                  aria-labelledby={headingId}
                  className={styles.paletteGroup}
                >
                  <div id={headingId} role="presentation" className={styles.paletteGroupLabel}>
                    {groupLabels.get(section.group) ?? section.group}
                  </div>
                  {section.commands.map((command) => {
                    index += 1;
                    const at = index;
                    return (
                      <div
                        key={command.id}
                        id={optionId(at)}
                        role="option"
                        tabIndex={-1}
                        aria-selected={at === activeIndex}
                        aria-disabled={command.disabled || undefined}
                        className={styles.paletteOption}
                        onMouseMove={() => at !== activeIndex && setActive(at)}
                        onMouseDown={(event) => {
                          // Focus stays in the search field, as the combobox pattern wants.
                          event.preventDefault();
                          run(command);
                        }}
                      >
                        {command.icon && (
                          <span className={styles.paletteIcon} aria-hidden="true">
                            {command.icon}
                          </span>
                        )}
                        <span className={styles.paletteLabel}>{command.label}</span>
                        {command.hint && <span className={styles.paletteHint}>{command.hint}</span>}
                        {at === activeIndex && !command.disabled && (
                          <CornerDownLeft
                            size={14}
                            aria-hidden="true"
                            className={styles.paletteEnter}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {flat.length === 0 && (
            <p className={styles.paletteEmpty}>
              {query.trim()
                ? sprintf(
                    __('Nothing matches “%s”. Try another word.', 'pressbase-admin'),
                    query.trim(),
                  )
                : __('No commands yet.', 'pressbase-admin')}
            </p>
          )}
          <p className={styles.paletteFooter}>
            {__('↑ ↓ to move · Enter to run · Esc to close', 'pressbase-admin')}
            {!query.trim() && (
              <span>{__('Type a section’s name to add it.', 'pressbase-admin')}</span>
            )}
          </p>
          <p className="visually-hidden" role="status">
            {query.trim()
              ? sprintf(
                  _n('%d command found', '%d commands found', flat.length, 'pressbase-admin'),
                  flat.length,
                )
              : ''}
          </p>
        </div>
      )}
    </dialog>
  );
}
