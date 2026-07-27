import * as THREE from 'three';
import { ARCHETYPES, ARCHETYPE_KEYS, PERKS, PERK_KEYS } from './traits.js';
import { detailMaterial } from './materials.js';

/**
 * Character creation.
 *
 * The preview is the real fighter, not a stand-in: the same rig, the same
 * weapon mount, the same calibration. So the reach shown on the panel is the
 * number the game will actually use in a fight, measured from the blade you
 * are looking at.
 */

const _v = new THREE.Vector3();

export const HERALDRY = [
  { name: 'Iron Blue', hex: 0x1b2f6b },
  { name: 'Blood Red', hex: 0x6e1414 },
  { name: 'Forest', hex: 0x1e4526 },
  { name: 'Imperial', hex: 0x4a1c5c },
  { name: 'Ash Grey', hex: 0x33383f },
  { name: 'Ochre', hex: 0x8a6218 },
  { name: 'Bone', hex: 0x9a927c },
  { name: 'Black', hex: 0x121316 },
];

const CATEGORIES = ['archetype', 'weapon', 'armour', 'perk1', 'perk2', 'heraldry', 'name'];
const MAX_NAME = 14;

export class CharacterCreator {
  constructor({ armours, weapons, heraldry = HERALDRY }) {
    this.armours = armours;         // [{key, name, file, health, speedMul, herald}]
    this.weapons = weapons;         // [{key, name, ...grip, damageMul}]
    this.heraldry = heraldry;

    this.armourIndex = 0;
    this.weaponIndex = 0;
    this.heraldIndex = 0;
    this.archetypeIndex = 0;
    this.perkIndex = [1, 2];        // two perk slots, offset so they differ
    this.name = 'Warden';
    this.category = 0;
    this.done = false;
    this.dirty = true;              // loadout needs applying
    this.time = 0;
    this.spin = 0;
    this.flash = 0;
  }

  get armour() { return this.armours[this.armourIndex]; }
  get weapon() { return this.weapons[this.weaponIndex]; }
  get herald() { return this.heraldry[this.heraldIndex]; }
  get archetypeKey() { return ARCHETYPE_KEYS[this.archetypeIndex]; }
  get archetype() { return ARCHETYPES[this.archetypeKey]; }
  perkKeyAt(slot) { return PERK_KEYS[this.perkIndex[slot]]; }
  get perkKeys() { return [this.perkKeyAt(0), this.perkKeyAt(1)]; }

  // ------------------------------------------------------------------ input

  /**
   * Returns true on the frame the player confirms. Presses are replayed in the
   * order they arrived, so a burst between frames is not collapsed into one.
   */
  handle(input) {
    this._consumeText(input);
    let confirmed = false;
    for (const code of input.keys || []) {
      switch (code) {
        case 'ArrowDown': case 'KeyS':
          this.category = (this.category + 1) % CATEGORIES.length;
          break;
        case 'ArrowUp': case 'KeyW':
          this.category =
            (this.category + CATEGORIES.length - 1) % CATEGORIES.length;
          break;
        case 'ArrowRight': case 'KeyD': this._cycle(1); break;
        case 'ArrowLeft': case 'KeyA': this._cycle(-1); break;
        // Space confirms as well as Enter: one confirm key is a single point
        // of failure across keyboard layouts and input methods.
        case 'Enter': case 'NumpadEnter': case 'Space':
          this.done = true;
          confirmed = true;
          break;
        default: break;
      }
    }
    return confirmed;
  }

