import * as THREE from 'three';

/**
 * Interaction rules — the "Art of Battle" layer.
 *
 * An attack has one resolution instant (`strike`). Everything the defender can
 * do is expressed relative to that instant:
 *   - matching guard, passively             -> block
 *   - heavy pressed inside the parry window -> parry (attacker is staggered)
 *   - dodge i-frames                        -> whiff
 *   - anything else                         -> damage
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export const PARRY_WINDOW = 0.26;
const GB_RANGE = 2.05;
const GB_REACH_TIME = 0.22;

export class Duel {
  constructor(a, b) {
    this.a = a;
    this.b = b;
    this.events = [];
    this.hitStop = 0;
    this.over = false;
  }

  get fighters() { return [this.a, this.b]; }

  opponentOf(f) { return f === this.a ? this.b : this.a; }

  emit(e) { this.events.push(e); return e; }

  update() {
    for (const f of this.fighters) {
      const foe = this.opponentOf(f);
      if (f.state === 'attack' && f.attack && !f.attack.resolved &&
          f.clipTime >= f.attack.strike) {
        this.resolveStrike(f, foe);
      }
      if (f.state === 'gb' && !f.gbResolved && f.clipTime >= GB_REACH_TIME) {
        this.resolveGuardBreak(f, foe);
      }
    }
    if (!this.over) {
      for (const f of this.fighters) {
        if (!f.alive) {
          this.over = true;
          this.winner = this.opponentOf(f);
          this.emit({ type: 'matchover', winner: this.winner, loser: f });
        }
      }
    }
  }

  /** Geometry gate shared by strikes and guard breaks. */
  _inRange(attacker, defender, reach) {
    _v.subVectors(defender.pos, attacker.pos);
    _v.y = 0;
    const dist = _v.length();
    if (dist > reach) return false;
    _v2.set(Math.sin(attacker.yaw), 0, Math.cos(attacker.yaw));
    return _v.normalize().dot(_v2) > 0.25;
  }

  contactPoint(attacker, defender, out = new THREE.Vector3()) {
    attacker.rig.bladeTip(out);
    _v.copy(defender.pos).setY(1.15);
    return out.lerp(_v, 0.45);
  }

  resolveStrike(attacker, defender) {
    const a = attacker.attack;
    a.resolved = true;
    const dir = a.dir;
    const heavy = a.type === 'heavy';
    const point = this.contactPoint(attacker, defender);

    if (!this._inRange(attacker, defender, attacker.reach)) {
      this.emit({ type: 'whiff', attacker, defender, dir, heavy, point });
      return;
    }
    if (defender.invulnerable) {
      this.emit({ type: 'dodged', attacker, defender, dir, heavy, point });
      return;
    }
    if (!a.unblockable && defender.canBlock && defender.guard === dir) {
      defender.onBlocked(dir, heavy);
      attacker.openChain();          // a blocked swing still earns pressure
      _v.subVectors(defender.pos, attacker.pos);
      defender.push(_v, heavy ? 0.30 : 0.14);
      this.hitStop = Math.max(this.hitStop, heavy ? 0.055 : 0.035);
      this.emit({ type: 'block', attacker, defender, dir, heavy, point });
      return;
    }

    let dmg = a.damage * (defender.exhausted > 0 ? 1.2 : 1);
    // Reading the line right still pays even when the guard cannot stop it.
    if (defender.guard === dir) dmg *= 1 - (defender.traits?.guardReduction ?? 0);
    // Punishing the helpless is what the Executioner and Duellist are for.
    if (defender.state === 'stagger' || defender.state === 'thrown') {
      dmg *= attacker.traits?.staggeredDamageMul ?? 1;
    }
    attacker.openChain();
    defender.takeDamage(dmg, dir, heavy);
    _v.subVectors(defender.pos, attacker.pos);
    defender.push(_v, heavy ? 0.34 : 0.16);
    this.hitStop = Math.max(this.hitStop, heavy ? 0.09 : 0.06);
    this.emit({
      type: 'hit', attacker, defender, dir, heavy, point,
      damage: Math.round(dmg), unblockable: a.unblockable,
    });
  }

  /**
   * Called the moment a fighter presses heavy. If an enemy blade is arriving
   * on the guarded line right now, that input becomes a parry instead of an
   * attack — mistime it and you are stuck in a windup.
   */
  tryParry(defender) {
    const attacker = this.opponentOf(defender);
    if (attacker.state !== 'attack' || !attacker.attack) return false;
    const a = attacker.attack;
    if (a.resolved) return false;
    if (!defender.canBlock) return false;
    if (defender.guard !== a.dir) return false;
    const window = PARRY_WINDOW * (defender.traits?.parryWindowMul ?? 1);
    const remaining = a.strike - attacker.clipTime;
    if (remaining > window || remaining < -0.05) return false;
    if (!this._inRange(attacker, defender, attacker.reach + 0.5)) return false;

    a.resolved = true;
    const point = this.contactPoint(attacker, defender);
    attacker.onStagger();
    _v.subVectors(attacker.pos, defender.pos);
    attacker.push(_v, 0.36);
    defender.onParrySuccess(a.dir);
    defender.stamina = Math.min(100,
      defender.stamina + 10 + (defender.traits?.staminaOnParry ?? 0));
    this.hitStop = Math.max(this.hitStop, 0.1);
    this.emit({ type: 'parry', attacker: defender, defender: attacker,
      dir: a.dir, point });
    return true;
  }

  resolveGuardBreak(attacker, defender) {
    attacker.gbResolved = true;
    const point = this.contactPoint(attacker, defender);
    if (!this._inRange(attacker, defender, GB_RANGE) || defender.invulnerable) {
      this.emit({ type: 'gbwhiff', attacker, defender, point });
      return;
    }
    if (defender.gbCounterWindow > 0) {
      attacker.onThrown();
      _v.subVectors(attacker.pos, defender.pos);
      attacker.push(_v, 0.4);
      this.hitStop = Math.max(this.hitStop, 0.08);
      this.emit({ type: 'gbcounter', attacker: defender, defender: attacker, point });
      return;
    }
    // Swinging beats a grab: the attacker eats the interruption.
    if (defender.state === 'attack' && defender.attackPhase !== 'recover') {
      attacker.onStagger(0.6);
      this.emit({ type: 'gbwhiff', attacker, defender, point });
      return;
    }
    defender.onThrown();
    _v.subVectors(defender.pos, attacker.pos);
    defender.push(_v, 0.55);
    this.hitStop = Math.max(this.hitStop, 0.06);
    this.emit({ type: 'gbhit', attacker, defender, point });
  }

  drain() {
    const out = this.events;
    this.events = [];
    return out;
  }
}
