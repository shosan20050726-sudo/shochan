/**
 * Footsteps, jumps and landings.
 *
 * The failure mode for procedural footsteps is that they loop: same click,
 * same pitch, forever. Every step here randomises pitch, gain, filter centre,
 * grain count, grain timing and the amount of gear rattle, and alternates a
 * subtle left/right timbre, so two identical steps are statistically almost
 * impossible.
 *
 * Each surface gets a genuinely different synthesis topology, not just a
 * different EQ curve: metal is a resonator bank, sand is filtered noise with a
 * soft attack, rock is granular, wood is a damped modal pair, water is a
 * lowpass sweep plus bubbles.
 */
import {
  clamp, rnd, nGain, nFilter, nNoise, nOsc, chain, env, sweep, fire, mark,
  sub, merge, clickLayer, resonatorBank, toneLayer, nShaper,
} from './Synth.js';

const SURFACES = {
  concrete: {
    level: 0.55, bp: [1100, 2400], q: 1.1, decay: 0.055, attack: 0.0009,
    thud: { f: 108, decay: 0.055, amp: 0.42 }, grit: [2, 5], gritF: [2600, 6200],
    gritAmp: 0.11, spread: 0.030,
  },
  rock: {
    level: 0.58, bp: [900, 3000], q: 0.9, decay: 0.070, attack: 0.0010,
    thud: { f: 96, decay: 0.065, amp: 0.38 }, grit: [4, 9], gritF: [1600, 5200],
    gritAmp: 0.20, spread: 0.048,
  },
  metal: {
    level: 0.64, bp: [1400, 3200], q: 1.4, decay: 0.030, attack: 0.0006,
    thud: { f: 128, decay: 0.035, amp: 0.26 }, grit: [1, 3], gritF: [3000, 7000],
    gritAmp: 0.10, spread: 0.018,
    modes: [742, 1187, 1963, 3121, 4507], modeQ: 24, modeAmp: 0.42, modeDecay: 0.30,
  },
  sand: {
    level: 0.46, bp: [1500, 4200], q: 0.5, decay: 0.135, attack: 0.0065,
    thud: { f: 84, decay: 0.045, amp: 0.20 }, grit: [0, 2], gritF: [2500, 5000],
    gritAmp: 0.05, spread: 0.040, hiss: 0.55,
  },
  grass: {
    level: 0.40, bp: [2400, 6000], q: 0.55, decay: 0.100, attack: 0.0040,
    thud: { f: 92, decay: 0.040, amp: 0.16 }, grit: [3, 7], gritF: [3200, 8000],
    gritAmp: 0.07, spread: 0.055, hiss: 0.40,
  },
  wood: {
    level: 0.54, bp: [800, 2000], q: 1.0, decay: 0.050, attack: 0.0010,
    thud: { f: 118, decay: 0.050, amp: 0.34 }, grit: [1, 3], gritF: [2200, 4800],
    gritAmp: 0.08, spread: 0.026,
    modes: [186, 431, 707], modeQ: 11, modeAmp: 0.34, modeDecay: 0.11,
  },
  glass: {
    level: 0.46, bp: [2800, 7000], q: 1.6, decay: 0.035, attack: 0.0006,
    thud: { f: 140, decay: 0.030, amp: 0.18 }, grit: [3, 7], gritF: [3800, 9500],
    gritAmp: 0.18, spread: 0.045,
    modes: [3120, 4680, 6350], modeQ: 40, modeAmp: 0.14, modeDecay: 0.18,
  },
  water: {
    level: 0.52, bp: [700, 2600], q: 0.6, decay: 0.115, attack: 0.0045,
    thud: { f: 76, decay: 0.055, amp: 0.24 }, grit: [0, 2], gritF: [1800, 4000],
    gritAmp: 0.05, spread: 0.05, splash: true,
  },
  flesh: {
    level: 0.44, bp: [420, 1100], q: 0.8, decay: 0.060, attack: 0.0018,
    thud: { f: 88, decay: 0.075, amp: 0.46 }, grit: [0, 1], gritF: [900, 2000],
    gritAmp: 0.04, spread: 0.03,
  },
};

