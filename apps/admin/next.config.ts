import type { NextConfig } from 'next';

const CORE_URL = process.env.CORE_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  // The browser talks to one origin. /wp-json/* is proxied to the core server,
  // so session cookies stay first-party and no CORS is needed.
  async rewrites() {
    return [
      { source: '/wp-json/:path*', destination: `${CORE_URL}/wp-json/:path*` },
      // Uploaded files are served by core, at WordPress's URLs.
      {
        source: '/wp-content/uploads/:path*',
        destination: `${CORE_URL}/wp-content/uploads/:path*`,
      },
      // The public comment form posts here (wp-comments-post.php), until apps/web exists.
      { source: '/wp-comments-post', destination: `${CORE_URL}/wp-comments-post` },
    ];
  },
  poweredByHeader: false,
  turbopack: {
    resolveAlias: {
      // The block editor's optional in-browser image processor (~22 MB of
      // WebAssembly). Pressbase processes uploads on the server; see the stub.
      '@wordpress/vips/worker': './src/components/block-editor/vips-stub.ts',
    },
  },
};

export default nextConfig;
