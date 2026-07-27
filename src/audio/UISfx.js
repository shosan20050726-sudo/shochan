/**
 * Non-diegetic and mechanical UI sounds: hitmarkers, reload sequences, weapon
 * swaps, ability casts, menu clicks, the low-health heartbeat and the ring
 * klaxon.
 *
 * Hitmarkers are the most performance-critical feedback sound in an FPS: they
 * have to be readable inside a wall of gunfire, and body / headshot / kill must
 * be distinguishable in ~40 ms. They are therefore short, pitched, and
 * deliberately *not* noise — a tuned tick cuts through broadband gunfire in a
 * way another noise burst never can.
 */
import {
  clamp, rnd, nGain, nFilter, nNoise, nOsc, nShaper, chain, env, sweep, fire, mark,
  clickLayer, resonatorBank, toneLayer, hashStr,
} from './Synth.js';

/* ------------------------------------------------------------------ hitmarker */

const HIT_TONES = {
  body: { f: 1180, f2: 1770, amp: 0.34, decay: 0.045, q: 6 },
  head: { f: 1980, f2: 2970, amp: 0.42, decay: 0.055, q: 7 },
  shield: { f: 2450, f2: 3680, amp: 0.30, decay: 0.050, q: 9 },
  kill: { f: 1560, f2: 2340, amp: 0.46, decay: 0.075, q: 5 },
};

export function buildHitmarker(sc, opts = {}) {
  const t = sc.when;
  const kind = opts.kill ? 'kill' : opts.headshot ? 'head' : opts.shield ? 'shield' : 'body';
  const h = HIT_TONES[kind];
  const lvl = (opts.gain != null ? opts.gain : 1) * h.amp;
  const p = rnd(sc.rng, 0.02);

  // Tuned tick: two partials, second quieter, both very short.
  toneLayer(sc, t, { amp: lvl, freq: h.f * p, type: 'triangle', attack: 0.0006, decay: h.decay });
  toneLayer(sc, t, { amp: lvl * 0.45, freq: h.f2 * p, type: 'sine', attack: 0.0006, decay: h.decay * 0.6 });
  // Noise edge so it has an attack transient, not just a tone.
  clickLayer(sc, t, { amp: lvl * 0.55, freq: h.f * 2.4 * p, q: h.q, decay: 0.006 });

  if (kind === 'kill') {
    // Descending confirm interval — reads as "done" rather than "hit".
    toneLayer(sc, t + 0.055, { amp: lvl * 0.8, freq: h.f * 0.75 * p, type: 'triangle', attack: 0.001, decay: 0.12 });
    toneLayer(sc, t + 0.055, { amp: lvl * 0.35, freq: h.f * 1.5 * p, type: 'sine', attack: 0.001, decay: 0.09 });
    toneLayer(sc, t + 0.130, { amp: lvl * 0.55, freq: h.f * 0.5 * p, type: 'triangle', attack: 0.001, decay: 0.20 });
  }
  if (kind === 'head') {
    // A tiny metallic ping on top: the "crunch" of a headshot.
    const src = nNoise(sc, 'white', 1);
    const pre = nGain(sc, 1);
    src.connect(pre);
    env(pre.gain, t, [[0.0005, 1], [0.004, 0.001]]);
    const end = resonatorBank(sc, pre, sc.out, [3960 * p, 5940 * p], {
      q: 30, amp: lvl * 0.30, decay: 0.09, t,
    });
    fire(sc, src, t, 0.02);
    mark(sc, t + end);
  }
  return sc.dur;
}

/* --------------------------------------------------------------- kill confirm */

export function buildKillConfirm(sc, opts = {}) {
  const t = sc.when;
  const lvl = (opts.gain != null ? opts.gain : 1) * 0.30;
  // Rising major-ish triad, short and clean.
  const base = 620;
  const steps = [1, 1.26, 1.5, 2.0];
  for (let i = 0; i < steps.length; i++) {
    toneLayer(sc, t + i * 0.045, {
      amp: lvl * (1 - i * 0.12), freq: base * steps[i],
      type: i > 1 ? 'sine' : 'triangle', attack: 0.002, decay: 0.11 + i * 0.05,
    });
  }
  // Sub drop underneath for weight.
  toneLayer(sc, t, { amp: lvl * 0.7, freq: 150, to: 55, type: 'sine', attack: 0.004, decay: 0.30 });
  return sc.dur;
}

/* ------------------------------------------------------------------- UI clicks */

