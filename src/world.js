import * as THREE from 'three';

/**
 * Scene, lighting and the arena's living details (fire, embers, flicker).
 * Dusk: a cold moon key with warm brazier fill, so the two fighters read as
 * silhouettes edged in orange.
 */

const FOG_COLOR = 0x14161f;

/** Soft round sprite — without a map, THREE.Points renders hard squares. */
let _soft = null;
function softSprite() {
  if (_soft) return _soft;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0.0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.3, 'rgba(255,196,120,0.62)');
  grd.addColorStop(1.0, 'rgba(255,110,20,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  _soft = new THREE.CanvasTexture(c);
  _soft.colorSpace = THREE.SRGBColorSpace;
  return _soft;
}

export function buildSky() {
  const geo = new THREE.SphereGeometry(220, 32, 24);
  const colors = [];
  const pos = geo.attributes.position;
  const top = new THREE.Color(0x0a0d18);
  const mid = new THREE.Color(0x232a3d);
  const horizon = new THREE.Color(0x4a3a35);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const h = pos.getY(i) / 220;
    if (h > 0.05) c.copy(mid).lerp(top, Math.min(1, h * 1.5));
    else c.copy(horizon).lerp(mid, Math.min(1, (h + 0.35) / 0.4));
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
  }));
  mesh.renderOrder = -1000;
  return mesh;
}

function starField() {
  const n = 900;
  const pos = new Float32Array(n * 3);
  const size = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * Math.PI * 2;
    const v = Math.acos(2 * Math.random() - 1);
    const r = 190;
    const y = Math.abs(Math.cos(v)) * r;
    pos[i * 3] = Math.sin(v) * Math.cos(u) * r;
    pos[i * 3 + 1] = y * 0.9 + 12;
    pos[i * 3 + 2] = Math.sin(v) * Math.sin(u) * r;
    size[i] = Math.random() < 0.08 ? 2.6 : 1.2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const mat = new THREE.PointsMaterial({
    color: 0xbcc8e0, size: 1.1, sizeAttenuation: false,
    transparent: true, opacity: 0.75, fog: false, depthWrite: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.renderOrder = -999;
  return pts;
}

/**
 * A tiny scene PMREM'd into an environment map. Without one, every metal in
 * the armour renders black.
 */
export function buildEnvironment(renderer) {
  const env = new THREE.Scene();
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(40, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x44506b, side: THREE.BackSide }),
  );
  env.add(dome);
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(38, 24),
    new THREE.MeshBasicMaterial({ color: 0x14100c, side: THREE.DoubleSide }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -3;
  env.add(ground);
  // Warm sources roughly where the braziers sit.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(2.4, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xa84a14 }),
    );
    m.position.set(Math.cos(a) * 18, 0.8, Math.sin(a) * 18);
    env.add(m);
  }
  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(5, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xcfdcf5 }),
  );
  moon.position.set(-14, 24, -20);
  env.add(moon);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(env, 0.04);
  pmrem.dispose();
  return target.texture;
}

/**
 * The cone of lit air above a brazier.
 *
 * Real volumetrics would mean marching the depth buffer; at this scale a piece
 * of additive geometry reads the same and costs one draw call. Two things stop
 * it looking like a solid cone: it fades out towards the tip, and it fades as
 * the surface turns edge-on to the camera, so there is never a hard silhouette
 * where the geometry ends.
 */
const SHAFT_VERT = `
varying vec2 vUvS;
varying vec3 vNrmS;
varying vec3 vViewS;
void main() {
  vUvS = uv;
  vNrmS = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewS = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const SHAFT_FRAG = `
