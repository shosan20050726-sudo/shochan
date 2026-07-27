/**
 * Low-level Web Audio building blocks.
 *
 * Every sound in the game is assembled from these. The important convention is
 * the "synth context" (`sc`) passed to every builder:
 *
 *   {
 *     ac,        BaseAudioContext (online OR offline — never assume online)
 *     out,       AudioNode every layer connects into (the voice head)
 *     when,      absolute start time in ac time
 *     distance,  metres to the listener, 0 for non-spatial
 *     rng,       seeded () => 0..1, deterministic per voice
 *     nodes,     every node created, so the voice can be torn down cleanly
 *     sources,   every scheduled source
 *   }
 *
 * Builders return the voice's total duration in seconds so the owner knows
 * when it is safe to disconnect.
 */
import { noiseBuffer } from './Buffers.js';

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
/** Symmetric random in [-1,1] scaled by k. */
export const jit = (rng, k) => (rng() * 2 - 1) * k;
/** Multiplicative jitter, e.g. rnd(rng, 0.1) -> 0.9..1.1 */
export const rnd = (rng, k) => 1 + (rng() * 2 - 1) * k;

const MIN = 1e-5;

function track(sc, node) { sc.nodes.push(node); return node; }

export function nGain(sc, value = 0) {
  const g = sc.ac.createGain();
  g.gain.value = value;
  return track(sc, g);
}

export function nFilter(sc, type, freq, q = 1, gainDb = 0) {
  const f = sc.ac.createBiquadFilter();
  f.type = type;
  f.frequency.value = clamp(freq, 10, sc.ac.sampleRate * 0.47);
  f.Q.value = q;
  if (gainDb) f.gain.value = gainDb;
  return track(sc, f);
}

export function nOsc(sc, type, freq) {
  const o = sc.ac.createOscillator();
  o.type = type;
  o.frequency.value = clamp(freq, 0.01, sc.ac.sampleRate * 0.45);
  sc.sources.push(o);
  return track(sc, o);
}

export function nNoise(sc, kind = 'white', rate = 1) {
  const s = sc.ac.createBufferSource();
  s.buffer = noiseBuffer(sc.ac, kind);
  s.loop = true;
  s.loopStart = 0;
  s.loopEnd = s.buffer.duration;
  s.playbackRate.value = clamp(rate, 0.05, 12);
  sc.sources.push(s);
  return track(sc, s);
}

export function nDelay(sc, time, max = 1.0) {
  const d = sc.ac.createDelay(Math.max(max, time + 0.01));
  d.delayTime.value = Math.max(0, time);
  return track(sc, d);
}

const CURVES = new WeakMap();
/** Cached tanh soft-saturation curve; drive 1 is nearly clean, 6 is crunchy. */
export function satCurve(ac, drive = 2) {
  let m = CURVES.get(ac);
  if (!m) { m = new Map(); CURVES.set(ac, m); }
  const key = Math.round(drive * 8);
  let c = m.get(key);
  if (!c) {
    const n = 1024;
    c = new Float32Array(n);
    const k = Math.tanh(drive);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * drive) / k;
    }
    m.set(key, c);
  }
  return c;
}

export function nShaper(sc, drive = 2) {
  const w = sc.ac.createWaveShaper();
  w.curve = satCurve(sc.ac, drive);
  // 'none' on purpose: Chrome's oversampled WaveShaper costs ~2.7 ms of group
  // delay, which smears exactly the transient these sounds are built around.
  // The sources being shaped are noise, so the aliasing it avoids is inaudible.
  w.oversample = 'none';
  return track(sc, w);
}

/** Connect a list of nodes in series; returns the last one. */
export function chain(...nodes) {
  const list = nodes.filter(Boolean);
  for (let i = 0; i < list.length - 1; i++) list[i].connect(list[i + 1]);
  return list[list.length - 1];
}

/**
 * Multi-segment exponential envelope.
 * `pts` is [[dtFromStart, value], ...] with strictly increasing times.
 * Returns the envelope length in seconds.
 */
export function env(param, t0, pts, scale = 1) {
  if (!pts.length) return 0;
  try {
    param.cancelScheduledValues(t0);
    param.setValueAtTime(MIN, t0);
    let last = 0;
    for (let i = 0; i < pts.length; i++) {
      const dt = Math.max(pts[i][0], last + 0.0002);
      const v = Math.max(pts[i][1] * scale, MIN);
      param.exponentialRampToValueAtTime(v, t0 + dt);
      last = dt;
    }
    param.linearRampToValueAtTime(0, t0 + last + 0.006);
    return last + 0.006;
  } catch (e) { return 0.05; }
}

