// tsc doesn't copy .d.ts sources: put the generated core types beside dist/index.d.ts.
import { copyFile } from 'node:fs/promises';

await copyFile(
  new URL('../src/core.generated.d.ts', import.meta.url),
  new URL('../dist/core.generated.d.ts', import.meta.url),
);
