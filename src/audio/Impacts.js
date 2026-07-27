/**
 * Bullet impacts, one topology per surface.
 *
 * The design rule: an impact must tell you what you hit before you look. So
 * each surface uses a structurally different synth rather than a filtered
 * version of the same puff:
 *
 *   concrete  transient + dusty noise puff + a scatter of debris grains
 *   rock      harder, brighter crack + more, longer-lived grains
 *   metal     inharmonic resonator bank with long Q (the ring) + spark ticks
 *   glass     a shower of short high sines at random inharmonic pitches
 *   wood      mid modal knock + splinter grains
 *   flesh     lowpassed wet slap + sub thud, no HF at all
 *   sand      soft broadband puff with a slow attack, almost no transient
 *   grass     brief rustle
 *   water     lowpass sweep splash + rising bubbles
 *
 * Hard surfaces also get an occasional ricochet: a descending bandpassed
 * whine, which is the single most recognisable "bullet hit stone" cue there is.
 */
import {
  clamp, rnd, nGain, nFilter, nNoise, nOsc, nShaper, chain, env, sweep, fire, mark,
  clickLayer, resonatorBank, toneLayer,
} from './Synth.js';

const IMPACTS = {
  concrete: {
    strike: 0.86, strikeHp: 520, strikeLp: 9000, level: 0.72, transient: { freq: 4200, amp: 0.75, decay: 0.008 },
    puff: { f0: 2400, f1: 620, q: 0.75, amp: 0.62, decay: 0.085, kind: 'white' },
    thud: { f: 130, to: 52, amp: 0.42, decay: 0.075 },
    debris: { n: [4, 9], f: [1800, 6400], amp: 0.16, spread: 0.20, decay: [0.004, 0.016] },
    ric: 0.30,
  },
  rock: {
    strike: 0.97, strikeHp: 900, strikeLp: 13000, level: 0.78, transient: { freq: 5200, amp: 0.85, decay: 0.007 },
    puff: { f0: 3000, f1: 780, q: 0.9, amp: 0.55, decay: 0.070, kind: 'white' },
    thud: { f: 150, to: 60, amp: 0.38, decay: 0.065 },
    debris: { n: [6, 13], f: [2200, 8000], amp: 0.20, spread: 0.28, decay: [0.004, 0.020] },
    ric: 0.42,
  },
  metal: {
    strike: 0.78, strikeHp: 1400, strikeLp: 16000, level: 0.80, transient: { freq: 6000, amp: 1.35, decay: 0.006 },
    puff: { f0: 3600, f1: 1400, q: 1.4, amp: 0.30, decay: 0.030, kind: 'white' },
    thud: { f: 180, to: 90, amp: 0.22, decay: 0.040 },
    modes: [612, 977, 1583, 2417, 3719, 5231], modeQ: 44, modeAmp: 0.30, modeDecay: 0.60,
    debris: { n: [2, 5], f: [4000, 10000], amp: 0.13, spread: 0.10, decay: [0.003, 0.010] },
    ric: 0.55,
  },
  glass: {
    strike: 0.89, strikeHp: 1900, strikeLp: 16000, level: 0.70, transient: { freq: 7000, amp: 1.25, decay: 0.005 },
    puff: { f0: 5200, f1: 2200, q: 1.1, amp: 0.28, decay: 0.030, kind: 'white' },
    thud: { f: 210, to: 120, amp: 0.14, decay: 0.030 },
    shatter: { n: [10, 22], f: [2200, 8500], amp: 0.13, spread: 0.28, decay: [0.05, 0.22] },
    debris: { n: [5, 11], f: [3000, 9000], amp: 0.14, spread: 0.35, decay: [0.004, 0.018] },
    ric: 0.0,
  },
  wood: {
    strike: 0.72, strikeHp: 430, strikeLp: 6500, level: 0.68, transient: { freq: 3200, amp: 0.65, decay: 0.009 },
    puff: { f0: 1700, f1: 480, q: 0.8, amp: 0.48, decay: 0.070, kind: 'white' },
    thud: { f: 145, to: 62, amp: 0.40, decay: 0.080 },
    modes: [214, 486, 812, 1290], modeQ: 13, modeAmp: 0.34, modeDecay: 0.16,
    debris: { n: [3, 7], f: [1400, 5000], amp: 0.14, spread: 0.22, decay: [0.005, 0.020] },
    ric: 0.10,
  },
  sand: {
    strike: 0.34, strikeHp: 300, strikeLp: 4200, level: 0.58, transient: { freq: 2600, amp: 0.28, decay: 0.010 },
    puff: { f0: 1900, f1: 500, q: 0.45, amp: 0.70, decay: 0.150, kind: 'pink', attack: 0.005 },
    thud: { f: 96, to: 44, amp: 0.34, decay: 0.090 },
    debris: { n: [1, 4], f: [1200, 3600], amp: 0.07, spread: 0.24, decay: [0.006, 0.022] },
    ric: 0.0,
  },
  grass: {
    strike: 0.40, strikeHp: 900, strikeLp: 8000, level: 0.50, transient: { freq: 4600, amp: 0.32, decay: 0.007 },
    puff: { f0: 3400, f1: 1100, q: 0.5, amp: 0.50, decay: 0.100, kind: 'pink', attack: 0.003 },
    thud: { f: 88, to: 42, amp: 0.24, decay: 0.070 },
    debris: { n: [3, 8], f: [2600, 7500], amp: 0.09, spread: 0.20, decay: [0.004, 0.014] },
    ric: 0.0,
  },
  water: {
    strike: 0.46, strikeHp: 380, strikeLp: 5200, level: 0.62, transient: { freq: 2200, amp: 0.30, decay: 0.008 },
    puff: { f0: 1200, f1: 3600, q: 0.6, amp: 0.62, decay: 0.110, kind: 'white', attack: 0.004, up: true },
    thud: { f: 78, to: 38, amp: 0.30, decay: 0.090 },
    bubbles: { n: [3, 8], f: [380, 1400], amp: 0.12, spread: 0.24 },
    ric: 0.0,
  },
  flesh: {
    strike: 0.58, strikeHp: 170, strikeLp: 2200, level: 0.74, transient: { freq: 900, amp: 0.36, decay: 0.010 },
    puff: { f0: 900, f1: 260, q: 0.7, amp: 0.72, decay: 0.070, kind: 'white', lp: 1400 },
    thud: { f: 105, to: 40, amp: 0.80, decay: 0.110 },
    squelch: true,
    debris: { n: [0, 2], f: [500, 1500], amp: 0.06, spread: 0.10, decay: [0.008, 0.026] },
    ric: 0.0,
  },
};

