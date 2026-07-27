import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

import { AudioEngine } from './audio.js';
import { Opponent } from './ai.js';
import { DuelCamera, FirstPersonCamera } from './camera.js';
import { Duel } from './combat.js';
import { Compound } from './compound.js';
import { batchStatic, batchWithinNodes, foldMaterials } from './batching.js';
import { bakeVertexAO } from './ao.js';
import { CharacterCreator, applyHeraldry } from './creator.js';
import { ARCHETYPES, ARCHETYPE_KEYS, PERK_KEYS, resolveTraits } from './traits.js';
import { Fighter } from './fighter.js';
import { VIEWMODEL_LAYER } from './rig.js';
import { PostFX } from './postfx.js';
import { Score } from './music.js';
import { Nav } from './nav.js';
import { Gadgets, GADGETS } from './gadgets.js';
import { HUD, HUD_COLORS } from './hud.js';
import { Input } from './input.js';
import { detailScene } from './materials.js';
import { PHASE, ROLE, Siege } from './round.js';
import { SiegeHUD } from './siegehud.js';
import { VFX } from './vfx.js';
import { buildWorld } from './world.js';

/**
 * Weapon loadout. `lead`/`rear` are where the two hands grip along the
 * weapon's own +Y, `tip` is the blade end — measured from the built models, so
 * the rig can normalise any of them onto the same animations.
 */
const WEAPONS = {
  longsword:  { file: 'weapon_longsword.glb',  name: 'Longsword',
    lead: -0.050, rear: -0.160, tip: 1.072, damageMul: 1.00, trail: 0x9fc4ff },
  greatsword: { file: 'weapon_greatsword.glb', name: 'Greatsword',
    lead: -0.075, rear: -0.270, tip: 1.200, damageMul: 1.18, trail: 0xc8d6ff },
  daneaxe:    { file: 'weapon_daneaxe.glb',    name: 'Dane Axe',
    lead:  0.000, rear: -0.550, tip: 0.545, damageMul: 1.12, trail: 0xffb27a },
  warhammer:  { file: 'weapon_warhammer.glb',  name: 'War Hammer',
    lead:  0.010, rear: -0.420, tip: 0.520, damageMul: 1.22, trail: 0xffd08a },
  spear:      { file: 'weapon_spear.glb',      name: 'Winged Spear',
    lead:  0.020, rear: -0.400, tip: 0.860, damageMul: 0.90, trail: 0xbfe6ff },
  katana:     { file: 'weapon_katana.glb',     name: 'Katana',
    lead: -0.060, rear: -0.250, tip: 0.742, damageMul: 1.05, trail: 0xe8f4ff },
};

/**
 * Armour. The tier is not cosmetic — it trades health against speed, so the
 * numbers the creation screen prints are ones the fight actually uses.
 * `herald` selects the material that carries the player's colours; the raider
 * kits have no dedicated accent surface, so their hide takes it instead.
 */
const ARMOURS = {
  warden:        { file: 'knight_warden.glb',        name: 'Warden',
    health: 130, speedMul: 1.00, herald: /_accent$/ },
  warden_heavy:  { file: 'knight_warden_heavy.glb',  name: 'Warden — Plate',
    health: 152, speedMul: 0.90, herald: /_accent$/ },
  warden_light:  { file: 'knight_warden_light.glb',  name: 'Warden — Mail',
    health: 112, speedMul: 1.10, herald: /_accent$/ },
  raider:        { file: 'knight_raider.glb',        name: 'Raider',
    health: 130, speedMul: 1.00, herald: /_hide$/ },
  raider_heavy:  { file: 'knight_raider_heavy.glb',  name: 'Raider — Chieftain',
    health: 152, speedMul: 0.90, herald: /_hide$/ },
  raider_light:  { file: 'knight_raider_light.glb',  name: 'Raider — Berserker',
    health: 112, speedMul: 1.10, herald: /_hide$/ },
};

const PLAYER_WEAPONS = ['longsword', 'greatsword', 'katana', 'spear', 'warhammer', 'daneaxe'];

const MODELS = {
  compound: 'models/compound.glb',
  ...Object.fromEntries(Object.entries(ARMOURS).map(
    ([k, v]) => [`armour_${k}`, `models/${v.file}`])),
  ...Object.fromEntries(Object.entries(WEAPONS).map(
    ([k, v]) => [`weapon_${k}`, `models/${v.file}`])),
};

// Models the game can run without — a missing one degrades, never crashes.
const OPTIONAL = new Set(['compound']);



const _v = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _viewDir = new THREE.Vector3();   // kept separate from _v, which the
                                        // event handlers reuse every frame

/**
 * Viewport size that is never degenerate. A hidden tab, a collapsed pane or a
 * display:none iframe reports 0x0, and 0/0 aspect turns both projection
 * matrices into NaN — from which nothing recovers until a later resize.
 */
function viewportSize() {
  const w = Math.max(1, window.innerWidth || 0);
  const h = Math.max(1, window.innerHeight || 0);
  return { w, h, aspect: w / h };
}

async function loadAll() {
  const loader = new GLTFLoader();
  // Every .glb is meshopt-compressed by tools/compress_models.mjs — about a
  // fifth of the raw size, which matters because Cloudflare will not gzip
  // model/gltf-binary. The decoder ships inside three, so registering it costs
  // no extra network request.
  loader.setMeshoptDecoder(MeshoptDecoder);
  const entries = await Promise.all(
    Object.entries(MODELS).map(async ([k, url]) => {
      try {
        return [k, await loader.loadAsync(url)];
      } catch (err) {
        if (OPTIONAL.has(k)) {
          console.warn(`[art-of-battle] ${url} missing — using stand-in`, err);
          return [k, null];
        }
        throw err;
      }
    }),
  );
  return Object.fromEntries(entries);
}

