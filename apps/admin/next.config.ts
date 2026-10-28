import path from 'node:path';
import type { NextConfig } from 'next';

const CORE_URL = process.env.CORE_URL ?? 'http://localhost:4000';
const WEB_URL = process.env.WEB_URL ?? 'http://localhost:3001';

const nextConfig: NextConfig = {
  // The browser talks to one origin. /wp-json/* is proxied to the core server,
  // so session cookies stay first-party and no CORS is needed.
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [
        { source: '/wp-json/:path*', destination: `${CORE_URL}/wp-json/:path*` },
        // Uploaded files, theme assets and block styles are served by core, at WordPress's URLs.
        {
          source: '/wp-content/uploads/:path*',
          destination: `${CORE_URL}/wp-content/uploads/:path*`,
        },
        {
          source: '/wp-content/themes/:path*',
          destination: `${CORE_URL}/wp-content/themes/:path*`,
        },
        { source: '/wp-includes/:path*', destination: `${CORE_URL}/wp-includes/:path*` },
        // The post password form (wp-login.php?action=postpass).
        { source: '/wp-login.php', destination: `${CORE_URL}/wp-login.php` },
        // The public comment form posts here, as to WordPress's wp-comments-post.php.
        { source: '/wp-comments-post', destination: `${CORE_URL}/wp-comments-post` },
        { source: '/wp-comments-post.php', destination: `${CORE_URL}/wp-comments-post.php` },
      ],
      // Anything the admin doesn't route is the public site (apps/web), so the
      // site and its admin share one origin, as in WordPress: the address
      // entered at install (`home`) shows the site, /admin the dashboard.
      // The trailing slash of WordPress permalinks must survive the rewrite.
      fallback: [
        { source: '/:path+/', destination: `${WEB_URL}/:path+/` },
        { source: '/:path*', destination: `${WEB_URL}/:path*` },
      ],
    };
  },
  // WordPress permalinks end with a slash; leave them to the public site.
  skipTrailingSlashRedirect: true,
  poweredByHeader: false,
  // The Docker image runs Next.js's standalone server (see the Dockerfile).
  // Tracing starts at the repository root so workspace packages are included.
  ...(process.env.PRESSBASE_STANDALONE
    ? { output: 'standalone' as const, outputFileTracingRoot: path.resolve(process.cwd(), '../..') }
    : {}),
  // Next.js would otherwise write an AGENTS.md into the app on `next dev`.
  agentRules: false,
  turbopack: {
    resolveAlias: {
      // The block editor's optional in-browser image processor (~22 MB of
      // WebAssembly). Pressbase processes uploads on the server; see the stub.
      '@wordpress/vips/worker': './src/components/block-editor/vips-stub.ts',
    },
  },
};

export default nextConfig;
