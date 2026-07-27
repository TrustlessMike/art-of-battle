import * as THREE from 'three';
import {
  OBJECTIVE, PANEL_WIDTH, SURFACE, WALLS, WALL_HEIGHT, expandWall,
} from './layout.js';

/**
 * The compound at runtime: what still stands, what has been broken open, and
 * what has been barricaded shut.
 *
 * Collision and line of sight are computed from `src/layout.js`, never from the
 * art. The GLB is bound by node name where it exists and is purely cosmetic —
 * if a panel's art is missing the panel still blocks, and if the whole GLB is
 * missing the level is still fully playable with generated stand-in geometry.
 */

const _a = new THREE.Vector2();
const _b = new THREE.Vector2();
const _p = new THREE.Vector2();

export const BARRICADE = {
  plank: { hp: 70, blocksSight: true, name: 'Barricade' },
  reinforce: { hp: 320, blocksSight: true, name: 'Reinforcement' },
};

export class Compound {
  constructor(scene, art = null) {
    this.scene = scene;
    this.art = art;
    this.surfaces = [];      // everything that can block or break
    this.openings = new Map();
    this.group = new THREE.Group();
    this.group.name = 'CompoundRuntime';
    scene.add(this.group);

    this._build();
    if (art) this._bindArt(art);
    this._buildFallbackArt();

    this.objective = {
      ...OBJECTIVE,
      hp: OBJECTIVE.hp,
      maxHp: OBJECTIVE.hp,
      destroyed: false,
      pos: new THREE.Vector3(OBJECTIVE.x, 0, OBJECTIVE.z),
    };
  }

  _build() {
    for (const wall of WALLS) {
      const e = expandWall(wall);
      const surf = SURFACE[wall.surface];
      wall._expanded = e;

      e.spans.forEach((span, si) => {
        e.panels(span).forEach((panel, pi) => {
          const s = e.point(panel.from);
          const t = e.point(panel.to);
          this.surfaces.push({
            kind: 'panel',
            id: `Panel_${wall.id}_${si}_${pi}`,
            wallId: wall.id,
            surface: wall.surface,
            soft: surf.soft,
            hp: surf.hp, maxHp: surf.hp,
            broken: false,
            reinforced: false,
            thickness: surf.soft ? 0.16 : 0.32,
            x1: s.x, z1: s.z, x2: t.x, z2: t.z,
            yMin: 0, yMax: WALL_HEIGHT,
            node: null,
          });
        });
      });

      for (const o of e.openings) {
        const s = e.point(o.a);
        const t = e.point(o.b);
        const rec = {
          kind: 'opening',
          id: o.id,
          openingKind: o.kind,
          wallId: wall.id,
          x1: s.x, z1: s.z, x2: t.x, z2: t.z,
          cx: (s.x + t.x) / 2, cz: (s.z + t.z) / 2,
          thickness: 0.18,
          // Windows are gaps you vault; they block nothing at floor level
          // until someone boards them up.
          yMin: o.kind === 'window' ? 0.95 : 0,
          yMax: o.kind === 'window' ? 2.2 : WALL_HEIGHT,
          barricade: null,
          hp: 0, maxHp: 0, broken: false,
          node: null,
        };
        this.surfaces.push(rec);
        this.openings.set(o.id, rec);
      }
    }
  }

  _bindArt(art) {
    const byName = new Map();
    art.traverse((o) => { if (o.name) byName.set(o.name, o); });
    let bound = 0;
    for (const s of this.surfaces) {
      if (s.kind !== 'panel') continue;
      const node = byName.get(s.id);
      if (node) { s.node = node; bound++; }
    }
    this.boundPanels = bound;
    this.anchors = new Map();
    art.traverse((o) => {
      if (/^Anchor_/.test(o.name)) {
        const p = new THREE.Vector3();
        o.getWorldPosition(p);
        this.anchors.set(o.name.replace('Anchor_', ''), p);
      }
    });
  }

  /**
   * Stand-in geometry for anything the art does not cover. Keeps the level
   * playable and readable whether or not the compound GLB is present.
   */
  _buildFallbackArt() {
    const mats = {
      stone: new THREE.MeshStandardMaterial({ color: 0x6a6f78, roughness: 0.92 }),
      timber: new THREE.MeshStandardMaterial({ color: 0x5a4128, roughness: 0.85 }),
      palisade: new THREE.MeshStandardMaterial({ color: 0x4d3a24, roughness: 0.9 }),
    };
    this._mats = mats;
    this.barricadeMat = new THREE.MeshStandardMaterial({
      color: 0x6b4a26, roughness: 0.82,
    });
    this.reinforceMat = new THREE.MeshStandardMaterial({
      color: 0x585d66, metalness: 0.7, roughness: 0.5,
    });

    for (const s of this.surfaces) {
      if (s.kind !== 'panel' || s.node) continue;
      const mesh = this._slab(s, mats[s.surface]);
      s.node = mesh;
      s.node.userData.generated = true;
      this.group.add(mesh);
    }
  }

