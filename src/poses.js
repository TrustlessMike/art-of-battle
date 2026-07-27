import * as THREE from 'three';
import { easing } from './rig.js';

/**
 * The animation library.
 *
 * Every clip is authored as a path for the *weapon* (position + blade
 * direction, in torso space) plus a handful of body rotations. The arms are
 * solved by IK onto the weapon, so an attack is designed by drawing the arc
 * the blade should travel — which is exactly the thing the player has to read
 * in order to block it.
 *
 * Character space: +Z forward (toward the opponent), +X the fighter's LEFT.
 * Torso space adds y = 0.98 (the waist) and inherits the torso's rotation.
 */

export const DIRS = ['top', 'left', 'right'];

// ---------------------------------------------------------------- frame model

const BASE = {
  p: [0, 0.5, 0.15],          // weapon hilt, torso space
  b: [0, 1, 0],               // blade direction
  r: 0,                       // blade roll, degrees
  Torso: [4, 10, 0],
  Head: [0, -6, 0],
  Hips: [0, -12, 0],
  Cloak: [0, 0, 0],
  y: 0,                       // pelvis height offset
  fwd: 0,                     // root offset along facing
  side: 0,                    // root offset along +X
  feetL: [0.19, 0, 0.20],     // foot targets, character space
  feetR: [-0.17, 0, -0.22],
  ease: 'inOutCubic',
};

function F(t, o = {}) {
  return { ...BASE, ...o, t };
}

/** Mirror a frame across the fighter's sagittal plane (left <-> right). */
function mirror(f) {
  const neg3 = (v) => [-v[0], v[1], v[2]];
  const negYZ = (v) => [v[0], -v[1], -v[2]];
  return {
    ...f,
    p: neg3(f.p),
    b: neg3(f.b),
    r: -f.r,
    Torso: negYZ(f.Torso),
    Head: negYZ(f.Head),
    Hips: negYZ(f.Hips),
    Cloak: negYZ(f.Cloak),
    side: -f.side,
    feetL: neg3(f.feetR),
    feetR: neg3(f.feetL),
  };
}

export class Clip {
  constructor(frames, opts = {}) {
    this.frames = frames;
    this.duration = frames[frames.length - 1].t;
    Object.assign(this, opts);
  }

  sample(time, out = newSample()) {
    const fr = this.frames;
    let i = 0;
    while (i < fr.length - 2 && time > fr[i + 1].t) i++;
    const a = fr[i];
    const b = fr[Math.min(i + 1, fr.length - 1)];
    const span = Math.max(1e-5, b.t - a.t);
    let u = Math.min(1, Math.max(0, (time - a.t) / span));
    u = (easing[b.ease] || easing.inOutCubic)(u);

    lerp3(a.p, b.p, u, out.p);
    slerpDir(a.b, b.b, u, out.b);
    out.roll = a.r + (b.r - a.r) * u;
    for (const k of ['Torso', 'Head', 'Hips', 'Cloak']) {
      const va = a[k], vb = b[k];
      out.pose[k][0] = va[0] + (vb[0] - va[0]) * u;
      out.pose[k][1] = va[1] + (vb[1] - va[1]) * u;
      out.pose[k][2] = va[2] + (vb[2] - va[2]) * u;
    }
    out.y = a.y + (b.y - a.y) * u;
    out.fwd = a.fwd + (b.fwd - a.fwd) * u;
    out.side = a.side + (b.side - a.side) * u;
    lerp3(a.feetL, b.feetL, u, out.feetL);
    lerp3(a.feetR, b.feetR, u, out.feetR);
    return out;
  }
}

export function newSample() {
  return {
    p: new THREE.Vector3(), b: new THREE.Vector3(0, 1, 0), roll: 0,
    pose: { Torso: [0, 0, 0], Head: [0, 0, 0], Hips: [0, 0, 0], Cloak: [0, 0, 0] },
    y: 0, fwd: 0, side: 0,
    feetL: new THREE.Vector3(), feetR: new THREE.Vector3(),
  };
}

