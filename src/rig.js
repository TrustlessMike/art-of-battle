import * as THREE from 'three';

/**
 * Drives a Blender-authored rigid-part rig (see ASSET_CONTRACT.md).
 *
 * Bones point down their own local -Y. The weapon is deliberately NOT parented
 * to a hand: it hangs off `weaponAnchor` (a child of Torso) so animation can
 * author the blade's arc directly, and both arms are solved with two-bone IK
 * onto grip points on the weapon. Authoring the weapon path rather than joint
 * angles is what makes an attack's direction readable at a glance.
 */

const DEG = Math.PI / 180;
const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _m1 = new THREE.Matrix4();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _e1 = new THREE.Euler();
const AXIS_X = new THREE.Vector3(1, 0, 0);

export const UPPER_JOINTS = [
  'Torso', 'Head', 'Cloak',
  'ShoulderL', 'ElbowL', 'HandL',
  'ShoulderR', 'ElbowR', 'HandR',
];

export const LOWER_JOINTS = [
  'Hips', 'HipL', 'KneeL', 'FootL', 'HipR', 'KneeR', 'FootR',
];

export const ALL_JOINTS = [...UPPER_JOINTS, ...LOWER_JOINTS];

// Bone lengths, straight from the joint offsets in ASSET_CONTRACT.md.
const UPPER_ARM = 0.29;
const FORE_ARM = 0.27;
const THIGH = 0.44;
const SHIN = 0.44;
/** Render layer for the first-person viewmodel (own arms + weapon). */
export const VIEWMODEL_LAYER = 1;

export const HIP_HEIGHT = 0.98;
export const LEG_REACH = THIGH + SHIN;

export class Rig {
  constructor(gltfScene) {
    this.root = gltfScene;
    this.joints = {};
    this.rest = {};

    gltfScene.traverse((o) => {
      if (ALL_JOINTS.includes(o.name) || /^(Grip|Root)/.test(o.name)) {
        this.joints[o.name] = o;
      }
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        // Rigid armour reads better with slightly crisper speculars than the
        // Blender defaults give us.
        if (o.material) {
          o.material.envMapIntensity = 1.15;
          o.material.shadowSide = THREE.FrontSide;
        }
      }
    });

    for (const name of ALL_JOINTS) {
      const j = this.joints[name];
      if (j) this.rest[name] = j.quaternion.clone();
    }

    // Weapon lives under the torso so its authored path is independent of the
    // arms; the arms chase it, not the other way round.
    this.weaponAnchor = new THREE.Object3D();
    this.weaponAnchor.name = 'WeaponAnchor';
    (this.joints.Torso || this.root).add(this.weaponAnchor);

    this.gripPoints = {
      // Along the weapon's local +Y (blade direction) from the hilt.
      lead: new THREE.Vector3(0, 0.04, 0),
      rear: new THREE.Vector3(0, -0.10, 0),
    };