class Game {
  constructor(assets, renderer, canvas2d) {
    this.renderer = renderer;
    this.assets = assets;

    const world = buildWorld(renderer, assets.compound?.scene ?? null);
    this.scene = world.scene;
    this.braziers = world.braziers;
    this.fireShadows = world.fireShadows || [];
    this._fireShadowOptIn = new URLSearchParams(location.search).has('fireshadow');
    this.motes = world.motes;
    this.moon = world.moon;

    const view = viewportSize();
    this.camera = new THREE.PerspectiveCamera(72, view.aspect, 0.1, 400);
    // The main camera draws the world; the viewmodel is a separate pass.
    this.camera.layers.set(0);

    /**
     * Viewmodel camera. It sits *behind* the eye, because the fighter's hands
     * are about 0.17m behind it — no field of view on the main camera can pull
     * something behind the lens into frame. Backing off puts the hands and
     * weapon comfortably in front of this one instead.
     */
    this.viewCam = new THREE.PerspectiveCamera(45, view.aspect, 0.02, 14);
    this.viewCam.layers.set(VIEWMODEL_LAYER);
    this.viewCamBack = 1.15;

    // The viewmodel needs its own lighting: every light in the world sits on
    // layer 0, and a light only illuminates objects sharing its layer, so the
    // weapon would otherwise render as a black silhouette. These ride the lens
    // so your blade stays readable wherever you are standing.
    const vmKey = new THREE.PointLight(0xffe2bc, 14, 8, 2);
    vmKey.position.set(0.55, 0.75, 0.9);
    vmKey.layers.set(VIEWMODEL_LAYER);
    const vmFill = new THREE.HemisphereLight(0x9db4d8, 0x2a2018, 1.6);
    vmFill.layers.set(VIEWMODEL_LAYER);
    this.viewCam.add(vmKey, vmFill);
    this.scene.add(this.viewCam);   // lights are only gathered from the graph
    this.duelCam = new DuelCamera(this.camera);
    this.fpCam = new FirstPersonCamera(this.camera);
    this.lockedOn = false;
    this.lockOverride = false;   // Q forces lock-on off for a look around
    this.lostSight = 0;

    this.post = new PostFX({
      renderer, scene: this.scene, camera: this.camera, viewCam: this.viewCam,
    });
    this.score = new Score();

    this.compound = new Compound(this.scene, assets.compound?.scene ?? null);
    // The compound art is one mesh per architectural piece, which costs far more
    // to submit than to draw. Merge everything the game never mutates; the
    // destructible panels are bound by name and have to stay individual.
    const art = assets.compound?.scene;
    // ?nobatch= lets the batcher be A/B'd against itself on the same build.
    if (art && !new URLSearchParams(location.search).has('nobatch')) {
      const keep = new Set();
      for (const s of this.compound.surfaces) if (s.node) keep.add(s.node);
      for (const o of this.compound.openings.values()) if (o.node) keep.add(o.node);
      // Fold colour-only material variants first: distinct materials can never
      // share a draw call, and that — not the panel structure — was the limit.
      const f = foldMaterials(art);
      const b = batchStatic(art, keep);
      this.scene.add(b.group);
      // Panels cannot join that batch, but each one can collapse internally:
      // destruction acts on a whole panel, never on the courses inside it.
      const w = batchWithinNodes(keep);
      // Contact shading, baked once. Has to run after folding (which creates
      // the colour attribute) and after merging (fewer, larger meshes to walk).
      // ?noao / ?ao=<strength> so the bake can be judged against itself.
      const qs = new URLSearchParams(location.search);
      const aoStrength = qs.has('noao') ? 0 : parseFloat(qs.get('ao') ?? '0.55');
      const aoOpt = { strength: aoStrength };
      const ao = bakeVertexAO(art, this.compound.surfaces, aoOpt);
      const ao2 = bakeVertexAO(b.group, this.compound.surfaces, aoOpt);
      this.batchStats = { ...b, panels: w, fold: f, ao, aoBatch: ao2 };
    }
    this.duelCam.collider = this.compound;
    this.vfx = new VFX(this.scene);
    this.hud = new HUD(canvas2d);
    this.siegeHud = new SiegeHUD(this.hud);
    this.audio = new AudioEngine();
    this.score.attach(this.audio);
    this.input = new Input(renderer.domElement);
    this.gadgets = new Gadgets(this.scene, this.compound);

    this._buildFighters();

    this.siege = new Siege({
      player: this.player, enemy: this.enemy,
      compound: this.compound, duel: this.duel,
    });
    this.nav = new Nav(this.compound);
    this.ai.siege = this.siege;
    this.ai.gadgets = this.gadgets;
    this.ai.compound = this.compound;
    this.ai.nav = this.nav;

    this.time = 0;
    this.timeScale = 1;
    this.slowmo = 0;
    /**
     * Screen-state signals, driven by gameplay and consumed by the grade pass:
     * a red pulse when struck, a sustained desaturation when nearly dead, a
     * flash on a landed blow, and a cooler/harder look during parry slow-motion.
     */
    this.fx = { damage: 0, lowHealth: 0, hitFlash: 0, slowmo: 0 };
    this.started = false;
    this.paused = false;
    this._move = { x: 0, y: 0 };
    this._prepAngle = 0;
    // Scout camera: the attacker's only job in prep, so it has to be theirs to
    // drive rather than an automatic pan they sit through.
    this._scout = { yaw: 0, pitch: 0.85, dist: 23, focus: new THREE.Vector3(0, 0.5, 0), idle: 0 };

    this.creator = new CharacterCreator({
      armours: Object.entries(ARMOURS).map(([key, v]) => ({ key, ...v })),
      weapons: Object.entries(WEAPONS).map(([key, v]) => ({ key, ...v })),
    });
    this.mode = 'create';
    this.startMatch();
    this.enterCreation();
  }