const UI_TONES = {
  click: { f: 2100, amp: 0.26, decay: 0.018, noise: 0.6 },
  hover: { f: 3000, amp: 0.12, decay: 0.010, noise: 0.4 },
  confirm: { f: 900, amp: 0.20, decay: 0.070, noise: 0.25, up: 1.5 },
  error: { f: 220, amp: 0.24, decay: 0.110, noise: 0.2, up: 0.7, type: 'square' },
  select: { f: 1500, amp: 0.18, decay: 0.040, noise: 0.4, up: 1.25 },
  pickup: { f: 1250, amp: 0.20, decay: 0.060, noise: 0.35, up: 1.6 },
};

export function buildUI(sc, opts = {}) {
  const t = sc.when;
  const u = UI_TONES[opts.kind] || UI_TONES.click;
  const lvl = (opts.gain != null ? opts.gain : 1) * u.amp;
  toneLayer(sc, t, {
    amp: lvl, freq: u.f, to: u.up ? u.f * u.up : null,
    type: u.type || 'triangle', attack: 0.0008, decay: u.decay,
    sweepTime: u.decay * 0.6,
  });
  if (u.noise) {
    clickLayer(sc, t, { amp: lvl * u.noise, freq: u.f * 2, q: 2.5, decay: 0.006 });
  }
  return sc.dur;
}

/* ---------------------------------------------------------------- reload chain */

/**
 * A reload is a *sequence*, and its readability is what tells the player how
 * long they are vulnerable. Offsets are normalised 0..1 across the reload
 * duration so it stays in sync with whatever the weapons system reports.
 */
const RELOAD_STEPS = {
  light: [
    { at: 0.02, kind: 'click', f: 2900, q: 2.4, amp: 0.36, decay: 0.012 },
    { at: 0.16, kind: 'rattle', f: 1500, amp: 0.26, decay: 0.10 },
    { at: 0.50, kind: 'thunk', f: 260, amp: 0.55, decay: 0.070 },
    { at: 0.58, kind: 'click', f: 2200, q: 3.0, amp: 0.34, decay: 0.016 },
    { at: 0.82, kind: 'slide', f: 1800, amp: 0.34, decay: 0.090 },
    { at: 0.94, kind: 'snap', f: 3100, q: 2.0, amp: 0.44, decay: 0.020 },
  ],
  heavy: [
    { at: 0.02, kind: 'click', f: 2200, q: 2.2, amp: 0.40, decay: 0.016 },
    { at: 0.14, kind: 'rattle', f: 1150, amp: 0.32, decay: 0.14 },
    { at: 0.46, kind: 'thunk', f: 190, amp: 0.70, decay: 0.100 },
    { at: 0.56, kind: 'click', f: 1700, q: 3.0, amp: 0.38, decay: 0.022 },
    { at: 0.78, kind: 'slide', f: 1300, amp: 0.42, decay: 0.130 },
    { at: 0.93, kind: 'snap', f: 2500, q: 1.8, amp: 0.52, decay: 0.028 },
  ],
  shell: [
    { at: 0.06, kind: 'click', f: 2600, q: 2.6, amp: 0.30, decay: 0.012 },
    { at: 0.24, kind: 'thunk', f: 320, amp: 0.42, decay: 0.050 },
    { at: 0.42, kind: 'thunk', f: 330, amp: 0.42, decay: 0.050 },
    { at: 0.60, kind: 'thunk', f: 310, amp: 0.42, decay: 0.050 },
    { at: 0.80, kind: 'slide', f: 1400, amp: 0.46, decay: 0.110 },
    { at: 0.95, kind: 'snap', f: 2400, q: 1.9, amp: 0.55, decay: 0.030 },
  ],
};

export function reloadStyle(weaponClass) {
  if (weaponClass === 'shotgun') return 'shell';
  if (weaponClass === 'lmg' || weaponClass === 'sniper') return 'heavy';
  return 'light';
}

