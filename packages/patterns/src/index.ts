/**
 * @pressbase/patterns — the Pressbase pattern library. See README.md for the
 * rules every pattern follows and docs/architecture/patterns.md for how core
 * registers them.
 */
export {
  LIBRARY_CATEGORIES,
  type LibraryCategory,
  type LibraryPattern,
  libraryPatterns,
  PATTERNS_DIR,
  PatternFileError,
  readPattern,
  readPatterns,
} from './library';
export { checkPattern, PORTABLE_PRESETS } from './rules';