    this.hipsOffset = new THREE.Vector3();
    this.rootYaw = 0;
    this._ikEnabled = true;
    this._bladeTip = new THREE.Vector3();
  }

  /**
   * Mount a weapon.
   *
   * `spec` gives, in the weapon's own +Y axis, where the two hands grip and
   * where the tip is. Weapons are modelled with their origin in different
   * places, so the model is shifted until the midpoint between the hands sits
   * on the anchor. Every animation is authored against that hand position, so
   * this is what lets any weapon play the same clips correctly.
   */
  attachWeapon(weaponScene, spec = {}) {
    if (this.weapon) {
      this.weaponAnchor.remove(this.weapon);
    }
    this.weapon = weaponScene;
    weaponScene.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });

    const lead = spec.lead ?? 0.05;
    const rear = spec.rear ?? -0.10;
    const tip = spec.tip ?? 1.3;
    const centre = (lead + rear) / 2;

    weaponScene.position.set(0, -centre, 0);
    this.weaponAnchor.add(weaponScene);
    this.gripPoints.lead.set(0, lead - centre, 0);
    this.gripPoints.rear.set(0, rear - centre, 0);
    this.bladeLength = tip - centre;
    this.gripSpec = { lead, rear, tip, centre };
  }

  /**
   * Hide the parts that would sit inside the camera in first person. The
   * fighter's own helm surrounds the lens, so it is dropped; everything else
   * stays, which is what lets you see your own hands and weapon.
   */
  setFirstPerson(on, viewLayer = VIEWMODEL_LAYER) {
    this.firstPerson = on;
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      // Keep only what a first-person view should show: your own forearms and
      // hands, holding the weapon. Everything else surrounds the lens — the
      // helm, the pauldrons and the chest all clip straight through it.
      // The glTF loader splits multi-material meshes into name_1, name_2, ...,
      // so match the base name rather than the whole thing.
      const base = o.name.replace(/_\d+$/, '');
      const keep = /^M_(Arm[LR]_Lower|Hand[LR]|Weapon)$/.test(base);
      o.visible = on ? keep : true;
      // Still cast a full-body shadow, so the fighter reads on the floor.
      o.castShadow = true;
      // What survives goes on its own layer, drawn by a second camera. The
      // hands sit slightly *behind* the eye, so no field of view on the main
      // camera can bring them into frame — they need their own viewpoint.
      o.layers.set(on && keep ? viewLayer : 0);
    });
  }

  /** Reset every joint to its exported rest orientation. */
  resetPose() {
    for (const name of ALL_JOINTS) {
      const j = this.joints[name];
      if (j) j.quaternion.copy(this.rest[name]);
    }
    this.hipsOffset.set(0, 0, 0);
  }

  /**
   * Apply a pose: { JointName: [rx, ry, rz] } in degrees, relative to rest.
   * Joints missing from the pose keep their rest orientation.
   */
  applyPose(pose) {
    for (const name in pose) {
      const j = this.joints[name];
      if (!j) continue;
      const r = pose[name];
      _e1.set(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'YXZ');
      _q1.setFromEuler(_e1);
      j.quaternion.copy(this.rest[name]).multiply(_q1);
    }
  }

  /** Place the authored weapon transform (torso-local). */
  setWeapon(pos, bladeDir, rollDeg) {
    this.weaponAnchor.position.copy(pos);
    _v1.copy(bladeDir).normalize();
    _q1.setFromUnitVectors(UP, _v1);
    _q2.setFromAxisAngle(UP, rollDeg * DEG);
    this.weaponAnchor.quaternion.copy(_q1).multiply(_q2);
  }

  /** World-space position of the blade tip, for trails and hit sweeps. */
  bladeTip(out = new THREE.Vector3()) {
    out.set(0, this.bladeLength ?? 1.3, 0);
    return this.weaponAnchor.localToWorld(out);
  }

  /** Point a fraction of the way along the blade, for trail inner edges. */
  bladePoint(frac, out = new THREE.Vector3()) {
    out.set(0, (this.bladeLength ?? 1.3) * frac, 0);
    return this.weaponAnchor.localToWorld(out);
  }

  bladeBase(out = new THREE.Vector3()) {
    return this.bladePoint(0.14, out);
  }

  /**
   * Two-bone IK. Aims `root`/`mid` so the chain's end lands on `targetWorld`,
   * with the middle joint pushed toward `poleWorld`. Bones point local -Y.
   */
  solveChain(rootName, midName, l1, l2, targetWorld, poleWorld) {
    const shoulder = this.joints[rootName];
    const elbow = this.joints[midName];
    if (!shoulder || !elbow) return;

    const parent = shoulder.parent;
    parent.updateWorldMatrix(true, false);
    _m1.copy(parent.matrixWorld).invert();

    const T = _v1.copy(targetWorld).applyMatrix4(_m1);
    const S = shoulder.position;
    const toT = _v2.subVectors(T, S);
    let d = toT.length();
    const max = (l1 + l2) * 0.995;
    if (d > max) { toT.multiplyScalar(max / d); d = max; }
    if (d < 1e-4) return;
    const dir = toT.clone().normalize();

    const cosA = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
    const a = Math.acos(Math.min(1, Math.max(-1, cosA)));

    // Rotating `dir` about (dir × pole) by +a swings it toward the pole.
    const pole = _v3.copy(poleWorld).applyMatrix4(_m1).sub(S).normalize();
    const axis = dir.clone().cross(pole);
    if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0); else axis.normalize();
    const upperDir = dir.clone().applyAxisAngle(axis, a);

    _q1.setFromUnitVectors(DOWN, upperDir);
    shoulder.quaternion.copy(_q1);

    const elbowPos = S.clone().addScaledVector(upperDir, l1);
    const lowerDir = T.clone().sub(elbowPos).normalize();
    _q2.setFromUnitVectors(DOWN, lowerDir);
    elbow.quaternion.copy(_q1).invert().multiply(_q2);
  }

  solveArm(side, targetWorld, poleWorld) {
    this.solveChain(`Shoulder${side}`, `Elbow${side}`,
      UPPER_ARM, FORE_ARM, targetWorld, poleWorld);
  }

  /**
   * Plant a foot at a world position. `bodyQuat` is the character's world
   * orientation — the sole is levelled to it so feet never skate or sink.
   */
  solveLeg(side, targetWorld, bodyQuat, footPitch = 0) {
    const hip = this.joints[`Hip${side}`];
    if (!hip) return;
    hip.updateWorldMatrix(true, false);
    // Knees track forward of the hip, which keeps the bend anatomically sane.
    const pole = hip.localToWorld(_v1.set(0, -0.4, 1.4)).clone();
    this.solveChain(`Hip${side}`, `Knee${side}`,
      THIGH, SHIN, targetWorld, pole);

    const foot = this.joints[`Foot${side}`];
    if (!foot) return;
    foot.parent.updateWorldMatrix(true, false);
    const parentWorld = _q1.setFromRotationMatrix(
      _m1.extractRotation(foot.parent.matrixWorld));
    const desired = _q2.copy(bodyQuat)
      .multiply(_q3.setFromAxisAngle(AXIS_X, footPitch * DEG));
    foot.quaternion.copy(parentWorld).invert().multiply(desired);
  }

  /** Snap both hands onto the weapon grip after the FK pose is set. */
  solveGrips(leadSide = 'R', poleSpread = 1) {
    if (!this._ikEnabled || !this.weapon) return;
    const rearSide = leadSide === 'R' ? 'L' : 'R';
    this.joints.Torso?.updateWorldMatrix(true, false);
    this.weaponAnchor.updateWorldMatrix(true, false);

    const leadT = this.weaponAnchor.localToWorld(this.gripPoints.lead.clone());
    const rearT = this.weaponAnchor.localToWorld(this.gripPoints.rear.clone());

    for (const [side, target] of [[leadSide, leadT], [rearSide, rearT]]) {
      const sh = this.joints[`Shoulder${side}`];
      if (!sh) continue;
      sh.updateWorldMatrix(true, false);
      // Elbows sit out to the side, low and slightly back.
      const sign = side === 'L' ? 1 : -1;
      const pole = sh.localToWorld(
        _v1.set(sign * 0.75 * poleSpread, -0.55, -0.62),
      ).clone();
      this.solveArm(side, target, pole);
      const hand = this.joints[`Hand${side}`];
      if (hand) {
        // Wrist rolls to line the palm up with the grip.
        hand.quaternion.copy(this.rest[`Hand${side}`]);
      }
    }
  }
}

/** Linear-blend two poses. Missing joints fall back to neutral (rest). */
export function blendPose(a, b, t, out = {}) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const va = a[k] || ZERO;
    const vb = b[k] || ZERO;
    out[k] = [
      va[0] + (vb[0] - va[0]) * t,
      va[1] + (vb[1] - va[1]) * t,
      va[2] + (vb[2] - va[2]) * t,
    ];
  }
  return out;
}

/** Add pose `b` into `a` in place (used to layer torso lean over locomotion). */
export function addPose(a, b, scale = 1) {
  for (const k in b) {
    const vb = b[k];
    if (!a[k]) a[k] = [0, 0, 0];
    a[k][0] += vb[0] * scale;
    a[k][1] += vb[1] * scale;
    a[k][2] += vb[2] * scale;
  }
  return a;
}

const ZERO = [0, 0, 0];

export const easing = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  // Wind up slowly, then explode forward — the shape of a real swing.
  strike: (t) => t < 0.35 ? (t / 0.35) * 0.12 : 0.12 + Math.pow((t - 0.35) / 0.65, 1.7) * 0.88,
  outBack: (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2),
};