export const IMPACT_SURFACES = Object.keys(IMPACTS);

export function impactSpec(name) {
  return IMPACTS[String(name || '').toLowerCase()] || IMPACTS.concrete;
}

/**
 * opts: { surface, scale, gain }
 */
export function buildImpact(sc, opts = {}) {
  const rng = sc.rng;
  const t = sc.when;
  const s = impactSpec(opts.surface);
  const scale = clamp(opts.scale != null ? opts.scale : 1, 0.25, 4);
  const d = sc.distance || 0;
  const near = 1 / (1 + d / 30);
  const p = rnd(rng, 0.14);
  const lvl = (opts.gain != null ? opts.gain : 1) * s.level * (0.55 + 0.55 * scale) * rnd(rng, 0.14);
  const detail = sc.detail != null ? sc.detail : 1;

  // --- strike ---
  // Broadband sub-millisecond wavefront. Same idea as the muzzle blast in
  // Weapons.js: without it, filtered layers and ringing resonators build to a
  // plateau and the hit reads as a "whump" instead of a strike.
  {
    const amp = (s.strike != null ? s.strike : 1.2) * lvl * (0.15 + 0.85 * near) * rnd(rng, 0.10);
    const src = nNoise(sc, 'white', 1.8 * p);
    const hp = nFilter(sc, 'highpass', (s.strikeHp || 700) * p, 0.6);
    const lp = nFilter(sc, 'lowpass', (s.strikeLp || 12000) * p, 0.6);
    const g = nGain(sc, 0);
    chain(src, hp, lp, nShaper(sc, 2.4), g).connect(sc.out);
    const len = env(g.gain, t, [[0.0003, amp], [0.0026, amp * 0.20], [0.011, 0.0008]]);
    fire(sc, src, t, len + 0.005);
  }

  // --- transient ---
  {
    const tr = s.transient;
    const src = nNoise(sc, 'white', 1.4 * p);
    const hp = nFilter(sc, 'highpass', tr.freq * 0.4 * p, 0.7);
    const bp = nFilter(sc, 'bandpass', tr.freq * p * rnd(rng, 0.12), 1.0);
    const g = nGain(sc, 0);
    chain(src, hp, bp, g).connect(sc.out);
    const a = tr.amp * lvl * (0.18 + 0.82 * near);
    const len = env(g.gain, t, [[0.0004, a], [0.0004 + tr.decay, 0.0008]]);
    fire(sc, src, t, len + 0.006);
  }

  // --- body puff ---
  {
    const pf = s.puff;
    const src = nNoise(sc, pf.kind, p);
    const bp = nFilter(sc, 'bandpass', pf.f0 * p, pf.q);
    if (pf.up) {
      sweep(bp.frequency, t, pf.f0 * p, pf.f1 * p, pf.decay * 0.35, 40);
      sweep(bp.frequency, t + pf.decay * 0.4, pf.f1 * p, pf.f0 * 0.5 * p, pf.decay, 40);
    } else {
      sweep(bp.frequency, t, pf.f0 * p, pf.f1 * p, pf.decay * 0.8, 40);
    }
    const g = nGain(sc, 0);
    const nodes = [src, bp];
    if (pf.lp) nodes.push(nFilter(sc, 'lowpass', pf.lp * p, 0.8));
    nodes.push(nShaper(sc, 1.5), g);
    chain(...nodes).connect(sc.out);
    const a = pf.amp * lvl;
    const at = pf.attack || 0.0008;
    const len = env(g.gain, t, [[at, a], [at + pf.decay * 0.4, a * 0.34],
                                [at + pf.decay * 1.6, 0.0006]]);
    fire(sc, src, t, len + 0.01);
  }

  // --- low thud ---
  {
    const th = s.thud;
    const o = nOsc(sc, 'sine', th.f * p);
    sweep(o.frequency, t, th.f * p, th.to * p, th.decay * 0.8, 14);
    const g = nGain(sc, 0);
    chain(o, g).connect(sc.out);
    const a = th.amp * lvl * (0.7 + 0.6 * (1 - near));
    const len = env(g.gain, t, [[0.0018, a], [th.decay, 0.0006]]);
    fire(sc, o, t, len + 0.01);
  }

  // --- flesh squelch: a fast downward bandpass over the puff ---
  if (s.squelch) {
    const src = nNoise(sc, 'pink', 0.7);
    const bp = nFilter(sc, 'bandpass', 1600 * p, 3.4);
    sweep(bp.frequency, t, 1700 * p, 380 * p, 0.055, 40);
    const g = nGain(sc, 0);
    chain(src, bp, g).connect(sc.out);
    const a = 0.30 * lvl;
    const len = env(g.gain, t, [[0.003, a], [0.060, 0.0006]]);
    fire(sc, src, t, len + 0.01);
  }

  // --- modal ring (metal, wood) ---
  if (s.modes && near > 0.06 && detail > 0.25) {
    const src = nNoise(sc, 'white', 1);
    const pre = nGain(sc, 1);
    src.connect(pre);
    env(pre.gain, t, [[0.0006, 1], [0.006, 0.001]]);
    const end = resonatorBank(sc, pre, sc.out, s.modes.map((f) => f * p), {
      q: s.modeQ, amp: s.modeAmp * lvl * (0.25 + 0.75 * near),
      decay: s.modeDecay * rnd(rng, 0.25), t, spread: 0.05,
    });
    fire(sc, src, t, 0.03);
    mark(sc, t + end);
  }

  // --- glass shatter: inharmonic shards, staggered onsets ---
  if (s.shatter) {
    const sh = s.shatter;
    const n = Math.max(4, Math.round((sh.n[0] + Math.floor(rng() * (sh.n[1] - sh.n[0] + 1))) * (0.35 + 0.65 * detail)));
    for (let i = 0; i < n; i++) {
      const dt = rng() * rng() * sh.spread;     // front-loaded distribution
      toneLayer(sc, t + dt, {
        amp: sh.amp * lvl * rnd(rng, 0.6) / Math.sqrt(n) * 2.0,
        freq: (sh.f[0] + rng() * (sh.f[1] - sh.f[0])) * p,
        type: 'sine', attack: 0.0008,
        decay: sh.decay[0] + rng() * (sh.decay[1] - sh.decay[0]),
      });
    }
  }

  // --- debris grains ---
  if (s.debris) {
    const db = s.debris;
    const n = Math.round((db.n[0] + Math.floor(rng() * (db.n[1] - db.n[0] + 1))) * (0.3 + 0.7 * detail));
    for (let i = 0; i < n; i++) {
      const dt = rng() * rng() * db.spread;
      clickLayer(sc, t + dt, {
        amp: db.amp * lvl * near * rnd(rng, 0.55),
        freq: (db.f[0] + rng() * (db.f[1] - db.f[0])) * p,
        q: 1.6 + rng() * 3,
        decay: db.decay[0] + rng() * (db.decay[1] - db.decay[0]),
      });
    }
  }

  // --- water bubbles ---
  if (s.bubbles) {
    const b = s.bubbles;
    const n = b.n[0] + Math.floor(rng() * (b.n[1] - b.n[0] + 1));
    for (let i = 0; i < n; i++) {
      toneLayer(sc, t + 0.01 + rng() * b.spread, {
        amp: b.amp * lvl * rnd(rng, 0.5),
        freq: b.f[0] + rng() * (b.f[1] - b.f[0]),
        to: (b.f[0] + rng() * (b.f[1] - b.f[0])) * 2.4,
        type: 'sine', attack: 0.002, decay: 0.035 + rng() * 0.05, sweepTime: 0.04,
      });
    }
  }

  // --- ricochet ---
  if (s.ric > 0 && rng() < s.ric * near) {
    buildRicochet({ ...sc, when: t + 0.004 + rng() * 0.012, dur: 0 }, { gain: lvl * 0.9 });
    mark(sc, t + 0.45);
  }

  return sc.dur;
}

