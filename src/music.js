/**
 * Adaptive procedural score for art-of-battle.
 *
 * Everything is synthesized at runtime with the Web Audio API — no files, no
 * fetch, no base64. The Score never creates its own AudioContext: it borrows
 * the AudioEngine's (see audio.js) via attach(), so the game only ever has one
 * context and one master bus. If there is no context, or it can't be resumed,
 * every public method quietly no-ops.
 *
 * ---------------------------------------------------------------- musical idea
 * One tonal centre for the whole game: D. The *mode* changes with the game
 * state rather than the key, so states can cross-fade over a drone that never
 * has to move — Aeolian for the camp, Phrygian (that flat 2nd) when blades are
 * out, Dorian for a win. Drones and open fifths, no triads: pre-tonal, medieval,
 * not Hollywood. Percussion is struck wood, skin and iron, all synthesized.
 *
 * ------------------------------------------------------------------ the layers
 *   drone  sawtooth organum at D1/D2/A2 through a breathing lowpass — always on
 *   buzz   resonant hurdy-gurdy rasp; rides intensity, the "harsh" drone
 *   air    filtered noise bed, the room tone; loudest when stalking
 *   pluck  Karplus-Strong gut string; the lone motif in menu/prep
 *   perc   frame drum, wood, iron; density and weight scale with intensity
 *   ost    reedy low ostinato in fifths; combat only
 *   pulse  sub heartbeat; prep and combat
 *   swell  slow dissonant bowed clusters; stalk's tension-from-restraint
 *   fx     stings and cadences
 *
 * ------------------------------------------------------------------- signal path
 *   layerGain -> musicBus -> lowShelf -> highShelf(-) -> lowpass -> comp -> master
 *   layerGain -> send -> convolver -> revReturn -> musicBus
 *
 * The high shelf and lowpass deliberately scoop 1.5k-8k so the score sits
 * *under* the blade clangs instead of fighting them. setVolume() ducks the lot.
 *
 * All notes are scheduled ahead on the AudioContext clock by a lookahead
 * scheduler driven from update(dt) — never one setTimeout per note — so timing
 * is sample-accurate and survives frame hitches. Every note voice disconnects
 * itself once its last source ends (with a timer backstop for throttled tabs).
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rnd = (a, b) => a + Math.random() * (b - a);
const EPS = 0.0001; // exponentialRamp can never reach zero

const MAX_VOICES = 40; // hard ceiling; a stall can never dogpile the graph
const LOOKAHEAD = 0.18; // seconds of music scheduled ahead of the clock
const STEP = 8; // eighth-notes per 4/4 bar

// --------------------------------------------------------------------- pitch
const ROOT = 73.416; // D2
const MODES = {
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10], // the flat 2nd — the "blades are out" colour
  dorian: [0, 2, 3, 5, 7, 9, 10],
};

/** Scale degree -> semitones from root. Degrees may run past the octave. */
function degree(mode, d) {
  const s = MODES[mode] || MODES.aeolian;
  const n = s.length;
  const oct = Math.floor(d / n);
  return s[((d % n) + n) % n] + 12 * oct;
}
const hz = (semi) => ROOT * Math.pow(2, semi / 12);

// ---------------------------------------------------------------- state table
// layers = base mix for the state; intensity then shapes it in _applyMix().
const STATES = {
  menu: {
    mode: 'aeolian',
    bpm: 46,
    layers: { drone: 0.55, buzz: 0.0, air: 0.14, pluck: 0.95, perc: 0.0, ost: 0, pulse: 0, swell: 0.10 },
  },
  prep: {
    mode: 'aeolian',
    bpm: 62,
    layers: { drone: 0.62, buzz: 0.10, air: 0.20, pluck: 0.45, perc: 0.55, ost: 0, pulse: 1.0, swell: 0.06 },
  },
  stalk: {
    mode: 'phrygian',
    bpm: 50,
    layers: { drone: 0.42, buzz: 0.05, air: 0.62, pluck: 0.14, perc: 0.08, ost: 0, pulse: 0.18, swell: 0.34 },
  },
  combat: {
    mode: 'phrygian',
    bpm: 96,
    layers: { drone: 0.92, buzz: 0.62, air: 0.10, pluck: 0, perc: 1.0, ost: 1.0, pulse: 0.35, swell: 0.03 },
  },
  victory: {
    mode: 'dorian',
    bpm: 56,
    layers: { drone: 0.55, buzz: 0.0, air: 0.12, pluck: 0.75, perc: 0.18, ost: 0, pulse: 0, swell: 0.0 },
  },
  defeat: {
    mode: 'phrygian',
    bpm: 42,
    layers: { drone: 0.52, buzz: 0.06, air: 0.30, pluck: 0.5, perc: 0.04, ost: 0, pulse: 0, swell: 0.06 },
  },
};

// Per-layer output trim, so the state table can stay in readable 0..1 terms.
const TRIM = {
  drone: 0.34,
  buzz: 0.15,
  air: 0.28,
  pluck: 0.48,
  perc: 0.58,
  ost: 0.24,
  pulse: 0.46,
  swell: 0.32,
  fx: 0.85,
};

// Reverb send per layer.
const SEND = { drone: 0.10, buzz: 0.05, air: 0.06, pluck: 0.34, perc: 0.16, ost: 0.09, pulse: 0.04, swell: 0.55, fx: 0.40 };

const LAYERS = ['drone', 'buzz', 'air', 'pluck', 'perc', 'ost', 'pulse', 'swell', 'fx'];

// Menu/prep motif: a lone modal phrase with deliberate holes in it.
const MOTIF_MENU = [0, 4, 2, 4, 7, 4, 2, -1, 0, 3, 2, 0];
const MOTIF_PREP = [0, 3, 4, 3, 0, 2, 4, 5];
// Combat ostinato over one bar of eighths; null = rest. Degrees, Phrygian.
const OSTINATO = [0, 0, 1, 0, 3, 0, 1, -2];

