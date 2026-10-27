import { defineConfig } from 'drizzle-kit';

// `pnpm db:generate` diffs src/schema.ts against the existing migrations and
// writes a new SQL migration. It never connects to a database.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
});