export function blendSamples(a, b, t, out) {
  out.p.lerpVectors(a.p, b.p, t);
  slerpVec(a.b, b.b, t, out.b);
  out.roll = a.roll + (b.roll - a.roll) * t;
  for (const k in out.pose) {
    for (let i = 0; i < 3; i++) {
      out.pose[k][i] = a.pose[k][i] + (b.pose[k][i] - a.pose[k][i]) * t;
    }
  }
  out.y = a.y + (b.y - a.y) * t;
  out.fwd = a.fwd + (b.fwd - a.fwd) * t;
  out.side = a.side + (b.side - a.side) * t;
  out.feetL.lerpVectors(a.feetL, b.feetL, t);
  out.feetR.lerpVectors(a.feetR, b.feetR, t);
  return out;
}

const _sa = new THREE.Vector3();
const _sb = new THREE.Vector3();
const _sp = new THREE.Vector3();

/**
 * Spherical interpolation between two blade directions.
 *
 * A plain lerp between near-opposite directions passes through the origin and
 * snaps — an overhead chop would teleport rather than sweep. Slerping traces
 * the great circle, which is the arc the swing is supposed to draw.
 */
export function slerpVec(a, b, u, out) {
  const dot = Math.min(1, Math.max(-1, a.dot(b)));
  if (dot > 0.9995) return out.copy(a).lerp(b, u).normalize();
  if (dot < -0.9995) {
    // Exactly antipodal: no unique great circle, so pick a stable one.
    _sp.set(-a.y, a.x, 0);
    if (_sp.lengthSq() < 1e-6) _sp.set(0, -a.z, a.y);
    _sp.normalize();
    const th = Math.PI * u;
    return out.copy(a).multiplyScalar(Math.cos(th)).addScaledVector(_sp, Math.sin(th));
  }
  const theta = Math.acos(dot) * u;
  _sp.copy(b).addScaledVector(a, -dot).normalize();
  return out.copy(a).multiplyScalar(Math.cos(theta)).addScaledVector(_sp, Math.sin(theta));
}

function slerpDir(ax, bx, u, out) {
  _sa.set(ax[0], ax[1], ax[2]).normalize();
  _sb.set(bx[0], bx[1], bx[2]).normalize();
  return slerpVec(_sa, _sb, u, out);
}

function lerp3(a, b, u, out) {
  out.set(a[0] + (b[0] - a[0]) * u,
    a[1] + (b[1] - a[1]) * u,
    a[2] + (b[2] - a[2]) * u);
}

// ------------------------------------------------------------------- guards

/**
 * Resting guards.
 *
 * Note for anyone trying to make the weapon visible in first person: moving
 * these will not do it. The eye sits only ~0.12m above and ~0.17m behind the
 * hands, so the weapon is inside the near field and outside the frustum
 * wherever the guard is placed, and pushing it far enough forward to clear the
 * lens exceeds the arm's reach. That needs a separate viewmodel camera with
 * its own FOV, the way shooters do it — not a pose change.
 */
const GUARD_FRAME = {
  top: {
    p: [-0.13, 0.66, 0.02], b: [0.10, 0.62, -0.78], r: 0,
    Torso: [6, 8, 0], Head: [-4, -6, 0], Hips: [0, -10, 0],
  },
  left: {
    p: [0.26, 0.52, 0.16], b: [0.34, 0.87, -0.36], r: 0,
    Torso: [4, 18, -5], Head: [0, -12, 0], Hips: [0, -8, 0],
  },
  right: {
    p: [-0.27, 0.51, 0.16], b: [-0.30, 0.90, -0.32], r: 0,
    Torso: [4, -4, 7], Head: [0, 4, 0], Hips: [0, -16, 0],
  },
};

export const GUARD = {};
for (const d of DIRS) GUARD[d] = new Clip([F(0, GUARD_FRAME[d])]);

/** Small idle breathing/settle offset layered over the guard. */
export function idleSway(t) {
  return {
    py: Math.sin(t * 1.7) * 0.012,
    pitch: Math.sin(t * 1.7 + 0.6) * 1.4,
    yaw: Math.sin(t * 0.9) * 1.8,
  };
}

// ------------------------------------------------------------------ attacks

