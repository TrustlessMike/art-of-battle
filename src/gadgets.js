import * as THREE from 'three';
import { ROLE } from './round.js';

/**
 * Utility — the layer that turns a duel into a siege.
 *
 * Defenders spend prep sealing approaches and hardening walls, then hold with
 * area denial and intel. Attackers spend theirs looking, then open the building
 * on their own terms. Everything here changes the *shape* of the fight rather
 * than adding damage.
 */

const _v = new THREE.Vector3();

export const GADGETS = {
  barricade: {
    role: ROLE.DEFEND, phase: 'prep', charges: 3, label: 'Barricade',
    hint: 'Board a door or window',
  },
  reinforce: {
    role: ROLE.DEFEND, phase: 'prep', charges: 2, label: 'Reinforce',
    hint: 'Harden a timber wall',
  },
  caltrops: {
    role: ROLE.DEFEND, phase: 'any', charges: 2, label: 'Caltrops',
    hint: 'Slows and bleeds',
  },
  alarm: {
    role: ROLE.DEFEND, phase: 'prep', charges: 1, label: 'Alarm Bell',
    hint: 'Reveals the attacker',
  },
  breach: {
    role: ROLE.ATTACK, phase: 'action', charges: 2, label: 'Breach Charge',
    hint: 'Blow open any wall',
  },
  smoke: {
    role: ROLE.ATTACK, phase: 'action', charges: 2, label: 'Smoke Pot',
    hint: 'Blocks line of sight',
  },
};

const SMOKE_LIFE = 11;
const SMOKE_RADIUS = 2.6;
const CALTROP_RADIUS = 1.5;
const BREACH_FUSE = 2.2;
const BREACH_RADIUS = 1.7;
const ALARM_RADIUS = 3.4;

export class Gadgets {
  constructor(scene, compound) {
    this.scene = scene;
    this.compound = compound;
    this.group = new THREE.Group();
    this.group.name = 'Gadgets';
    scene.add(this.group);

    this.deployed = [];
    this.inventory = new Map();      // fighter -> { kind: remaining }
    this.events = [];
    this._mats = {
      iron: new THREE.MeshStandardMaterial({ color: 0x4b5058, metalness: 0.85, roughness: 0.45 }),
      wood: new THREE.MeshStandardMaterial({ color: 0x6b4a26, roughness: 0.85 }),
      brass: new THREE.MeshStandardMaterial({ color: 0xb08b32, metalness: 0.9, roughness: 0.35 }),
      fuse: new THREE.MeshStandardMaterial({ color: 0x2a1d12, roughness: 0.9 }),
    };
    this._smokeTex = smokeSprite();
  }

  emit(e) { this.events.push(e); return e; }

  drain() {
    const out = this.events;
    this.events = [];
    return out;
  }

  /** Refill both fighters at the start of a round. */
  resetFor(fighters, roleOf) {
    for (const d of this.deployed) {
      this.group.remove(d.node);
      d.node.traverse?.((o) => o.geometry?.dispose?.());
    }
    this.deployed.length = 0;
    this.inventory.clear();
    for (const f of fighters) {
      const role = roleOf(f);
      const inv = {};
      const bonus = f.traits?.gadgetBonus || {};
      for (const [kind, spec] of Object.entries(GADGETS)) {
        if (spec.role === role) inv[kind] = spec.charges + (bonus[kind] || 0);
      }
      this.inventory.set(f, inv);
    }
  }

  remaining(fighter, kind) {
    return this.inventory.get(fighter)?.[kind] ?? 0;
  }

  available(fighter, phase) {
    const inv = this.inventory.get(fighter) || {};
    return Object.keys(inv).filter((k) => {
      if (inv[k] <= 0) return false;
      const spec = GADGETS[k];
      return spec.phase === 'any' || spec.phase === phase;
    });
  }

  _spend(fighter, kind) {
    const inv = this.inventory.get(fighter);
    if (!inv || !inv[kind]) return false;
    inv[kind]--;
    return true;
  }

  // ------------------------------------------------------------------ use

