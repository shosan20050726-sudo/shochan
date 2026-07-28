import * as THREE from 'three';
import VCFG from './VFXConfig.js';

/**
 * The ring / zone wall — the one silhouette in this game that has to be
 * readable from six hundred metres away.
 *
 * A single open cylinder carries the whole effect. Everything is procedural in
 * the fragment shader, parameterised on the cylinder's own (angle, height) uv
 * so there is no seam and no texture:
 *
 *   - three scrolling fbm octaves at different rates give the body its churn;
 *   - a domain-warped vertical offset drags the pattern into the tall smeared
 *     streaks that read as falling/rising energy rather than moving noise;
 *   - sharp filaments (a thresholded ridge of the same field) are the bright
 *     vertical bolts;
 *   - a fresnel term drives both alpha and hue, so the wall is a solid glowing
 *     slab where it is grazed and near-invisible where you look straight
 *     through it — imposing at distance, translucent when you are stood in it;
 *   - the base glow and the ground contact ring anchor it to the terrain;
 *   - a soft depth-intersection term feathers the wall where it cuts through
 *     buildings instead of leaving a hard geometric slice.
 */

const WALL_VERT = /* glsl */`
uniform float uTime;
uniform float uRadius;
uniform float uWobble;

varying vec2  vUv;
varying vec3  vWorld;
varying vec3  vNormalW;

void main() {
  vUv = uv;
  vec3 n = normalize(vec3(normal.x, 0.0, normal.z));
  // Object-space wobble; the mesh is a unit cylinder scaled to the ring, so
  // divide by the radius to keep the displacement in metres.
  float w = sin(uv.x * 47.0 + uTime * 0.7) * 0.5 + sin(uv.y * 9.0 - uTime * 1.3) * 0.5;
  vec3 p = position + n * (w * uWobble / max(uRadius, 1.0));
  vec4 world = modelMatrix * vec4(p, 1.0);
  vWorld = world.xyz;
  vNormalW = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const WALL_FRAG = /* glsl */`
#include <packing>

uniform float uTime;
uniform float uHeight;
uniform float uRepeat;
uniform vec3  uCamPos;
uniform vec3  uColA;
uniform vec3  uColB;
uniform vec3  uColC;
uniform float uOpacity;
uniform float uNearFade;
uniform float uScroll;
uniform float uPulse;

uniform sampler2D uDepth;
uniform vec2  uInvRes;
uniform float uNear;
uniform float uFar;
uniform float uHasDepth;

varying vec2  vUv;
varying vec3  vWorld;
varying vec3  vNormalW;

float h21(vec2 p, float period) {
  p.x = mod(p.x, period);
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float vnoise(vec2 p, float period) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = h21(i, period);
  float b = h21(i + vec2(1.0, 0.0), period);
  float c = h21(i + vec2(0.0, 1.0), period);
  float d = h21(i + vec2(1.0, 1.0), period);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p, float period) {
  float s = 0.0, a = 0.5, per = period;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p, per);
    p *= 2.0; per *= 2.0; a *= 0.5;
  }
  return s;
}

