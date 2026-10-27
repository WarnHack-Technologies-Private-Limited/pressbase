/**
 * Browser-side client for the core REST API. Requests go to /wp-json on the
 * admin's own origin and are proxied to core (see next.config.ts).
 */

export interface ApiErrorData {
  status?: number;
  /** Field-level messages for rest_invalid_param, keyed by field path. */
  params?: Record<string, string>;
  /** Next step for the user, on database errors. */
  hint?: string;
  retryAfter?: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly data: ApiErrorData = {},
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  { method = 'GET', body }: { method?: string; body?: unknown } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/wp-json${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        // Required on writes; see requireRequestHeader in apps/core/src/http.ts.
        'x-pressbase-request': '1',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(
      0,
      'pressbase_network_error',
      'Pressbase could not be reached. Check your connection and try again.',
    );
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.code ?? 'pressbase_unknown_error',
      data?.message ?? 'Something went wrong. Please try again.',
      data?.data ?? {},
    );
  }
  return data as T;
}
