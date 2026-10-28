import type { Kernel } from '../kernel';
import { PURGE_ACTION } from './invalidation';
import { CacheTag } from './tags';

/**
 * Sends cache purges to apps/web's revalidation endpoint
 * (POST {WEB_URL}/_pressbase/revalidate, `Authorization: Bearer <secret>`).
 *
 * Purges are batched for a few milliseconds, so one save (which fires
 * transition_post_status, save_post, set_object_terms…) costs one request.
 * Delivery is best effort: a failure is retried once and then logged; the
 * cache's time-to-live bounds how long a missed purge can matter.
 */

export const REVALIDATE_PATH = '/_pressbase/revalidate';

export interface NotifierOptions {
  /** The public app's base URLs (several instances each get the purge). */
  urls: string[];
  secret: string;
  delayMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

export function startRevalidationNotifier(kernel: Kernel, options: NotifierOptions): () => void {
  const {
    urls,
    secret,
    delayMs = 25,
    timeoutMs = 3000,
    fetch: send = fetch,
    log = (m) => console.warn(m),
  } = options;
  let pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;

  const deliver = async (url: string, tags: string[]) => {
    const endpoint = `${url.replace(/\/+$/, '')}${REVALIDATE_PATH}`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await send(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
          body: JSON.stringify({ tags }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) return;
        if (res.status === 401) {
          log(
            `[cache] ${endpoint} refused the purge: PRESSBASE_REVALIDATE_SECRET differs between core and apps/web.`,
          );
          return;
        }
      } catch {
        // Retried once below.
      }
    }
    log(`[cache] Couldn't reach ${endpoint} to purge ${tags.length} cache tag(s).`);
  };

  const flush = () => {
    timer = undefined;
    // `site` purges everything; the other tags would be redundant.
    const tags = pending.has(CacheTag.site) ? [CacheTag.site] : [...pending];
    pending = new Set();
    if (tags.length) void Promise.all(urls.map((url) => deliver(url, tags)));
  };

  const off = kernel.hooks.addAction(PURGE_ACTION, async (tags) => {
    for (const tag of tags) pending.add(tag);
    timer ??= setTimeout(flush, delayMs);
  });
  return () => {
    off();
    if (timer) clearTimeout(timer);
    flush();
  };
}
