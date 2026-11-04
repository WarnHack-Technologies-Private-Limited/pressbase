import { AiError, type AiProvider } from '@pressbase/core/src/ai/types';
import { describe, expect, it } from 'vitest';
import { site } from './helpers';

/** pressbase ability list|get|run, ability category list and ai test (v0.7). */

describe('pressbase ability', () => {
  it('lists and shows abilities', async () => {
    const s = await site();
    const list = await s.ok(['ability', 'list', '--format=json']);
    expect(JSON.parse(list).map((a: { name: string }) => a.name)).toEqual([
      // The quality checks (v0.8, docs/architecture/quality-checks.md).
      'core/check-page',
      // The site-building abilities (v0.8, docs/architecture/site-abilities.md).
      'core/create-page',
      'core/get-design-system',
      'core/get-page-structure',
      'core/get-site-brief',
      'core/get-site-info',
      'core/list-patterns',
      'core/update-global-styles',
      'core/update-page-sections',
      'core/update-template-part',
    ]);
    expect(JSON.parse(list)).toContainEqual(
      expect.objectContaining({ name: 'core/get-site-info', category: 'site' }),
    );
    const one = JSON.parse(await s.ok(['ability', 'get', 'core/get-site-info', '--format=json']));
    expect(JSON.parse(one.input_schema).properties.fields.type).toBe('array');
    const categories = await s.ok(['ability', 'category', 'list', '--field=slug']);
    expect(categories.trim().split('\n')).toEqual(['site', 'user']);
    const missing = await s.cli(['ability', 'get', 'nope/nope']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('There’s no ability “nope/nope”');
  });

  it('runs an ability with JSON input, checking input and --user', async () => {
    const s = await site();
    const out = await s.ok([
      'ability',
      'run',
      'core/get-site-info',
      '--input={"fields":["name","charset"]}',
    ]);
    expect(JSON.parse(out)).toEqual({ name: 'Test Site', charset: 'UTF-8' });

    const invalid = await s.cli([
      'ability',
      'run',
      'core/get-site-info',
      '--input={"fields":["x"]}',
    ]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain('(ability_invalid_input)');

    const bad = await s.cli(['ability', 'run', 'core/get-site-info', '--input=nope']);
    expect(bad.stderr).toContain('--input must be JSON');

    await s.loginAs('ed', 'editor');
    const denied = await s.cli(['ability', 'run', 'core/get-site-info', '--user=ed']);
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain('(ability_invalid_permissions)');
  });
});

describe('pressbase ability run: site building', () => {
  it('reads the site and writes into the user’s changeset, never the live site', async () => {
    const s = await site();
    const brief = JSON.parse(await s.ok(['ability', 'run', 'core/get-site-brief']));
    expect(brief).toMatchObject({ name: 'Test Site', facts: [] });
    const patterns = JSON.parse(
      await s.ok(['ability', 'run', 'core/list-patterns', '--input={"category":"opening-hours"}']),
    );
    expect(patterns.patterns.map((p: { name: string }) => p.name)).toEqual([
      'pressbase/opening-hours',
    ]);
    const design = JSON.parse(await s.ok(['ability', 'run', 'core/get-design-system']));
    expect(design.palette.length).toBeGreaterThan(0);

    // A write needs a person: their changeset holds the change.
    const anonymous = await s.cli([
      'ability',
      'run',
      'core/create-page',
      '--input={"title":"Menu"}',
    ]);
    expect(anonymous.code).toBe(1);
    expect(anonymous.stderr).toContain('(rest_not_logged_in)');

    const input = JSON.stringify({
      title: 'Menu',
      sections: [{ pattern: 'pressbase/hero-centered', slots: { title: 'Our bread' } }],
    });
    const created = JSON.parse(
      await s.ok(['ability', 'run', 'core/create-page', `--input=${input}`, '--user=admin']),
    );
    expect(created).toMatchObject({ slug: 'menu', entry: 'page:menu' });
    const structure = JSON.parse(
      await s.ok([
        'ability',
        'run',
        'core/get-page-structure',
        '--input={"slug":"menu"}',
        '--user=admin',
      ]),
    );
    expect(structure.sections[0].values.title).toBe('Our bread');
    expect(await s.kernel.changesets.find(created.changeset_uuid)).toMatchObject({
      status: 'auto-draft',
    });
    const live = await s.request('GET', '/wp/v2/pages?slug=menu&status=any');
    expect(live.body).toEqual([]);

    const styles = await s.cli([
      'ability',
      'run',
      'core/update-global-styles',
      '--input={"styles":{"color":{"background":"#000"}}}',
      '--user=admin',
    ]);
    expect(styles.code).toBe(1);
    expect(styles.stderr).toContain('(ability_invalid_input)');
  });
});

describe('pressbase ai test', () => {
  it('reports AI that is off, then a working provider, without network', async () => {
    const s = await site();
    const off = await s.cli(['ai', 'test']);
    expect(off.code).toBe(1);
    expect(off.stderr).toContain('(prompt_prevented)');

    const provider: AiProvider = {
      id: 'mock',
      name: 'Mock',
      envVar: 'PRESSBASE_MOCK_API_KEY',
      defaultModel: 'mock-1',
      models: [],
      async generateText(request) {
        if (request.model !== 'mock-1') throw new AiError('prompt_client_error', 'model', 400);
        return {
          id: '1',
          message: { role: 'model', parts: [{ type: 'text', text: 'OK' }] },
          finishReason: 'stop',
          tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          providerId: 'mock',
          model: 'mock-1',
        };
      },
    };
    s.kernel.ai.registerProvider(provider);
    await s.kernel.ai.saveSettings({ enabled: true, provider: 'mock' });
    await s.kernel.ai.setApiKey('mock', 'mock-key-123456789');
    expect(await s.ok(['ai', 'test'])).toContain('Success: mock answered with mock-1.');
  });
});
