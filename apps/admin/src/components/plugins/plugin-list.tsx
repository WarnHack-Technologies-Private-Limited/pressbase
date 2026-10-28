'use client';

import { Plug, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { useCan } from '@/components/shell/current-user';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Badge, Card, EmptyState, Notice } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import { ApiError, api } from '@/lib/api';
import {
  canDelete,
  countPlugins,
  describePermission,
  isBroken,
  PluginUploadError,
  pluginProblem,
  type RestPlugin,
  uploadPlugin,
} from '@/lib/plugins';
import styles from './plugins.module.css';

type Filter = 'all' | 'active' | 'inactive';

/**
 * Plugins (wp-admin/plugins.php): the installed plugins with Activate,
 * Deactivate and Delete, an upload form (plugin-install.php?tab=upload), the
 * permissions a plugin asks for before it's activated, and load errors.
 */
export function PluginList({ plugins }: { plugins: RestPlugin[] }) {
  const router = useRouter();
  const toast = useToast();
  const canInstall = useCan('install_plugins');
  const canActivate = useCan('activate_plugins');
  const canDeletePlugins = useCan('delete_plugins');
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmActivate, setConfirmActivate] = useState<RestPlugin | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<RestPlugin | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const counts = countPlugins(plugins);
  const shown = plugins.filter((p) => filter === 'all' || p.status === filter);

  async function setStatus(plugin: RestPlugin, status: 'active' | 'inactive') {
    setBusy(plugin.plugin);
    try {
      await api(`/wp/v2/plugins/${encodeURIComponent(plugin.plugin)}`, {
        method: 'PUT',
        body: status === 'active' ? { status, permissions: plugin.permissions } : { status },
      });
      toast(status === 'active' ? `${plugin.name} is active.` : `${plugin.name} is deactivated.`);
      setConfirmActivate(null);
      router.refresh();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'That didn’t work. Try again.', {
        tone: 'danger',
      });
      setConfirmActivate(null);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  function activate(plugin: RestPlugin) {
    // Plugins that ask for permissions are confirmed first; the rest activate at once.
    if (plugin.permissions.length) setConfirmActivate(plugin);
    else void setStatus(plugin, 'active');
  }

  async function remove(plugin: RestPlugin) {
    setBusy(plugin.plugin);
    try {
      await api(`/wp/v2/plugins/${encodeURIComponent(plugin.plugin)}`, { method: 'DELETE' });
      toast(`${plugin.name} was deleted.`);
      setConfirmDelete(null);
      router.refresh();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'The plugin couldn’t be deleted.', {
        tone: 'danger',
      });
    } finally {
      setBusy(null);
    }
  }

  async function upload(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const plugin = await uploadPlugin(file);
      toast(`${plugin.name} was installed. Activate it when you’re ready.`);
      router.refresh();
    } catch (error) {
      setUploadError(
        error instanceof PluginUploadError ? error.message : 'The plugin couldn’t be installed.',
      );
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <>
      {canInstall && (
        <Card
          title="Add a plugin"
          description="Upload a plugin as a .zip file. It installs without restarting your site."
        >
          <div className={styles.upload}>
            <input
              ref={fileRef}
              id="plugin-zip"
              type="file"
              accept=".zip,application/zip"
              className="visually-hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            <Button
              icon={<Upload size={16} aria-hidden="true" />}
              loading={uploading}
              onClick={() => fileRef.current?.click()}
            >
              Upload plugin
            </Button>
            <p className={styles.hint}>
              Only install plugins you trust: a plugin runs with the same access as Pressbase
              itself.
            </p>
          </div>
          {uploadError && <Notice tone="danger">{uploadError}</Notice>}
        </Card>
      )}

      <nav className={styles.filters} aria-label="Filter plugins">
        {(['all', 'active', 'inactive'] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={styles.filter}
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'All' : f === 'active' ? 'Active' : 'Inactive'} ({counts[f]})
          </button>
        ))}
      </nav>

      {shown.length === 0 ? (
        <Card>
          <EmptyState icon={<Plug size={28} />} title="No plugins here">
            <p>
              {filter === 'all'
                ? 'Upload a plugin’s .zip file to add features to your site.'
                : `No ${filter} plugins.`}
            </p>
          </EmptyState>
        </Card>
      ) : (
        <ul className={styles.list}>
          {shown.map((plugin) => {
            const active = plugin.status === 'active';
            const problem = pluginProblem(plugin);
            const broken = isBroken(plugin);
            return (
              <li key={plugin.plugin} className={styles.plugin} data-active={active}>
                <div className={styles.main}>
                  <div className={styles.titleRow}>
                    <h2 className={styles.name}>{plugin.name}</h2>
                    {active && <Badge tone="success">Active</Badge>}
                    {plugin.source === 'bundled' && <Badge>Bundled</Badge>}
                  </div>
                  {!broken && (
                    <p className={styles.meta}>
                      Version {plugin.version}
                      {plugin.author && (
                        <>
                          {' · By '}
                          {plugin.author_uri ? (
                            <a href={plugin.author_uri} target="_blank" rel="noreferrer">
                              {plugin.author}
                            </a>
                          ) : (
                            plugin.author
                          )}
                        </>
                      )}
                      {plugin.plugin_uri && (
                        <>
                          {' · '}
                          <a href={plugin.plugin_uri} target="_blank" rel="noreferrer">
                            Visit plugin site
                          </a>
                        </>
                      )}
                    </p>
                  )}
                  {plugin.description.raw && (
                    <p className={styles.description}>{plugin.description.raw}</p>
                  )}
                  {plugin.permissions.length > 0 && (
                    <p className={styles.meta}>Permissions: {plugin.permissions.join(', ')}</p>
                  )}
                  {problem && <Notice tone={active ? 'warning' : 'danger'}>{problem}</Notice>}
                </div>
                <div className={styles.actions}>
                  {!active && !broken && canActivate && (
                    <Button
                      variant="primary"
                      size="sm"
                      loading={busy === plugin.plugin && !confirmDelete}
                      disabled={busy !== null || !plugin.compatible}
                      onClick={() => activate(plugin)}
                      aria-label={`Activate ${plugin.name}`}
                    >
                      Activate
                    </Button>
                  )}
                  {active && canActivate && (
                    <Button
                      size="sm"
                      loading={busy === plugin.plugin}
                      disabled={busy !== null}
                      onClick={() => setStatus(plugin, 'inactive')}
                      aria-label={`Deactivate ${plugin.name}`}
                    >
                      Deactivate
                    </Button>
                  )}
                  {canDelete(plugin) && canDeletePlugins && (
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => setConfirmDelete(plugin)}
                      aria-label={`Delete ${plugin.name}`}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={confirmActivate !== null}
        title={`Activate ${confirmActivate?.name ?? 'plugin'}?`}
        confirmLabel="Allow and activate"
        tone="primary"
        busy={busy !== null}
        onConfirm={() => confirmActivate && setStatus(confirmActivate, 'active')}
        onCancel={() => setConfirmActivate(null)}
      >
        <p>This plugin asks to:</p>
        <ul className={styles.permissions}>
          {confirmActivate?.permissions.map((p) => (
            <li key={p}>{describePermission(p)}</li>
          ))}
        </ul>
        <p>Only allow this if you trust the plugin’s author.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete?.name ?? 'plugin'}?`}
        confirmLabel="Delete plugin"
        busy={busy !== null}
        onConfirm={() => confirmDelete && remove(confirmDelete)}
        onCancel={() => setConfirmDelete(null)}
      >
        <p>
          The plugin’s files are removed and it runs its clean-up. Content it created, like posts,
          stays on your site. This can’t be undone.
        </p>
      </ConfirmDialog>
    </>
  );
}
