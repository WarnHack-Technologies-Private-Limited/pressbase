import { describe, expect, it } from 'vitest';
import { CliCommands } from './plugins/cli';

/** kernel.cli: the commands plugins add with api.cli.addCommand(). End-to-end in packages/cli. */
describe('CliCommands', () => {
  const handler = () => {};

  it('takes commands named after the plugin and removes them', () => {
    const cli = new CliCommands();
    const off = cli.add({ name: 'reading-time estimate', handler, plugin: 'reading-time' });
    cli.add({ name: 'reading-time', handler, plugin: 'reading-time' });
    expect(cli.all().map((c) => c.name)).toEqual(['reading-time', 'reading-time estimate']);
    off();
    expect(cli.get('reading-time estimate')).toBeUndefined();
  });

  it('refuses names that could shadow other commands', () => {
    const cli = new CliCommands();
    expect(() => cli.add({ name: 'post list', handler, plugin: 'reading-time' })).toThrow(
      /start with its name/,
    );
    expect(() => cli.add({ name: 'user', handler, plugin: 'user' })).toThrow(/Pressbase’s own/);
    expect(() => cli.add({ name: 'reading-time  x', handler, plugin: 'reading-time' })).toThrow(
      /lowercase words/,
    );
    cli.add({ name: 'reading-time', handler, plugin: 'reading-time' });
    expect(() => cli.add({ name: 'reading-time', handler, plugin: 'reading-time' })).toThrow(
      /already exists/,
    );
  });
});
