import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'export', 'web');
const destination = path.join(root, '.work', 'cloudflare-pages');

const omittedRootFiles = new Set([
  'hijacked.gltf',
  'hijacked.bin',
  'hijacked_geometry.glb',
  'hijacked_collision.gltf',
  'hijacked_collision.bin',
  'hijacked_collision_source.json',
]);
const keptLooseTextures = new Set(['mp_hijacked_lut.png']);

function include(candidate) {
  const relative = path.relative(source, candidate);
  if (!relative) return true;
  const segments = relative.split(path.sep);
  if (segments.length === 1 && omittedRootFiles.has(segments[0])) return false;
  if (
    segments.length === 2
    && segments[0] === 'textures'
    && segments[1].endsWith('.png')
    && !keptLooseTextures.has(segments[1])
  ) return false;
  return true;
}

for (const required of [
  'hijacked_optimized.glb',
  'hijacked_collision_bvh.bin',
  'hijacked_collision_bvh.json',
  'hijacked.navmesh.bin',
  path.join('textures', 'env'),
  path.join('textures', 'probe'),
  path.join('textures', 'mp_hijacked_lut.png'),
]) {
  await stat(path.join(source, required));
}

await mkdir(path.dirname(destination), { recursive: true });
await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true, filter: include });
console.log(`Staged Cloudflare Pages assets in ${path.relative(root, destination)}`);