  /**
   * Use a gadget. `target` is resolved by the caller (the nearest opening,
   * panel, or just the fighter's position) so the AI and the player share
   * exactly one code path.
   */
  use(fighter, kind, target) {
    const spec = GADGETS[kind];
    if (!spec || this.remaining(fighter, kind) <= 0) return false;

    switch (kind) {
      case 'barricade': {
        if (!target?.openingId) return false;
        if (!this.compound.barricade(target.openingId, 'plank')) return false;
        break;
      }
      case 'reinforce': {
        if (!target?.surface) return false;
        if (!this.compound.reinforcePanel(target.surface)) return false;
        break;
      }
      case 'caltrops':
        this._deployCaltrops(fighter);
        break;
      case 'alarm':
        this._deployAlarm(fighter);
        break;
      case 'smoke':
        this._deploySmoke(fighter);
        break;
      case 'breach': {
        if (!target?.surface) return false;
        this._deployBreach(fighter, target.surface);
        break;
      }
      default:
        return false;
    }

    this._spend(fighter, kind);
    this.emit({ type: 'gadget', kind, fighter });
    return true;
  }

  _front(fighter, dist = 0.8) {
    return new THREE.Vector3(
      fighter.pos.x + Math.sin(fighter.yaw) * dist, 0,
      fighter.pos.z + Math.cos(fighter.yaw) * dist,
    );
  }

  _deployCaltrops(fighter) {
    const at = this._front(fighter, 1.0);
    const node = new THREE.Group();
    for (let i = 0; i < 14; i++) {
      const s = new THREE.Mesh(
        new THREE.TetrahedronGeometry(0.075), this._mats.iron);
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * CALTROP_RADIUS * 0.85;
      s.position.set(Math.cos(a) * r, 0.05, Math.sin(a) * r);
      s.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      s.castShadow = true;
      node.add(s);
    }
    node.position.copy(at);
    this.group.add(node);
    this.deployed.push({
      kind: 'caltrops', owner: fighter, node,
      pos: at.clone(), radius: CALTROP_RADIUS, life: Infinity, tick: 0,
    });
  }

