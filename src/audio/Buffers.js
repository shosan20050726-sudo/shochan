/**
 * Procedural audio assets. There are no audio files in this project, so every
 * buffer the engine ever plays is generated here, deterministically, from a
 * seeded RNG.
 *
 * Two families:
 *   1. Noise beds (white / pink / brown) — the raw material for every
 *      percussive, non-tonal layer (gun bodies, footsteps, impacts, wind).
 *   2. Impulse responses for the convolution reverb. These are the single most
 *      important thing in the whole file: a gunshot without a tail sounds like
 *      a toy, and the tail *is* the room. They are synthesised with
 *      frequency-dependent decay (highs die first, exactly like real air +
 *      absorbent surfaces) plus discrete early-reflection taps, which is what
 *      separates "reverb" from "a wash of noise".
 *
 * Buffers are cached per BaseAudioContext, so the same code path serves the
 * live AudioContext and any OfflineAudioContext used for verification.
 */
import { makeRNG } from '../core/Rand.js';

const CACHE = new WeakMap();

function slot(ac) {
  let e = CACHE.get(ac);
  if (!e) { e = { noise: new Map(), ir: new Map() }; CACHE.set(ac, e); }
  return e;
}

const KIND_SEED = { white: 0x1234, pink: 0x5A17, brown: 0x77C3, velvet: 0x2B9F };

/** Peak-normalise a Float32Array in place. */
function normalise(data, target = 0.92) {
  let peak = 0;
  for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
  if (peak > 1e-9) {
    const k = target / peak;
    for (let i = 0; i < data.length; i++) data[i] *= k;
  }
  return peak;
}

/**
 * Looping noise bed. 2.6 s is long enough that a random read offset per voice
 * makes repeated one-shots sound different every time without any audible
 * period.
 */
export function noiseBuffer(ac, kind = 'white', seed = 0x5EED) {
  const s = slot(ac);
  const hit = s.noise.get(kind);
  if (hit) return hit;

  const sr = ac.sampleRate;
  const len = Math.max(1024, Math.floor(sr * 2.6));
  const buf = ac.createBuffer(2, len, sr);

  for (let ch = 0; ch < 2; ch++) {
    const rng = makeRNG((seed + (KIND_SEED[kind] || 0) + ch * 7919) >>> 0);
    const d = buf.getChannelData(ch);

    if (kind === 'pink') {
      // Paul Kellet's refined pink filter — flat-ish -3 dB/oct, cheap.
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = rng() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        d[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        b6 = w * 0.115926;
      }
    } else if (kind === 'brown') {
      // Integrated white -> -6 dB/oct. The bed under wind and distant booms.
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = rng() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      }
    } else if (kind === 'velvet') {
      // Sparse signed impulses. Grain source for gravel/debris/rain-like layers.
      const density = 0.006;
      for (let i = 0; i < len; i++) {
        d[i] = rng() < density ? (rng() < 0.5 ? -1 : 1) : 0;
      }
    } else {
      for (let i = 0; i < len; i++) d[i] = rng() * 2 - 1;
    }
    normalise(d, kind === 'velvet' ? 1.0 : 0.9);
  }

  s.noise.set(kind, buf);
  return buf;
}

/**
 * Impulse response specs.
 *   rt: [low, mid, high] RT60 in seconds. Highs always shortest — that is what
 *       makes the tail sound like distance rather than like a spring reverb.
 *   taps: discrete early reflections [timeSeconds, amplitude]. Sign alternation
 *       is deliberate; real reflections invert on some boundaries and the
 *       resulting comb structure is what the ear reads as "a place".
 */
export const IR_SPECS = {
  // Tight interior — used as the always-on early-reflection send so even a
  // point-blank shot has a room around it.
  tight: {
    dur: 0.30, rt: [0.34, 0.24, 0.13], pre: 0.0015, spread: 0.4, hp: 140,
    taps: [[0.0035, 0.95], [0.0068, -0.72], [0.0112, 0.58], [0.0165, -0.44],
           [0.0228, 0.33], [0.0310, -0.24], [0.0415, 0.17]],
  },
  // Warehouse / building interior.
  indoor: {
    dur: 1.15, rt: [1.05, 0.74, 0.33], pre: 0.006, spread: 0.9, hp: 95,
    taps: [[0.0090, 0.82], [0.0152, -0.64], [0.0231, 0.52], [0.0344, -0.42],
           [0.0478, 0.33], [0.0641, -0.25], [0.0832, 0.19], [0.1090, -0.14]],
  },
  // Open ground with buildings in the middle distance. Sparse, dark, long low
  // end — the classic "rifle over a field" tail.
  outdoor: {
    dur: 2.30, rt: [2.05, 1.20, 0.42], pre: 0.012, spread: 1.6, hp: 72,
    taps: [[0.0285, 0.58], [0.0524, -0.45], [0.0881, 0.36], [0.1402, -0.28],
           [0.2058, 0.22], [0.2903, -0.16], [0.4011, 0.12], [0.5520, -0.085]],
  },
  // Rock walls. Discrete slap echoes that arrive late and keep coming.
  canyon: {
    dur: 3.60, rt: [3.30, 2.35, 0.88], pre: 0.020, spread: 2.4, hp: 58,
    taps: [[0.0752, 0.74], [0.1706, -0.58], [0.2914, 0.47], [0.4405, -0.38],
           [0.6402, 0.30], [0.8810, -0.22], [1.1830, 0.16], [1.5510, -0.11],
           [1.9800, 0.075]],
  },
};

