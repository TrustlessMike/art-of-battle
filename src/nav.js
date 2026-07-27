import { NAV_ROOMS, ROOMS, navRoomAt } from './layout.js';

/**
 * Navigation.
 *
 * Rooms are convex rectangles and walls only ever lie on their boundaries, so
 * a straight line inside a room is always safe. That reduces pathfinding to a
 * tiny graph: room centres joined through the openings between them.
 *
 * Breaking a wall panel adds an edge. Barricading an opening removes one. The
 * AI therefore re-routes through the holes you make, and around the ones you
 * board up, without any of it being special-cased.
 */

const OUTSIDE = 'outside';
const RING_INSET = 3.2;

export class Nav {
  constructor(compound) {
    this.compound = compound;
    this.nodes = new Map();          // id -> { id, x, z, kind }
    this.edges = new Map();          // id -> Set(id)
    this._build();
  }

  _add(id, x, z, kind) {
    this.nodes.set(id, { id, x, z, kind });
    if (!this.edges.has(id)) this.edges.set(id, new Set());
    return id;
  }

  _link(a, b) {
    if (a === b || !this.nodes.has(a) || !this.nodes.has(b)) return;
    this.edges.get(a).add(b);
    this.edges.get(b).add(a);
  }

  _build() {
    for (const r of NAV_ROOMS) {
      this._add(`room:${r.id}`, (r.x1 + r.x2) / 2, (r.z1 + r.z2) / 2, 'room');
    }

    // A ring of nodes around the outside so approaches are navigable.
    const b = bounds();
    const ring = [
      [b.x1 - RING_INSET, b.z1 - RING_INSET], [0, b.z1 - RING_INSET],
      [b.x2 + RING_INSET, b.z1 - RING_INSET], [b.x2 + RING_INSET, 0],
      [b.x2 + RING_INSET, b.z2 + RING_INSET], [0, b.z2 + RING_INSET],
      [b.x1 - RING_INSET, b.z2 + RING_INSET], [b.x1 - RING_INSET, 0],
    ];
    this.ring = ring.map(([x, z], i) => this._add(`out:${i}`, x, z, 'outside'));
    for (let i = 0; i < this.ring.length; i++) {
      this._link(this.ring[i], this.ring[(i + 1) % this.ring.length]);
    }

    // Openings and panels are portals between whatever is on either side.
    for (const s of this.compound.surfaces) {
      const id = s.kind === 'opening' ? `open:${s.id}` : `gap:${s.id}`;
      const cx = (s.x1 + s.x2) / 2;
      const cz = (s.z1 + s.z2) / 2;
      this._add(id, cx, cz, s.kind === 'opening' ? 'opening' : 'gap');
      s._navId = id;

      const [ax, az, bx, bz] = sidePoints(s);
      const sideA = this._sideNode(ax, az);
      const sideB = this._sideNode(bx, bz);
      s._navSides = [sideA, sideB];
      // Panels start solid — their edges are only linked once broken.
      if (s.kind === 'opening') {
        this._link(id, sideA);
        this._link(id, sideB);
      }
    }
  }

  _sideNode(x, z) {
    const r = navRoomAt(x, z);
    if (r) return `room:${r.id}`;
    // Outside: attach to the nearest ring node.
    let best = this.ring[0], bd = Infinity;
    for (const id of this.ring) {
      const n = this.nodes.get(id);
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }

  /** Recompute which portals are currently passable. */
  refresh() {
    for (const s of this.compound.surfaces) {
      if (!s._navId) continue;
      const [a, b] = s._navSides;
      const open = s.kind === 'opening'
        ? (!s.barricade || s.broken)
        : s.broken;
      if (open) {
        this._link(s._navId, a);
        this._link(s._navId, b);
      } else {
        this.edges.get(s._navId)?.delete(a);
        this.edges.get(s._navId)?.delete(b);
        this.edges.get(a)?.delete(s._navId);
        this.edges.get(b)?.delete(s._navId);
      }
    }
  }

  _nodeAt(x, z) {
    const r = navRoomAt(x, z);
    if (r) return `room:${r.id}`;
    return this._sideNode(x, z);
  }

  /**
   * When there is no route, the next best thing: the reachable node that gets
   * you closest to where you wanted to go. Walking there first means a breach
   * gets spent on the wall that is actually in the way, rather than on
   * whichever wall happened to be nearest when the route failed.
   */
  closestReachable(fromX, fromZ, toX, toZ) {
    this.refresh();
    const start = this._nodeAt(fromX, fromZ);
    const seen = new Set([start]);
    const queue = [start];
    let best = null, bestD = Infinity;
    while (queue.length) {
      const cur = queue.shift();
      const n = this.nodes.get(cur);
      const d = (n.x - toX) ** 2 + (n.z - toZ) ** 2;
      if (d < bestD) { bestD = d; best = n; }
      for (const nxt of this.edges.get(cur) || []) {
        if (seen.has(nxt)) continue;
        seen.add(nxt);
        queue.push(nxt);
      }
    }
    return best;
  }

  /**
   * Waypoints from one world position to another. Returns [] when already in
   * the destination area, or null when no route exists (fully barricaded in).
   */
  path(fromX, fromZ, toX, toZ) {
    this.refresh();
    const start = this._nodeAt(fromX, fromZ);
    const goal = this._nodeAt(toX, toZ);
    if (start === goal) return [];

    const prev = new Map([[start, null]]);
    const queue = [start];
    let found = false;
    while (queue.length) {
      const cur = queue.shift();
      if (cur === goal) { found = true; break; }
      for (const nxt of this.edges.get(cur) || []) {
        if (prev.has(nxt)) continue;
        prev.set(nxt, cur);
        queue.push(nxt);
      }
    }
    if (!found) return null;

    const out = [];
    let cur = goal;
    while (cur) {
      const n = this.nodes.get(cur);
      out.unshift({ x: n.x, z: n.z, kind: n.kind, id: n.id });
      cur = prev.get(cur);
    }
    out.shift();               // drop the node we are standing in
    return out;
  }
}

function bounds() {
  let x1 = Infinity, z1 = Infinity, x2 = -Infinity, z2 = -Infinity;
  for (const r of ROOMS) {
    x1 = Math.min(x1, r.x1); z1 = Math.min(z1, r.z1);
    x2 = Math.max(x2, r.x2); z2 = Math.max(z2, r.z2);
  }
  return { x1, z1, x2, z2 };
}

/** Two probe points either side of a surface, used to find what it joins. */
function sidePoints(s, off = 1.0) {
  const dx = s.x2 - s.x1;
  const dz = s.z2 - s.z1;
  const len = Math.hypot(dx, dz) || 1;
  const nx = -dz / len;
  const nz = dx / len;
  const cx = (s.x1 + s.x2) / 2;
  const cz = (s.z1 + s.z2) / 2;
  return [cx + nx * off, cz + nz * off, cx - nx * off, cz - nz * off];
}

export { OUTSIDE };