export class Score {
  constructor() {
    this.ctx = null;
    this._engine = null;
    this._dest = null;
    this._offline = false;
    this._supported = true;

    this._built = false;
    this._running = false;
    this._gen = 0; // bumped on stop() so pending teardowns can't hit a new graph

    this._volume = 0.7;
    this._intTarget = 0.25;
    this._int = 0.25;
    this._state = 'menu';
    this._st = STATES.menu;

    this._bpm = STATES.menu.bpm;
    this._step = 0;
    this._nextStep = 0;
    this._mixAccum = 1; // force a mix update on the first frame
    this._phrase = 0;
    this._nextSwell = 0;
    this._activeVoices = 0;

    this._nodes = []; // permanent bus + layer nodes
    this._sources = []; // permanent oscillators / noise loops
    this._layer = {}; // name -> GainNode
    this._teardown = null;

    this._noiseWhite = null;
    this._noiseBrown = null;
    this._softCurve = null;
    this._droneLP = null;
    this._buzzBP = null;
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Borrow the SFX engine's AudioContext and master bus. Safe to call before
   * the engine is unlocked — the graph is built lazily once a context exists.
   * Also accepts a bare AudioContext/OfflineAudioContext (handy for tests).
   */
  attach(engine) {
    if (!this._supported) return;
    try {
      this._engine = engine || null;
      this._resolveCtx();
    } catch (e) {
      /* ignore */
    }
  }

  /** Begin playing. Call after a user gesture (the engine must be unlocked). */
  start() {
    if (!this._supported || this._running) return;
    try {
      this._running = true;
      if (this._teardown) {
        clearTimeout(this._teardown);
        this._teardown = null;
      }
      if (!this._ensure()) return; // will retry from update()
      this._beginTransport();
    } catch (e) {
      /* ignore */
    }
  }

  /** Fade out and tear the graph down. start() rebuilds it from scratch. */
  stop() {
    if (!this._running) return;
    this._running = false;
    const ctx = this.ctx;
    if (!ctx || !this._built) return;
    try {
      const t = ctx.currentTime;
      const g = this._bus.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0, t + 0.7);
      // The permanent sources keep running (silently) until the teardown, so a
      // start() inside the fade window resumes the same graph instead of a
      // half-dead one. _dispose() is what actually stops them.
      const gen = this._gen;
      this._teardown = setTimeout(() => {
        if (gen !== this._gen) return;
        this._dispose();
      }, 1100);
    } catch (e) {
      this._dispose();
    }
  }

  setVolume(v) {
    this._volume = clamp(Number(v) || 0, 0, 1);
    if (!this._built || !this.ctx) return;
    try {
      const t = this.ctx.currentTime;
      const g = this._bus.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(this._running ? this._volume : 0, t + 0.08);
    } catch (e) {
      /* ignore */
    }
  }

  /** 0 = calm, 1 = life-or-death. Smoothed in update(); never a hard jump. */
  setIntensity(v) {
    const n = Number(v);
    this._intTarget = clamp(isFinite(n) ? n : 0, 0, 1);
  }

  setState(name) {
    if (!STATES[name] || name === this._state) return;
    this._state = name;
    this._st = STATES[name];
    this._phrase = 0;
    this._nextSwell = 0;
    this._mixAccum = 1; // re-target the crossfades immediately
    // Resolving states get a cadence rather than just a mix change.
    if (this._built && this._running && (name === 'victory' || name === 'defeat')) {
      try {
        this._cadence(name, this.ctx.currentTime + 0.03);
      } catch (e) {
        /* ignore */
      }
    }
  }

  /** Called every frame. Drives crossfades and the lookahead scheduler. */
  update(dt) {
    if (!this._running || !this._supported) return;
    const d = clamp(Number(dt) || 0.016, 0, 0.25);
    try {
      if (!this._built) {
        if (!this._ensure()) return;
        this._beginTransport();
      }
      const ctx = this.ctx;
      if (!this._offline && ctx.state === 'suspended') {
        this._resume();
        return; // nothing scheduled while the clock is parked
      }
      if (ctx.state === 'closed') return;

      // Smooth the continuous controls — exponential, frame-rate independent.
      this._int += (this._intTarget - this._int) * (1 - Math.exp(-d * 1.7));
      const bpmTarget = this._targetBpm();
      this._bpm += (bpmTarget - this._bpm) * (1 - Math.exp(-d * 0.9));

      this._mixAccum += d;
      if (this._mixAccum >= 0.1) {
        this._applyMix(this._mixAccum);
        this._mixAccum = 0;
      }
      this._schedule();
    } catch (e) {
      /* never let the score break the game loop */
    }
  }