  /**
   * A fresh copy of a loaded model. Both fighters can end up wearing the same
   * kit, and an Object3D can only have one parent — so nothing is ever used
   * directly from the loaded asset.
   */
  _instance(key) {
    const src = this.assets[key];
    return src ? src.scene.clone(true) : null;
  }

  _buildFighters() {
    const pw = WEAPONS.longsword;
    const ew = WEAPONS.daneaxe;
    const pa = ARMOURS.warden_heavy;
    const ea = ARMOURS.raider_heavy;

    this.player = new Fighter({
      name: 'Warden',
      model: this._instance('armour_warden_heavy'),
      weapon: this._instance('weapon_longsword'),
      grip: pw,
      profile: { damageMul: pw.damageMul, leadHand: 'R', trail: pw.trail,
        speedMul: pa.speedMul },
      x: 0, z: -14, yaw: 0, health: pa.health,
    });
    this.enemy = new Fighter({
      name: 'Raider',
      model: this._instance('armour_raider_heavy'),
      weapon: this._instance('weapon_daneaxe'),
      grip: ew,
      profile: { damageMul: ew.damageMul, leadHand: 'R', trail: ew.trail,
        speedMul: ea.speedMul },
      x: 6, z: 4, yaw: Math.PI, health: ea.health,
    });
    this.player.collider = this.compound;
    this.enemy.collider = this.compound;
    this.player.rig.setFirstPerson(true);
    this.player.freeLook = true;
    this.scene.add(this.player.group, this.enemy.group);

    this.duel = new Duel(this.player, this.enemy);
    this.ai = new Opponent(this.enemy, this.duel, 'warrior');
    this.fpCam.snap(this.player, this.enemy, false);
  }

  // ------------------------------------------------------------- creation

  enterCreation() {
    this.mode = 'create';
    // Creation does not drain the siege queue, so the round-start emitted at
    // construction would still be sitting there and fire a second banner the
    // moment the real round begins.
    this.siege.drain();
    const p = this.player;
    p.rig.setFirstPerson(false);      // show the whole fighter on the card
    p.frozen = true;
    p.freeLook = true;
    p.pos.set(0, 0, -15);
    p.velocity.set(0, 0, 0);
    p.setGuard('right');
    this.enemy.group.visible = false;
    this.creator.dirty = true;
  }

  /** Put the creator's choices onto the real fighter. */
  applyPlayerLoadout() {
    const c = this.creator;
    const a = ARMOURS[c.armour.key];
    const w = WEAPONS[c.weapon.key];
    this.player.setLoadout({
      model: this._instance(`armour_${c.armour.key}`),
      weapon: this._instance(`weapon_${c.weapon.key}`),
      grip: w,
      profile: {
        damageMul: w.damageMul, leadHand: 'R', trail: w.trail,
        speedMul: a.speedMul,
      },
    });
    applyHeraldry(this.player.rig, c.herald.hex, a.herald);
    // Archetype + perks resolve into one modifier set the fight reads directly.
    this.player.traits = resolveTraits(c.archetypeKey, c.perkKeys);
    this.player.archetypeName = c.archetype.name;
    this.player.maxHealth = Math.round(a.health * this.player.traits.healthMul);
    this.player.health = this.player.maxHealth;
    this.vfx.trails.delete(this.player);   // colour belongs to the new weapon
  }

  beginMatch() {
    this.applyPlayerLoadout();
    this.player.name = (this.creator.name || '').trim() || 'Warden';
    this.player.rig.setFirstPerson(true);
    this.player.frozen = false;
    this.enemy.group.visible = true;
    this.mode = 'match';
    this.startMatch();
  }

  _updateCreate(dt, inp) {
    if (this.creator.dirty) {
      this.applyPlayerLoadout();
      this.creator.dirty = false;
    }
    const confirmed = this.creator.handle(inp);
    this.creator.update(dt);
    this.creator.poseCamera(this.camera, this.player);

    this.player.update(dt, this.enemy);
    this.player.events.length = 0;

    this._renderFrame(dt);
    this.hud.ctx.clearRect(0, 0, this.hud.w, this.hud.h);
    this.creator.draw(this.hud, this.player);

    if (confirmed) this.beginMatch();
  }

  /**
   * Give the opponent a build of their own. Knowing you are facing a Bulwark
   * rather than a Berserker should change how you open — so it is rolled once
   * per match and shown on their nameplate, not hidden.
   */
  _rollEnemyBuild() {
    const pick = (arr) => arr[(Math.random() * arr.length) | 0];
    const key = pick(ARCHETYPE_KEYS);
    const perks = PERK_KEYS.filter((k) => k !== 'none');
    let a = pick(perks);
    let b = pick(perks);
    while (b === a) b = pick(perks);
    this.enemy.traits = resolveTraits(key, [a, b]);
    this.enemyArchetype = ARCHETYPES[key].name;
    const base = ARMOURS.raider_heavy.health;
    this.enemy.maxHealth = Math.round(base * this.enemy.traits.healthMul);
    this.enemy.health = this.enemy.maxHealth;
    this.enemy.archetypeName = this.enemyArchetype;
  }