  _slab(s, material, height = null, yBase = 0) {
    const dx = s.x2 - s.x1;
    const dz = s.z2 - s.z1;
    const len = Math.hypot(dx, dz);
    const h = height ?? (s.yMax - s.yMin);
    const geo = new THREE.BoxGeometry(len, h, s.thickness);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set((s.x1 + s.x2) / 2, yBase + s.yMin + h / 2, (s.z1 + s.z2) / 2);
    mesh.rotation.y = -Math.atan2(dz, dx);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  // ------------------------------------------------------------- barricades

  canBarricade(openingId) {
    const o = this.openings.get(openingId);
    return !!o && !o.barricade;
  }

  barricade(openingId, type = 'plank') {
    const o = this.openings.get(openingId);
    if (!o || o.barricade) return false;
    const spec = BARRICADE[type];
    o.barricade = type;
    o.hp = spec.hp;
    o.maxHp = spec.hp;
    o.broken = false;
    // A boarded window blocks at floor level too.
    o.yMin = 0;
    o.yMax = WALL_HEIGHT;
    const mat = type === 'reinforce' ? this.reinforceMat : this.barricadeMat;
    const mesh = this._slab({ ...o, thickness: 0.14 }, mat,
      o.openingKind === 'window' ? 1.5 : WALL_HEIGHT - 0.1);
    mesh.position.y = o.openingKind === 'window' ? 1.5 : (WALL_HEIGHT - 0.1) / 2;
    o.node = mesh;
    this.group.add(mesh);
    return true;
  }

  /** Reinforce turns a soft panel into something only a charge will open. */
  reinforcePanel(surface) {
    if (surface.kind !== 'panel' || surface.reinforced || surface.broken) {
      return false;
    }
    surface.reinforced = true;
    surface.soft = false;
    surface.hp = SURFACE.stone.hp;
    surface.maxHp = SURFACE.stone.hp;
    if (surface.node) this._paint(surface.node, this.reinforceMat);
    return true;
  }

  /**
   * Repaint a panel. Art panels arrive from Blender as a Group of several
   * meshes (stone, mortar, trim), so assigning `.material` to the node itself
   * silently does nothing — which is why reinforced walls used to look
   * identical to soft ones. Traversing covers both shapes, since a lone Mesh
   * traverses itself.
   */
  _paint(node, mat) {
    node.traverse((o) => {
      if (!o.isMesh) return;
      if (o.userData.origMaterial === undefined) o.userData.origMaterial = o.material;
      o.material = mat;
    });
  }

  /** Put a panel's authored materials back. */
  _unpaint(node) {
    node.traverse((o) => {
      if (o.isMesh && o.userData.origMaterial !== undefined) {
        o.material = o.userData.origMaterial;
      }
    });
  }

  // ------------------------------------------------------------- destruction

  active(s) {
    if (s.kind === 'panel') return !s.broken;
    if (s.barricade) return !s.broken;
    return false;   // an unbarricaded opening blocks nothing
  }

  /** Anything solid between two points, for line of sight. */
  blocksSight(s) {
    if (s.kind === 'panel') return !s.broken;
    return !!s.barricade && !s.broken;
  }

  nearestSurface(x, z, maxDist = 1.6, filter = null) {
    let best = null, bestD = maxDist;
    for (const s of this.surfaces) {
      if (!this.active(s)) continue;
      if (filter && !filter(s)) continue;
      const d = this._distToSegment(x, z, s);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best ? { surface: best, dist: bestD } : null;
  }

  /**
   * Damage every surface within `radius` of a point. `power` decides what it
   * can hurt: a blade only opens soft partitions, a charge opens anything.
   */
  damageAt(x, z, radius, amount, { breach = false } = {}) {
    const hits = [];
    for (const s of this.surfaces) {
      if (!this.active(s)) continue;
      if (!breach && !s.soft && s.kind === 'panel') continue;
      if (this._distToSegment(x, z, s) > radius) continue;
      const dealt = breach ? amount : amount * (s.reinforced ? 0.15 : 1);
      s.hp -= dealt;
      if (s.hp <= 0) {
        this._break(s);
        hits.push({ surface: s, broken: true });
      } else {
        hits.push({ surface: s, broken: false });
      }
    }
    return hits;
  }

  _break(s) {
    s.broken = true;
    s.hp = 0;
    if (s.node) {
      s.node.visible = false;
    }
    if (s.kind === 'opening') {
      s.barricade = null;
      if (s.node) {
        this.group.remove(s.node);
        s.node.geometry?.dispose?.();
        s.node = null;
      }
    }
  }

  /** Centre point of a surface, for spawning debris. */
  centre(s, out = new THREE.Vector3()) {
    return out.set((s.x1 + s.x2) / 2,
      (s.yMin + Math.min(s.yMax, WALL_HEIGHT)) / 2,
      (s.z1 + s.z2) / 2);
  }

  // -------------------------------------------------------------- collision

  /**
   * Push a circle out of every standing surface. Returns true if it moved.
   * Iterated a couple of times so corners resolve cleanly.
   */
  collide(pos, radius) {
    let moved = false;
    for (let pass = 0; pass < 2; pass++) {
      for (const s of this.surfaces) {
        if (!this.active(s)) continue;
        if (s.kind === 'opening' && !s.barricade) continue;
        const half = s.thickness / 2;
        const need = radius + half;
        const c = this._closestPoint(pos.x, pos.z, s, _p);
        let dx = pos.x - c.x;
        let dz = pos.z - c.y;
        let d = Math.hypot(dx, dz);
        if (d >= need) continue;
        if (d < 1e-5) {
          // Dead centre on the segment: shove along its normal.
          const nx = -(s.z2 - s.z1);
          const nz = s.x2 - s.x1;
          const nl = Math.hypot(nx, nz) || 1;
          dx = nx / nl; dz = nz / nl; d = 1e-5;
        } else {
          dx /= d; dz /= d;
        }
        pos.x += dx * (need - d);
        pos.z += dz * (need - d);
        moved = true;
      }
    }
    return moved;
  }

  _closestPoint(px, pz, s, out) {
    const ax = s.x1, az = s.z1;
    const bx = s.x2, bz = s.z2;
    const abx = bx - ax, abz = bz - az;
    const len2 = abx * abx + abz * abz;
    let t = len2 > 1e-9 ? ((px - ax) * abx + (pz - az) * abz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return out.set(ax + abx * t, az + abz * t);
  }

  _distToSegment(px, pz, s) {
    this._closestPoint(px, pz, s, _p);
    return Math.hypot(px - _p.x, pz - _p.y);
  }

  // ------------------------------------------------------------------ sight

  /** True if anything solid stands between the two points. */
  losBlocked(ax, az, bx, bz) {
    for (const s of this.surfaces) {
      if (!this.blocksSight(s)) continue;
      if (segmentsCross(ax, az, bx, bz, s.x1, s.z1, s.x2, s.z2)) return true;
    }
    return false;
  }

  /** Cheap ray march for the raven / breach preview: first surface hit. */
  raycastSurface(ax, az, bx, bz) {
    let best = null, bestT = Infinity;
    for (const s of this.surfaces) {
      if (!this.active(s)) continue;
      const t = segmentCrossT(ax, az, bx, bz, s.x1, s.z1, s.x2, s.z2);
      if (t !== null && t < bestT) { bestT = t; best = s; }
    }
    return best ? { surface: best, t: bestT } : null;
  }

  damageObjective(amount) {
    const o = this.objective;
    if (o.destroyed) return false;
    o.hp = Math.max(0, o.hp - amount);
    if (o.hp <= 0) { o.destroyed = true; return true; }
    return false;
  }

  reset() {
    for (const s of this.surfaces) {
      if (s.kind === 'panel') {
        const surf = SURFACE[s.surface];
        s.broken = false;
        s.reinforced = false;
        s.soft = surf.soft;
        s.hp = surf.hp;
        s.maxHp = surf.hp;
        if (s.node) {
          s.node.visible = true;
          if (s.node.userData.origMaterial) {
            s.node.material = s.node.userData.origMaterial;
            delete s.node.userData.origMaterial;
          } else if (s.node.userData.generated) {
            s.node.material = this._mats[s.surface];
          }
        }
      } else {
        if (s.node) {
          this.group.remove(s.node);
          s.node.geometry?.dispose?.();
          s.node = null;
        }
        s.barricade = null;
        s.broken = false;
        s.hp = 0;
        s.yMin = s.openingKind === 'window' ? 0.95 : 0;
        s.yMax = s.openingKind === 'window' ? 2.2 : WALL_HEIGHT;
      }
    }
    this.objective.hp = this.objective.maxHp;
    this.objective.destroyed = false;
  }
}

// ------------------------------------------------------------------ geometry

function segmentCrossT(ax, az, bx, bz, cx, cz, dx, dz) {
  const r1 = bx - ax, r2 = bz - az;
  const s1 = dx - cx, s2 = dz - cz;
  const denom = r1 * s2 - r2 * s1;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((cx - ax) * s2 - (cz - az) * s1) / denom;
  const u = ((cx - ax) * r2 - (cz - az) * r1) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
}

function segmentsCross(ax, az, bx, bz, cx, cz, dx, dz) {
  return segmentCrossT(ax, az, bx, bz, cx, cz, dx, dz) !== null;
}
