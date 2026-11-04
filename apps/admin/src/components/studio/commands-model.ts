/**
 * The command palette's registry and search (#33), like Elementor's Finder
 * and WordPress's `core/commands` store. Studio registers its commands (go
 * to a page, add a section, open a panel, Simple/Advanced, devices, Preview,
 * Publish); other features add theirs the same way, and plugins will through
 * `studioCommands`. Pure TypeScript, tested in commands-model.test.ts.
 * See docs/architecture/studio.md#command-palette.
 */

import type { ReactNode } from 'react';
import { msgid } from '../../lib/i18n/locale';

/** Where a command is listed. Groups not named here are listed last, under *More*. */
export const COMMAND_GROUPS = [
  { id: 'actions', label: msgid('Actions') },
  { id: 'pages', label: msgid('Pages') },
  { id: 'sections', label: msgid('Add a section') },
  { id: 'panels', label: msgid('Panels') },
  { id: 'view', label: msgid('View and settings') },
  { id: 'more', label: msgid('More') },
] as const;

export type CommandGroupId = (typeof COMMAND_GROUPS)[number]['id'];

export interface StudioCommand {
  /** Unique; registering the same id again replaces the command ("pressbase/open-page/12"). */
  id: string;
  /** What it does, in the person's language: "Preview in a new tab". */
  label: string;
  group: CommandGroupId | (string & {});
  /** More words it's found by (translated): "home", "draft". */
  keywords?: readonly string[];
  /** Shown at the end of the row: "Ctrl+Z", "Now". */
  hint?: string;
  icon?: ReactNode;
  /** Listed, but can't run now (nothing to publish). */
  disabled?: boolean;
  /** Only listed once the person types (sections: too many to list up front). */
  searchOnly?: boolean;
  run: () => void | Promise<void>;
}

/* --------------------------------------------------------------- registry */

/**
 * The commands available now. `register()` returns a function that removes
 * what it added (unless something registered the same id since). Listeners
 * hear every change; `list()` is a stable snapshot between changes, for
 * React's useSyncExternalStore.
 */
export class CommandRegistry {
  #commands = new Map<string, { command: StudioCommand; token: symbol }>();
  #listeners = new Set<() => void>();
  #snapshot: readonly StudioCommand[] = [];

  register(commands: StudioCommand | readonly StudioCommand[]): () => void {
    const token = Symbol('registration');
    const list = Array.isArray(commands) ? commands : [commands as StudioCommand];
    for (const command of list) this.#commands.set(command.id, { command, token });
    this.#changed();
    return () => {
      let removed = false;
      for (const command of list) {
        if (this.#commands.get(command.id)?.token === token) {
          this.#commands.delete(command.id);
          removed = true;
        }
      }
      if (removed) this.#changed();
    };
  }

  list = (): readonly StudioCommand[] => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #changed() {
    this.#snapshot = [...this.#commands.values()].map((entry) => entry.command);
    for (const listener of this.#listeners) listener();
  }
}

/** Studio's registry. Plugins will add commands here too (`studioCommands.register()`). */
export const studioCommands = new CommandRegistry();

/* ----------------------------------------------------------------- search */

export interface CommandSection {
  group: string;
  commands: StudioCommand[];
}

const normalize = (text: string) => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const groupRank = (group: string) => {
  const index = COMMAND_GROUPS.findIndex((g) => g.id === group);
  return index < 0 ? COMMAND_GROUPS.length : index;
};

/** Unknown groups are listed under *More*. */
export const groupOf = (command: Pick<StudioCommand, 'group'>): string =>
  COMMAND_GROUPS.some((g) => g.id === command.group) ? command.group : 'more';

/**
 * How well a command matches a search: 0 for no match. Every word must
 * appear in the label, keywords or group name. Higher for a label that
 * starts with the search (4), has it at the start of a word (3), or has
 * every word at the start of one of its words (2).
 */
export function commandScore(
  command: Pick<StudioCommand, 'label' | 'keywords'>,
  query: string,
  groupLabel = '',
): number {
  const search = normalize(query);
  if (!search) return 1;
  const label = normalize(command.label);
  const haystack = [label, ...(command.keywords ?? []).map(normalize), normalize(groupLabel)].join(
    ' ',
  );
  const words = search.split(/\s+/);
  if (!words.every((word) => haystack.includes(word))) return 0;
  if (label.startsWith(search)) return 4;
  const labelWords = label.split(/[\s:·,–—-]+/).filter(Boolean);
  if (label.includes(` ${search}`)) return 3;
  if (words.every((word) => labelWords.some((w) => w.startsWith(word)))) return 2;
  return 1;
}

/**
 * The commands to list for a search, by group. With no search: everything
 * but search-only commands, in the groups' order. With one: the matches,
 * best first within each group, and the group with the best match first.
 * `limit` caps the matches listed per group.
 */
export function filterCommands(
  commands: readonly StudioCommand[],
  query: string,
  options: { groupLabels?: ReadonlyMap<string, string>; limit?: number } = {},
): CommandSection[] {
  const searching = normalize(query) !== '';
  const limit = options.limit ?? 20;
  const groups = new Map<string, { command: StudioCommand; score: number; order: number }[]>();
  commands.forEach((command, order) => {
    if (!searching && command.searchOnly) return;
    const group = groupOf(command);
    const score = commandScore(command, query, options.groupLabels?.get(group) ?? '');
    if (!score) return;
    const list = groups.get(group) ?? [];
    list.push({ command, score, order });
    groups.set(group, list);
  });
  const sections = [...groups.entries()].map(([group, list]) => {
    list.sort((a, b) => b.score - a.score || a.order - b.order);
    return {
      group,
      best: list[0]?.score ?? 0,
      commands: list.slice(0, limit).map((e) => e.command),
    };
  });
  sections.sort(
    (a, b) => (searching ? b.best - a.best : 0) || groupRank(a.group) - groupRank(b.group),
  );
  return sections.map(({ group, commands: list }) => ({ group, commands: list }));
}
