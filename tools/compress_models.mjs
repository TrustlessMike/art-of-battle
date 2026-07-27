/**
 * Compresses every exported .glb with EXT_meshopt_compression.
 *
 * The Blender scripts write plain glTF, which is enormously redundant — the
 * compound alone is 2.6MB of mostly repeating float patterns. Cloudflare will
 * not gzip `model/gltf-binary` either, so that size is exactly what every
 * player downloads. Meshopt takes roughly 70% off and three decodes it with a
 * decoder it already ships, so nothing extra is fetched at runtime.
 *
 * This runs as the last step of `npm run assets`, after Blender regenerates the
 * raw files. Already-compressed files are skipped so re-running is harmless
 * rather than quietly re-quantising the same geometry a second time.
 *
 * It deliberately does NOT reorganise the scene graph. The game hard-codes the
 * joint names and offsets in ASSET_CONTRACT.md, so anything that renames, joins
 * or reparents nodes would break the rig. Meshopt only touches vertex data: it
 * recentres mesh geometry and compensates on the mesh node's own translation,
 * leaving the joint Empties — the things the game actually drives — untouched.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'public/models';
const CLI = 'node_modules/.bin/gltf-transform';

/** Reads the GLB's JSON chunk to see whether it is already compressed. */
function alreadyCompressed(path) {
  const b = readFileSync(path);
  if (b.length < 20 || b.readUInt32LE(0) !== 0x46546c67) return false; // 'glTF'
  const len = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + len).toString('utf8'));
  return (json.extensionsUsed ?? []).includes('EXT_meshopt_compression');
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.glb')).sort();
let before = 0;
let after = 0;

for (const f of files) {
  const path = join(DIR, f);
  const raw = statSync(path).size;
  before += raw;

  if (alreadyCompressed(path)) {
    after += raw;
    console.log(`  ${f.padEnd(30)} already compressed, skipped`);
    continue;
  }

  // Output over the input: the raw file is a build product of the Blender
  // scripts and can always be regenerated.
  execFileSync(CLI, ['meshopt', path, path], { stdio: 'pipe' });
  const now = statSync(path).size;
  after += now;
  const cut = ((1 - now / raw) * 100).toFixed(0);
  console.log(
    `  ${f.padEnd(30)} ${(raw / 1024).toFixed(0).padStart(6)}KB -> ` +
      `${(now / 1024).toFixed(0).padStart(6)}KB  (-${cut}%)`,
  );
}

const mb = (n) => (n / 1048576).toFixed(2);
console.log(
  `\n  total ${mb(before)}MB -> ${mb(after)}MB ` +
    `(-${((1 - after / before) * 100).toFixed(0)}%)`,
);