  /** One-shot musical accent. */
  sting(name) {
    if (!this._supported) return;
    try {
      if (!this._ensure()) return;
      const ctx = this.ctx;
      if (!this._offline && ctx.state === 'suspended') {
        this._resume();
        return;
      }
      const t = ctx.currentTime + 0.02;
      switch (name) {
        case 'parry':
          this._stingParry(t);
          break;
        case 'breach':
          this._stingBreach(t);
          break;
        case 'roundwin':
          this._cadence('victory', t);
          break;
        case 'roundloss':
          this._cadence('defeat', t);
          break;
        case 'objective':
          this._stingObjective(t);
          break;
        default:
          break;
      }
    } catch (e) {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------ context

  _resolveCtx() {
    if (this.ctx) return true;
    const e = this._engine;
    if (!e) return false;
    // AudioEngine, {ctx}, {context}, or a bare (Offline)AudioContext.
    const c =
      (e.ctx && e.ctx.createGain && e.ctx) ||
      (e.context && e.context.createGain && e.context) ||
      (e.createGain && e.destination && e);
    if (!c) return false;
    this.ctx = c;
    // OfflineAudioContext parks itself in state 'suspended' at every
    // suspend() point, which is exactly how an offline render drives our
    // scheduler — so the "don't run while suspended" guard is realtime-only.
    this._offline = !!(c.startRendering && typeof c.length === 'number');
    // Prefer the engine's master so the game's volume control still owns us.
    this._dest =
      (e._master && e._master.gain && e._master) ||
      (e.master && e.master.gain && e.master) ||
      c.destination;
    return true;
  }

  _resume() {
    const ctx = this.ctx;
    if (!ctx || this._offline) return;
    if (!ctx.resume || ctx.state === 'running' || ctx.state === 'closed') return;
    try {
      const p = ctx.resume();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {
      /* ignore */
    }
  }

  // ------------------------------------------------------------- graph build

  _ensure() {
    if (this._built) return true;
    if (!this._supported) return false;
    if (!this._resolveCtx()) return false;
    try {
      this._build();
      this._built = true;
      return true;
    } catch (e) {
      this._supported = false;
      this._dispose();
      return false;
    }
  }

  _build() {
    const ctx = this.ctx;
    const add = (n) => (this._nodes.push(n), n);
    const src = (n) => (this._nodes.push(n), this._sources.push(n), n);

    this._noiseWhite = this._makeNoise(ctx, 2.5, 'white');
    this._noiseBrown = this._makeNoise(ctx, 3.0, 'brown');
    this._softCurve = this._makeSoftCurve();

    // --- master chain. The two shelves are the "stay out of the blades" EQ.
    const bus = add(ctx.createGain());
    bus.gain.value = this._running ? this._volume : 0;
    this._bus = bus;

    const lowShelf = add(ctx.createBiquadFilter());
    lowShelf.type = 'lowshelf';
    lowShelf.frequency.value = 140;
    lowShelf.gain.value = 3.5;

    const scoop = add(ctx.createBiquadFilter());
    scoop.type = 'highshelf';
    scoop.frequency.value = 1500;
    scoop.gain.value = -10; // blade clangs live up here — leave them the room

    const tame = add(ctx.createBiquadFilter());
    tame.type = 'lowpass';
    tame.frequency.value = 7000;
    tame.Q.value = 0.5;

    // Safety net, not a leveller: sat high with a gentle ratio so that rising
    // intensity actually reads as rising loudness instead of being squashed.
    const comp = add(ctx.createDynamicsCompressor());
    comp.threshold.value = -8;
    comp.knee.value = 6;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.01;
    comp.release.value = 0.25;

    bus.connect(lowShelf);
    lowShelf.connect(scoop);
    scoop.connect(tame);
    tame.connect(comp);
    comp.connect(this._dest);

    // --- a dark, long stone-hall tail of our own (the SFX verb is too short).
    const conv = add(ctx.createConvolver());
    conv.buffer = this._makeImpulse(ctx, 3.4, 3.1);
    const revLP = add(ctx.createBiquadFilter());
    revLP.type = 'lowpass';
    revLP.frequency.value = 2600;
    const revReturn = add(ctx.createGain());
    revReturn.gain.value = 0.9;
    conv.connect(revLP);
    revLP.connect(revReturn);
    revReturn.connect(bus);
    this._conv = conv;

    // --- one gain per layer; every crossfade is a ramp on one of these.
    for (const name of LAYERS) {
      const g = add(ctx.createGain());
      g.gain.value = 0;
      g.connect(bus);
      const s = add(ctx.createGain());
      s.gain.value = SEND[name];
      g.connect(s);
      s.connect(conv);
      this._layer[name] = g;
    }
    this._layer.fx.gain.value = TRIM.fx; // stings are never faded out

    // ---------------------------------------------------------------- drone
    // Open organum: root, its octaves and the fifth. No third, ever.
    const droneLP = add(ctx.createBiquadFilter());
    droneLP.type = 'lowpass';
    droneLP.frequency.value = 260;
    droneLP.Q.value = 3.0;
    droneLP.connect(this._layer.drone);
    this._droneLP = droneLP;

    const t0 = ctx.currentTime;
    const voiceOf = (type, freq, detune, level, dest) => {
      const o = src(ctx.createOscillator());
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = detune;
      const g = add(ctx.createGain());
      g.gain.value = level;
      o.connect(g);
      g.connect(dest);
      o.start(t0);
      return o;
    };
    voiceOf('sawtooth', ROOT, -4, 0.42, droneLP);
    voiceOf('sawtooth', ROOT * 1.002, 7, 0.30, droneLP);
    voiceOf('triangle', ROOT * 1.5, 3, 0.26, droneLP); // the fifth
    voiceOf('sine', ROOT * 0.5, 0, 0.5, this._layer.drone); // sub weight, unfiltered
    voiceOf('triangle', ROOT * 2, -6, 0.16, droneLP);

    // Slow LFO helper: modulates a param around its own value.
    const lfo = (rate, depth, target) => {
      const o = src(ctx.createOscillator());
      o.type = 'sine';
      o.frequency.value = rate;
      const g = add(ctx.createGain());
      g.gain.value = depth;
      o.connect(g);
      g.connect(target);
      o.start(t0);
      return o;
    };
    lfo(0.035, 55, droneLP.frequency); // the drone breathes

    // ----------------------------------------------------------------- buzz
    // Hurdy-gurdy rasp: saw pair squeezed through a resonant band.
    const buzzBP = add(ctx.createBiquadFilter());
    buzzBP.type = 'bandpass';
    buzzBP.frequency.value = 300;
    buzzBP.Q.value = 5.5;
    const buzzShape = add(ctx.createWaveShaper());
    buzzShape.curve = this._softCurve;
    buzzBP.connect(buzzShape);
    buzzShape.connect(this._layer.buzz);
    this._buzzBP = buzzBP;
    voiceOf('sawtooth', ROOT * 2, 5, 0.5, buzzBP);
    voiceOf('sawtooth', ROOT * 3, -9, 0.34, buzzBP); // fifth above the octave
    lfo(0.11, 26, buzzBP.frequency);

    // ------------------------------------------------------------------ air
    // Room tone: a low brown bed plus a thin, distant band of texture.
    const airSrc = src(ctx.createBufferSource());
    airSrc.buffer = this._noiseBrown;
    airSrc.loop = true;
    airSrc.playbackRate.value = 0.8;
    const airBP = add(ctx.createBiquadFilter());
    airBP.type = 'bandpass';
    airBP.frequency.value = 230;
    airBP.Q.value = 0.6;
    const airG = add(ctx.createGain());
    airG.gain.value = 0.75;
    airSrc.connect(airBP);
    airBP.connect(airG);
    airG.connect(this._layer.air);
    airSrc.start(t0, Math.random() * 1.5);
    lfo(0.047, 110, airBP.frequency);
    lfo(0.029, 0.22, airG.gain);

    const air2 = src(ctx.createBufferSource());
    air2.buffer = this._noiseWhite;
    air2.loop = true;
    air2.playbackRate.value = 0.55;
    const air2BP = add(ctx.createBiquadFilter());
    air2BP.type = 'bandpass';
    air2BP.frequency.value = 820;
    air2BP.Q.value = 1.4;
    const air2G = add(ctx.createGain());
    air2G.gain.value = 0.05;
    air2.connect(air2BP);
    air2BP.connect(air2G);
    air2G.connect(this._layer.air);
    air2.start(t0, Math.random() * 1.5);
    lfo(0.019, 260, air2BP.frequency);
  }

  _beginTransport() {
    const ctx = this.ctx;
    this._bpm = this._targetBpm();
    this._step = 0;
    this._nextStep = ctx.currentTime + 0.08;
    this._nextSwell = ctx.currentTime + rnd(1.5, 4);
    this._mixAccum = 1;
    const g = this._bus.gain;
    const t = ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(this._volume, t + 1.4); // fade in, never a cut
  }

  _dispose() {
    this._gen++;
    if (this._teardown) {
      clearTimeout(this._teardown);
      this._teardown = null;
    }
    for (const s of this._sources) {
      try {
        s.stop();
      } catch (e) {
        /* already stopped */
      }
      s.onended = null;
    }
    for (const n of this._nodes) {
      try {
        n.disconnect();
      } catch (e) {
        /* ignore */
      }
    }
    this._nodes.length = 0;
    this._sources.length = 0;
    this._layer = {};
    this._bus = null;
    this._conv = null;
    this._droneLP = null;
    this._buzzBP = null;
    this._built = false;
  }

  // -------------------------------------------------------------------- mix

  _targetBpm() {
    const base = this._st.bpm;
    // Combat is the only state that really accelerates with the fight.
    if (this._state === 'combat') return 78 + 46 * this._int;
    return base * (0.95 + 0.12 * this._int);
  }

  /**
   * Re-target every layer gain. Called ~10x/sec, always as a ramp, so a state
   * change is a crossfade and never a restart.
   */
  _applyMix(dt) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const I = this._int;
    const L = this._st.layers;
    const ramp = Math.max(0.12, Math.min(0.5, dt * 3));

    const want = {
      drone: L.drone * (0.7 + 0.45 * I),
      buzz: L.buzz * (0.14 + 1.05 * I),
      air: L.air * (1.15 - 0.4 * I), // texture recedes as the fight arrives
      pluck: L.pluck * (1.0 - 0.3 * I),
      perc: L.perc * (0.24 + 0.95 * I),
      ost: L.ost * (0.2 + 1.0 * I),
      pulse: L.pulse * (0.45 + 0.75 * I),
      swell: L.swell * (1.0 - 0.5 * I),
    };

    for (const name in want) {
      const g = this._layer[name];
      if (!g) continue;
      const target = clamp(want[name] * TRIM[name], 0, 2);
      const p = g.gain;
      if (Math.abs(p.value - target) < 0.0008) continue;
      p.cancelScheduledValues(t);
      p.setValueAtTime(p.value, t);
      p.linearRampToValueAtTime(target, t + ramp);
    }

    // Timbre follows intensity too: the drone opens up and the rasp climbs.
    if (this._droneLP) {
      const f = this._droneLP.frequency;
      const target = 190 + 780 * I;
      f.cancelScheduledValues(t);
      f.setValueAtTime(f.value, t);
      f.linearRampToValueAtTime(target, t + ramp);
    }
    if (this._buzzBP) {
      const f = this._buzzBP.frequency;
      const target = 230 + 480 * I; // stays well below the blade band
      f.cancelScheduledValues(t);
      f.setValueAtTime(f.value, t);
      f.linearRampToValueAtTime(target, t + ramp);
    }
  }

  // -------------------------------------------------------------- scheduler

  _schedule() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    let dur = 30 / this._bpm; // one eighth note

    // Recover from a stall (throttled tab, a long frame, or a whole screen
    // that never called update()) without a burst of catch-up notes: jump the
    // grid forward silently, keeping the bar phase. Computed rather than
    // looped, so an arbitrarily long gap costs the same.
    if (this._nextStep < now - 0.05) {
      const skip = Math.ceil((now - this._nextStep) / dur);
      this._nextStep += skip * dur;
      this._step += skip;
    }

    const horizon = now + LOOKAHEAD;
    let guard = 0;
    while (this._nextStep < horizon && guard++ < 32) {
      this._scheduleStep(this._step, this._nextStep, dur);
      this._nextStep += dur;
      this._step++;
      dur = 30 / this._bpm;
    }

    // Slow, aperiodic events (swells) get their own lookahead on the same clock.
    if (this._nextSwell && this._nextSwell < horizon) {
      const amount = this._st.layers.swell;
      if (amount > 0.02) this._swell(Math.max(this._nextSwell, now + 0.02));
      this._nextSwell = Math.max(this._nextSwell, now) + rnd(5, 13);
    }
  }

  /** One eighth-note of music. `t` is an absolute AudioContext time. */
  _scheduleStep(step, t, dur) {
    if (this._activeVoices >= MAX_VOICES) return;
    const s = ((step % STEP) + STEP) % STEP;
    const bar = Math.floor(step / STEP);
    const I = this._int;
    const st = this._state;
    const mode = this._st.mode;

    // ------------------------------------------------------------- heartbeat
    // "lub-dub" under prep; in combat it just reinforces the downbeat.
    if (this._st.layers.pulse > 0.05) {
      if (s === 0) this._sub(t, 0.85, 0.5);
      if (s === 0 && st !== 'combat') this._sub(t + dur * 0.62, 0.5, 0.42);
      if (st === 'combat' && s === 4) this._sub(t, 0.55, 0.42);
    }

    // ------------------------------------------------------------ percussion
    const percOn = this._st.layers.perc > 0.02;
    if (percOn) {
      if (st === 'combat') {
        // Layers stack as intensity rises rather than getting merely louder.
        if (s === 0) this._drum(t, 1.0, 0.15);
        if (s === 4) this._drum(t, 0.82, 0.35);
        if (I > 0.22 && (s === 2 || s === 6)) this._drum(t, 0.45 + 0.25 * I, 0.6);
        if (I > 0.42 && (s === 3 || s === 7)) this._wood(t, 0.35 + 0.35 * I);
        if (I > 0.6 && s % 2 === 1) this._wood(t + dur * 0.5, 0.18 + 0.2 * I);
        if (I > 0.7 && s === 6 && bar % 2 === 1) this._iron(t, 0.3 + 0.3 * I);
        if (I > 0.85 && s === 0 && bar % 4 === 0) this._iron(t, 0.5, 300);
      } else if (st === 'prep') {
        if (s === 0) this._drum(t, 0.55, 0.4);
        if (s === 4) this._wood(t, 0.22);
        if (bar % 4 === 3 && s === 6) this._iron(t, 0.16);
      } else if (st === 'stalk') {
        if (Math.random() < 0.05) this._wood(t, rnd(0.06, 0.16)); // a distant knock
      } else if (st === 'victory') {
        if (s === 0 && bar % 2 === 0) this._drum(t, 0.5, 0.3);
      }
    }

    // -------------------------------------------------------------- ostinato
    // Urgent low figure in bare fifths — the engine room of the combat cue.
    if (this._st.layers.ost > 0.02) {
      const d = OSTINATO[s];
      const gate = I > 0.55 ? 1 : I > 0.3 ? s % 2 === 0 : s === 0 || s === 4;
      if (d !== null && d !== undefined && gate) {
        const semi = degree(mode, d);
        this._reed(t, hz(semi + 12), dur * (s % 2 === 0 ? 1.05 : 0.85), 0.5 + 0.4 * I);
      }
    }

    // ----------------------------------------------------------- plucked motif
    if (this._st.layers.pluck > 0.05) {
      if (st === 'menu' && s === 0 && bar % 2 === 0) {
        const d = MOTIF_MENU[this._phrase % MOTIF_MENU.length];
        this._phrase++;
        // Leave holes: silence is part of the menu cue.
        if (this._phrase % 4 !== 0) {
          this._pluck(t + rnd(0, 0.03), hz(degree(mode, d) + 12), 0.34, 2.6);
          if (Math.random() < 0.3) this._pluck(t + rnd(0.28, 0.5), hz(degree(mode, d + 4)), 0.16, 2.2);
        }
      } else if (st === 'prep' && (s === 0 || s === 5)) {
        const d = MOTIF_PREP[this._phrase % MOTIF_PREP.length];
        this._phrase++;
        this._pluck(t, hz(degree(mode, d) + 12), s === 0 ? 0.3 : 0.18, 1.8);
      } else if (st === 'stalk' && s === 0 && Math.random() < 0.18) {
        this._pluck(t, hz(degree(mode, Math.random() < 0.5 ? 0 : 1) + 12), 0.16, 3.0);
      } else if (st === 'defeat' && s === 0 && bar % 2 === 0) {
        const seq = [1, 0, -3, 0];
        this._pluck(t, hz(degree(mode, seq[this._phrase % 4]) + 12), 0.26, 3.2);
        this._phrase++;
      } else if (st === 'victory' && s === 0) {
        const seq = [0, 4, 7, 4];
        this._pluck(t, hz(degree(mode, seq[this._phrase % 4]) + 12), 0.28, 2.6);
        this._phrase++;
      }
    }
  }

  // ------------------------------------------------------------- voice utils

  _voice(dest) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 1;
    out.connect(dest || this._layer.fx);
    this._activeVoices++;
    const nodes = [out];
    const v = {
      out,
      nodes,
      sources: [],
      dead: false,
      timer: null,
      add(n) {
        nodes.push(n);
        return n;
      },
      src(n) {
        nodes.push(n);
        v.sources.push(n);
        return n;
      },
    };
    return v;
  }

