// Builds src/index.ts into dist/index.js: one ES module, the SDK's few
// helpers bundled in. Pressbase imports it as is; run `npm run typecheck` for
// type errors (esbuild only strips types).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // Node's built-ins stay imports; everything else you import is bundled.
  packages: 'bundle',
  sourcemap: true,
  logLevel: 'info',
});
