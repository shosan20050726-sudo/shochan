import * as THREE from 'three';
import { EV } from '../core/EventBus.js';
import { makeRNG } from '../core/Rand.js';
import VCFG from './VFXConfig.js';
import { ParticleEngine } from './ParticleSystem.js';
import buildVFXTextures from './ProcTextures.js';
import DecalPool from './Decals.js';
import RingWall from './RingWall.js';
import { DustMotes } from './Atmosphere.js';

/**
 * Combat and atmosphere effects.
 *
 * Every particle lives in a GPU-side ring buffer: emitting writes 28 floats
 * into an instanced attribute and the shader integrates position, colour and
 * size from birth time, so nothing is stepped on the CPU per frame and a burst
 * costs one buffer upload rather than thousands of object updates.
 *
 * Impact recipes are keyed on the surface reported by the collision hit, so
 * concrete puffs dust and chips while metal throws a bright ricochet spark
 * shower and glass throws shards.
 */

const _v = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _bitan = new THREE.Vector3();

/** Scratch emit record — reused so emitting never allocates. */
const E = {
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1,
  r0: 1, g0: 1, b0: 1, a0: 1, r1: 1, g1: 1, b1: 1, a1: 0,
  size0: 0.1, size1: 0.2, roll: 0, spin: 0,
  drag: 1.4, gravity: 0, stretch: 0, turb: 0,
  frame: 0, seed: 0, planeY: -9999, rest: 0,
};

function reset() {
  E.vx = E.vy = E.vz = 0; E.life = 1;
  E.r0 = E.g0 = E.b0 = E.a0 = 1;
  E.r1 = E.g1 = E.b1 = 1; E.a1 = 0;
  E.size0 = 0.1; E.size1 = 0.2; E.roll = 0; E.spin = 0;
  E.drag = 1.4; E.gravity = 0; E.stretch = 0; E.turb = 0;
  E.frame = 0; E.seed = 0; E.planeY = -9999; E.rest = 0;
  return E;
}

/**
 * Per-surface impact character. Colours are linear-ish HDR: sparks go above 1
 * so they bloom, dust stays below.
 */
const SURFACE_FX = {
  concrete: { dust: [0.74, 0.70, 0.64], sparks: 0,  chips: 10, dustAmt: 14, size: 0.34 },
  metal:    { dust: [0.55, 0.55, 0.58], sparks: 26, chips: 4,  dustAmt: 4,  size: 0.16 },
  rock:     { dust: [0.62, 0.58, 0.52], sparks: 0,  chips: 12, dustAmt: 12, size: 0.32 },
  sand:     { dust: [0.86, 0.76, 0.56], sparks: 0,  chips: 2,  dustAmt: 22, size: 0.46 },
  wood:     { dust: [0.52, 0.38, 0.24], sparks: 0,  chips: 14, dustAmt: 7,  size: 0.24 },
  glass:    { dust: [0.80, 0.90, 0.95], sparks: 6,  chips: 18, dustAmt: 3,  size: 0.18 },
  grass:    { dust: [0.42, 0.50, 0.28], sparks: 0,  chips: 8,  dustAmt: 9,  size: 0.26 },
  water:    { dust: [0.70, 0.82, 0.90], sparks: 0,  chips: 6,  dustAmt: 16, size: 0.34 },
  flesh:    { dust: [0.42, 0.06, 0.06], sparks: 0,  chips: 6,  dustAmt: 10, size: 0.20 },
  default:  { dust: [0.70, 0.68, 0.64], sparks: 2,  chips: 8,  dustAmt: 12, size: 0.30 },
};

export default class VFXSystem {
  name = 'vfx';
  priority = 60;

  constructor() {
    this.engine = new ParticleEngine();
    this.rng = makeRNG(VCFG.seed);
    this.time = 0;
    this.textures = null;
    this.decals = null;
    this.ring = null;
    this.motes = null;
    this._unsub = [];
  }

