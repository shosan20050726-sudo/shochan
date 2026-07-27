/**
 * Gunshot synthesis.
 *
 * A convincing modern gunshot is not one sound, it is five arriving inside
 * 60 ms, plus a room:
 *
 *   1. TRANSIENT  ~1 ms of hard-filtered impulse — firing pin / muzzle blast
 *                 wavefront. This is what makes it feel *sharp*.
 *   2. BODY       shaped noise through a resonant bandpass whose centre
 *                 frequency and playback rate sweep downward fast. The sweep is
 *                 the whole trick: a static noise burst sounds like a hi-hat,
 *                 a swept one sounds like an explosion.
 *   3. ROAR       a wider, slower low-mid noise layer under the body, giving
 *                 weight without mud.
 *   4. THUMP      a sine/triangle punch sweeping ~150 Hz -> ~40 Hz with a fast
 *                 decay. Chest, not ears.
 *   5. MECHANICAL bolt / action clicks offset 12-45 ms later, plus a light
 *                 inharmonic resonator ring for metal.
 *
 * ...and then the TAIL, which is handled by the caller: the voice sends into a
 * convolution reverb whose impulse response is generated in Buffers.js. The
 * send level *rises* with distance while the dry level falls, so a rifle at
 * 200 m is nearly all tail and almost no crack, exactly like real life.
 *
 * Distance also drives an air-absorption lowpass (in AudioGraph) and, here,
 * a re-balance of the layers: the click and mechanical layers are pure high
 * frequency and effectively vanish beyond ~60 m, while a delayed low "boom"
 * layer fades in.
 */
import {
  rnd, nGain, nFilter, nNoise, nOsc, nShaper,
  chain, env, sweep, fire, mark, clickLayer, resonatorBank, toneLayer,
} from './Synth.js';

/**
 * Per-class character. These numbers are the difference between four guns and
 * one gun played at four pitches.
 */
