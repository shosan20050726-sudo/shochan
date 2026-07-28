import * as THREE from 'three';
import { makeRNG } from '../core/Rand.js';
import VCFG from './VFXConfig.js';

/**
 * Environmental atmosphere: the stuff that makes air look like air.
 *
 *   DustMotes   — a world-space mote volume that wraps around the camera, so
 *                 you are always inside it without any of it ever being
 *                 respawned on the CPU. Motes forward-scatter toward the sun,
 *                 which is what makes them only really show up in sunlight.
 *   LightShafts — crossed additive cards along the sun vector, anchored to a
 *                 coarse world grid around the camera so shafts belong to the
 *                 world rather than sliding with the view.
 *   HeatHaze    — real refraction. Samples the half-res scene capture with an
 *                 animated offset, so hot air actually bends what is behind it
 *                 instead of being an additive smear pretending to.
 */

/* ------------------------------------------------------------- motes ----- */

const MOTE_VERT = /* glsl */`
attribute vec4 aSeed;

uniform float uTime;
uniform vec3  uBox;
uniform vec3  uCenter;
uniform vec3  uWind;
uniform vec3  uSunDir;
uniform float uSize;

varying vec2  vQuv;
varying float vBright;

void main() {
  vec3 base = aSeed.xyz * uBox;
  float ph = aSeed.w * 37.0;
  vec3 drift = uWind * uTime + vec3(
    sin(uTime * 0.31 + ph) * 0.55,
    sin(uTime * 0.19 + ph * 1.7) * 0.30,
    cos(uTime * 0.27 + ph * 0.6) * 0.55);

  // Wrap into a box that follows the camera. mod() twice keeps it positive.
  vec3 rel = base + drift - uCenter + uBox * 0.5;
  rel = mod(mod(rel, uBox) + uBox, uBox);
  vec3 p = rel - uBox * 0.5 + uCenter;

  vec3 toCam = cameraPosition - p;
  float d = length(toCam);
  vec3 viewDir = -toCam / max(d, 1e-3);

  float sparkle = 0.22 + 0.78 * pow(0.5 + 0.5 * sin(uTime * (1.7 + aSeed.w * 3.4) + ph * 3.1), 5.0);
  float fs = pow(max(dot(viewDir, -uSunDir), 0.0), 5.0);     // forward scatter
  float band = 0.35 + 0.65 * (0.5 + 0.5 * sin(p.x * 0.11 + p.z * 0.083 + sin(p.y * 0.19) * 1.7));
  float fade = smoothstep(0.5, 1.8, d) * (1.0 - smoothstep(uBox.x * 0.30, uBox.x * 0.50, d));

  vBright = sparkle * band * fade * (0.25 + 2.35 * fs);
  vQuv = uv;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  mv.xy += position.xy * (uSize * (0.45 + aSeed.w));
  gl_Position = projectionMatrix * mv;
}
`;

const MOTE_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uColor;
varying vec2  vQuv;
varying float vBright;
void main() {
  float a = texture2D(uMap, vQuv).a * vBright;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
}
`;

export class DustMotes {
  constructor(count = 640, seed = 7) {
    this.count = count;
    this.seed = seed;
  }

  build(texture, shared) {
    const rng = makeRNG(this.seed);
    const seeds = new Float32Array(this.count * 4);
    for (let i = 0; i < this.count; i++) {
      seeds[i * 4] = rng();
      seeds[i * 4 + 1] = rng();
      seeds[i * 4 + 2] = rng();
      seeds[i * 4 + 3] = rng();
    }

    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      0, 0, 1, 0, 1, 1, 0, 1]), 2));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = this.count;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const box = VCFG.atmosphere.moteBox;
    this.uniforms = {
      uTime: shared.uTime,
      uMap: { value: texture },
      uBox: { value: new THREE.Vector3(box, box * 0.6, box) },
      uCenter: { value: new THREE.Vector3() },
      uWind: shared.uWind,
      uSunDir: shared.uSunWorld,
      uSize: { value: VCFG.atmosphere.moteSize },
      uColor: { value: new THREE.Color(1.7, 1.52, 1.18) },
    };

    this.material = new THREE.ShaderMaterial({
      name: 'vfx:motes',
      uniforms: this.uniforms,
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 11;
    this.mesh.name = 'vfx:motes';
    return this.mesh;
  }

  update(camera) {
    this.uniforms.uCenter.value.copy(camera.position);
  }

  dispose() {
    this.mesh?.geometry.dispose();
    this.material?.dispose();
  }
}

/* ------------------------------------------------------------ shafts ----- */

const SHAFT_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vN;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const SHAFT_FRAG = /* glsl */`
#include <packing>

