import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';

/**
 * Post-processing for the duel.
 *
 * The chain, in order:
 *
 *   1. WorldViewmodelPass  world with `camera`, then the first-person arms and
 *                          weapon with `viewCam` over the top, depth cleared —
 *                          the same two-pass trick the game does directly.
 *   2. UnrealBloomPass     bloom on the *linear HDR* buffer, so the threshold
 *                          means something physical: fire, sparks, blade glints
 *                          push past 1.0, moonlit stone does not.
 *   3. OutputPass          ACES tone map + sRGB, read live off the renderer, so
 *                          the game's exposure of 1.12 still applies.
 *   4. FXAA (or SMAA)      renderer `antialias:true` does nothing once we draw
 *                          into a render target, so AA has to be a pass. FXAA is
 *                          one pass where SMAA is three, which is why it is the
 *                          default; both want tone-mapped sRGB input, which is
 *                          exactly what step 3 hands them.
 *   5. GradePass           one shader: chromatic aberration, vignette, animated
 *                          film grain, and the four gameplay drives. Last, so
 *                          the grain stays crisp instead of being chewed by AA.
 *
 * Deliberately NOT here: SSAO/GTAO. Both want a depth+normal prepass of the
 * whole scene — a second geometry submission — and neither can see the
 * viewmodel layer without unpicking the depth-clear trick. The compound does
 * have the hard corners AO likes, but they sit in FogExp2 and are lit almost
 * entirely by flickering point lights, so the contact darkening lands on
 * surfaces that are already dark and reads as mud rather than depth. Two more
 * fullscreen passes for that trade is the wrong side of the budget; the look is
 * carried by bloom and the grade instead.
 */

// --------------------------------------------------------------- world pass

/**
 * Draws the world, then the viewmodel on top of it into the same target.
 *
 * `needsSwap = false` so it behaves like RenderPass: it writes into the read
 * buffer and the next pass picks it straight up.
 */
class WorldViewmodelPass extends Pass {
  constructor(fx) {
    super();
    this.fx = fx;
    this.needsSwap = false;
  }

  render(renderer, writeBuffer, readBuffer) {
    const fx = this.fx;
    const prevAutoClear = renderer.autoClear;

    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.autoClear = true;
    renderer.render(fx.scene, fx.camera);

    if (fx.viewmodel) {
      // three repaints scene.background at the start of *every* render call
      // whatever autoClear says, so it has to come off or the second pass
      // floods the frame with fog colour. Depth is cleared so the weapon is
      // never clipped by the wall the fighter is pressed against.
      const bg = fx.scene.background;
      fx.scene.background = null;
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(fx.scene, fx.viewCam);
      fx.scene.background = bg;
    }

    renderer.autoClear = prevAutoClear;
  }
}

// -------------------------------------------------------------- grade shader

