# syntax=docker/dockerfile:1

# Pressbase in one image: core (Hono, run from TypeScript with tsx), the admin
# and the public site (Next.js standalone servers), started by docker/start.mjs.
#
#   docker build -t pressbase .
#   docker run -p 3000:3000 -v pressbase:/data pressbase
#
# Then open http://localhost:3000. See docs/development/getting-started.md.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
# pnpm, at the version pinned in package.json's packageManager field.
RUN corepack enable
WORKDIR /repo

# ---------------------------------------------------------------------------
# Build: install everything, build the admin and the public site as
# standalone servers, and lay out /out exactly as the runtime image uses it.
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile

# Next.js fixes its rewrites at build time. These are the addresses inside
# the container; docker/start.mjs starts core and the public site on them.
ENV PRESSBASE_STANDALONE=1 \
    CORE_URL=http://127.0.0.1:4000 \
    WEB_URL=http://127.0.0.1:3001
RUN pnpm --filter @pressbase/web build
RUN pnpm --filter @pressbase/admin build

# The standalone servers, with the static files they serve next to them.
RUN mkdir -p /out \
 && cp -a apps/admin/.next/standalone /out/admin \
 && cp -a apps/admin/.next/static /out/admin/apps/admin/.next/static \
 && cp -a apps/web/.next/standalone /out/web \
 && cp -a apps/web/.next/static /out/web/apps/web/.next/static

# Core runs from its TypeScript source (themes, static files and migrations
# are found relative to it, and plugins will be imported at runtime), so it
# keeps the repository's layout, with production dependencies only.
RUN mkdir -p /out/core \
 && cp -a --parents package.json pnpm-lock.yaml pnpm-workspace.yaml \
      apps/*/package.json packages/*/package.json e2e/package.json /out/core/ \
 && cd /out/core \
 && pnpm install --frozen-lockfile --prod --filter "@pressbase/core..." \
 && cd /repo \
 && cp -a --parents apps/core/src apps/core/static packages/*/src packages/db/migrations \
      themes /out/core/

# ---------------------------------------------------------------------------
# Runtime: Node.js, the three apps, and nothing else.
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    PRESSBASE_DATA_DIR=/data
WORKDIR /app

# Core's code stays owned by root (read-only for the server). The Next.js
# servers write caches inside .next, so they belong to the `node` user.
COPY --from=build /out/core /app/core
COPY --from=build --chown=node:node /out/admin /app/admin
COPY --from=build --chown=node:node /out/web /app/web
COPY docker/start.mjs docker/healthcheck.mjs /app/

# config.json, the built-in database, uploads, themes and the mail outbox.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD ["node", "/app/healthcheck.mjs"]
CMD ["node", "/app/start.mjs"]
