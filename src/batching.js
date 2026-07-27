import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { classify, detailMaterial } from './materials.js';

/**
 * Static draw-call batching.
 *
 * The compound arrives from Blender as one mesh per architectural piece — 612
 * of them sharing 25 materials. That is 612 draw calls, doubled by the shadow
 * pass, to push about 47k triangles: work the GPU finishes in around a
 * millisecond while the CPU spends seven just submitting it. Merging every
 * mesh that shares a material collapses the submission cost without changing a
 * single pixel.
 *
 * What must NOT be merged is anything the game mutates at runtime. Destructible
 * panels are swapped, hidden and re-materialised as the building comes apart,
 * and a merged panel has no independent existence to swap. Those are passed in
 * via `exclude` and left exactly as they are.
 */

/**
 * Geometries can only merge when their attribute sets match exactly, so the
 * signature is part of the grouping key rather than a thing to fail on.
 */
function signature(geo) {
  return Object.keys(geo.attributes).sort().join(',') + (geo.index ? '|i' : '');
}

/**
 * @param {THREE.Object3D} root      subtree to batch
 * @param {Set<THREE.Object3D>} exclude  nodes to leave alone, with their subtrees
 * @returns {{group: THREE.Group, before: number, after: number, merged: number}}
 */
export function batchStatic(root, exclude = new Set()) {
  root.updateMatrixWorld(true);

  // A node is excluded if it or any ancestor was named. Walking up per mesh is
  // cheaper than materialising the full excluded subtree.
  const isExcluded = (o) => {
    for (let n = o; n; n = n.parent) if (exclude.has(n)) return true;
    return false;
  };

  const buckets = new Map();   // key -> { material, meshes[] }
  let before = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    before++;
    if (isExcluded(o)) return;
    // Multi-material meshes index into an array per group; not worth splitting.
    if (Array.isArray(o.material)) return;
    const key = `${o.material.uuid}|${signature(o.geometry)}|` +
      `${o.castShadow ? 1 : 0}${o.receiveShadow ? 1 : 0}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { material: o.material, meshes: [] }));
    b.meshes.push(o);
  });

  const group = new THREE.Group();
  group.name = 'StaticBatch';
  let merged = 0;

  for (const { material, meshes } of buckets.values()) {
    if (meshes.length < 2) continue;         // nothing to gain
    const geos = meshes.map((m) => {
      const g = m.geometry.clone();
      g.applyMatrix4(m.matrixWorld);         // bake into world space
      // Merging is per-attribute; anything not shared has already been keyed out.
      return g;
    });
    let batchGeo;
    try {
      batchGeo = mergeGeometries(geos, false);
    } catch {
      batchGeo = null;
    }
    geos.forEach((g) => g.dispose());
    if (!batchGeo) continue;                 // leave this bucket untouched

    const mesh = new THREE.Mesh(batchGeo, material);
    mesh.castShadow = meshes[0].castShadow;
    mesh.receiveShadow = meshes[0].receiveShadow;
    // The batch is world-space already, so its own transform must stay identity.
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
    merged++;

    for (const m of meshes) {
      m.parent?.remove(m);
      m.geometry.dispose();
    }
  }

  // Whatever survives is static too — it just had no partner to merge with.
  root.traverse((o) => {
    if (o.isMesh && !isExcluded(o)) {
      o.matrixAutoUpdate = false;
      o.updateMatrix();
    }
  });

  let after = 0;
  root.traverse((o) => { if (o.isMesh) after++; });
  group.traverse((o) => { if (o.isMesh) after++; });
  return { group, before, after, merged };
}

/**
 * Fold flat-colour materials into shared ones carrying vertex colours.
 *
 * The compound uses 25 materials that differ only in colour — M_Stone,
 * M_StoneCool, M_StoneTrim, M_Mortar and so on. Distinct materials can never
 * share a draw call, which is why the panels could not collapse: each of the
 * three or four meshes in a panel had a material all to itself.
 *
 * Baking each material's colour into a vertex-colour attribute lets every mesh
 * with the same *surface response* (roughness, metalness, shading) share one
 * material, and merging becomes possible. The pixels are unchanged: vertex
 * colours multiply against `material.color`, so the shared material is white
 * and the colour simply moves from the uniform into the attribute.
 *
 * Anything with a texture, emission or transparency is left alone — those carry
 * information a flat vertex colour cannot.
 */
export function foldMaterials(root) {
  const shared = new Map();
  let folded = 0, families = 0;

  // Materials carrying projected surface detail (see materials.js) can still
  // fold, but only into their own surface family: stone and timber may share a
  // roughness and are still not interchangeable once each carries a different
  // projected pattern. Family is therefore part of the key, the folded name
  // keeps the substring `classify` matches on, and the hook is re-injected
  // afterwards because `clone()` drops `onBeforeCompile`.
  const foldable = (m) => m && m.isMeshStandardMaterial && !m.map && !m.normalMap &&
    !m.emissiveMap && !m.transparent && m.opacity === 1 &&
    (!m.emissive || m.emissive.getHex() === 0x000000);

  root.traverse((o) => {
    if (!o.isMesh || !o.geometry || Array.isArray(o.material)) return;
    const m = o.material;
    if (!foldable(m)) return;

    // Group by how the surface responds to light, not by its colour — and
    // quantise, because the authored variants sit a few hundredths apart
    // (0.85 vs 0.92 roughness on stone) which is invisible but would otherwise
    // put every one of them in a family of its own.
    const q = (v, step) => (Math.round(v / step) * step).toFixed(2);
    const family = classify(m.name) || 'plain';
    const key = `${family}|${q(m.roughness, 0.15)}|${q(m.metalness, 0.34)}|` +
      `${m.flatShading ? 1 : 0}|${m.side}`;
    let mat = shared.get(key);
    if (!mat) {
      mat = m.clone();
      mat.color.setRGB(1, 1, 1);      // colour now lives in the attribute
      mat.vertexColors = true;
      // Take the bucket's centre rather than whichever member happened to be
      // first, so the shared look does not depend on traversal order.
      mat.roughness = parseFloat(q(m.roughness, 0.15));
      mat.metalness = parseFloat(q(m.metalness, 0.34));
      // Keep the original name in front so `classify` still resolves the same
      // family, then re-inject the detail hook the clone lost.
      mat.name = `${m.name}_folded`;
      mat.userData = { ...m.userData };
      delete mat.userData.detailed;
      detailMaterial(mat);
      shared.set(key, mat);
      families++;
    }

    const geo = o.geometry;
    const count = geo.attributes.position.count;
    // A geometry shared between meshes of different colours must not be
    // written through — clone before attaching per-mesh colour.
    if (geo.userData._foldedFor !== undefined && geo.userData._foldedFor !== m.uuid) {
      o.geometry = geo.clone();
    }
    const g = o.geometry;
    const arr = new Float32Array(count * 3);
    const { r, b, g: gg } = m.color;
    for (let i = 0; i < count; i++) { arr[i * 3] = r; arr[i * 3 + 1] = gg; arr[i * 3 + 2] = b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    g.userData._foldedFor = m.uuid;
    o.material = mat;
    folded++;
  });
  return { folded, families };
}

/**
 * Collapse the meshes *inside* each node, leaving the node itself intact.
 *
 * The destructible panels could not take part in the batch above because the
 * game hides, removes and repaints them individually. But destruction operates
 * on a whole panel — never on the stone course within it — so a panel is free
 * to be one mesh per material instead of the three or four Blender emits. The
 * node keeps its identity, so `surface.node` and every behaviour hanging off it
 * still works.
 *
 * Merging happens in the node's own local space, so the panel's transform stays
 * meaningful and the geometry does not jump to the world origin.
 */
export function batchWithinNodes(nodes) {
  const _inv = new THREE.Matrix4();
  const _rel = new THREE.Matrix4();
  let before = 0, after = 0, collapsed = 0;

  for (const node of nodes) {
    node.updateMatrixWorld(true);
    const meshes = [];
    node.traverse((o) => { if (o.isMesh && o.geometry && !Array.isArray(o.material)) meshes.push(o); });
    before += meshes.length;
    if (meshes.length < 2) { after += meshes.length; continue; }

    _inv.copy(node.matrixWorld).invert();
    const buckets = new Map();
    for (const m of meshes) {
      const key = `${m.material.uuid}|${signature(m.geometry)}|` +
        `${m.castShadow ? 1 : 0}${m.receiveShadow ? 1 : 0}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { material: m.material, meshes: [] }));
      b.meshes.push(m);
    }
    // Nothing to gain if every mesh already has its own material.
    if (buckets.size === meshes.length) { after += meshes.length; continue; }

    let ok = true;
    const built = [];
    for (const { material, meshes: ms } of buckets.values()) {
      if (ms.length < 2) { built.push(null); continue; }
      const geos = ms.map((m) => {
        const g = m.geometry.clone();
        _rel.multiplyMatrices(_inv, m.matrixWorld);
        g.applyMatrix4(_rel);
        return g;
      });
      let geo = null;
      try { geo = mergeGeometries(geos, false); } catch { geo = null; }
      geos.forEach((g) => g.dispose());
      if (!geo) { ok = false; break; }
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = ms[0].castShadow;
      mesh.receiveShadow = ms[0].receiveShadow;
      built.push({ mesh, replaced: ms });
    }
    if (!ok) {                       // leave this node exactly as it was
      built.forEach((b) => b?.mesh.geometry.dispose());
      after += meshes.length;
      continue;
    }

    for (const b of built) {
      if (!b) continue;
      for (const m of b.replaced) { m.parent?.remove(m); m.geometry.dispose(); }
      node.add(b.mesh);
      collapsed++;
    }
    let n = 0;
    node.traverse((o) => { if (o.isMesh) n++; });
    after += n;
  }
  return { before, after, collapsed };
}
