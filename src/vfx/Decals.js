import * as THREE from 'three';

/**
 * Pooled surface decals.
 *
 * One instanced draw call, one ring buffer, one hard cap — decals can never
 * grow unbounded. Each instance carries its own tangent frame so the quad sits
 * flush on the hit normal with a random roll, and its own birth time so the
 * shader fades it out and recycles the slot silently.
 *
 * The decal is shaded rather than pasted: a cheap lambert against the scene
 * sun plus ambient means a bullet hole in shadow stays in shadow instead of
 * glowing as an unlit sticker.
 */

const VERT = /* glsl */`
attribute vec3 iCenter;
attribute vec4 iRight;    // xyz basis, w half-width
attribute vec4 iUp;       // xyz basis, w half-height
attribute vec4 iData;     // spawnTime, life, frame, fadeStart
attribute vec4 iTint;     // rgb tint, a alpha multiplier

uniform float uTime;
uniform vec2  uAtlas;

varying vec2  vUv;
varying vec4  vTint;
varying vec3  vNormal;
varying float vFade;

void main() {
  float age = uTime - iData.x;
  float t = age / max(iData.y, 1e-3);
  vUv = vec2(0.0); vTint = vec4(0.0); vNormal = vec3(0.0, 1.0, 0.0); vFade = 0.0;
  if (age < 0.0 || t >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  vec3 r = iRight.xyz;
  vec3 u = iUp.xyz;
  vec3 wp = iCenter + r * (position.x * iRight.w) + u * (position.y * iUp.w);

  float fin  = smoothstep(0.0, 0.045, t);
  float fout = 1.0 - smoothstep(iData.w, 1.0, t);
  vFade = fin * fout;
  vTint = iTint;
  vNormal = normalize(cross(r, u));

  float f = floor(iData.z + 0.5);
  vUv = (uv + vec2(mod(f, uAtlas.x), floor(f / uAtlas.x))) / uAtlas;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
}
`;

const FRAG = /* glsl */`
uniform sampler2D uMap;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbColor;

varying vec2  vUv;
varying vec4  vTint;
varying vec3  vNormal;
varying float vFade;

void main() {
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vFade * vTint.a;
  if (a < 0.004) discard;
  float ndl = max(dot(normalize(vNormal), uSunDir), 0.0);
  vec3 light = uAmbColor + uSunColor * (ndl * 0.85 + 0.06);
  gl_FragColor = vec4(tex.rgb * vTint.rgb * light, a);
}
`;

const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();

export default class DecalPool {
  constructor(cap = 192) {
    this.cap = cap;
    this.head = 0;
    this.used = 0;
    this.maxDeath = -1e9;
    this.center = new Float32Array(cap * 3);
    this.right = new Float32Array(cap * 4);
    this.up = new Float32Array(cap * 4);
    this.data = new Float32Array(cap * 4);
    this.tint = new Float32Array(cap * 4);
    this._dirty = false;
  }

