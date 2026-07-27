import * as THREE from 'three';

/**
 * Blade trails, sparks, impact flashes and dust. All pooled — nothing is
 * allocated during a fight.
 */

const MAX_SPARKS = 900;
const TRAIL_SEGMENTS = 14;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

const SPARK_VERT = /* glsl */`
attribute float aSize;
attribute vec3 aColor;
attribute float aLife;
varying vec3 vColor;
varying float vLife;
void main() {
  vColor = aColor;
  vLife = aLife;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (260.0 / max(0.1, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;

const SPARK_FRAG = /* glsl */`
varying vec3 vColor;
varying float vLife;
void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5 || vLife <= 0.0) discard;
  float a = smoothstep(0.5, 0.05, d) * vLife;
  gl_FragColor = vec4(vColor * (0.6 + a * 1.8), a);
}`;

class Sparks {
  constructor() {
    const pos = new Float32Array(MAX_SPARKS * 3);
    const col = new Float32Array(MAX_SPARKS * 3);
    const size = new Float32Array(MAX_SPARKS);
    const life = new Float32Array(MAX_SPARKS);
    this.vel = new Float32Array(MAX_SPARKS * 3);
    this.age = new Float32Array(MAX_SPARKS);
    this.ttl = new Float32Array(MAX_SPARKS);
    this.drag = new Float32Array(MAX_SPARKS);
    this.gravity = new Float32Array(MAX_SPARKS);
    this.head = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aLife', new THREE.BufferAttribute(life, 1));
    geo.setDrawRange(0, MAX_SPARKS);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 60);

    this.points = new THREE.Points(geo, new THREE.ShaderMaterial({
      vertexShader: SPARK_VERT,
      fragmentShader: SPARK_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    this.points.frustumCulled = false;
    this.geo = geo;
  }

  spawn(origin, opts) {
    const {
      count = 16, speed = 5, spread = 1, color = new THREE.Color(0xffb055),
      size = 0.09, ttl = 0.5, gravity = 9, drag = 2.6, dir = null,
      colorJitter = 0.2,
    } = opts;
    const pos = this.geo.attributes.position.array;
    const col = this.geo.attributes.aColor.array;
    const sz = this.geo.attributes.aSize.array;
    const lf = this.geo.attributes.aLife.array;

    for (let n = 0; n < count; n++) {
      const i = this.head;
      this.head = (this.head + 1) % MAX_SPARKS;
      pos[i * 3] = origin.x;
      pos[i * 3 + 1] = origin.y;
      pos[i * 3 + 2] = origin.z;

      _v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
      if (_v.lengthSq() < 1e-5) _v.set(0, 1, 0);
      _v.normalize();
      if (dir) _v.lerp(dir, 1 - spread * 0.5).normalize();
      const sp = speed * (0.35 + Math.random() * 0.9);
      this.vel[i * 3] = _v.x * sp;
      this.vel[i * 3 + 1] = _v.y * sp;
      this.vel[i * 3 + 2] = _v.z * sp;

      const j = 1 + (Math.random() - 0.5) * colorJitter;
      col[i * 3] = color.r * j;
      col[i * 3 + 1] = color.g * j;
      col[i * 3 + 2] = color.b * j;
      sz[i] = size * (0.6 + Math.random() * 0.9);
      lf[i] = 1;
      this.age[i] = 0;
      this.ttl[i] = ttl * (0.65 + Math.random() * 0.7);
      this.gravity[i] = gravity;
      this.drag[i] = drag;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aLife.needsUpdate = true;
  }

  update(dt) {
    const pos = this.geo.attributes.position.array;
    const lf = this.geo.attributes.aLife.array;
    let live = false;
    for (let i = 0; i < MAX_SPARKS; i++) {
      if (lf[i] <= 0) continue;
      live = true;
      this.age[i] += dt;
      const u = this.age[i] / this.ttl[i];
      if (u >= 1) { lf[i] = 0; continue; }
      lf[i] = 1 - u * u;
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= d;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.gravity[i] * dt;
      this.vel[i * 3 + 2] *= d;
      pos[i * 3] += this.vel[i * 3] * dt;
      pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (pos[i * 3 + 1] < 0.02) {
        pos[i * 3 + 1] = 0.02;
        this.vel[i * 3 + 1] *= -0.28;
        this.vel[i * 3] *= 0.6;
        this.vel[i * 3 + 2] *= 0.6;
      }
    }
    if (live) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.aLife.needsUpdate = true;
    }
  }
}

/** A ribbon swept between the blade's base and tip over recent frames. */
class Trail {
  constructor(color) {
    const geo = new THREE.BufferGeometry();
    const verts = new Float32Array(TRAIL_SEGMENTS * 2 * 3);
    const cols = new Float32Array(TRAIL_SEGMENTS * 2 * 4);
    const idx = [];
    for (let i = 0; i < TRAIL_SEGMENTS - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 4));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 60);

    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }));
    this.mesh.frustumCulled = false;
    this.geo = geo;
    this.color = new THREE.Color(color);
    this.count = 0;
    this.strength = 0;
    this.tips = Array.from({ length: TRAIL_SEGMENTS }, () => new THREE.Vector3());
    this.bases = Array.from({ length: TRAIL_SEGMENTS }, () => new THREE.Vector3());
  }

  push(base, tip, strength) {
    // Shift history down and write the newest sample at the head.
    for (let i = TRAIL_SEGMENTS - 1; i > 0; i--) {
      this.tips[i].copy(this.tips[i - 1]);
      this.bases[i].copy(this.bases[i - 1]);
    }
    this.tips[0].copy(tip);
    this.bases[0].copy(base);
    this.count = Math.min(TRAIL_SEGMENTS, this.count + 1);
    this.strength = strength;
  }

  update(dt) {
    this.strength = Math.max(0, this.strength - dt * 5.0);
    const pos = this.geo.attributes.position.array;
    const col = this.geo.attributes.color.array;
    const n = this.count;
    for (let i = 0; i < TRAIL_SEGMENTS; i++) {
      const j = Math.min(i, Math.max(0, n - 1));
      const b = this.bases[j];
      const t = this.tips[j];
      pos[i * 6] = b.x; pos[i * 6 + 1] = b.y; pos[i * 6 + 2] = b.z;
      pos[i * 6 + 3] = t.x; pos[i * 6 + 4] = t.y; pos[i * 6 + 5] = t.z;
      const fade = i < n ? Math.pow(1 - i / TRAIL_SEGMENTS, 1.7) : 0;
      const a = fade * this.strength;
      for (const k of [0, 1]) {
        const o = (i * 2 + k) * 4;
        col[o] = this.color.r;
        col[o + 1] = this.color.g;
        col[o + 2] = this.color.b;
        // The tip edge of the ribbon is brighter than the hilt edge.
        col[o + 3] = a * (k === 1 ? 0.30 : 0.0);
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.mesh.visible = this.strength > 0.01;
  }

  clear() {
    this.count = 0;
    this.strength = 0;
  }
}

/** A brief expanding disc at the point of contact. */
class Flash {
  constructor() {
    this.sprites = [];
    this.group = new THREE.Group();
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0,
          blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        }),
      );
      m.visible = false;
      this.group.add(m);
      this.sprites.push({ mesh: m, age: 0, ttl: 0, size: 1 });
    }
    this.head = 0;
  }

  spawn(point, color, size, ttl = 0.16) {
    const s = this.sprites[this.head];
    this.head = (this.head + 1) % this.sprites.length;
    s.mesh.position.copy(point);
    s.mesh.material.color.set(color);
    s.age = 0;
    s.ttl = ttl;
    s.size = size;
    s.mesh.visible = true;
  }

  update(dt, camera) {
    for (const s of this.sprites) {
      if (!s.mesh.visible) continue;
      s.age += dt;
      const u = s.age / s.ttl;
      if (u >= 1) { s.mesh.visible = false; s.mesh.material.opacity = 0; continue; }
      const k = s.size * (0.5 + u * 1.5);
      s.mesh.scale.set(k, k, k);
      s.mesh.material.opacity = (1 - u) * (1 - u) * 0.9;
      s.mesh.quaternion.copy(camera.quaternion);
    }
  }
}

export class VFX {
  constructor(scene) {
    this.scene = scene;
    this.sparks = new Sparks();
    this.flash = new Flash();
    scene.add(this.sparks.points);
    scene.add(this.flash.group);
    this.trails = new Map();
    this._c = new THREE.Color();
  }

  trailFor(fighter, color) {
    let t = this.trails.get(fighter);
    if (!t) {
      t = new Trail(color);
      this.trails.set(fighter, t);
      this.scene.add(t.mesh);
    }
    return t;
  }

  /** Steel on steel: hot white sparks that bounce and die fast. */
  clash(point, dir) {
    this.sparks.spawn(point, {
      count: 30, speed: 7.5, spread: 1.4, size: 0.075, ttl: 0.55,
      color: this._c.setHex(0xffd9a0), gravity: 11, drag: 1.8, dir,
      colorJitter: 0.35,
    });
    this.flash.spawn(point, 0xfff0d0, 1.5, 0.13);
  }

  parryBurst(point) {
    this.sparks.spawn(point, {
      count: 54, speed: 10, spread: 1.6, size: 0.095, ttl: 0.75,
      color: this._c.setHex(0xfff4c8), gravity: 9, drag: 1.4,
      colorJitter: 0.3,
    });
    this.flash.spawn(point, 0xffffff, 2.9, 0.24);
  }

  bloodHit(point, dir, heavy) {
    this.sparks.spawn(point, {
      count: heavy ? 34 : 20, speed: heavy ? 5.2 : 3.6, spread: 1.1,
      size: heavy ? 0.10 : 0.075, ttl: 0.75,
      color: this._c.setHex(0x8e1414), gravity: 13, drag: 2.2, dir,
      colorJitter: 0.4,
    });
    this.flash.spawn(point, 0xff5533, heavy ? 1.5 : 1.0, 0.12);
  }

  dust(point, amount = 10, up = 1.6) {
    _v2.set(0, 1, 0);
    this.sparks.spawn(point, {
      count: amount, speed: up, spread: 1.7, size: 0.16, ttl: 0.85,
      color: this._c.setHex(0x50463a), gravity: 1.6, drag: 3.4, dir: _v2,
      colorJitter: 0.25,
    });
  }

  unblockableTell(point) {
    this.sparks.spawn(point, {
      count: 26, speed: 2.2, spread: 1.8, size: 0.11, ttl: 0.7,
      color: this._c.setHex(0xff7a10), gravity: -1.4, drag: 1.6,
      colorJitter: 0.2,
    });
  }

  /** Feed the blade trail; call every frame with the fighter's swing state. */
  updateTrail(fighter, color) {
    const t = this.trailFor(fighter, color);
    const active = fighter.state === 'attack' && fighter.attack &&
      fighter.clipTime > fighter.attack.windup * 0.82 &&
      fighter.clipTime < fighter.attack.strike + 0.22;
    if (active) {
      t.push(fighter.rig.bladePoint(0.58, _v), fighter.rig.bladeTip(_v2), 1);
    } else if (t.strength <= 0.02) {
      t.clear();
      t.push(fighter.rig.bladePoint(0.58, _v), fighter.rig.bladeTip(_v2), 0);
    }
  }

  update(dt, camera) {
    this.sparks.update(dt);
    this.flash.update(dt, camera);
    for (const t of this.trails.values()) t.update(dt);
  }
}
