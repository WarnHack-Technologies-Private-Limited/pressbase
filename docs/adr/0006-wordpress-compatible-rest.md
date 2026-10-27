# 0006: WordPress-compatible REST surface under /wp-json

- **Status:** Accepted
- **Date:** 2026-10-27

## Context

There is a large ecosystem of WordPress REST clients: mobile apps, headless frontends, integrations. Matching WordPress's API lets Pressbase reuse it and makes migration painless.

## Decision

- Serve the API at `/wp-json`.
- Implement `wp/v2/*` with WordPress's route names, field names, status codes and error shape (`{ code, message, data: { status } }`).
- Put Pressbase-only features under `pressbase/v1/*`.
- Name settings, options and hooks after WordPress wherever an equivalent exists.

## Consequences

- WordPress clients work against Pressbase as `wp/v2` coverage grows.
- We inherit some legacy naming (`blogname`, `post_name`); the database uses clean names and the REST layer maps them.
- Each `wp/v2` route needs a parity check against WordPress's controller in `wp-includes/rest-api/endpoints/`.