  startMatch() {
    this.duel.over = false;
    this.duel.winner = null;
    this._rollEnemyBuild();
    this.siege.startMatch();
    this.hud.messages.length = 0;
    this.hud.floats.length = 0;
    for (const t of this.vfx.trails.values()) t.clear();
  }

  _onRoundStart() {
    this.duel.over = false;
    this.duel.winner = null;
    this.gadgets.resetFor([this.player, this.enemy],
      (f) => this.siege.roleOf(f));
    this.ai.reset?.();
    this.fpCam.snap(this.player, this.enemy, false);
  }

  // ------------------------------------------------------------------ vision

  /** Can the player actually see their opponent right now? */
  enemyVisible() {
    const a = this.player.pos, b = this.enemy.pos;
    if (this.compound.losBlocked(a.x, a.z, b.x, b.z)) return false;
    if (this.gadgets.smokeBlocks(a.x, a.z, b.x, b.z)) return false;
    return true;
  }

  /**
   * What the player is pointing at, for utility placement: the nearest opening
   * or wall panel in front of them.
   */
  _gadgetTarget(kind) {
    const p = this.player;
    const fx = p.pos.x + Math.sin(p.yaw) * 1.5;
    const fz = p.pos.z + Math.cos(p.yaw) * 1.5;

    if (kind === 'barricade') {
      let best = null, bestD = 2.6;
      for (const [id, o] of this.compound.openings) {
        if (o.barricade) continue;
        const d = Math.hypot(fx - o.cx, fz - o.cz);
        if (d < bestD) { bestD = d; best = id; }
      }
      return best ? { openingId: best } : null;
    }
    if (kind === 'reinforce') {
      const hit = this.compound.nearestSurface(fx, fz, 2.2,
        (s) => s.kind === 'panel' && s.soft && !s.reinforced);
      return hit ? { surface: hit.surface } : null;
    }
    if (kind === 'breach') {
      const hit = this.compound.nearestSurface(fx, fz, 2.2,
        (s) => s.kind === 'panel');
      return hit ? { surface: hit.surface } : null;
    }
    return {};
  }

  // ------------------------------------------------------------------- input

  /**
   * Lock on when the opponent is close enough and actually visible. While
   * locked the fighter turns to face them by itself, which frees the mouse to
   * set the guard; otherwise the mouse steers.
   */
  _updateLockOn(dt) {
    const inRange = this.player.pos.distanceTo(this.enemy.pos) < 5.2;
    const canSee = this.enemyVisible();
    if (!canSee) this.lostSight += dt; else this.lostSight = 0;

    const want = this.siege.phase === PHASE.ACTION &&
      this.player.alive && this.enemy.alive &&
      !this.lockOverride && inRange && this.lostSight < 0.45;

    this.lockedOn = want;
    this.input.lockedOn = want;
    this.player.freeLook = !want;
    if (!want) this.player.yaw = this.input.yaw;
    else this.input.yaw = this.player.yaw;
  }

  _handleInput(p, dt = 1 / 60) {
    const move = this.input.move(this._move);
    const player = this.player;
    const phase = this.siege.phase;

    if (p.gadgetSlot != null) this._useGadget(p.gadgetSlot);
    if (p.toggleLock) {
      this.lockOverride = !this.lockOverride;
      this.hud.say(this.lockOverride ? 'FREE LOOK' : 'LOCK ON',
        '#c9d2de', 0.8);
    }

    if (phase === PHASE.PREP) {
      player.moveInput.set(0, 0);
      this._scoutInput(p, move, dt);
      return;
    }
    if (phase !== PHASE.ACTION || !player.alive) {
      player.moveInput.set(0, 0);
      return;
    }
    player.moveInput.set(move.x, move.y);
    if (this.lockedOn) {
      player.setGuard(this.input.guard);
      if (p.guardChanged) this.audio.play('ui_stance', { volume: 0.5 });
    }

    if (p.light) player.startAttack('light');
    if (p.heavy) {
      // A heavy pressed on an arriving blade is a parry, not an attack.
      if (!this.duel.tryParry(player)) player.startAttack('heavy');
    }
    if (p.heavyReleased) player.releaseCharge();
    if (p.feint) player.feint();
    if (p.gb) player.startGuardBreak();
    if (p.dodge) player.startDodge(move.x, move.y);
  }

  _useGadget(slot) {
    const phase = this.siege.phase === PHASE.PREP ? 'prep' : 'action';
    const inv = this.gadgets.inventory.get(this.player) || {};
    const kind = Object.keys(inv)[slot];
    if (!kind) return;
    const spec = GADGETS[kind];
    if (spec.phase !== 'any' && spec.phase !== phase) {
      this.hud.say(`${spec.label} — WRONG PHASE`, HUD_COLORS.dim, 0.8);
      return;
    }
    if (this.gadgets.remaining(this.player, kind) <= 0) {
      this.hud.say('NONE LEFT', HUD_COLORS.dim, 0.7);
      return;
    }
    const target = this._gadgetTarget(kind);
    if (!target) {
      this.hud.say('NOTHING TO USE IT ON', HUD_COLORS.dim, 0.9);
      return;
    }
    if (this.gadgets.use(this.player, kind, target)) {
      this.hud.say(spec.label.toUpperCase(), '#c9d2de', 0.8);
    } else {
      this.hud.say('CANNOT PLACE THERE', HUD_COLORS.dim, 0.9);
    }
  }

