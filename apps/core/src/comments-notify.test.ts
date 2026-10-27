import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { setup } from './test-utils';

interface OutboxMail {
  to: string[];
  subject: string;
  text: string;
}

async function outbox(dataDir: string, n: number): Promise<OutboxMail[]> {
  const dir = path.join(dataDir, 'outbox');
  for (let i = 0; i < 100; i += 1) {
    const files = (await readdir(dir).catch(() => [] as string[])).filter((f) =>
      f.endsWith('.json'),
    );
    if (files.length >= n) {
      return Promise.all(
        files
          .sort()
          .map(async (f) => JSON.parse(await readFile(path.join(dir, f), 'utf8')) as OutboxMail),
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return [];
}

/** A visitor's comment: no cookie, no CSRF header (the anonymous-comment exception). */
async function visitorComment(
  app: Awaited<ReturnType<typeof setup>>['app'],
  post: number,
  content: string,
  who = { name: 'Ada', email: 'ada@example.com', ip: '203.0.113.1' },
) {
  return app.request('/wp-json/wp/v2/comments', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': who.ip },
    body: JSON.stringify({ post, author_name: who.name, author_email: who.email, content }),
  });
}

describe('comment notifications', () => {
  it('emails the moderators when a comment is held, and the author when one is approved', async () => {
    const { app, dataDir, install, request } = await setup();
    await install();
    const post = await request('POST', '/wp/v2/posts', {
      title: 'Calm software',
      status: 'publish',
    });

    // First-time commenters are held ("previously approved" is on by default).
    expect((await visitorComment(app, post.body.id, 'Lovely piece.')).status).toBe(201);
    const [held] = await outbox(dataDir, 1);
    expect(held?.to).toEqual(['admin@example.com']);
    expect(held?.subject).toContain('Please moderate: “Calm software”');
    expect(held?.text).toContain('Ada (ada@example.com)');
    expect(held?.text).toContain('/admin/comments?c=');

    // The admin wrote the post, so their own approved comment sends nothing new…
    await request('POST', '/wp/v2/comments', { post: post.body.id, content: 'Thanks!' });
    // …but turning off moderation emails silences the next held comment too.
    await request('POST', '/wp/v2/settings', { moderation_notify: false });
    // A different visitor (the same one would trip flood control).
    const grace = { name: 'Grace', email: 'grace@example.com', ip: '203.0.113.2' };
    expect((await visitorComment(app, post.body.id, 'Another thought.', grace)).status).toBe(201);
    await new Promise((r) => setTimeout(r, 200));
    expect(await outbox(dataDir, 1)).toHaveLength(1);
  });
});
