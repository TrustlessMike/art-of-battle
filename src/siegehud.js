import * as THREE from 'three';
import { GADGETS } from './gadgets.js';
import { PHASE, ROLE } from './round.js';

/**
 * The siege overlay: round state, the objective, your utility, and intel.
 *
 * The rule this enforces is that the player only ever sees what they have
 * earned — the enemy marker appears when you have line of sight or your alarm
 * tripped, never otherwise.
 */

const _p = new THREE.Vector3();

const C = {
  text: '#d7dee9',
  dim: 'rgba(215,222,233,0.45)',
  attack: '#e08a3c',
  defend: '#6fb3ff',
  objective: '#e0c45a',
  danger: '#e0392b',
  win: '#9ee08a',
};

export class SiegeHUD {
  constructor(hud) {
    this.hud = hud;          // reuse the base HUD's canvas, scale and projection
  }

  get ctx() { return this.hud.ctx; }
  get w() { return this.hud.w; }
  get h() { return this.hud.h; }
  get s() { return this.hud.s; }

  draw(dt, state) {
    const { siege, compound, gadgets, player, camera, enemy,
      enemyVisible, time } = state;
    const c = this.ctx;

    this._roundBar(c, siege);
    this._role(c, siege);
    this._objective(c, siege, compound, camera, player);
    this._gadgets(c, siege, gadgets, player);
    if (siege.phase === PHASE.PREP) {
      this._matchup(c, siege, player, enemy);
      this._prep(c, siege, gadgets, player);
    }
    if (siege.phase === PHASE.RESOLVE) this._roundResult(c, siege);
    if (siege.phase === PHASE.MATCH_OVER) this._matchResult(c, siege);
    this._enemyMarker(c, enemy, camera, enemyVisible, time);
  }

  // ------------------------------------------------------------ round state

  _roundBar(c, siege) {
    const s = this.s;
    const cx = this.w / 2;
    c.save();
    c.textAlign = 'center';

    const urgent = siege.phase === PHASE.ACTION && siege.timer < 20;
    c.font = `700 ${30 * s}px ui-sans-serif, system-ui, sans-serif`;
    c.fillStyle = urgent ? C.danger : C.text;
    c.letterSpacing = `${2 * s}px`;
    c.shadowColor = 'rgba(0,0,0,0.85)';
    c.shadowBlur = 8;
    c.fillText(siege.timeText, cx, 42 * s);

    c.font = `600 ${11 * s}px ui-sans-serif, system-ui, sans-serif`;
    c.letterSpacing = `${3 * s}px`;
    c.fillStyle = C.dim;
    const label = {
      [PHASE.PREP]: 'PREPARATION',
      [PHASE.ACTION]: `ROUND ${siege.round}`,
      [PHASE.RESOLVE]: 'ROUND OVER',
      [PHASE.MATCH_OVER]: 'MATCH OVER',
    }[siege.phase] || '';
    c.fillText(label, cx, 60 * s);

    // Score pips: yours left, theirs right.
    const pip = 9 * s;
    const gap = 6 * s;
    const need = siege.winsNeeded;
    for (let i = 0; i < need; i++) {
      c.beginPath();
      c.arc(cx - 74 * s - i * (pip + gap), 36 * s, pip / 2, 0, Math.PI * 2);
      c.fillStyle = i < siege.score.player ? C.win : 'rgba(215,222,233,0.18)';
      c.fill();
      c.beginPath();
      c.arc(cx + 74 * s + i * (pip + gap), 36 * s, pip / 2, 0, Math.PI * 2);
      c.fillStyle = i < siege.score.enemy ? C.danger : 'rgba(215,222,233,0.18)';
      c.fill();
    }
    c.restore();
  }

  _role(c, siege) {
    const s = this.s;
    const atk = siege.playerRole === ROLE.ATTACK;
    c.save();
    c.textAlign = 'left';
    c.font = `800 ${15 * s}px ui-sans-serif, system-ui, sans-serif`;
    c.letterSpacing = `${4 * s}px`;
    c.fillStyle = atk ? C.attack : C.defend;
    c.shadowColor = 'rgba(0,0,0,0.85)';
    c.shadowBlur = 6;
    c.fillText(atk ? 'ATTACK' : 'DEFEND', 42 * s, 44 * s);
    c.font = `500 ${11 * s}px ui-sans-serif, system-ui, sans-serif`;
    c.letterSpacing = `${1 * s}px`;
    c.fillStyle = C.dim;
    c.fillText(atk ? 'Destroy the banner' : 'Hold the chapel',
      42 * s, 62 * s);
    c.restore();
  }

