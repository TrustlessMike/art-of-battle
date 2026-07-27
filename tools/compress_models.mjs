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

/**
 * Reads the GLB's JSON chunk to see whether it is already compressed.
 *
 * Everything here is guarded: this runs over build output, and a truncated or
 * half-written .glb should be reported as one bad file, not crash the run with
 * a JSON parse error that dumps the whole chunk to the terminal.
 */
function alreadyCompressed(path) {
  try {
    const b = readFileSync(path);
    if (b.length < 20 || b.readUInt32LE(0) !== 0x46546c67) return false; // 'glTF'
    const len = b.readUInt32LE(12);
    if (b.readUInt32LE(16) !== 0x4e4f534a) return false;                 // 'JSON'
    if (b.length < 20 + len) return false;
    const json = JSON.parse(b.subarray(20, 20 + len).toString('utf8'));
    return (json.extensionsUsed ?? []).includes('EXT_meshopt_compression');
  } catch {
    return false;   // not readable as a compressed GLB; let the CLI report why
  }
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.glb')).sort();
let before = 0;
let after = 0;
const failed = [];

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
  //
  // One bad file must not abort the run — the files are processed in sorted
  // order, so an early failure would leave the directory half compressed with
  // no summary saying which half. And gltf-transform prints its diagnostics to
  // *stdout*, while Node only appends stderr to the thrown Error, so the reason
  // has to be dug back out of err.stdout or it is lost entirely.
  try {
    execFileSync(CLI, ['meshopt', path, path], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const why = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || err.message;
    console.error(`  ${f.padEnd(30)} FAILED — ${why.split('\n').filter(Boolean).pop()}`);
    failed.push(f);
    after += raw;
    continue;
  }
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

// Exit non-zero so `npm run assets` cannot report success over a directory that
// is only partly compressed — the game would still load, just heavier, which is
// exactly the kind of regression that goes unnoticed.
if (failed.length) {
  console.error(`\n  ${failed.length} file(s) failed: ${failed.join(', ')}`);
  process.exitCode = 1;
}
