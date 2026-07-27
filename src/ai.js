import { DIRS } from './poses.js';
import { PHASE, ROLE } from './round.js';

/**
 * The opposing duellist.
 *
 * It plays by the same rules the player does — it can only read an attack once
 * the windup has started, and it has to commit its guard before the blade
 * arrives. Difficulty is expressed as reaction latency and how often it makes
 * the right read, never as extra damage or hidden information.
 */

const DIFFICULTY = {
  squire: {
    reaction: [0.34, 0.46], blockChance: 0.62, parryChance: 0.08,
    aggression: 0.55, feintChance: 0.05, gbChance: 0.05, chargeChance: 0.08,
    idle: [0.75, 1.5],
  },
  warrior: {
    reaction: [0.24, 0.34], blockChance: 0.80, parryChance: 0.18,
    aggression: 0.75, feintChance: 0.12, gbChance: 0.10, chargeChance: 0.16,
    idle: [0.45, 1.0],
  },
  warlord: {
    reaction: [0.17, 0.25], blockChance: 0.92, parryChance: 0.32,
    aggression: 0.92, feintChance: 0.22, gbChance: 0.14, chargeChance: 0.26,
    idle: [0.28, 0.7],
  },
};

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

export class Opponent {
  constructor(fighter, duel, level = 'warrior') {
    this.f = fighter;
    this.duel = duel;
    this.setDifficulty(level);

    this.reactAt = 0;
    this.reactTo = null;
    this.parryAt = 0;
    this.plan = null;
    this.nextAction = rand(0.6, 1.2);
    this.circle = Math.random() < 0.5 ? 1 : -1;
    this.circleTimer = rand(1, 2.5);
    this.time = 0;
    this.chargeUntil = 0;
    this.feintAt = 0;
    this.path = null;
    this.pathIndex = 0;
    this.repath = 0;
    this.prepTimer = rand(0.6, 1.4);
    this.siege = null;
    this.gadgets = null;
    this.compound = null;
    this.nav = null;
  }

  setDifficulty(level) {
    this.level = level;
    this.cfg = DIFFICULTY[level] ?? DIFFICULTY.warrior;
  }

  reset() {
    this.reactTo = null;
    this.plan = null;
    this.parryAt = 0;
    this.nextAction = rand(0.6, 1.2);
    this.path = null;
    this.pathIndex = 0;
    this.repath = 0;
    this.prepStep = 0;
    this.prepTimer = rand(0.6, 1.4);
    this.f.faceOverride = null;
  }

  update(dt) {
    const f = this.f;
    const foe = this.duel.opponentOf(f);
    if (!f.alive || !foe.alive) {
      f.moveInput.set(0, 0);
      return;
    }
    this.time += dt;

    // No siege wired up: behave as a pure duellist (used by the test harness).
    if (!this.siege) {
      f.faceOverride = null;
      this._observe(foe);
      this._defend(foe);
      this._offend(dt, foe);
      this._move(dt, foe);
      return;
    }

    if (this.siege.phase === PHASE.PREP) {
      f.moveInput.set(0, 0);
      this._prepare(dt, foe);
      return;
    }
    if (this.siege.phase !== PHASE.ACTION) {
      f.moveInput.set(0, 0);
      return;
    }

    const engaged = this._canSee(foe) &&
      f.pos.distanceTo(foe.pos) < f.reach + 2.6;

    if (engaged) {
      f.faceOverride = null;
      this.path = null;
      this._observe(foe);
      this._defend(foe);
      this._offend(dt, foe);
      this._move(dt, foe);
    } else {
      this.reactTo = null;
      this.plan = null;
      this._patrol(dt, foe);
    }
  }

  _canSee(foe) {
    if ((foe.revealedUntil || 0) > this.time) return true;
    const c = this.compound;
    if (!c) return true;
    if (c.losBlocked(this.f.pos.x, this.f.pos.z, foe.pos.x, foe.pos.z)) {
      return false;
    }
    if (this.gadgets?.smokeBlocks(
      this.f.pos.x, this.f.pos.z, foe.pos.x, foe.pos.z)) return false;
    return true;
  }

  // ------------------------------------------------------------------- prep