export const WEAPON_SPECS = {
  pistol: {
    level: 0.60, pitchVar: 0.05, tail: 0.22, early: 0.34, boom: 0.30,
    blast: { amp: 1.50, hp: 320, lp: 13000, drive: 2.8, decay: 0.0040 },
    click: { amp: 0.70, freq: 4600, q: 0.9, decay: 0.008 },
    body: { f0: 2500, f1: 900, q: 1.35, sweepT: 0.030, amp: 0.62, drive: 2.0,
            lp: 11000, rate0: 1.25, rate1: 0.80,
            pts: [[0.0008, 1.0], [0.010, 0.38], [0.040, 0.075], [0.130, 0.001]] },
    roar: { f0: 1300, f1: 380, amp: 0.20, decay: 0.090, q: 0.7 },
    thump: { f0: 150, f1: 48, sweepT: 0.040, decay: 0.10, amp: 0.52, type: 'triangle' },
    mech: [{ dt: 0.020, amp: 0.26, freq: 2400, q: 2.2, decay: 0.016 },
           { dt: 0.052, amp: 0.18, freq: 1700, q: 2.8, decay: 0.022 }],
    ring: { freqs: [2900, 4300], q: 13, amp: 0.05, decay: 0.07 },
  },

  smg: {
    // Fast, spitty, bright. Small low end so bursts stay articulate.
    level: 0.55, pitchVar: 0.06, tail: 0.18, early: 0.30, boom: 0.22,
    blast: { amp: 1.55, hp: 420, lp: 15000, drive: 2.6, decay: 0.0032 },
    click: { amp: 0.80, freq: 5400, q: 0.9, decay: 0.007 },
    body: { f0: 3200, f1: 1250, q: 1.55, sweepT: 0.024, amp: 0.58, drive: 2.4,
            lp: 13000, rate0: 1.45, rate1: 0.95,
            pts: [[0.0007, 1.0], [0.008, 0.34], [0.030, 0.055], [0.090, 0.001]] },
    roar: { f0: 1600, f1: 480, amp: 0.15, decay: 0.070, q: 0.8 },
    thump: { f0: 128, f1: 55, sweepT: 0.030, decay: 0.070, amp: 0.36, type: 'triangle' },
    mech: [{ dt: 0.013, amp: 0.34, freq: 2900, q: 1.9, decay: 0.013 },
           { dt: 0.034, amp: 0.22, freq: 2100, q: 2.6, decay: 0.016 }],
    ring: { freqs: [3400, 5100], q: 15, amp: 0.07, decay: 0.055 },
  },

  rifle: {
    // Assault rifle: hard crack, real body, audible action.
    level: 0.72, pitchVar: 0.045, tail: 0.36, early: 0.38, boom: 0.55,
    blast: { amp: 1.62, hp: 300, lp: 13000, drive: 3.0, decay: 0.0046 },
    click: { amp: 0.80, freq: 4800, q: 0.85, decay: 0.009 },
    body: { f0: 2400, f1: 780, q: 1.25, sweepT: 0.036, amp: 0.66, drive: 2.8,
            lp: 12000, rate0: 1.30, rate1: 0.72,
            pts: [[0.0008, 1.0], [0.012, 0.40], [0.050, 0.085], [0.180, 0.001]] },
    roar: { f0: 1150, f1: 300, amp: 0.26, decay: 0.125, q: 0.65 },
    thump: { f0: 155, f1: 44, sweepT: 0.050, decay: 0.150, amp: 0.60, type: 'triangle' },
    sub: { freq: 62, decay: 0.20, amp: 0.24 },
    mech: [{ dt: 0.016, amp: 0.30, freq: 2600, q: 2.1, decay: 0.016 },
           { dt: 0.044, amp: 0.24, freq: 1800, q: 2.9, decay: 0.024 },
           { dt: 0.072, amp: 0.12, freq: 3300, q: 3.4, decay: 0.018 }],
    ring: { freqs: [2700, 3950, 5600], q: 18, amp: 0.075, decay: 0.09 },
    whip: { amp: 0.16, f0: 3600, f1: 900, dur: 0.020 },
  },

  lmg: {
    // Heavier, slower, more low-mid roar than the rifle.
    level: 0.78, pitchVar: 0.05, tail: 0.42, early: 0.40, boom: 0.70,
    blast: { amp: 1.42, hp: 260, lp: 11500, drive: 3.2, decay: 0.0052 },
    click: { amp: 0.62, freq: 4100, q: 0.85, decay: 0.010 },
    body: { f0: 2100, f1: 620, q: 1.05, sweepT: 0.044, amp: 0.70, drive: 3.2,
            lp: 10000, rate0: 1.20, rate1: 0.62,
            pts: [[0.0009, 1.0], [0.016, 0.44], [0.065, 0.10], [0.220, 0.001]] },
    roar: { f0: 980, f1: 250, amp: 0.32, decay: 0.155, q: 0.6 },
    thump: { f0: 165, f1: 40, sweepT: 0.055, decay: 0.185, amp: 0.70, type: 'triangle' },
    sub: { freq: 55, decay: 0.26, amp: 0.30 },
    mech: [{ dt: 0.018, amp: 0.34, freq: 2200, q: 2.0, decay: 0.020 },
           { dt: 0.050, amp: 0.26, freq: 1500, q: 2.8, decay: 0.030 }],
    ring: { freqs: [2300, 3400, 4800], q: 16, amp: 0.07, decay: 0.10 },
  },

  shotgun: {
    // Broadband, low-Q, huge low end. Reads as "wide" rather than "sharp".
    level: 0.92, pitchVar: 0.05, tail: 0.48, early: 0.44, boom: 0.85,
    blast: { amp: 1.42, hp: 190, lp: 9500, drive: 3.6, decay: 0.0075 },
    click: { amp: 0.52, freq: 3600, q: 0.7, decay: 0.012 },
    body: { f0: 1500, f1: 340, q: 0.55, sweepT: 0.060, amp: 0.72, drive: 3.6,
            lp: 8500, rate0: 1.05, rate1: 0.48,
            pts: [[0.0010, 1.0], [0.022, 0.46], [0.090, 0.11], [0.290, 0.001]] },
    roar: { f0: 760, f1: 190, amp: 0.36, decay: 0.200, q: 0.5 },
    thump: { f0: 195, f1: 36, sweepT: 0.070, decay: 0.260, amp: 0.70, type: 'triangle' },
    sub: { freq: 46, decay: 0.34, amp: 0.30 },
    mech: [{ dt: 0.030, amp: 0.20, freq: 1900, q: 2.4, decay: 0.026 }],
    ring: { freqs: [1700, 2600], q: 10, amp: 0.04, decay: 0.09 },
    pellets: { count: 9, amp: 0.20, spread: 0.014 },
  },

  sniper: {
    // The loudest, longest, darkest thing in the game. Enormous low sweep, a
    // supersonic whip on top, and a tail that outlives everything.
    level: 1.0, pitchVar: 0.03, tail: 0.80, early: 0.46, boom: 1.0,
    blast: { amp: 2.05, hp: 220, lp: 11000, drive: 4.0, decay: 0.0065 },
    click: { amp: 0.72, freq: 5000, q: 0.8, decay: 0.008 },
    body: { f0: 1750, f1: 360, q: 0.85, sweepT: 0.070, amp: 0.74, drive: 4.0,
            lp: 9500, rate0: 1.15, rate1: 0.42,
            pts: [[0.0008, 1.0], [0.024, 0.46], [0.110, 0.12], [0.380, 0.001]] },
    roar: { f0: 820, f1: 150, amp: 0.42, decay: 0.260, q: 0.5 },
    thump: { f0: 170, f1: 30, sweepT: 0.090, decay: 0.380, amp: 0.62, type: 'triangle' },
    sub: { freq: 40, decay: 0.50, amp: 0.28 },
    mech: [{ dt: 0.055, amp: 0.26, freq: 2000, q: 2.6, decay: 0.030 },
           { dt: 0.140, amp: 0.20, freq: 1400, q: 3.2, decay: 0.045 },
           { dt: 0.215, amp: 0.14, freq: 2600, q: 3.8, decay: 0.030 }],
    ring: { freqs: [1900, 2850, 4100], q: 20, amp: 0.055, decay: 0.16 },
    whip: { amp: 0.24, f0: 4200, f1: 700, dur: 0.026 },
  },

  energy: {
    // Legend / prototype weapon: FM zap over a short noise body.
    level: 0.62, pitchVar: 0.09, tail: 0.30, early: 0.36, boom: 0.20,
    blast: { amp: 1.35, hp: 600, lp: 16000, drive: 2.2, decay: 0.0026 },
    click: { amp: 0.50, freq: 6200, q: 1.4, decay: 0.006 },
    body: { f0: 2800, f1: 700, q: 2.6, sweepT: 0.045, amp: 0.40, drive: 2.0,
            lp: 14000, rate0: 1.5, rate1: 0.6,
            pts: [[0.0010, 1.0], [0.014, 0.32], [0.060, 0.05], [0.160, 0.001]] },
    roar: { f0: 1400, f1: 300, amp: 0.14, decay: 0.100, q: 1.1 },
    thump: { f0: 210, f1: 60, sweepT: 0.040, decay: 0.115, amp: 0.38, type: 'sine' },
    zap: { carrier: 1800, to: 240, mod: 340, index: 900, decay: 0.16, amp: 0.36 },
    mech: [{ dt: 0.090, amp: 0.10, freq: 3200, q: 3.0, decay: 0.030 }],
    ring: { freqs: [3600, 5400], q: 22, amp: 0.05, decay: 0.12 },
  },
};