  // ------------------------------------------------------------------ events

  _pan(point) {
    _camRight.setFromMatrixColumn(this.camera.matrixWorld, 0);
    _v.subVectors(point, this.camera.position);
    const d = Math.max(1, _v.length());
    return THREE.MathUtils.clamp(_v.dot(_camRight) / d * 2.2, -1, 1);
  }

  _processEvents() {
    const A = this.audio;

    for (const f of [this.player, this.enemy]) {
      for (const e of f.events) {
        switch (e.type) {
          case 'swing':
            A.play(e.attack.type === 'heavy' ? 'swing_heavy' : 'swing_light', {
              volume: 0.75, pan: this._pan(f.pos),
              rate: 0.94 + Math.random() * 0.12,
            });
            break;
          case 'footstep': {
            const foot = f.feet[e.side];
            A.play('footstep', { volume: 0.28, pan: this._pan(foot.world) });
            if (f.velocity.lengthSq() > 1.2) this.vfx.dust(foot.world, 4, 0.8);
            break;
          }
          case 'dodge':
            A.play('dodge', { volume: 0.6, pan: this._pan(f.pos) });
            this.vfx.dust(_v.copy(f.pos).setY(0.05), 12, 1.4);
            break;
          case 'guardbreak':
            A.play('guardbreak', { volume: 0.5, pan: this._pan(f.pos) });
            break;
          case 'feint':
            A.play('ui_stance', { volume: 0.7, rate: 0.7 });
            break;
          case 'unblockable':
            this.vfx.unblockableTell(f.rig.bladeTip(_v));
            A.play('ui_stance', { volume: 0.9, rate: 0.55 });
            if (f === this.enemy) {
              this.hud.say('UNBLOCKABLE', HUD_COLORS.unblock, 0.9);
            }
            break;
          case 'exhausted':
            A.play('stamina_empty', { volume: 0.7 });
            if (f === this.player) {
              this.hud.say('EXHAUSTED', HUD_COLORS.staminaLow, 1.0);
            }
            break;
          case 'death':
            A.play('death', { volume: 0.9, pan: this._pan(f.pos) });
            this.vfx.dust(_v.copy(f.pos).setY(0.1), 26, 1.8);
            break;
        }
      }
      f.events.length = 0;
    }

    for (const e of this.duel.drain()) {
      const pan = e.point ? this._pan(e.point) : 0;
      switch (e.type) {
        case 'hit':
          if (e.defender === this.player) this.fx.damage = 1;
          else this.fx.hitFlash = 1;
          A.play('hit_flesh', { volume: 0.95, pan });
          _v.subVectors(e.defender.pos, e.attacker.pos).normalize();
          this.vfx.bloodHit(e.point, _v, e.heavy);
          this.fpCam.kick(e.heavy ? 0.55 : 0.3, e.heavy ? 4 : 1.5);
          this.hud.float(e.point, `${e.damage}`,
            e.defender === this.player ? '#ff6b5e' : '#ffe9c9');
          A.duckMusic(0.5, 0.4);
          break;
        case 'block':
          A.play('hit_block', { volume: 0.85, pan, rate: 0.92 + Math.random() * 0.16 });
          _v.subVectors(e.defender.pos, e.attacker.pos).normalize();
          this.vfx.clash(e.point, _v);
          this.fpCam.kick(e.heavy ? 0.3 : 0.16, e.heavy ? 1.5 : 0);
          break;
        case 'parry':
          this.fx.hitFlash = 1;
          A.play('parry', { volume: 1.0, pan });
          this.vfx.parryBurst(e.point);
          this.fpCam.kick(0.7, 5);
          this.hud.say('PARRY', HUD_COLORS.parry, 1.0, true);
          this.score.sting('parry');
          this.slowmo = 0.34;
          A.duckMusic(0.8, 0.6);
          break;
        case 'gbhit':
          A.play('guardbreak', { volume: 0.95, pan });
          this.fpCam.kick(0.35, 2);
          this.hud.say('GUARD BROKEN', '#e8d9b0', 0.9);
          this.vfx.dust(_v.copy(e.defender.pos).setY(0.05), 14, 1.5);
          break;
        case 'gbcounter':
          A.play('parry', { volume: 0.8, pan, rate: 0.8 });
          this.hud.say('COUNTERED', HUD_COLORS.parry, 0.9);
          this.fpCam.kick(0.4, 2);
          break;
        case 'whiff':
          // A missed swing still carries force — into walls, and the banner.
          this._swingHitsWorld(e);
          break;
        case 'dodged':
          this.hud.say('MISS', 'rgba(220,228,240,0.75)', 0.6);
          break;
      }
    }

    for (const e of this.gadgets.drain()) {
      switch (e.type) {
        case 'breached':
          A.play('hit_block', { volume: 1.0, rate: 0.45 });
          A.play('death', { volume: 0.55, rate: 1.5 });
          this.fpCam.kick(0.85, 6);
          this.vfx.dust(e.pos, 40, 3.2);
          this.vfx.clash(e.pos, _v.set(0, 1, 0));
          this.hud.say('BREACH', HUD_COLORS.unblock, 1.0, true);
          this.score.sting('breach');
          break;
        case 'alarm':
          A.play('ui_stance', { volume: 1.0, rate: 1.8 });
          this.hud.say(e.fighter === this.player
            ? 'ALARM TRIPPED' : 'ALARM — THEY ARE CLOSE',
          HUD_COLORS.unblock, 1.0);
          break;
        case 'caltrophit':
          A.play('hit_flesh', { volume: 0.4, rate: 1.6 });
          break;
        case 'gadget':
          A.play('ui_stance', { volume: 0.6, rate: 0.9 });
          break;
      }
    }

    for (const e of this.siege.drain()) {
      switch (e.type) {
        case 'roundstart':
          this._onRoundStart();
          this.hud.say(`ROUND ${e.round} — ${
            e.playerRole === ROLE.ATTACK ? 'ATTACK' : 'DEFEND'}`,
          e.playerRole === ROLE.ATTACK ? '#e08a3c' : '#6fb3ff', 2.0, true);
          break;
        case 'phase':
          if (e.phase === PHASE.ACTION) {
            this.hud.say('FIGHT', '#e8eef8', 1.2, true);
            this.hud.showHints();
            A.play('victory', { volume: 0.5, rate: 0.7 });
          }
          break;
        case 'objectivehit':
          A.play('hit_block', { volume: 0.7, rate: 0.7 });
          this.vfx.clash(this.compound.objective.pos.clone().setY(1.4),
            _v.set(0, 1, 0));
          if (e.broke) {
            this.score.sting('objective');
            this.hud.say('BANNER DOWN', HUD_COLORS.unblock, 1.4, true);
            this.fpCam.kick(0.7, 4);
          }
          break;
        case 'roundend':
          this.score.sting(e.winner === 'player' ? 'roundwin' : 'roundloss');
          A.play(e.winner === 'player' ? 'victory' : 'defeat', { volume: 0.9 });
          this.slowmo = 1.0;
          break;
        case 'matchend':
          A.play(e.winner === 'player' ? 'victory' : 'defeat', { volume: 1.0 });
          break;
      }
    }
  }

