import * as THREE from 'three';

/**
 * Baked ambient occlusion, written into vertex colours.
 *
 * A dusk scene lit by one cold key and a handful of braziers has almost no
 * contact darkening: walls meet floors in a clean seam and everything reads
 * flat. Screen-space AO would fix it, but the world pass draws the viewmodel
 * into the same target, so a fullscreen AO pass would darken the player's own
 * hands using world depth.
 *
 * The compound never moves, so the occlusion can be solved once at load and
 * folded into the vertex colours the batcher already attaches. Runtime cost is
 * then exactly zero.
 *
 * Occupancy is voxelised from the collision surfaces rather than the art, so
 * the AO agrees with the geometry the game actually simulates, and the whole
 * bake is a few million grid lookups instead of millions of ray/triangle tests.
 */

const CELL = 0.5;                 // metres per voxel

class Occupancy {
  constructor(surfaces, wallHeight) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const s of surfaces) {
      x0 = Math.min(x0, s.x1, s.x2); x1 = Math.max(x1, s.x1, s.x2);
      z0 = Math.min(z0, s.z1, s.z2); z1 = Math.max(z1, s.z1, s.z2);
    }
    const pad = 2;
    this.minX = x0 - pad; this.minZ = z0 - pad;
    this.nx = Math.ceil((x1 - x0 + pad * 2) / CELL);
    this.nz = Math.ceil((z1 - z0 + pad * 2) / CELL);
    this.ny = Math.ceil((wallHeight + 1) / CELL);
    this.grid = new Uint8Array(this.nx * this.ny * this.nz);

    for (const s of surfaces) this._stamp(s);
  }

  _idx(ix, iy, iz) { return (iy * this.nz + iz) * this.nx + ix; }

  /** Walk the slab's length and mark the cells it passes through. */
  _stamp(s) {
    const dx = s.x2 - s.x1, dz = s.z2 - s.z1;
    const len = Math.hypot(dx, dz);
    if (!len) return;
    const steps = Math.ceil(len / (CELL * 0.5));
    const th = Math.max(CELL, s.thickness ?? 0.3);
    const nxs = -dz / len, nzs = dx / len;      // slab normal
    const yMin = s.yMin ?? 0, yMax = s.yMax ?? 3.4;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = s.x1 + dx * t, pz = s.z1 + dz * t;
      for (let o = -1; o <= 1; o++) {           // spread across the thickness
        const ox = px + nxs * (o * th * 0.5);
        const oz = pz + nzs * (o * th * 0.5);
        const ix = Math.floor((ox - this.minX) / CELL);
        const iz = Math.floor((oz - this.minZ) / CELL);
        if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) continue;
        for (let iy = Math.floor(yMin / CELL); iy <= Math.min(this.ny - 1, Math.floor(yMax / CELL)); iy++) {
          this.grid[this._idx(ix, iy, iz)] = 1;
        }
      }
    }
  }

  solid(x, y, z) {
    if (y < 0) return true;                     // the ground occludes too
    const ix = Math.floor((x - this.minX) / CELL);
    const iz = Math.floor((z - this.minZ) / CELL);
    const iy = Math.floor(y / CELL);
    if (ix < 0 || iz < 0 || iy < 0 || ix >= this.nx || iz >= this.nz || iy >= this.ny) return false;
    return this.grid[this._idx(ix, iy, iz)] === 1;
  }
}

// A fixed hemisphere of directions, reused for every vertex.
function hemisphere(n) {
  const dirs = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 0.85;         // bias away from the surface
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = golden * i;
    dirs.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
  }
  return dirs;
}

const DIRS = hemisphere(10);
const RADII = [0.35, 0.8, 1.5];
const WEIGHTS = [3, 1.6, 0.7];    // near occluders dominate the shading

/**
 * Vertex AO can only be as detailed as the mesh it is written into.
 *
 * Most of the compound is fine — walls, trim and props carry plenty of
 * vertices. The floors are the exception: a few very large quads whose only
 * vertices are the corners, all of which sit against a wall. Shading those
 * corners drags the whole surface dark by interpolation, which is exactly what
 * happened the first time this ran.
 *
 * Subdividing them is not the answer either — recursive tessellation of a 40m
 * quad multiplies without bound, and after merging there is no way to subdivide
 * one surface without subdividing everything sharing its material. So coarse
 * geometry is simply left alone: it keeps its authored look, and AO is spent
 * where there are vertices to carry it.
 */
function tooCoarseForAO(geo) {
  const pos = geo.attributes.position;
  if (!pos || pos.count < 12) return true;
  geo.computeBoundingBox();
  const s = new THREE.Vector3();
  geo.boundingBox.getSize(s);
  // Surface area of the bounding box is a good enough proxy for the real area.
  const area = 2 * (s.x * s.y + s.y * s.z + s.z * s.x);
  return area / pos.count > COARSE_AREA_PER_VERTEX;
}