const CLASS_KEYS = [
  ['sniper', /snip|dmr|kraber|longbow|bolt|marks/i],
  ['shotgun', /shot|peace|mastiff|eva|buck|slug/i],
  ['lmg', /lmg|spitfire|devot|rampage|machine|mg\b/i],
  ['smg', /smg|alter|r99|prowler|volt|car\b|mp\d/i],
  ['energy', /energ|plasma|laser|havoc|charge|ion|beam|arc/i],
  ['pistol', /pistol|p2020|re45|wingman|revolv|sidearm|handgun/i],
  ['rifle', /rifle|flatline|hemlok|havoc|r301|ak|scar|assault|carbine/i],
];

/** Best-effort mapping from whatever id the weapons system emits to a class. */
export function weaponClass(weaponId) {
  const id = String(weaponId == null ? '' : weaponId);
  if (WEAPON_SPECS[id]) return id;
  for (const [cls, re] of CLASS_KEYS) if (re.test(id)) return cls;
  return 'rifle';
}

export function weaponSpec(weaponId) {
  return WEAPON_SPECS[weaponClass(weaponId)];
}

/**
 * Assemble one shot into `sc.out`.
 * @returns {number} voice duration in seconds
 */
export function buildGunshot(sc, spec, opts = {}) {
  const { ac, rng } = sc;
  const t = sc.when;
  const d = sc.distance || 0;
  const near = 1 / (1 + d / 26);          // 1 at the muzzle, ->0 far away
  const far = 1 - near;
  const p = rnd(rng, spec.pitchVar);       // per-shot pitch variation
  const lvl = (opts.gain != null ? opts.gain : 1) * spec.level;
  const supp = opts.suppressed ? 0.45 : 1;
  const detail = sc.detail != null ? sc.detail : 1;

  // -------------------------------------------------------------------- blast
  // The muzzle-blast wavefront. Broadband, sub-millisecond attack, gone in a
  // few ms — this layer IS the peak of the sound, and it is the single thing
  // that separates a gunshot from a filtered noise burst. The master limiter's
  // 3 ms attack deliberately lets it through before gain reduction bites.
  if (spec.blast) {
    const bl = spec.blast;
    const amp = bl.amp * lvl * supp * (0.10 + 0.90 * near) * rnd(rng, 0.06);
    const src = nNoise(sc, 'white', 2.0 * p);
    const hp = nFilter(sc, 'highpass', bl.hp * p, 0.6);
    const lp = nFilter(sc, 'lowpass', bl.lp * p, 0.6);
    const g = nGain(sc, 0);
    chain(src, hp, lp, nShaper(sc, bl.drive), g).connect(sc.out);
    const len = env(g.gain, t, [[0.00035, amp], [bl.decay, amp * 0.22],
                                [bl.decay * 3.4, 0.0008]]);
    fire(sc, src, t, len + 0.005);
  }

  // ---------------------------------------------------------------- transient
  if (spec.click) {
    const c = spec.click;
    const amp = c.amp * lvl * supp * (0.10 + 0.90 * near) * rnd(rng, 0.10);
    const src = nNoise(sc, 'white', 1.6 * p);
    const hp = nFilter(sc, 'highpass', 1800 * p, 0.7);
    const bp = nFilter(sc, 'bandpass', c.freq * p * rnd(rng, 0.08), c.q);
    const g = nGain(sc, 0);
    chain(src, hp, bp, g).connect(sc.out);
    const len = env(g.gain, t, [[0.0004, amp], [0.0004 + c.decay, 0.001]]);
    fire(sc, src, t, len + 0.005);
  }

  // --------------------------------------------------------------------- body
  {
    const b = spec.body;
    const src = nNoise(sc, 'white', b.rate0 * p);
    sweep(src.playbackRate, t, b.rate0 * p, b.rate1 * p, b.sweepT, 0.05);

    // Centre frequency drops as distance rises: far shots are all low-mid.
    const f0 = b.f0 * p * (1 - 0.45 * far);
    const f1 = b.f1 * p * (1 - 0.30 * far);
    const bp = nFilter(sc, 'bandpass', f0, Math.max(b.q * (1 - 0.4 * far), 0.35));
    sweep(bp.frequency, t, f0, f1, b.sweepT, 40);
    const lp = nFilter(sc, 'lowpass', b.lp * p, 0.6);
    const sat = nShaper(sc, b.drive);
    const g = nGain(sc, 0);
    chain(src, bp, lp, sat, g).connect(sc.out);
    const amp = b.amp * lvl * supp * rnd(rng, 0.07);
    const len = env(g.gain, t, b.pts, amp);
    fire(sc, src, t, len + 0.01);
  }

  // --------------------------------------------------------------------- roar
  if (spec.roar) {
    const r = spec.roar;
    const src = nNoise(sc, 'pink', 1.0 * p);
    const bp = nFilter(sc, 'lowpass', r.f0 * p, r.q);
    sweep(bp.frequency, t, r.f0 * p, r.f1 * p, r.decay * 0.8, 40);
    const g = nGain(sc, 0);
    chain(src, bp, g).connect(sc.out);
    const amp = r.amp * lvl * supp * (0.75 + 0.55 * far) * rnd(rng, 0.08);
    const len = env(g.gain, t, [[0.002, amp], [r.decay * 0.35, amp * 0.45],
                                [r.decay, amp * 0.02], [r.decay * 2.0, 0.0008]]);
    fire(sc, src, t, len + 0.01);
  }

  // -------------------------------------------------------------------- thump
  {
    const th = spec.thump;
    const o = nOsc(sc, th.type, th.f0 * p);
    sweep(o.frequency, t, th.f0 * p, th.f1 * p, th.sweepT, 12);
    const lp = nFilter(sc, 'lowpass', 320, 0.9);
    const g = nGain(sc, 0);
    chain(o, lp, g).connect(sc.out);
    // Low end survives distance far better than the crack does.
    const amp = th.amp * lvl * supp * (0.55 + 0.75 * far) * rnd(rng, 0.06);
    const len = env(g.gain, t, [[0.0018, amp], [th.decay * 0.4, amp * 0.42],
                                [th.decay, 0.0008]]);
    fire(sc, o, t, len + 0.01);
  }

  if (spec.sub) {
    const s = spec.sub;
    const o = nOsc(sc, 'sine', s.freq * p);
    sweep(o.frequency, t, s.freq * 1.9 * p, s.freq * p, 0.05, 10);
    const g = nGain(sc, 0);
    chain(o, g).connect(sc.out);
    const amp = s.amp * lvl * supp * (0.5 + 0.8 * far);
    const len = env(g.gain, t, [[0.004, amp], [s.decay, 0.0008]]);
    fire(sc, o, t, len + 0.01);
  }

  // ------------------------------------------------------------------ pellets
  if (spec.pellets) {
    const pel = spec.pellets;
    const pn = Math.max(3, Math.round(pel.count * (0.4 + 0.6 * detail)));
    for (let i = 0; i < pn; i++) {
      const dt = rng() * pel.spread;
      clickLayer(sc, t + dt, {
        amp: pel.amp * lvl * near * rnd(rng, 0.4) / Math.sqrt(pel.count),
        freq: (2200 + rng() * 3800) * p, q: 1.6, decay: 0.010 + rng() * 0.012,
      });
    }
  }

  // --------------------------------------------------------------- supersonic
  if (spec.whip) {
    const w = spec.whip;
    const o = nOsc(sc, 'sawtooth', w.f0 * p);
    sweep(o.frequency, t, w.f0 * p, w.f1 * p, w.dur, 60);
    const bp = nFilter(sc, 'bandpass', 2400, 1.1);
    sweep(bp.frequency, t, 3800, 900, w.dur, 60);
    const g = nGain(sc, 0);
    chain(o, bp, g).connect(sc.out);
    const amp = w.amp * lvl * supp * (0.25 + 0.75 * near);
    const len = env(g.gain, t, [[0.0008, amp], [w.dur, amp * 0.15], [w.dur * 2.2, 0.0008]]);
    fire(sc, o, t, len + 0.01);
  }

  // -------------------------------------------------------------- energy zap
  if (spec.zap) {
    const z = spec.zap;
    const car = nOsc(sc, 'sine', z.carrier * p);
    const mod = nOsc(sc, 'sine', z.mod * p);
    const modGain = nGain(sc, z.index);
    mod.connect(modGain); modGain.connect(car.frequency);
    sweep(car.frequency, t, z.carrier * p, z.to * p, z.decay * 0.8, 20);
    env(modGain.gain, t, [[0.002, z.index], [z.decay * 0.7, z.index * 0.05]]);
    const g = nGain(sc, 0);
    const bp = nFilter(sc, 'bandpass', 1600, 0.9);
    chain(car, bp, g).connect(sc.out);
    const amp = z.amp * lvl * (0.3 + 0.7 * near);
    const len = env(g.gain, t, [[0.001, amp], [z.decay, 0.0008]]);
    fire(sc, car, t, len + 0.01);
    fire(sc, mod, t, len + 0.01);
  }

  // --------------------------------------------------------- mechanical layer
  const mechScale = 0.05 + 0.95 * near * near;
  if (spec.mech && mechScale > 0.02) {
    const taps = detail < 0.45 ? spec.mech.slice(0, 1) : spec.mech;
    for (const m of taps) {
      clickLayer(sc, t + m.dt * rnd(rng, 0.15), {
        amp: m.amp * lvl * mechScale * rnd(rng, 0.18),
        freq: m.freq * rnd(rng, 0.10), q: m.q, decay: m.decay, drive: 1.4,
      });
    }
  }

  // Inharmonic metal ring off the receiver — subtle, but it is the difference
  // between "a gun" and "a metal object that just did something violent".
  if (spec.ring && mechScale > 0.05 && detail > 0.3) {
    const src = nNoise(sc, 'white', 1);
    const pre = nGain(sc, 1);
    src.connect(pre);
    env(pre.gain, t, [[0.0008, 1], [0.010, 0.001]]);
    const rf = (detail < 0.6 ? spec.ring.freqs.slice(0, 2) : spec.ring.freqs).map((f) => f * p);
    const ringEnd = resonatorBank(sc, pre, sc.out, rf, {
      q: spec.ring.q, amp: spec.ring.amp * lvl * mechScale, decay: spec.ring.decay, t,
      spread: 0.04,
    });
    fire(sc, src, t, 0.03);
    mark(sc, t + ringEnd);
  }

  // ------------------------------------------------------------- distant boom
  // Beyond ~35 m the muzzle blast rolls in as a separate low event a few tens
  // of ms behind the crack. This is the cue the ear uses for "that was far".
  if (d > 35 && spec.boom > 0) {
    const bt = t + 0.022 + rng() * 0.035 + Math.min(d, 400) * 0.00012;
    const src = nNoise(sc, 'brown', 0.85);
    const lp = nFilter(sc, 'lowpass', 260, 0.8);
    sweep(lp.frequency, bt, 300, 95, 0.45, 40);
    const g = nGain(sc, 0);
    chain(src, lp, nShaper(sc, 1.3), g).connect(sc.out);
    const amp = spec.boom * lvl * Math.min(1, (d - 35) / 90) * 0.55 * rnd(rng, 0.15);
    const len = env(g.gain, bt, [[0.020, amp], [0.16, amp * 0.35], [0.62, 0.0008]]);
    fire(sc, src, bt, len + 0.01);
  }

  return sc.dur;
}

