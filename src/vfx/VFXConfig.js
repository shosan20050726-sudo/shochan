import CFG from '../core/Config.js';

/**
 * Every tuning number the VFX system uses, read defensively out of
 * `CFG.vfx` so the lead can fold the block into Config.js verbatim without
 * this module ever breaking when a key is missing.
 */
const V = CFG.vfx ?? {};
const p = (v, d) => (v === undefined || v === null ? d : v);

export const VCFG = {
  seed: p(V.seed, 0x5F1E),

  /** Half-res colour+depth prepass that feeds soft particles + refraction. */
  prepass: {
    enabled: p(V.prepass?.enabled, true),
    scale: p(V.prepass?.scale, 0.5),
  },

  /** Hard caps. Pools are ring buffers: the oldest particle is recycled. */
  caps: {
    spark: p(V.caps?.spark, 1500),
    glow: p(V.caps?.glow, 800),
    flash: p(V.caps?.flash, 180),
    smoke: p(V.caps?.smoke, 520),
    debris: p(V.caps?.debris, 640),
    shard: p(V.caps?.shard, 260),
    blood: p(V.caps?.blood, 460),
    tracer: p(V.caps?.tracer, 96),
    decal: p(V.caps?.decal, 192),
    motes: p(V.caps?.motes, 640),
    lights: p(V.caps?.lights, 3),
    shafts: p(V.caps?.shafts, 6),
    shock: p(V.caps?.shock, 5),
    haze: p(V.caps?.haze, 8),
  },

  /** Global wind, used by smoke drift and the dust-mote field. */
  wind: {
    x: p(V.wind?.x, 0.72),
    y: p(V.wind?.y, 0.10),
    z: p(V.wind?.z, -0.34),
  },

  muzzle: {
    flashLife: p(V.muzzle?.flashLife, 0.048),   // ~3 frames at 60Hz
    flashSize: p(V.muzzle?.flashSize, 0.46),
    lightIntensity: p(V.muzzle?.lightIntensity, 34),
    lightRange: p(V.muzzle?.lightRange, 13),
    smokePuffs: p(V.muzzle?.smokePuffs, 4),
    sparks: p(V.muzzle?.sparks, 7),
    tracerEvery: p(V.muzzle?.tracerEvery, 3),
  },

  tracer: {
    speed: p(V.tracer?.speed, 205),
    maxDist: p(V.tracer?.maxDist, 260),
    width: p(V.tracer?.width, 0.055),
    stretch: p(V.tracer?.stretch, 0.0042),      // seconds of travel drawn
    coreColor: p(V.tracer?.coreColor, 0xfff0c8),
    haloColor: p(V.tracer?.haloColor, 0xff8a30),
  },

  decals: {
    life: p(V.decals?.life, 26),
    fadeStart: p(V.decals?.fadeStart, 0.62),
    size: p(V.decals?.size, 0.30),
    offset: p(V.decals?.offset, 0.022),
  },

  smoke: {
    softness: p(V.smoke?.softness, 1.15),
  },

  ring: {
    height: p(V.ring?.height, CFG.ring?.height ?? 260),
    segments: p(V.ring?.segments, 128),
    rings: p(V.ring?.rings, 22),
    // At full opacity the wall behaves like a fog bank: it sits between the
    // camera and the map and flattens the aerial perspective behind it. It
    // should read as an energy curtain you can see the world through.
    opacity: p(V.ring?.opacity, 0.42),
    colorA: p(V.ring?.colorA, 0x4a1a7a),        // deep violet body
    colorB: p(V.ring?.colorB, 0xff37c8),        // hot magenta filaments
    colorC: p(V.ring?.colorC, 0x9ce8ff),        // cyan-white hot core
    nearFade: p(V.ring?.nearFade, 85),          // translucent within this range
    scroll: p(V.ring?.scroll, 0.14),
  },

  atmosphere: {
    motes: p(V.atmosphere?.motes, true),
    moteBox: p(V.atmosphere?.moteBox, 34),
    moteSize: p(V.atmosphere?.moteSize, 0.017),
    shafts: p(V.atmosphere?.shafts, true),
    shaftSpacing: p(V.atmosphere?.shaftSpacing, 46),
    shaftIntensity: p(V.atmosphere?.shaftIntensity, 0.5),
    haze: p(V.atmosphere?.haze, true),
    hazeStrength: p(V.atmosphere?.hazeStrength, 0.0075),
  },

  /** Fallback lighting for particles when postfx/sky is not loaded. */
  light: {
    sunColor: p(V.light?.sunColor, [1.45, 1.24, 0.98]),
    ambColor: p(V.light?.ambColor, [0.26, 0.32, 0.43]),
    sunDir: p(V.light?.sunDir, [0.42, 0.62, 0.66]),
  },
};

export default VCFG;
