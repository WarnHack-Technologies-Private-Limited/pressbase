import { AbilityError } from '../abilities/registry';
import type { CurrentUser } from '../auth/users';
import { ChangesetEntryError } from '../changesets/entities';
import {
  type ChangesetData,
  ChangesetError,
  ChangesetValidationError,
} from '../changesets/service';
import type { Post } from '../content/posts';
import type { Kernel } from '../kernel';

/**
 * The changeset a site-building ability reads through and writes into
 * (ADR 0022): the one named by `changeset_uuid`, else the user's open
 * changeset. Writes start one when there is none; reads never do. No
 * ability publishes: publishing a changeset stays a person's action.
 */

/** Who is writing: a person, because a changeset belongs to someone. */
export function requireUser(user: CurrentUser | null): CurrentUser {
  if (user) return user;
  throw new AbilityError(
    'rest_not_logged_in',
    'Changes go into a person’s changeset: run this as a user (in the CLI, with --user).',
    401,
  );
}

/**
 * The changeset to use: `uuid` when given (it must be open and the user's
 * to manage), else the user's newest open one; with `create`, a new one
 * when there is none. Undefined for reads without a user or a changeset.
 */
export async function changesetFor(
  kernel: Kernel,
  user: CurrentUser | null,
  uuid: string | undefined,
  create: boolean,
): Promise<Post | undefined> {
  const { changesets } = kernel;
  if (uuid) {
    const changeset = await changesets.find(uuid);
    if (!changeset || changeset.status === 'trash') {
      throw new AbilityError('changeset_invalid_uuid', 'There’s no changeset with that UUID.', 404);
    }
    if (!user || !changesets.canManage(changeset, user)) {
      throw new AbilityError(
        'rest_cannot_edit',
        'Sorry, you are not allowed to change this changeset.',
        user ? 403 : 401,
      );
    }
    if (!changesets.isOpen(changeset)) {
      throw new AbilityError(
        'changeset_already_published',
        'The previous set of changes has already been published.',
        409,
      );
    }
    return changeset;
  }
  if (!user) return undefined;
  const [open] = await changesets.openFor(user.id);
  if (open || !create) return open;
  return (await changesets.create(user)).changeset;
}

/** The changeset a write goes into, started when the user has none open. */
export async function writableChangeset(
  kernel: Kernel,
  user: CurrentUser,
  uuid?: string,
): Promise<Post> {
  const changeset = await changesetFor(kernel, user, uuid, true);
  if (!changeset) throw new Error('A changeset should have been started.');
  return changeset;
}

/** The changeset's entries, or none. */
export function entriesOf(kernel: Kernel, changeset: Post | undefined): ChangesetData {
  return changeset ? kernel.changesets.data(changeset) : {};
}

/** The first of `keys` the changeset has, with its value. */
export function findEntry(
  data: ChangesetData,
  keys: string[],
): { key: string; value: Record<string, unknown> } | undefined {
  for (const key of keys) {
    const entry = data[key];
    if (entry && typeof entry.value === 'object' && entry.value !== null) {
      return { key, value: entry.value as Record<string, unknown> };
    }
  }
  return undefined;
}

/**
 * Writes entries into the changeset as `user` (the entity handlers validate,
 * sanitise and permission-check each one), turning changeset errors into
 * ability errors with the same codes.
 */
export async function writeEntries(
  kernel: Kernel,
  changeset: Post,
  user: CurrentUser,
  entries: Record<string, unknown>,
): Promise<Post> {
  try {
    return await kernel.changesets.update(changeset, user, { entries });
  } catch (error) {
    if (error instanceof ChangesetValidationError) {
      const [key, first] = Object.entries(error.entries)[0] ?? [];
      const forbidden = first?.code === 'changeset_entry_forbidden';
      throw new AbilityError(
        first?.code ?? 'transaction_fail',
        first ? `${key}: ${first.message}` : error.message,
        forbidden ? 403 : 400,
        { entries: error.entries },
      );
    }
    if (error instanceof ChangesetError || error instanceof ChangesetEntryError) {
      throw new AbilityError(
        error.code,
        error.message,
        error instanceof ChangesetError ? error.status : 400,
      );
    }
    throw error;
  }
}

/** What every write answers with: where the change went, and how to see it. */
export interface ChangesetWrite {
  changeset_uuid: string;
  entry: string;
  preview_link: string;
}

export async function changesetWrite(
  kernel: Kernel,
  changeset: Post,
  entry: string,
  path = '/',
): Promise<ChangesetWrite> {
  const home = (await kernel.options.get<string>('home', '')).replace(/\/+$/, '');
  const separator = path.includes('?') ? '&' : '?';
  return {
    changeset_uuid: changeset.slug,
    entry,
    preview_link: `${home}${path}${separator}changeset_uuid=${changeset.slug}`,
  };
}

export const CHANGESET_WRITE_PROPERTIES = {
  changeset_uuid: {
    type: 'string',
    description:
      'The changeset the change was saved in. Nothing is live until a person publishes it.',
  },
  entry: { type: 'string', description: 'The changeset entry written, such as page:12.' },
  preview_link: { type: 'string', description: 'The site with the changeset applied.' },
} as const;

export const CHANGESET_UUID_INPUT = {
  type: 'string',
  format: 'uuid',
  description:
    'The changeset to read through or write into. By default the user’s open changeset (a write starts one when there is none).',
} as const;
