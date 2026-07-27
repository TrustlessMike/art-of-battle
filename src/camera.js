import * as THREE from 'three';
import { WALL_HEIGHT } from './layout.js';

/**
 * Locked-on duel camera: always frames both fighters, sits over the player's
 * shoulder, and pulls back as the gap opens so the enemy's guard indicator
 * never leaves the screen.
 */

const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _want = new THREE.Vector3();
const _look = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class DuelCamera {
  constructor(camera) {
    this.camera = camera;
    this.pos = new THREE.Vector3(0, 2, -5);
    this.target = new THREE.Vector3();
    this.shake = 0;
    this.shakeDecay = 6;
    this.fovBase = camera.fov;
    this.fovPunch = 0;
    this.shoulder = 0.86;
    this.collider = null;   // a Compound, so the lens does not enter walls
    this.time = 0;
    this._offset = new THREE.Vector3();
  }

  /**
   * Keep a wall from getting between the fighter and the lens.
   *
   * The compound has no roof, so the good answer is to rise over the wall
   * rather than shove the camera up against the fighter's back — which is what
   * pulling straight in does, and it leaves the player filling the frame in
   * every narrow room. Distance is only trimmed a little; height does the work.
   */
  _resolveOcclusion(pos, px, pz, trim = true) {
    if (!this.collider) return;
    const hit = this.collider.raycastSurface(px, pz, pos.x, pos.z);
    if (!hit) return;
    const t = Math.max(0.55, hit.t);
    // Trimming is only ever applied to the freshly computed ideal position.
    // Applying it to the settled position as well would re-scale an already
    // scaled distance every frame and walk the camera into the fighter's back.
    if (trim) {
      pos.x = px + (pos.x - px) * t;
      pos.z = pz + (pos.z - pz) * t;
    }
    // Raising is idempotent, so it is safe to reapply after smoothing.
    pos.y = Math.max(pos.y, WALL_HEIGHT + 0.2 + (1 - t) * 0.55);
  }

  kick(amount, fov = 0) {
    this.shake = Math.min(1.1, this.shake + amount);
    this.fovPunch = Math.min(9, this.fovPunch + fov);
  }

  update(dt, player, enemy, finished) {
    this.time += dt;
    _dir.subVectors(enemy.pos, player.pos);
    _dir.y = 0;
    const gap = Math.max(0.8, _dir.length());
    _dir.normalize();
    _right.crossVectors(UP, _dir).normalize();

    // fov is vertical, so a narrow/portrait window frames much less width —
    // pull back to keep both fighters and the guard indicator on screen.
    const aspect = this.camera.aspect || 1.777;
    const widen = aspect < 1.6 ? (1.6 - aspect) * 2.1 : 0;
    const back = THREE.MathUtils.clamp(3.05 + gap * 0.34 + widen, 3.2, 6.4);
    const height = 1.86 + gap * 0.06 + widen * 0.16;

    _want.copy(player.pos)
      .addScaledVector(_dir, -back)
      .addScaledVector(_right, this.shoulder)
      .setY(height);

    // Frame the midpoint, biased toward the enemy so you read their guard.
    _look.lerpVectors(player.pos, enemy.pos, 0.46).setY(1.22);

    // The round-over pull-back has to happen before occlusion is resolved,
    // otherwise it shoves the settled camera straight back into a wall — and
    // that is the shot every round ends on.
    if (finished) {
      _want.addScaledVector(_dir, -0.7).setY(height + 0.35);
      _look.setY(1.0);
    }

    // Indoors the ideal camera position is usually inside a wall.
    this._resolveOcclusion(_want, player.pos.x, player.pos.z);

    const kPos = 1 - Math.exp(-9 * dt);
    const kLook = 1 - Math.exp(-13 * dt);
    this.pos.lerp(_want, kPos);
    this.target.lerp(_look, kLook);

    // Smoothing can drag the lens back through a wall it just cleared, so
    // resolve the settled position too, not just the target one.
    this._resolveOcclusion(this.pos, player.pos.x, player.pos.z, false);

    // Impact shake: high-frequency, decaying, biased to the screen plane.
    this.shake = Math.max(0, this.shake - this.shakeDecay * dt * this.shake - dt * 0.15);
    const s = this.shake * this.shake;
    this._offset.set(
      Math.sin(this.time * 61) * s * 0.28,
      Math.sin(this.time * 47 + 1.3) * s * 0.22,
      Math.sin(this.time * 73 + 2.1) * s * 0.16,
    );

    this.camera.position.copy(this.pos).add(this._offset);
    this.camera.lookAt(this.target);
    this.camera.rotateZ(Math.sin(this.time * 39) * s * 0.035);

    this.fovPunch *= Math.exp(-7 * dt);
    const fov = this.fovBase + this.fovPunch;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  snap(player, enemy) {
    for (let i = 0; i < 40; i++) this.update(1 / 60, player, enemy, false);
  }
}

const _head = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _aim = new THREE.Vector3();

/**
 * First-person view, mounted on the fighter's head.
 *
 * Two modes, which is what makes the mouse able to do two jobs:
 *  - free      : you steer with the mouse and look around the building.
 *  - locked on : the fighter turns to face their opponent by itself, the view
 *                frames them, and the mouse is freed up to set your guard.
 *
 * There is no occlusion problem to solve here — the lens is inside the
 * fighter's skull, so it can never end up on the far side of a wall.
 */
export class FirstPersonCamera {
  constructor(camera) {
    this.camera = camera;
    this.pitch = 0;
    this.shake = 0;
    this.shakeDecay = 6;
    this.fovBase = camera.fov;
    this.fovPunch = 0;
    this.time = 0;
    this.bob = 0;
    this._offset = new THREE.Vector3();
    this.eyeForward = 0.17;
    this.eyeUp = 0.045;
  }

  kick(amount, fov = 0) {
    this.shake = Math.min(1.1, this.shake + amount);
    this.fovPunch = Math.min(9, this.fovPunch + fov);
  }

  /** Where the eyes are, in world space. */
  eyePosition(player, out = _eye) {
    const head = player.rig.joints.Head;
    if (head) {
      head.updateWorldMatrix(true, false);
      head.getWorldPosition(out);
    } else {
      out.copy(player.pos).setY(1.55);
    }
    const s = Math.sin(player.yaw);
    const c = Math.cos(player.yaw);
    out.x += s * this.eyeForward;
    out.z += c * this.eyeForward;
    out.y += this.eyeUp;
    return out;
  }

  update(dt, player, enemy, locked) {
    this.time += dt;

    // Head bob, scaled by how fast the fighter is actually travelling.
    const speed = player.velocity.length();
    this.bob += dt * (3.2 + speed * 2.4);
    const bobAmount = Math.min(1, speed / 2.5);

    this.eyePosition(player, _head);
    _head.y += Math.sin(this.bob * 2) * 0.014 * bobAmount;
    _head.x += Math.cos(this.bob) * 0.012 * bobAmount;

    this.shake = Math.max(0,
      this.shake - this.shakeDecay * dt * this.shake - dt * 0.15);
    const s = this.shake * this.shake;
    this._offset.set(
      Math.sin(this.time * 61) * s * 0.10,
      Math.sin(this.time * 47 + 1.3) * s * 0.09,
      Math.sin(this.time * 73 + 2.1) * s * 0.06,
    );
    this.camera.position.copy(_head).add(this._offset);

    if (locked && enemy.alive) {
      // Frame the opponent's chest so the guard indicator sits centre screen.
      _aim.copy(enemy.pos).setY(1.28);
      this.camera.lookAt(_aim);
      // Keep pitch in sync so unlocking does not snap the view.
      const d = Math.hypot(_aim.x - _head.x, _aim.z - _head.z);
      this.pitch = Math.atan2(_aim.y - _head.y, Math.max(0.2, d));
    } else {
      this.camera.rotation.set(this.pitch, player.yaw, 0, 'YXZ');
    }
    this.camera.rotateZ(Math.sin(this.time * 39) * s * 0.05);

    this.fovPunch *= Math.exp(-7 * dt);
    const fov = this.fovBase + this.fovPunch;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  snap(player, enemy, locked) {
    this.update(1 / 60, player, enemy, locked);
  }
}
