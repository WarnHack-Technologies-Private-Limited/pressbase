import { describe, expect, it } from 'vitest';
import {
  allowAnyone,
  defineLifecycle,
  defineManifest,
  definePlugin,
  defineRoute,
  type PluginApi,
  requireCapability,
  restError,
} from '../src/index';

describe('@pressbase/plugin-sdk helpers', () => {
  it('returns what they are given', () => {
    const register = () => {};
    expect(definePlugin(register)).toBe(register);
    expect(defineLifecycle(register)).toBe(register);
    const manifest = { name: 'x', title: 'X', version: '1.0.0' };
    expect(defineManifest(manifest)).toBe(manifest);
    const route = { permission: allowAnyone, handler: () => 'ok' };
    expect(defineRoute(route)).toBe(route);
    expect(allowAnyone()).toBe(true);
  });

  it('checks capabilities through api.rest.userCan', () => {
    const asked: string[] = [];
    const api = {
      rest: {
        userCan: (_c: unknown, capability: string) => {
          asked.push(capability);
          return capability === 'edit_posts';
        },
      },
    } as unknown as PluginApi;
    const c = {} as never;
    expect(requireCapability(api, 'edit_posts')(c)).toBe(true);
    expect(requireCapability(api, 'manage_options')(c)).toBe(false);
    expect(asked).toEqual(['edit_posts', 'manage_options']);
  });

  it('builds WordPress-shaped REST errors', async () => {
    const res = restError(409, 'my_plugin_taken', 'That name is taken.', { field: 'name' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: 'my_plugin_taken',
      message: 'That name is taken.',
      data: { status: 409, field: 'name' },
    });
  });
});
