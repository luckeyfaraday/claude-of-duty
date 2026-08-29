import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'export', 'web', 'hijacked.gltf');
const intermediate = path.join(root, 'export', 'web', 'hijacked_geometry.glb');
const output = path.join(root, 'export', 'web', 'hijacked_optimized.glb');

function run(args) {
  return new Promise((resolve, reject) => {
    const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawn(executable, ['--yes', '@gltf-transform/cli@4.4.2', ...args], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`glTF Transform exited with status ${code}`));
    });
  });
}

try {
  await run([
    'optimize', source, intermediate,
    '--compress', 'meshopt',
    '--flatten', 'false',
    '--join', 'false',
    '--instance', 'true',
    '--instance-min', '3',
    '--palette', 'false',
    '--simplify', 'false',
    '--texture-compress', 'false',
  ]);
  await run([
    'uastc', intermediate, output,
    '--level', '2',
    '--rdo',
    '--rdo-lambda', '0.75',
    '--zstd', '10',
    '--jobs', '8',
  ]);
} finally {
  await rm(intermediate, { force: true });
}