uniform vec3 uColor;
uniform float uIntensity;
varying vec2 vUvS;
varying vec3 vNrmS;
varying vec3 vViewS;
void main() {
  // uv.y runs 0 at the base to 1 at the tip on a cone.
  float height = 1.0 - vUvS.y;
  float fade = pow(height, 2.2);
  // Edge-on faces are where the eye would notice the geometry, so hide them.
  float facing = 1.0 - abs(dot(normalize(vNrmS), normalize(vViewS)));
  fade *= smoothstep(1.0, 0.35, facing);
  gl_FragColor = vec4(uColor * uIntensity * fade, fade);
}`;

function buildShaft(color) {
  const geo = new THREE.ConeGeometry(1.15, 3.1, 14, 1, true);
  geo.translate(0, 1.55, 0);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uIntensity: { value: 0.5 },
    },
    vertexShader: SHAFT_VERT,
    fragmentShader: SHAFT_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geo, mat);
}

export class Brazier {
  constructor(position) {
    this.position = position.clone();
    this.group = new THREE.Group();
    this.group.position.copy(position);

    this.light = new THREE.PointLight(0xff8a3a, 34, 24, 2);
    this.light.position.y = 0.35;
    this.light.castShadow = false;
    this.group.add(this.light);

    // Flame: a small billowing point cloud, additive.
    const n = 46;
    const pos = new Float32Array(n * 3);
    this.seeds = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      this.seeds[i * 3] = Math.random();
      this.seeds[i * 3 + 1] = 0.4 + Math.random() * 0.9;
      this.seeds[i * 3 + 2] = Math.random() * Math.PI * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.flame = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffa43c, size: 0.30, transparent: true, opacity: 0.8, map: softSprite(),
      blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
    }));
    this.group.add(this.flame);

    this.shaft = buildShaft(0xff8f42);
    this.shaft.position.y = 0.3;
    this.group.add(this.shaft);

    this.phase = Math.random() * 20;
  }

  update(t) {
    const p = this.flame.geometry.attributes.position;
    const s = this.seeds;
    for (let i = 0; i < p.count; i++) {
      const life = (t * s[i * 3 + 1] * 0.75 + s[i * 3]) % 1;
      const spread = 0.16 * (1 - life) + 0.03;
      const wob = Math.sin(t * 5 + s[i * 3 + 2]) * 0.09 * life;
      p.setXYZ(i,
        Math.cos(s[i * 3 + 2]) * spread + wob,
        life * 0.95 + 0.1,
        Math.sin(s[i * 3 + 2]) * spread + wob * 0.6);
    }
    p.needsUpdate = true;
    const flicker = 0.78 + Math.sin(t * 11 + this.phase) * 0.12 +
      Math.sin(t * 27.3 + this.phase * 2) * 0.08;
    this.light.intensity = 34 * flicker;
    this.flame.material.opacity = 0.7 + flicker * 0.22;
    // The shaft breathes with the flame, but at a fraction of its swing — lit
    // air lags the fire that lights it.
    this.shaft.material.uniforms.uIntensity.value = 0.34 + flicker * 0.20;
    this.shaft.rotation.y = t * 0.15 + this.phase;
  }
}

/**
 * Slow-drifting ash and dust hanging in the air.
 *
 * Costs almost nothing and does more for the sense of place than any amount of
 * extra geometry — the space stops feeling like a vacuum. Additive, unlit, and
 * wrapped in a moving box so it follows the fight without ever running out.
 */
export class Motes {
  constructor(count = 260, extent = 26, height = 7) {
    this.extent = extent;
    this.height = height;
    const pos = new Float32Array(count * 3);
    this.drift = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * extent;
      pos[i * 3 + 1] = Math.random() * height;
      pos[i * 3 + 2] = (Math.random() - 0.5) * extent;
      this.drift[i * 3] = (Math.random() - 0.5) * 0.18;
      this.drift[i * 3 + 1] = 0.02 + Math.random() * 0.09;
      this.drift[i * 3 + 2] = (Math.random() - 0.5) * 0.18;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), extent);
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xc8b79a, size: 0.035, transparent: true, opacity: 0.5,
      depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
      map: softSprite(), sizeAttenuation: true,
    }));
    this.points.frustumCulled = false;
    this.centre = new THREE.Vector3();
  }

  /** `focus` is where the fight is; the field recentres so it never runs dry. */
  update(dt, focus, time) {
    const p = this.points.geometry.attributes.position;
    const a = p.array;
    const half = this.extent / 2;
    if (focus) this.centre.set(focus.x, 0, focus.z);
    for (let i = 0; i < p.count; i++) {
      const j = i * 3;
      // A lazy breeze, so the field is never a rigid upward march.
      a[j] += (this.drift[j] + Math.sin(time * 0.3 + i) * 0.05) * dt;
      a[j + 1] += this.drift[j + 1] * dt;
      a[j + 2] += (this.drift[j + 2] + Math.cos(time * 0.24 + i) * 0.05) * dt;
      if (a[j + 1] > this.height) a[j + 1] -= this.height;
      // Wrap around the focus rather than the origin.
      const dx = a[j] - this.centre.x;
      const dz = a[j + 2] - this.centre.z;
      if (dx > half) a[j] -= this.extent; else if (dx < -half) a[j] += this.extent;
      if (dz > half) a[j + 2] -= this.extent; else if (dz < -half) a[j + 2] += this.extent;
    }
    p.needsUpdate = true;
  }
}

export function buildWorld(renderer, arenaScene) {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(FOG_COLOR, 0.017);
  scene.background = new THREE.Color(FOG_COLOR);
  scene.environment = buildEnvironment(renderer);
  scene.environmentIntensity = 0.85;

  scene.add(buildSky());
  scene.add(starField());

  const hemi = new THREE.HemisphereLight(0x46597f, 0x2a1f13, 0.98);
  scene.add(hemi);

  const moon = new THREE.DirectionalLight(0xb0c6ec, 2.15);
  moon.position.set(-16, 22, -13);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  const sc = moon.shadow.camera;
  sc.left = -14; sc.right = 14; sc.top = 14; sc.bottom = -14;
  sc.near = 1; sc.far = 60;
  moon.shadow.bias = -0.0007;
  moon.shadow.normalBias = 0.022;
  // Moonlight is a large, distant source, so its shadows should not be razor
  // edged. This carries the softness that PCFSoftShadowMap used to provide
  // before three removed it.
  moon.shadow.radius = 3.2;
  scene.add(moon);
  scene.add(moon.target);

  // A soft warm bounce so the shadowed side of the armour is not dead black.
  const fill = new THREE.DirectionalLight(0xffb37a, 0.5);
  fill.position.set(11, 5, 9);
  scene.add(fill);

  const braziers = [];
  if (arenaScene) {
    arenaScene.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    const anchors = [];
    arenaScene.traverse((o) => {
      if (/^Light_Brazier/.test(o.name)) anchors.push(o);
    });
    arenaScene.updateMatrixWorld(true);
    for (const a of anchors) {
      const p = new THREE.Vector3().setFromMatrixPosition(a.matrixWorld);
      const b = new Brazier(p);
      braziers.push(b);
      scene.add(b.group);
    }
    scene.add(arenaScene);
  }

  // Catch shadows beyond the arena disc so fighters never look unmoored.
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(60, 48),
    new THREE.MeshStandardMaterial({ color: 0x1b1720, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  scene.add(ground);

  const motes = new Motes();
  scene.add(motes.points);

  // Firelight shadows, but only two of them.
  //
  // Eleven shadow-casting point lights would mean eleven cube shadow maps
  // rendered every frame. Instead two dedicated casters follow whichever
  // braziers are nearest the player and take over their lighting entirely, so
  // the fire nearest you throws real moving shadows and the rest stay cheap.
  // One caster, not two. Each shadow-casting point light renders six cube
  // faces of the scene, and measured here that is roughly +375 draw calls
  // apiece — enough to undo the batching this build exists to gain. One is
  // affordable at the top quality tier; two were not.
  const fireShadows = [];
  for (let i = 0; i < 1; i++) {
    const l = new THREE.PointLight(0xff8a3a, 0, 24, 2);
    l.castShadow = true;
    l.shadow.mapSize.set(512, 512);
    l.shadow.bias = -0.004;
    l.shadow.normalBias = 0.04;
    l.shadow.camera.near = 0.25;
    l.shadow.camera.far = 18;
    l.visible = false;
    scene.add(l);
    fireShadows.push(l);
  }

  return { scene, moon, braziers, hemi, motes, fireShadows };
}