/** Dry-fire: firing pin on an empty chamber. */
export function buildDryFire(sc, opts = {}) {
  const t = sc.when;
  const lvl = (opts.gain != null ? opts.gain : 1) * 0.5;
  clickLayer(sc, t, { amp: 0.55 * lvl, freq: 3200, q: 2.2, decay: 0.010, drive: 2 });
  clickLayer(sc, t + 0.012, { amp: 0.30 * lvl, freq: 1800, q: 3.0, decay: 0.020 });
  toneLayer(sc, t + 0.001, { amp: 0.10 * lvl, freq: 2600, decay: 0.05, type: 'triangle' });
  return sc.dur;
}

/**
 * Supersonic round passing the listener. Pure Doppler: a bandpassed noise whose
 * centre frequency slams down as it goes by.
 */
export function buildWhizby(sc, opts = {}) {
  const t = sc.when;
  const lvl = (opts.gain != null ? opts.gain : 1) * 0.55;
  const rng = sc.rng;
  const dur = 0.075 + rng() * 0.05;
  const src = nNoise(sc, 'white', 1.0);
  const bp = nFilter(sc, 'bandpass', 3400, 3.2);
  sweep(bp.frequency, t, (2600 + rng() * 2400), 380 + rng() * 240, dur, 60);
  const g = nGain(sc, 0);
  chain(src, bp, g).connect(sc.out);
  const len = env(g.gain, t, [[dur * 0.35, lvl], [dur, lvl * 0.25], [dur * 1.9, 0.0008]]);
  fire(sc, src, t, len + 0.01);
  // A faint tonal core sells the "zip".
  toneLayer(sc, t, {
    amp: lvl * 0.18, freq: 1700 + rng() * 900, to: 260, type: 'sine',
    attack: dur * 0.3, decay: dur * 1.2, sweepTime: dur,
  });
  return sc.dur;
}

