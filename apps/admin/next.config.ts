import type { NextConfig } from 'next';

const CORE_URL = process.env.CORE_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  // The browser talks to one origin. /wp-json/* is proxied to the core server,
  // so session cookies stay first-party and no CORS is needed.
  async rewrites() {
    return [{ source: '/wp-json/:path*', destination: `${CORE_URL}/wp-json/:path*` }];
  },
  poweredByHeader: false,
};

export default nextConfig;