const ARC = {
  top: {
    windup: {
      p: [-0.10, 0.78, -0.26], b: [0.05, 0.42, -0.91],
      Torso: [-13, 6, 0], Head: [-10, -2, 0], Hips: [0, -8, 0],
      y: 0.01, fwd: -0.04,
      feetL: [0.19, 0, 0.16], feetR: [-0.17, 0, -0.26],
    },
    // The blade passes straight overhead before it comes down in front.
    apex: {
      p: [-0.03, 0.76, 0.02], b: [0.02, 0.96, 0.28],
      Torso: [2, 4, 0], Head: [0, 0, 0], Hips: [0, -8, 0],
      y: -0.01, fwd: 0.05,
      feetL: [0.19, 0, 0.24], feetR: [-0.17, 0, -0.24],
    },
    impact: {
      p: [0.0, 0.50, 0.42], b: [0.0, 0.30, 0.95],
      Torso: [16, 2, 0], Head: [8, 0, 0], Hips: [3, -6, 0],
      y: -0.04, fwd: 0.14,
      feetL: [0.19, 0, 0.34], feetR: [-0.17, 0, -0.20],
    },
    follow: {
      p: [0.02, 0.40, 0.42], b: [0.0, -0.35, 0.94],
      Torso: [26, 4, 0], Head: [14, 0, 0], Hips: [6, -6, 0],
      y: -0.08, fwd: 0.19,
      feetL: [0.19, 0, 0.36], feetR: [-0.17, 0, -0.20],
    },
  },
  left: {
    windup: {
      p: [0.30, 0.56, -0.10], b: [0.44, 0.80, -0.41], r: -10,
      Torso: [2, 30, -10], Head: [0, -18, 0], Hips: [0, 6, 0],
      y: 0.0, fwd: -0.03, side: 0.03,
      feetL: [0.23, 0, 0.14], feetR: [-0.15, 0, -0.24],
    },
    // Mid-swing the blade points out past the lead shoulder, sweeping across.
    apex: {
      p: [0.24, 0.46, 0.16], b: [0.80, 0.20, 0.57], r: -4,
      Torso: [4, 18, -6], Head: [0, -10, 0], Hips: [0, -2, 0],
      y: -0.01, fwd: 0.05, side: 0.0,
      feetL: [0.21, 0, 0.22], feetR: [-0.17, 0, -0.22],
    },
    // Contact: blade level and pointed down the line, at chest height.
    impact: {
      p: [0.0, 0.40, 0.46], b: [-0.05, -0.02, 1.0], r: 6,
      Torso: [8, -8, 4], Head: [4, 6, 0], Hips: [2, -14, 0],
      y: -0.04, fwd: 0.15, side: -0.05,
      feetL: [0.17, 0, 0.30], feetR: [-0.21, 0, -0.18],
    },
    follow: {
      p: [-0.24, 0.38, 0.32], b: [-0.86, -0.22, 0.46], r: 10,
      Torso: [11, -34, 12], Head: [4, 20, 0], Hips: [2, -30, 0],
      y: -0.06, fwd: 0.16, side: -0.08,
      feetL: [0.15, 0, 0.30], feetR: [-0.23, 0, -0.16],
    },
  },
};
const ARC_KEYS = ['windup', 'apex', 'impact', 'follow'];

ARC.right = Object.fromEntries(
  ARC_KEYS.map((k) => [k, mirror(F(0, ARC.left[k]))]),
);

// Normalise every arc key against BASE. Arcs are authored sparsely, and a
// missing numeric field would otherwise reach scaleFrame() as undefined and
// silently propagate NaN into the fighter's position.
for (const d of DIRS) {
  for (const k of ARC_KEYS) ARC[d][k] = F(0, ARC[d][k]);
}

export const TIMING = {
  light: { windup: 0.42, active: 0.09, recover: 0.34, damage: 13, stamina: 11 },
  heavy: { windup: 0.74, active: 0.12, recover: 0.56, damage: 29, stamina: 22 },
};

function scaleFrame(f, s) {
  const sc = (v) => [(v?.[0] ?? 0) * s, (v?.[1] ?? 0) * s, (v?.[2] ?? 0) * s];
  return {
    ...f,
    Torso: sc(f.Torso), Head: sc(f.Head), Hips: sc(f.Hips),
    fwd: (f.fwd ?? 0) * s, side: (f.side ?? 0) * s, y: (f.y ?? 0) * s,
  };
}

