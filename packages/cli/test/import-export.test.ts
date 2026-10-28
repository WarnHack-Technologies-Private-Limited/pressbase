import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { site, tempDir } from './helpers';

/** import and export: WXR out of one site and into another. */

describe('export and import', () => {
  it('moves a post to a fresh site, and skips it on a second run', {
    timeout: 180_000,
  }, async () => {
    const from = await site();
    await from.ok([
      'post',
      'create',
      '--post_title=Notes on tidal islands',
      '--post_content=Cut off twice a day.',
      '--post_status=publish',
    ]);
    const dir = await tempDir();
    expect(await from.ok(['export', `--dir=${dir}`])).toMatch(/^Success: Exported to .+\.xml\.\n$/);
    const [file] = await readdir(dir);
    const xml = await readFile(path.join(dir, file ?? ''), 'utf8');
    expect(xml).toContain('<wp:wxr_version>1.2</wp:wxr_version>');
    expect(xml).toContain('Notes on tidal islands');
    expect(await from.ok(['export', '--stdout', '--post_type=page'])).not.toContain(
      'Notes on tidal islands',
    );

    const to = await site();
    const xmlPath = path.join(dir, file ?? '');
    // Imports run as a user who can import.
    expect((await to.cli(['import', xmlPath])).stderr).toMatch(/Add --user=<username>/);
    expect(await to.ok(['import', xmlPath, '--user=admin', '--skip=attachment'])).toMatch(
      /Success: Imported 1 file\./,
    );
    expect(await to.ok(['post', 'list', '--field=post_title'])).toContain('Notes on tidal islands');

    // A second run finds the post already there.
    expect(await to.ok(['import', xmlPath, '--user=admin', '--skip=attachment'])).toMatch(
      /Skipped \d+/,
    );
    const titles = (await to.ok(['post', 'list', '--field=post_title', '--format=json'])) as string;
    expect(JSON.parse(titles).filter((t: string) => t === 'Notes on tidal islands')).toHaveLength(
      1,
    );
  });
});