uniform float uTime;
uniform vec3  uColor;
uniform float uIntensity;
uniform vec3  uCamPos;
uniform sampler2D uDepth;
uniform vec2  uInvRes;
uniform float uNear;
uniform float uFar;
uniform float uHasDepth;

varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vN;

float h21(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x),
             mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main() {
  float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
  float a = pow(across, 1.7);
  // uv.y: 0 at the ground, 1 at the source aperture
  a *= pow(clamp(vUv.y, 0.0, 1.0), 0.85) * (1.0 - smoothstep(0.88, 1.0, vUv.y));

  float dust = 0.55 + 0.45 * vnoise(vec2(vUv.x * 3.0, vUv.y * 5.0 - uTime * 0.06));
  a *= dust;

  vec3 V = uCamPos - vWorld;
  float dist = length(V);
  V /= max(dist, 1e-3);
  a *= 0.30 + 0.70 * abs(dot(normalize(vN), V));
  a *= smoothstep(1.5, 7.0, dist) * (1.0 - smoothstep(60.0, 130.0, dist));

  if (uHasDepth > 0.5) {
    vec2 suv = gl_FragCoord.xy * uInvRes;
    float dz = texture2D(uDepth, suv).x;
    float sceneDist = -perspectiveDepthToViewZ(dz, uNear, uFar);
    a *= clamp((sceneDist - dist) / 2.5, 0.0, 1.0);
  }

  a *= uIntensity;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor, clamp(a, 0.0, 1.0));
}
`;

const OFFSETS = [[0, 0], [1, 0], [0, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [0, -2]];
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _pos = new THREE.Vector3();

export class LightShafts {
  constructor(count = 6, seed = 13) {
    this.count = count;
    this.seed = seed;
    this.group = new THREE.Group();
    this.group.name = 'vfx:shafts';
    this.cells = new Int32Array(count * 2).fill(0x7fffffff);
    this.len = 34;
  }

  _cardGeometry(wTop, wBot, len) {
    const cards = 3;
    const pos = new Float32Array(cards * 4 * 3);
    const uv = new Float32Array(cards * 4 * 2);
    const nrm = new Float32Array(cards * 4 * 3);
    const idx = new Uint16Array(cards * 6);
    for (let c = 0; c < cards; c++) {
      const th = (c / cards) * Math.PI;
      const cs = Math.cos(th), sn = Math.sin(th);
      // quad in local XY rotated about Y; +Y points at the light source
      const corners = [
        [-wBot * 0.5, -len * 0.5], [wBot * 0.5, -len * 0.5],
        [wTop * 0.5, len * 0.5], [-wTop * 0.5, len * 0.5],
      ];
      const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
      for (let v = 0; v < 4; v++) {
        const [x, y] = corners[v];
        const o = (c * 4 + v) * 3;
        pos[o] = x * cs; pos[o + 1] = y; pos[o + 2] = -x * sn;
        nrm[o] = sn; nrm[o + 1] = 0; nrm[o + 2] = cs;
        const u = (c * 4 + v) * 2;
        uv[u] = uvs[v][0]; uv[u + 1] = uvs[v][1];
      }
      const b = c * 4, i = c * 6;
      idx[i] = b; idx[i + 1] = b + 1; idx[i + 2] = b + 2;
      idx[i + 3] = b; idx[i + 4] = b + 2; idx[i + 5] = b + 3;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
  }

  build(shared) {
    this.geometry = this._cardGeometry(4.5, 11, this.len);
    this.uniforms = {
      uTime: shared.uTime,
      uColor: { value: new THREE.Color(1.20, 1.02, 0.74) },
      uIntensity: { value: VCFG.atmosphere.shaftIntensity },
      uCamPos: { value: new THREE.Vector3() },
      uDepth: shared.uDepth,
      uInvRes: shared.uInvRes,
      uNear: shared.uNear,
      uFar: shared.uFar,
      uHasDepth: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'vfx:shaft',
      uniforms: this.uniforms,
      vertexShader: SHAFT_VERT,
      fragmentShader: SHAFT_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    for (let i = 0; i < this.count; i++) {
      const m = new THREE.Mesh(this.geometry, this.material);
      m.frustumCulled = false;
      this.group.add(m);
    }
    return this.group;
  }

  update(camera, sunDir, hasDepth) {
    this.uniforms.uCamPos.value.copy(camera.position);
    this.uniforms.uHasDepth.value = hasDepth ? 1 : 0;

    const sp = VCFG.atmosphere.shaftSpacing;
    const bx = Math.round(camera.position.x / sp);
    const bz = Math.round(camera.position.z / sp);
    _q.setFromUnitVectors(_up, sunDir);

    for (let i = 0; i < this.count; i++) {
      const off = OFFSETS[i % OFFSETS.length];
      const cx = bx + off[0], cz = bz + off[1];
      const mesh = this.group.children[i];
      if (this.cells[i * 2] !== cx || this.cells[i * 2 + 1] !== cz) {
        this.cells[i * 2] = cx;
        this.cells[i * 2 + 1] = cz;
        const rng = makeRNG((this.seed ^ (cx * 73856093) ^ (cz * 19349663)) >>> 0);
        const jx = (rng() - 0.5) * sp * 0.75;
        const jz = (rng() - 0.5) * sp * 0.75;
        mesh.userData.gx = cx * sp + jx;
        mesh.userData.gz = cz * sp + jz;
        mesh.userData.scale = 0.7 + rng() * 0.9;
        mesh.userData.on = rng() < 0.78;
      }
      mesh.visible = mesh.userData.on;
      if (!mesh.visible) continue;
      const s = mesh.userData.scale;
      _pos.set(mesh.userData.gx, 0, mesh.userData.gz)
        .addScaledVector(sunDir, this.len * 0.5 * s);
      mesh.position.copy(_pos);
      mesh.quaternion.copy(_q);
      mesh.scale.setScalar(s);
    }
  }

  dispose() {
    this.geometry?.dispose();
    this.material?.dispose();
    this.group.parent?.remove(this.group);
  }
}

/* -------------------------------------------------------------- haze ----- */

const HAZE_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const HAZE_FRAG = /* glsl */`
uniform sampler2D uScene;
uniform vec2  uInvRes;
uniform float uTime;
uniform float uStrength;
uniform float uAmount;
uniform vec3  uCamPos;
uniform float uFreq;

