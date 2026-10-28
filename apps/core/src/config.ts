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
  /** Largest upload accepted, in megabytes (PRESSBASE_MAX_UPLOAD_MB). Default 64. */
  maxUploadMb?: number;
  /** Outgoing email (see mail/mailer.ts). Without SMTP, mail goes to <dataDir>/outbox. */
  mail?: MailConfig;
  /**
   * Public page cache purges (docs/adr/0008-public-page-caching.md): the
   * public app's URLs (WEB_URL, comma-separated for several instances) and
   * the shared secret (PRESSBASE_REVALIDATE_SECRET). Without a secret, core
   * sends no purges and apps/web doesn't cache.
   */
  revalidate?: { urls: string[]; secret: string };
  /** Run the job queue worker in this process (PRESSBASE_WORKER=off disables it). Default true. */
  worker?: boolean;
}

export interface MailConfig {
  /** PRESSBASE_SMTP_URL, e.g. smtps://user:pass@smtp.example.com:465. Wins over the separate fields. */
  smtpUrl?: string;
  host?: string;
  port?: number;
  user?: string;
  pass?: string;
  /** Use TLS from the start (port 465). Otherwise STARTTLS is used when offered. */
  secure?: boolean;
  /** PRESSBASE_MAIL_FROM, e.g. "Pressbase <wordpress@example.com>". */
  from?: string;
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
    maxUploadMb: Number(env.PRESSBASE_MAX_UPLOAD_MB) > 0 ? Number(env.PRESSBASE_MAX_UPLOAD_MB) : 64,
    revalidate: env.PRESSBASE_REVALIDATE_SECRET
      ? {
          secret: env.PRESSBASE_REVALIDATE_SECRET,
          urls: (env.WEB_URL || 'http://localhost:3001')
            .split(',')
            .map((u) => u.trim())
            .filter(Boolean),
        }
      : undefined,
    worker: !['off', '0', 'false', 'no'].includes((env.PRESSBASE_WORKER ?? '').toLowerCase()),
    mail: {
      smtpUrl: env.PRESSBASE_SMTP_URL || undefined,
      host: env.PRESSBASE_SMTP_HOST || undefined,
      port: Number(env.PRESSBASE_SMTP_PORT) > 0 ? Number(env.PRESSBASE_SMTP_PORT) : undefined,
      user: env.PRESSBASE_SMTP_USER || undefined,
      pass: env.PRESSBASE_SMTP_PASS || undefined,
      secure: env.PRESSBASE_SMTP_SECURE
        ? ['1', 'true', 'yes'].includes(env.PRESSBASE_SMTP_SECURE)
        : undefined,
      from: env.PRESSBASE_MAIL_FROM || undefined,
    },
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