  /** A whiffed swing bites whatever it actually reached. */
  _swingHitsWorld(e) {
    const attacker = e.attacker;
    const tip = attacker.rig.bladeTip(new THREE.Vector3());
    const heavy = e.heavy;

    if (this.siege.strikeObjective(attacker, heavy ? 22 : 10)) return;

    const hits = this.compound.damageAt(tip.x, tip.z, 0.85, heavy ? 46 : 18);
    if (!hits.length) return;
    this.audio.play('hit_block', { volume: 0.5, rate: 1.25 });
    for (const h of hits) {
      const c = this.compound.centre(h.surface, new THREE.Vector3());
      if (h.broken) {
        this.vfx.dust(c, 22, 2.4);
        this.vfx.clash(c, _v.set(0, 1, 0));
        this.fpCam.kick(0.3, 1.5);
      } else {
        this.vfx.dust(c, 5, 1.2);
      }
    }
  }

  // -------------------------------------------------------------------- loop

  update(dtRaw) {
    const inp = this.input.flush();
    this.time += dtRaw;
    for (const b of this.braziers) b.update(this.time);
    this._followFireShadows();
    this.motes?.update(dtRaw, this.player.pos, this.time);
    if (this.mode === 'create') {
      this._updateCreate(dtRaw, inp);
      // The menu cue needs frames too; the match-only path below never runs here.
      this._driveScore(dtRaw);
      return;
    }
    if (inp.pause) this.paused = !this.paused;
    if (inp.restart && this.siege.phase === PHASE.MATCH_OVER) {
      this.startMatch();
      this.paused = false;
    }
    // Graphics quality is a player-facing setting: the composer costs real
    // frames on integrated graphics, so it has to be droppable in-game.
    if (inp.toggleHints) {
      const on = this.hud.toggleHints();
      this.hud.say(on ? 'CONTROLS PINNED' : 'CONTROLS HIDDEN', '#c9d2de', 0.9);
    }
    if (inp.cycleQuality && this.post) {
      const order = ['high', 'medium', 'off'];
      const next = order[(order.indexOf(this.post.quality) + 1) % order.length];
      this.post.setQuality(next);
      this.post.enabled = next !== 'off';
      this.hud.say(`GRAPHICS — ${next.toUpperCase()}`, '#c9d2de', 1.2);
    }
    if (inp.difficulty && !this.started) {
      this.ai.setDifficulty(inp.difficulty);
      this.hud.say(inp.difficulty.toUpperCase(), '#c9d2de', 1.1);
    }

    const paused = !this.started || this.paused;

    if (!paused) {
      this._updateLockOn(dtRaw);
      this._handleInput(inp, dtRaw);

      if (this.slowmo > 0) this.slowmo -= dtRaw;
      const targetScale = this.slowmo > 0 ? 0.28 : 1;
      this.timeScale += (targetScale - this.timeScale) *
        Math.min(1, dtRaw * (this.slowmo > 0 ? 22 : 6));

      let dt = dtRaw * this.timeScale;
      if (this.duel.hitStop > 0) {
        this.duel.hitStop -= dtRaw;
        dt *= 0.06;
      }

      this.siege.update(dt);
      this.ai.update(dt);
      this.player.update(dt, this.enemy);
      this.enemy.update(dt, this.player);
      if (this.siege.phase === PHASE.ACTION) this.duel.update();
      this.gadgets.update(dt, [this.player, this.enemy], this.time);
    } else {
      this.player.update(0, this.enemy);
      this.enemy.update(0, this.player);
    }
    // Always drained, so round setup still lands while the title card is up.
    this._processEvents();

    // Signals decay fast; low health is a sustained state, not an event.
    this.fx.damage = Math.max(0, this.fx.damage - dtRaw * 1.8);
    this.fx.hitFlash = Math.max(0, this.fx.hitFlash - dtRaw * 6);
    this.fx.slowmo += ((this.slowmo > 0 ? 1 : 0) - this.fx.slowmo) *
      Math.min(1, dtRaw * 8);
    const hpFrac = this.player.health / Math.max(1, this.player.maxHealth);
    this.fx.lowHealth += (Math.max(0, 1 - hpFrac / 0.35) - this.fx.lowHealth) *
      Math.min(1, dtRaw * 3);

    if (this.post) {
      this.post.damage = this.fx.damage;
      this.post.lowHealth = this.fx.lowHealth;
      this.post.hitFlash = this.fx.hitFlash;
      this.post.slowmo = this.fx.slowmo;
    }
    this._driveScore(dtRaw);

    this.vfx.updateTrail(this.player, this.player.profile.trail);
    this.vfx.updateTrail(this.enemy, this.enemy.profile.trail);
    this.vfx.update(dtRaw, this.camera);
    this._updateCamera(dtRaw);

    this.moon.target.position.lerp(
      _v.copy(this.player.pos).lerp(this.enemy.pos, 0.5), 0.1);
    this.moon.position.copy(this.moon.target.position).add(
      _v.set(-16, 22, -13));

    this._renderFrame(dtRaw);

    const visible = this.enemyVisible();
    this.hud.draw(dtRaw, {
      player: this.player, enemy: this.enemy, camera: this.camera,
      duel: this.duel, paused, started: this.started,
      showIndicator: visible && this.siege.phase === PHASE.ACTION,
    });
    this.siegeHud.draw(dtRaw, {
      siege: this.siege, compound: this.compound, gadgets: this.gadgets,
      player: this.player, enemy: this.enemy, camera: this.camera,
      enemyVisible: visible, time: this.time,
    });
  }