function reloadStep(sc, t, step, lvl) {
  const rng = sc.rng;
  const p = rnd(rng, 0.06);
  const amp = step.amp * lvl * rnd(rng, 0.12);
  switch (step.kind) {
    case 'click':
    case 'snap':
      clickLayer(sc, t, { amp, freq: step.f * p, q: step.q || 2.4, decay: step.decay, drive: 1.6 });
      // Metal edge.
      toneLayer(sc, t, { amp: amp * 0.25, freq: step.f * 1.6 * p, type: 'triangle', attack: 0.0005, decay: step.decay * 1.4 });
      break;
    case 'thunk': {
      toneLayer(sc, t, { amp: amp, freq: step.f * p, to: step.f * 0.45 * p, type: 'triangle', attack: 0.002, decay: step.decay, sweepTime: step.decay * 0.6 });
      clickLayer(sc, t, { amp: amp * 0.55, freq: 1500 * p, q: 1.6, decay: 0.012 });
      const src = nNoise(sc, 'white', 1);
      const pre = nGain(sc, 1);
      src.connect(pre);
      env(pre.gain, t, [[0.0006, 1], [0.005, 0.001]]);
      const end = resonatorBank(sc, pre, sc.out, [820 * p, 1340 * p, 2210 * p],
        { q: 18, amp: amp * 0.30, decay: 0.10, t, spread: 0.04 });
      fire(sc, src, t, 0.02);
      mark(sc, t + end);
      break;
    }
    case 'rattle': {
      const n = 3 + Math.floor(rng() * 4);
      for (let i = 0; i < n; i++) {
        clickLayer(sc, t + rng() * step.decay, {
          amp: amp * 0.5 * rnd(rng, 0.5), freq: step.f * (0.6 + rng() * 1.4) * p,
          q: 3 + rng() * 4, decay: 0.008 + rng() * 0.018,
        });
      }
      break;
    }
    case 'slide': {
      // Metal-on-metal drag: bandpassed noise with a moving centre.
      const src = nNoise(sc, 'white', rnd(rng, 0.2));
      const bp = nFilter(sc, 'bandpass', step.f * p, 2.2);
      sweep(bp.frequency, t, step.f * 0.7 * p, step.f * 1.5 * p, step.decay, 60);
      const g = nGain(sc, 0);
      chain(src, bp, nShaper(sc, 1.4), g).connect(sc.out);
      const len = env(g.gain, t, [[0.006, amp], [step.decay * 0.6, amp * 0.5], [step.decay * 1.3, 0.0006]]);
      fire(sc, src, t, len + 0.01);
      break;
    }
    default: break;
  }
}

/** Whole reload sequence. opts: { style, duration, gain } */
export function buildReload(sc, opts = {}) {
  const t = sc.when;
  const dur = clamp(opts.duration != null ? opts.duration : 2.1, 0.35, 6);
  const steps = RELOAD_STEPS[opts.style] || RELOAD_STEPS.light;
  const lvl = (opts.gain != null ? opts.gain : 1) * 0.55;
  for (const s of steps) reloadStep(sc, t + s.at * dur, s, lvl);
  mark(sc, t + dur + 0.25);
  return sc.dur;
}

/** Final chamber snap for RELOAD_END, in case the sequence was cut short. */
export function buildReloadEnd(sc, opts = {}) {
  const t = sc.when;
  const lvl = (opts.gain != null ? opts.gain : 1) * 1.5;
  reloadStep(sc, t, { kind: 'snap', f: 2700, q: 2.0, amp: 0.5, decay: 0.024 }, lvl);
  reloadStep(sc, t + 0.05, { kind: 'click', f: 1900, q: 3.0, amp: 0.26, decay: 0.018 }, lvl);
  // Bolt seating: a short mid thunk so the end of a reload is felt, not just heard.
  reloadStep(sc, t + 0.012, { kind: 'thunk', f: 340, amp: 0.34, decay: 0.045 }, lvl * 0.7);
  return sc.dur;
}

/* --------------------------------------------------------------- weapon swap */

export function buildWeaponSwitch(sc, opts = {}) {
  const rng = sc.rng;
  const t = sc.when;
  const lvl = (opts.gain != null ? opts.gain : 1) * 0.5;

  // Cloth swish out of the holster.
  const src = nNoise(sc, 'pink', rnd(rng, 0.2));
  const bp = nFilter(sc, 'bandpass', 1100, 0.9);
  sweep(bp.frequency, t, 700, 2400, 0.13, 60);
  const g = nGain(sc, 0);
  chain(src, bp, g).connect(sc.out);
  const len = env(g.gain, t, [[0.020, lvl * 0.5], [0.090, lvl * 0.3], [0.190, 0.0006]]);
  fire(sc, src, t, len + 0.01);

  // Gear knocks and the receiver settling.
  for (let i = 0; i < 3; i++) {
    clickLayer(sc, t + 0.04 + rng() * 0.11, {
      amp: 0.16 * lvl * rnd(rng, 0.4), freq: 1600 + rng() * 3200,
      q: 3 + rng() * 4, decay: 0.010 + rng() * 0.02,
    });
  }
  reloadStep(sc, t + 0.16, { kind: 'thunk', f: 300, amp: 0.42, decay: 0.055 }, lvl);
  reloadStep(sc, t + 0.215, { kind: 'snap', f: 2600, q: 2.2, amp: 0.30, decay: 0.018 }, lvl);
  return sc.dur;
}

