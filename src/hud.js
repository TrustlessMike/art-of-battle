import * as THREE from 'three';

/**
 * The readability layer. Everything the player needs in order to make a
 * decision inside a 400ms window: which way the enemy is guarding, which way
 * their blade is coming from, and whether it can be blocked at all.
 */

const _p = new THREE.Vector3();

const DIR_ANGLE = { top: -90, right: 30, left: 150 };  // canvas degrees
const ARC = 40;                                        // half-width, degrees
const RAD = Math.PI / 180;

const COL = {
  steel: '#c9d2de',
  dim: 'rgba(201,210,222,0.22)',
  attack: '#e0392b',
  unblock: '#ff8a12',
  parry: '#ffe27a',
  player: '#6fb3ff',
  health: '#d8dee8',
  healthLost: '#5c2323',
  stamina: '#8ad6a0',
  staminaLow: '#d8a03a',
};

export class HUD {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.messages = [];
    this.floats = [];
    this.time = 0;
    this.hintTimer = 9;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // Never zero: a hidden tab reports 0x0 and every scale below divides by it.
    this.w = Math.max(1, window.innerWidth || 0);
    this.h = Math.max(1, window.innerHeight || 0);
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dpr = dpr;
    // Scale the whole overlay so it never overflows a narrow viewport.
    this.s = Math.max(0.58, Math.min(1, Math.min(this.w / 1180, this.h / 780)));
  }

  say(text, color = COL.steel, ttl = 1.1, big = false) {
    this.messages.unshift({ text, color, ttl, age: 0, big });
    if (this.messages.length > 4) this.messages.pop();
  }

  float(worldPoint, text, color) {
    this.floats.push({
      p: worldPoint.clone(), text, color, age: 0, ttl: 1.0,
      drift: (Math.random() - 0.5) * 30,
    });
  }

  project(v, camera) {
    _p.copy(v).project(camera);
    return {
      x: (_p.x * 0.5 + 0.5) * this.w,
      y: (-_p.y * 0.5 + 0.5) * this.h,
      behind: _p.z > 1,
    };
  }

  draw(dt, ctxState) {
    const { player, enemy, camera, duel, paused, showIndicator = true } = ctxState;
    this.time += dt;
    this.hintTimer -= dt;
    const c = this.ctx;
    c.clearRect(0, 0, this.w, this.h);

    // The guard widget is intel: it only appears when you can actually see them.
    if (showIndicator) this._drawIndicator(c, player, enemy, camera, duel);
    this._drawBars(c, player, enemy);
    this._drawFloats(c, dt, camera);
    this._drawMessages(c, dt);
    if (this.hintTimer > 0) this._drawHints(c);
    if (paused) this._drawPaused(c, ctxState.started);
  }

  // ------------------------------------------------------------- guard widget

  _drawIndicator(c, player, enemy, camera, duel) {
    if (!enemy.alive || !player.alive) return;
    _p.copy(enemy.pos).setY(1.25);
    const s = this.project(_p, camera);
    if (s.behind) return;

    const R = 62;
    const rIn = 40;
    c.save();
    c.translate(s.x, s.y);
    c.lineCap = 'butt';

    const atk = enemy.state === 'attack' && enemy.attack &&
      !enemy.attack.resolved ? enemy.attack : null;
    const incoming = atk ? atk.dir : null;
    const unblockable = atk?.unblockable;

    // Base ring: the enemy's three lanes.
    for (const dir of ['top', 'left', 'right']) {
      const a0 = (DIR_ANGLE[dir] - ARC) * RAD;
      const a1 = (DIR_ANGLE[dir] + ARC) * RAD;
      const active = enemy.guard === dir;
      const hit = incoming === dir;

      c.beginPath();
      c.arc(0, 0, R, a0, a1);
      if (hit) {
        const remain = atk.strike - enemy.clipTime;
        const charge = Math.min(1, 1 - Math.max(0, remain) / Math.max(0.1, atk.strike));
        c.strokeStyle = unblockable ? COL.unblock : COL.attack;
        c.lineWidth = 8 + charge * 7;
        c.shadowColor = c.strokeStyle;
        c.shadowBlur = 14 + charge * 18;
        c.globalAlpha = unblockable
          ? 0.75 + Math.sin(this.time * 26) * 0.25
          : 0.6 + charge * 0.4;
      } else {
        c.strokeStyle = active ? COL.steel : COL.dim;
        c.lineWidth = active ? 7 : 4;
        c.shadowBlur = active ? 8 : 0;
        c.shadowColor = COL.steel;
        c.globalAlpha = active ? 0.95 : 1;
      }
      c.stroke();
      c.shadowBlur = 0;
      c.globalAlpha = 1;
    }

    // Parry window: a bright hairline that appears only while a parry is live.
    if (atk) {
      const remain = atk.strike - enemy.clipTime;
      if (remain > 0 && remain < 0.26 && player.guard === atk.dir) {
        const a0 = (DIR_ANGLE[atk.dir] - ARC) * RAD;
        const a1 = (DIR_ANGLE[atk.dir] + ARC) * RAD;
        c.beginPath();
        c.arc(0, 0, R + 11, a0, a1);
        c.strokeStyle = COL.parry;
        c.lineWidth = 2.5;
        c.globalAlpha = 0.85;
        c.shadowColor = COL.parry;
        c.shadowBlur = 12;
        c.stroke();
        c.shadowBlur = 0;
        c.globalAlpha = 1;
      }
    }

    // Inner ring: your own guard.
    for (const dir of ['top', 'left', 'right']) {
      const a0 = (DIR_ANGLE[dir] - ARC + 6) * RAD;
      const a1 = (DIR_ANGLE[dir] + ARC - 6) * RAD;
      const mine = player.guard === dir;
      c.beginPath();
      c.arc(0, 0, rIn, a0, a1);
      c.strokeStyle = mine ? COL.player : 'rgba(111,179,255,0.16)';
      c.lineWidth = mine ? 5 : 3;
      if (mine) { c.shadowColor = COL.player; c.shadowBlur = 10; }
      c.stroke();
      c.shadowBlur = 0;
    }

    // Chain pips: how deep your pressure currently runs, and whether the
    // window to continue it is still open.
    if (player.chainStep > 0) {
      const depth = player.traits?.chainDepth ?? 2;
      const live = player.chainWindow > 0;
      for (let i = 0; i < depth; i++) {
        const px = (i - (depth - 1) / 2) * 13;
        c.beginPath();
        c.arc(px, rIn + 26, 3.4, 0, Math.PI * 2);
        c.fillStyle = i < player.chainStep
          ? (live ? '#ffc861' : 'rgba(255,200,97,0.35)')
          : 'rgba(215,222,233,0.16)';
        c.fill();
      }
    }

    if (player.state === 'attack' && player.attack?.unblockable) {
      c.beginPath();
      c.arc(0, 0, rIn - 9, 0, Math.PI * 2);
      c.strokeStyle = COL.unblock;
      c.lineWidth = 2;
      c.globalAlpha = 0.5 + Math.sin(this.time * 22) * 0.4;
      c.stroke();
      c.globalAlpha = 1;
    }
    c.restore();
  }

  // ---------------------------------------------------------------- vitals

  _bar(c, x, y, w, h, frac, color, bg = 'rgba(0,0,0,0.55)') {
    c.fillStyle = bg;
    c.fillRect(x, y, w, h);
    c.fillStyle = color;
    c.fillRect(x, y, w * Math.max(0, Math.min(1, frac)), h);
    c.strokeStyle = 'rgba(255,255,255,0.20)';
    c.lineWidth = 1;
    c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  _vitals(c, f, x, y, w, align, label) {
    const hf = f.health / f.maxHealth;
    const sf = f.stamina / 100;

    c.save();
    c.font = `600 ${12 * this.s}px ui-sans-serif, system-ui, sans-serif`;
    c.fillStyle = 'rgba(220,228,240,0.75)';
    c.textAlign = align;
    c.letterSpacing = '2px';
    c.fillText(label.toUpperCase(), align === 'right' ? x + w : x, y - 9);
    // Their archetype is information you have earned by looking at them; it
    // tells you what kind of fight this is before the first exchange.
    if (f.archetypeName) {
      c.font = `500 ${9 * this.s}px ui-sans-serif, system-ui, sans-serif`;
      c.fillStyle = 'rgba(215,222,233,0.42)';
      c.letterSpacing = '1px';
      c.fillText(f.archetypeName.toUpperCase(),
        align === 'right' ? x + w : x, y - 22);
    }
    c.letterSpacing = '0px';
    c.restore();

    // Ghost bar showing damage just taken.
    f._ghost = f._ghost === undefined ? hf : f._ghost;
    f._ghost += (hf - f._ghost) * 0.06;
    c.fillStyle = COL.healthLost;
    c.fillRect(x, y, w * Math.max(0, f._ghost), 14);

    this._bar(c, x, y, w, 14, hf,
      f.hitFlash > 0 ? '#ffffff' : COL.health, 'rgba(10,12,16,0.7)');
    this._bar(c, x, y + 17, w, 5, sf,
      f.exhausted > 0 ? COL.staminaLow : COL.stamina, 'rgba(10,12,16,0.7)');

    if (f.exhausted > 0) {
      c.font = `700 ${10 * this.s}px ui-sans-serif, system-ui, sans-serif`;
      c.fillStyle = COL.staminaLow;
      c.textAlign = align;
      c.globalAlpha = 0.6 + Math.sin(this.time * 12) * 0.4;
      c.fillText('EXHAUSTED', align === 'right' ? x + w : x, y + 36);
      c.globalAlpha = 1;
    }
  }

  _drawBars(c, player, enemy) {
    const w = Math.min(320 * this.s, this.w * 0.30);
    const pad = 42 * this.s;
    const y = this.h - 78 * this.s;
    this._vitals(c, player, pad, y, w, 'left', player.name);
    this._vitals(c, enemy, this.w - pad - w, y, w, 'right', enemy.name);
  }

  // -------------------------------------------------------------- feedback

  _drawFloats(c, dt, camera) {
    c.save();
    c.textAlign = 'center';
    for (let i = this.floats.length - 1; i >= 0; i--) {
      const f = this.floats[i];
      f.age += dt;
      if (f.age > f.ttl) { this.floats.splice(i, 1); continue; }
      const u = f.age / f.ttl;
      const s = this.project(f.p, camera);
      if (s.behind) continue;
      c.globalAlpha = 1 - u * u;
      c.font = `700 ${26 * this.s}px ui-sans-serif, system-ui, sans-serif`;
      c.fillStyle = f.color;
      c.shadowColor = 'rgba(0,0,0,0.9)';
      c.shadowBlur = 6;
      c.fillText(f.text, s.x + f.drift * u, s.y - 30 - u * 52);
    }
    c.restore();
  }

  _drawMessages(c, dt) {
    c.save();
    c.textAlign = 'center';
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      m.age += dt;
      if (m.age > m.ttl) { this.messages.splice(i, 1); continue; }
      const u = m.age / m.ttl;
      c.globalAlpha = Math.min(1, (1 - u) * 2.5);
      const pop = 1 + Math.max(0, 0.25 - m.age) * 1.4;
      const size = (m.big ? 42 : 24) * pop * this.s;
      c.font = `800 ${size}px ui-sans-serif, system-ui, sans-serif`;
      c.fillStyle = m.color;
      c.shadowColor = 'rgba(0,0,0,0.85)';
      c.shadowBlur = 10;
      c.letterSpacing = '4px';
      c.fillText(m.text, this.w / 2, this.h * 0.29 + i * 34 * this.s);
      c.letterSpacing = '0px';
    }
    c.restore();
  }

  _drawHints(c) {
    const lines = [
      'MOUSE — look around.  When you LOCK ON to an enemy, mouse sets your GUARD.',
      'LEFT CLICK light  ·  RIGHT CLICK heavy (hold = unblockable)  ·  time a HEAVY to PARRY',
      'E guard break  ·  SPACE dodge  ·  F feint  ·  Q free look  ·  1-4 utility  ·  G graphics',
      'Attack: break the banner.  Defend: hold the chapel until the clock runs out.',
    ];
    c.save();
    c.textAlign = 'center';
    c.globalAlpha = Math.min(1, this.hintTimer / 2);
    c.font = `500 ${14 * this.s}px ui-sans-serif, system-ui, sans-serif`;
    c.fillStyle = 'rgba(210,220,235,0.8)';
    c.shadowColor = 'rgba(0,0,0,0.9)';
    c.shadowBlur = 6;
    lines.forEach((l, i) => c.fillText(l, this.w / 2,
      this.h - (128 + lines.length * 22) * this.s + i * 21 * this.s));
    c.restore();
  }

  _drawResult(c, duel, player) {
    const won = duel.winner === player;
    c.save();
    c.fillStyle = won ? 'rgba(12,18,28,0.45)' : 'rgba(28,8,8,0.5)';
    c.fillRect(0, 0, this.w, this.h);
    c.textAlign = 'center';
    c.font = `800 ${76 * this.s}px ui-sans-serif, system-ui, sans-serif`;
    c.letterSpacing = '10px';
    c.fillStyle = won ? '#f0e6d2' : '#e0554a';
    c.shadowColor = 'rgba(0,0,0,0.9)';
    c.shadowBlur = 20;
    c.fillText(won ? 'VICTORY' : 'DEFEAT', this.w / 2, this.h / 2 - 10 * this.s);
    c.font = `500 ${16 * this.s}px ui-sans-serif, system-ui, sans-serif`;
    c.letterSpacing = '3px';
    c.fillStyle = 'rgba(230,235,245,0.8)';
    c.fillText('PRESS R TO FIGHT AGAIN', this.w / 2, this.h / 2 + 44 * this.s);
    c.restore();
  }

  _drawPaused(c, started) {
    c.save();
    c.fillStyle = 'rgba(8,10,14,0.6)';
    c.fillRect(0, 0, this.w, this.h);
    c.textAlign = 'center';
    c.font = `800 ${48 * this.s}px ui-sans-serif, system-ui, sans-serif`;
    c.letterSpacing = '8px';
    c.fillStyle = '#e8eef8';
    c.fillText(started ? 'PAUSED' : 'ART OF BATTLE', this.w / 2, this.h / 2);
    c.font = `500 ${15 * this.s}px ui-sans-serif, system-ui, sans-serif`;
    c.letterSpacing = '3px';
    c.fillStyle = 'rgba(220,228,240,0.72)';
    c.fillText(started ? 'CLICK TO RESUME' : 'CLICK TO TAKE THE FIELD',
      this.w / 2, this.h / 2 + 38 * this.s);
    c.font = `500 ${13 * this.s}px ui-sans-serif, system-ui, sans-serif`;
    c.fillStyle = 'rgba(200,210,226,0.5)';
    c.fillText('1 SQUIRE    2 WARRIOR    3 WARLORD',
      this.w / 2, this.h / 2 + 74 * this.s);
    c.restore();
  }
}

export { COL as HUD_COLORS };
