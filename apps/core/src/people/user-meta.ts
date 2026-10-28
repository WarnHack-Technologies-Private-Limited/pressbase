import { z } from 'zod';

/**
 * User meta exposed through the REST API's `meta` field: Pressbase's version of
 * register_meta( 'user', $key, array( 'show_in_rest' => … ) ) and
 * WP_REST_User_Meta_Fields (wp-includes/rest-api/fields/).
 *
 * Only registered keys can be read or written over REST. They appear in the
 * edit context only (a person's own preferences aren't public), and writing
 * them needs `edit_user` for that person, like any other profile field.
 * A `null` value deletes the meta, so the default applies again.
 */

export interface RegisteredUserMeta {
  /** Validates a value sent over REST. */
  schema: z.ZodType;
  /** Returned when the user has no value stored. */
  default: unknown;
  description: string;
}

const registry = new Map<string, RegisteredUserMeta>();

/** register_meta( 'user', … ) with show_in_rest. A later registration replaces an earlier one. */
export function registerUserMeta(key: string, definition: RegisteredUserMeta): void {
  registry.set(key, definition);
}

export function registeredUserMetaKeys(): string[] {
  return [...registry.keys()];
}

/** The `meta` object for a user, with defaults for keys they haven't set. */
export function restUserMeta(stored: Map<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, definition] of registry) {
    const value = stored?.get(key);
    out[key] = value === undefined ? definition.default : value;
  }
  return out;
}

/**
 * Validates a request's `meta` object. Unregistered keys are ignored, as
 * WP_REST_Meta_Fields::update_value() does; invalid values fail the request.
 * Resolves to the values to store (`null` meaning delete), or the zod error.
 */
export function parseUserMetaUpdate(
  input: unknown,
): { success: true; data: Record<string, unknown> } | { success: false; error: z.ZodError } {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, definition] of registry) shape[key] = definition.schema.nullable().optional();
  const parsed = z.object(shape).safeParse(input);
  if (!parsed.success) {
    // Report fields as meta.<key>, so clients can match them to their inputs.
    const error = new z.ZodError(
      parsed.error.issues.map((issue) => ({ ...issue, path: ['meta', ...issue.path] })),
    );
    return { success: false, error };
  }
  const data = Object.fromEntries(
    Object.entries(parsed.data).filter(([, value]) => value !== undefined),
  );
  return { success: true, data };
}

/** The admin's colour scheme: follow the operating system, or force light or dark. */
export const ADMIN_COLOR_SCHEME_META = 'pressbase_admin_color_scheme';

registerUserMeta(ADMIN_COLOR_SCHEME_META, {
  schema: z.enum(['system', 'light', 'dark'], {
    error: 'Choose system, light or dark.',
  }),
  default: 'system',
  description: 'The admin colour scheme: system, light or dark.',
});
