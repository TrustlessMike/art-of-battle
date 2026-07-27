import * as THREE from 'three';
import { Rig, HIP_HEIGHT } from './rig.js';
import {
  ATTACK, BLOCK_REACT, Clip, DEATH, GUARD, GUARDBREAK, PARRY_REACT, STAGGER,
  DIRS, THROWN, TIMING, VICTORY, blendSamples, dodgeClip, hitReact,
  idleSway, newSample,
} from './poses.js';
import { resolveTraits } from './traits.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

export const ARENA_RADIUS = 30.0;
const BODY_RADIUS = 0.66;

export const STAMINA_MAX = 100;
const STAMINA_REGEN = 26;
const STAMINA_DELAY = 0.85;
const EXHAUST_TIME = 3.2;

const STEP_TRIGGER = 0.22;
const ACCEL = 15;      // m/s^2 getting under way
const DECEL = 22;      // m/s^2 planting the feet to stop

export class Fighter {
  constructor(opts) {
    this.name = opts.name;
    this.rig = new Rig(opts.model);
    this.rig.attachWeapon(opts.weapon, opts.grip);
    this.group = new THREE.Group();
    this.group.add(opts.model);
    this.profile = opts.profile;         // { damageMul, leadHand, ... }

    this.calibratedReach = 2.2;
    this.contact = null;   // filled in by _calibrate() below

    this.pos = new THREE.Vector3(opts.x ?? 0, 0, opts.z ?? 0);
    this.yaw = opts.yaw ?? 0;

    this.maxHealth = opts.health ?? 130;
    this.health = this.maxHealth;
    this.stamina = STAMINA_MAX;
    this.staminaTimer = 0;
    this.exhausted = 0;

    this.guard = 'right';
    this.state = 'idle';
    this.stateTime = 0;
    this.attack = null;
    this.clip = GUARD.right;
    this.clipTime = 0;
    this.clipHold = false;

    this.sample = newSample();
    this.prevSample = newSample();
    this.outSample = newSample();
    this.fade = 1;
    this.fadeTime = 0.12;

    this.lastFwd = 0;
    this.lastSide = 0;
    this.velocity = new THREE.Vector3();
    this.moveInput = new THREE.Vector2();

    this.feet = {
      L: newFoot(this.pos, 0.19, 0.20, this.yaw),
      R: newFoot(this.pos, -0.17, -0.22, this.yaw),
    };

    this.events = [];
    this.gbCounterWindow = 0;
    this.hitFlash = 0;
    this.charge = 0;
    this.chargeHeld = false;
    this.blockedRecently = 0;
    this.swaySeed = Math.random() * 10;
    this.stepSide = 'L';
    this.stepTimer = 0;
    this.gaitPhase = 0;
    this.hitstunTime = 0.4;
    this.staggerScale = 1;
    this.gbResolved = true;
    this.frozen = false;
    this.caltropSlow = 0;
    this.revealedUntil = 0;
    this.collider = null;   // set to a Compound to collide with walls
    this.faceOverride = null;  // {x,z} to look at instead of the opponent
    this.freeLook = false;     // true while the player is steering themselves
    this.traits = opts.traits || resolveTraits('vanguard', []);
    this.chainWindow = 0;      // time left to continue an attack chain
    this.chainStep = 0;        // how deep into the current chain we are

    this._calibrate();
  }

  /**
   * Swap the armour and weapon this fighter wears, in place.
   *
   * The Fighter object's identity is deliberately preserved: it is used as a
   * Map key for gadget inventories and blade trails, and is referenced by the
   * duel, the siege and the AI. Rebuilding a new Fighter instead would leave
   * every one of those pointing at a corpse.
   */
  setLoadout({ model, weapon, grip, profile }) {
    if (model && model !== this.rig.root) {
      this.group.remove(this.rig.root);
      const wasFirstPerson = !!this.rig.firstPerson;
      this.rig = new Rig(model);
      this.group.add(model);
      this.rig.attachWeapon(weapon, grip);
      if (wasFirstPerson) this.rig.setFirstPerson(true);
    } else if (weapon) {
      this.rig.attachWeapon(weapon, grip);
    }
    if (profile) this.profile = profile;
    // Reach and contact timing belong to the weapon, so they must be re-measured.
    this._calibrate();
    return this;
  }