  // -------------------------------------------------------------- objective

  _objective(c, siege, compound, camera, player) {
    const s = this.s;
    const o = compound.objective;
    const frac = o.hp / o.maxHp;

    // Bar under the role badge.
    const x = 42 * s, y = 76 * s, w = 168 * s, h = 7 * s;
    c.save();
    c.fillStyle = 'rgba(10,12,16,0.7)';
    c.fillRect(x, y, w, h);
    c.fillStyle = o.destroyed ? C.danger : C.objective;
    c.fillRect(x, y, w * Math.max(0, frac), h);
    c.strokeStyle = 'rgba(255,255,255,0.2)';
    c.lineWidth = 1;
    c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    c.font = `600 ${9 * s}px ui-sans-serif, system-ui, sans-serif`;
    c.fillStyle = C.dim;
    c.textAlign = 'left';
    c.fillText('BANNER', x, y - 4 * s);
    c.restore();

    // World marker, so you always know which way the objective is.
    _p.set(o.x, 2.4, o.z);
    const sp = this.hud.project(_p, camera);
    const dist = Math.hypot(player.pos.x - o.x, player.pos.z - o.z);
    c.save();
    c.textAlign = 'center';
    if (!sp.behind && sp.x > 0 && sp.x < this.w) {
      c.globalAlpha = 0.85;
      c.strokeStyle = C.objective;
      c.lineWidth = 2 * s;
      const r = 11 * s;
      c.beginPath();
      c.moveTo(sp.x, sp.y - r);
      c.lineTo(sp.x + r, sp.y);
      c.lineTo(sp.x, sp.y + r);
      c.lineTo(sp.x - r, sp.y);
      c.closePath();
      c.stroke();
      c.font = `600 ${10 * s}px ui-sans-serif, system-ui, sans-serif`;
      c.fillStyle = C.objective;
      c.fillText(`${dist.toFixed(0)}m`, sp.x, sp.y + 26 * s);
    } else {
      // Off screen: pin an arrow to the edge pointing the way.
      const ang = Math.atan2(o.x - player.pos.x, o.z - player.pos.z);
      const rel = ang - Math.atan2(
        camera.position.x - player.pos.x === 0 ? 1 : (player.pos.x - camera.position.x),
        player.pos.z - camera.position.z);
      const ex = this.w / 2 + Math.sin(rel) * this.w * 0.42;
      c.globalAlpha = 0.7;
      c.fillStyle = C.objective;
      c.beginPath();
      c.moveTo(ex, 96 * s);
      c.lineTo(ex - 8 * s, 82 * s);
      c.lineTo(ex + 8 * s, 82 * s);
      c.closePath();
      c.fill();
      c.font = `600 ${10 * s}px ui-sans-serif, system-ui, sans-serif`;
      c.fillText(`${dist.toFixed(0)}m`, ex, 112 * s);
    }
    c.restore();
  }

  // ---------------------------------------------------------------- gadgets

