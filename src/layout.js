/**
 * The compound — single source of truth for level geometry.
 *
 * Gameplay (collision, line of sight, destruction, navigation) reads this
 * directly, and `tools/export_layout.mjs` dumps it to JSON so the Blender
 * script builds art from the *same* numbers. Nothing can drift out of sync.
 *
 * Coordinates: metres, X east, Z north, Y up. Floor at y = 0.
 */

export const WALL_HEIGHT = 3.4;
export const DOOR_WIDTH = 1.7;
export const WINDOW_WIDTH = 1.5;
export const PANEL_WIDTH = 1.0;

/**
 * Wall materials.
 *  stone  — indestructible by blades; only a breach charge opens it.
 *  timber — a soft partition; heavy attacks and charges break panels out.
 *  palisade — soft outer fencing.
 */
export const SURFACE = {
  stone: { soft: false, hp: 260, name: 'stone' },
  timber: { soft: true, hp: 100, name: 'timber' },
  palisade: { soft: true, hp: 70, name: 'palisade' },
};

/**
 * Walls are line segments with openings cut out of them. An opening is a
 * doorway or window and is described by its centre distance along the segment.
 */
const W = (id, x1, z1, x2, z2, surface, openings = [], opts = {}) => ({
  id, x1, z1, x2, z2, surface, openings, ...opts,
});

const door = (at, id) => ({ kind: 'door', at, width: DOOR_WIDTH, id });
const window_ = (at, id) => ({ kind: 'window', at, width: WINDOW_WIDTH, id });

// Footprint: x -13..13, z -10..10. Interior split into five rooms.
export const WALLS = [
  // ---- exterior curtain ------------------------------------------------
  W('ext_s', -13, -10, 13, -10, 'stone',
    [door(7.0, 'gate_main'), window_(17.5, 'win_s1')]),
  W('ext_n', -13, 10, 13, 10, 'stone',
    [window_(6.0, 'win_n1'), window_(19.0, 'win_n2')]),
  W('ext_w', -13, -10, -13, 10, 'stone',
    [window_(6.0, 'win_w1'), window_(14.0, 'win_w2')]),
  W('ext_e', 13, -10, 13, 10, 'stone',
    [door(6.0, 'gate_postern'), window_(15.0, 'win_e1')]),

  // ---- interior spine --------------------------------------------------
  // Central hall runs east-west between z = -2 and z = 2.
  W('hall_s', -13, -2, 13, -2, 'timber',
    [door(4.0, 'd_barracks'), door(17.0, 'd_stores')]),
  W('hall_n', -13, 2, 13, 2, 'stone',
    [door(5.0, 'd_armoury'), door(18.0, 'd_chapel')]),

  // North rooms split: armoury (west) | chapel (east, the objective)
  W('north_split', 1, 2, 1, 10, 'timber', [door(4.0, 'd_north_link')]),
  // South rooms split: barracks (west) | stores (east)
  W('south_split', -1, -10, -1, -2, 'timber', []),

  // A reinforceable partition shielding the objective. It has to span the full
  // width of the chapel — a screen you can simply walk around the end of makes
  // reinforcing it pointless.
  W('chapel_screen', 1, 6, 13, 6, 'timber', [door(4.0, 'd_screen')]),
];

export const ROOMS = [
  { id: 'barracks', name: 'Barracks', x1: -13, z1: -10, x2: -1, z2: -2 },
  { id: 'stores', name: 'Stores', x1: -1, z1: -10, x2: 13, z2: -2 },
  { id: 'hall', name: 'Central Hall', x1: -13, z1: -2, x2: 13, z2: 2 },
  { id: 'armoury', name: 'Armoury', x1: -13, z1: 2, x2: 1, z2: 10 },
  { id: 'chapel', name: 'Chapel', x1: 1, z1: 2, x2: 13, z2: 10 },
];

/** The banner the attacker must destroy and the defender must hold. */
export const OBJECTIVE = {
  id: 'banner',
  x: 9.0, z: 8.2,
  room: 'chapel',
  radius: 1.1,
  hp: 100,
};

export const SPAWNS = {
  attacker: [
    { x: 0, z: -16, yaw: 0 },
    { x: 18, z: -6, yaw: -Math.PI / 2 },
    { x: -17, z: 4, yaw: Math.PI / 2 },
  ],
  defender: [
    { x: 6.0, z: 4.0, yaw: 0 },
    { x: -6.0, z: 6.0, yaw: 0 },
  ],
};

/** Where the defender is allowed to place fortifications, roughly. */
export const OUTER_RADIUS = 26;

// ---------------------------------------------------------------- expansion

/**
 * Expand a wall into solid spans (the bits that actually exist) and the
 * openings between them. Openings are returned separately because doors and
 * windows can be barricaded, which turns them back into breakable surfaces.
 */
export function expandWall(wall) {
  const dx = wall.x2 - wall.x1;
  const dz = wall.z2 - wall.z1;
  const len = Math.hypot(dx, dz);
  const ux = dx / len;
  const uz = dz / len;

  const cuts = [...wall.openings]
    .map((o) => ({ ...o, a: o.at - o.width / 2, b: o.at + o.width / 2 }))
    .sort((p, q) => p.a - q.a);

  const spans = [];
  let cursor = 0;
  for (const c of cuts) {
    const a = Math.max(0, Math.min(len, c.a));
    const b = Math.max(0, Math.min(len, c.b));
    if (a > cursor + 1e-3) spans.push({ from: cursor, to: a });
    cursor = Math.max(cursor, b);
  }
  if (cursor < len - 1e-3) spans.push({ from: cursor, to: len });

  const point = (t) => ({ x: wall.x1 + ux * t, z: wall.z1 + uz * t });

  return {
    wall, len, ux, uz, spans, openings: cuts,
    point,
    /** Split a span into ~PANEL_WIDTH destructible panels. */
    panels(span) {
      const n = Math.max(1, Math.round((span.to - span.from) / PANEL_WIDTH));
      const step = (span.to - span.from) / n;
      const out = [];
      for (let i = 0; i < n; i++) {
        const from = span.from + i * step;
        const to = from + step;
        out.push({ from, to, mid: (from + to) / 2 });
      }
      return out;
    },
  };
}

/**
 * Rooms as *navigation* cells.
 *
 * Pathing relies on a room being convex with walls only on its boundary, so a
 * straight line inside one is always safe. `chapel_screen` runs through the
 * middle of the chapel, which breaks that — so the chapel is split in two here.
 * This list is only used for navigation; ROOMS still describes the architecture
 * and drives the art.
 */
export const NAV_ROOMS = [
  ...ROOMS.filter((r) => r.id !== 'chapel'),
  { id: 'chapel_s', name: 'Chapel', x1: 1, z1: 2, x2: 13, z2: 6 },
  { id: 'chapel_n', name: 'Chapel', x1: 1, z1: 6, x2: 13, z2: 10 },
];

export function navRoomAt(x, z) {
  for (const r of NAV_ROOMS) {
    if (x >= r.x1 && x <= r.x2 && z >= r.z1 && z <= r.z2) return r;
  }
  return null;
}

export function roomAt(x, z) {
  for (const r of ROOMS) {
    if (x >= r.x1 && x <= r.x2 && z >= r.z1 && z <= r.z2) return r;
  }
  return null;
}

/** Serialisable form for the Blender build script. */
export function toJSON() {
  return {
    wallHeight: WALL_HEIGHT,
    panelWidth: PANEL_WIDTH,
    surfaces: SURFACE,
    walls: WALLS,
    rooms: ROOMS,
    objective: OBJECTIVE,
    spawns: SPAWNS,
  };
}
