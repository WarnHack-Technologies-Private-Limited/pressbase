import { rm } from 'node:fs/promises';

/** Removes the run's data directory, unless it was passed in (PRESSBASE_E2E_DATA_DIR). */
export default async function globalTeardown() {
  const dir = process.env.PRESSBASE_E2E_DATA_DIR;
  if (dir && process.env.PRESSBASE_E2E_DATA_DIR_TEMP === '1' && !process.env.E2E_KEEP_DATA) {
    await rm(dir, { recursive: true, force: true });
  }
}