varying vec2 vUv;
varying vec3 vWorld;

float h21(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x),
             mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main() {
  // Rising cells of hot air: two noise fields scrolling up at different rates.
  vec2 q = vUv * vec2(uFreq, uFreq * 0.55);
  float n1 = vnoise(q + vec2(uTime * 0.13, -uTime * 0.85));
  float n2 = vnoise(q * 2.3 + vec2(-uTime * 0.09, -uTime * 1.55));

  float edge = pow(1.0 - abs(vUv.x * 2.0 - 1.0), 0.9);
  float up = (1.0 - smoothstep(0.15, 1.0, vUv.y)) * smoothstep(0.0, 0.10, vUv.y);
  float mask = edge * up * uAmount;
  if (mask < 0.004) discard;

  vec2 off = (vec2(n1, n2) - 0.5) * (uStrength * mask);
  vec2 suv = clamp(gl_FragCoord.xy * uInvRes + off, vec2(0.001), vec2(0.999));
  vec3 c = texture2D(uScene, suv).rgb;
  c *= vec3(1.035, 1.005, 0.965);      // hot air reads slightly warm

  gl_FragColor = vec4(c, mask * 0.85);
}
`;

const _fwd = new THREE.Vector3();
const _tmp = new THREE.Vector3();

export class HeatHaze {
  constructor(count = 3) {
    this.count = count;
    this.group = new THREE.Group();
    this.group.name = 'vfx:haze';
    this.transient = [];
  }

  build(shared) {
    this.geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
    this.uniforms = {
      uScene: shared.uScene,
      uInvRes: shared.uInvRes,
      uTime: shared.uTime,
      uStrength: { value: VCFG.atmosphere.hazeStrength },
      uAmount: { value: 1 },
      uCamPos: { value: new THREE.Vector3() },
      uFreq: { value: 5.0 },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'vfx:haze',
      uniforms: this.uniforms,
      vertexShader: HAZE_VERT,
      fragmentShader: HAZE_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    // Ground bands that ride with the camera — desert heat over hot ground.
    this.dists = [17, 33, 58];
    for (let i = 0; i < this.count; i++) {
      const m = new THREE.Mesh(this.geometry, this.material);
      m.frustumCulled = false;
      m.renderOrder = 3;
      this.group.add(m);
    }
    return this.group;
  }

  update(camera, enabled) {
    this.group.visible = enabled;
    if (!enabled) return;
    this.uniforms.uCamPos.value.copy(camera.position);
    camera.getWorldDirection(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    const yaw = Math.atan2(_fwd.x, _fwd.z);
    for (let i = 0; i < this.count; i++) {
      const m = this.group.children[i];
      const d = this.dists[i % this.dists.length];
      const h = 2.2 + d * 0.10;
      _tmp.copy(camera.position).addScaledVector(_fwd, d);
      m.position.set(_tmp.x, h * 0.5, _tmp.z);
      m.rotation.set(0, yaw, 0);
      m.scale.set(d * 2.4, h, 1);
    }
  }

  dispose() {
    this.geometry?.dispose();
    this.material?.dispose();
    this.group.parent?.remove(this.group);
  }
}

export default { DustMotes, LightShafts, HeatHaze };