  async init(ctx) {
    this.ctx = ctx;
    const { scene, bus } = ctx;

    this.textures = buildVFXTextures(VCFG.seed);
    const tex = this.textures;
    const caps = VCFG.caps;

    // The dust-mote shader takes the sun in WORLD space for its forward-scatter
    // term, while the particle engine only publishes the view-space direction.
    // Without this the uniform resolves to undefined, and three throws while
    // uploading it -- which aborts the whole world render, not just the motes.
    this.engine.shared.uSunWorld = { value: new THREE.Vector3(0.42, 0.78, 0.32).normalize() };

    // Additive layers read as hot light; smoke is alpha-blended and soft so it
    // does not cut a hard line where it intersects geometry.
    this.engine.add('spark', caps.spark,
      { additive: true, soft: false, stretch: 1, sizeScale: 1, intensity: 3.2 }, tex.streak);
    this.engine.add('glow', caps.glow,
      { additive: true, soft: true, softness: 0.4, intensity: 2.4 }, tex.glow);
    this.engine.add('smoke', caps.smoke,
      { additive: false, soft: true, softness: 1.1, atlas: [4, 2], windGain: 1, alphaPow: 1.2 }, tex.smoke);
    this.engine.add('debris', caps.debris,
      { additive: false, soft: false, atlas: [4, 2], bounce: 0.3 }, tex.chip);
    this.engine.add('shard', caps.shard,
      { additive: false, soft: false, atlas: [4, 2] }, tex.shard);
    this.engine.add('tracer', caps.tracer,
      { additive: true, soft: false, stretch: 1, intensity: 4.0 }, tex.streak);

    // Debug hook so a bad component can be bisected without a rebuild:
    //   window.__VFX_DISABLE = 'ring,motes,decals'
    const off = String(globalThis.__VFX_DISABLE || '').split(',').map((s) => s.trim());
    const enabled = (n) => !off.includes(n);

    if (enabled('particles')) scene.add(this.engine.group);

    if (enabled('decals')) {
      this.decals = new DecalPool(caps.decal);
      const decalMesh = this.decals.build?.(tex.decal, this.engine.shared.uTime);
      if (decalMesh) scene.add(decalMesh);
    }

    if (enabled('motes')) {
      this.motes = new DustMotes(caps.motes, VCFG.seed ^ 0x2B);
      const moteMesh = this.motes.build?.(tex.glow, this.engine.shared);
      if (moteMesh) scene.add(moteMesh);
    }

    // Built lazily on the first stage event: the ring only exists once a match
    // is closing, so there is no reason for it to sit in the scene before then.
    this._ringEnabled = enabled('ring');

    const on = (type, fn) => this._unsub.push(bus.on(type, fn));
    on(EV.IMPACT, (e) => this.impact(e));
    on(EV.SHOT_FIRED, (e) => this.muzzle(e));
    on('vfx:tracer', (e) => this.tracer(e));
    on(EV.ENTITY_KILLED, (e) => this.impact({ ...e, surface: 'flesh', scale: 2.2 }));
    on(EV.RING_STAGE, (e) => this._onRingStage(e));
  }

  /** Build the ring wall on demand, the first time a stage is announced. */
  _onRingStage(e) {
    if (!this._ringEnabled) return;
    // The HUD demo synthesises match events so the interface can be
    // screenshotted populated. Those are UI fixtures, not a running match --
    // staging a kilometre-wide wall in the world off the back of them put a
    // translucent slab across every review frame.
    if (e?.demo) return;
    if (!this.ring) {
      this.ring = new RingWall();
      const mesh = this.ring.build?.(this.engine.shared);
      if (mesh) this.ctx.scene.add(mesh);
    }
    this.ring.setStage?.(e);
  }

  /* ------------------------------------------------------------ effects -- */

