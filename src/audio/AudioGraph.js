/**
 * The mixer, the reverb, the spatialiser and the voice allocator.
 *
 * Deliberately written against BaseAudioContext rather than AudioContext, so
 * the identical graph can be instantiated on an OfflineAudioContext for
 * numerical verification. Whatever is measured offline is literally what the
 * game plays.
 *
 * Signal flow
 * -----------
 *   voice head ──▶ air-absorption LP ──▶ HF shelf ──┬──▶ HRTF panner ──▶ sfxBus
 *                                                    ├──▶ tail send  ──▶ tailBus
 *                                                    └──▶ early send ──▶ earlyBus
 *
 *   tailBus  ──▶ convolver(env IR)   ──▶ tailReturn  ──▶ sfxBus
 *   earlyBus ──▶ convolver(tight IR) ──▶ earlyReturn ──▶ sfxBus
 *
 *   sfxBus ┐
 *   uiBus  ├──▶ master ──▶ compressor/limiter ──▶ soft clip ──▶ destination
 *   ambienceBus ──▶ duck ─┘
 *   musicBus    ──▶ duck ─┘
 *
 * The two things that make this sound expensive rather than cheap:
 *  1. the tail send *rises* with distance while the dry path falls, so far
 *     gunfire is mostly room and almost no crack;
 *  2. everything shares one limiter, so twelve overlapping shots compress into
 *     a wall instead of clipping into fizz.
 */
import { makeRNG } from '../core/Rand.js';
import { impulseResponse, prewarm } from './Buffers.js';
import { satCurve, clamp } from './Synth.js';
import { resolve as resolveSound } from './SoundBank.js';

const SPEED_OF_SOUND = 343;

export default class AudioGraph {
  /**
   * @param {BaseAudioContext} ac
   * @param {object} cfg CFG.audio slice (read defensively)
   * @param {{live?:boolean, seed?:number, environment?:string}} opts
   */
  constructor(ac, cfg = {}, opts = {}) {
    this.ac = ac;
    this.cfg = cfg || {};
    this.live = opts.live !== false;
    this.seed = (opts.seed ?? 0xA9EC) >>> 0;
    this.rng = makeRNG(this.seed);
    this.environment = opts.environment || 'outdoor';

    this.masterGain = this.cfg.masterGain ?? 0.65;
    this.sfxGain = this.cfg.sfxGain ?? 0.9;
    this.musicGain = this.cfg.musicGain ?? 0.35;
    this.rolloff = this.cfg.rolloff ?? 1.6;
    this.refDistance = this.cfg.refDistance ?? 6;
    this.maxDistance = this.cfg.maxDistance ?? 420;
    this.maxVoices = this.cfg.maxVoices ?? 42;

    this.voices = [];
    this.listener = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0 };