/** One-pole coefficient for a cutoff in Hz at the given sample rate. */
function onePole(freq, sr) {
  return 1 - Math.exp(-2 * Math.PI * Math.min(freq, sr * 0.45) / sr);
}

/**
 * Build a stereo impulse response.
 *
 * The noise is split into three bands with independent exponential decays, so
 * the spectrum darkens as the tail rings out. Early taps are injected as short
 * filtered bursts rather than single-sample spikes — a lone spike reads as a
 * digital click, a 6 ms burst reads as a wall.
 */
export function impulseResponse(ac, name = 'outdoor', seed = 0x1D2E) {
  const s = slot(ac);
  const hit = s.ir.get(name);
  if (hit) return hit;

  const spec = IR_SPECS[name] || IR_SPECS.outdoor;
  const sr = ac.sampleRate;
  const len = Math.max(64, Math.floor(spec.dur * sr));
  const buf = ac.createBuffer(2, len, sr);

  const aLow = onePole(320, sr);
  const aMid = onePole(2600, sr);
  const aHp = onePole(spec.hp, sr);
  const LN1000 = 6.907755;

  for (let ch = 0; ch < 2; ch++) {
    const rng = makeRNG((seed + name.length * 337 + ch * 104729) >>> 0);
    const d = buf.getChannelData(ch);

    // Per-sample decay multipliers (cheaper and smoother than exp() per sample).
    const kL = Math.exp(-LN1000 / (spec.rt[0] * sr));
    const kM = Math.exp(-LN1000 / (spec.rt[1] * sr));
    const kH = Math.exp(-LN1000 / (spec.rt[2] * sr));
    let eL = 1, eM = 1, eH = 1;

    let lp1 = 0, lp2 = 0, hp = 0;
    const preN = Math.floor(spec.pre * sr);
    const buildN = Math.max(1, Math.floor(0.018 * sr));

    for (let i = 0; i < len; i++) {
      const w = rng() * 2 - 1;
      lp1 += (w - lp1) * aLow;
      lp2 += (w - lp2) * aMid;
      const low = lp1;
      const mid = lp2 - lp1;
      const high = w - lp2;

      let v = low * eL + mid * eM + high * eH;

      // Density build-up: a real room takes a few ms to become diffuse.
      if (i < preN) v *= 0.06;
      else if (i < preN + buildN) v *= 0.06 + 0.94 * ((i - preN) / buildN);

      // Kill DC / sub rumble that convolution would otherwise pile up.
      hp += (v - hp) * aHp;
      d[i] = v - hp;

      eL *= kL; eM *= kM; eH *= kH;
    }

    // Discrete early reflections, decorrelated L/R by spec.spread.
    for (let t = 0; t < spec.taps.length; t++) {
      const [time, amp] = spec.taps[t];
      const jitter = (rng() * 2 - 1) * 0.0022 * spec.spread;
      const start = Math.floor((time + jitter + (ch ? 0.0009 * spec.spread : 0)) * sr);
      const burst = Math.max(8, Math.floor(0.006 * sr));
      if (start < 0 || start + burst >= len) continue;
      let bl = 0;
      const aB = onePole(3200 - t * 260, sr);
      for (let i = 0; i < burst; i++) {
        const w = rng() * 2 - 1;
        bl += (w - bl) * aB;
        const wnd = Math.sin((i / burst) * Math.PI);
        d[start + i] += bl * wnd * amp * 0.55;
      }
    }

    normalise(d, 0.85);
  }

  s.ir.set(name, buf);
  return buf;
}

/** Pre-warm the buffers a live session will need, off the hot path. */
export function prewarm(ac, irs = ['tight', 'outdoor']) {
  noiseBuffer(ac, 'white');
  noiseBuffer(ac, 'pink');
  noiseBuffer(ac, 'brown');
  noiseBuffer(ac, 'velvet');
  for (const n of irs) impulseResponse(ac, n);
}

export default { noiseBuffer, impulseResponse, prewarm, IR_SPECS };
