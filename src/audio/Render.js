/**
 * Offline rendering and numerical analysis.
 *
 * Because the whole mixer is written against BaseAudioContext, this module can
 * instantiate the *exact* production graph on an OfflineAudioContext and render
 * any sound in the bank to a buffer. That means the verification numbers in the
 * report describe the code that actually ships, not a parallel test rig.
 *
 * This module is only ever loaded via dynamic import (AudioSystem.render), so
 * it lands in its own chunk and costs the game nothing.
 */
import CFG from '../core/Config.js';
import AudioGraph from './AudioGraph.js';
import { ALL_IDS } from './SoundBank.js';

/**
 * @param {string} id sound bank id
 * @param {object} o { distance, duration, sampleRate, environment, seed,
 *                     spatial, propagate, opts }
 * @returns {Promise<AudioBuffer>}
 */
export async function renderSound(id, o = {}) {
  const sr = o.sampleRate || 48000;
  const dur = o.duration || 3.0;
  const Ctor = (typeof OfflineAudioContext !== 'undefined')
    ? OfflineAudioContext : self.webkitOfflineAudioContext;
  const oac = new Ctor(2, Math.max(128, Math.ceil(sr * dur)), sr);

  const graph = new AudioGraph(oac, { ...(CFG.audio || {}), ...(o.cfg || {}) }, {
    live: false,
    seed: o.seed != null ? o.seed : 0xA9EC,
    environment: o.environment || 'outdoor',
  });
  graph.setListener(0, 0, 0, 0, 0, -1, 0, 1, 0);

  const d = o.distance != null ? o.distance : 0;
  const spatial = o.spatial != null ? o.spatial : d > 0;
  const opts = {
    when: 0,
    propagate: o.propagate === true,      // off by default so t=0 is the onset
    spatial,
    ...(o.opts || {}),
  };
  if (spatial) {
    opts.position = { x: 0, y: 0, z: -Math.max(d, 0.001) };
    opts.distance = d;
  }
  graph.spawn(id, opts);
  return oac.startRendering();
}

/* ------------------------------------------------------------------- analysis */

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** Energy-weighted spectral centroid (Hz) over [from,to) seconds. */
export function spectralCentroid(buffer, from = 0, to = Infinity, size = 2048) {
  const sr = buffer.sampleRate;
  const ch = buffer.getChannelData(0);
  const ch2 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const i0 = Math.max(0, Math.floor(from * sr));
  const i1 = Math.min(ch.length, Math.floor(Math.min(to, buffer.duration) * sr));
  if (i1 - i0 < size) return 0;

  const win = new Float32Array(size);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size);

  const re = new Float32Array(size);
  const im = new Float32Array(size);
  let num = 0, den = 0;
  const hop = size >> 1;
  for (let s = i0; s + size <= i1; s += hop) {
    for (let i = 0; i < size; i++) {
      const v = ch2 ? (ch[s + i] + ch2[s + i]) * 0.5 : ch[s + i];
      re[i] = v * win[i]; im[i] = 0;
    }
    fft(re, im);
    for (let k = 1; k < size / 2; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const f = k * sr / size;
      num += f * mag; den += mag;
    }
  }
  return den > 1e-12 ? num / den : 0;
}

/** Peak-abs envelope, `n` buckets over [from,to) seconds, for plotting. */
export function envelope(buffer, n = 512, from = 0, to = Infinity) {
  const ch = buffer.getChannelData(0);
  const ch2 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const sr = buffer.sampleRate;
  const i0 = Math.max(0, Math.floor(from * sr));
  const i1 = Math.min(ch.length, Math.floor(Math.min(to, buffer.duration) * sr));
  const out = new Float32Array(n);
  const step = (i1 - i0) / n;
  for (let i = 0; i < n; i++) {
    const a = i0 + Math.floor(i * step), b = Math.min(i1, i0 + Math.floor((i + 1) * step));
    let m = 0;
    for (let j = a; j < b; j++) {
      const v = Math.max(Math.abs(ch[j]), ch2 ? Math.abs(ch2[j]) : 0);
      if (v > m) m = v;
    }
    out[i] = m;
  }
  return out;
}

