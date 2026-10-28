import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { schema } from '@pressbase/db';
import { eq, sql } from 'drizzle-orm';
import { loadUser } from '../auth/users';
import type { Job } from '../jobs/queue';
import type { Kernel } from '../kernel';
import {
  type AuthorChoice,
  type ImportOptions,
  type ImportProgress,
  type ImportReport,
  runImport,
} from './writer';
import { scanWxr, type WxrInput, WxrReader, type WxrSummary } from './wxr-reader';

/**
 * WXR imports as background jobs, and the functions the CLI calls.
 *
 * The admin's flow is WordPress's (wp-admin/import.php → the WordPress
 * Importer's three steps), with the long part moved off the request:
 *
 * 1. Upload: the file is streamed to `<dataDir>/imports/{id}.xml` (never
 *    held in memory), read once to list its authors and count its content,
 *    and described in `{id}.json`.
 * 2. Start: the admin maps authors and chooses whether to download
 *    attachments; a `pressbase/import` job is queued.
 * 3. The job imports the file, recording progress in its row (`jobs.data`),
 *    so the admin can poll it and a big import outlives the request. The
 *    final report is kept in `{id}.json` too, and the XML is deleted.
 *
 * A job that dies part-way (a restart) is retried; items already imported
 * are recognised and skipped, so the retry picks up where it stopped.
 */

export const IMPORT_JOB = 'pressbase/import';
/** A big import with downloads can take a while; a job that runs longer is retried. */
const IMPORT_TIMEOUT_SECONDS = 4 * 60 * 60;
/** Uploaded files that were never imported, and old reports, are deleted after this. */
const KEEP_DAYS = 7;

export type ImportStatus = 'uploaded' | 'queued' | 'running' | 'completed' | 'failed';

/** What `{id}.json` holds. */
export interface ImportSession {
  id: string;
  /** The uploaded file's name. */
  filename: string;
  size: number;
  /** Who uploaded it. */
  userId: number;
  createdAt: string;
  summary: WxrSummary;
  jobId?: number;
  startedAt?: string;
  options?: { authors: Record<string, AuthorChoice>; fetchAttachments: boolean };
  report?: ImportReport;
  error?: string;
}

/** What the job's data holds. */
interface ImportJobData {
  importId: string;
  userId: number;
  authors: Record<string, AuthorChoice>;
  fetchAttachments: boolean;
  total: number;
  progress?: ImportProgress;
  report?: ImportReport;
}

export class ImportSessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 | 413 = 400,
  ) {
    super(message);
  }
}

export function importsDir(kernel: Kernel): string {
  return path.join(kernel.config.dataDir, 'imports');
}

/** PRESSBASE_MAX_IMPORT_MB, default 1024, in bytes. */
export function maxImportBytes(kernel: Kernel): number {
  return Math.max(1, kernel.config.import?.maxFileMb ?? 1024) * 1024 * 1024;
}

const ID = /^[a-f0-9]{24}$/;

function paths(kernel: Kernel, id: string) {
  if (!ID.test(id))
    throw new ImportSessionError('import_not_found', 'That import doesn’t exist.', 404);
  const dir = importsDir(kernel);
  return { xml: path.join(dir, `${id}.xml`), json: path.join(dir, `${id}.json`) };
}