  /**
   * Measure this fighter's actual reach and the instant each swing crosses the
   * target, by running the real rig through every attack clip and watching the
   * blade tip. Deriving it from the rig rather than a parallel bit of maths
   * means a hit can never register while the blade is somewhere else.
   */
  _calibrate(graze = 0.38, chestY = 1.12) {
    const saved = {
      pos: this.pos.clone(), yaw: this.yaw, state: this.state,
      clip: this.clip, clipTime: this.clipTime, fade: this.fade,
      attack: this.attack,
      feet: { L: this.feet.L.world.clone(), R: this.feet.R.world.clone() },
    };
    this.pos.set(0, 0, 0);
    this.yaw = 0;
    this.state = 'attack';
    this.attack = null;

    const traj = {};
    for (const type of ['light', 'heavy']) {
      traj[type] = {};
      for (const dir of DIRS) {
        const clip = ATTACK[type][dir];
        const pts = [];
        const from = clip.windup * 0.6;
        const to = clip.impact + clip.recover * 0.4;
        for (let t = from; t <= to; t += 0.008) {
          this.clip = clip;
          this.clipTime = t;
          this.fade = 1;
          this._poseRig(0);
          pts.push({ t, p: this.rig.bladeTip(new THREE.Vector3()) });
        }
        traj[type][dir] = pts;
        this.events.length = 0;
      }
    }

    const nearest = (pts, d) => {
      let best = Infinity;
      for (const s of pts) {
        best = Math.min(best, Math.hypot(s.p.x, s.p.y - chestY, s.p.z - d));
      }
      return best;
    };

    // The usable reach is the furthest distance every swing can still graze.
    let reach = 1.3;
    for (let d = 1.3; d <= 3.6; d += 0.02) {
      let ok = true;
      for (const type of ['light', 'heavy']) {
        for (const dir of DIRS) {
          if (nearest(traj[type][dir], d) > graze) { ok = false; break; }
        }
        if (!ok) break;
      }
      if (ok) reach = d;
    }
    this.calibratedReach = reach;

    this.contact = { light: {}, heavy: {} };
    this.contactMiss = { light: {}, heavy: {} };
    for (const type of ['light', 'heavy']) {
      for (const dir of DIRS) {
        let best = Infinity, bt = ATTACK[type][dir].impact;
        for (const s of traj[type][dir]) {
          const d = Math.hypot(s.p.x, s.p.y - chestY, s.p.z - reach);
          if (d < best) { best = d; bt = s.t; }
        }
        this.contact[type][dir] = bt;
        this.contactMiss[type][dir] = +best.toFixed(3);
      }
    }

    Object.assign(this, {
      yaw: saved.yaw, state: saved.state, clip: saved.clip,
      clipTime: saved.clipTime, fade: saved.fade, attack: saved.attack,
    });
    this.pos.copy(saved.pos);
    for (const s of ['L', 'R']) {
      const f = this.feet[s];
      f.world.copy(saved.feet[s]);
      f.desired.copy(saved.feet[s]);
      f.from.copy(saved.feet[s]);
      f.to.copy(saved.feet[s]);
      f.stepping = false;
      f.t = 1;
      f.lift = 0;
    }
    this.events.length = 0;
  }

  get alive() { return this.state !== 'dead'; }
  get reach() { return this.calibratedReach; }

  /** True while the fighter is able to start a new action. */
  get canAct() {
    if (this.frozen) return false;
    if (this.state === 'idle') return true;
    if (this.state === 'attack') {
      // Late in the recovery you can cancel into the next action.
      if (!this.attack) return true;
      if (this.chainWindow > 0) return this.clipTime > this.attack.strike;
      return this.clipTime > this.clip.duration - this.attack.recover * 0.28;
    }
    if (this.state === 'blockReact') return this.stateTime > 0.16;
    if (this.state === 'parryReact') return this.stateTime > 0.20;
    if (this.state === 'gb') return this.clipTime > 0.42;
    return false;
  }

