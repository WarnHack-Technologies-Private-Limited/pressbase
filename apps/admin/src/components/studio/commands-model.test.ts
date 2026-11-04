import { describe, expect, it, vi } from 'vitest';
import {
  CommandRegistry,
  commandScore,
  filterCommands,
  groupOf,
  type StudioCommand,
} from './commands-model';

const command = (id: string, label: string, group: string, extra: Partial<StudioCommand> = {}) =>
  ({ id, label, group, run: () => {}, ...extra }) as StudioCommand;

describe('the command registry', () => {
  it('adds and removes commands, telling listeners each time', () => {
    const registry = new CommandRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    const preview = command('preview', 'Preview in a new tab', 'actions');
    const off = registry.register(preview);
    expect(registry.list()).toEqual([preview]);
    const offPages = registry.register([
      command('page/1', 'Home', 'pages'),
      command('page/2', 'About us', 'pages'),
    ]);
    expect(registry.list().map((c) => c.id)).toEqual(['preview', 'page/1', 'page/2']);
    offPages();
    expect(registry.list().map((c) => c.id)).toEqual(['preview']);
    off();
    expect(registry.list()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('keeps one snapshot between changes, for useSyncExternalStore', () => {
    const registry = new CommandRegistry();
    registry.register(command('a', 'A', 'actions'));
    expect(registry.list()).toBe(registry.list());
  });

  it('replaces a command registered again under its id; the old registration no longer removes it', () => {
    const registry = new CommandRegistry();
    const offOld = registry.register(command('publish', 'Publish', 'actions', { disabled: true }));
    registry.register(command('publish', 'Publish 2 changes', 'actions'));
    expect(registry.list().map((c) => c.label)).toEqual(['Publish 2 changes']);
    const listener = vi.fn();
    registry.subscribe(listener);
    offOld();
    expect(registry.list().map((c) => c.label)).toEqual(['Publish 2 changes']);
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops telling a listener once it unsubscribes', () => {
    const registry = new CommandRegistry();
    const listener = vi.fn();
    const stop = registry.subscribe(listener);
    stop();
    registry.register(command('a', 'A', 'actions'));
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('searching commands', () => {
  const commands = [
    command('preview', 'Preview in a new tab', 'actions'),
    command('publish', 'Publish 2 changes', 'actions', { keywords: ['go live'] }),
    command('page/1', 'Home', 'pages', { keywords: ['home page'] }),
    command('page/2', 'About us', 'pages'),
    command('page/3', 'Café menu', 'pages'),
    command('section/pricing', 'Add section: Pricing', 'sections', {
      searchOnly: true,
      keywords: ['prices', 'plans'],
    }),
    command('section/faq', 'Add section: Questions and answers', 'sections', {
      searchOnly: true,
      keywords: ['faq'],
    }),
    command('panel/pages', 'Open the Pages panel', 'panels'),
    command('mode', 'Switch to Advanced settings', 'view'),
    command('device/mobile', 'Switch to Mobile view', 'view'),
    command('plugin', 'Say hello', 'my-plugin'),
  ];
  const ids = (sections: ReturnType<typeof filterCommands>) =>
    sections.flatMap((s) => s.commands.map((c) => c.id));

  it('lists everything but search-only commands with no search, in the groups’ order', () => {
    const sections = filterCommands(commands, '  ');
    expect(sections.map((s) => s.group)).toEqual(['actions', 'pages', 'panels', 'view', 'more']);
    expect(ids(sections)).not.toContain('section/pricing');
    expect(sections.at(-1)?.commands.map((c) => c.id)).toEqual(['plugin']);
  });

  it('finds commands by every word, in labels and keywords, ignoring case and accents', () => {
    expect(ids(filterCommands(commands, 'cafe'))).toEqual(['page/3']);
    expect(ids(filterCommands(commands, 'PRICES'))).toEqual(['section/pricing']);
    expect(ids(filterCommands(commands, 'faq'))).toEqual(['section/faq']);
    expect(ids(filterCommands(commands, 'go live'))).toEqual(['publish']);
    expect(ids(filterCommands(commands, 'add pricing'))).toEqual(['section/pricing']);
    expect(ids(filterCommands(commands, 'nothing like this'))).toEqual([]);
  });

  it('finds commands by their group’s name', () => {
    const labels = new Map([['sections', 'Add a section']]);
    expect(ids(filterCommands(commands, 'section', { groupLabels: labels }))).toEqual([
      'section/pricing',
      'section/faq',
    ]);
  });

  it('puts the best match first, and its group first', () => {
    const sections = filterCommands(commands, 'pages');
    expect(sections[0]?.group).toBe('panels');
    expect(ids(filterCommands(commands, 'mob'))).toEqual(['device/mobile']);
    // "Home" starts with the search; the Pages panel only has it in a word.
    const home = filterCommands(
      [command('panel', 'Open the Home panel', 'panels'), command('page', 'Home', 'pages')],
      'home',
    );
    expect(home.map((s) => s.group)).toEqual(['pages', 'panels']);
  });

  it('scores a label that starts with the search over one with it at a word or inside', () => {
    const start = commandScore({ label: 'Pricing table' }, 'pric');
    const word = commandScore({ label: 'Add section: Pricing' }, 'pric');
    const inside = commandScore({ label: 'Repricing' }, 'pric');
    expect(start).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(0);
    expect(commandScore({ label: 'Home' }, 'about')).toBe(0);
  });

  it('caps each group at the limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => command(`p${i}`, `Page ${i}`, 'pages'));
    expect(filterCommands(many, 'page', { limit: 5 })[0]?.commands).toHaveLength(5);
  });

  it('lists unknown groups under More', () => {
    expect(groupOf({ group: 'my-plugin' })).toBe('more');
    expect(groupOf({ group: 'pages' })).toBe('pages');
  });
});
