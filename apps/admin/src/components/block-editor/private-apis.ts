/**
 * WordPress's private APIs, which Studio needs for responsive editing (#49):
 * the block editor's style state viewport (`setStyleStateViewport()`, which
 * makes the inspector's style panels edit `style["@mobile"]`) and the
 * device the canvas shows (`deviceTypeKey`).
 *
 * WordPress keeps these for its own packages. Studio does the job of
 * `@wordpress/edit-site` (WordPress's site editor, which Pressbase doesn't
 * ship), so it opts in under that name. The APIs can change with any
 * @wordpress/block-editor release: the versions are pinned in package.json,
 * and responsive-model.test.ts and the Studio e2e tests cover what we use.
 */

import { __dangerousOptInToUnstableAPIsOnlyForCoreModules } from '@wordpress/private-apis';

const CONSENT =
  'I acknowledge private features are not for use in themes or plugins and doing so will break in the next version of WordPress.';

const { unlock: unlockPrivate } = __dangerousOptInToUnstableAPIsOnlyForCoreModules(
  CONSENT,
  '@wordpress/edit-site',
);

/** The private part of a WordPress object (a store's actions or selectors, a package's privateApis). */
export function unlock<T = Record<string | symbol, unknown>>(object: unknown): T {
  return unlockPrivate(object as object) as T;
}
