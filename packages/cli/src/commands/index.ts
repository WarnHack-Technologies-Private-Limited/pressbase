import type { CommandSpec } from '../command';
import { commentCommands } from './comment';
import { coreCommands } from './core';
import { cronCommands } from './cron';
import { dbCommands } from './db';
import { mediaCommands } from './media';
import { optionCommands } from './option';
import { pluginCommands } from './plugin';
import { postCommands } from './post';
import { searchReplaceCommands } from './search-replace';
import { cacheCommands, rewriteCommands, themeCommands } from './site';
import { termCommands } from './term';
import { userCommands } from './user';

/** Every built-in command. Plugins add theirs through api.cli (kernel.cli). */
export const COMMANDS: CommandSpec[] = [
  ...cacheCommands,
  ...commentCommands,
  ...coreCommands,
  ...cronCommands,
  ...dbCommands,
  ...mediaCommands,
  ...optionCommands,
  ...pluginCommands,
  ...postCommands,
  ...rewriteCommands,
  ...searchReplaceCommands,
  ...termCommands,
  ...themeCommands,
  ...userCommands,
];

/** Command groups, for `pressbase help` and `pressbase <group>`. */
export const GROUPS: [string, string][] = [
  ['cache', 'Empties the public site’s page cache.'],
  ['comment', 'Lists and moderates comments.'],
  ['core', 'Shows the version and installs Pressbase.'],
  ['cron', 'Lists, runs and deletes scheduled events.'],
  ['cron event', 'Lists, runs and deletes scheduled events.'],
  ['cron schedule', 'Lists the recurrences events can use.'],
  ['db', 'Checks the database and applies migrations.'],
  ['media', 'Regenerates image sizes.'],
  ['option', 'Reads and changes options.'],
  ['plugin', 'Installs, activates, deactivates and deletes plugins.'],
  ['post', 'Lists, creates, updates and deletes posts and pages.'],
  ['rewrite', 'Sets the permalink structure.'],
  ['search-replace', 'Searches and replaces text across the site.'],
  ['term', 'Lists, creates and deletes categories, tags and other terms.'],
  ['theme', 'Lists and switches themes.'],
  ['user', 'Manages users, roles, passwords and application passwords.'],
  ['user application-password', 'Creates, lists and deletes application passwords.'],
];
