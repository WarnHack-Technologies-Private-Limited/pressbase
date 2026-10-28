// Packs the built plugin into <name>-<version>.zip, ready for
// Plugins → Upload plugin (or POST /wp-json/wp/v2/plugins).
//
// The archive holds one folder named after the plugin with plugin.json, the
// built dist/, and migrations/, public/ and README.md when present. It is a
// plain ZIP (deflate, no ZIP64, no symlinks), which is what Pressbase accepts.
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

const manifest = JSON.parse(await readFile('plugin.json', 'utf8'));
const main = manifest.main ?? 'index.js';
try {
  await lstat(main);
} catch {
  console.error(`${main} is missing: run the build first (npm run build).`);
  process.exit(1);
}

/** Files under `dir`, as forward-slash paths. Symbolic links are refused. */
async function walk(dir) {
  const info = await lstat(dir).catch(() => null);
  if (!info) return [];
  if (info.isSymbolicLink()) throw new Error(`${dir} is a symbolic link; Pressbase refuses those.`);
  if (info.isFile()) return [dir];
  const files = [];
  for (const entry of await readdir(dir)) {
    if (entry.startsWith('.')) continue;
    files.push(...(await walk(path.posix.join(dir, entry))));
  }
  return files;
}

// The entry's folder (dist/), or only the entry when it sits at the root.
const mainDir = path.posix.dirname(main);
const roots = ['plugin.json', 'README.md', mainDir === '.' ? main : mainDir, 'public'];
if (manifest.migrations) roots.push(manifest.migrations);
const files = [...new Set((await Promise.all(roots.map(walk))).flat())].sort();

const locals = [];
const centrals = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(`${manifest.name}/${file}`, 'utf8');
  const data = await readFile(file);
  const body = deflateRawSync(data);
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  locals.push(local, name, body);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);
  offset += local.length + name.length + body.length;
}
const directory = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);

const out = `${manifest.name}-${manifest.version}.zip`;
await writeFile(out, Buffer.concat([...locals, directory, end]));
console.log(`Packed ${files.length} files into ${out}.`);