  _deployAlarm(fighter) {
    const at = this._front(fighter, 0.9);
    const node = new THREE.Group();
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.06, 1.5, 8), this._mats.wood);
    post.position.y = 0.75;
    const bell = new THREE.Mesh(
      new THREE.ConeGeometry(0.17, 0.28, 10), this._mats.brass);
    bell.position.y = 1.42;
    node.add(post, bell);
    node.position.copy(at);
    node.traverse((o) => { o.castShadow = true; });
    this.group.add(node);
    this.deployed.push({
      kind: 'alarm', owner: fighter, node, bell,
      pos: at.clone(), radius: ALARM_RADIUS, life: Infinity, triggered: 0,
    });
  }

  _deploySmoke(fighter) {
    const at = this._front(fighter, 1.4);
    const node = new THREE.Group();
    const puffs = [];
    for (let i = 0; i < 16; i++) {
      const m = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this._smokeTex, color: 0xb9bcc2, transparent: true,
        opacity: 0, depthWrite: false, fog: true,
      }));
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * SMOKE_RADIUS * 0.7;
      m.position.set(Math.cos(a) * r, 0.4 + Math.random() * 1.5, Math.sin(a) * r);
      const s = 1.8 + Math.random() * 1.6;
      m.scale.set(s, s, s);
      node.add(m);
      puffs.push({ sprite: m, seed: Math.random() * 10, rise: 0.1 + Math.random() * 0.2 });
    }
    node.position.copy(at);
    this.group.add(node);
    this.deployed.push({
      kind: 'smoke', owner: fighter, node, puffs,
      pos: at.clone(), radius: SMOKE_RADIUS, life: SMOKE_LIFE, age: 0,
    });
  }

  _deployBreach(fighter, surface) {
    const at = this.compound.centre(surface, new THREE.Vector3());
    at.y = 1.2;
    const node = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.34, 0.14), this._mats.wood);
    const band = new THREE.Mesh(
      new THREE.TorusGeometry(0.2, 0.03, 6, 12), this._mats.iron);
    band.rotation.y = Math.PI / 2;
    node.add(body, band);
    node.position.copy(at);
    node.traverse((o) => { o.castShadow = true; });
    this.group.add(node);
    this.deployed.push({
      kind: 'breach', owner: fighter, node, surface,
      pos: at.clone(), fuse: BREACH_FUSE, life: BREACH_FUSE,
    });
  }

  // --------------------------------------------------------------- runtime

  update(dt, fighters, time) {
    for (let i = this.deployed.length - 1; i >= 0; i--) {
      const d = this.deployed[i];

      if (d.kind === 'breach') {
        d.fuse -= dt;
        const t = 1 - d.fuse / BREACH_FUSE;
        d.node.scale.setScalar(1 + Math.sin(time * 22) * 0.05 * t);
        if (d.fuse <= 0) {
          const hits = this.compound.damageAt(
            d.pos.x, d.pos.z, BREACH_RADIUS, 400, { breach: true });
          this.emit({ type: 'breached', pos: d.pos.clone(), hits });
          this._remove(i);
          continue;
        }
      }

      if (d.kind === 'smoke') {
        d.age += dt;
        const fade = Math.min(1, d.age / 0.7) *
          Math.min(1, Math.max(0, (d.life - d.age) / 2.2));
        for (const p of d.puffs) {
          p.sprite.material.opacity = fade * 0.62;
          p.sprite.position.y += p.rise * dt;
          p.sprite.position.x += Math.sin(time * 0.6 + p.seed) * 0.06 * dt;
        }
        if (d.age >= d.life) { this._remove(i); continue; }
      }

      if (d.kind === 'caltrops') {
        d.tick -= dt;
        for (const f of fighters) {
          if (f === d.owner || !f.alive || f.frozen) continue;
          if (_v.copy(f.pos).sub(d.pos).setY(0).length() > d.radius) continue;
          f.caltropSlow = 0.35;
          if (d.tick <= 0) {
            f.takeDamage?.(4, f.guard, false);
            this.emit({ type: 'caltrophit', fighter: f, pos: d.pos.clone() });
            d.tick = 0.85;
          }
        }
      }

      if (d.kind === 'alarm') {
        d.triggered = Math.max(0, d.triggered - dt);
        for (const f of fighters) {
          if (f === d.owner || !f.alive || f.frozen) continue;
          if (_v.copy(f.pos).sub(d.pos).setY(0).length() > d.radius) continue;
          if (d.triggered <= 0) {
            d.triggered = 4;
            this.emit({ type: 'alarm', fighter: f, pos: d.pos.clone() });
          }
          f.revealedUntil = Math.max(f.revealedUntil || 0, time + 6);
        }
        if (d.bell) {
          d.bell.rotation.z = d.triggered > 0
            ? Math.sin(time * 26) * 0.22 * Math.min(1, d.triggered) : 0;
        }
      }
    }
  }

  _remove(i) {
    const d = this.deployed[i];
    this.group.remove(d.node);
    d.node.traverse?.((o) => o.geometry?.dispose?.());
    this.deployed.splice(i, 1);
  }

  /** Smoke blocks sight independently of walls. */
  smokeBlocks(ax, az, bx, bz) {
    for (const d of this.deployed) {
      if (d.kind !== 'smoke' || d.age < 0.35) continue;
      if (segmentNearPoint(ax, az, bx, bz, d.pos.x, d.pos.z) < d.radius) {
        return true;
      }
    }
    return false;
  }
}

function segmentNearPoint(ax, az, bx, bz, px, pz) {
  const abx = bx - ax, abz = bz - az;
  const len2 = abx * abx + abz * abz;
  let t = len2 > 1e-9 ? ((px - ax) * abx + (pz - az) * abz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + abx * t), pz - (az + abz * t));
}

function smokeSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grd.addColorStop(0, 'rgba(230,232,236,0.85)');
  grd.addColorStop(0.55, 'rgba(200,203,210,0.45)');
  grd.addColorStop(1, 'rgba(180,184,192,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
