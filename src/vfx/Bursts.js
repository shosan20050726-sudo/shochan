import * as THREE from 'three';

/**
 * Two small pools that need per-instance state but not per-instance draw
 * calls' worth of complexity:
 *
 *   ShockwavePool — expanding energy shells (ability casts, big impacts). Each
 *     slot owns a sphere shell plus a ground ring so the wave reads both in
 *     the air and along the floor.
 *   FlashLightPool — the real dynamic lights behind muzzle flashes, sparks and
 *     ability casts. Lights are created once and *never* added or removed at
 *     runtime: changing the scene light count forces three to recompile every
 *     material in the world, which is a guaranteed hitch. Idle lights simply
 *     sit at zero intensity.
 */

const SHOCK_VERT = /* glsl */`
uniform float uRadius;
varying vec3 vN;
varying vec3 vW;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 p = position * uRadius;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const SHOCK_FRAG = /* glsl */`
uniform vec3  uColor;
uniform vec3  uCore;
uniform float uAlpha;
uniform float uPower;
uniform vec3  uCamPos;
varying vec3 vN;
varying vec3 vW;
varying vec2 vUv;
void main() {
  vec3 V = normalize(uCamPos - vW);
  float rim = pow(1.0 - abs(dot(normalize(vN), V)), uPower);
  float a = rim * uAlpha;
  if (a < 0.003) discard;
  vec3 col = mix(uColor, uCore, clamp(rim * 1.4, 0.0, 1.0));
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}
`;

const RING_VERT = /* glsl */`
uniform float uRadius;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position * vec3(uRadius, 1.0, uRadius), 1.0);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const RING_FRAG = /* glsl */`
uniform vec3  uColor;
uniform vec3  uCore;
uniform float uAlpha;
varying vec2 vUv;
void main() {
  float band = 1.0 - abs(vUv.x * 2.0 - 1.0);
  float a = pow(band, 2.6) * uAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(mix(uColor, uCore, pow(band, 4.0)), clamp(a, 0.0, 1.0));
}
`;

export class ShockwavePool {
  constructor(count = 5) {
    this.count = count;
    this.group = new THREE.Group();
    this.group.name = 'vfx:shock';
    this.slots = [];
    this.next = 0;
  }

  build() {
    this.sphereGeo = new THREE.IcosahedronGeometry(1, 3);
    this.ringGeo = new THREE.RingGeometry(0.80, 1.0, 72, 1);
    this.ringGeo.rotateX(-Math.PI / 2);

    for (let i = 0; i < this.count; i++) {
      const u = {
        uRadius: { value: 1 },
        uColor: { value: new THREE.Color(0.35, 0.75, 1.4) },
        uCore: { value: new THREE.Color(2.4, 2.4, 2.6) },
        uAlpha: { value: 0 },
        uPower: { value: 3.0 },
        uCamPos: { value: new THREE.Vector3() },
      };
      const sMat = new THREE.ShaderMaterial({
        name: 'vfx:shockShell', uniforms: u,
        vertexShader: SHOCK_VERT, fragmentShader: SHOCK_FRAG,
        transparent: true, depthTest: true, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.BackSide, toneMapped: false,
      });
      const ru = {
        uRadius: { value: 1 },
        uColor: u.uColor,
        uCore: u.uCore,
        uAlpha: { value: 0 },
      };
      const rMat = new THREE.ShaderMaterial({
        name: 'vfx:shockRing', uniforms: ru,
        vertexShader: RING_VERT, fragmentShader: RING_FRAG,
        transparent: true, depthTest: true, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
      });

      const shell = new THREE.Mesh(this.sphereGeo, sMat);
      const ring = new THREE.Mesh(this.ringGeo, rMat);
      shell.frustumCulled = false; ring.frustumCulled = false;
      shell.renderOrder = 9; ring.renderOrder = 9;
      const holder = new THREE.Group();
      holder.add(shell); holder.add(ring);
      holder.visible = false;
      this.group.add(holder);

      this.slots.push({
        holder, shell, ring, u, ru,
        t: 1, life: 1, r0: 0, r1: 1, groundY: 0, ringR1: 1, alpha: 1,
      });
    }
    return this.group;
  }