  /**
   * Defenders spend prep sealing the approaches nearest the banner and
   * hardening the soft wall behind it; attackers just watch.
   */
  _prepare(dt, foe) {
    const f = this.f;
    if (this.siege.roleOf(f) !== ROLE.DEFEND || !this.gadgets) return;
    this.prepTimer -= dt;
    if (this.prepTimer > 0) return;
    this.prepTimer = rand(1.4, 2.6);

    const o = this.compound.objective;
    const near = (a, b) => Math.hypot(a.cx - b.x, a.cz - b.z);

    // 1. Board the openings closest to the objective.
    if (this.gadgets.remaining(f, 'barricade') > 0) {
      const open = [...this.compound.openings.values()]
        .filter((s) => !s.barricade)
        .sort((a, b) => near(a, o) - near(b, o));
      if (open.length && this.gadgets.use(f, 'barricade',
        { openingId: open[0].id })) return;
    }
    // 2. Harden the soft partition shielding it.
    if (this.gadgets.remaining(f, 'reinforce') > 0) {
      const panels = this.compound.surfaces
        .filter((s) => s.kind === 'panel' && s.soft && !s.reinforced && !s.broken)
        .sort((a, b) => Math.hypot(a.x1 - o.x, a.z1 - o.z) -
          Math.hypot(b.x1 - o.x, b.z1 - o.z));
      if (panels.length && this.gadgets.use(f, 'reinforce',
        { surface: panels[0] })) return;
    }
    // 3. Alarm on the approach, caltrops underfoot.
    if (this.gadgets.remaining(f, 'alarm') > 0) {
      f.pos.set(o.x - 3.5, 0, o.z - 3.0);
      if (this.gadgets.use(f, 'alarm', {})) return;
    }
    if (this.gadgets.remaining(f, 'caltrops') > 0) {
      f.pos.set(o.x - 1.6, 0, o.z - 2.2);
      if (this.gadgets.use(f, 'caltrops', {})) return;
    }
    // Settle back onto the objective for the opening seconds.
    f.pos.set(o.x - 2.0, 0, o.z - 2.6);
  }

  // ---------------------------------------------------------------- patrol

  /** Move with purpose when the enemy is not in sight. */
  _patrol(dt, foe) {
    const f = this.f;
    const attacking = this.siege.roleOf(f) === ROLE.ATTACK;
    const o = this.compound.objective;

    let goalX, goalZ;
    if (attacking) {
      goalX = o.x; goalZ = o.z;
    } else {
      // Hold an angle on the banner rather than standing on top of it.
      goalX = o.x - 2.6;
      goalZ = o.z - 3.2;
    }

    const distGoal = Math.hypot(f.pos.x - goalX, f.pos.z - goalZ);

    // Attacker in reach of the banner: break it.
    if (attacking && distGoal < o.radius + 1.2) {
      f.moveInput.set(0, 0);
      f.faceOverride = { x: o.x, z: o.z };
      this.nextAction -= dt;
      if (this.nextAction <= 0 && f.canAct && f.stamina > 25) {
        f.startAttack('heavy', pick(DIRS));
        this.nextAction = rand(0.5, 0.9);
      }
      return;
    }
    if (!attacking && distGoal < 1.4) {
      f.moveInput.set(0, 0);
      f.faceOverride = null;
      return;
    }

    // Sealed out? Then make a door. Without this a defender who barricades
    // well simply wins by default, because the attacker has no way in.
    if (attacking && this.nav &&
        this.nav.path(f.pos.x, f.pos.z, goalX, goalZ) === null) {
      // Close the distance first: breaching from the far side of the compound
      // would spend a charge on a wall that was never the obstacle.
      const near = this.nav.closestReachable(f.pos.x, f.pos.z, goalX, goalZ);
      if (near && Math.hypot(f.pos.x - near.x, f.pos.z - near.z) > 1.6) {
        this._steer(dt, near.x, near.z);
        return;
      }
      if (this._breachIn(dt, goalX, goalZ)) return;
    }

    this._steer(dt, goalX, goalZ);
  }

  /**
   * Make a door. Prefer a charge, which opens anything; failing that, hack at
   * timber with the weapon, which a blade can cut through. Returns false only
   * when there is genuinely nothing to force, so the caller can fall back to
   * ordinary pathing.
   */
  _breachIn(dt, goalX, goalZ) {
    const f = this.f;
    if (!this.compound) return false;

    const charges = this.gadgets ? this.gadgets.remaining(f, 'breach') : 0;
    const hit = this.compound.raycastSurface(f.pos.x, f.pos.z, goalX, goalZ);
    let target = hit ? hit.surface : null;

    // Out of charges: only a soft surface is worth swinging at.
    if (!charges) {
      const soft = (s) => s.kind === 'panel' && s.soft && !s.reinforced;
      if (!target || !soft(target)) {
        target = this.compound.nearestSurface(f.pos.x, f.pos.z, 9, soft)?.surface;
      }
    } else if (!target) {
      target = this.compound.nearestSurface(f.pos.x, f.pos.z, 9)?.surface;
    }
    if (!target) return false;

    const cx = (target.x1 + target.x2) / 2;
    const cz = (target.z1 + target.z2) / 2;
    if (Math.hypot(f.pos.x - cx, f.pos.z - cz) > 1.7) {
      this._steerDirect(dt, cx, cz);
      return true;
    }

    f.moveInput.set(0, 0);
    f.faceOverride = { x: cx, z: cz };

    if (charges) {
      if (this.gadgets.use(f, 'breach', { surface: target })) {
        this.path = null;        // the building just changed shape
        this.repath = 0;
        this.nextAction = rand(0.8, 1.4);
      }
      return true;
    }

    // Chop. A whiffed swing damages whatever it actually reached.
    this.nextAction -= dt;
    if (this.nextAction <= 0 && f.canAct && f.stamina > 26) {
      f.startAttack('heavy', pick(DIRS));
      this.nextAction = rand(0.45, 0.8);
      this.repath = 0;
    }
    return true;
  }

