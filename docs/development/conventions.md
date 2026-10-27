# Conventions

## TypeScript

- `strict` and `noUncheckedIndexedAccess` are on. Handle `undefined`; don't silence it.
- No `any` outside tests. Prefer `unknown` and narrow it.
- Avoid `!` non-null assertions. Throw a clear error instead (see `only()` in `install/installer.ts`).
- Validate every external input (request bodies, config files) with **zod** at the boundary. Inside, trust the types.
- ES modules everywhere. Internal packages export their TypeScript source (`"exports": "./src/index.ts"`); there's no build step for them.

## Naming

| Thing                              | Style                            | Example                                   |
| ---------------------------------- | -------------------------------- | ----------------------------------------- |
| Files                              | kebab-case                       | `rate-limit.ts`, `admin-shell.tsx`        |
| Components, classes, types         | PascalCase                       | `HookBus`, `PasswordField`                |
| Functions, variables               | camelCase                        | `loadUser`, `databaseUrlFrom`             |
| DB tables and columns              | snake_case                       | `term_taxonomy.parent_id`                 |
| Hooks, options, REST fields        | WordPress names where one exists | `save_post`, `blogname`, `posts_per_page` |
| Pressbase-only error codes and options | `pressbase_` prefix                  | `pressbase_db_refused`, `pressbase_db_version`    |

## Comments

- Explain **why**, and point to the WordPress original when you port it: `// Like wp_install()…`.
- Every module starts with a short comment saying what it is for.
- Don't comment what the code already says.

## Core patterns

- Routes live in `routes/<resource>.ts` and export a function that returns a `Hono<AppEnv>`.
- Access the kernel through `c.get('kernel')` and the user through `c.get('user')`.
- Errors: `restError(c, status, code, message, extra)` or `invalidParams(c, zodError)`. Never throw for expected failures.
- Write data in transactions when more than one row must change together.

## Admin patterns

- **Server components** fetch with `coreGet()` and redirect on 401 or 503. **Client components** mutate with `api()`.
- Styling: CSS Modules plus tokens. No inline colours or sizes. See [Components](../design/components.md).
- Keep hydration stable: anything random or time-based (generated passwords, "now") starts on the client in `useEffect`.
- UI copy follows [Voice and tone](../design/voice-and-tone.md).

## Formatting

Biome handles formatting and lint: 2 spaces, single quotes, semicolons, 100 columns. Run `pnpm format` before committing.