const GradeShader = {
  name: 'GradeShader',

  uniforms: {
    tDiffuse:     { value: null },
    uResolution:  { value: new THREE.Vector2(1, 1) },
    uSeed:        { value: new THREE.Vector2(0, 0) },
    uTime:        { value: 0 },
    uGrainScale:  { value: 1 },   // device px per grain cell
    uAberration:  { value: 1.1 }, // radial RGB split at the corner, in px
    uGrain:       { value: 0.055 },
    uVignette:    { value: 0.34 },
    uDamage:      { value: 0 },
    uLowHealth:   { value: 0 },
    uHitFlash:    { value: 0 },
    uSlowmo:      { value: 0 },
  },

  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2  uResolution;
    uniform vec2  uSeed;
    uniform float uTime;
    uniform float uGrainScale;
    uniform float uAberration;
    uniform float uGrain;
    uniform float uVignette;
    uniform float uDamage;
    uniform float uLowHealth;
    uniform float uHitFlash;
    uniform float uSlowmo;

    varying vec2 vUv;

    // Cheap hash — no sin(), which bands badly on some integrated drivers.
    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    void main() {
      vec2 c  = vUv - 0.5;          // -0.5 .. 0.5
      float rl = length(c);
      float rr = rl * 2.0;          // 0 centre, ~1.41 corner
      float falloff = rr * rr;      // quadratic: the middle of frame stays clean

      // --- chromatic aberration -------------------------------------------
      // Widens on damage and in parry slow-motion; a lens under stress.
      float shiftPx = uAberration * falloff *
        (1.0 + uDamage * 1.6 + uSlowmo * 0.7);
      vec2 dir = rl > 1e-5 ? c / rl : vec2(0.0);
      vec2 off = dir * shiftPx / uResolution;

      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;

      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));

      // --- parry slow-motion: cooler and punchier --------------------------
      vec3 cool = col * vec3(0.87, 0.97, 1.20);
      cool = clamp((cool - 0.5) * 1.20 + 0.5, 0.0, 1.0);
      col = mix(col, cool, uSlowmo);

      // Edge masks. rr is 0 at the centre, 1.0 at the middle of the short
      // edges and ~1.41 in the corners, so anything meant to read as a border
      // effect has to start well past 0.5 or it floods the whole frame.
      float edge  = smoothstep(0.52, 1.28, rr);   // sustained, softer
      float dEdge = smoothstep(0.44, 1.20, rr);   // hit pulse, reaches further

      // --- low health: sustained desaturation + red creeping in at the edge -
      float pulse = 0.5 + 0.5 * sin(uTime * 3.2);
      col = mix(col, vec3(lum), uLowHealth * 0.55);
      col.gb *= 1.0 - uLowHealth * edge * (0.34 + 0.16 * pulse);
      col.r  += uLowHealth * edge * (0.05 + 0.04 * pulse);

      // --- damage: hard red vignette pulse on a landed hit ------------------
      col.gb *= 1.0 - uDamage * dEdge * 0.80;
      col.r   = min(1.0, col.r + uDamage * dEdge * 0.26);

      // --- hit flash: brief warm lift, brightest through the middle ---------
      float centre = 1.0 - smoothstep(0.0, 1.1, rr);
      col += vec3(1.0, 0.95, 0.84) * uHitFlash * (0.14 + 0.16 * centre);

      // --- vignette ---------------------------------------------------------
      col *= 1.0 - uVignette * smoothstep(0.45, 1.35, rr);

      // --- film grain -------------------------------------------------------
      // Weighted toward the shadows so the fire and the moon stay clean, which
      // is how film actually grains and keeps the dusk mood readable.
      float n = hash21(floor(gl_FragCoord.xy / uGrainScale) + uSeed);
      float shadow = 1.0 - smoothstep(0.0, 0.65, lum);
      col += (n - 0.5) * uGrain * (0.35 + 0.65 * shadow);

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};

// ---------------------------------------------------------------- quality

/**
 * `pixelRatioCap` is the important one. Every pass in the chain is a fullscreen
 * quad over a half-float buffer, so cost scales with buffer area and nothing
 * else — running the post chain at 1.5x on a 2x display is ~45% cheaper for a
 * softening you have to hunt for. The HUD is a separate 2D canvas and stays at
 * full device resolution, so all the text stays razor sharp either way.
 */
const QUALITY = {
  high: {
    aa: 'fxaa',           // one pass; 'smaa' is three. See the `aa` option.
    // Measured: at a full 2x device ratio this chain drops frames even on an
    // Apple M4 (p95 33ms); at 1.75 and below it sits locked on 60. 1.5 keeps a
    // margin. Pass `pixelRatioCap: 2` if you would rather have the sharpness.
    pixelRatioCap: 1.5,
    bloomScale: 1,        // UnrealBloomPass already halves what it is given
    bloomStrength: 0.62,
    bloomRadius: 0.58,
    bloomThreshold: 1.0,
    aberration: 1.1,
    grain: 0.055,
    vignette: 0.34,
  },
  // The integrated-graphics tier: 1:1 with CSS pixels whatever the display is
  // doing, a quarter-resolution bloom and no chromatic aberration.
  medium: {
    aa: 'fxaa',
    pixelRatioCap: 1,
    bloomScale: 0.5,      // → quarter resolution bloom
    bloomStrength: 0.55,
    bloomRadius: 0.7,
    bloomThreshold: 1.05,
    aberration: 0,        // skip the extra two taps
    grain: 0.045,
    vignette: 0.32,
  },
};