  /** Straight-line walk, for when there is no path to follow. */
  _steerDirect(dt, tx, tz) {
    const f = this.f;
    const dx = tx - f.pos.x;
    const dz = tz - f.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    f.faceOverride = { x: tx, z: tz };
    const align = Math.cos(f.yaw) * (dz / len) + Math.sin(f.yaw) * (dx / len);
    f.moveInput.set(0, align > 0.4 ? 1 : 0.25);
  }

  /** Follow a nav path, recomputing when it goes stale or gets blocked. */
  _steer(dt, goalX, goalZ) {
    const f = this.f;
    this.repath -= dt;
    if (!this.path || this.repath <= 0) {
      this.path = this.nav ? this.nav.path(f.pos.x, f.pos.z, goalX, goalZ) : [];
      this.pathIndex = 0;
      this.repath = 1.2;
    }

    let tx = goalX, tz = goalZ;
    if (this.path && this.path.length) {
      while (this.pathIndex < this.path.length) {
        const wp = this.path[this.pathIndex];
        // A doorway has to be reached properly, not merely approached: the
        // generous room radius lets a fighter "arrive" at a door from the
        // wrong side, skip to the next waypoint, and walk into the wall beside
        // it. Portals therefore need a radius smaller than the gap is wide.
        const arrive = (wp.kind === 'opening' || wp.kind === 'gap') ? 0.34 : 0.75;
        if (Math.hypot(f.pos.x - wp.x, f.pos.z - wp.z) < arrive) {
          this.pathIndex++;
        } else break;
      }
      const wp = this.path[Math.min(this.pathIndex, this.path.length - 1)];
      tx = wp.x; tz = wp.z;
    }

    const dx = tx - f.pos.x;
    const dz = tz - f.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    f.faceOverride = { x: tx, z: tz };
    // moveInput is in the fighter's own frame; it is already turning to face
    // the waypoint, so simply drive forward.
    const align = Math.cos(f.yaw) * (dz / len) + Math.sin(f.yaw) * (dx / len);
    f.moveInput.set(0, align > 0.4 ? 1 : 0.25);
  }

  /** Notice a new attack and start the reaction clock. */
  _observe(foe) {
    const a = foe.state === 'attack' ? foe.attack : null;
    if (a && a !== this.reactTo && !a.resolved) {
      this.reactTo = a;
      const [lo, hi] = this.cfg.reaction;
      this.reactAt = this.time + rand(lo, hi);
      this.plan = null;
      this.parryAt = 0;
    }
    if (!a && this.reactTo && this.reactTo.resolved) {
      this.reactTo = null;
      this.plan = null;
    }
  }

  _defend(foe) {
    const f = this.f;
    const a = this.reactTo;
    if (!a || a.resolved) return;

    // Decide once, after the reaction delay has elapsed.
    if (!this.plan && this.time >= this.reactAt) {
      const late = foe.clipTime > a.strike - 0.06;
      if (late) {
        this.plan = 'toolate';
      } else if (a.unblockable) {
        this.plan = Math.random() < 0.72 ? 'dodge' : 'parry';
      } else if (Math.random() < this.cfg.parryChance) {
        this.plan = 'parry';
      } else if (Math.random() < this.cfg.blockChance) {
        this.plan = 'block';
      } else {
        this.plan = 'mistake';
      }

      if (this.plan === 'block' || this.plan === 'parry') {
        f.setGuard(a.dir);
      } else if (this.plan === 'mistake') {
        f.setGuard(pick(DIRS.filter((d) => d !== a.dir)));
      }
      if (this.plan === 'parry') {
        // Aim for the parry window, but land inside it imperfectly.
        this.parryAt = this.time + (a.strike - foe.clipTime) -
          rand(0.02, 0.16);
      }
    }

    if (this.plan === 'parry' && this.parryAt && this.time >= this.parryAt) {
      this.parryAt = 0;
      if (!this.duel.tryParry(f)) {
        // Mistimed: the heavy comes out anyway, which is the honest penalty.
        f.startAttack('heavy', f.guard);
      }
    }
    if (this.plan === 'dodge' && foe.clipTime > a.strike - 0.26) {
      this.plan = 'dodged';
      const dx = Math.random() < 0.5 ? -1 : 1;
      f.startDodge(dx, Math.random() < 0.35 ? -0.6 : 0);
    }
  }

