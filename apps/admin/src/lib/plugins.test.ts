import { describe, expect, it } from 'vitest';
import {
  canDelete,
  countPlugins,
  describePermission,
  isBroken,
  pluginProblem,
  type RestPlugin,
  sortPlugins,
  uploadMessage,
} from './plugins';

const plugin = (overrides: Partial<RestPlugin> = {}): RestPlugin => ({
  plugin: 'sample',
  status: 'inactive',
  name: 'Sample',
  plugin_uri: '',
  author: '',
  author_uri: '',
  description: { raw: '', rendered: '' },
  version: '1.0.0',
  requires_pressbase: '*',
  permissions: [],
  granted_permissions: [],
  admin: null,
  source: 'site',
  compatible: true,
  error: null,
  runtime_errors: [],
  ...overrides,
});

describe('plugins', () => {
  it('lists active plugins first, then by name', () => {
    const sorted = sortPlugins([
      plugin({ plugin: 'b', name: 'Beta' }),
      plugin({ plugin: 'z', name: 'Zeta', status: 'active' }),
      plugin({ plugin: 'a', name: 'Alpha' }),
    ]);
    expect(sorted.map((p) => p.plugin)).toEqual(['z', 'a', 'b']);
    expect(countPlugins(sorted)).toEqual({ all: 3, active: 1, inactive: 2 });
  });

  it('only offers Delete for inactive plugins installed on the site', () => {
    expect(canDelete(plugin())).toBe(true);
    expect(canDelete(plugin({ status: 'active' }))).toBe(false);
    expect(canDelete(plugin({ source: 'bundled' }))).toBe(false);
  });

  it('explains what went wrong', () => {
    expect(pluginProblem(plugin())).toBeNull();
    const broken = plugin({ error: { message: 'name: bad', during: 'manifest', time: '' } });
    expect(isBroken(broken)).toBe(true);
    expect(pluginProblem(broken)).toMatch(/can’t be loaded: name: bad/);
    expect(pluginProblem(plugin({ error: { message: 'boom', during: 'load', time: '' } }))).toMatch(
      /switched off because it failed to load: boom/,
    );
    expect(pluginProblem(plugin({ compatible: false, requires_pressbase: '>=2' }))).toMatch(/>=2/);
    expect(
      pluginProblem(
        plugin({
          status: 'active',
          runtime_errors: [{ message: 'oops', during: 'hook', time: '' }],
        }),
      ),
    ).toMatch(/oops/);
  });

  it('describes permissions and upload errors in plain words', () => {
    expect(describePermission('database')).toMatch(/database/);
    expect(describePermission('unknown')).toBe('unknown');
    expect(uploadMessage(400, 'incompatible_archive_no_plugins')).toMatch(/plugin.json/);
    expect(uploadMessage(413)).toMatch(/too big/);
  });
});