/** Descending whine — a round skipping off stone or steel. */
export function buildRicochet(sc, opts = {}) {
  const rng = sc.rng;
  const t = sc.when;
  const lvl = (opts.gain != null ? opts.gain : 1) * 0.42;
  const dur = 0.14 + rng() * 0.22;
  const f0 = 2200 + rng() * 2600;
  const f1 = f0 * (0.16 + rng() * 0.18);

  const o = nOsc(sc, rng() < 0.5 ? 'sawtooth' : 'square', f0);
  sweep(o.frequency, t, f0, f1, dur, 40);
  const bp = nFilter(sc, 'bandpass', f0, 5.5);
  sweep(bp.frequency, t, f0 * 1.1, f1 * 1.2, dur, 40);
  const g = nGain(sc, 0);
  chain(o, bp, g).connect(sc.out);
  const len = env(g.gain, t, [[0.003, lvl], [dur * 0.5, lvl * 0.45], [dur * 1.15, 0.0006]]);
  fire(sc, o, t, len + 0.01);

  // Vibrato: a wobbling ricochet is much more convincing than a clean glide.
  const lfo = nOsc(sc, 'sine', 18 + rng() * 26);
  const lfoGain = nGain(sc, f0 * 0.035);
  lfo.connect(lfoGain); lfoGain.connect(o.frequency);
  env(lfoGain.gain, t, [[0.01, f0 * 0.045], [dur, 1]]);
  fire(sc, lfo, t, len);

  // Airy noise riding along with it.
  const src = nNoise(sc, 'white', 1);
  const nbp = nFilter(sc, 'bandpass', f0, 2.2);
  sweep(nbp.frequency, t, f0, f1, dur, 40);
  const ng = nGain(sc, 0);
  chain(src, nbp, ng).connect(sc.out);
  env(ng.gain, t, [[0.004, lvl * 0.35], [dur * 1.1, 0.0006]]);
  fire(sc, src, t, len);
  return sc.dur;
}