async function saveSession(kernel: Kernel, session: ImportSession): Promise<void> {
  const { json } = paths(kernel, session.id);
  const temp = `${json}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify(session), { mode: 0o600 });
  await rename(temp, json);
}

export async function getSession(kernel: Kernel, id: string): Promise<ImportSession> {
  const { json } = paths(kernel, id);
  try {
    return JSON.parse(await readFile(json, 'utf8')) as ImportSession;
  } catch {
    throw new ImportSessionError('import_not_found', 'That import doesn’t exist.', 404);
  }
}

/** Deletes uploads and reports older than KEEP_DAYS (never one that is queued or running). */
async function pruneSessions(kernel: Kernel): Promise<void> {
  const dir = importsDir(kernel);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const name of names) {
    const id = name.replace(/\.(xml|json)$/, '');
    if (!ID.test(id) || !name.endsWith('.json')) continue;
    try {
      const session = await getSession(kernel, id);
      if (new Date(session.createdAt).getTime() > cutoff) continue;
      const status = await sessionStatus(kernel, session);
      if (status.status === 'queued' || status.status === 'running') continue;
      await removeSession(kernel, id);
    } catch {
      // Skip anything unreadable.
    }
  }
}

async function removeSession(kernel: Kernel, id: string): Promise<void> {
  const { xml, json } = paths(kernel, id);
  await rm(xml, { force: true });
  await rm(json, { force: true });
}

/**
 * Step 1: stores an uploaded WXR file and reads what's in it. Throws
 * ImportSessionError for files that are too big or aren't WXR.
 */
export async function createImportSession(
  kernel: Kernel,
  input: {
    body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;
    filename: string;
    userId: number;
  },
): Promise<ImportSession> {
  await pruneSessions(kernel);
  const dir = importsDir(kernel);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const id = randomBytes(12).toString('hex');
  const { xml } = paths(kernel, id);
  const max = maxImportBytes(kernel);
  let size = 0;
  try {
    await pipeline(
      input.body as AsyncIterable<Uint8Array>,
      async function* limit(source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          size += chunk.byteLength;
          if (size > max) {
            throw new ImportSessionError(
              'import_file_too_big',
              `This file is too big. Export files must be smaller than ${Math.round(max / 1024 / 1024)} MB.`,
              413,
            );
          }
          yield chunk;
        }
      },
      createWriteStream(xml, { mode: 0o600 }),
    );
  } catch (error) {
    await rm(xml, { force: true });
    throw error;
  }
  if (!size) {
    await rm(xml, { force: true });
    throw new ImportSessionError(
      'import_empty_file',
      'The file is empty. Choose the .xml file from Tools → Export.',
    );
  }
  let summary: WxrSummary;
  try {
    summary = await scanWxr({ path: xml });
  } catch (error) {
    await rm(xml, { force: true });
    throw new ImportSessionError(
      'wxr_invalid',
      error instanceof Error && 'code' in error
        ? error.message
        : 'This file couldn’t be read as a WordPress export. Check that it’s the .xml file from Tools → Export.',
    );
  }
  const session: ImportSession = {
    id,
    filename: path.basename(input.filename || 'import.xml'),
    size,
    userId: input.userId,
    createdAt: new Date().toISOString(),
    summary,
  };
  await saveSession(kernel, session);
  return session;
}

/** Step 2: queues the import. */
export async function startImportSession(
  kernel: Kernel,
  id: string,
  options: { authors?: Record<string, AuthorChoice>; fetchAttachments?: boolean; userId: number },
): Promise<ImportSession> {
  const session = await getSession(kernel, id);
  if (session.jobId) {
    throw new ImportSessionError('import_already_started', 'This import has already started.', 409);
  }
  const { xml } = paths(kernel, id);
  try {
    await stat(xml);
  } catch {
    throw new ImportSessionError(
      'import_not_found',
      'The uploaded file is gone. Upload it again.',
      404,
    );
  }
  const data: ImportJobData = {
    importId: id,
    userId: options.userId,
    authors: options.authors ?? {},
    fetchAttachments: Boolean(options.fetchAttachments),
    total: session.summary.items,
  };
  const job = await kernel.jobs.enqueue(IMPORT_JOB, data, {
    singletonKey: `import:${id}`,
    timeoutSeconds: IMPORT_TIMEOUT_SECONDS,
    maxAttempts: 3,
    backoffSeconds: 30,
  });
  if (!job)
    throw new ImportSessionError('import_already_started', 'This import has already started.', 409);
  session.jobId = job.id;
  session.startedAt = new Date().toISOString();
  session.options = { authors: data.authors, fetchAttachments: data.fetchAttachments };
  await saveSession(kernel, session);
  return session;
}

export interface SessionStatus {
  status: ImportStatus;
  progress: ImportProgress | null;
  report: ImportReport | null;
  /** Why the job failed (its last error's first line). */
  error: string | null;
}

/** Where an import is: from its job while it exists, else from the saved report. */
export async function sessionStatus(
  kernel: Kernel,
  session: ImportSession,
): Promise<SessionStatus> {
  if (!session.jobId) {
    return { status: 'uploaded', progress: null, report: null, error: null };
  }
  const job = await kernel.jobs.get(session.jobId);
  if (!job) {
    return session.report
      ? { status: 'completed', progress: null, report: session.report, error: null }
      : {
          status: 'failed',
          progress: null,
          report: null,
          error: session.error ?? 'The import stopped.',
        };
  }
  const data = job.data as ImportJobData;
  const status: ImportStatus = job.status === 'pending' ? 'queued' : (job.status as ImportStatus);
  return {
    status: status === 'queued' && job.attempts > 0 ? 'running' : status,
    progress: data.progress ?? null,
    report: data.report ?? session.report ?? null,
    error: job.status === 'failed' ? ((job.lastError ?? '').split('\n')[0] ?? null) : null,
  };
}

/** Cancels an import that hasn't started running, and deletes its files. */
export async function deleteImportSession(kernel: Kernel, id: string): Promise<void> {
  const session = await getSession(kernel, id);
  if (session.jobId) {
    const job = await kernel.jobs.get(session.jobId);
    if (job?.status === 'running' || (job?.status === 'pending' && job.attempts > 0)) {
      throw new ImportSessionError(
        'import_running',
        'This import is running and can’t be cancelled now.',
        409,
      );
    }
    if (job?.status === 'pending') await kernel.jobs.cancel(job.id);
  }
  await removeSession(kernel, id);
}

/** The most recent imports, newest first. */
export async function listImportSessions(kernel: Kernel, limit = 10): Promise<ImportSession[]> {
  let names: string[];
  try {
    names = await readdir(importsDir(kernel));
  } catch {
    return [];
  }
  const sessions: ImportSession[] = [];
  for (const name of names) {
    const id = name.replace(/\.json$/, '');
    if (!name.endsWith('.json') || !ID.test(id)) continue;
    try {
      sessions.push(await getSession(kernel, id));
    } catch {
      // Unreadable: skip.
    }
  }
  return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

/** Merges `patch` into a job's data without touching anything else. */
async function patchJobData(
  kernel: Kernel,
  jobId: number,
  patch: Partial<ImportJobData>,
): Promise<void> {
  await kernel.db
    .update(schema.jobs)
    .set({ data: sql`${schema.jobs.data} || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(schema.jobs.id, jobId));
}