  _offend(dt, foe) {
    const f = this.f;
    this.nextAction -= dt;

    /**
     * Chain pressure. A connected swing leaves a short window where the
     * follow-up comes out far faster; spending it is the difference between
     * an opponent who trades and one who runs you down. The direction is
     * deliberately switched so the chain is a mixup, not a repeat.
     */
    if (f.chainWindow > 0 && f.canAct && f.stamina > 22 &&
        this.cfg.aggression > Math.random()) {
      const dir = pick(DIRS.filter((d) => d !== foe.guard && d !== f.guard))
        || pick(DIRS.filter((d) => d !== f.guard));
      // Finish a chain with a heavy now and then, so it is not all lights.
      const heavy = f.chainStep >= 2 && Math.random() < 0.4;
      if (f.startAttack(heavy ? 'heavy' : 'light', dir)) {
        this.nextAction = rand(0.3, 0.6);
        return;
      }
    }

    // Free punish: they are wide open, take the heaviest thing available.
    const open = foe.state === 'stagger' || foe.state === 'thrown';
    if (open && f.canAct && f.stamina > 25) {
      const dir = pick(DIRS);
      if (f.startAttack('heavy', dir)) {
        this.nextAction = rand(0.5, 0.9);
        return;
      }
    }

    if (this.chargeUntil && this.time >= this.chargeUntil) {
      this.chargeUntil = 0;
      f.releaseCharge();
    }
    if (this.feintAt && this.time >= this.feintAt) {
      this.feintAt = 0;
      if (f.feint()) this.nextAction = rand(0.12, 0.3);
      return;
    }

    if (this.nextAction > 0 || !f.canAct) return;
    if (this.reactTo && !this.reactTo.resolved && this.plan !== 'toolate') return;

    const dist = f.pos.distanceTo(foe.pos);
    if (dist > f.reach) {
      this.nextAction = 0.15;
      return;
    }
    if (f.stamina < 28) {
      this.nextAction = rand(0.5, 1.0);
      return;
    }

    const cfg = this.cfg;
    if (Math.random() > cfg.aggression) {
      this.nextAction = rand(...cfg.idle);
      return;
    }

    const roll = Math.random();
    // Prefer a lane their guard is not already covering.
    const dir = Math.random() < 0.78
      ? pick(DIRS.filter((d) => d !== foe.guard))
      : pick(DIRS);

    if (roll < cfg.gbChance && foe.blockedRecently > 0) {
      f.startGuardBreak();
      this.nextAction = rand(0.6, 1.0);
    } else if (roll < cfg.gbChance + cfg.chargeChance) {
      if (f.startAttack('heavy', dir)) {
        f.chargeHeld = true;
        this.chargeUntil = this.time + rand(0.32, 0.62);
        this.nextAction = rand(1.0, 1.6);
      }
    } else if (roll < 0.66) {
      f.startAttack('light', dir);
      this.nextAction = rand(0.35, 0.8);
    } else {
      if (f.startAttack('heavy', dir)) {
        if (Math.random() < cfg.feintChance) {
          this.feintAt = this.time + rand(0.18, 0.4);
        }
        this.nextAction = rand(0.7, 1.2);
      }
    }
  }

  _move(dt, foe) {
    const f = this.f;
    this.circleTimer -= dt;
    if (this.circleTimer <= 0) {
      this.circle = Math.random() < 0.5 ? 1 : -1;
      this.circleTimer = rand(1.0, 2.8);
    }

    const dist = f.pos.distanceTo(foe.pos);
    const ideal = f.reach - 0.28;
    let forward = 0;
    if (dist > ideal + 0.20) forward = 1;
    else if (dist < ideal - 0.35) forward = -1;

    // Back off to breathe when gassed.
    if (f.stamina < 22) forward = -1;

    const strafe = this.circle * (dist < ideal + 0.8 ? 0.75 : 0.25);
    f.moveInput.set(strafe, forward);
  }
}