    this._build();
  }

  /* ------------------------------------------------------------------ graph */

  _build() {
    const ac = this.ac;

    this.out = ac.createGain();
    this.out.gain.value = 1;

    // Limiter. Fast attack, musical release; the soft clipper behind it is the
    // guarantee that nothing ever leaves this graph above 1.0.
    this.comp = ac.createDynamicsCompressor();
    this.comp.threshold.value = -9;
    this.comp.knee.value = 6;
    this.comp.ratio.value = 9;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.16;

    this.clip = ac.createWaveShaper();
    this.clip.curve = satCurve(ac, 1.25);
    // See Synth.nShaper: oversampling here would add 2.7 ms to every sound in
    // the game for no audible benefit on a near-linear tanh.
    this.clip.oversample = 'none';

    this.master = ac.createGain();
    this.master.gain.value = this.masterGain;

    this.master.connect(this.comp);
    this.comp.connect(this.clip);
    this.clip.connect(this.out);
    this.out.connect(ac.destination);

    // Buses.
    this.sfxBus = ac.createGain();
    this.sfxBus.gain.value = this.sfxGain;
    this.sfxBus.connect(this.master);

    this.uiBus = ac.createGain();
    this.uiBus.gain.value = (this.cfg.uiGain ?? 0.85);
    this.uiBus.connect(this.master);

    // Ambience and music live behind the ducker.
    this.duck = ac.createGain();
    this.duck.gain.value = 1;
    this.duck.connect(this.master);

    this.ambienceBus = ac.createGain();
    this.ambienceBus.gain.value = (this.cfg.ambienceGain ?? 0.55);
    this.ambienceBus.connect(this.duck);

    this.musicBus = ac.createGain();
    this.musicBus.gain.value = this.musicGain;
    this.musicBus.connect(this.duck);

    // Reverb: two sends. "early" is a tight room that everything gets a little
    // of; "tail" is the environment and is what distance modulates.
    this.earlyBus = ac.createGain();
    this.earlyBus.gain.value = 1;
    this.convEarly = ac.createConvolver();
    this.convEarly.normalize = true;
    this.convEarly.buffer = impulseResponse(ac, 'tight');
    this.earlyReturn = ac.createGain();
    this.earlyReturn.gain.value = this.cfg.earlyReturn ?? 0.55;
    this.earlyBus.connect(this.convEarly);
    this.convEarly.connect(this.earlyReturn);
    this.earlyReturn.connect(this.sfxBus);

    this.tailBus = ac.createGain();
    this.tailBus.gain.value = 1;
    // A short pre-delay on the tail separates the crack from the room, which
    // is most of the perceived "size".
    this.tailPre = ac.createDelay(0.25);
    this.tailPre.delayTime.value = 0.022;
    this.convTail = ac.createConvolver();
    this.convTail.normalize = true;
    this.convTail.buffer = impulseResponse(ac, this.environment);
    this.tailReturn = ac.createGain();
    this.tailReturn.gain.value = this.cfg.tailReturn ?? 1.05;
    // Roll the very top off the tail: real reflections are always darker than
    // the direct sound.
    this.tailTone = ac.createBiquadFilter();
    this.tailTone.type = 'lowpass';
    this.tailTone.frequency.value = 5200;
    this.tailTone.Q.value = 0.6;
    this.tailBus.connect(this.tailPre);
    this.tailPre.connect(this.convTail);
    this.convTail.connect(this.tailTone);
    this.tailTone.connect(this.tailReturn);
    this.tailReturn.connect(this.sfxBus);

    if (this.live) {
      try { prewarm(ac, ['tight', this.environment]); } catch (e) { /* noop */ }
    }
  }

  /** Swap the environment impulse response (indoor / outdoor / canyon / tight). */
  setEnvironment(name) {
    if (!name || name === this.environment) return;
    try {
      const ir = impulseResponse(this.ac, name);
      this.convTail.buffer = ir;
      this.environment = name;
      this.tailTone.frequency.value = name === 'indoor' ? 6200 : name === 'canyon' ? 4200 : 5200;
      this.tailPre.delayTime.value = name === 'canyon' ? 0.035 : name === 'indoor' ? 0.012 : 0.022;
    } catch (e) { /* keep the old IR */ }
  }

  /* -------------------------------------------------------------- listener */

  setListener(px, py, pz, fx, fy, fz, ux, uy, uz) {
    const L = this.listener;
    L.x = px; L.y = py; L.z = pz;
    L.fx = fx; L.fy = fy; L.fz = fz;
    L.ux = ux; L.uy = uy; L.uz = uz;
    const l = this.ac.listener;
    if (!l) return;
    try {
      // Direct .value assignment rather than setValueAtTime: this runs every
      // frame and we do not want to grow an automation queue at 60 Hz.
      if (l.positionX) {
        l.positionX.value = px;
        l.positionY.value = py;
        l.positionZ.value = pz;
        l.forwardX.value = fx;
        l.forwardY.value = fy;
        l.forwardZ.value = fz;
        l.upX.value = ux;
        l.upY.value = uy;
        l.upZ.value = uz;
      } else {
        l.setPosition(px, py, pz);
        l.setOrientation(fx, fy, fz, ux, uy, uz);
      }
    } catch (e) { /* some contexts reject listener writes while suspended */ }
  }

  distanceTo(p) {
    if (!p) return 0;
    const L = this.listener;
    const dx = (p.x ?? p[0] ?? 0) - L.x;
    const dy = (p.y ?? p[1] ?? 0) - L.y;
    const dz = (p.z ?? p[2] ?? 0) - L.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /* ---------------------------------------------------------------- physics */

  /** Inverse distance model, mirroring what the PannerNode does to the dry path. */
  attenuation(d) {
    const ref = this.refDistance;
    const dd = clamp(d, ref, this.maxDistance);
    return ref / (ref + this.rolloff * (dd - ref));
  }

  /**
   * Air absorption. 20 kHz at the muzzle, ~4 kHz at 50 m, ~650 Hz at 200 m.
   * This single filter is most of why a distant gun sounds distant rather than
   * just quiet.
   */
  airCutoff(d) {
    if (d <= 1) return 20000;
    return clamp(20000 / (1 + Math.pow(d / 18, 1.4)), 220, 20000);
  }

  airShelfDb(d) {
    return -clamp(d / 9, 0, 26);
  }

  /* ----------------------------------------------------------------- voices */

  _canAllocate(priority) {
    if (this.voices.length < this.maxVoices) return true;
    // Steal the lowest-priority voice if this one outranks it.
    let worst = -1, worstP = Infinity;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (v.priority < worstP) { worstP = v.priority; worst = i; }
    }
    if (worst >= 0 && worstP < priority) {
      this._kill(this.voices[worst]);
      this.voices.splice(worst, 1);
      return true;
    }
    return false;
  }

  _kill(v) {
    for (const n of v.nodes) { try { n.disconnect(); } catch (e) { /* noop */ } }
    for (const s of v.sources) { try { s.stop(); } catch (e) { /* noop */ } }
    v.nodes.length = 0;
    v.sources.length = 0;
  }

  /**
   * Spawn one voice.
   * opts: { position, distance, gain, when, delay, spatial, bus, propagate, ... }
   * @returns {object|null}
   */
  spawn(id, opts = {}) {
    const entry = resolveSound(id);
    if (!entry || !entry.build) return null;
    const ac = this.ac;

    // A suspended live context does not advance currentTime; scheduling into it
    // would pile up an enormous burst on resume. Silently drop instead.
    if (this.live && ac.state !== 'running') return null;

    // Reap finished voices here as well as in update(): if the frame rate
    // collapses, a purge that only runs once per frame would let the voice list
    // fill up and silence the game exactly when it is already struggling.
    if (this.voices.length) this.update();

    const priority = opts.priority ?? entry.priority ?? 5;
    if (!this._canAllocate(priority)) return null;

    const spatial = opts.spatial != null ? opts.spatial : (entry.spatial && !!opts.position);
    const pos = opts.position;
    let d = opts.distance != null ? opts.distance : (spatial && pos ? this.distanceTo(pos) : 0);
    d = clamp(d, 0, this.maxDistance * 1.5);

    // Beyond audibility, don't build a graph at all.
    if (spatial && d > this.maxDistance) return null;

    const base = this.live ? ac.currentTime + 0.004 : 0;
    let when = opts.when != null ? opts.when : base;
    if (opts.delay) when += opts.delay;
    // Speed of sound. A shot 200 m away arrives ~0.58 s late, and that late
    // arrival is a real gameplay cue.
    if (spatial && opts.propagate !== false) when += Math.min(d / SPEED_OF_SOUND, 1.2);

    const nodes = [];
    const sources = [];
    const head = ac.createGain();
    head.gain.value = 1;
    nodes.push(head);

    try {
      if (spatial) {
        const air = ac.createBiquadFilter();
        air.type = 'lowpass';
        air.frequency.value = this.airCutoff(d);
        air.Q.value = 0.5;
        const shelf = ac.createBiquadFilter();
        shelf.type = 'highshelf';
        shelf.frequency.value = 3800;
        shelf.gain.value = this.airShelfDb(d);
        nodes.push(air, shelf);
        head.connect(air); air.connect(shelf);

        const panner = ac.createPanner();
        try { panner.panningModel = opts.hrtf === false ? 'equalpower' : 'HRTF'; }
        catch (e) { panner.panningModel = 'equalpower'; }
        panner.distanceModel = 'inverse';
        panner.refDistance = this.refDistance;
        panner.rolloffFactor = this.rolloff;
        panner.maxDistance = this.maxDistance;
        const px = pos ? (pos.x ?? pos[0] ?? 0) : this.listener.x;
        const py = pos ? (pos.y ?? pos[1] ?? 0) : this.listener.y;
        const pz = pos ? (pos.z ?? pos[2] ?? 0) : this.listener.z;
        try {
          if (panner.positionX) {
            panner.positionX.value = px;
            panner.positionY.value = py;
            panner.positionZ.value = pz;
          } else { panner.setPosition(px, py, pz); }
        } catch (e) { /* noop */ }
        nodes.push(panner);
        shelf.connect(panner);
        panner.connect(entry.bus === 'ui' ? this.uiBus : this.sfxBus);

        // Reverb sends. `atten^0.55` keeps the tail from exploding at range
        // while the `0.30 + 1.5*near..far` term makes it dominate at distance.
        const at = this.attenuation(d);
        const far = clamp(d / 140, 0, 1);
        const tailAmt = (entry.tail ?? 0.3) * (opts.tail ?? 1)
          * Math.pow(at, 0.55) * (0.30 + 1.55 * far);
        const earlyAmt = (entry.early ?? 0.35) * (opts.early ?? 1)
          * Math.pow(at, 0.85) * (1 - 0.55 * far);
        if (tailAmt > 0.0015) {
          const g = ac.createGain(); g.gain.value = tailAmt;
          nodes.push(g); shelf.connect(g); g.connect(this.tailBus);
        }
        if (earlyAmt > 0.0015) {
          const g = ac.createGain(); g.gain.value = earlyAmt;
          nodes.push(g); shelf.connect(g); g.connect(this.earlyBus);
        }
      } else {
        let tap = head;
        if (opts.pan) {
          try {
            const sp = ac.createStereoPanner();
            sp.pan.value = clamp(opts.pan, -1, 1);
            nodes.push(sp); head.connect(sp); tap = sp;
          } catch (e) { /* noop */ }
        }
        tap.connect(entry.bus === 'ui' ? this.uiBus : this.sfxBus);
        const earlyAmt = (entry.early ?? 0.2) * (opts.early ?? 1);
        if (earlyAmt > 0.0015) {
          const g = ac.createGain(); g.gain.value = earlyAmt;
          nodes.push(g); tap.connect(g); g.connect(this.earlyBus);
        }
        const tailAmt = (entry.tail ?? 0) * (opts.tail ?? 1) * 0.5;
        if (tailAmt > 0.0015) {
          const g = ac.createGain(); g.gain.value = tailAmt;
          nodes.push(g); tap.connect(g); g.connect(this.tailBus);
        }
      }

      // Audio LOD: as the voice list fills and as sources get further away, the
      // decorative layers (receiver ring, extra bolt taps, debris grains) are
      // dropped first. They are inaudible in a firefight anyway, and this is
      // what keeps a 12-player gunfight from costing more than one gunshot.
      const detail = clamp((1 - this.voices.length / this.maxVoices)
        * (spatial ? clamp(1.25 - d / 160, 0.2, 1) : 1), 0, 1);

      const sc = {
        ac, out: head, when, dur: 0, distance: d, detail,
        rng: makeRNG((this.rng() * 0xffffffff) >>> 0),
        nodes, sources, live: this.live, graph: this,
      };
      entry.build(sc, opts);

      const voice = {
        id, priority, nodes, sources,
        endTime: when + Math.max(sc.dur, 0.05) + (spatial ? 0.05 : 0.02),
      };
      this.voices.push(voice);

      // Ducking: gunfire and explosions push the ambience bed out of the way.
      if (entry.duck || opts.duck) {
        this.applyDuck((entry.duck ?? 1) * (opts.duck ?? 1)
          * clamp(this.attenuation(d) * 1.6, 0.12, 1), when);
      }
      return voice;
    } catch (err) {
      for (const n of nodes) { try { n.disconnect(); } catch (e) { /* noop */ } }
      return null;
    }
  }

  /* ---------------------------------------------------------------- ducking */

  /**
   * Scheduled sidechain. A true signal-following sidechain needs an
   * AudioWorklet; a scheduled duck is what shipped games actually use because
   * it is sample-accurate, free, and does not depend on the analysis latency.
   */
  applyDuck(amount = 1, when) {
    const p = this.duck.gain;
    const t = Math.max(when ?? this.ac.currentTime, this.ac.currentTime);
    const depth = clamp(amount, 0, 1) * (this.cfg.duckDepth ?? 0.62);
    const target = clamp(1 - depth, 0.12, 1);
    try {
      if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t);
      else p.cancelScheduledValues(t);
      p.setTargetAtTime(target, t, 0.008);
      p.setTargetAtTime(1, t + (this.cfg.duckHold ?? 0.10), this.cfg.duckRelease ?? 0.22);
    } catch (e) { /* noop */ }
  }

  /* ----------------------------------------------------------------- update */

  /** Purge finished voices. Called once per frame; allocation-free. */
  update() {
    if (!this.voices.length) return;
    const now = this.ac.currentTime;
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.endTime <= now) {
        this._kill(v);
        this.voices.splice(i, 1);
      }
    }
  }

  get voiceCount() { return this.voices.length; }

  /** Stop a voice early (a cancelled reload, an interrupted ability). */
  stop(voice) {
    if (!voice) return;
    const i = this.voices.indexOf(voice);
    if (i >= 0) this.voices.splice(i, 1);
    this._kill(voice);
  }

  dispose() {
    for (const v of this.voices) this._kill(v);
    this.voices.length = 0;
    const all = [this.out, this.comp, this.clip, this.master, this.sfxBus, this.uiBus,
      this.duck, this.ambienceBus, this.musicBus, this.earlyBus, this.convEarly,
      this.earlyReturn, this.tailBus, this.tailPre, this.convTail, this.tailTone,
      this.tailReturn];
    for (const n of all) { try { n?.disconnect(); } catch (e) { /* noop */ } }
  }
}