  _gadgets(c, siege, gadgets, player) {
    const s = this.s;
    const phase = siege.phase === PHASE.PREP ? 'prep' : 'action';
    const inv = gadgets.inventory.get(player) || {};
    const kinds = Object.keys(inv);
    if (!kinds.length) return;

    const boxW = 128 * s, boxH = 36 * s, gap = 7 * s;
    const total = kinds.length * boxW + (kinds.length - 1) * gap;
    let x = this.w / 2 - total / 2;
    const y = this.h - 118 * s;

    c.save();
    kinds.forEach((kind, i) => {
      const spec = GADGETS[kind];
      const usable = inv[kind] > 0 &&
        (spec.phase === 'any' || spec.phase === phase);
      c.fillStyle = usable ? 'rgba(16,20,27,0.78)' : 'rgba(16,20,27,0.4)';
      c.fillRect(x, y, boxW, boxH);
      c.strokeStyle = usable ? 'rgba(215,222,233,0.35)' : 'rgba(215,222,233,0.12)';
      c.lineWidth = 1;
      c.strokeRect(x + 0.5, y + 0.5, boxW - 1, boxH - 1);

      c.textAlign = 'left';
      c.font = `700 ${10 * s}px ui-sans-serif, system-ui, sans-serif`;
      c.fillStyle = usable ? C.text : C.dim;
      c.fillText(`${i + 1}`, x + 7 * s, y + 14 * s);
      c.font = `600 ${10 * s}px ui-sans-serif, system-ui, sans-serif`;
      c.fillText(spec.label.toUpperCase(), x + 20 * s, y + 14 * s);
      c.font = `500 ${9 * s}px ui-sans-serif, system-ui, sans-serif`;
      c.fillStyle = C.dim;
      c.fillText(spec.hint, x + 7 * s, y + 28 * s);

      c.textAlign = 'right';
      c.font = `700 ${12 * s}px ui-sans-serif, system-ui, sans-serif`;
      c.fillStyle = usable ? C.text : C.dim;
      c.fillText(`${inv[kind]}`, x + boxW - 7 * s, y + 15 * s);
      x += boxW + gap;
    });
    c.restore();
  }

  /**
   * The matchup card. Siege shows you the operators before the round; the
   * equivalent here is the two builds, because knowing you are about to fight
   * a Bulwark rather than a Berserker is what prep is *for*.
   */
  _matchup(c, siege, player, enemy) {
    const s = this.s;
    const cx = this.w / 2;
    const y = this.h * 0.47;   // clear of the round banner at 0.29
    // Fade in over the first moment of prep, out over the last.
    const t = siege.timer;
    const fade = Math.min(1, Math.min((25 - t) / 0.8, t / 2.5));
    if (fade <= 0) return;

    c.save();
    c.globalAlpha = Math.max(0, fade);
    c.textAlign = 'center';

    c.font = `600 ${10 * s}px ui-sans-serif, system-ui, sans-serif`;
    c.letterSpacing = `${5 * s}px`;
    c.fillStyle = C.dim;
    c.shadowColor = 'rgba(0,0,0,0.9)';
    c.shadowBlur = 10;
    c.fillText('THE MATCHUP', cx, y - 34 * s);

    const side = (f, dx, align, colour) => {
      c.textAlign = align;
      const px = cx + dx;
      c.font = `800 ${25 * s}px ui-sans-serif, system-ui, sans-serif`;
      c.letterSpacing = `${2 * s}px`;
      c.fillStyle = colour;
      c.fillText((f.archetypeName || '—').toUpperCase(), px, y);
      c.font = `500 ${12 * s}px ui-sans-serif, system-ui, sans-serif`;
      c.letterSpacing = `${1 * s}px`;
      c.fillStyle = C.text;
      c.fillText(f.name, px, y + 22 * s);
      c.font = `500 ${10 * s}px ui-sans-serif, system-ui, sans-serif`;
      c.fillStyle = C.dim;
      const t2 = f.traits || {};
      const notes = [
        `${f.maxHealth} hp`,
        `chain ${t2.chainDepth ?? 2}`,
        t2.parryWindowMul > 1 ? 'wide parry' : null,
        t2.guardReduction > 0 ? 'hardened guard' : null,
        t2.dodgeIFrameMul > 1 ? 'evasive' : null,
        t2.woundedDamage > 0 ? 'rages when hurt' : null,
      ].filter(Boolean).join('  ·  ');
      c.fillText(notes, px, y + 40 * s);
    };

    side(player, -26 * s, 'right', C.defend);
    side(enemy, 26 * s, 'left', C.attack);

    c.textAlign = 'center';
    c.font = `700 ${16 * s}px ui-sans-serif, system-ui, sans-serif`;
    c.fillStyle = C.dim;
    c.fillText('vs', cx, y);
    c.restore();
  }

