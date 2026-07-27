/**
 * Dump the authoritative compound layout to JSON for the Blender build script.
 *   node tools/export_layout.mjs
 * Run this whenever src/layout.js changes, then rebuild the compound art.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toJSON, expandWall, WALLS } from '../src/layout.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'compound_layout.json');

// Pre-expand walls into spans/panels so the Blender side does no geometry
// reasoning of its own — it just builds exactly what gameplay uses.
const data = toJSON();
data.expanded = WALLS.map((w) => {
  const e = expandWall(w);
  return {
    id: w.id,
    surface: w.surface,
    ux: e.ux, uz: e.uz, len: e.len,
    x1: w.x1, z1: w.z1, x2: w.x2, z2: w.z2,
    openings: e.openings.map((o) => ({
      id: o.id, kind: o.kind, at: o.at, width: o.width,
      a: o.a, b: o.b,
      start: e.point(o.a), end: e.point(o.b),
    })),
    spans: e.spans.map((s) => ({
      from: s.from, to: s.to,
      start: e.point(s.from), end: e.point(s.to),
      panels: e.panels(s).map((p) => ({
        from: p.from, to: p.to,
        start: e.point(p.from), end: e.point(p.to),
        centre: e.point(p.mid),
      })),
    })),
  };
});

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(data, null, 1));
console.log(`wrote ${out}`);
console.log(`walls: ${data.expanded.length}, panels: ${
  data.expanded.reduce((n, w) => n + w.spans.reduce((m, s) => m + s.panels.length, 0), 0)}`);
