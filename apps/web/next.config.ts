import { existsSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

// Read the repository's .env as core does (variables already set win), so
// PRESSBASE_REVALIDATE_SECRET reaches both apps from one place in development.
const rootEnv = path.resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const CORE_URL = process.env.CORE_URL ?? 'http://localhost:4000';

/**
 * The public site. Pages are rendered by core (see src/app/[[...path]]/route.ts);
 * the REST API and public files are proxied to core at WordPress's URLs, so a
 * theme's links to /wp-json, /wp-content and /wp-includes work on this origin.
 */
const nextConfig: NextConfig = {
  async rewrites() {
    return {
      // beforeFiles: the catch-all route handler would otherwise answer these paths.
      beforeFiles: [
        { source: '/wp-json/:path*', destination: `${CORE_URL}/wp-json/:path*` },
        { source: '/wp-content/:path*', destination: `${CORE_URL}/wp-content/:path*` },
        { source: '/wp-includes/:path*', destination: `${CORE_URL}/wp-includes/:path*` },
        // The post password form (wp-login.php?action=postpass).
        { source: '/wp-login.php', destination: `${CORE_URL}/wp-login.php` },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  // WordPress permalinks end with a slash; core decides canonical redirects.
  skipTrailingSlashRedirect: true,
  poweredByHeader: false,
  // Next.js would otherwise write an AGENTS.md into the app on `next dev`.
  agentRules: false,
};

export default nextConfig;