// ------------------------------------------------------------------- PostFX

export class PostFX {
  /**
   * @param {object}  o
   * @param {THREE.WebGLRenderer} o.renderer
   * @param {THREE.Scene}  o.scene
   * @param {THREE.Camera} o.camera    world camera (layer 0)
   * @param {THREE.Camera} o.viewCam   viewmodel camera (layer 1)
   * @param {string}  [o.quality='high']
   * @param {boolean} [o.enabled=true]
   * @param {string}  [o.aa]             `'fxaa'` | `'smaa'`, overrides the tier
   * @param {number}  [o.pixelRatioCap]  overrides the tier's render scale cap
   */
  constructor({ renderer, scene, camera, viewCam, quality = 'high', enabled = true,
    aa, pixelRatioCap }) {
    this.renderer = renderer;
    this._aaOverride = aa;
    this._prOverride = pixelRatioCap;
    this.scene = scene;
    this.camera = camera;
    this.viewCam = viewCam;

    this.enabled = enabled;

    /**
     * Whether to draw the first-person arms/weapon this frame. Mirrors
     * `player.rig.firstPerson` — set it before each `render()`.
     */
    this.viewmodel = true;

    // Gameplay drives, 0..1. `damage` and `hitFlash` are described as pulses,
    // so they bleed off on their own; poke them once and they fade. Writing a
    // value every frame still wins, so a caller that drives them explicitly
    // behaves exactly as it expects.
    this.damage = 0;
    this.lowHealth = 0;
    this.hitFlash = 0;
    this.slowmo = 0;
    this.autoDecay = true;
    this.damageDecay = 2.2;     // per second
    this.hitFlashDecay = 7.0;

    const size = renderer.getSize(new THREE.Vector2());
    this.width = Math.max(1, Math.round(size.x) || 1);
    this.height = Math.max(1, Math.round(size.y) || 1);

    this._t = 0;
    this._pixelRatio = 1;
    this.quality = 'off';
    this.composer = null;

    this.setQuality(quality);
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * `'high'` — SMAA + half-res bloom + full grade.
   * `'medium'` — FXAA, quarter-res bloom, pixel ratio capped at 1.5, no CA.
   * `'off'` — tears the stack down entirely and renders straight to the canvas.
   */
  setQuality(quality) {
    const q = QUALITY[quality] ? quality : 'off';
    if (q === this.quality) return;
    this.quality = q;

    this._teardown();
    if (q === 'off') return;

    const cfg = QUALITY[q];

    // HalfFloat so the world pass keeps linear HDR values for the bloom
    // threshold to bite on; depth buffer so the viewmodel depth clear works.
    const rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    rt.texture.name = 'PostFX.scene';

    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.renderToScreen = true;

    this.worldPass = new WorldViewmodelPass(this);
    this.composer.addPass(this.worldPass);

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      cfg.bloomStrength, cfg.bloomRadius, cfg.bloomThreshold,
    );
    this.composer.addPass(this.bloomPass);

    // Tone mapping and colour space, pulled live off the renderer each frame.
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    const aa = this._aaOverride || cfg.aa;
    this.aaPass = aa === 'smaa' ? new SMAAPass() : new FXAAPass();
    this.composer.addPass(this.aaPass);

    this.gradePass = new ShaderPass(GradeShader);
    this.grade = this.gradePass.uniforms;
    this.grade.uAberration.value = cfg.aberration;
    this.grade.uGrain.value = cfg.grain;
    this.grade.uVignette.value = cfg.vignette;
    this.composer.addPass(this.gradePass);

    this._bloomScale = cfg.bloomScale;
    this._pixelRatioCap = this._prOverride ?? cfg.pixelRatioCap;

    this._resize();
  }

  /** Release every GPU resource. Safe to call more than once. */
  dispose() {
    this._teardown();
  }

