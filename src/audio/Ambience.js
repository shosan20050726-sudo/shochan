/**
 * The always-on beds: wind, distant world rumble, and the ring/zone.
 *
 * Three wind layers with independent filters and two slow, mutually prime
 * gust LFOs. Because the LFO periods (14.3 s and 7.7 s) never line up, the
 * bed does not audibly repeat. Height opens the wind up (more high band, wider
 * gusts) and speed adds a rush that tracks the player's velocity — which is
 * what makes sprinting and sliding feel fast without touching the music.
 *
 * Everything lives on the ambience bus, which sits behind the ducker, so
 * gunfire automatically pushes it out of the way.
 */
import { noiseBuffer } from './Buffers.js';
import { clamp } from './Synth.js';

const SMOOTH = 0.35;      // setTargetAtTime time constant for level changes

export default class Ambience {
  /**
   * @param {BaseAudioContext} ac
   * @param {AudioNode} dest ambience bus
   */
  constructor(ac, dest, cfg = {}) {
    this.ac = ac;
    this.dest = dest;
    this.cfg = cfg;
    this.started = false;
    this.nodes = [];
    this.sources = [];
    this._height = 0;
    this._speed = 0;
    this._ring = 0;
    this._indoor = 0;
  }

  _noise(kind, rate = 1) {
    const s = this.ac.createBufferSource();
    s.buffer = noiseBuffer(this.ac, kind);
    s.loop = true;
    s.playbackRate.value = rate;
    this.sources.push(s);
    this.nodes.push(s);
    return s;
  }

  _gain(v = 0) { const g = this.ac.createGain(); g.gain.value = v; this.nodes.push(g); return g; }

  _filter(type, f, q = 1) {
    const b = this.ac.createBiquadFilter();
    b.type = type; b.frequency.value = f; b.Q.value = q;
    this.nodes.push(b);
    return b;
  }

  _osc(type, f) {
    const o = this.ac.createOscillator();
    o.type = type; o.frequency.value = f;
    this.sources.push(o); this.nodes.push(o);
    return o;
  }

  start() {
    if (this.started || !this.ac || !this.dest) return;
    const ac = this.ac;
    const t = ac.currentTime;

    this.busGain = this._gain(1);
    this.busGain.connect(this.dest);

    // ---- layer 1: low rumble. Always there, the floor of the world. ----
    const lowSrc = this._noise('brown', 0.85);
    this.lowLP = this._filter('lowpass', 150, 0.7);
    this.lowGain = this._gain(0.30);
    lowSrc.connect(this.lowLP); this.lowLP.connect(this.lowGain);
    this.lowGain.connect(this.busGain);

    // ---- layer 2: mid wind. The body. Bandpass centre moves with gusts. ----
    const midSrc = this._noise('pink', 1);
    this.midBP = this._filter('bandpass', 520, 0.75);
    this.midGain = this._gain(0.16);
    midSrc.connect(this.midBP); this.midBP.connect(this.midGain);
    this.midGain.connect(this.busGain);

    // ---- layer 3: high whistle. Only when high up or moving fast. ----
    const hiSrc = this._noise('white', 1);
    this.hiHP = this._filter('highpass', 2600, 0.6);
    this.hiBP = this._filter('bandpass', 4200, 1.4);
    this.hiGain = this._gain(0.0);
    hiSrc.connect(this.hiHP); this.hiHP.connect(this.hiBP);
    this.hiBP.connect(this.hiGain); this.hiGain.connect(this.busGain);

    // ---- gusts: two slow LFOs on the mid/high gains and the mid filter ----
    this.gustA = this._osc('sine', 1 / 14.3);
    this.gustB = this._osc('sine', 1 / 7.7);
    const gA = this._gain(0.075);
    const gB = this._gain(0.045);
    this.gustA.connect(gA); gA.connect(this.midGain.gain);
    this.gustB.connect(gB); gB.connect(this.hiGain.gain);
    const fA = this._gain(210);
    this.gustA.connect(fA); fA.connect(this.midBP.frequency);
    this.gustGainA = gA;
    this.gustGainB = gB;

    // ---- ring / zone: electric crackle plus a rising drone ----
    this.ringGain = this._gain(0.0);
    this.ringGain.connect(this.busGain);
    const ringSrc = this._noise('white', 1);
    this.ringBP = this._filter('bandpass', 1500, 2.2);
    const ringShape = this._gain(0.5);
    ringSrc.connect(this.ringBP); this.ringBP.connect(ringShape);
    ringShape.connect(this.ringGain);
    // Gate the crackle with a fast irregular LFO so it sputters.
    this.crackleLfo = this._osc('sawtooth', 7.3);
    const cg = this._gain(0.45);
    this.crackleLfo.connect(cg); cg.connect(ringShape.gain);
    // Drone.
    this.ringDrone = this._osc('sawtooth', 58);
    const droneLP = this._filter('lowpass', 320, 3);
    const droneGain = this._gain(0.22);
    this.ringDrone.connect(droneLP); droneLP.connect(droneGain);
    droneGain.connect(this.ringGain);
    this.ringDroneGain = droneGain;

    for (const s of this.sources) { try { s.start(t); } catch (e) { /* noop */ } }
    this.started = true;
    this.setLevels(0, 0, 0, 0);
  }