/** Exponential parameter glide (pitch sweeps, filter sweeps). */
export function sweep(param, t0, from, to, dur, floor = 1) {
  try {
    param.cancelScheduledValues(t0);
    param.setValueAtTime(Math.max(from, floor), t0);
    param.exponentialRampToValueAtTime(Math.max(to, floor), t0 + Math.max(dur, 0.001));
  } catch (e) { /* param may be read-only in exotic contexts */ }
}

/** Extend the voice's known lifetime to an absolute time. */
export function mark(sc, tEnd) {
  const d = tEnd - sc.when;
  if (d > sc.dur) sc.dur = d;
  return d;
}

/**
 * Child synth context starting at a different time. Shares the node/source
 * lists so teardown still sees everything; call `merge` afterwards so the
 * parent's duration accounts for the child.
 */
export function sub(sc, when) {
  return { ...sc, when, dur: 0 };
}

export function merge(parent, child) {
  return mark(parent, child.when + child.dur);
}

/** Start/stop a source safely. Buffer sources get a random read offset. */
export function fire(sc, src, t, dur, offset) {
  const t0 = Math.max(t, 0);
  const t1 = t0 + Math.max(dur, 0.004);
  try {
    if (src.buffer) {
      const span = Math.max(src.buffer.duration - dur - 0.05, 0.001);
      src.start(t0, offset != null ? offset : sc.rng() * span);
    } else {
      src.start(t0);
    }
    src.stop(t1);
  } catch (e) { /* already started / context gone */ }
  if (t1 - sc.when > sc.dur) sc.dur = t1 - sc.when;
  return t1;
}

/**
 * A short filtered noise "click" — the atom of every mechanical sound.
 * Returns its duration.
 */
export function clickLayer(sc, t, opts = {}) {
  const {
    amp = 0.5, freq = 3000, q = 1.1, type = 'bandpass',
    attack = 0.0004, decay = 0.012, kind = 'white', rate = 1, drive = 0,
  } = opts;
  const src = nNoise(sc, kind, rate);
  const f = nFilter(sc, type, freq, q);
  const g = nGain(sc, 0);
  const tail = drive ? chain(src, f, nShaper(sc, drive), g) : chain(src, f, g);
  tail.connect(sc.out);
  const len = env(g.gain, t, [[attack, amp], [attack + decay, 0.001]]);
  fire(sc, src, t, len + 0.01);
  return len;
}

/**
 * Bank of ringing bandpass resonators fed from one input. This is how metal
 * gets its clang: a handful of *inharmonic* partials with long Q.
 */
export function resonatorBank(sc, input, dest, freqs, opts = {}) {
  const { q = 26, amp = 0.3, decay = 0.35, t = sc.when, spread = 0.0 } = opts;
  let longest = 0;
  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i] * (1 + jit(sc.rng, spread));
    const bp = nFilter(sc, 'bandpass', f, q * (1 - i * 0.08));
    const g = nGain(sc, 0);
    input.connect(bp); bp.connect(g); g.connect(dest);
    const a = amp * Math.pow(0.62, i);
    const d = decay * Math.pow(0.78, i);
    const len = env(g.gain, t, [[0.001, a], [d, 0.0006]]);
    if (len > longest) longest = len;
  }
  return longest;
}

/** Damped sine partial — wood thock, body resonance, heartbeat. */
export function toneLayer(sc, t, opts = {}) {
  const {
    amp = 0.3, freq = 200, to = null, type = 'sine',
    attack = 0.002, decay = 0.18, sweepTime = null, lp = 0,
  } = opts;
  const o = nOsc(sc, type, freq);
  const g = nGain(sc, 0);
  let node = o;
  if (lp) node = chain(o, nFilter(sc, 'lowpass', lp, 0.8));
  node.connect(g); g.connect(sc.out);
  if (to) sweep(o.frequency, t, freq, to, sweepTime != null ? sweepTime : decay * 0.7, 8);
  const len = env(g.gain, t, [[attack, amp], [attack + decay, 0.0008]]);
  fire(sc, o, t, len + 0.01);
  return len;
}

/** Deterministic 32-bit hash of a string — per-legend / per-weapon flavour. */
export function hashStr(s) {
  let h = 2166136261 >>> 0;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export default {
  clamp, lerp, jit, rnd, nGain, nFilter, nOsc, nNoise, nDelay, nShaper,
  chain, env, sweep, fire, mark, sub, merge, clickLayer, resonatorBank, toneLayer, hashStr,
};