  impact({ point, normal, surface, scale = 1 }) {
    if (!point) return;
    const fx = SURFACE_FX[surface] || SURFACE_FX.default;
    const t = this.time;
    const rng = this.rng;

    // Build a basis on the surface so ejecta spray outward around the normal.
    _v.copy(normal || { x: 0, y: 1, z: 0 });
    _tangent.set(_v.y, -_v.x, 0);
    if (_tangent.lengthSq() < 1e-4) _tangent.set(1, 0, 0);
    _tangent.normalize();
    _bitan.crossVectors(_v, _tangent);

    const spray = (spd, spreadAmt) => {
      const a = rng() * Math.PI * 2;
      const r = rng() * spreadAmt;
      const nx = _v.x + (_tangent.x * Math.cos(a) + _bitan.x * Math.sin(a)) * r;
      const ny = _v.y + (_tangent.y * Math.cos(a) + _bitan.y * Math.sin(a)) * r;
      const nz = _v.z + (_tangent.z * Math.cos(a) + _bitan.z * Math.sin(a)) * r;
      const l = Math.hypot(nx, ny, nz) || 1;
      return [nx / l * spd, ny / l * spd, nz / l * spd];
    };

    // --- dust / smoke puff ------------------------------------------------
    for (let i = 0; i < fx.dustAmt * scale; i++) {
      const e = reset();
      e.x = point.x; e.y = point.y; e.z = point.z;
      const [vx, vy, vz] = spray(0.8 + rng() * 1.9, 1.15);
      e.vx = vx; e.vy = vy + 0.5; e.vz = vz;
      e.life = 0.55 + rng() * 0.9;
      e.r0 = fx.dust[0]; e.g0 = fx.dust[1]; e.b0 = fx.dust[2]; e.a0 = 0.5;
      e.r1 = fx.dust[0]; e.g1 = fx.dust[1]; e.b1 = fx.dust[2]; e.a1 = 0;
      e.size0 = fx.size * (0.5 + rng() * 0.6) * scale;
      e.size1 = e.size0 * (2.6 + rng() * 1.8);
      e.drag = 2.4; e.gravity = -0.6; e.turb = 0.35;
      e.roll = rng() * 6.283; e.spin = (rng() - 0.5) * 1.4;
      e.frame = Math.floor(rng() * 8); e.seed = rng();
      this.engine.emit('smoke', e, t);
    }

    // --- sparks (metal / glass) -------------------------------------------
    for (let i = 0; i < fx.sparks * scale; i++) {
      const e = reset();
      e.x = point.x; e.y = point.y; e.z = point.z;
      const [vx, vy, vz] = spray(5 + rng() * 12, 0.85);
      e.vx = vx; e.vy = vy; e.vz = vz;
      e.life = 0.18 + rng() * 0.45;
      e.r0 = 4.2; e.g0 = 2.1; e.b0 = 0.7; e.a0 = 1;
      e.r1 = 1.6; e.g1 = 0.35; e.b1 = 0.08; e.a1 = 0;
      e.size0 = 0.026 + rng() * 0.02; e.size1 = e.size0 * 0.35;
      e.drag = 1.1; e.gravity = -9.2; e.stretch = 0.09;
      e.rest = 0.25; e.seed = rng();
      this.engine.emit('spark', e, t);
    }

    // --- solid ejecta ------------------------------------------------------
    const chipLayer = surface === 'glass' ? 'shard' : 'debris';
    for (let i = 0; i < fx.chips * scale; i++) {
      const e = reset();
      e.x = point.x; e.y = point.y; e.z = point.z;
      const [vx, vy, vz] = spray(2.2 + rng() * 5.5, 0.95);
      e.vx = vx; e.vy = vy + 1.2; e.vz = vz;
      e.life = 0.7 + rng() * 1.1;
      e.r0 = fx.dust[0] * 0.85; e.g0 = fx.dust[1] * 0.85; e.b0 = fx.dust[2] * 0.85; e.a0 = 1;
      e.r1 = e.r0; e.g1 = e.g0; e.b1 = e.b0; e.a1 = 0;
      e.size0 = 0.024 + rng() * 0.05; e.size1 = e.size0;
      e.drag = 0.5; e.gravity = -11.5;
      e.roll = rng() * 6.283; e.spin = (rng() - 0.5) * 14;
      e.frame = Math.floor(rng() * 8); e.seed = rng();
      this.engine.emit(chipLayer, e, t);
    }

    // --- a brief hot flash at the point of contact -------------------------
    if (fx.sparks > 0) {
      const e = reset();
      e.x = point.x; e.y = point.y; e.z = point.z;
      e.life = 0.07;
      e.r0 = 5; e.g0 = 3.2; e.b0 = 1.4; e.a0 = 1;
      e.r1 = 2; e.g1 = 0.8; e.b1 = 0.2; e.a1 = 0;
      e.size0 = 0.32 * scale; e.size1 = 0.05;
      e.seed = rng();
      this.engine.emit('glow', e, t);
    }

    this.decals?.spawn?.(point, normal, 0.16 + this.rng() * 0.16,
      Math.floor(this.rng() * 8), 18, 12, this.rng() * 6.283, null, 0.85, 0.012, t);
  }