export const ATTACK = {};
for (const type of ['light', 'heavy']) {
  ATTACK[type] = {};
  const T = TIMING[type];
  const amp = type === 'heavy' ? 1.18 : 1.0;
  for (const d of DIRS) {
    const a = ARC[d];
    const g = GUARD_FRAME[d];
    const tImpact = T.windup + T.active;
    const swing = T.active + 0.06;   // windup -> apex -> contact
    ATTACK[type][d] = new Clip([
      F(0, { ...g, ease: 'outQuad' }),
      F(T.windup * 0.62, { ...scaleFrame(a.windup, amp), ease: 'outCubic' }),
      F(T.windup, { ...scaleFrame(a.windup, amp), ease: 'linear' }),
      F(T.windup + swing * 0.55, { ...scaleFrame(a.apex, amp), ease: 'inQuad' }),
      F(T.windup + swing, { ...scaleFrame(a.impact, amp), ease: 'outQuad' }),
      F(T.windup + swing + 0.13, { ...scaleFrame(a.follow, amp), ease: 'outQuad' }),
      F(tImpact + T.recover, { ...g, ease: 'inOutCubic' }),
    ], { windup: T.windup, impact: T.windup + swing, recover: T.recover });
  }
}

// --------------------------------------------------------------- reactions

/** Weapon jolts back along the incoming line; the body absorbs the shock. */
export const BLOCK_REACT = {};
for (const d of DIRS) {
  const g = GUARD_FRAME[d];
  const shove = {
    top: { p: [-0.11, 0.60, -0.10], Torso: [-9, 6, 0], y: -0.05, fwd: -0.10 },
    left: { p: [0.20, 0.48, 0.02], Torso: [-4, 24, -8], y: -0.04, fwd: -0.08, side: -0.05 },
    right: { p: [-0.21, 0.48, 0.02], Torso: [-4, -10, 10], y: -0.04, fwd: -0.08, side: 0.05 },
  }[d];
  BLOCK_REACT[d] = new Clip([
    F(0, g),
    F(0.055, { ...g, ...shove, ease: 'outQuad' }),
    F(0.30, { ...g, ease: 'outCubic' }),
  ]);
}

/** Parry: deflect the blade wide and step in — the reward pose. */
export const PARRY_REACT = {};
for (const d of DIRS) {
  const g = GUARD_FRAME[d];
  const push = {
    top: { p: [0.20, 0.68, 0.24], b: [0.72, 0.52, 0.46], Torso: [6, -18, 12], fwd: 0.08 },
    left: { p: [-0.22, 0.60, 0.30], b: [-0.62, 0.62, 0.48], Torso: [6, -24, 14], fwd: 0.08 },
    right: { p: [0.22, 0.60, 0.30], b: [0.62, 0.64, 0.44], Torso: [6, 24, -14], fwd: 0.08 },
  }[d];
  PARRY_REACT[d] = new Clip([
    F(0, g),
    F(0.09, { ...g, ...push, ease: 'outQuad' }),
    F(0.24, { ...g, ...push, ease: 'linear' }),
    F(0.46, { ...g, ease: 'inOutCubic' }),
  ]);
}

/** Taking a hit from a given direction. */
export function hitReact(dir, heavy) {
  const g = GUARD_FRAME[dir];
  const away = {
    top: { Torso: [-22, 4, 0], Head: [-24, 0, 0], p: [-0.16, 0.44, -0.10], y: -0.09, fwd: -0.14 },
    left: { Torso: [-6, -26, 20], Head: [-8, 16, 10], p: [-0.20, 0.40, 0.0], y: -0.06, fwd: -0.10, side: -0.10 },
    right: { Torso: [-6, 26, -20], Head: [-8, -16, -10], p: [0.20, 0.40, 0.0], y: -0.06, fwd: -0.10, side: 0.10 },
  }[dir];
  const s = heavy ? 1.35 : 1;
  const t = heavy ? 0.60 : 0.40;
  // Keep the guard's blade orientation; only the body and hilt recoil.
  const struck = scaleFrame({ ...BASE, ...g, ...away }, s);
  struck.b = g.b;
  struck.p = away.p;
  return new Clip([
    F(0, g),
    F(0.07, { ...struck, ease: 'outQuad' }),
    F(t, { ...g, ease: 'outCubic' }),
  ]);
}

/** Parried / guard-broken: wide open, weapon flung out of line. */
export const STAGGER = new Clip([
  F(0, { p: [-0.16, 0.58, 0.05], b: [0.1, 0.8, -0.6] }),
  F(0.12, {
    p: [0.34, 0.42, -0.18], b: [0.86, 0.30, -0.42],
    Torso: [-16, 34, -22], Head: [-18, -10, 0], Hips: [-6, 20, 0],
    y: -0.10, fwd: -0.18, side: 0.10,
    feetL: [0.26, 0, 0.02], feetR: [-0.20, 0, -0.34], ease: 'outQuad',
  }),
  F(0.62, {
    p: [0.30, 0.40, -0.14], b: [0.80, 0.36, -0.48],
    Torso: [-12, 30, -18], Head: [-14, -8, 0], Hips: [-4, 18, 0],
    y: -0.12, fwd: -0.20, side: 0.08,
    feetL: [0.26, 0, 0.02], feetR: [-0.20, 0, -0.34], ease: 'linear',
  }),
  F(0.95, { ease: 'inOutCubic' }),
]);

