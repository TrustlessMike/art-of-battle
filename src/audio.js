/**
 * Procedural sound engine for art-of-battle.
 *
 * Everything is synthesized at runtime with the Web Audio API — no files,
 * no fetch, no base64. The AudioContext is created lazily in unlock() so we
 * never trip the browser autoplay policy at import time. If the context can't
 * be created, every public method quietly no-ops.
 *
 * Signal graph:
 *   voice -> [pan] -> sfxBus ----\
 *   voice -> reverbSend -> conv --+-> master -> limiter -> destination
 *   ambience layers -> ambGain -> ambDuck ----/
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rnd = (a, b) => a + Math.random() * (b - a);
const EPS = 0.0001; // exponentialRamp can never reach zero

// Hard ceiling on simultaneous voices so a chaotic match can't melt the graph.
const MAX_VOICES = 64;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this._supported = true; // flips false if construction ever fails
    this._masterVolume = 0.9;
    this._activeVoices = 0;

    this._master = null;
    this._sfxBus = null;
    this._convolver = null;
    this._ambGain = null;
    this._ambDuck = null;
    this._fireBus = null;

    this._noiseWhite = null;
    this._noiseBrown = null;
    this._softCurve = null;

    this._amb = null; // { nodes, sources, timer, nextCrackle }
  }

  // ---------------------------------------------------------------- lifecycle

  /** Create/resume the AudioContext. Safe to call on every user gesture. */
  unlock() {
    if (!this._supported) return;
    if (this.ctx) {
      this._resume();
      return;
    }
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) {
        this._supported = false;
        return;
      }
      const ctx = new AC({ latencyHint: 'interactive' });

      const master = ctx.createGain();
      master.gain.value = this._masterVolume;

      // Gentle bus limiter: keeps dogpiles of hits from clipping.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -8;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.18;
      master.connect(limiter);
      limiter.connect(ctx.destination);

      const sfxBus = ctx.createGain();
      sfxBus.connect(master);

      const ambDuck = ctx.createGain();
      ambDuck.connect(master);
      const ambGain = ctx.createGain();
      ambGain.gain.value = 0;
      ambGain.connect(ambDuck);

      const convolver = ctx.createConvolver();
      convolver.buffer = this._makeImpulse(ctx, 1.8, 2.7);
      const revReturn = ctx.createGain();
      revReturn.gain.value = 0.85;
      convolver.connect(revReturn);
      revReturn.connect(master);

      this.ctx = ctx;
      this._master = master;
      this._sfxBus = sfxBus;
      this._ambGain = ambGain;
      this._ambDuck = ambDuck;
      this._convolver = convolver;

      this._noiseWhite = this._makeNoise(ctx, 2.0, 'white');
      this._noiseBrown = this._makeNoise(ctx, 3.0, 'brown');
      this._softCurve = this._makeSoftCurve();

      this._resume();
    } catch (e) {
      this._supported = false;
      this.ctx = null;
    }
  }

  /** resume() can reject *or* throw depending on context type — swallow both. */
  _resume() {
    if (!this.ctx || this.ctx.state === 'running' || this.ctx.state === 'closed') return;
    try {
      const p = this.ctx.resume();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {
      /* ignore */
    }
  }

  setMasterVolume(v) {
    this._masterVolume = clamp(Number(v) || 0, 0, 1);
    if (!this.ctx || !this._master) return;
    try {
      const now = this.ctx.currentTime;
      const g = this._master.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(this._masterVolume, now + 0.03);
    } catch (e) {
      /* ignore */
    }
  }

  // ------------------------------------------------------------ buffer makers

  /** Shared noise beds — read from a random offset so grains never repeat. */
  _makeNoise(ctx, seconds, kind) {
    const len = Math.floor(ctx.sampleRate * seconds);
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

  /** Stone-courtyard impulse: sparse early reflections + darkened noise tail. */
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
        lp += (n - lp) * 0.42; // one-pole tilt, keeps the tail from hissing
        d[i] = lp;
      }
      // A handful of discrete early reflections for a sense of walls.
      for (let r = 0; r < 7; r++) {
        const idx = Math.floor(rnd(0.008, 0.09) * sr) + ch * 37;
        if (idx < len) d[idx] += rnd(-0.7, 0.7);
      }
    }
    return ir;
  }

  /** Soft saturation curve — adds grit/weight to low thuds. */
  _makeSoftCurve() {
    const n = 1024;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * 2.2) / Math.tanh(2.2);
    }
    return c;
  }

  // --------------------------------------------------------------- voice util

  _voice(opts) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = clamp(opts.volume === undefined ? 1 : opts.volume, 0, 4);

    const nodes = [g];
    const pan = clamp(opts.pan || 0, -1, 1);
    if (pan !== 0 && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      p.connect(this._sfxBus);
      nodes.push(p);
    } else {
      g.connect(this._sfxBus);
    }

    this._activeVoices++;
    const v = {
      out: g,
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

  /** Wet send for a voice (0..1). */
  _send(v, amount) {
    if (!amount) return;
    const s = this.ctx.createGain();
    s.gain.value = amount;
    v.out.connect(s);
    s.connect(this._convolver);
    v.add(s);
  }

  /** Disconnect everything once the last source has ended. */
  _reap(v, endTime) {
    const dispose = () => {
      if (v.dead) return;
      v.dead = true;
      this._activeVoices--;
      for (const n of v.nodes) {
        try {
          n.disconnect();
        } catch (e) {
          /* ignore */
        }
      }
      for (const s of v.sources) s.onended = null;
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

    // Belt-and-braces: if onended never fires (throttled tab), sweep anyway.
    const ms = Math.max(0, (endTime - this.ctx.currentTime) * 1000) + 500;
    v.timer = setTimeout(dispose, ms);
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
    s.start(t, Math.random() * (buf.duration - 0.5));
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

  /**
   * Struck-steel body: a few INHARMONIC partials with staggered decays so it
   * rings like metal rather than beeping like a sine.
   */
  _metal(v, dest, t, base, ratios, dur, level, riseAmount) {
    for (let i = 0; i < ratios.length; i++) {
      const f = base * ratios[i] * rnd(0.995, 1.005);
      const d = dur * (1 / (1 + i * 0.42)); // highs die first
      const lvl = level * (1 / (1 + i * 0.55));
      const o = this.ctx.createOscillator();
      o.type = i < 2 ? 'triangle' : 'sine';
      o.frequency.setValueAtTime(f, t);
      if (riseAmount) {
        // slight upward bend — reads as "sharp, rewarding" on a parry
        o.frequency.setValueAtTime(f * (1 - riseAmount), t);
        o.frequency.linearRampToValueAtTime(f, t + Math.min(0.16, d * 0.5));
      }
      o.detune.value = rnd(-9, 9);
      const g = this._gain(v, 0);
      this._env(g.gain, t, lvl, 0.002, d);
      o.connect(g);
      g.connect(dest);
      v.src(o);
      o.start(t);
      o.stop(t + d + 0.05);
    }
    return dur;
  }

  // -------------------------------------------------------------------- play

  play(name, opts) {
    if (!this.ctx || !this._supported) return;
    if (this._activeVoices >= MAX_VOICES) return;
    const o = opts || {};
    let v = null;
    let t = 0;
    try {
      this._resume();
      const rate = clamp(o.rate || 1, 0.25, 4);
      t = this.ctx.currentTime + 0.001;
      v = this._voice(o);
      let end;
      switch (name) {
        case 'swing_light':
          end = this._swing(v, t, rate, false);
          break;
        case 'swing_heavy':
          end = this._swing(v, t, rate, true);
          break;
        case 'hit_flesh':
          end = this._hitFlesh(v, t, rate);
          break;
        case 'hit_block':
          end = this._hitBlock(v, t, rate);
          break;
        case 'parry':
          end = this._parry(v, t, rate);
          break;
        case 'guardbreak':
          end = this._guardbreak(v, t, rate);
          break;
        case 'dodge':
          end = this._dodge(v, t, rate);
          break;
        case 'footstep':
          end = this._footstep(v, t, rate);
          break;
        case 'stamina_empty':
          end = this._staminaEmpty(v, t, rate);
          break;
        case 'death':
          end = this._death(v, t, rate);
          break;
        case 'ui_stance':
          end = this._uiStance(v, t, rate);
          break;
        case 'victory':
          end = this._victory(v, t, rate);
          break;
        case 'defeat':
          end = this._defeat(v, t, rate);
          break;
        default:
          this._reap(v, t);
          return;
      }
      this._reap(v, end);
    } catch (e) {
      // Never let audio break the game loop — but still release the voice.
      if (v && !v.dead) {
        try {
          this._reap(v, t);
        } catch (e2) {
          /* ignore */
        }
      }
    }
  }

  // ------------------------------------------------------------------ voices

  /** Whoosh: bandpassed noise whose centre sweeps up past you, then away. */
  _swing(v, t, rate, heavy) {
    const dur = (heavy ? 0.35 : 0.18) / rate;
    const jit = rnd(0.94, 1.07);
    const lo = (heavy ? 190 : 620) * rate * jit;
    const peak = (heavy ? 950 : 2700) * rate * jit;
    const tail = (heavy ? 260 : 900) * rate * jit;

    const stop = t + dur + 0.05;
    const src = this._noise(v, t, stop, heavy, rnd(0.9, 1.15));

    const bp = this._filter(v, 'bandpass', lo, heavy ? 0.9 : 1.5);
    bp.frequency.setValueAtTime(lo, t);
    bp.frequency.exponentialRampToValueAtTime(peak, t + dur * 0.45);
    bp.frequency.exponentialRampToValueAtTime(tail, t + dur);

    const hp = this._filter(v, 'highpass', heavy ? 90 : 320);
    const g = this._gain(v, 0);
    // Fast in, hold through the arc, fall away.
    g.gain.setValueAtTime(EPS, t);
    g.gain.linearRampToValueAtTime(heavy ? 0.85 : 0.6, t + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(EPS, t + dur);

    src.connect(bp);
    bp.connect(hp);
    hp.connect(g);
    g.connect(v.out);

    if (heavy) {
      // Sub-layer for mass — you feel the blade before you hear it.
      const sub = this._osc(v, 'sine', 120 * rate, t, t + dur + 0.05);
      sub.frequency.exponentialRampToValueAtTime(58 * rate, t + dur);
      const sg = this._gain(v, 0);
      this._env(sg.gain, t, 0.28, 0.04, dur);
      sub.connect(sg);
      sg.connect(v.out);
    }

    this._send(v, heavy ? 0.1 : 0.05);
    return stop;
  }

  /** Meaty impact: saturated low thud + a wet mid slap + short noise burst. */
  _hitFlesh(v, t, rate) {
    const j = rnd(0.9, 1.12);
    const stop = t + 0.4 / rate;

    const thump = this._osc(v, 'sine', 155 * rate * j, t, stop);
    thump.frequency.exponentialRampToValueAtTime(42 * rate * j, t + 0.13 / rate);
    const tg = this._gain(v, 0);
    this._env(tg.gain, t, 0.95, 0.004, 0.24 / rate);
    const shaper = this.ctx.createWaveShaper();
    shaper.curve = this._softCurve;
    v.add(shaper);
    thump.connect(tg);
    tg.connect(shaper);
    shaper.connect(v.out);

    // Body noise: dull, closes down fast.
    const n = this._noise(v, t, stop, true, rnd(0.85, 1.2));
    const lp = this._filter(v, 'lowpass', 1500 * rate, 0.9);
    lp.frequency.exponentialRampToValueAtTime(380 * rate, t + 0.12 / rate);
    const ng = this._gain(v, 0);
    this._env(ng.gain, t, 0.5, 0.003, 0.1 / rate);
    n.connect(lp);
    lp.connect(ng);
    ng.connect(v.out);

    // Mid "slap" transient so it cuts through the mix.
    const n2 = this._noise(v, t, t + 0.1 / rate, false, 1);
    const bp = this._filter(v, 'bandpass', rnd(780, 1050) * rate, 2.2);
    const g2 = this._gain(v, 0);
    this._env(g2.gain, t, 0.3, 0.002, 0.055 / rate);
    n2.connect(bp);
    bp.connect(g2);
    g2.connect(v.out);

    this._send(v, 0.12);
    return stop;
  }

  /** Steel-on-steel: bright chiff transient, inharmonic ring, wooden body. */
  _hitBlock(v, t, rate) {
    const base = 1180 * rate * rnd(0.9, 1.12);
    const dur = 0.75 / rate;
    const stop = t + dur + 0.15;

    const n = this._noise(v, t, t + 0.06, false, 1);
    const hp = this._filter(v, 'highpass', 3000, 0.7);
    const ng = this._gain(v, 0);
    this._env(ng.gain, t, 0.55, 0.001, 0.022);
    n.connect(hp);
    hp.connect(ng);
    ng.connect(v.out);

    this._metal(
      v,
      v.out,
      t,
      base,
      [1, 1.68, 2.35, 3.02, 4.11, 5.43, 6.9],
      dur,
      0.26,
      0
    );

    // Low clunk = the shield/guard absorbing the blow.
    const body = this._osc(v, 'triangle', 205 * rate * rnd(0.95, 1.06), t, t + 0.25);
    const bg = this._gain(v, 0);
    this._env(bg.gain, t, 0.4, 0.003, 0.14 / rate);
    body.connect(bg);
    bg.connect(v.out);

    this._send(v, 0.26);
    return stop;
  }

  /** Parry: higher, sharper, longer ring-out, with a rising bend. Rewarding. */
  _parry(v, t, rate) {
    const base = 1950 * rate * rnd(0.94, 1.08);
    const dur = 1.05 / rate;
    const stop = t + dur + 0.2;

    // Upward chiff — the "shing".
    const n = this._noise(v, t, t + 0.12, false, 1);
    const bp = this._filter(v, 'bandpass', 2000, 3);
    bp.frequency.exponentialRampToValueAtTime(6800, t + 0.07);
    const ng = this._gain(v, 0);
    this._env(ng.gain, t, 0.5, 0.001, 0.065);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(v.out);

    this._metal(
      v,
      v.out,
      t,
      base,
      [1, 1.41, 2.13, 2.79, 3.61, 4.72, 6.11, 7.4],
      dur,
      0.22,
      0.035
    );

    // Bright singing overtone that lingers after the body decays.
    const ping = this._osc(v, 'sine', base * 2.02, t, stop);
    ping.frequency.linearRampToValueAtTime(base * 2.14, t + 0.2);
    const pg = this._gain(v, 0);
    this._env(pg.gain, t, 0.16, 0.008, dur * 0.85);
    ping.connect(pg);
    pg.connect(v.out);

    this._send(v, 0.42);
    return stop;
  }

  /** Winded grunt through vowel formants + leather/armour shuffle. */
  _guardbreak(v, t, rate) {
    const dur = 0.42 / rate;
    const stop = t + dur + 0.1;
    const f0 = 118 * rate * rnd(0.88, 1.14);

    const grunt = this._osc(v, 'sawtooth', f0, t, stop);
    grunt.frequency.exponentialRampToValueAtTime(f0 * 0.76, t + dur * 0.8);
    const lp = this._filter(v, 'lowpass', 1100, 0.8);
    const fm1 = this._filter(v, 'peaking', 520 * rnd(0.9, 1.1), 4, 13);
    const fm2 = this._filter(v, 'peaking', 1150 * rnd(0.9, 1.1), 6, 9);
    const gg = this._gain(v, 0);
    gg.gain.setValueAtTime(EPS, t);
    gg.gain.linearRampToValueAtTime(0.5, t + 0.025);
    gg.gain.linearRampToValueAtTime(0.34, t + dur * 0.5);
    gg.gain.exponentialRampToValueAtTime(EPS, t + dur);
    grunt.connect(lp);
    lp.connect(fm1);
    fm1.connect(fm2);
    fm2.connect(gg);
    gg.connect(v.out);

    // Armour shuffle: two noise swells with a leathery low band.
    const n = this._noise(v, t, stop, false, rnd(0.8, 1.1));
    const bp = this._filter(v, 'bandpass', 1750 * rnd(0.85, 1.2), 0.8);
    const ng = this._gain(v, 0);
    ng.gain.setValueAtTime(EPS, t);
    ng.gain.linearRampToValueAtTime(0.14, t + 0.04);
    ng.gain.linearRampToValueAtTime(0.05, t + 0.12);
    ng.gain.linearRampToValueAtTime(0.11, t + 0.2);
    ng.gain.exponentialRampToValueAtTime(EPS, t + dur);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(v.out);

    const creak = this._noise(v, t, stop, true, 0.7);
    const cbp = this._filter(v, 'bandpass', 420, 1.4);
    const cg = this._gain(v, 0);
    this._env(cg.gain, t + 0.02, 0.16, 0.05, dur * 0.7);
    creak.connect(cbp);
    cbp.connect(cg);
    cg.connect(v.out);

    this._send(v, 0.12);
    return stop;
  }

  /** Cloth/mail rustle: two quick bandpassed grains sweeping downward. */
  _dodge(v, t, rate) {
    const dur = 0.22 / rate;
    const stop = t + dur + 0.05;

    for (let i = 0; i < 2; i++) {
      const at = t + (i === 0 ? 0 : rnd(0.05, 0.085));
      const n = this._noise(v, at, stop, false, rnd(0.9, 1.25));
      const bp = this._filter(v, 'bandpass', rnd(2600, 3400), 1.2);
      bp.frequency.exponentialRampToValueAtTime(rnd(1000, 1500), at + 0.1 / rate);
      const hp = this._filter(v, 'highpass', 800);
      const g = this._gain(v, 0);
      this._env(g.gain, at, i === 0 ? 0.4 : 0.22, 0.012, 0.1 / rate);
      n.connect(bp);
      bp.connect(hp);
      hp.connect(g);
      g.connect(v.out);
    }

    this._send(v, 0.07);
    return stop;
  }

  /** Gravel crunch — 2-3 randomized grains so repeats never sound identical. */
  _footstep(v, t, rate) {
    const grains = 2 + ((Math.random() * 2) | 0);
    let last = t;
    for (let i = 0; i < grains; i++) {
      const at = t + (i === 0 ? 0 : rnd(0.008, 0.04) * i);
      const d = rnd(0.03, 0.075) / rate;
      const n = this._noise(v, at, at + d + 0.04, false, rnd(0.7, 1.4));
      const bp = this._filter(v, 'bandpass', rnd(620, 1750) * rate, rnd(0.7, 2.2));
      const g = this._gain(v, 0);
      this._env(g.gain, at, rnd(0.16, 0.4), 0.002, d);
      n.connect(bp);
      bp.connect(g);
      g.connect(v.out);
      last = Math.max(last, at + d + 0.04);
    }

    // Soft weight under the crunch.
    const th = this._osc(v, 'sine', rnd(88, 108) * rate, t, t + 0.14);
    th.frequency.exponentialRampToValueAtTime(58 * rate, t + 0.06);
    const tg = this._gain(v, 0);
    this._env(tg.gain, t, 0.24, 0.004, 0.09 / rate);
    th.connect(tg);
    tg.connect(v.out);

    this._send(v, 0.05);
    return Math.max(last, t + 0.15);
  }

  /** Despairing sub-drop for an empty stamina bar. */
  _staminaEmpty(v, t, rate) {
    const dur = 0.85 / rate;
    const stop = t + dur + 0.15;
    const f0 = 190 * rate;

    for (let i = 0; i < 2; i++) {
      const o = this._osc(v, i ? 'triangle' : 'sine', f0 * (i ? 0.994 : 1), t, stop);
      o.frequency.exponentialRampToValueAtTime(34 * rate * (i ? 1.01 : 1), t + dur);
      o.detune.value = i ? rnd(-14, -4) : rnd(-3, 3);
      const g = this._gain(v, 0);
      g.gain.setValueAtTime(EPS, t);
      g.gain.linearRampToValueAtTime(i ? 0.22 : 0.55, t + 0.03);
      g.gain.exponentialRampToValueAtTime(EPS, t + dur);
      const lp = this._filter(v, 'lowpass', 800, 1.1);
      lp.frequency.exponentialRampToValueAtTime(180, t + dur);
      o.connect(lp);
      lp.connect(g);
      g.connect(v.out);
    }

    // Exhausted breath under it.
    const n = this._noise(v, t, stop, true, 0.8);
    const nlp = this._filter(v, 'lowpass', 520, 0.7);
    const ng = this._gain(v, 0);
    this._env(ng.gain, t, 0.14, 0.06, dur * 0.7);
    n.connect(nlp);
    nlp.connect(ng);
    ng.connect(v.out);

    this._send(v, 0.18);
    return stop;
  }

  /** Body-and-armour collapse: huge thud, dull impact noise, metal clatter. */
  _death(v, t, rate) {
    const stop = t + 1.5 / rate;

    const thud = this._osc(v, 'sine', 105 * rate, t, t + 0.8);
    thud.frequency.exponentialRampToValueAtTime(27 * rate, t + 0.25 / rate);
    const tg = this._gain(v, 0);
    this._env(tg.gain, t, 1.0, 0.006, 0.65 / rate);
    const shaper = this.ctx.createWaveShaper();
    shaper.curve = this._softCurve;
    v.add(shaper);
    thud.connect(tg);
    tg.connect(shaper);
    shaper.connect(v.out);

    const n = this._noise(v, t, t + 0.6, true, rnd(0.8, 1.05));
    const lp = this._filter(v, 'lowpass', 1000, 0.8);
    lp.frequency.exponentialRampToValueAtTime(180, t + 0.35 / rate);
    const ng = this._gain(v, 0);
    this._env(ng.gain, t, 0.55, 0.008, 0.4 / rate);
    n.connect(lp);
    lp.connect(ng);
    ng.connect(v.out);

    // Plates and buckles settling — scattered small metallic hits.
    const pieces = 5 + ((Math.random() * 3) | 0);
    for (let i = 0; i < pieces; i++) {
      const at = t + rnd(0.03, 0.6);
      const d = rnd(0.12, 0.36);
      this._metal(v, v.out, at, rnd(900, 2600), [1, 1.73, 2.61], d, rnd(0.05, 0.13), 0);
    }

    this._send(v, 0.35);
    return stop;
  }

  /** Tiny UI tick for guard-direction changes. */
  _uiStance(v, t, rate) {
    const stop = t + 0.12;
    this._metal(v, v.out, t, 2600 * rate * rnd(0.97, 1.03), [1, 2.14, 3.31], 0.055, 0.1, 0);
    const n = this._noise(v, t, t + 0.03, false, 1);
    const hp = this._filter(v, 'highpass', 2600, 0.7);
    const g = this._gain(v, 0);
    this._env(g.gain, t, 0.12, 0.0008, 0.009);
    n.connect(hp);
    hp.connect(g);
    g.connect(v.out);
    this._send(v, 0.06);
    return stop;
  }

  /** Triumphant metallic sting: three ascending struck-steel hits + a swell. */
  _victory(v, t, rate) {
    const root = 660 * rate;
    const steps = [1, 1.5, 2];
    for (let i = 0; i < steps.length; i++) {
      const at = t + i * 0.11;
      this._metal(
        v,
        v.out,
        at,
        root * steps[i],
        [1, 2.01, 2.99, 4.21, 5.44],
        i === 2 ? 1.5 : 0.85,
        0.2 + i * 0.03,
        0.01
      );
    }

    const swell = this._osc(v, 'triangle', root * 0.5, t, t + 1.6);
    const sg = this._gain(v, 0);
    this._env(sg.gain, t, 0.22, 0.06, 1.3);
    const lp = this._filter(v, 'lowpass', 1600, 0.8);
    swell.connect(lp);
    lp.connect(sg);
    sg.connect(v.out);

    this._send(v, 0.5);
    return t + 1.9;
  }

  /** Mournful low sting: sagging detuned drone under a dull tolling bell. */
  _defeat(v, t, rate) {
    const dur = 1.5 / rate;
    const stop = t + dur + 0.3;
    const f0 = 165 * rate;

    for (let i = 0; i < 2; i++) {
      const o = this._osc(v, i ? 'triangle' : 'sine', f0 * (i ? 0.5 : 1), t, stop);
      o.frequency.linearRampToValueAtTime(f0 * (i ? 0.5 : 1) * 0.84, t + dur);
      o.detune.value = i ? -12 : 6;
      const g = this._gain(v, 0);
      this._env(g.gain, t, i ? 0.34 : 0.4, 0.09, dur);
      const lp = this._filter(v, 'lowpass', 620, 0.9);
      o.connect(lp);
      lp.connect(g);
      g.connect(v.out);
    }

    // Dull, damped bell — mostly reverb tail.
    this._metal(v, v.out, t, 220 * rate, [1, 1.19, 1.56, 2.03], dur, 0.1, 0);

    this._send(v, 0.5);
    return stop;
  }

  // ---------------------------------------------------------------- ambience

  /** Low wind bed + fire rumble with scheduled crackles. */
  startAmbience() {
    if (!this.ctx || !this._supported || this._amb) return;
    try {
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const nodes = [];
      const sources = [];
      const add = (n) => (nodes.push(n), n);
      const src = (n) => (nodes.push(n), sources.push(n), n);

      const noise = (brown, rate) => {
        const buf = brown ? this._noiseBrown : this._noiseWhite;
        const s = ctx.createBufferSource();
        s.buffer = buf;
        s.loop = true;
        s.playbackRate.value = rate;
        src(s);
        s.start(t, Math.random() * (buf.duration - 0.5));
        return s;
      };
      // Slow LFO helper: modulates a target AudioParam around its own value.
      const lfo = (hz, depth, target) => {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = hz;
        const g = ctx.createGain();
        g.gain.value = depth;
        o.connect(g);
        g.connect(target);
        src(o);
        add(g);
        o.start(t);
        return o;
      };

      // --- Wind: brown noise through a slowly breathing lowpass.
      const w = noise(true, 0.85);
      const wlp = add(ctx.createBiquadFilter());
      wlp.type = 'lowpass';
      wlp.frequency.value = 400;
      wlp.Q.value = 0.7;
      const whp = add(ctx.createBiquadFilter());
      whp.type = 'highpass';
      whp.frequency.value = 70;
      const wg = add(ctx.createGain());
      wg.gain.value = 0.17;
      w.connect(wlp);
      wlp.connect(whp);
      whp.connect(wg);
      wg.connect(this._ambGain);
      lfo(0.07, 220, wlp.frequency);
      lfo(0.043, 0.08, wg.gain);

      // --- Gusts: a thinner whistling band that swells in and out.
      const w2 = noise(false, 0.6);
      const wbp = add(ctx.createBiquadFilter());
      wbp.type = 'bandpass';
      wbp.frequency.value = 760;
      wbp.Q.value = 1.6;
      const wg2 = add(ctx.createGain());
      wg2.gain.value = 0.03;
      w2.connect(wbp);
      wbp.connect(wg2);
      wg2.connect(this._ambGain);
      lfo(0.021, 480, wbp.frequency);
      lfo(0.031, 0.028, wg2.gain);

      // --- Fire: steady low roar; crackles are scheduled separately.
      const fireBus = add(ctx.createGain());
      fireBus.gain.value = 1;
      fireBus.connect(this._ambGain);
      this._fireBus = fireBus;

      const f = noise(true, 1.4);
      const flp = add(ctx.createBiquadFilter());
      flp.type = 'lowpass';
      flp.frequency.value = 300;
      const fg = add(ctx.createGain());
      fg.gain.value = 0.11;
      f.connect(flp);
      flp.connect(fg);
      fg.connect(fireBus);
      lfo(0.9, 0.035, fg.gain); // flicker
      lfo(0.17, 90, flp.frequency);

      this._ambGain.gain.cancelScheduledValues(t);
      this._ambGain.gain.setValueAtTime(this._ambGain.gain.value, t);
      this._ambGain.gain.linearRampToValueAtTime(1, t + 1.2);
      this._ambDuck.gain.cancelScheduledValues(t);
      this._ambDuck.gain.setValueAtTime(1, t);

      this._amb = { nodes, sources, timer: null, next: t + 0.2 };
      this._scheduleCrackles();
    } catch (e) {
      this._amb = null;
    }
  }

  /** Lookahead scheduler for fire pops. */
  _scheduleCrackles() {
    const amb = this._amb;
    if (!amb || !this.ctx) return;
    const horizon = this.ctx.currentTime + 0.6;
    while (amb.next < horizon) {
      this._crackle(Math.max(amb.next, this.ctx.currentTime + 0.01));
      amb.next += rnd(0.04, 0.42);
    }
    amb.timer = setTimeout(() => this._scheduleCrackles(), 250);
  }

  /** One tiny resinous pop. Self-cleaning like any other voice. */
  _crackle(t) {
    if (!this._fireBus) return;
    const ctx = this.ctx;
    const dur = rnd(0.008, 0.03);
    const nodes = [];
    const s = ctx.createBufferSource();
    s.buffer = this._noiseWhite;
    s.loop = true;
    s.playbackRate.value = rnd(0.8, 1.6);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = rnd(900, 3600);
    bp.Q.value = rnd(1.5, 6);
    const g = ctx.createGain();
    g.gain.value = 0;
    this._env(g.gain, t, rnd(0.05, 0.3), 0.001, dur);
    s.connect(bp);
    bp.connect(g);
    g.connect(this._fireBus);
    nodes.push(s, bp, g);
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur + 0.02);
    let dead = false;
    const dispose = () => {
      if (dead) return;
      dead = true;
      clearTimeout(timer);
      s.onended = null;
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch (e) {
          /* ignore */
        }
      }
    };
    const timer = setTimeout(dispose, (t - ctx.currentTime + dur) * 1000 + 500);
    s.onended = dispose;
  }

  stopAmbience() {
    if (!this.ctx || !this._amb) return;
    const amb = this._amb;
    this._amb = null;
    if (amb.timer) clearTimeout(amb.timer);
    try {
      const t = this.ctx.currentTime;
      const g = this._ambGain.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0, t + 0.5);
      for (const s of amb.sources) {
        try {
          s.stop(t + 0.55);
        } catch (e) {
          /* ignore */
        }
      }
      setTimeout(() => {
        for (const n of amb.nodes) {
          try {
            n.disconnect();
          } catch (e) {
            /* ignore */
          }
        }
        amb.nodes.length = 0;
        amb.sources.length = 0;
        this._fireBus = null;
      }, 900);
    } catch (e) {
      /* ignore */
    }
  }

  /** Brief dip of the ambience bed under a dramatic hit. */
  duckMusic(amount, seconds) {
    if (!this.ctx || !this._ambDuck) return;
    try {
      const dip = clamp(amount === undefined ? 0.6 : amount, 0, 1);
      const back = Math.max(0.05, seconds === undefined ? 0.6 : seconds);
      const t = this.ctx.currentTime;
      const g = this._ambDuck.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(1 - dip, t + 0.03);
      g.linearRampToValueAtTime(1, t + 0.03 + back);
    } catch (e) {
      /* ignore */
    }
  }
}

export default AudioEngine;
