import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractStrings, staleTemplates, withoutReferences } from './extract';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('pnpm i18n:extract', () => {
  it('keeps languages/*.pot in step with the source (run `pnpm i18n:extract`)', () => {
    expect(staleTemplates()).toEqual([]);
  });

  it('collects calls by domain, with contexts, plurals, markers and translators’ notes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pressbase-extract-'));
    dirs.push(root);
    await mkdir(path.join(root, 'apps/admin/src'), { recursive: true });
    await writeFile(
      path.join(root, 'apps/admin/src/page.tsx'),
      `const LABELS = [msgid('Posts'), msgid('May', 'May abbreviation')];
export function Page({ n, name }: { n: number; name: string }) {
  const { __, _x, _n } = useI18n();
  // translators: %s: a person's name.
  const hello = sprintf(__('Hello, %s', 'pressbase-admin'), name);
  return (
    <p title={_x('Post', 'verb', 'pressbase-admin')}>
      {/* translators: %d: how many. */}
      {_n('%d item', '%d items', n, 'pressbase-admin')}
      {__('Other domain', 'my-plugin')}
      {__(dynamic, 'pressbase-admin')}
      {i18n.__('Twice', 'pressbase-admin')}{__('Twice', 'pressbase-admin')}
      {__('Joined ' + 'up', 'pressbase-admin')}
    </p>
  );
}`,
    );
    await writeFile(
      path.join(root, 'apps/admin/src/page.test.tsx'),
      `__('From a test', 'pressbase-admin');`,
    );
    const entries = extractStrings(
      { domain: 'pressbase-admin', dirs: ['apps/admin/src'], pot: 'x.pot', markers: true },
      root,
    );
    expect(entries.map((e) => [e.context, e.singular, e.plural])).toEqual([
      ['', 'Posts', undefined],
      ['May abbreviation', 'May', undefined],
      ['', 'Hello, %s', undefined],
      ['verb', 'Post', undefined],
      ['', '%d item', '%d items'],
      ['', 'Twice', undefined],
      ['', 'Joined up', undefined],
    ]);
    const hello = entries.find((e) => e.singular === 'Hello, %s');
    expect(hello).toMatchObject({
      extractedComments: "translators: %s: a person's name.",
      references: ['apps/admin/src/page.tsx:5'],
      flags: ['js-format'],
    });
    expect(entries.find((e) => e.singular === '%d item')?.extractedComments).toBe(
      'translators: %d: how many.',
    );
    expect(entries.find((e) => e.singular === 'Twice')?.references).toHaveLength(2);
    expect(withoutReferences('#: a.ts:1\nmsgid "x"')).toBe('msgid "x"');
  });
});
