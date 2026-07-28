import * as THREE from 'three';

/**
 * Small, allocation-free math helpers shared by the weapon rig.
 *
 * Everything here is written so it can be called every frame from the update
 * loop without producing garbage: springs mutate in place, tracks return
 * scalars, and the only THREE objects that exist are the ones owned by a
 * long-lived spring instance.
 */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
/** Frame-rate independent exponential approach factor. */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
export const smooth = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
export const smoother = (t) => { t = clamp01(t); return t * t * t * (t * (t * 6 - 15) + 10); };
export const DEG = Math.PI / 180;

export function approach(cur, target, maxDelta) {
  const d = target - cur;
  if (d > maxDelta) return cur + maxDelta;
  if (d < -maxDelta) return cur - maxDelta;
  return target;
}

/** Shortest signed angular difference, radians. */
export function angleDelta(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/* --------------------------------------------------------------- easing -- */

export const EASE = {
  linear: (t) => t,
  in2: (t) => t * t,
  out2: (t) => 1 - (1 - t) * (1 - t),
  in3: (t) => t * t * t,
  out3: (t) => 1 - Math.pow(1 - t, 3),
  in4: (t) => t * t * t * t,
  out4: (t) => 1 - Math.pow(1 - t, 4),
  inOut: smooth,
  inOut5: smoother,
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -9 * t)),
  inExpo: (t) => (t <= 0 ? 0 : Math.pow(2, 9 * (t - 1))),
  // Overshoot: the single most important curve for making metal feel heavy.
  outBack: (t) => { const s = 1.9; const u = t - 1; return 1 + (s + 1) * u * u * u + s * u * u; },
  inBack: (t) => { const s = 1.9; return t * t * ((s + 1) * t - s); },
  outElastic: (t) => {
    if (t <= 0) return 0; if (t >= 1) return 1;
    const p = 0.34;
    return Math.pow(2, -9 * t) * Math.sin((t - p * 0.25) * (2 * Math.PI) / p) + 1;
  },
  // Snappy slam-and-settle used for magazine seating.
  outSlam: (t) => {
    if (t >= 1) return 1;
    const e = 1 - Math.pow(1 - t, 3.2);
    return e + Math.sin(t * Math.PI * 2.0) * 0.055 * (1 - t) * (1 - t);
  },
};

/**
 * Keyframe evaluator. `keys` is [[time, value, easeName?], ...] sorted by time;
 * the ease named on a key governs the segment that ENDS at that key.
 */
export function track(t, keys) {
  const n = keys.length;
  if (n === 0) return 0;
  if (t <= keys[0][0]) return keys[0][1];
  if (t >= keys[n - 1][0]) return keys[n - 1][1];
  for (let i = 1; i < n; i++) {
    const k1 = keys[i];
    if (t <= k1[0]) {
      const k0 = keys[i - 1];
      const span = k1[0] - k0[0];
      const u = span > 1e-6 ? (t - k0[0]) / span : 1;
      const fn = EASE[k1[2] || 'inOut'] || EASE.inOut;
      return k0[1] + (k1[1] - k0[1]) * fn(u);
    }
  }
  return keys[n - 1][1];
}

/** Triangular pulse: 0 -> 1 -> 0 across [a,b] peaking at `peak`. */
export function pulse(t, a, peak, b, easeIn = 'out2', easeOut = 'in2') {
  if (t <= a || t >= b) return 0;
  if (t < peak) return (EASE[easeIn] || EASE.out2)((t - a) / Math.max(1e-5, peak - a));
  return 1 - (EASE[easeOut] || EASE.in2)((t - peak) / Math.max(1e-5, b - peak));
}

/* -------------------------------------------------------------- springs -- */

const MAX_DT = 0.06;
const SUB = 1 / 360;

/**
 * Scalar spring-damper. `f` is angular frequency (rad/s), `z` the damping
 * ratio: 1 = critically damped, <1 overshoots (weight), >1 sluggish.
 */
export class Spring {
  constructor(f = 18, z = 1, value = 0) {
    this.f = f; this.z = z; this.x = value; this.v = 0; this.target = value;
  }

  set(v) { this.x = v; this.v = 0; this.target = v; return this; }
  kick(v) { this.v += v; return this; }

  step(dt) {
    if (dt > MAX_DT) dt = MAX_DT;
    const w = this.f, z2 = 2 * this.z * this.f;
    let remain = dt;
    while (remain > 1e-6) {
      const h = remain > SUB ? SUB : remain;
      remain -= h;
      const a = w * w * (this.target - this.x) - z2 * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
    return this.x;
  }
}

/** Vector3 spring. `x`, `v` and `target` are live Vector3s — write into them. */
export class Spring3 {
  constructor(f = 18, z = 1) {
    this.f = f; this.z = z;
    this.x = new THREE.Vector3();
    this.v = new THREE.Vector3();
    this.target = new THREE.Vector3();
  }

  set(x, y, z) { this.x.set(x, y, z); this.v.set(0, 0, 0); this.target.set(x, y, z); return this; }
  setV(v) { this.x.copy(v); this.v.set(0, 0, 0); this.target.copy(v); return this; }
  snap() { this.x.copy(this.target); this.v.set(0, 0, 0); return this; }
  kick(x, y, z) { this.v.x += x; this.v.y += y; this.v.z += z; return this; }

  step(dt) {
    if (dt > MAX_DT) dt = MAX_DT;
    const w2 = this.f * this.f, z2 = 2 * this.z * this.f;
    const x = this.x, v = this.v, t = this.target;
    let remain = dt;
    while (remain > 1e-6) {
      const h = remain > SUB ? SUB : remain;
      remain -= h;
      v.x += (w2 * (t.x - x.x) - z2 * v.x) * h;
      v.y += (w2 * (t.y - x.y) - z2 * v.y) * h;
      v.z += (w2 * (t.z - x.z) - z2 * v.z) * h;
      x.x += v.x * h; x.y += v.y * h; x.z += v.z * h;
    }
    return x;
  }
}

/** Deterministic hash noise in [-1,1] — used for idle drift, never for gameplay. */
export function hashNoise(t, seed = 0) {
  const s = Math.sin(t * 12.9898 + seed * 78.233) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

/** Smooth 1D value noise, C1 continuous, for breathing/idle drift. */
export function valueNoise(t, seed = 0) {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  const a = hashNoise(i, seed), b = hashNoise(i + 1, seed);
  return a + (b - a) * u;
}

export default {
  clamp, clamp01, lerp, damp, smooth, smoother, approach, angleDelta,
  EASE, track, pulse, Spring, Spring3, hashNoise, valueNoise, DEG,
};