export const SURFACE_LIST = Object.keys(SURFACES);

export function surfaceSpec(name) {
  return SURFACES[String(name || '').toLowerCase()] || SURFACES.concrete;
}

/**
 * One footstep.
 * opts: { surface, speed, gain, crouch, foot }
 */
export function buildFootstep(sc, opts = {}) {
  const rng = sc.rng;
  const t = sc.when;
  const s = surfaceSpec(opts.surface);
  const speed = clamp(opts.speed != null ? opts.speed : 4.6, 0, 14);
  // Faster => louder and brighter; crouching => quiet and dull.
  const effort = clamp(0.30 + speed / 9.0, 0.28, 1.45) * (opts.crouch ? 0.42 : 1);
  const p = rnd(rng, 0.13);                       // per-step pitch
  const bright = rnd(rng, 0.16) * (0.82 + 0.28 * clamp(speed / 7, 0, 1.4));
  // Alternating feet get a slightly different body so a walk cycle never
  // reads as a loop of one sample.
  const footTilt = (opts.foot ? 1.06 : 0.945);
  const lvl = (opts.gain != null ? opts.gain : 1) * s.level * effort * rnd(rng, 0.16);
  const detail = sc.detail != null ? sc.detail : 1;

  // --- scuff: the broadband contact noise ---
  {
    const src = nNoise(sc, s.hiss ? 'pink' : 'white', p * footTilt);
    const bp = nFilter(sc, 'bandpass', s.bp[0] * p * bright * footTilt, s.q);
    sweep(bp.frequency, t, s.bp[1] * p * bright, s.bp[0] * p * bright, s.decay * 0.9, 60);
    const g = nGain(sc, 0);
    chain(src, bp, g).connect(sc.out);
    const a = lvl * (s.hiss ? 0.85 : 1.0);
    const len = env(g.gain, t, [[s.attack, a], [s.attack + s.decay * 0.45, a * 0.35],
                                [s.attack + s.decay * (s.hiss ? 2.2 : 1.4), 0.0006]]);
    fire(sc, src, t, len + 0.01);
  }

  // --- heel thud: low body so steps have weight through a subwoofer ---
  {
    const th = s.thud;
    const o = nOsc(sc, 'sine', th.f * p * footTilt);
    sweep(o.frequency, t, th.f * 1.6 * p, th.f * 0.72 * p, th.decay, 20);
    const g = nGain(sc, 0);
    chain(o, g).connect(sc.out);
    const a = th.amp * lvl;
    const len = env(g.gain, t, [[0.0016, a], [th.decay, 0.0006]]);
    fire(sc, o, t, len + 0.01);
  }

  // --- grains: gravel, twigs, glass shards, loose plate ---
  const gn = Math.round((s.grit[0] + Math.floor(rng() * (s.grit[1] - s.grit[0] + 1))) * (0.3 + 0.7 * detail));
  for (let i = 0; i < gn; i++) {
    clickLayer(sc, t + rng() * s.spread, {
      amp: s.gritAmp * lvl * rnd(rng, 0.5),
      freq: (s.gritF[0] + rng() * (s.gritF[1] - s.gritF[0])) * p,
      q: 1.4 + rng() * 2.2,
      decay: 0.004 + rng() * 0.012,
    });
  }

  // --- modal ring: metal plate, hollow wood, glass ---
  if (s.modes) {
    const src = nNoise(sc, 'white', 1);
    const pre = nGain(sc, 1);
    src.connect(pre);
    env(pre.gain, t, [[0.0006, 1], [0.005, 0.001]]);
    const end = resonatorBank(sc, pre, sc.out, s.modes.map((f) => f * p * footTilt), {
      q: s.modeQ, amp: s.modeAmp * lvl, decay: s.modeDecay * rnd(rng, 0.2), t, spread: 0.03,
    });
    fire(sc, src, t, 0.02);
    mark(sc, t + end);
  }

  // --- water splash ---
  if (s.splash) {
    const src = nNoise(sc, 'white', rnd(rng, 0.2));
    const lp = nFilter(sc, 'lowpass', 600, 0.9);
    sweep(lp.frequency, t, 900, 4200, 0.035, 60);
    sweep(lp.frequency, t + 0.04, 4200, 500, 0.16, 60);
    const g = nGain(sc, 0);
    chain(src, lp, g).connect(sc.out);
    const len = env(g.gain, t, [[0.004, lvl * 0.9], [0.05, lvl * 0.35], [0.22, 0.0006]]);
    fire(sc, src, t, len + 0.01);
    const bubbles = 2 + Math.floor(rng() * 4);
    for (let i = 0; i < bubbles; i++) {
      toneLayer(sc, t + 0.02 + rng() * 0.14, {
        amp: lvl * 0.10 * rnd(rng, 0.5), freq: 400 + rng() * 900,
        to: 900 + rng() * 1400, type: 'sine', attack: 0.002,
        decay: 0.030 + rng() * 0.04, sweepTime: 0.035,
      });
    }
  }

  // --- gear rattle: kit, sling, buckles. Only when actually moving. ---
  if (speed > 2.2 && detail > 0.4 && rng() < 0.72) {
    const n = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      clickLayer(sc, t + 0.006 + rng() * 0.055, {
        amp: 0.055 * lvl * rnd(rng, 0.5),
        freq: 2400 + rng() * 4200, q: 3.5 + rng() * 4, decay: 0.008 + rng() * 0.02,
      });
    }
  }

  // --- cloth: soft pink whoosh, gives the step a body attached to it ---
  if (rng() < 0.85) {
    const src = nNoise(sc, 'pink', rnd(rng, 0.25));
    const bp = nFilter(sc, 'bandpass', 900 * rnd(rng, 0.3), 0.7);
    const g = nGain(sc, 0);
    chain(src, bp, g).connect(sc.out);
    const a = 0.075 * lvl;
    const len = env(g.gain, t, [[0.012, a], [0.075, 0.0005]]);
    fire(sc, src, t, len + 0.01);
  }

  return sc.dur;
}

