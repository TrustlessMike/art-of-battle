import * as THREE from 'three';
import { OBJECTIVE, SPAWNS } from './layout.js';

/**
 * Match structure, borrowed from Siege and cut down to a duel.
 *
 * A round is: PREP (defender fortifies, attacker scouts) -> ACTION (one life
 * each) -> RESOLVE. Sides swap every round and the match runs to `winsNeeded`.
 * There is no respawn, so every decision in prep is a bet you live with.
 */

export const PHASE = {
  PREP: 'prep',
  ACTION: 'action',
  RESOLVE: 'resolve',
  MATCH_OVER: 'matchover',
};

export const ROLE = { ATTACK: 'attacker', DEFEND: 'defender' };

const PREP_TIME = 25;
const ACTION_TIME = 150;
const RESOLVE_TIME = 4.5;

export class Siege {
  constructor({ player, enemy, compound, duel, winsNeeded = 3 }) {
    this.player = player;
    this.enemy = enemy;
    this.compound = compound;
    this.duel = duel;
    this.winsNeeded = winsNeeded;

    this.round = 0;
    this.score = { player: 0, enemy: 0 };
    this.phase = PHASE.PREP;
    this.timer = PREP_TIME;
    this.events = [];
    this.playerRole = ROLE.ATTACK;
    this.lastResult = null;
  }

  get enemyRole() {
    return this.playerRole === ROLE.ATTACK ? ROLE.DEFEND : ROLE.ATTACK;
  }

  roleOf(fighter) {
    return fighter === this.player ? this.playerRole : this.enemyRole;
  }

  attacker() {
    return this.playerRole === ROLE.ATTACK ? this.player : this.enemy;
  }

  defender() {
    return this.playerRole === ROLE.DEFEND ? this.player : this.enemy;
  }

  emit(e) { this.events.push(e); return e; }

  drain() {
    const out = this.events;
    this.events = [];
    return out;
  }

  // ------------------------------------------------------------------ rounds

  startMatch() {
    this.round = 0;
    this.score = { player: 0, enemy: 0 };
    this.playerRole = ROLE.ATTACK;
    this.startRound();
  }

  startRound() {
    this.round++;
    this.phase = PHASE.PREP;
    this.timer = PREP_TIME;
    this.compound.reset();

    for (const f of [this.player, this.enemy]) {
      f.guard = 'right';
      f.resetForRound();
      f.frozen = true;                 // combat is locked during prep
    }

    const atk = this.attacker();
    const def = this.defender();
    const a = SPAWNS.attacker[(this.round - 1) % SPAWNS.attacker.length];
    const d = SPAWNS.defender[(this.round - 1) % SPAWNS.defender.length];
    placeFighter(atk, a);
    placeFighter(def, d);

    this.duel.reset?.();
    this.emit({
      type: 'roundstart', round: this.round,
      playerRole: this.playerRole, phase: PHASE.PREP,
    });
  }

  /**
   * End preparation early. The attacker has nothing to build, so once they have
   * seen what they need there is no reason to make them watch the clock.
   */
  skipPrep() {
    if (this.phase !== PHASE.PREP) return false;
    this.timer = 0;
    this.beginAction();
    return true;
  }

  beginAction() {
    this.phase = PHASE.ACTION;
    this.timer = ACTION_TIME;
    for (const f of [this.player, this.enemy]) f.frozen = false;
    this.emit({ type: 'phase', phase: PHASE.ACTION });
  }

  endRound(winner, reason) {
    if (this.phase === PHASE.RESOLVE || this.phase === PHASE.MATCH_OVER) return;
    this.phase = PHASE.RESOLVE;
    this.timer = RESOLVE_TIME;
    const playerWon = winner === 'player';
    this.score[playerWon ? 'player' : 'enemy']++;
    this.lastResult = { winner, reason };
    for (const f of [this.player, this.enemy]) f.frozen = true;
    this.emit({ type: 'roundend', winner, reason, score: { ...this.score } });

    if (this.score.player >= this.winsNeeded ||
        this.score.enemy >= this.winsNeeded) {
      this.phase = PHASE.MATCH_OVER;
      this.emit({
        type: 'matchend',
        winner: this.score.player >= this.winsNeeded ? 'player' : 'enemy',
        score: { ...this.score },
      });
    }
  }

  // ------------------------------------------------------------------ update

  update(dt) {
    if (this.phase === PHASE.MATCH_OVER) return;
    this.timer -= dt;

    if (this.phase === PHASE.PREP) {
      if (this.timer <= 0) this.beginAction();
      return;
    }

    if (this.phase === PHASE.RESOLVE) {
      if (this.timer <= 0) {
        // Swap sides and go again.
        this.playerRole = this.enemyRole;
        this.startRound();
      }
      return;
    }

    // ACTION
    const atk = this.attacker();
    const def = this.defender();

    if (this.compound.objective.destroyed) {
      this.endRound(atk === this.player ? 'player' : 'enemy', 'objective');
      return;
    }
    if (!this.player.alive) {
      this.endRound('enemy', 'elimination');
      return;
    }
    if (!this.enemy.alive) {
      this.endRound('player', 'elimination');
      return;
    }
    if (this.timer <= 0) {
      this.endRound(def === this.player ? 'player' : 'enemy', 'timeout');
    }
  }

  /** Attacker damaging the banner — the thing that actually wins rounds. */
  strikeObjective(fighter, amount) {
    if (this.phase !== PHASE.ACTION) return false;
    if (this.roleOf(fighter) !== ROLE.ATTACK) return false;
    const o = this.compound.objective;
    if (o.destroyed) return false;
    const d = Math.hypot(fighter.pos.x - o.x, fighter.pos.z - o.z);
    if (d > o.radius + 1.5) return false;
    const broke = this.compound.damageObjective(amount);
    this.emit({ type: 'objectivehit', amount, hp: o.hp, broke });
    return true;
  }

  get timeText() {
    const t = Math.max(0, this.timer);
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
}

function placeFighter(f, spawn) {
  f.pos.set(spawn.x, 0, spawn.z);
  f.yaw = spawn.yaw ?? 0;
  f.velocity.set(0, 0, 0);
  for (const side of ['L', 'R']) {
    const foot = f.feet[side];
    const off = side === 'L'
      ? new THREE.Vector3(0.19, 0, 0.20)
      : new THREE.Vector3(-0.17, 0, -0.22);
    off.applyAxisAngle(new THREE.Vector3(0, 1, 0), f.yaw).add(f.pos);
    foot.world.copy(off);
    foot.desired.copy(off);
    foot.from.copy(off);
    foot.to.copy(off);
    foot.stepping = false;
    foot.t = 1;
    foot.lift = 0;
  }
}

export { OBJECTIVE };