  /**
   * Music follows the situation, not the clock: how close the fight is, how
   * hurt you are, and whether you can see them at all.
   */
  _driveScore(dt) {
    if (!this.score) return;
    let state = 'menu';
    let intensity = 0.15;
    if (this.mode === 'match') {
      const phase = this.siege.phase;
      if (phase === PHASE.PREP) {
        state = 'prep';
        intensity = 0.3;
      } else if (phase === PHASE.ACTION) {
        const gap = this.player.pos.distanceTo(this.enemy.pos);
        const engaged = this.lockedOn || gap < 6;
        state = engaged ? 'combat' : 'stalk';
        const hurt = 1 - this.player.health / Math.max(1, this.player.maxHealth);
        const near = THREE.MathUtils.clamp(1 - (gap - 2) / 14, 0, 1);
        intensity = THREE.MathUtils.clamp(
          (engaged ? 0.55 : 0.2) + near * 0.25 + hurt * 0.3, 0, 1);
      } else if (phase === PHASE.RESOLVE || phase === PHASE.MATCH_OVER) {
        const won = this.siege.lastResult?.winner === 'player';
        state = won ? 'victory' : 'defeat';
        intensity = 0.4;
      }
    }
    this.score.setState(state);
    this.score.setIntensity(intensity);
    this.score.update(dt);
  }

  /**
   * World pass, then the viewmodel over the top with the depth buffer cleared
   * so your own weapon is never clipped by the wall you are standing against.
   */
  _renderFrame(dt = 0.016) {
    // The viewmodel lens must be synced before *either* render path runs —
    // the composer reads viewCam directly, so leaving this after an early
    // return renders the weapon from wherever the camera was last frame.
    const firstPerson = !!this.player.rig.firstPerson;
    if (firstPerson) {
      this.viewCam.position.copy(this.camera.position)
        .addScaledVector(this.camera.getWorldDirection(_viewDir), -this.viewCamBack);
      this.viewCam.quaternion.copy(this.camera.quaternion);
      this.viewCam.updateMatrixWorld(true);
    }

    if (this.post?.enabled) {
      this.post.viewmodel = firstPerson;
      this.post.render(dt);
      return;
    }
    const r = this.renderer;
    r.render(this.scene, this.camera);
    if (!firstPerson) return;

    // three redraws scene.background at the start of *every* render, whatever
    // autoClear says — leaving it set would flood the frame with fog colour and
    // erase the world we just drew. Depth is cleared so the viewmodel is never
    // clipped by the wall the fighter is standing against.
    const bg = this.scene.background;
    this.scene.background = null;
    r.autoClear = false;
    r.clearDepth();
    r.render(this.scene, this.viewCam);
    r.autoClear = true;
    this.scene.background = bg;
  }

  /**
   * Prep is watched from above — the attacker's scouting pass, and the
   * defender's view of their own fortifications going up.
   */
  /**
   * Preparation input. The defender is fortifying, but the attacker has no
   * gadgets available this phase and cannot move, so without this the whole
   * 25 seconds is a cutscene. The mouse orbits, WASD pans, and Enter starts
   * the round the moment you have seen enough.
   */
  _scoutInput(p, move, dt) {
    const sc = this._scout;
    const moving = move.x || move.y;
    // The look angles the Input class already tracks double as orbit control.
    const yaw = this.input.yaw;
    const pitch = this.input.pitch;
    if (yaw !== sc._lastYaw || pitch !== sc._lastPitch) sc.idle = 0;
    else sc.idle += dt;
    sc._lastYaw = yaw; sc._lastPitch = pitch;
    sc.yaw = yaw;
    sc.pitch = THREE.MathUtils.clamp(0.35 + pitch * 0.9, 0.22, 1.32);

    if (moving) {
      sc.idle = 0;
      const c = Math.cos(sc.yaw), sn = Math.sin(sc.yaw);
      const step = 7 * dt;                     // metres per second, not per frame
      sc.focus.x = THREE.MathUtils.clamp(sc.focus.x - (move.x * c + move.y * sn) * step, -16, 16);
      sc.focus.z = THREE.MathUtils.clamp(sc.focus.z - (move.y * c - move.x * sn) * step, -16, 16);
    }
    if (p.keys?.includes('Enter') || p.dodge) {
      if (this.siege.skipPrep()) this.hud.say('THE HORN SOUNDS', '#e0c45a', 1.2);
    }
  }