/** Jump: cloth + gear + a short exhale-shaped noise formant. */
export function buildJump(sc, opts = {}) {
  const rng = sc.rng;
  const t = sc.when;
  const lvl = (opts.gain != null ? opts.gain : 1) * 0.5;

  // Push-off scuff.
  const push = sub(sc, t);
  buildFootstep(push, { surface: opts.surface, speed: 5.5, gain: lvl * 1.1, foot: rng() < 0.5 });
  merge(sc, push);

  // Exhale: two overlapping formant-ish bandpasses on pink noise. Not a voice
  // sample, but the ear reads the formant pair as breath.
  const src = nNoise(sc, 'pink', rnd(rng, 0.15));
  const f1 = nFilter(sc, 'bandpass', 620 * rnd(rng, 0.12), 2.4);
  const f2 = nFilter(sc, 'bandpass', 1450 * rnd(rng, 0.12), 3.0);
  const mix = nGain(sc, 1);
  const g = nGain(sc, 0);
  src.connect(f1); src.connect(f2);
  f1.connect(mix); f2.connect(mix);
  chain(mix, g).connect(sc.out);
  const a = 0.16 * lvl;
  const len = env(g.gain, t + 0.01, [[0.020, a], [0.075, a * 0.4], [0.180, 0.0006]]);
  fire(sc, src, t, len + 0.03);

  // Gear jangle on the way up.
  for (let i = 0; i < 3; i++) {
    clickLayer(sc, t + 0.02 + rng() * 0.09, {
      amp: 0.06 * lvl * rnd(rng, 0.5), freq: 2600 + rng() * 4200,
      q: 4 + rng() * 5, decay: 0.010 + rng() * 0.025,
    });
  }
  return sc.dur;
}