/** Guard break: drive the crossguard into their chest. */
export const GUARDBREAK = new Clip([
  F(0, { p: [-0.10, 0.54, 0.18], b: [0.1, 0.9, -0.4] }),
  F(0.13, {
    p: [-0.06, 0.50, 0.02], b: [0.2, 0.78, -0.6],
    Torso: [-8, 12, 0], y: 0.01, fwd: -0.05, ease: 'outQuad',
  }),
  F(0.30, {
    p: [0.0, 0.46, 0.40], b: [0.06, 0.30, 0.95],
    Torso: [16, -4, 0], Head: [8, 0, 0], y: -0.05, fwd: 0.26,
    feetL: [0.19, 0, 0.36], feetR: [-0.17, 0, -0.14], ease: 'strike',
  }),
  F(0.58, { ease: 'inOutCubic' }),
]);

/** Being thrown after a landed guard break. */
export const THROWN = new Clip([
  F(0, {}),
  F(0.14, {
    Torso: [-24, 10, 0], Head: [-20, 0, 0], y: -0.14, fwd: -0.34,
    p: [0.18, 0.40, -0.12], b: [0.6, 0.5, -0.6],
    feetL: [0.22, 0, -0.02], feetR: [-0.18, 0, -0.36], ease: 'outQuad',
  }),
  F(0.55, {
    Torso: [-18, 8, 0], y: -0.16, fwd: -0.70,
    p: [0.18, 0.40, -0.12], b: [0.6, 0.5, -0.6],
    feetL: [0.22, 0, -0.10], feetR: [-0.18, 0, -0.44], ease: 'outCubic',
  }),
  F(0.90, { ease: 'inOutCubic' }),
]);

export function dodgeClip(dx, dz) {
  const lean = { Torso: [-dz * 12 + 4, dx * 16, -dx * 14], y: -0.07 };
  return new Clip([
    F(0, {}),
    F(0.10, { ...lean, fwd: dz * 0.30, side: dx * 0.30, ease: 'outQuad' }),
    F(0.26, { ...lean, fwd: dz * 0.85, side: dx * 0.85, ease: 'outCubic' }),
    F(0.46, { fwd: dz * 0.95, side: dx * 0.95, ease: 'inOutCubic' }),
  ], { travel: 0.95 });
}

export const DEATH = new Clip([
  F(0, {}),
  F(0.16, {
    Torso: [-14, 8, 0], Head: [-18, 0, 0], y: -0.16,
    p: [0.20, 0.34, -0.10], b: [0.7, 0.2, -0.6], ease: 'outQuad',
  }),
  F(0.52, {
    Torso: [26, 16, -8], Head: [22, 0, 0], Hips: [-30, 10, 0], y: -0.52,
    p: [0.30, 0.10, 0.10], b: [0.9, -0.3, 0.2],
    feetL: [0.24, 0, -0.10], feetR: [-0.20, 0, -0.36], ease: 'inQuad',
  }),
  F(0.95, {
    Torso: [40, 18, -10], Head: [26, 0, 0], Hips: [-46, 12, 0], y: -0.72,
    p: [0.34, 0.06, 0.14], b: [0.95, -0.2, 0.2],
    feetL: [0.26, 0, -0.14], feetR: [-0.22, 0, -0.40], ease: 'outQuad',
  }),
], { hold: true });

export const VICTORY = new Clip([
  F(0, {}),
  F(0.45, {
    p: [-0.12, 0.74, -0.06], b: [0.1, 0.95, -0.3],
    Torso: [-6, 10, 0], Head: [-12, 0, 0], y: 0.02, ease: 'outBack',
  }),
  F(1.2, {
    p: [-0.12, 0.72, -0.04], b: [0.1, 0.96, -0.26],
    Torso: [-4, 10, 0], Head: [-10, 0, 0], ease: 'inOutCubic',
  }),
], { hold: true });