/** Coarse log-frequency spectrogram, cols x bins, values 0..1. */
export function spectrogram(buffer, cols = 256, bins = 96, size = 1024, from = 0, to = Infinity) {
  const sr = buffer.sampleRate;
  const ch = buffer.getChannelData(0);
  const i0 = Math.max(0, Math.floor(from * sr));
  const i1 = Math.min(ch.length, Math.floor(Math.min(to, buffer.duration) * sr));
  const out = new Float32Array(cols * bins);
  const win = new Float32Array(size);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size);
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  const step = Math.max(1, Math.floor((i1 - i0 - size) / cols));
  const fMin = 40, fMax = Math.min(18000, sr * 0.45);
  let maxV = 1e-9;
  for (let c = 0; c < cols; c++) {
    const s = i0 + c * step;
    if (s + size > i1) break;
    for (let i = 0; i < size; i++) { re[i] = ch[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let b = 0; b < bins; b++) {
      const f0 = fMin * Math.pow(fMax / fMin, b / bins);
      const f1 = fMin * Math.pow(fMax / fMin, (b + 1) / bins);
      const k0 = Math.max(1, Math.round(f0 * size / sr));
      const k1 = Math.max(k0 + 1, Math.round(f1 * size / sr));
      let acc = 0;
      for (let k = k0; k < k1 && k < size / 2; k++) {
        acc += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      }
      const v = acc / (k1 - k0);
      out[c * bins + b] = v;
      if (v > maxV) maxV = v;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i] / maxV;
  return { data: out, cols, bins, fMin, fMax };
}

/** Full measurement set for one rendered buffer. */
export function measure(buffer) {
  const sr = buffer.sampleRate;
  const ch = buffer.getChannelData(0);
  const ch2 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const n = ch.length;

  let peak = 0, peakIdx = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    const v = ch2 ? Math.max(Math.abs(ch[i]), Math.abs(ch2[i])) : Math.abs(ch[i]);
    if (v > peak) { peak = v; peakIdx = i; }
    sum += ch[i] * ch[i];
  }
  const rms = Math.sqrt(sum / Math.max(n, 1));

  // Smoothed energy envelope for decay measurement (1 ms window).
  const win = Math.max(1, Math.floor(sr * 0.001));
  const envN = Math.floor(n / win);
  const envArr = new Float32Array(envN);
  for (let i = 0; i < envN; i++) {
    let m = 0;
    for (let j = i * win; j < (i + 1) * win && j < n; j++) {
      const v = ch2 ? Math.max(Math.abs(ch[j]), Math.abs(ch2[j])) : Math.abs(ch[j]);
      if (v > m) m = v;
    }
    envArr[i] = m;
  }

  const thr60 = peak * 0.001;
  const thr20 = peak * 0.1;
  let audibleMs = 0, decay20Ms = 0;
  for (let i = envN - 1; i >= 0; i--) if (envArr[i] > thr60) { audibleMs = i; break; }
  const peakMs = Math.floor(peakIdx / sr * 1000);
  for (let i = peakMs; i < envN; i++) if (envArr[i] <= thr20) { decay20Ms = i - peakMs; break; }

  // Attack: first sample crossing 90 % of peak.
  let attackMs = 0;
  for (let i = 0; i < n; i++) {
    const v = ch2 ? Math.max(Math.abs(ch[i]), Math.abs(ch2[i])) : Math.abs(ch[i]);
    if (v >= peak * 0.9) { attackMs = i / sr * 1000; break; }
  }
  // Onset: first sample above 1 % of peak. Timings are reported relative to
  // this as well as to the buffer start, because Chrome's
  // DynamicsCompressorNode on the master bus has a fixed 6 ms of lookahead
  // latency — measuring attack from the buffer origin would just be measuring
  // that constant.
  let onsetMs = 0;
  for (let i = 0; i < n; i++) {
    const v = ch2 ? Math.max(Math.abs(ch[i]), Math.abs(ch2[i])) : Math.abs(ch[i]);
    if (v >= peak * 0.01) { onsetMs = i / sr * 1000; break; }
  }

  const tailStart = Math.min(0.15, buffer.duration * 0.5);
  return {
    sampleRate: sr,
    peak,
    peakDb: 20 * Math.log10(Math.max(peak, 1e-9)),
    rms,
    rmsDb: 20 * Math.log10(Math.max(rms, 1e-9)),
    crest: peak / Math.max(rms, 1e-9),
    peakTimeMs: peakIdx / sr * 1000,
    onsetMs,
    peakFromOnsetMs: peakIdx / sr * 1000 - onsetMs,
    attackFromOnsetMs: attackMs - onsetMs,
    attackMs,
    decay20Ms,
    audibleMs,
    centroidHz: spectralCentroid(buffer, 0, buffer.duration),
    tailCentroidHz: spectralCentroid(buffer, tailStart, buffer.duration),
    clipped: peak > 0.999,
  };
}

/** Render + measure in one call. */
export async function analyse(id, o = {}) {
  const buf = await renderSound(id, o);
  const m = measure(buf);
  m.id = id;
  m.distance = o.distance != null ? o.distance : 0;
  m.duration = buf.duration;
  return m;
}

export { ALL_IDS };
export default { renderSound, measure, analyse, envelope, spectrogram, spectralCentroid, ALL_IDS };