  muzzle({ origin, dir }) {
    if (!origin || !dir) return;
    const t = this.time, rng = this.rng;
    // Smoke leaves the barrel and keeps travelling; it should not appear glued
    // to the muzzle, so it inherits a slice of the bullet's direction.
    for (let i = 0; i < 5; i++) {
      const e = reset();
      e.x = origin.x + dir.x * 0.5; e.y = origin.y + dir.y * 0.5; e.z = origin.z + dir.z * 0.5;
      e.vx = dir.x * (1.6 + rng()) + (rng() - 0.5) * 0.6;
      e.vy = dir.y * (1.6 + rng()) + rng() * 0.5;
      e.vz = dir.z * (1.6 + rng()) + (rng() - 0.5) * 0.6;
      e.life = 0.45 + rng() * 0.6;
      e.r0 = 0.72; e.g0 = 0.70; e.b0 = 0.68; e.a0 = 0.20;
      e.r1 = 0.6; e.g1 = 0.6; e.b1 = 0.6; e.a1 = 0;
      e.size0 = 0.07; e.size1 = 0.5 + rng() * 0.4;
      e.drag = 2.8; e.gravity = 0.35; e.turb = 0.5;
      e.roll = rng() * 6.283; e.spin = (rng() - 0.5) * 1.1;
      e.frame = Math.floor(rng() * 8); e.seed = rng();
      this.engine.emit('smoke', e, t);
    }
  }

  tracer({ origin, end, speed = 900 }) {
    if (!origin || !end) return;
    _v.subVectors(end, origin);
    const dist = _v.length();
    if (dist < 0.5) return;
    _v.divideScalar(dist);

    const e = reset();
    e.x = origin.x; e.y = origin.y; e.z = origin.z;
    e.vx = _v.x * speed; e.vy = _v.y * speed; e.vz = _v.z * speed;
    e.life = Math.min(dist / speed, 0.5);
    e.r0 = 3.4; e.g0 = 2.4; e.b0 = 1.1; e.a0 = 1;
    e.r1 = 1.8; e.g1 = 0.9; e.b1 = 0.3; e.a1 = 0.2;
    e.size0 = 0.05; e.size1 = 0.03;
    e.drag = 0; e.gravity = 0; e.stretch = 0.55;
    e.seed = this.rng();
    this.engine.emit('tracer', e, this.time);
  }

  /* ------------------------------------------------------------- update -- */

  update(dt, alpha, ctx) {
    this.time += dt;
    const shared = this.engine.shared;
    shared.uWind.value.set(VCFG.wind.x, VCFG.wind.y ?? 0, VCFG.wind.z ?? 0);

    const cam = ctx.camera;
    shared.uNear.value = cam.near;
    shared.uFar.value = cam.far;

    // Keep the atmosphere lit by the sun the sky is actually drawing.
    const sunDir = ctx.engine.get('postfx')?.sky?.sunDirection;
    if (sunDir) {
      shared.uSunWorld.value.copy(sunDir);
      shared.uSunView.value.copy(sunDir).transformDirection(cam.matrixWorldInverse);
    }

    const player = ctx.engine.get('player');
    if (player && this.ring) {
      this.ring.update?.(dt, cam, false);
    }
    this.decals?.flush?.(this.time);
    this.engine.flush(this.time);
  }

  /** Fire one of everything near the camera, for the screenshot harness. */
  debugPresent() {
    const cam = this.ctx?.camera;
    if (!cam) return;
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    const base = cam.position.clone().addScaledVector(fwd, 4);
    const surfaces = ['metal', 'concrete', 'sand', 'glass', 'wood'];
    for (let i = 0; i < surfaces.length; i++) {
      const p = base.clone();
      p.x += (i - 2) * 1.1;
      this.impact({ point: p, normal: new THREE.Vector3(0, 1, 0), surface: surfaces[i], scale: 1.4 });
    }
    this.tracer({
      origin: cam.position.clone().addScaledVector(fwd, 0.6),
      end: base.clone().addScaledVector(fwd, 30),
    });
  }

  dispose() {
    for (const off of this._unsub) off();
    this.engine.dispose();
    this.textures?.dispose?.();
    this.decals?.dispose?.();
    this.ring?.dispose?.();
  }
}
