import * as THREE from 'three';
import { PARTICLE_VERT, PARTICLE_FRAG } from './ParticleShader.js';

/**
 * Pooled, GPU-driven particle layers.
 *
 * Each layer is exactly one draw call: an InstancedBufferGeometry over a unit
 * quad with a single interleaved instance buffer. Spawning writes 28 floats
 * and marks a dirty range; after that the particle is entirely the vertex
 * shader's problem. Nothing in `update()` allocates and nothing walks the
 * particle array — the only per-frame CPU work is a handful of uniform writes.
 *
 * Pools are ring buffers with a hard cap, so a pathological event storm
 * recycles the oldest particle instead of growing memory.
 */

export const STRIDE = 28;

/* Shared unit quad. One GPU buffer for every layer. */
const QUAD_POS = new THREE.BufferAttribute(new Float32Array([
  -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
]), 3);
const QUAD_UV = new THREE.BufferAttribute(new Float32Array([
  0, 0, 1, 0, 1, 1, 0, 1,
]), 2);
const QUAD_IDX = new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1);

/**
 * The one and only emit descriptor. Call `begin()` to get it reset, fill the
 * fields you care about, hand it to `emit()`. Reused forever: zero garbage.
 */
const E = {
  x: 0, y: 0, z: 0,
  vx: 0, vy: 0, vz: 0,
  life: 1,
  r0: 1, g0: 1, b0: 1, a0: 1,
  r1: 1, g1: 1, b1: 1, a1: 0,
  size0: 0.2, size1: 0.2,
  roll: 0, spin: 0,
  drag: 0, gravity: 0, stretch: 0, turb: 0,
  frame: 0, seed: 0, planeY: -9999, rest: 0.4,
};

export function begin() {
  E.x = 0; E.y = 0; E.z = 0;
  E.vx = 0; E.vy = 0; E.vz = 0;
  E.life = 1;
  E.r0 = 1; E.g0 = 1; E.b0 = 1; E.a0 = 1;
  E.r1 = 1; E.g1 = 1; E.b1 = 1; E.a1 = 0;
  E.size0 = 0.2; E.size1 = 0.2;
  E.roll = 0; E.spin = 0;
  E.drag = 0; E.gravity = 0; E.stretch = 0; E.turb = 0;
  E.frame = 0; E.seed = 0; E.planeY = -9999; E.rest = 0.4;
  return E;
}

export class ParticleLayer {
  /**
   * @param {string} name
   * @param {number} cap hard particle cap
   * @param {object} opts shader/material configuration
   */
  constructor(name, cap, opts = {}) {
    this.name = name;
    this.cap = Math.max(1, cap | 0);
    this.opts = opts;
    this.data = new Float32Array(this.cap * STRIDE);
    this.head = 0;
    this.used = 0;
    this.maxDeath = -1e9;
    this._dMin = Infinity;
    this._dMax = -Infinity;
    this.mesh = null;
    this.material = null;
    this.geometry = null;
    this.buffer = null;
  }

