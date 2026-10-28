/**
 * The types `@pressbase/plugin-sdk` publishes. Its build bundles this file's
 * declarations (and everything they reference) into one `.d.ts`, so plugin
 * authors get core's exact types without installing core
 * (packages/plugin-sdk/README.md, docs/architecture/plugins.md#the-sdk).
 *
 * Add a type here when plugins need to name it. Every module that adds hooks
 * to the registries (`declare module '@pressbase/hooks'`) is pulled in with an
 * `export type {} from …` line so
 * the SDK's hook names stay complete; the SDK's generator fails when one is
 * missing.
 */

export type {} from '@pressbase/blocks';
export type {
  ActionArgs,
  ActionCallback,
  ActionRegistry,
  FilterArgs,
  FilterCallback,
  FilterRegistry,
} from '@pressbase/hooks';
export type { CurrentUser } from '../auth/users';
export type {} from '../cache/invalidation';
export type { PostType, PostTypeArgs } from '../content/post-types';
export type { Post, PostInput } from '../content/posts';
export type { QueryArgs, QueryResult } from '../content/query';
export type { Taxonomy, TaxonomyArgs } from '../content/taxonomies';
export type {} from '../frontend/dependencies';
export type { HtmlOutput } from '../frontend/head';
export type { PageRender } from '../frontend/page';
export type {} from '../frontend/render';
export type {} from '../frontend/title';
export type {} from '../jobs/core-events';
export type { CronEvent, CronSchedule } from '../jobs/cron';
export type { EnqueueOptions, HandlerOptions, Job, JobContext } from '../jobs/queue';
export type {} from '../mail/mailer';
export type {} from '../people/application-passwords';
export type {} from '../people/password-reset';
export type {} from '../people/users';
export type {} from '../routes/users';
export type {
  DebugField,
  DebugInfo,
  DebugSection,
  DebugValue,
  SiteHealthAsyncTest,
  SiteHealthDirectTest,
  SiteHealthStatus,
  SiteHealthTestResult,
  SiteStatusTests,
} from '../site-health/types';
export type {
  PageParent,
  PluginPageArgs,
  PluginSectionArgs,
  PluginSettingArgs,
  SettingChoice,
  SettingControl,
  SettingType,
} from './admin';
export type {
  PluginAssets,
  PluginScripts,
  PluginStyles,
  ScriptOptions,
  Strategy,
  Version,
} from './assets';
export type { PluginCron, PluginJobContext, PluginJobHandler, PluginJobs } from './background';
export type {
  PluginCliAssocArgs,
  PluginCliCommandArgs,
  PluginCliHandler,
  PluginCliIo,
} from './cli';
export type {} from './manager';
export type { PluginManifest, PluginManifestInput, PluginPermission } from './manifest';
export type {
  PluginApi,
  PluginLogger,
  PluginModule,
  PluginRequestContext,
  PluginRouteArgs,
} from './runtime';