const COARSE_AREA_PER_VERTEX = 0.6;   // m² of surface per vertex

// Triangle area at which a vertex still carries AO fully, and the area beyond
// which it carries none. A 0.2m² triangle is small enough that shading its
// corner reads as a corner; a 2m² one spans a whole flagstone bay.
const DETAIL_FULL = 0.2;
const DETAIL_NONE = 2.0;

/**
 * Per-vertex confidence that AO will read as shading rather than as a flat
 * wash, derived from the size of the triangles each vertex belongs to.
 */
function vertexDetail(geo) {
  const pos = geo.attributes.position;
  const idx = geo.index;
  const n = pos.count;
  const area = new Float32Array(n);
  const share = new Float32Array(n);
  const triCount = idx ? idx.count / 3 : n / 3;

  const ax = new THREE.Vector3(), bx = new THREE.Vector3(), cx = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    ax.fromBufferAttribute(pos, i0);
    bx.fromBufferAttribute(pos, i1);
    cx.fromBufferAttribute(pos, i2);
    const a = e1.subVectors(bx, ax).cross(e2.subVectors(cx, ax)).length() * 0.5;
    area[i0] += a; area[i1] += a; area[i2] += a;
    share[i0]++; share[i1]++; share[i2]++;
  }

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const avg = share[i] ? area[i] / share[i] : DETAIL_NONE;
    const t = (avg - DETAIL_FULL) / (DETAIL_NONE - DETAIL_FULL);
    out[i] = Math.min(1, Math.max(0, 1 - t));
  }
  return out;
}

/**
 * @param {THREE.Object3D} root      art to bake into (needs vertex colours)
 * @param {Array} surfaces           collision slabs to voxelise
 * @param {object} [opt]
 * @param {number} [opt.strength=0.72]  how dark a fully occluded vertex goes
 * @param {number} [opt.wallHeight=3.4]
 */
export function bakeVertexAO(root, surfaces, opt = {}) {
  const strength = opt.strength ?? 0.55;
  const occ = new Occupancy(surfaces, opt.wallHeight ?? 3.4);
  const t0 = performance.now();

  const _p = new THREE.Vector3();
  const _n = new THREE.Vector3();
  const _t = new THREE.Vector3();
  const _b = new THREE.Vector3();
  const _s = new THREE.Vector3();
  let vertices = 0, meshes = 0, skipped = 0;

  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    const col = g.attributes.color;
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    if (!col || !pos || !nor) return;           // nothing to modulate
    if (tooCoarseForAO(g)) { skipped++; return; }
    meshes++;

    // How much detail can each vertex actually hold? A vertex shared by big
    // triangles spreads its shading across metres of surface, so darkening it
    // darkens the whole floor. Merging hides this at mesh level — the batch
    // that holds the 40m ground quads also holds fine trim — so it has to be
    // measured per vertex.
    const detail = vertexDetail(g);

    for (let i = 0; i < pos.count; i++) {
      _p.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      _n.fromBufferAttribute(nor, i).transformDirection(o.matrixWorld).normalize();

      // Build a frame so the sample hemisphere follows the surface normal.
      _t.set(_n.z, 0, -_n.x);
      if (_t.lengthSq() < 1e-6) _t.set(1, 0, 0);
      _t.normalize();
      _b.crossVectors(_n, _t);

      let hits = 0, total = 0;
      for (const d of DIRS) {
        // d is in tangent space: y along the normal.
        _s.set(
          _t.x * d.x + _n.x * d.y + _b.x * d.z,
          _t.y * d.x + _n.y * d.y + _b.y * d.z,
          _t.z * d.x + _n.z * d.y + _b.z * d.z,
        );
        for (let ri = 0; ri < RADII.length; ri++) {
          const r = RADII[ri];
          // Something touching the surface shades it far more than something a
          // metre and a half away, so near samples carry more weight.
          const w = WEIGHTS[ri];
          total += w;
          // Step off the surface first so a wall never occludes itself.
          if (occ.solid(_p.x + _s.x * r + _n.x * 0.12,
                        _p.y + _s.y * r + _n.y * 0.12,
                        _p.z + _s.z * r + _n.z * 0.12)) {
            hits += w;
          }
        }
      }
      const ao = total ? hits / total : 0;
      // Never let a vertex go fully black; unlit corners should read as deep
      // shadow, not as a hole in the geometry.
      const amt = strength * detail[i];
      const k = Math.max(1 - amt, 1 - ao * amt);
      col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
      vertices++;
    }
    col.needsUpdate = true;
  });

  return { meshes, skipped, vertices, ms: +(performance.now() - t0).toFixed(0) };
}