/* ---------------------------------------------------------------- abilities */

/**
 * Ability sounds are keyed off a hash of the legend id so every legend has its
 * own consistent timbre without needing a per-legend table (the legends system
 * is authored independently and its ids are not known here).
 */
export function buildAbility(sc, opts = {}) {
  const rng = sc.rng;
  const t = sc.when;
  const ult = opts.slot === 'ultimate';
  const h = hashStr(opts.legendId || 'default');
  const flavour = (h & 0xff) / 255;                 // 0..1 timbre selector
  const base = 180 + flavour * 260;                 // per-legend fundamental
  const lvl = (opts.gain != null ? opts.gain : 1) * (ult ? 0.37 : 0.32);
  const dur = ult ? 1.5 : 0.6;

  // Riser: detuned saw pair sweeping up through a resonant lowpass.
  for (let i = 0; i < 2; i++) {
    const o = nOsc(sc, i ? 'sawtooth' : 'triangle', base * (i ? 1.005 : 0.997));
    sweep(o.frequency, t, base * 0.6, base * (ult ? 4.2 : 2.6), dur * 0.7, 20);
    const lp = nFilter(sc, 'lowpass', 500, 6);
    sweep(lp.frequency, t, 400, ult ? 6500 : 3800, dur * 0.75, 40);
    const g = nGain(sc, 0);
    chain(o, lp, g).connect(sc.out);
    const a = lvl * (i ? 0.30 : 0.38);
    const len = env(g.gain, t, [[dur * 0.25, a], [dur * 0.7, a * 0.8], [dur, 0.0006]]);
    fire(sc, o, t, len + 0.01);
  }

  // Air: noise sweeping with the riser.
  {
    const src = nNoise(sc, 'pink', 1);
    const bp = nFilter(sc, 'bandpass', 800, 1.4);
    sweep(bp.frequency, t, 600, ult ? 7000 : 4200, dur * 0.8, 60);
    const g = nGain(sc, 0);
    chain(src, bp, g).connect(sc.out);
    const a = lvl * 0.34;
    const len = env(g.gain, t, [[dur * 0.35, a], [dur * 0.85, a * 0.5], [dur * 1.1, 0.0006]]);
    fire(sc, src, t, len + 0.01);
  }

  // Impact at the end of the cast: sub drop plus a metallic shimmer whose
  // partials come from the legend hash, so each legend reads distinct.
  const tImpact = t + dur * 0.72;
  toneLayer(sc, tImpact, {
    amp: lvl * 0.85, freq: 150 + flavour * 80, to: 38, type: 'sine',
    attack: 0.004, decay: ult ? 0.60 : 0.28, sweepTime: 0.10,
  });
  {
    const src = nNoise(sc, 'white', 1);
    const pre = nGain(sc, 1);
    src.connect(pre);
    env(pre.gain, tImpact, [[0.0008, 1], [0.008, 0.001]]);
    const partials = [1, 1.41 + flavour * 0.5, 2.13 + flavour * 0.7, 3.07 + flavour * 0.9]
      .map((m) => (500 + flavour * 900) * m);
    const end = resonatorBank(sc, pre, sc.out, partials, {
      q: 28, amp: lvl * (ult ? 0.34 : 0.22), decay: ult ? 0.9 : 0.35, t: tImpact, spread: 0.02,
    });
    fire(sc, src, tImpact, 0.03);
    mark(sc, tImpact + end);
  }

  if (ult) {
    // Extra tail: a slow, wide pad that makes an ultimate feel like an event.
    const o = nOsc(sc, 'sawtooth', base * 0.5);
    const lp = nFilter(sc, 'lowpass', 900, 2);
    sweep(lp.frequency, tImpact, 2600, 400, 1.2, 40);
    const g = nGain(sc, 0);
    chain(o, lp, g).connect(sc.out);
    const len = env(g.gain, tImpact, [[0.05, lvl * 0.24], [0.5, lvl * 0.12], [1.3, 0.0006]]);
    fire(sc, o, tImpact, len + 0.01);
  }
  return sc.dur;
}