/** Registers the import job's handler. Called once, from the kernel. */
export function registerImportJobs(kernel: Kernel): void {
  kernel.jobs.register<ImportJobData>(
    IMPORT_JOB,
    async (data, { job, signal }) => {
      const user = await loadUser(kernel, data.userId);
      if (!user) throw new Error('The user who started this import no longer exists.');
      const { xml } = paths(kernel, data.importId);
      const session = await getSession(kernel, data.importId);
      try {
        await stat(xml);
      } catch {
        throw new Error('The uploaded file is gone. Upload it again.');
      }
      const report = await runImport(kernel, new WxrReader({ path: xml }), {
        user,
        authors: data.authors,
        fetchAttachments: data.fetchAttachments,
        allowPrivateHosts: kernel.config.import?.allowPrivateHosts,
        total: data.total,
        signal,
        onProgress: (progress) => patchJobData(kernel, job.id, { progress }),
      });
      await patchJobData(kernel, job.id, { report });
      await saveSession(kernel, { ...session, report });
      // wp_import_cleanup(): the uploaded file isn't needed any more.
      await rm(xml, { force: true });
    },
    { maxAttempts: 3, timeoutSeconds: IMPORT_TIMEOUT_SECONDS, backoffSeconds: 30 },
  );
  // Remember why an import failed for good, after its job row is pruned.
  kernel.hooks.addAction(
    'pressbase_job_failed',
    async (job: Job, error: unknown, retrying: boolean) => {
      if (job.name !== IMPORT_JOB || retrying) return;
      const id = (job.data as ImportJobData | null)?.importId;
      if (!id) return;
      try {
        const session = await getSession(kernel, id);
        await saveSession(kernel, {
          ...session,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Already deleted.
      }
    },
  );
}

/* ------------------------------------------------------- functions for the CLI */

export interface ImportWxrOptions extends Omit<ImportOptions, 'user'> {
  /** The user the import runs as (needs `import`). */
  userId: number;
}

/**
 * Imports a WXR file in this process, without the job queue: what
 * `pressbase import` calls. `input` is a path (`{ path }`), XML text
 * (`{ xml }`) or a stream. Returns the report.
 */
export async function importWxr(
  kernel: Kernel,
  input: WxrInput,
  options: ImportWxrOptions,
): Promise<ImportReport> {
  const user = await loadUser(kernel, options.userId);
  if (!user) throw new ImportSessionError('import_invalid_user', 'That user doesn’t exist.', 404);
  return runImport(kernel, new WxrReader(input), {
    ...options,
    user,
    allowPrivateHosts: options.allowPrivateHosts ?? kernel.config.import?.allowPrivateHosts,
  });
}