  /** True while the guard is actually up and can stop a blade. */
  get canBlock() {
    if (this.state === 'idle' || this.state === 'blockReact') return true;
    if (this.state === 'parryReact') return this.stateTime > 0.24;
    if (this.state === 'attack') {
      if (!this.attack) return true;
      return this.clipTime > this.clip.duration - this.attack.recover * 0.45;
    }
    return false;
  }

  get invulnerable() {
    const window = 0.25 * this.traits.dodgeIFrameMul;
    return this.state === 'dodge' &&
      this.stateTime > 0.09 && this.stateTime < 0.09 + window;
  }

  /** Phase of the current attack, for HUD indicators and AI reads. */
  get attackPhase() {
    if (this.state !== 'attack') return null;
    const a = this.attack;
    if (this.clipTime < a.windup) return 'windup';
    if (this.clipTime < a.strike + 0.02) return 'active';
    return 'recover';
  }

  // ------------------------------------------------------------- clip control

  play(clip, { fade = 0.12, hold = false } = {}) {
    copySample(this.outSample, this.prevSample);
    this.fade = 0;
    this.fadeTime = Math.max(0.001, fade);
    this.clip = clip;
    this.clipTime = 0;
    this.clipHold = hold || !!clip.hold;
    this.lastFwd = 0;
    this.lastSide = 0;
  }

  setState(state, clip, opts) {
    this.state = state;
    this.stateTime = 0;
    if (clip) this.play(clip, opts);
  }

  // ------------------------------------------------------------------ actions

  setGuard(dir) {
    if (dir === this.guard) return false;
    this.guard = dir;
    if (this.state === 'idle') this.play(GUARD[dir], { fade: 0.09 });
    return true;
  }

  spend(amount) {
    this.stamina = Math.max(0, this.stamina - amount);
    this.staminaTimer = STAMINA_DELAY;
    if (this.stamina <= 0 && this.exhausted <= 0) {
      this.exhausted = EXHAUST_TIME;
      this.events.push({ type: 'exhausted' });
    }
  }

  startAttack(type, dir = this.guard) {
    if (!this.canAct) return false;
    const cost = TIMING[type].stamina;
    if (this.stamina < cost * 0.5) return false;
    this.guard = dir;
    const clip = ATTACK[type][dir];
    const chaining = this.chainWindow > 0 &&
      this.chainStep < this.traits.chainDepth;
    this.chainStep = chaining ? this.chainStep + 1 : 1;
    this.chainWindow = 0;
    const slow = (this.exhausted > 0 ? 1.3 : 1) *
      this.traits.windupMul * (chaining ? 0.62 : 1);
    // Timings are in CLIP time; being exhausted slows the playback rate
    // instead, so every phase stretches consistently.
    this.attack = {
      type, dir,
      windup: clip.windup,
      strike: this.contact[type][dir],
      recover: clip.recover,
      chained: chaining,
      damage: TIMING[type].damage * (this.profile.damageMul ?? 1) *
        this.traits.damageMul *
        // Berserkers hit harder the closer they are to death.
        (1 + this.traits.woundedDamage * (1 - this.health / this.maxHealth)),
      resolved: false,
      unblockable: false,
      timeScale: 1 / slow,
    };
    this.charge = 0;
    this.chargeHeld = type === 'heavy';
    this.spend(cost);
    this.setState('attack', clip, { fade: 0.07 });
    this.events.push({ type: 'swing', attack: this.attack });
    return true;
  }

  /**
   * A connected swing opens a chain: the follow-up winds up far faster, which
   * is what turns single trades into pressure. Only landing or being blocked
   * opens it — whiffing into thin air earns nothing.
   */
  openChain() {
    // chainStep is already 1 after the opening swing, so the test is against
    // the step count itself: depth 2 means the opener plus one follow-up.
    if (this.chainStep >= this.traits.chainDepth) return;
    this.chainWindow = 0.62;
  }

  /** Release a held heavy so the charged/unblockable version fires. */
  releaseCharge() { this.chargeHeld = false; }