  _teardown() {
    if (!this.composer) return;
    for (const pass of this.composer.passes) pass.dispose?.();
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
    this.composer.copyPass.dispose?.();
    this.composer = null;
    this.worldPass = this.bloomPass = this.outputPass = null;
    this.aaPass = this.gradePass = this.grade = null;
  }

  // ------------------------------------------------------------------ size

  /**
   * @param {number} width  CSS pixels, same units as `renderer.setSize`
   * @param {number} height
   */
  setSize(width, height) {
    // A hidden tab or a collapsed pane reports 0x0; a zero-sized target is a
    // GL error on some drivers and NaN everywhere else.
    this.width = Math.max(1, Math.round(width) || 0);
    this.height = Math.max(1, Math.round(height) || 0);
    this._resize();
  }

  _resize() {
    if (!this.composer) return;

    const pr = Math.max(0.5,
      Math.min(this._pixelRatioCap, this.renderer.getPixelRatio() || 1));
    this._pixelRatio = pr;

    // Round to whole device pixels ourselves and drive the composer at a ratio
    // of 1: EffectComposer multiplies size by its pixel ratio without
    // rounding, and a 1732.5-wide render target is not a thing.
    const w = Math.max(1, Math.round(this.width * pr));
    const h = Math.max(1, Math.round(this.height * pr));

    // EffectComposer.setSize / WebGLRenderTarget.setSize dispose the old
    // texture and framebuffer before allocating the new one, so repeated
    // resizes do not pile up render targets. Same for every pass below.
    this.composer.setPixelRatio(1);
    this.composer.setSize(w, h);

    // UnrealBloomPass halves whatever size it is given, so `bloomScale` of 1
    // is half resolution and 0.5 is quarter.
    if (this._bloomScale !== 1) {
      this.bloomPass.setSize(
        Math.max(2, Math.round(w * this._bloomScale)),
        Math.max(2, Math.round(h * this._bloomScale)),
      );
    }

    this.grade.uResolution.value.set(w, h);
    this.grade.uGrainScale.value = Math.max(1, Math.round(pr));
  }

  // ---------------------------------------------------------------- render

  /** Replaces `renderer.render(...)`. `dt` is seconds since the last frame. */
  render(dt) {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 1 / 60;

    if (!this.enabled || !this.composer) {
      this._renderDirect();
      this._tick(step);
      return;
    }

    // The pixel ratio can change under us when the window moves between a
    // retina and a non-retina display.
    const pr = Math.min(this._pixelRatioCap, this.renderer.getPixelRatio() || 1);
    if (Math.abs(pr - this._pixelRatio) > 1e-3) this._resize();

    // Push first, decay after: a value the caller set this frame is used at
    // full strength this frame and only starts bleeding off on the next one.
    this._push();
    this.composer.render(step);
    this._tick(step);
  }

  /** The plain two-pass path — the game must always be playable. */
  _renderDirect() {
    const r = this.renderer;
    r.setRenderTarget(null);
    r.render(this.scene, this.camera);

    if (!this.viewmodel) return;
    const bg = this.scene.background;
    this.scene.background = null;
    const prevAutoClear = r.autoClear;
    r.autoClear = false;
    r.clearDepth();
    r.render(this.scene, this.viewCam);
    r.autoClear = prevAutoClear;
    this.scene.background = bg;
  }

  _tick(dt) {
    this._t = (this._t + dt) % 600;   // wrapped: keeps float precision sane
    if (!this.autoDecay) return;
    this.damage = Math.max(0, this.damage - dt * this.damageDecay);
    this.hitFlash = Math.max(0, this.hitFlash - dt * this.hitFlashDecay);
  }

  /** Copy the gameplay drives onto the grade shader. */
  _push() {
    const u = this.grade;
    const clamp01 = (v) => (v > 1 ? 1 : v > 0 ? v : 0);
    u.uTime.value = this._t;
    u.uSeed.value.set(Math.random() * 512, Math.random() * 512);
    u.uDamage.value = clamp01(this.damage);
    u.uLowHealth.value = clamp01(this.lowHealth);
    u.uHitFlash.value = clamp01(this.hitFlash);
    u.uSlowmo.value = clamp01(this.slowmo);
  }
}
