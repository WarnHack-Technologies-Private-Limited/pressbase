import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Runtime configuration. Environment variables win over config.json, which
 * the web installer writes into the data directory (Pressbase's wp-config.php).
 */
export interface Config {
  dataDir: string;
  port: number;
  databaseUrl: string | undefined;
  /** True when DATABASE_URL came from the environment, so the installer skips that step. */
  databaseFromEnv: boolean;
  /** When set, the installer refuses to run without this code. */
  setupToken: string | undefined;
}

export interface SiteConfigFile {
  databaseUrl: string;
}

const CONFIG_FILE = 'config.json';

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const dataDir = path.resolve(env.PRESSBASE_DATA_DIR ?? '.pressbase');
  const file = await readSiteConfig(dataDir);
  return {
    dataDir,
    port: Number(env.PORT ?? 4000),
    databaseUrl: env.DATABASE_URL || file?.databaseUrl,
    databaseFromEnv: Boolean(env.DATABASE_URL),
    setupToken: env.PRESSBASE_SETUP_TOKEN || undefined,
  };
}

async function readSiteConfig(dataDir: string): Promise<SiteConfigFile | undefined> {
  try {
    return JSON.parse(await readFile(path.join(dataDir, CONFIG_FILE), 'utf8')) as SiteConfigFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Writes config.json readable only by the server's user, since it holds credentials. */
export async function writeSiteConfig(dataDir: string, config: SiteConfigFile): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, CONFIG_FILE);
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}