/** Shield break / shield chip — glassy, synthetic, clearly not a wall. */
export function buildShieldHit(sc, opts = {}) {
  const rng = sc.rng;
  const t = sc.when;
  const broke = !!opts.broke;
  const lvl = (opts.gain != null ? opts.gain : 1) * (broke ? 0.55 : 0.34);

  const src = nNoise(sc, 'white', 1);
  const pre = nGain(sc, 1);
  src.connect(pre);
  env(pre.gain, t, [[0.0005, 1], [0.006, 0.001]]);
  const base = broke ? 1 : 1.18;
  const end = resonatorBank(sc, pre, sc.out,
    [1870 * base, 2960 * base, 4310 * base, 6120 * base].map((f) => f * rnd(rng, 0.05)), {
      q: 38, amp: lvl * 0.7, decay: broke ? 0.42 : 0.16, t, spread: 0.03,
    });
  fire(sc, src, t, 0.03);
  mark(sc, t + end);

  // Energy sizzle.
  toneLayer(sc, t, {
    amp: lvl * 0.28, freq: broke ? 1400 : 2600, to: broke ? 320 : 3400,
    type: 'triangle', attack: 0.001, decay: broke ? 0.30 : 0.09,
  });
  if (broke) {
    // Shards.
    for (let i = 0; i < 9; i++) {
      toneLayer(sc, t + rng() * rng() * 0.22, {
        amp: lvl * 0.13 * rnd(rng, 0.6), freq: 2400 + rng() * 5200,
        type: 'sine', attack: 0.001, decay: 0.05 + rng() * 0.16,
      });
    }
  }
  return sc.dur;
}

export default { buildImpact, buildRicochet, buildShieldHit, impactSpec, IMPACT_SURFACES };