void main() {
  float t = uTime;
  float h = vUv.y;
  float ax = vUv.x * uRepeat;

  // Vertical domain warp — this is what turns noise into "energy".
  float warp = (fbm(vec2(ax * 0.30, h * 1.6 - t * uScroll * 0.6), uRepeat * 0.30) - 0.5);
  float hw = h + warp * 0.55;

  float body  = fbm(vec2(ax * 0.36, hw * 2.6 - t * uScroll), uRepeat * 0.36);
  float mid   = fbm(vec2(ax * 1.10, hw * 5.5 - t * uScroll * 2.4), uRepeat * 1.10);
  float fine  = fbm(vec2(ax * 3.20, hw * 12.0 - t * uScroll * 5.5), uRepeat * 3.20);

  // Bright vertical bolts: a ridge of the mid field, sharpened hard.
  float ridge = 1.0 - abs(mid * 2.0 - 1.0);
  float bolts = pow(clamp(ridge, 0.0, 1.0), 9.0) * (0.55 + 0.45 * fine);

  // Rising filament sheets.
  float lane = fract(ax * 0.55 + body * 1.6);
  float sheet = pow(1.0 - abs(lane * 2.0 - 1.0), 10.0);
  sheet *= smoothstep(0.0, 0.35, fract(h * 1.3 - t * 0.22 + body));

  float scan = 0.72 + 0.28 * sin(hw * 210.0 - t * 2.3);

  float ground = exp(-h * 8.5);          // hot contact band at the base
  float top    = 1.0 - smoothstep(0.42, 1.0, h);
  float rise   = smoothstep(0.0, 0.10, h);

  vec3 V = uCamPos - vWorld;
  float dist = length(V);
  V /= max(dist, 1e-3);
  float fres = pow(1.0 - abs(dot(normalize(vNormalW), V)), 2.6);

  float density = (0.22 + 0.78 * body) * top;
  float energy = bolts * 1.35 + sheet * 1.15 + ground * 1.9 + mid * 0.25;

  float a = (density * 0.42 + energy * 0.34) * scan * rise;
  a *= (0.26 + 1.55 * fres);
  a *= mix(0.85, 1.30, smoothstep(50.0, 260.0, dist));   // imposing at range
  a *= smoothstep(0.0, uNearFade, dist);                 // translucent up close
  a *= uOpacity * uPulse;

  vec3 col = mix(uColA, uColB, clamp(energy * 0.72 + fres * 0.45, 0.0, 1.0));
  col = mix(col, uColC, clamp(pow(energy, 2.0) * 0.42 + ground * 0.35, 0.0, 1.0));
  col += uColC * (fres * fres * 0.55);
  col *= (0.75 + 0.85 * uPulse);

  if (uHasDepth > 0.5) {
    vec2 suv = gl_FragCoord.xy * uInvRes;
    float dz = texture2D(uDepth, suv).x;
    float sceneDist = -perspectiveDepthToViewZ(dz, uNear, uFar);
    a *= clamp((sceneDist - dist) / 4.5, 0.0, 1.0);
  }

  a = clamp(a, 0.0, 1.0);
  if (a < 0.002) discard;
  gl_FragColor = vec4(col, a);
}
`;

const FLOOR_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const FLOOR_FRAG = /* glsl */`
uniform float uTime;
uniform vec3  uColB;
uniform vec3  uColC;
uniform float uOpacity;
uniform float uPulse;
uniform float uRepeat;
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  // RingGeometry uv.x runs across the band, uv.y around it.
  float band = 1.0 - abs(vUv.x * 2.0 - 1.0);
  float a = pow(band, 2.2);
  float flicker = 0.72 + 0.28 * sin(vUv.y * uRepeat * 2.0 + uTime * 3.1);
  a *= flicker * uOpacity * uPulse;
  vec3 col = mix(uColB, uColC, pow(band, 3.0));
  gl_FragColor = vec4(col * 1.6, clamp(a, 0.0, 1.0));
}
`;

const _c = new THREE.Color();

export default class RingWall {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'vfx:ringwall';
    this.radius = 0;
    this.targetRadius = 0;
    this.stage = 0;
    this.active = false;
    this.pulse = 1;
    this._flash = 0;
  }

  build(shared) {
    const cfg = VCFG.ring;
    const geo = new THREE.CylinderGeometry(1, 1, 1, cfg.segments, cfg.rings, true);

    this.uniforms = {
      uTime: shared.uTime,
      uRadius: { value: 100 },
      uHeight: { value: cfg.height },
      uRepeat: { value: 64 },
      uWobble: { value: 0.9 },
      uCamPos: { value: new THREE.Vector3() },
      uColA: { value: new THREE.Color(cfg.colorA) },
      uColB: { value: new THREE.Color(cfg.colorB) },
      uColC: { value: new THREE.Color(cfg.colorC) },
      uOpacity: { value: cfg.opacity },
      uNearFade: { value: cfg.nearFade },
      uScroll: { value: cfg.scroll },
      uPulse: { value: 1 },
      uDepth: shared.uDepth,
      uInvRes: shared.uInvRes,
      uNear: shared.uNear,
      uFar: shared.uFar,
      uHasDepth: { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      name: 'vfx:ringwall',
      uniforms: this.uniforms,
      vertexShader: WALL_VERT,
      fragmentShader: WALL_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.group.add(this.mesh);

    // Ground contact band so the wall does not look like it is hovering.
    const fgeo = new THREE.RingGeometry(0.94, 1.06, cfg.segments, 1);
    fgeo.rotateX(-Math.PI / 2);
    this.floorUniforms = {
      uTime: shared.uTime,
      uColB: this.uniforms.uColB,
      uColC: this.uniforms.uColC,
      uOpacity: { value: 0.85 },
      uPulse: this.uniforms.uPulse,
      uRepeat: this.uniforms.uRepeat,
    };
    this.floorMat = new THREE.ShaderMaterial({
      name: 'vfx:ringfloor',
      uniforms: this.floorUniforms,
      vertexShader: FLOOR_VERT,
      fragmentShader: FLOOR_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.floor = new THREE.Mesh(fgeo, this.floorMat);
    this.floor.frustumCulled = false;
    this.floor.renderOrder = 3;
    this.group.add(this.floor);

    this.group.visible = false;
    return this.group;
  }

  /** EV.RING_STAGE payload — center may be {x,z} or a Vector3. */
  setStage(p = {}) {
    const c = p.center || p.position;
    if (c) {
      this.group.position.x = c.x ?? 0;
      this.group.position.z = c.z ?? 0;
    }
    const r = p.radius ?? this.targetRadius;
    if (r > 0) {
      this.targetRadius = r;
      if (!this.active) this.radius = r;
    }
    if (p.nextRadius != null) this.nextRadius = p.nextRadius;
    this.stage = p.stage ?? this.stage;
    this.closing = p.phase !== 'wait';
    this.active = true;
    this.group.visible = true;
    this._flash = 1;
  }

  /** Directly place the wall (used by debugPresent to stage a hero shot). */
  place(x, z, radius) {
    this.group.position.set(x, 0, z);
    this.radius = radius;
    this.targetRadius = radius;
    this.active = true;
    this.group.visible = true;
  }

  update(dt, camera, hasDepth) {
    if (!this.active) return;
    const cfg = VCFG.ring;

    // Ease toward the target so a stage change closes rather than teleports.
    if (this.targetRadius > 0 && Math.abs(this.radius - this.targetRadius) > 0.01) {
      this.radius += (this.targetRadius - this.radius) * Math.min(1, dt * 0.55);
    }
    const r = Math.max(this.radius, 1);

    this.mesh.scale.set(r, cfg.height, r);
    this.mesh.position.y = cfg.height * 0.5;
    this.floor.scale.set(r, 1, r);
    this.floor.position.y = 0.06;

    this.uniforms.uRadius.value = r;
    this.uniforms.uRepeat.value = Math.max(24, Math.min(240,
      Math.round((2 * Math.PI * r) / 9)));
    this.uniforms.uCamPos.value.copy(camera.position);
    this.uniforms.uHasDepth.value = hasDepth ? 1 : 0;

    // Stage-change flare, then a slow breathing pulse.
    this._flash = Math.max(0, this._flash - dt * 0.7);
    const breathe = 0.94 + 0.06 * Math.sin(performance.now() * 0.0011);
    this.uniforms.uPulse.value = breathe + this._flash * 1.4;
  }

  setColors(a, b, c) {
    this.uniforms.uColA.value.copy(_c.set(a));
    this.uniforms.uColB.value.copy(_c.set(b));
    this.uniforms.uColC.value.copy(_c.set(c));
  }

  dispose() {
    this.mesh?.geometry.dispose();
    this.material?.dispose();
    this.floor?.geometry.dispose();
    this.floorMat?.dispose();
    this.group.parent?.remove(this.group);
  }
}