/* ---------------------------------------------------------------- heartbeat */

/** "lub-dub" — two filtered sub thumps with a body resonance. */
export function buildHeartbeat(sc, opts = {}) {
  const t = sc.when;
  const intensity = clamp(opts.intensity != null ? opts.intensity : 1, 0, 1);
  const lvl = (opts.gain != null ? opts.gain : 1) * (0.10 + 0.20 * intensity);

  for (let i = 0; i < 2; i++) {
    const at = t + (i ? 0.145 : 0);
    const a = lvl * (i ? 0.62 : 1);
    const o = nOsc(sc, 'sine', 62);
    sweep(o.frequency, at, 78, 38, 0.10, 12);
    const lp = nFilter(sc, 'lowpass', 180, 1.1);
    const g = nGain(sc, 0);
    chain(o, lp, g).connect(sc.out);
    const len = env(g.gain, at, [[0.010, a], [0.055, a * 0.35], [0.150, 0.0006]]);
    fire(sc, o, at, len + 0.01);
    // Body thump texture.
    const src = nNoise(sc, 'brown', 0.6);
    const blp = nFilter(sc, 'lowpass', 220, 0.9);
    const bg = nGain(sc, 0);
    chain(src, blp, bg).connect(sc.out);
    const bl = env(bg.gain, at, [[0.012, a * 0.5], [0.120, 0.0006]]);
    fire(sc, src, at, bl + 0.01);
  }
  return sc.dur;
}

/* --------------------------------------------------------------------- ring */

/** Ring stage klaxon: descending three-tone plus a sub drop. */
export function buildRingStage(sc, opts = {}) {
  const t = sc.when;
  const stage = clamp(opts.stage != null ? opts.stage : 0, 0, 8);
  const lvl = (opts.gain != null ? opts.gain : 1) * (0.34 + stage * 0.035);
  // Later stages sit higher and tenser.
  const base = 420 + stage * 34;
  const seq = [1.0, 0.84, 0.667];
  for (let i = 0; i < seq.length; i++) {
    const at = t + i * 0.28;
    for (let h = 0; h < 2; h++) {
      const o = nOsc(sc, h ? 'sawtooth' : 'square', base * seq[i] * (h ? 2 : 1));
      const lp = nFilter(sc, 'lowpass', 2400, 1.4);
      const g = nGain(sc, 0);
      chain(o, lp, g).connect(sc.out);
      const a = lvl * (h ? 0.14 : 0.30);
      const len = env(g.gain, at, [[0.012, a], [0.20, a * 0.7], [0.30, 0.0006]]);
      fire(sc, o, at, len + 0.01);
    }
  }
  // Sub drop under the whole thing.
  toneLayer(sc, t, { amp: lvl * 0.9, freq: 110, to: 32, type: 'sine', attack: 0.02, decay: 1.1, sweepTime: 0.7 });
  // Distant rumble.
  {
    const src = nNoise(sc, 'brown', 0.7);
    const lp = nFilter(sc, 'lowpass', 200, 0.8);
    const g = nGain(sc, 0);
    chain(src, lp, g).connect(sc.out);
    const len = env(g.gain, t, [[0.25, lvl * 0.5], [1.2, 0.0006]]);
    fire(sc, src, t, len + 0.02);
  }
  mark(sc, t + 1.4);
  return sc.dur;
}

/** Being inside the ring: an electric sizzle tick. */
export function buildRingDamage(sc, opts = {}) {
  const rng = sc.rng;
  const t = sc.when;
  const lvl = (opts.gain != null ? opts.gain : 1) * 0.28;
  for (let i = 0; i < 5; i++) {
    clickLayer(sc, t + rng() * 0.10, {
      amp: lvl * rnd(rng, 0.6) * 0.5, freq: 1800 + rng() * 5200,
      q: 6 + rng() * 8, decay: 0.006 + rng() * 0.02,
    });
  }
  toneLayer(sc, t, { amp: lvl * 0.4, freq: 260, to: 120, type: 'sawtooth', attack: 0.006, decay: 0.18 });
  return sc.dur;
}

export default {
  buildHitmarker, buildKillConfirm, buildUI, buildReload, buildReloadEnd,
  buildWeaponSwitch, buildAbility, buildHeartbeat, buildRingStage, buildRingDamage,
  reloadStyle,
};
