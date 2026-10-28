#!/usr/bin/env node
/**
 * Docker HEALTHCHECK: healthy when core, the public site and the admin all
 * answer. Each is asked for the installer status, which works in every site
 * state (before and after installing). Exit code 0 = healthy, 1 = not.
 */
const CORE_PORT = process.env.PRESSBASE_CORE_PORT ?? '4000';
const WEB_PORT = process.env.PRESSBASE_WEB_PORT ?? '3001';
const ADMIN_PORT = process.env.PORT ?? '3000';
const PATH = '/wp-json/pressbase/v1/install';

const targets = {
  core: `http://127.0.0.1:${CORE_PORT}${PATH}`,
  // Through the web and admin proxies, so their rewrites to core are checked too.
  web: `http://127.0.0.1:${WEB_PORT}${PATH}`,
  admin: `http://127.0.0.1:${ADMIN_PORT}${PATH}`,
};

const results = await Promise.all(
  Object.entries(targets).map(async ([name, url]) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      return res.ok ? undefined : `${name}: HTTP ${res.status}`;
    } catch (error) {
      return `${name}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }),
);
const failures = results.filter(Boolean);
if (failures.length) {
  console.error(`unhealthy: ${failures.join('; ')}`);
  process.exit(1);
}