  feint() {
    if (this.state !== 'attack') return false;
    if (this.clipTime > this.attack.windup * 0.82) return false;
    if (this.stamina < 8) return false;
    this.spend(8);
    this.attack = null;
    this.charge = 0;
    this.setState('idle', GUARD[this.guard], { fade: 0.10 });
    this.events.push({ type: 'feint' });
    return true;
  }

  startGuardBreak() {
    if (!this.canAct || this.stamina < 8) return false;
    this.spend(9);
    this.gbResolved = false;
    // Reaching for a grab also arms the counter to being grabbed.
    this.gbCounterWindow = 0.38;
    this.setState('gb', GUARDBREAK, { fade: 0.07 });
    this.events.push({ type: 'guardbreak' });
    return true;
  }

  startDodge(dx, dz) {
    if (!this.canAct && this.state !== 'blockReact') return false;
    if (this.stamina < 10) return false;
    if (dx === 0 && dz === 0) dz = -1;
    const len = Math.hypot(dx, dz);
    this.spend(17 * this.traits.dodgeCostMul);
    this.setState('dodge', dodgeClip(dx / len, dz / len), { fade: 0.06 });
    this.events.push({ type: 'dodge' });
    return true;
  }

  // ---------------------------------------------------------------- reactions

  onBlocked(dir, heavy) {
    this.setState('blockReact', BLOCK_REACT[dir], { fade: 0.04 });
    this.blockedRecently = 0.5;
    if (heavy) this.spend(6 * this.traits.blockStaminaMul);
    if (this.exhausted > 0 && heavy) this.onStagger(0.7);
  }

  onParrySuccess(dir) {
    this.setState('parryReact', PARRY_REACT[dir], { fade: 0.04 });
  }

  onStagger(scale = 1) {
    this.attack = null;
    this.setState('stagger', STAGGER, { fade: 0.05 });
    this.staggerScale = scale;
    this.spend(14);
  }

  onThrown() {
    this.attack = null;
    this.setState('thrown', THROWN, { fade: 0.05 });
  }

