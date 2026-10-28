import { AiError, type AiProvider } from '@pressbase/core/src/ai/types';
import { describe, expect, it } from 'vitest';
import { site } from './helpers';

/** pressbase ability list|get|run, ability category list and ai test (v0.7). */

describe('pressbase ability', () => {
  it('lists and shows abilities', async () => {
    const s = await site();
    const list = await s.ok(['ability', 'list', '--format=json']);
    expect(JSON.parse(list)).toEqual([
      expect.objectContaining({ name: 'core/get-site-info', category: 'site' }),
    ]);
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