  build(texture, sharedTime, atlas = [4, 2]) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      0, 0, 1, 0, 1, 1, 0, 1,
    ]), 2));

    const mk = (arr, n) => {
      const a = new THREE.InstancedBufferAttribute(arr, n, false, 1);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aCenter = mk(this.center, 3);
    this.aRight = mk(this.right, 4);
    this.aUp = mk(this.up, 4);
    this.aData = mk(this.data, 4);
    this.aTint = mk(this.tint, 4);
    geo.setAttribute('iCenter', this.aCenter);
    geo.setAttribute('iRight', this.aRight);
    geo.setAttribute('iUp', this.aUp);
    geo.setAttribute('iData', this.aData);
    geo.setAttribute('iTint', this.aTint);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.uniforms = {
      uTime: sharedTime,
      uMap: { value: texture },
      uAtlas: { value: new THREE.Vector2(atlas[0], atlas[1]) },
      uSunDir: { value: new THREE.Vector3(0.42, 0.62, 0.66).normalize() },
      uSunColor: { value: new THREE.Color(1.35, 1.16, 0.94) },
      uAmbColor: { value: new THREE.Color(0.30, 0.36, 0.46) },
    };

    this.material = new THREE.ShaderMaterial({
      name: 'vfx:decals',
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.geometry = geo;
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'vfx:decals';
    return this.mesh;
  }

  /**
   * @param {THREE.Vector3} point   hit point in world space
   * @param {THREE.Vector3} normal  surface normal
   * @param {number} size           half-extent in metres
   * @param {number} frame          atlas frame
   * @param {number} life           seconds
   * @param {number} fadeStart      0..1 fraction of life where fade-out begins
   * @param {number} roll           radians about the normal
   * @param {THREE.Color|null} tint
   * @param {number} alpha
   * @param {number} offset         push along the normal to beat z-fighting
   * @param {number} time
   */
  spawn(point, normal, size, frame, life, fadeStart, roll, tint, alpha, offset, time) {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    if (this.used < this.cap) this.used++;

    _n.copy(normal);
    if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0);
    _n.normalize();

    // Build a tangent frame, then spin it about the normal so repeat hits on
    // the same wall never read as a stamped pattern.
    if (Math.abs(_n.y) < 0.92) _t.set(0, 1, 0); else _t.set(1, 0, 0);
    _r.crossVectors(_t, _n).normalize();
    _u.crossVectors(_n, _r).normalize();
    const cs = Math.cos(roll), sn = Math.sin(roll);
    const rx = _r.x * cs + _u.x * sn, ry = _r.y * cs + _u.y * sn, rz = _r.z * cs + _u.z * sn;
    const ux = _u.x * cs - _r.x * sn, uy = _u.y * cs - _r.y * sn, uz = _u.z * cs - _r.z * sn;

    const c3 = i * 3, c4 = i * 4;
    this.center[c3] = point.x + _n.x * offset;
    this.center[c3 + 1] = point.y + _n.y * offset;
    this.center[c3 + 2] = point.z + _n.z * offset;

    this.right[c4] = rx; this.right[c4 + 1] = ry; this.right[c4 + 2] = rz; this.right[c4 + 3] = size;
    this.up[c4] = ux; this.up[c4 + 1] = uy; this.up[c4 + 2] = uz; this.up[c4 + 3] = size;
    this.data[c4] = time; this.data[c4 + 1] = life; this.data[c4 + 2] = frame; this.data[c4 + 3] = fadeStart;
    if (tint) {
      this.tint[c4] = tint.r; this.tint[c4 + 1] = tint.g; this.tint[c4 + 2] = tint.b;
    } else {
      this.tint[c4] = 1; this.tint[c4 + 1] = 1; this.tint[c4 + 2] = 1;
    }
    this.tint[c4 + 3] = alpha;

    const death = time + life;
    if (death > this.maxDeath) this.maxDeath = death;
    this._dirty = true;
  }

  flush(time) {
    if (time > this.maxDeath) {
      this.head = 0; this.used = 0;
      this.geometry.instanceCount = 0;
    } else {
      this.geometry.instanceCount = this.used;
    }
    if (this._dirty) {
      this.aCenter.needsUpdate = true;
      this.aRight.needsUpdate = true;
      this.aUp.needsUpdate = true;
      this.aData.needsUpdate = true;
      this.aTint.needsUpdate = true;
      this._dirty = false;
    }
  }

  setLighting(sunDir, sunColor, ambColor) {
    this.uniforms.uSunDir.value.copy(sunDir);
    this.uniforms.uSunColor.value.copy(sunColor);
    this.uniforms.uAmbColor.value.copy(ambColor);
  }

  clear() {
    this.head = 0; this.used = 0; this.maxDeath = -1e9;
    if (this.geometry) this.geometry.instanceCount = 0;
  }

  dispose() {
    this.geometry?.dispose();
    this.material?.dispose();
  }
}