  /** Disconnect everything once the last source has ended. */
  _reap(v, endTime) {
    const dispose = () => {
      if (v.dead) return;
      v.dead = true;
      this._activeVoices--;
      for (const s of v.sources) s.onended = null;
      for (const n of v.nodes) {
        try {
          n.disconnect();
        } catch (e) {
          /* ignore */
        }
      }
      v.nodes.length = 0;
      v.sources.length = 0;
      if (v.timer) {
        clearTimeout(v.timer);
        v.timer = null;
      }
    };

    let pending = v.sources.length;
    if (pending === 0) {
      dispose();
      return;
    }
    const onEnd = () => {
      if (--pending <= 0) dispose();
    };
    for (const s of v.sources) s.onended = onEnd;

    // Backstop: onended never fires in a throttled tab or an offline render.
    const ms = Math.max(0, (endTime - this.ctx.currentTime) * 1000) + 600;
    if (typeof setTimeout === 'function') v.timer = setTimeout(dispose, ms);
  }

  _osc(v, type, freq, t, stop) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    v.src(o);
    o.start(t);
    o.stop(stop);
    return o;
  }

  _noise(v, t, stop, brown, rate) {
    const buf = brown ? this._noiseBrown : this._noiseWhite;
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.value = rate || 1;
    v.src(s);
    s.start(t, Math.random() * (buf.duration - 0.6));
    s.stop(stop);
    return s;
  }

  _gain(v, value) {
    const g = this.ctx.createGain();
    g.gain.value = value === undefined ? 0 : value;
    v.add(g);
    return g;
  }

  _filter(v, type, freq, q, gainDb) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q !== undefined) f.Q.value = q;
    if (gainDb !== undefined) f.gain.value = gainDb;
    v.add(f);
    return f;
  }

  /** Percussive envelope: silence -> peak -> exponential tail. */
  _env(param, t, peak, attack, dur) {
    param.setValueAtTime(EPS, t);
    param.linearRampToValueAtTime(Math.max(peak, EPS * 2), t + attack);
    param.exponentialRampToValueAtTime(EPS, t + Math.max(dur, attack + 0.01));
  }

  // ------------------------------------------------------------ instruments

  /** Skin drum — a struck frame drum. Low, round, a little saturated. */
  _drum(t, level, size, dest) {
    const v = this._voice(dest || this._layer.perc);
    const sz = size === undefined ? 0.4 : size;
    const f0 = (108 - 44 * sz) * rnd(0.96, 1.05);
    const dur = 0.5 - 0.22 * sz;
    const stop = t + dur + 0.12;

    const o = this._osc(v, 'sine', f0 * 1.85, t, stop);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.62, t + 0.075);
    const g = this._gain(v, 0);
    this._env(g.gain, t, level * 0.95, 0.004, dur);
    const shaper = this.ctx.createWaveShaper();
    shaper.curve = this._softCurve;
    v.add(shaper);
    o.connect(g);
    g.connect(shaper);
    shaper.connect(v.out);

    // Skin: a short dull noise slap, closes down fast.
    const n = this._noise(v, t, t + 0.2, true, rnd(0.85, 1.2));
    const lp = this._filter(v, 'lowpass', 620, 0.9);
    lp.frequency.exponentialRampToValueAtTime(190, t + 0.1);
    const ng = this._gain(v, 0);
    this._env(ng.gain, t, level * 0.4, 0.002, 0.1);
    n.connect(lp);
    lp.connect(ng);
    ng.connect(v.out);

    this._reap(v, stop);
  }

  /** Struck wood — claves / a stick on a shield rim. Dry and short. */
  _wood(t, level) {
    const v = this._voice(this._layer.perc);
    const stop = t + 0.14;
    const f = rnd(380, 780);
    const o = this._osc(v, 'triangle', f, t, stop);
    o.frequency.exponentialRampToValueAtTime(f * 0.8, t + 0.04);
    const g = this._gain(v, 0);
    this._env(g.gain, t, level * 0.7, 0.001, 0.055);
    o.connect(g);
    g.connect(v.out);

    const n = this._noise(v, t, t + 0.05, false, 1);
    const bp = this._filter(v, 'bandpass', rnd(900, 1300), 3.2);
    const ng = this._gain(v, 0);
    this._env(ng.gain, t, level * 0.22, 0.0008, 0.012);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(v.out);

    this._reap(v, stop);
  }

  /** Iron — an anvil / chain accent. Inharmonic but lowpassed hard so it
   *  can never crowd the blade clangs the SFX engine owns. */
  _iron(t, level, base, dest) {
    const v = this._voice(dest || this._layer.perc);
    const dur = rnd(0.5, 0.9);
    const stop = t + dur + 0.15;
    const lp = this._filter(v, 'lowpass', 2400, 0.7);
    lp.connect(v.out);
    const b = (base || rnd(330, 520)) * rnd(0.97, 1.04);
    const ratios = [1, 1.71, 2.39, 3.11, 4.07];
    for (let i = 0; i < ratios.length; i++) {
      const f = b * ratios[i] * rnd(0.995, 1.006);
      const d = dur * (1 / (1 + i * 0.5));
      const o = this._osc(v, i < 2 ? 'triangle' : 'sine', f, t, t + d + 0.05);
      o.detune.value = rnd(-10, 10);
      const g = this._gain(v, 0);
      this._env(g.gain, t, level * (0.34 / (1 + i * 0.6)), 0.002, d);
      o.connect(g);
      g.connect(lp);
    }
    this._reap(v, stop);
  }

  /** Sub heartbeat — felt more than heard. */
  _sub(t, level, drop, dest) {
    const v = this._voice(dest || this._layer.pulse);
    const stop = t + 0.42;
    const o = this._osc(v, 'sine', 74, t, stop);
    o.frequency.exponentialRampToValueAtTime(74 * (1 - 0.5 * (drop || 0.4)), t + 0.13);
    const g = this._gain(v, 0);
    this._env(g.gain, t, level * 0.75, 0.012, 0.3);
    o.connect(g);
    g.connect(v.out);
    this._reap(v, stop);
  }

  /**
   * Karplus-Strong gut string: a burst of noise round a damped delay loop.
   * Restricted to the low register — which both sounds right for a lute and
   * keeps the delay above one render quantum so the pitch stays true.
   */
  _pluck(t, freq, level, dur, dest) {
    const ctx = this.ctx;
    // A DelayNode inside a feedback cycle is forced to at least one render
    // quantum of latency, so the loop period is (delayTime + 128/sampleRate).
    // Subtract it or every string comes out flat — badly so up high, where
    // that fixed 2.9ms is a large slice of the period. It also sets the
    // ceiling on how high this string can be tuned at all.
    // (The extra ~4.5 samples is the measured group delay of the two loop
    // biquads; without it the string still lands ~30 cents flat.)
    const quantum = 132.5 / ctx.sampleRate;
    const f = clamp(freq, 70, Math.min(300, 0.95 / quantum));
    const v = this._voice(dest || this._layer.pluck);
    const d = dur || 2.4;
    const stop = t + d + 0.1;

    // Feedback is derived from the note length: the loop runs at f round-trips
    // per second, so fb^(d*f) = -60 dB gives a string that rings for exactly
    // as long as we asked. The excitation is then normalised by (1 - fb) —
    // the comb's resonant gain — so a note's peak tracks `level` whatever the
    // pitch or duration. (Without this a full-scale burst returns ~800x hot.)
    const rt = Math.max(1, d * f); // round trips over the note
    const fbAmt = clamp(Math.pow(10, -3 / rt), 0.85, 0.985);
    const EXCITE = 0.9 * (1 - fbAmt);

    // The source runs the whole note so onended reaps at the right moment;
    // the burst gain only opens for a couple of milliseconds.
    const src = this._noise(v, t, stop, false, 1);
    const burst = this._gain(v, 0);
    burst.gain.setValueAtTime(0, t);
    burst.gain.setValueAtTime(EXCITE, t + 0.0004);
    burst.gain.setValueAtTime(0, t + Math.min(0.014, 2.5 / f));

    const pre = this._filter(v, 'lowpass', 2600, 0.7);
    const delay = ctx.createDelay(0.05);
    v.add(delay);
    delay.delayTime.value = Math.max(0, 1 / f - quantum);
    // NB: for lowpass/highpass the Web Audio Q is in *decibels*, so anything
    // above -3.01 dB puts a resonant peak in the response — inside a feedback
    // loop that means loop gain > 1 and a runaway. Both loop filters are held
    // at Butterworth (flat, |H| <= 1), and a tanh saturator bounds the loop
    // no matter what, so the string can never blow up.
    const BUTTERWORTH = -3.01;
    const damp = this._filter(v, 'lowpass', 1900, BUTTERWORTH); // loses highs
    const dc = this._filter(v, 'highpass', 60, BUTTERWORTH); // no DC creep
    const sat = ctx.createWaveShaper();
    sat.curve = this._softCurve;
    v.add(sat);
    const fb = this._gain(v, fbAmt);

    src.connect(burst);
    burst.connect(pre);
    pre.connect(delay);
    delay.connect(damp);
    damp.connect(dc);
    dc.connect(sat);
    sat.connect(fb);
    fb.connect(delay);

    const out = this._gain(v, 0);
    out.gain.setValueAtTime(EPS, t);
    out.gain.linearRampToValueAtTime(level, t + 0.005);
    out.gain.exponentialRampToValueAtTime(EPS, t + d);
    delay.connect(out);
    out.connect(v.out);

    // A touch of fundamental so it reads as a pitch on small speakers.
    const body = this._osc(v, 'triangle', f, t, t + Math.min(d, 1.2));
    const bg = this._gain(v, 0);
    this._env(bg.gain, t, level * 0.25, 0.008, Math.min(d, 1.1));
    body.connect(bg);
    bg.connect(v.out);

    this._reap(v, stop);
  }

  /** Reedy ostinato note — shawm-ish, doubled at the fifth (organum). */
  _reed(t, freq, dur, level) {
    const v = this._voice(this._layer.ost);
    const d = Math.max(0.08, dur * 0.95);
    const stop = t + d + 0.08;
    const lp = this._filter(v, 'lowpass', 340 + 700 * this._int, 4.5);
    lp.connect(v.out);

    const partials = [
      { f: freq, type: 'sawtooth', lvl: 0.55 },
      { f: freq * 1.5, type: 'square', lvl: 0.22 }, // the bare fifth
      { f: freq * 0.5, type: 'triangle', lvl: 0.3 },
    ];
    for (const p of partials) {
      const o = this._osc(v, p.type, p.f, t, stop);
      o.detune.value = rnd(-8, 8);
      const g = this._gain(v, 0);
      g.gain.setValueAtTime(EPS, t);
      g.gain.linearRampToValueAtTime(level * p.lvl, t + 0.008);
      g.gain.setValueAtTime(level * p.lvl * 0.8, t + d * 0.55);
      g.gain.exponentialRampToValueAtTime(EPS, t + d);
      o.connect(g);
      g.connect(lp);
    }
    this._reap(v, stop);
  }

  /** Stalk's dissonant bowed cluster: root against its flat 2nd, very slow. */
  _swell(t) {
    const v = this._voice(this._layer.swell);
    const rise = rnd(2.0, 4.0);
    const fall = rnd(2.5, 4.5);
    const stop = t + rise + fall + 0.2;
    const lp = this._filter(v, 'lowpass', 700, 1.2);
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.linearRampToValueAtTime(900, t + rise);
    lp.frequency.linearRampToValueAtTime(280, t + rise + fall);
    lp.connect(v.out);

    const mode = this._st.mode;
    const cluster = [degree(mode, 0) + 12, degree(mode, 1) + 12, degree(mode, 4) + 12];
    for (let i = 0; i < cluster.length; i++) {
      const o = this._osc(v, i === 1 ? 'sawtooth' : 'triangle', hz(cluster[i]), t, stop);
      o.detune.value = rnd(-12, 12);
      const g = this._gain(v, 0);
      const peak = (i === 1 ? 0.18 : 0.3) * rnd(0.85, 1.1);
      g.gain.setValueAtTime(EPS, t);
      g.gain.linearRampToValueAtTime(peak, t + rise);
      g.gain.exponentialRampToValueAtTime(EPS, t + rise + fall);
      o.connect(g);
      g.connect(lp);
    }
    this._reap(v, stop);
  }

  // ----------------------------------------------------------------- stings

  /** Parry: a bright-but-low rising fifth. Sits under the blade clang. */
  _stingParry(t) {
    const v = this._voice(this._layer.fx);
    const stop = t + 0.85;
    const base = hz(degree('dorian', 4)); // the fifth
    for (let i = 0; i < 2; i++) {
      const o = this._osc(v, i ? 'triangle' : 'sawtooth', base * (i ? 2 : 1), t, stop);
      o.frequency.setValueAtTime(base * (i ? 2 : 1) * 0.97, t);
      o.frequency.linearRampToValueAtTime(base * (i ? 2 : 1), t + 0.09);
      const g = this._gain(v, 0);
      this._env(g.gain, t, i ? 0.3 : 0.5, 0.006, 0.55);
      const lp = this._filter(v, 'lowpass', 1400, 1.4);
      o.connect(lp);
      lp.connect(g);
      g.connect(v.out);
    }
    this._iron(t + 0.01, 0.45, 420, this._layer.fx);
    this._reap(v, stop);
  }

  /** Breach: a wall coming down — sub drop, big drum, iron. */
  _stingBreach(t) {
    const v = this._voice(this._layer.fx);
    const stop = t + 1.7;
    const o = this._osc(v, 'sine', 96, t, stop);
    o.frequency.exponentialRampToValueAtTime(26, t + 1.1);
    const g = this._gain(v, 0);
    this._env(g.gain, t, 0.8, 0.02, 1.4);
    const shaper = this.ctx.createWaveShaper();
    shaper.curve = this._softCurve;
    v.add(shaper);
    o.connect(g);
    g.connect(shaper);
    shaper.connect(v.out);

    const n = this._noise(v, t, t + 1.0, true, 0.9);
    const lp = this._filter(v, 'lowpass', 900, 0.9);
    lp.frequency.exponentialRampToValueAtTime(150, t + 0.8);
    const ng = this._gain(v, 0);
    this._env(ng.gain, t, 0.45, 0.02, 0.85);
    n.connect(lp);
    lp.connect(ng);
    ng.connect(v.out);

    this._drum(t, 1.0, 0.0, this._layer.fx);
    this._drum(t + 0.16, 0.7, 0.2, this._layer.fx);
    this._iron(t + 0.04, 0.55, 260, this._layer.fx);
    this._reap(v, stop);
  }

  /** Objective: a tolling low bell doubled at the octave. */
  _stingObjective(t) {
    this._iron(t, 0.5, 220, this._layer.fx);
    this._iron(t + 0.42, 0.36, 440, this._layer.fx);
    const v = this._voice(this._layer.fx);
    const stop = t + 2.2;
    const o = this._osc(v, 'triangle', hz(degree('dorian', 4)) * 0.5, t, stop);
    const g = this._gain(v, 0);
    this._env(g.gain, t, 0.28, 0.08, 1.9);
    const lp = this._filter(v, 'lowpass', 900, 0.9);
    o.connect(lp);
    lp.connect(g);
    g.connect(v.out);
    this._reap(v, stop);
  }

  /**
   * Round/match cadence. Not a functional V-I — a modal plagal fall on open
   * fifths, major-ish (Dorian 6th) for a win, Phrygian flat-2nd for a loss,
   * then it hands back to whatever bed the state mix is holding.
   */
  _cadence(kind, t) {
    const win = kind === 'victory';
    const mode = win ? 'dorian' : 'phrygian';
    const v = this._voice(this._layer.fx);
    const dur = win ? 2.6 : 3.4;
    const stop = t + dur + 0.3;

    // Two chords: an approach on the 4th/2nd, then home to root + fifth.
    const chords = win
      ? [
          { at: t, degs: [3, 7], lvl: 0.26, len: 0.9 },
          { at: t + 0.85, degs: [0, 4, 7], lvl: 0.34, len: dur - 0.85 },
        ]
      : [
          { at: t, degs: [1, 5], lvl: 0.24, len: 1.2 },
          { at: t + 1.1, degs: [0, 4], lvl: 0.32, len: dur - 1.1 },
        ];

    const lp = this._filter(v, 'lowpass', win ? 1500 : 800, 1.0);
    lp.connect(v.out);
    for (const c of chords) {
      for (let i = 0; i < c.degs.length; i++) {
        const f = hz(degree(mode, c.degs[i]));
        const o = this._osc(v, i === 0 ? 'sawtooth' : 'triangle', f, c.at, c.at + c.len + 0.1);
        o.detune.value = rnd(-7, 7);
        if (!win) o.frequency.linearRampToValueAtTime(f * 0.985, c.at + c.len); // sag
        const g = this._gain(v, 0);
        g.gain.setValueAtTime(EPS, c.at);
        g.gain.linearRampToValueAtTime(c.lvl / (1 + i * 0.6), c.at + (win ? 0.03 : 0.12));
        g.gain.exponentialRampToValueAtTime(EPS, c.at + c.len);
        o.connect(g);
        g.connect(lp);
      }
    }
    this._reap(v, stop);

    // Plucked answer over the top, and a single drum to punctuate.
    const seq = win ? [7, 9, 11] : [1, 0];
    for (let i = 0; i < seq.length; i++) {
      this._pluck(t + 0.1 + i * (win ? 0.24 : 0.5), hz(degree(mode, seq[i])), 0.26, 2.2, this._layer.fx);
    }
    this._drum(t, win ? 0.7 : 0.5, win ? 0.2 : 0.0, this._layer.fx);
    if (!win) this._sub(t + 0.05, 0.6, 0.6, this._layer.fx);
  }

  // ------------------------------------------------------------ buffer makers

  _makeNoise(ctx, seconds, kind) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    if (kind === 'brown') {
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.2;
      }
    } else {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return buf;
  }

  /** Long, dark stone-hall impulse. Sparse early reflections + tilted tail. */
  _makeImpulse(ctx, seconds, decay) {
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * seconds));
    const ir = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const env = Math.pow(1 - t, decay);
        const n = (Math.random() * 2 - 1) * env;
        lp += (n - lp) * 0.22; // darker tilt than the SFX verb — this is music
        d[i] = lp * 1.6;
      }
      for (let r = 0; r < 9; r++) {
        const idx = Math.floor(rnd(0.012, 0.13) * sr) + ch * 53;
        if (idx < len) d[idx] += rnd(-0.5, 0.5);
      }
    }
    return ir;
  }

  _makeSoftCurve() {
    const n = 1024;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * 1.8) / Math.tanh(1.8);
    }
    return c;
  }
}

export default Score;