  takeDamage(amount, dir, heavy) {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - amount);
    this.hitFlash = 0.28;
    if (this.health <= 0) {
      this.attack = null;
      this.setState('dead', DEATH, { fade: 0.06, hold: true });
      this.events.push({ type: 'death' });
      return;
    }
    this.attack = null;
    this.setState('hitstun', hitReact(dir, heavy), { fade: 0.04 });
    this.hitstunTime = heavy ? 0.60 : 0.40;
  }

  /**
   * Bring a fighter back for a fresh round. Health alone is not enough — a
   * corpse left in the `dead` state would end the next round instantly.
   */
  resetForRound() {
    this.health = this.maxHealth;
    this.stamina = STAMINA_MAX;
    this.staminaTimer = 0;
    this.exhausted = 0;
    this.hitFlash = 0;
    this.charge = 0;
    this.chargeHeld = false;
    this.caltropSlow = 0;
    this.revealedUntil = 0;
    this.faceOverride = null;
    this.gbCounterWindow = 0;
    this.gbResolved = true;
    this.blockedRecently = 0;
    this.attack = null;
    this.clipHold = false;
    this.velocity.set(0, 0, 0);
    this.moveInput.set(0, 0);
    this.lastFwd = 0;
    this.lastSide = 0;
    this.stepTimer = 0;
    this.gaitPhase = 0;
    this._ghost = 1;
    this.setState('idle', GUARD[this.guard] || GUARD.right, { fade: 0.01 });
  }

  celebrate() {
    if (this.state === 'dead') return;
    this.setState('victory', VICTORY, { fade: 0.2, hold: true });
  }

  // ------------------------------------------------------------------- update

  update(dt, opponent) {
    this.stateTime += dt;
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    this.blockedRecently = Math.max(0, this.blockedRecently - dt);
    this.gbCounterWindow = Math.max(0, this.gbCounterWindow - dt);

    this.caltropSlow = Math.max(0, this.caltropSlow - dt * 1.6);
    if (this.chainWindow > 0) {
      this.chainWindow -= dt;
      if (this.chainWindow <= 0) this.chainStep = 0;
    }
    if (this.exhausted > 0) this.exhausted -= dt;
    if (this.staminaTimer > 0) this.staminaTimer -= dt;
    else if (this.stamina < STAMINA_MAX) {
      this.stamina = Math.min(STAMINA_MAX,
        this.stamina + STAMINA_REGEN * (this.exhausted > 0 ? 0.55 : 1) *
          this.traits.staminaRegenMul * dt);
    }

    this._advanceClip(dt);
    this._updateState(dt);
    if (opponent && this.alive) this._faceOpponent(opponent, dt);
    this._applyMovement(dt, opponent);
    this._poseRig(dt);
  }

  _advanceClip(dt) {
    const a = this.attack;
    // A held heavy freezes at the top of the windup and charges up.
    if (this.state === 'attack' && a && a.type === 'heavy' &&
        this.chargeHeld && this.clipTime >= a.windup && this.charge < 0.75) {
      this.charge += dt;
      if (this.charge > 0.26 && !a.unblockable) {
        a.unblockable = true;
        a.damage *= 1.35;
        this.events.push({ type: 'unblockable' });
      }
      this.clipTime = a.windup;
      return;
    }
    const scale = (a && this.state === 'attack') ? a.timeScale : 1;
    this.clipTime += dt * scale;
    if (!this.clipHold) {
      this.clipTime = Math.min(this.clipTime, this.clip.duration);
    }
    this.fade = Math.min(1, this.fade + dt / this.fadeTime);
  }

  _updateState(dt) {
    switch (this.state) {
      case 'attack': {
        const a = this.attack;
        if (a && this.clipTime >= this.clip.duration) {
          this.attack = null;
          this.setState('idle', GUARD[this.guard], { fade: 0.14 });
        }
        break;
      }
      case 'blockReact':
      case 'parryReact':
        if (this.clipTime >= this.clip.duration) {
          this.setState('idle', GUARD[this.guard], { fade: 0.12 });
        }
        break;
      case 'hitstun':
        if (this.stateTime >= this.hitstunTime) {
          this.setState('idle', GUARD[this.guard], { fade: 0.14 });
        }
        break;
      case 'stagger':
      case 'thrown':
      case 'dodge':
      case 'gb':
        if (this.clipTime >= this.clip.duration) {
          this.setState('idle', GUARD[this.guard], { fade: 0.14 });
        }
        break;
    }
  }

  _faceOpponent(opponent, dt) {
    // Free look hands yaw to the mouse — but an explicit faceOverride still
    // wins, so anything steering this fighter (the AI, a scripted beat) keeps
    // working regardless of who is nominally holding the camera.
    if (this.freeLook && !this.faceOverride) return;
    if (this.faceOverride) {
      _v.set(this.faceOverride.x - this.pos.x, 0,
        this.faceOverride.z - this.pos.z);
      if (_v.lengthSq() < 1e-6) _v.subVectors(opponent.pos, this.pos);
    } else {
      _v.subVectors(opponent.pos, this.pos);
    }
    const target = Math.atan2(_v.x, _v.z);
    let delta = target - this.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    // Locked on: turn fast, but not instantly, so circling reads as movement.
    const rate = this.state === 'idle' ? 11 : 6;
    this.yaw += delta * Math.min(1, rate * dt);
  }

  _applyMovement(dt, opponent) {
    // Free movement is only available when not committed to an action.
    const mobile = (this.state === 'idle' || this.state === 'blockReact') &&
      !this.frozen;
    const want = _v.set(0, 0, 0);
    if (mobile && this.alive) {
      const fatigue = (this.exhausted > 0 ? 0.72 : 1) * (1 - this.caltropSlow) *
        (this.profile.speedMul ?? 1) * this.traits.speedMul;
      // Advancing is quicker than giving ground, as it should be.
      const fwd = (this.moveInput.y >= 0 ? 2.55 : 2.05) * fatigue;
      want.set(this.moveInput.x * 2.25 * fatigue, 0, this.moveInput.y * fwd);
      want.applyAxisAngle(UP, this.yaw);
    }

    // Bounded acceleration rather than a lerp: gives real weight, and the
    // result does not change with frame rate.
    _v2.subVectors(want, this.velocity);
    const gaining = want.lengthSq() > this.velocity.lengthSq();
    const maxDelta = (gaining ? ACCEL : DECEL) * dt;
    if (_v2.lengthSq() > maxDelta * maxDelta) _v2.setLength(maxDelta);
    this.velocity.add(_v2);
    if (this.velocity.lengthSq() < 1e-4) this.velocity.set(0, 0, 0);
    this.pos.addScaledVector(this.velocity, dt);

    // Root motion authored into the clip (lunges, dodges, stumbles).
    const s = this.outSample;
    const dF = s.fwd - this.lastFwd;
    const dS = s.side - this.lastSide;
    this.lastFwd = s.fwd;
    this.lastSide = s.side;
    // A malformed animation frame must never be able to poison the transform.
    if ((dF || dS) && Number.isFinite(dF) && Number.isFinite(dS)) {
      _v.set(dS, 0, dF).applyAxisAngle(UP, this.yaw);
      this.pos.add(_v);
    }

    // Fighters cannot occupy the same ground.
    if (opponent) {
      _v.subVectors(this.pos, opponent.pos);
      _v.y = 0;
      const d = _v.length();
      const min = BODY_RADIUS * 2;
      if (d < min && d > 1e-4) {
        this.pos.addScaledVector(_v.normalize(), (min - d) * 0.5);
      }
    }
    if (this.collider) this.collider.collide(this.pos, 0.42);
    const r = Math.hypot(this.pos.x, this.pos.z);
    if (r > ARENA_RADIUS) {
      this.pos.multiplyScalar(ARENA_RADIUS / r);
    }
  }

  push(dirVec, amount) {
    _v.copy(dirVec).setY(0).normalize().multiplyScalar(amount);
    this.pos.add(_v);
  }

  _poseRig(dt) {
    const s = this.clip.sample(Math.min(this.clipTime, this.clip.duration),
      this.sample);
    let out = this.sample;
    if (this.fade < 1) {
      out = blendSamples(this.prevSample, this.sample, this.fade, this.outSample);
    } else {
      copySample(this.sample, this.outSample);
      out = this.outSample;
    }

    // Idle breathing, only while genuinely idle.
    if (this.state === 'idle') {
      const sway = idleSway(this.stateTime + this.swaySeed);
      out.y += sway.py;
      out.pose.Torso[0] += sway.pitch;
      out.pose.Torso[1] += sway.yaw * 0.4;
      out.pose.Head[1] -= sway.yaw * 0.3;
    }

    // Locomotion overlay: lean into travel and bob with the gait. Without
    // this the fighter glides around perfectly upright like a chess piece.
    if (this.velocity.lengthSq() > 0.01) {
      _v.copy(this.velocity).applyAxisAngle(UP, -this.yaw);
      const fwd = clamp(_v.z, -2.6, 2.6);
      const side = clamp(_v.x, -2.4, 2.4);
      out.pose.Torso[0] += fwd * 2.3;
      out.pose.Torso[2] += -side * 1.9;
      out.pose.Hips[1] += -side * 2.6;
      out.pose.Head[0] -= fwd * 0.9;
      const swing = Math.min(1, this.velocity.length() / 2.4);
      out.y += Math.sin(this.gaitPhase * Math.PI * 2) * 0.018 * swing;
      out.pose.Hips[2] += Math.sin(this.gaitPhase * Math.PI) * 2.4 * swing;
    }

    this.group.position.copy(this.pos);
    this.group.rotation.set(0, this.yaw, 0);
    this.group.updateMatrixWorld(true);

    const rig = this.rig;
    rig.resetPose();
    rig.applyPose(out.pose);
    const hips = rig.joints.Hips;
    if (hips) hips.position.set(0, HIP_HEIGHT + out.y, 0);
    rig.root.updateMatrixWorld(true);

    this._updateFeet(dt, out);

    _q.setFromAxisAngle(UP, this.yaw);
    for (const side of ['L', 'R']) {
      rig.solveLeg(side, this.feet[side].world, _q, this.feet[side].lift * 55);
    }

    rig.setWeapon(out.p, out.b, out.roll);
    rig.weaponAnchor.updateMatrixWorld(true);
    rig.solveGrips(this.profile.leadHand ?? 'R');
    rig.root.updateMatrixWorld(true);
  }

  /**
   * Locomotion.
   *
   * Two regimes share one step integrator:
   *  - travelling: a cadence clock alternates the feet, and each step is
   *    placed *ahead* of where the body will be, so the fighter walks onto its
   *    feet instead of dragging them behind.
   *  - settling: when near-stationary (turning, lunging, changing stance) a
   *    foot only moves once it is genuinely out of position.
   *
   * Feet are always planted in world space between steps, so nothing skates.
   */
  _updateFeet(dt, out) {
    const speed = this.velocity.length();
    const free = this.state === 'idle' || this.state === 'blockReact';
    const travelling = free && speed > 0.45;

    // Faster movement means quicker, longer, higher steps.
    const cadence = clamp(0.60 - speed * 0.085, 0.25, 0.60);
    const stepTime = clamp(0.30 - speed * 0.050, 0.13, 0.30);
    const lift = 0.045 + Math.min(0.085, speed * 0.032);
    const lead = travelling ? cadence * 0.55 : 0.09;

    for (const side of ['L', 'R']) {
      const f = this.feet[side];
      const target = side === 'L' ? out.feetL : out.feetR;
      _v.copy(target).applyAxisAngle(UP, this.yaw).add(this.pos);
      f.desired.copy(_v);
    }

    const anyStepping = this.feet.L.stepping || this.feet.R.stepping;
    this.stepTimer -= dt;

    if (travelling && !anyStepping && this.stepTimer <= 0) {
      this._beginStep(this.stepSide, lead);
      this.stepSide = this.stepSide === 'L' ? 'R' : 'L';
      this.stepTimer = cadence;
    } else if (!travelling) {
      this.stepTimer = 0;
    }

    for (const side of ['L', 'R']) {
      const f = this.feet[side];
      if (f.stepping) {
        f.t += dt / stepTime;
        if (f.t >= 1) {
          f.stepping = false;
          f.t = 1;
          f.world.copy(f.to).setY(0);
          f.lift = 0;
          this.events.push({ type: 'footstep', side });
        } else {
          // Ease out of the plant and into the next one, arcing over the middle.
          const u = f.t;
          const e = u * u * (3 - 2 * u);
          f.world.lerpVectors(f.from, f.to, e);
          f.lift = Math.sin(u * Math.PI) * lift;
          f.world.y = f.lift;
        }
        continue;
      }
      // Safety net: a foot that has been left behind steps regardless of phase.
      const other = this.feet[side === 'L' ? 'R' : 'L'];
      const dist = f.world.distanceTo(f.desired);
      const trigger = travelling ? STEP_TRIGGER * 1.9 : STEP_TRIGGER;
      if (dist > trigger && (!other.stepping || dist > trigger * 2.1)) {
        this._beginStep(side, lead);
      } else {
        f.world.y = 0;
      }
    }

    // Gait phase drives the pelvis bob; only advances while actually walking.
    if (travelling) this.gaitPhase += dt / Math.max(0.12, cadence);
    else this.gaitPhase += dt * 0.35;
  }

  _beginStep(side, lead) {
    const f = this.feet[side];
    f.stepping = true;
    f.t = 0;
    f.from.copy(f.world);
    f.to.copy(f.desired).addScaledVector(this.velocity, lead);
    f.to.y = 0;
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function newFoot(pos, x, z, yaw) {
  const w = new THREE.Vector3(x, 0, z).applyAxisAngle(UP, yaw).add(pos);
  return {
    world: w.clone(), desired: w.clone(), from: w.clone(), to: w.clone(),
    stepping: false, t: 1, lift: 0,
  };
}

function copySample(src, dst) {
  dst.p.copy(src.p);
  dst.b.copy(src.b);
  dst.roll = src.roll;
  for (const k in src.pose) {
    dst.pose[k][0] = src.pose[k][0];
    dst.pose[k][1] = src.pose[k][1];
    dst.pose[k][2] = src.pose[k][2];
  }
  dst.y = src.y; dst.fwd = src.fwd; dst.side = src.side;
  dst.feetL.copy(src.feetL);
  dst.feetR.copy(src.feetR);
}