  /**
   * Hand the two shadow-casting lights to the nearest braziers.
   *
   * The follower takes the brazier's intensity and the brazier's own light is
   * muted while it does, so the fire is lit once, not twice. Everything beyond
   * the nearest two keeps its cheap shadowless point light.
   */
  _followFireShadows() {
    if (!this.fireShadows.length) return;
    // Measured cost of a single shadow-casting brazier in this scene: 391 draw
    // calls, against 355 for everything else put together. A cube shadow map
    // renders the scene six times, and the compound is wide enough that little
    // is culled. The effect is real but slight — firelight here is warm fill
    // rather than a key — so it does not earn a doubled frame, and stays off
    // unless explicitly asked for with ?fireshadow.
    if (!this._fireShadowOptIn) {
      for (const l of this.fireShadows) l.visible = false;
      for (const bz of this.braziers) bz.light.visible = true;
      return;
    }
    const eye = this.camera.position;
    // Cheap partial selection: the list is short and this runs once a frame.
    let a = null, b = null, da = Infinity, db = Infinity;
    for (const bz of this.braziers) {
      const d = bz.position.distanceToSquared(eye);
      if (d < da) { b = a; db = da; a = bz; da = d; }
      else if (d < db) { b = bz; db = d; }
    }
    const chosen = [a, b];
    for (const bz of this.braziers) bz.light.visible = true;
    this.fireShadows.forEach((l, i) => {
      const bz = chosen[i];
      if (!bz || da > 400) { l.visible = false; return; }
      l.visible = true;
      l.position.copy(bz.position).setY(bz.position.y + 0.35);
      l.intensity = bz.light.intensity;
      l.distance = bz.light.distance;
      bz.light.visible = false;        // the follower is lighting it now
    });
  }

  _updateCamera(dt) {
    if (this.siege.phase === PHASE.PREP) {
      const sc = this._scout;
      // Only drift when the player is not steering, so the view is theirs the
      // instant they touch the mouse but never sits dead still if they don't.
      if (sc.idle > 1.5) this._prepAngle += dt * 0.12;
      const a = sc.yaw + this._prepAngle;
      const r = sc.dist * Math.cos(sc.pitch * 0.55);
      _v.set(sc.focus.x + Math.sin(a) * r,
        6 + Math.sin(sc.pitch) * 19,
        sc.focus.z + Math.cos(a) * r);
      this.camera.position.lerp(_v, 1 - Math.exp(-6 * dt));
      this.camera.lookAt(sc.focus.x, 0.5, sc.focus.z);
      return;
    }
    this.fpCam.update(dt, this.player, this.enemy, this.lockedOn);
  }
}

// ------------------------------------------------------------------ bootstrap

async function boot() {
  const canvas = document.getElementById('view');
  const canvas2d = document.getElementById('hud');
  const loading = document.getElementById('loading');

  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  const boot0 = viewportSize();
  renderer.setSize(boot0.w, boot0.h);
  renderer.shadowMap.enabled = true;
  // PCFSoftShadowMap is deprecated, not gone: three still defines it, but
  // WebGLShadowMap.render reassigns this.type to PCFShadowMap on first use and
  // warns once. Asking for it therefore bought nothing — the scene was already
  // drawing hard PCF edges. Requesting PCF explicitly and taking the softness
  // from the light's own shadow.radius (see world.js) is the supported route;
  // radius feeds the 5-tap Vogel disk in the PCF branch of
  // shadowmap_pars_fragment, so it genuinely widens the penumbra.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;

  let assets;
  try {
    assets = await loadAll();
  } catch (err) {
    loading.textContent = `Failed to load assets: ${err.message}`;
    throw err;
  }

  // None of these models carry UVs, so surface detail is projected on rather
  // than mapped. Doing it once here means every clone taken later shares the
  // treated material.
  {
    let matched = 0;
    const missed = new Set();
    for (const gltf of Object.values(assets)) {
      if (!gltf?.scene) continue;
      const r = detailScene(gltf.scene);
      matched += r.matched;
      r.missed.forEach((m) => missed.add(m));
    }
    if (missed.size) {
      console.warn(`[art-of-battle] no surface family for: ${[...missed].join(', ')}`);
    }
    console.info(`[art-of-battle] surface detail on ${matched} materials`);
  }

  const game = new Game(assets, renderer, canvas2d);
  window.__game = game;   // handy for tuning from the console

  loading.classList.add('gone');
  canvas.addEventListener('click', () => {
    game.audio.unlock();
    game.audio.startAmbience();
    game.score.start();
    game.started = true;
    game.paused = false;
  });

  window.addEventListener('resize', () => {
    const { w, h, aspect } = viewportSize();
    game.camera.aspect = aspect;
    game.camera.updateProjectionMatrix();
    game.viewCam.aspect = aspect;
    game.viewCam.updateProjectionMatrix();
    renderer.setSize(w, h);
    game.post?.setSize(w, h);
  });

  let last = performance.now();
  renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    game.update(dt);
  });
}

boot();