  /**
   * @param {THREE.Vector3} pos
   * @param {number} r0 start radius
   * @param {number} r1 end radius
   * @param {number} life seconds
   * @param {THREE.Color} color
   * @param {THREE.Color} core
   * @param {number} groundY floor height for the ground ring
   */
  spawn(pos, r0, r1, life, color, core, groundY, alpha = 1) {
    const s = this.slots[this.next];
    this.next = (this.next + 1) % this.count;
    s.holder.position.copy(pos);
    s.holder.visible = true;
    s.t = 0; s.life = life; s.r0 = r0; s.r1 = r1;
    s.ringR1 = r1 * 1.35;
    s.alpha = alpha;
    s.groundY = groundY;
    s.u.uColor.value.copy(color);
    s.u.uCore.value.copy(core);
    s.ring.position.y = groundY - pos.y + 0.05;
  }

  update(dt, camera) {
    for (const s of this.slots) {
      if (!s.holder.visible) continue;
      s.t += dt / s.life;
      if (s.t >= 1) { s.holder.visible = false; s.u.uAlpha.value = 0; s.ru.uAlpha.value = 0; continue; }
      const e = 1 - Math.pow(1 - s.t, 3);         // ease-out expansion
      s.u.uRadius.value = s.r0 + (s.r1 - s.r0) * e;
      s.ru.uRadius.value = s.r0 + (s.ringR1 - s.r0) * e;
      const fade = Math.pow(1 - s.t, 1.8);
      s.u.uAlpha.value = fade * 1.5 * s.alpha;
      s.ru.uAlpha.value = fade * 1.15 * s.alpha;
      s.u.uCamPos.value.copy(camera.position);
    }
  }

  clear() {
    for (const s of this.slots) { s.holder.visible = false; s.t = 1; }
  }

  dispose() {
    this.sphereGeo?.dispose();
    this.ringGeo?.dispose();
    for (const s of this.slots) { s.shell.material.dispose(); s.ring.material.dispose(); }
    this.group.parent?.remove(this.group);
  }
}

/* -------------------------------------------------------------------------- */

export class FlashLightPool {
  constructor(count = 3) {
    this.count = count;
    this.lights = [];
    this.next = 0;
  }

  build(scene) {
    for (let i = 0; i < this.count; i++) {
      const l = new THREE.PointLight(0xffd7a0, 0, 16, 2);
      l.castShadow = false;
      l.name = `vfx:flashlight${i}`;
      scene.add(l);
      this.lights.push({ light: l, t: 1, life: 1, peak: 0, hold: 0 });
    }
    return this;
  }

  /** Short, bright, hard-falloff pop. `hold` keeps it at full for a moment. */
  pop(pos, color, intensity, range, life, hold = 0) {
    const s = this.lights[this.next];
    this.next = (this.next + 1) % this.count;
    s.light.position.copy(pos);
    s.light.color.set(color);
    s.light.distance = range;
    s.light.intensity = intensity;
    s.peak = intensity;
    s.life = Math.max(life, 1e-3);
    s.hold = hold;
    s.t = 0;
    return s;
  }

  update(dt) {
    for (const s of this.lights) {
      if (s.t >= 1) continue;
      if (s.hold > 0) { s.hold -= dt; s.light.intensity = s.peak; continue; }
      s.t += dt / s.life;
      if (s.t >= 1) { s.t = 1; s.light.intensity = 0; continue; }
      const f = 1 - s.t;
      s.light.intensity = s.peak * f * f;
    }
  }

  clear() {
    for (const s of this.lights) { s.t = 1; s.hold = 0; s.light.intensity = 0; }
  }

  dispose() {
    for (const s of this.lights) { s.light.parent?.remove(s.light); s.light.dispose?.(); }
    this.lights.length = 0;
  }
}

export default { ShockwavePool, FlashLightPool };