/** Landing: impact scaled by fall speed, plus knee-bend gear noise. */
export function buildLand(sc, opts = {}) {
  const rng = sc.rng;
  const t = sc.when;
  const speed = clamp(opts.speed != null ? opts.speed : 6, 0, 26);
  const hard = clamp(speed / 13, 0.22, 1.6);
  const lvl = (opts.gain != null ? opts.gain : 1) * 0.85 * hard;
  const s = surfaceSpec(opts.surface);

  // Big low thud.
  {
    const o = nOsc(sc, 'triangle', 128 * rnd(rng, 0.12));
    sweep(o.frequency, t, 165, 46, 0.075, 16);
    const lp = nFilter(sc, 'lowpass', 380, 0.9);
    const g = nGain(sc, 0);
    chain(o, lp, g).connect(sc.out);
    const a = 0.75 * lvl;
    const len = env(g.gain, t, [[0.002, a], [0.055, a * 0.35], [0.190, 0.0006]]);
    fire(sc, o, t, len + 0.01);
  }

  // Surface splat, harder and brighter than a walking step.
  const a1 = sub(sc, t + 0.002);
  buildFootstep(a1, { surface: opts.surface, speed: 8 + hard * 5, gain: lvl * 1.25, foot: true });
  merge(sc, a1);
  const a2 = sub(sc, t + 0.026 + rng() * 0.02);
  buildFootstep(a2, { surface: opts.surface, speed: 5 + hard * 4, gain: lvl * 0.7, foot: false });
  merge(sc, a2);

  // Gear slam.
  const n = 3 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    clickLayer(sc, t + rng() * 0.10, {
      amp: 0.085 * lvl * rnd(rng, 0.5), freq: 1800 + rng() * 5200,
      q: 3 + rng() * 6, decay: 0.010 + rng() * 0.03,
    });
  }

  // Hard landings on hollow surfaces boom.
  if (s.modes && hard > 0.6) {
    const src = nNoise(sc, 'white', 1);
    const pre = nGain(sc, 1);
    src.connect(pre);
    env(pre.gain, t, [[0.001, 1], [0.008, 0.001]]);
    const end = resonatorBank(sc, pre, sc.out, s.modes, {
      q: s.modeQ, amp: s.modeAmp * lvl * 0.9, decay: s.modeDecay * 1.6, t, spread: 0.03,
    });
    fire(sc, src, t, 0.03);
    mark(sc, t + end);
  }
  return sc.dur;
}

/** Slide start: sustained scrape with a rising then falling filter. */
export function buildSlide(sc, opts = {}) {
  const rng = sc.rng;
  const t = sc.when;
  const lvl = (opts.gain != null ? opts.gain : 1) * 0.5;
  const dur = clamp(opts.duration != null ? opts.duration : 0.9, 0.2, 2.4);
  const s = surfaceSpec(opts.surface);
  const src = nNoise(sc, 'white', rnd(rng, 0.15));
  const bp = nFilter(sc, 'bandpass', s.bp[0] * 1.2, 0.8);
  sweep(bp.frequency, t, s.bp[1] * 1.3, s.bp[0] * 0.65, dur, 60);
  const sat = nShaper(sc, 1.6);
  const g = nGain(sc, 0);
  chain(src, bp, sat, g).connect(sc.out);
  const len = env(g.gain, t, [[0.03, lvl], [dur * 0.55, lvl * 0.55], [dur, 0.0006]]);
  fire(sc, src, t, len + 0.02);
  // Low rumble of the body dragging.
  const o = nOsc(sc, 'sine', 70);
  const og = nGain(sc, 0);
  chain(o, og).connect(sc.out);
  env(og.gain, t, [[0.04, lvl * 0.35], [dur * 0.8, 0.0006]]);
  fire(sc, o, t, len);
  return sc.dur;
}

export default { buildFootstep, buildJump, buildLand, buildSlide, surfaceSpec, SURFACE_LIST };