  /**
   * @param {number} height metres above the reference ground plane
   * @param {number} speed  m/s
   * @param {number} ring   0..1 proximity to the closing ring
   * @param {number} indoor 0..1 how enclosed the listener is
   */
  setLevels(height, speed, ring = 0, indoor = 0) {
    if (!this.started) return;
    const ac = this.ac;
    const t = ac.currentTime;
    const h = clamp((height - 1.5) / 55, 0, 1);
    const v = clamp(speed / 13, 0, 1.25);
    const ins = clamp(indoor, 0, 1);
    this._height = h; this._speed = v; this._ring = ring; this._indoor = ins;

    const base = this.cfg.windGain ?? 1;
    const set = (p, val) => { try { p.setTargetAtTime(val, t, SMOOTH); } catch (e) { /* noop */ } };
    const snap = (p, val) => { try { p.setTargetAtTime(val, t, 0.12); } catch (e) { /* noop */ } };

    // Indoors the wind collapses to a low hum; outdoors and high up it opens.
    set(this.lowGain.gain, base * (0.26 + 0.20 * h + 0.10 * v) * (1 - 0.35 * ins));
    set(this.midGain.gain, base * (0.10 + 0.22 * h + 0.20 * v) * (1 - 0.72 * ins));
    set(this.hiGain.gain, base * (0.012 + 0.085 * h * h + 0.13 * v * v) * (1 - 0.85 * ins));

    // Faster / higher => brighter and wider gusts.
    snap(this.midBP.frequency, 420 + 520 * h + 380 * v);
    snap(this.hiBP.frequency, 3400 + 2400 * h + 1800 * v);
    snap(this.lowLP.frequency, 120 + 90 * v);
    try {
      this.gustGainA.gain.setTargetAtTime(0.05 + 0.09 * h, t, SMOOTH);
      this.gustGainB.gain.setTargetAtTime(0.02 + 0.06 * h, t, SMOOTH);
    } catch (e) { /* noop */ }

    // Ring.
    const r = clamp(ring, 0, 1);
    set(this.ringGain.gain, r * r * 0.55);
    snap(this.ringBP.frequency, 900 + 2600 * r);
    try { this.ringDrone.frequency.setTargetAtTime(46 + 40 * r, t, 0.6); } catch (e) { /* noop */ }
  }

  /** Momentary swell, e.g. when a ring stage begins. */
  gust(strength = 1, duration = 1.6) {
    if (!this.started) return;
    const t = this.ac.currentTime;
    try {
      const p = this.midGain.gain;
      const cur = p.value;
      p.cancelScheduledValues(t);
      p.setValueAtTime(cur, t);
      p.linearRampToValueAtTime(cur + 0.22 * strength, t + duration * 0.25);
      p.setTargetAtTime(cur, t + duration * 0.3, duration * 0.5);
    } catch (e) { /* noop */ }
  }

  stop() {
    for (const s of this.sources) { try { s.stop(); } catch (e) { /* noop */ } }
    for (const n of this.nodes) { try { n.disconnect(); } catch (e) { /* noop */ } }
    this.sources.length = 0;
    this.nodes.length = 0;
    this.started = false;
  }
}
