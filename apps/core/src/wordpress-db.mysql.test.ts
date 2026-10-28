import { schema } from '@pressbase/db';
import { describe, expect, it } from 'vitest';
import type { ImportRecord } from './import-export/records';
import { connectWordPressDatabase } from './import-export/wordpress-db';
import {
  FIXTURE_PASSWORDS,
  FIXTURE_UPLOADS,
  memoryWordPressDatabase,
  wordpressFixture,
  wordpressSchemaSql,
} from './import-export/wordpress-db-fixture';
import { WordPressDatabaseSource } from './import-export/wordpress-db-reader';
import { migrateFromWordPressDatabase } from './import-export/wordpress-migrate';
import { setup } from './test-utils';

/**
 * The WordPress database migration against a real MySQL (the `wordpress-mysql`
 * CI job, with `services: mysql:8`). Skipped unless PRESSBASE_TEST_MYSQL_URL
 * names a database the test may fill, as a user who can create tables and
 * users: mysql://root:root@127.0.0.1:3306/wordpress.
 *
 * It loads the in-memory fixture into MySQL, checks the SQL reads exactly
 * what the fake does, and migrates as a user with only SELECT.
 */

const ADMIN_URL = process.env.PRESSBASE_TEST_MYSQL_URL;
const PREFIX = 'wpt_';
const READER = { user: 'pressbase_reader', password: 'Read-0nly;pass' };

async function load(url: string): Promise<string> {
  const mysql = await import('mysql2/promise');
  const target = new URL(url);
  const database = target.pathname.slice(1);
  const connection = await mysql.createConnection({
    host: target.hostname,
    port: Number(target.port || 3306),
    user: decodeURIComponent(target.username),
    password: decodeURIComponent(target.password),
    database,
    charset: 'utf8mb4',
  });
  try {
    // WordPress drops the modes that refuse its zero dates (wpdb::set_sql_mode()).
    await connection.query("SET SESSION sql_mode = ''");
    const tables = wordpressFixture();
    for (const name of Object.keys(tables)) {
      await connection.query(`DROP TABLE IF EXISTS ${PREFIX}${name}`);
    }
    for (const sql of wordpressSchemaSql(PREFIX)) await connection.query(sql);
    for (const [name, rows] of Object.entries(tables)) {
      for (const row of rows) {
        const columns = Object.keys(row);
        await connection.query(
          `INSERT INTO ${PREFIX}${name} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
          columns.map((c) => row[c]),
        );
      }
    }
    // A user who may only read: all a migration needs.
    await connection.query(`DROP USER IF EXISTS '${READER.user}'@'%'`);
    await connection.query(`CREATE USER '${READER.user}'@'%' IDENTIFIED BY ?`, [READER.password]);
    await connection.query(`GRANT SELECT ON \`${database}\`.* TO '${READER.user}'@'%'`);
  } finally {
    await connection.end();
  }
  target.username = READER.user;
  target.password = encodeURIComponent(READER.password);
  return target.toString();
}

async function collect(source: WordPressDatabaseSource): Promise<ImportRecord[]> {
  const out: ImportRecord[] = [];
  for await (const record of source.records()) out.push(record);
  return out;
}

describe.skipIf(!ADMIN_URL)('migrating from a real MySQL database', () => {
  it('reads what the fake reads, as a read-only user, and migrates it', {
    timeout: 180_000,
  }, async () => {
    const readerUrl = await load(ADMIN_URL ?? '');

    // A wrong password is refused, and the message doesn't repeat it.
    const wrong = new URL(readerUrl);
    wrong.password = 'not-the-password-xyz';
    const refused = await connectWordPressDatabase(wrong.toString(), PREFIX).catch((e) => e);
    expect(refused).toBeInstanceOf(Error);
    expect(String(refused.message)).not.toContain('not-the-password-xyz');

    const real = await connectWordPressDatabase(readerUrl, PREFIX);
    try {
      const fake = memoryWordPressDatabase(wordpressFixture(), { prefix: PREFIX });
      const fromMysql = new WordPressDatabaseSource(real);
      const fromFake = new WordPressDatabaseSource(fake);
      await fromMysql.check();
      expect(await fromMysql.counts()).toEqual(await fromFake.counts());
      expect(await collect(fromMysql)).toEqual(await collect(fromFake));
    } finally {
      await real.close();
    }

    const ctx = await setup();
    await ctx.install();
    const [admin] = await ctx.kernel.db.select({ id: schema.users.id }).from(schema.users);
    const result = await migrateFromWordPressDatabase(ctx.kernel, {
      database: readerUrl,
      prefix: PREFIX,
      uploads: FIXTURE_UPLOADS,
      userId: admin?.id ?? 1,
    });
    expect(result.source).not.toContain(READER.password);
    expect(result.report?.errors.items).toEqual([]);
    expect(result.report?.imported.users).toBe(2);
    expect(result.report?.imported.posts).toMatchObject({ post: 3, page: 5, attachment: 1 });
    const res = await ctx.app.request('/wp-json/pressbase/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pressbase-request': '1' },
      body: JSON.stringify({ login: 'nadia', password: FIXTURE_PASSWORDS.nadia }),
    });
    expect(res.status).toBe(200);
  });
});