  build(texture, shared) {
    const o = this.opts;
    const defines = {};
    if (o.stretch) defines.USE_STRETCH = '';
    if (o.bounce) defines.USE_BOUNCE = '';
    if (o.soft) defines.USE_SOFT = '';
    if (o.lit) defines.USE_LIGHT = '';

    const uniforms = {
      uTime: shared.uTime,
      uMap: { value: texture },
      uAtlas: { value: new THREE.Vector2(o.atlas?.[0] ?? 1, o.atlas?.[1] ?? 1) },
      uFadeIn: { value: o.fadeIn ?? 0 },
      uAlphaPow: { value: o.alphaPow ?? 1 },
      uSizeCurve: { value: o.sizeCurve ?? 1 },
      uSizeScale: { value: o.sizeScale ?? 1 },
      uIntensity: { value: o.intensity ?? 1 },
      uNearFade: { value: new THREE.Vector2(o.nearFade?.[0] ?? 0.04, o.nearFade?.[1] ?? 0.22) },
      uWind: shared.uWind,
      uWindGain: { value: o.windGain ?? 0 },
    };
    if (o.soft) {
      uniforms.uDepth = shared.uDepth;
      uniforms.uInvRes = shared.uInvRes;
      uniforms.uNear = shared.uNear;
      uniforms.uFar = shared.uFar;
      uniforms.uSoftness = { value: o.softness ?? 1.0 };
    }
    if (o.lit) {
      uniforms.uSunView = shared.uSunView;
      uniforms.uSunColor = shared.uSunColor;
      uniforms.uAmbColor = shared.uAmbColor;
    }

    this.material = new THREE.ShaderMaterial({
      name: `vfx:${this.name}`,
      defines,
      uniforms,
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(QUAD_IDX);
    geo.setAttribute('position', QUAD_POS);
    geo.setAttribute('uv', QUAD_UV);

    const buf = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    buf.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPos', new THREE.InterleavedBufferAttribute(buf, 4, 0));
    geo.setAttribute('aVel', new THREE.InterleavedBufferAttribute(buf, 4, 4));
    geo.setAttribute('aCol0', new THREE.InterleavedBufferAttribute(buf, 4, 8));
    geo.setAttribute('aCol1', new THREE.InterleavedBufferAttribute(buf, 4, 12));
    geo.setAttribute('aSize', new THREE.InterleavedBufferAttribute(buf, 4, 16));
    geo.setAttribute('aPhys', new THREE.InterleavedBufferAttribute(buf, 4, 20));
    geo.setAttribute('aMisc', new THREE.InterleavedBufferAttribute(buf, 4, 24));
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.buffer = buf;
    this.geometry = geo;
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = o.renderOrder ?? 10;
    this.mesh.name = `vfx:${this.name}`;
    return this.mesh;
  }

  /** Write one particle. `time` is the shared VFX clock. */
  emit(e, time) {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    if (this.used < this.cap) this.used++;

    const o = i * STRIDE;
    const d = this.data;
    d[o] = e.x; d[o + 1] = e.y; d[o + 2] = e.z; d[o + 3] = time;
    d[o + 4] = e.vx; d[o + 5] = e.vy; d[o + 6] = e.vz; d[o + 7] = e.life;
    d[o + 8] = e.r0; d[o + 9] = e.g0; d[o + 10] = e.b0; d[o + 11] = e.a0;
    d[o + 12] = e.r1; d[o + 13] = e.g1; d[o + 14] = e.b1; d[o + 15] = e.a1;
    d[o + 16] = e.size0; d[o + 17] = e.size1; d[o + 18] = e.roll; d[o + 19] = e.spin;
    d[o + 20] = e.drag; d[o + 21] = e.gravity; d[o + 22] = e.stretch; d[o + 23] = e.turb;
    d[o + 24] = e.frame; d[o + 25] = e.seed; d[o + 26] = e.planeY; d[o + 27] = e.rest;

    const death = time + e.life;
    if (death > this.maxDeath) this.maxDeath = death;
    if (o < this._dMin) this._dMin = o;
    if (o + STRIDE > this._dMax) this._dMax = o + STRIDE;
  }

  /** Upload dirty ranges and set the instance count. No allocation. */
  flush(time) {
    if (time > this.maxDeath) {
      // Everything expired — rewind the ring so the next burst draws from 0.
      this.head = 0;
      this.used = 0;
      this.geometry.instanceCount = 0;
    } else {
      this.geometry.instanceCount = this.used;
    }
    if (this._dMax > this._dMin) {
      this.buffer.clearUpdateRanges();
      this.buffer.addUpdateRange(this._dMin, this._dMax - this._dMin);
      this.buffer.needsUpdate = true;
      this._dMin = Infinity;
      this._dMax = -Infinity;
    }
  }

  clear() {
    this.head = 0;
    this.used = 0;
    this.maxDeath = -1e9;
    this.geometry.instanceCount = 0;
  }

  dispose() {
    this.geometry?.dispose();
    this.material?.dispose();
  }
}

/* -------------------------------------------------------------------------- */

/** Owns every layer, the shared uniforms, and the root render group. */
export class ParticleEngine {
  constructor() {
    this.layers = new Map();
    this.group = new THREE.Group();
    this.group.name = 'vfx:particles';
    this.group.matrixAutoUpdate = false;
    this.shared = {
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector3() },
      uDepth: { value: null },
      uInvRes: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
      uNear: { value: 0.1 },
      uFar: { value: 1000 },
      uSunView: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1.4, 1.2, 0.95) },
      uAmbColor: { value: new THREE.Color(0.26, 0.32, 0.43) },
    };
  }

  add(name, cap, opts, texture) {
    const layer = new ParticleLayer(name, cap, opts);
    this.group.add(layer.build(texture, this.shared));
    this.layers.set(name, layer);
    return layer;
  }

  get(name) { return this.layers.get(name); }

  emit(name, e, time) {
    const l = this.layers.get(name);
    if (l) l.emit(e, time);
  }

  flush(time) {
    this.shared.uTime.value = time;
    for (const l of this.layers.values()) l.flush(time);
  }

  clear() { for (const l of this.layers.values()) l.clear(); }

  dispose() {
    for (const l of this.layers.values()) l.dispose();
    this.layers.clear();
    this.group.parent?.remove(this.group);
  }
}

export default ParticleEngine;