/** Ejected brass hitting the ground: two or three bright metallic ticks. */
export function buildShell(sc, opts = {}) {
  const t = sc.when;
  const rng = sc.rng;
  const lvl = (opts.gain != null ? opts.gain : 1) * 0.85;
  const bounces = 2 + Math.floor(rng() * 3);
  let at = t;
  for (let i = 0; i < bounces; i++) {
    const amp = lvl * Math.pow(0.55, i) * rnd(rng, 0.3);
    const src = nNoise(sc, 'white', 1);
    const pre = nGain(sc, 1);
    src.connect(pre);
    env(pre.gain, at, [[0.0005, 1], [0.004, 0.001]]);
    const end = resonatorBank(sc, pre, sc.out,
      [3300 * rnd(rng, 0.2), 5100 * rnd(rng, 0.2), 7400 * rnd(rng, 0.2)],
      { q: 34, amp, decay: 0.10 * Math.pow(0.7, i), t: at, spread: 0.05 });
    // Broadband tick so the bounce has an edge, not just a ring.
    clickLayer(sc, at, { amp: amp * 0.5, freq: 4200 * rnd(rng, 0.25), q: 1.4, decay: 0.005 });
    fire(sc, src, at, 0.02);
    mark(sc, at + end);
    at += 0.055 + rng() * 0.07;
  }
  return sc.dur;
}

export default { WEAPON_SPECS, weaponClass, weaponSpec, buildGunshot, buildDryFire, buildWhizby, buildShell };
