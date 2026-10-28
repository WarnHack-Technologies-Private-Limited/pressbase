#!/usr/bin/env node
/**
 * The Docker image's entry point: starts core, the public site and the admin,
 * prefixes their logs, forwards SIGTERM / SIGINT to them and exits when any of
 * them stops, so the container's restart policy can take over.
 *
 *   core   node --import tsx src/server.ts     PRESSBASE_CORE_PORT (4000), not published by default
 *   web    Next.js standalone server           127.0.0.1:PRESSBASE_WEB_PORT (3001), internal only
 *   admin  Next.js standalone server           0.0.0.0:PORT (3000), the port to publish
 *
 * The admin forwards /wp-json to core and every path it doesn't own to the
 * public site, so only the admin's port needs publishing. Those rewrites are
 * fixed when the image is built (CORE_URL / WEB_URL build arguments), so the
 * internal ports here must match them. No dependencies: plain Node.js.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const APP = process.env.PRESSBASE_APP_DIR ?? '/app';
const CORE_PORT = process.env.PRESSBASE_CORE_PORT ?? '4000';
const WEB_PORT = process.env.PRESSBASE_WEB_PORT ?? '3001';
const ADMIN_PORT = process.env.PORT ?? '3000';
const CORE_URL = `http://127.0.0.1:${CORE_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
/**
 * Core tells the public site which cached pages went stale; the shared secret
 * authenticates those calls (docs/adr/0008-public-page-caching.md). All three
 * processes live in this container, so a random per-container secret turns
 * caching on with nothing to configure. Set it yourself to keep it stable.
 */
const REVALIDATE_SECRET =
  process.env.PRESSBASE_REVALIDATE_SECRET || randomBytes(32).toString('hex');
/** How long to wait for the processes to stop before killing them. */
const STOP_TIMEOUT_MS = 10_000;

const services = [
  {
    name: 'core',
    cwd: path.join(APP, 'core/apps/core'),
    args: ['--import', 'tsx', 'src/server.ts'],
    env: {
      PORT: CORE_PORT,
      PRESSBASE_DATA_DIR: process.env.PRESSBASE_DATA_DIR ?? '/data',
      WEB_URL,
      PRESSBASE_REVALIDATE_SECRET: REVALIDATE_SECRET,
    },
  },
  {
    name: 'web',
    cwd: path.join(APP, 'web/apps/web'),
    args: ['server.js'],
    env: {
      PORT: WEB_PORT,
      HOSTNAME: '127.0.0.1',
      CORE_URL,
      PRESSBASE_REVALIDATE_SECRET: REVALIDATE_SECRET,
      // Empty: the installer redirect stays relative, so it works on any public address.
      ADMIN_URL: process.env.ADMIN_URL ?? '',
    },
  },
  {
    name: 'admin',
    cwd: path.join(APP, 'admin/apps/admin'),
    args: ['server.js'],
    env: {
      PORT: ADMIN_PORT,
      // Docker sets HOSTNAME to the container ID; Next.js would listen on that address only.
      HOSTNAME: '0.0.0.0',
      CORE_URL,
      WEB_URL,
    },
  },
];

const children = new Map();
let stopping = false;
let exitCode = 0;

function log(name, stream, chunk) {
  for (const line of chunk.toString().split('\n')) {
    if (line) stream.write(`[${name}] ${line}\n`);
  }
}

for (const service of services) {
  const child = spawn(process.execPath, service.args, {
    cwd: service.cwd,
    env: { ...process.env, NODE_ENV: 'production', ...service.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.set(service.name, child);
  child.stdout.on('data', (chunk) => log(service.name, process.stdout, chunk));
  child.stderr.on('data', (chunk) => log(service.name, process.stderr, chunk));
  child.on('error', (error) => {
    log(service.name, process.stderr, `failed to start: ${error.message}`);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    children.delete(service.name);
    if (!stopping) {
      log(service.name, process.stderr, `exited (${signal ?? code}); stopping the others`);
      stop(code || 1);
    }
    if (children.size === 0) process.exit(exitCode);
  });
}

function stop(code) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const child of children.values()) child.kill('SIGTERM');
  setTimeout(() => {
    for (const child of children.values()) child.kill('SIGKILL');
    process.exit(exitCode || 1);
  }, STOP_TIMEOUT_MS).unref();
  if (children.size === 0) process.exit(exitCode);
}

process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));

console.log(
  `[pressbase] starting core (:${CORE_PORT}), web (:${WEB_PORT}) and admin (:${ADMIN_PORT}). ` +
    `Open http://localhost:${ADMIN_PORT} once they are up.`,
);