  _prep(c, siege, gadgets, player) {
    const s = this.s;
    c.save();
    c.textAlign = 'center';
    c.font = `500 ${12 * s}px ui-sans-serif, system-ui, sans-serif`;
    c.fillStyle = C.dim;
    c.shadowColor = 'rgba(0,0,0,0.8)';
    c.shadowBlur = 5;
    const atk = siege.playerRole === ROLE.ATTACK;
    c.fillText(
      atk ? 'SCOUT THE COMPOUND — mouse looks · WASD pans · ENTER sounds the horn'
        : 'FORTIFY — face a door, window or wall and press a number',
      this.w / 2, this.h - 142 * s);
    c.restore();
  }

  _roundResult(c, siege) {
    const s = this.s;
    const r = siege.lastResult;
    if (!r) return;
    const won = r.winner === 'player';
    c.save();
    c.textAlign = 'center';
    c.font = `800 ${44 * s}px ui-sans-serif, system-ui, sans-serif`;
    c.letterSpacing = `${8 * s}px`;
    c.fillStyle = won ? C.win : C.danger;
    c.shadowColor = 'rgba(0,0,0,0.9)';
    c.shadowBlur = 16;
    c.fillText(won ? 'ROUND WON' : 'ROUND LOST', this.w / 2, this.h * 0.36);
    c.font = `500 ${14 * s}px ui-sans-serif, system-ui, sans-serif`;
    c.letterSpacing = `${3 * s}px`;
    c.fillStyle = C.text;
    const reason = {
      objective: won ? 'The banner is down' : 'They brought the banner down',
      elimination: won ? 'Opponent slain' : 'You were slain',
      timeout: won ? 'You held the compound' : 'Time ran out',
    }[r.reason] || '';
    c.fillText(reason.toUpperCase(), this.w / 2, this.h * 0.36 + 34 * s);
    c.fillStyle = C.dim;
    c.fillText('SIDES SWAP', this.w / 2, this.h * 0.36 + 58 * s);
    c.restore();
  }

  _matchResult(c, siege) {
    const s = this.s;
    const won = siege.score.player > siege.score.enemy;
    c.save();
    c.fillStyle = won ? 'rgba(10,18,26,0.55)' : 'rgba(26,8,8,0.55)';
    c.fillRect(0, 0, this.w, this.h);
    c.textAlign = 'center';
    c.font = `800 ${66 * s}px ui-sans-serif, system-ui, sans-serif`;
    c.letterSpacing = `${10 * s}px`;
    c.fillStyle = won ? '#f0e6d2' : '#e0554a';
    c.shadowColor = 'rgba(0,0,0,0.9)';
    c.shadowBlur = 20;
    c.fillText(won ? 'COMPOUND TAKEN' : 'COMPOUND HELD', this.w / 2, this.h / 2);
    c.font = `500 ${16 * s}px ui-sans-serif, system-ui, sans-serif`;
    c.letterSpacing = `${3 * s}px`;
    c.fillStyle = 'rgba(230,235,245,0.8)';
    c.fillText(`${siege.score.player} — ${siege.score.enemy}`,
      this.w / 2, this.h / 2 + 40 * s);
    c.fillText('PRESS R FOR A NEW MATCH', this.w / 2, this.h / 2 + 68 * s);
    c.restore();
  }

  _enemyMarker(c, enemy, camera, visible, time) {
    const revealed = (enemy.revealedUntil || 0) > time;
    if (!visible && !revealed) return;
    _p.copy(enemy.pos).setY(2.15);
    const sp = this.hud.project(_p, camera);
    if (sp.behind) return;
    const s = this.s;
    c.save();
    c.globalAlpha = visible ? 0.5 : 0.85;
    c.strokeStyle = revealed && !visible ? C.attack : 'rgba(224,57,43,0.9)';
    c.lineWidth = 2 * s;
    const r = 8 * s;
    c.beginPath();
    c.moveTo(sp.x - r, sp.y + r);
    c.lineTo(sp.x, sp.y - r);
    c.lineTo(sp.x + r, sp.y + r);
    c.stroke();
    if (revealed && !visible) {
      c.font = `600 ${9 * s}px ui-sans-serif, system-ui, sans-serif`;
      c.textAlign = 'center';
      c.fillStyle = C.attack;
      c.fillText('HEARD', sp.x, sp.y - 14 * s);
    }
    c.restore();
  }
}