  _consumeText(input) {
    if (CATEGORIES[this.category] !== 'name' || !input.typed) return;
    for (const ch of input.typed) {
      if (ch === '\b') this.name = this.name.slice(0, -1);
      else if (this.name.length < MAX_NAME && /[\w '-]/.test(ch)) this.name += ch;
    }
    if (!this.name) this.name = ' ';
  }

  _cycle(dir) {
    const wrap = (i, n) => (i + dir + n) % n;
    switch (CATEGORIES[this.category]) {
      case 'armour':
        this.armourIndex = wrap(this.armourIndex, this.armours.length);
        this.dirty = true;
        break;
      case 'weapon':
        this.weaponIndex = wrap(this.weaponIndex, this.weapons.length);
        this.dirty = true;
        break;
      case 'heraldry':
        this.heraldIndex = wrap(this.heraldIndex, this.heraldry.length);
        this.dirty = true;
        break;
      case 'archetype':
        this.archetypeIndex = wrap(this.archetypeIndex, ARCHETYPE_KEYS.length);
        this.dirty = true;
        break;
      case 'perk1':
      case 'perk2': {
        const slot = CATEGORIES[this.category] === 'perk1' ? 0 : 1;
        const other = this.perkIndex[1 - slot];
        // Skip past the other slot's pick so you cannot take a perk twice.
        do {
          this.perkIndex[slot] = wrap(this.perkIndex[slot], PERK_KEYS.length);
        } while (this.perkIndex[slot] === other && PERK_KEYS[other] !== 'none');
        this.dirty = true;
        break;
      }
      default:
        break;
    }
    this.flash = 0.25;
  }

  update(dt) {
    this.time += dt;
    this.spin += dt * 0.32;
    this.flash = Math.max(0, this.flash - dt);
  }

  // --------------------------------------------------------------- preview

  /**
   * Frame the fighter off to one side so the panel has room. The narrower the
   * window, the more of its width the panel eats — so the fighter is pushed
   * further across rather than being left standing behind the text.
   */
  poseCamera(camera, fighter) {
    fighter.yaw = this.spin;
    const aspect = camera.aspect || 1.777;
    // A smaller look-offset slides the fighter further right in frame, which
    // is what a narrow window needs to clear the panel.
    const shift = THREE.MathUtils.clamp(0.32 * aspect - 0.12, 0.12, 0.45);
    _v.set(fighter.pos.x + 0.85, 1.52, fighter.pos.z - 3.05);
    camera.position.copy(_v);
    camera.lookAt(fighter.pos.x - shift, 1.0, fighter.pos.z);
  }

  // ------------------------------------------------------------------- draw

  draw(hud, fighter) {
    const c = hud.ctx;
    const s = hud.s;
    const w = hud.w;
    const h = hud.h;

    c.save();
    // Darken behind the type so it always reads over the scene. Sized to the
    // text rather than to a fraction of the window, so a narrow viewport does
    // not end up with the backdrop covering most of the fighter.
    const panelW = Math.min(w * 0.62, 380 * s);
    const grad = c.createLinearGradient(0, 0, panelW, 0);
    grad.addColorStop(0, 'rgba(6,8,12,0.88)');
    grad.addColorStop(0.7, 'rgba(6,8,12,0.72)');
    grad.addColorStop(1, 'rgba(6,8,12,0)');
    c.fillStyle = grad;
    c.fillRect(0, 0, panelW, h);

    const x = 54 * s;
    let y = 96 * s;

    c.textAlign = 'left';
    c.font = `800 ${13 * s}px ui-sans-serif, system-ui, sans-serif`;
    c.letterSpacing = `${6 * s}px`;
    c.fillStyle = 'rgba(224,138,60,0.95)';
    c.fillText('CHOOSE YOUR CHAMPION', x, y);
    y += 40 * s;

    const rows = [
      ['ARCHETYPE', this.archetype.name, this.archetype.blurb],
      ['WEAPON', this.weapon.name, `${(this.weapon.damageMul * 100) | 0}% damage`],
      ['ARMOUR', this.armour.name,
        `${this.armour.health} hp · ${(this.armour.speedMul * 100) | 0}% speed`],
      ['PERK I', PERKS[this.perkKeyAt(0)].name, PERKS[this.perkKeyAt(0)].blurb],
      ['PERK II', PERKS[this.perkKeyAt(1)].name, PERKS[this.perkKeyAt(1)].blurb],
      ['HERALDRY', this.herald.name, ''],
      ['NAME', this.name, ''],
    ];

    rows.forEach(([label, value, note], i) => {
      const active = i === this.category;
      c.letterSpacing = `${2 * s}px`;
      c.font = `600 ${10 * s}px ui-sans-serif, system-ui, sans-serif`;
      c.fillStyle = active ? 'rgba(215,222,233,0.7)' : 'rgba(215,222,233,0.32)';
      c.fillText(label, x, y);

      c.letterSpacing = `${1 * s}px`;
      c.font = `${active ? 700 : 500} ${19 * s}px ui-sans-serif, system-ui, sans-serif`;
      c.fillStyle = active ? '#f0f4fa' : 'rgba(215,222,233,0.5)';
      c.fillText(value, x + 22 * s, y + 26 * s);

      if (active) {
        // Selection marker + the chevrons that say "this row changes".
        c.fillStyle = '#e08a3c';
        c.fillRect(x - 12 * s, y - 9 * s, 3 * s, 46 * s);
        if (CATEGORIES[i] !== 'name') {
          const pulse = 0.55 + Math.sin(this.time * 5) * 0.25;
          c.globalAlpha = pulse;
          c.font = `700 ${16 * s}px ui-sans-serif, system-ui, sans-serif`;
          c.fillText('‹', x + 4 * s, y + 26 * s);
          c.fillText('›', x + 250 * s, y + 26 * s);
          c.globalAlpha = 1;
        } else {
          // Caret, so it is obvious you can type here.
          if (Math.sin(this.time * 6) > 0) {
            const wdt = c.measureText(this.name).width;
            c.fillRect(x + 26 * s + wdt, y + 8 * s, 2 * s, 22 * s);
          }
        }
      }
      if (note) {
        c.letterSpacing = `${0.5 * s}px`;
        c.font = `500 ${10 * s}px ui-sans-serif, system-ui, sans-serif`;
        c.fillStyle = active ? 'rgba(224,138,60,0.85)' : 'rgba(215,222,233,0.28)';
        c.fillText(note, x + 22 * s, y + 41 * s);
      }
      y += 58 * s;
    });

    // Heraldry swatches, so the colour choice is visible not just named.
    const heraldRow = CATEGORIES.indexOf('heraldry');
    const swX = x + 22 * s;
    const swY = 96 * s + 40 * s + 58 * s * heraldRow + 32 * s;
    this.heraldry.forEach((hr, i) => {
      const sx = swX + i * 26 * s;
      c.fillStyle = `#${hr.hex.toString(16).padStart(6, '0')}`;
      c.fillRect(sx, swY, 18 * s, 12 * s);
      c.strokeStyle = i === this.heraldIndex
        ? '#f0f4fa' : 'rgba(215,222,233,0.25)';
      c.lineWidth = i === this.heraldIndex ? 2 * s : 1;
      c.strokeRect(sx + 0.5, swY + 0.5, 18 * s - 1, 12 * s - 1);
    });

    const statsY = y + 6 * s;
    this._stats(c, s, x, statsY, fighter);

    // Controls sit with the panel rather than pinned to the bottom of the
    // screen, which left them stranded in dead space on a tall window.
    const hintY = statsY + 62 * s;
    c.fillStyle = 'rgba(215,222,233,0.16)';
    c.fillRect(x, hintY - 20 * s, 300 * s, 1);

    c.letterSpacing = `${1 * s}px`;
    c.font = `500 ${12 * s}px ui-sans-serif, system-ui, sans-serif`;
    c.fillStyle = 'rgba(215,222,233,0.62)';
    c.fillText('W / S   choose a row', x, hintY);
    c.fillText('A / D   change it', x, hintY + 20 * s);
    c.fillText('ENTER / SPACE   take the field', x, hintY + 40 * s);
    c.restore();
  }

  /** Real numbers, straight off the fighter that is standing there. */
  _stats(c, s, x, y, fighter) {
    const a = this.armour;
    const stats = [
      ['REACH', `${(fighter?.reach ?? 0).toFixed(2)} m`],
      ['DAMAGE', `${Math.round((this.weapon.damageMul ?? 1) * 100)}%`],
      ['HEALTH', `${a.health}`],
      ['SPEED', `${Math.round((a.speedMul ?? 1) * 100)}%`],
    ];
    c.letterSpacing = `${2 * s}px`;
    stats.forEach(([label, value], i) => {
      const sx = x + i * 92 * s;
      c.font = `600 ${9 * s}px ui-sans-serif, system-ui, sans-serif`;
      c.fillStyle = 'rgba(215,222,233,0.4)';
      c.fillText(label, sx, y);
      c.font = `700 ${17 * s}px ui-sans-serif, system-ui, sans-serif`;
      c.fillStyle = '#d7dee9';
      c.fillText(value, sx, y + 22 * s);
    });
  }
}

/**
 * Recolour a fighter's heraldic surface. Materials are shared between clones
 * of the same GLB, so the material is cloned first — otherwise dressing one
 * fighter would repaint the other.
 */
export function applyHeraldry(rig, hex, matcher) {
  rig.root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const name = o.material.name || '';
    if (!matcher.test(name)) return;
    if (!o.material.userData.heraldClone) {
      o.material = o.material.clone();
      o.material.userData.heraldClone = true;
      // Cloning drops onBeforeCompile, so the clone arrives with no surface
      // detail. Without this the heraldic surfaces — the one part of the
      // fighter the player chose — would be the only flat ones on the model.
      detailMaterial(o.material);
    }
    o.material.color.setHex(hex);
  });
}
