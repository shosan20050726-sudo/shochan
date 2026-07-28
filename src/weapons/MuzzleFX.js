import * as THREE from 'three';
import { clamp01 } from './MathKit.js';

/**
 * First-person weapon effects that belong to the gun rather than to the world:
 * the muzzle flash (geometry + light, in both scenes), and ejected brass.
 *
 * World-space particles, decals and tracers are the vfx system's job — we only
 * emit the events for those.
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

let _flashTex = null;
let _glowTex = null;

function starTexture() {
  if (_flashTex || typeof document === 'undefined') return _flashTex;
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const h = s / 2;
  g.translate(h, h);

  // hot core
  let grad = g.createRadialGradient(0, 0, 0, 0, 0, h * 0.42);
  grad.addColorStop(0, 'rgba(255,255,250,1)');
  grad.addColorStop(0.25, 'rgba(255,238,190,0.95)');
  grad.addColorStop(0.55, 'rgba(255,168,60,0.55)');
  grad.addColorStop(1, 'rgba(255,110,20,0)');
  g.fillStyle = grad;
  g.beginPath(); g.arc(0, 0, h * 0.42, 0, Math.PI * 2); g.fill();

  // radial spikes
  g.globalCompositeOperation = 'lighter';
  const spikes = 9;
  for (let i = 0; i < spikes; i++) {
    const a = (i / spikes) * Math.PI * 2 + 0.31;
    const len = h * (i % 2 ? 0.62 : 0.98);
    const wdt = h * (i % 2 ? 0.055 : 0.085);
    g.save();
    g.rotate(a);
    const lg = g.createLinearGradient(0, 0, len, 0);
    lg.addColorStop(0, 'rgba(255,240,205,0.95)');
    lg.addColorStop(0.4, 'rgba(255,180,80,0.42)');
    lg.addColorStop(1, 'rgba(255,120,30,0)');
    g.fillStyle = lg;
    g.beginPath();
    g.moveTo(0, -wdt); g.lineTo(len, 0); g.lineTo(0, wdt);
    g.closePath(); g.fill();
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  _flashTex = t;
  return t;
}

function glowTexture() {
  if (_glowTex || typeof document === 'undefined') return _glowTex;
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const h = s / 2;
  const grad = g.createRadialGradient(h, h, 0, h, h, h);
  grad.addColorStop(0, 'rgba(255,246,225,0.95)');
  grad.addColorStop(0.35, 'rgba(255,190,110,0.42)');
  grad.addColorStop(1, 'rgba(255,140,50,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  _glowTex = t;
  return t;
}

/* ----------------------------------------------------------- muzzle flash - */

export class MuzzleFlash {
  constructor() {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.group.frustumCulled = false;
    this.t = 0;
    this.life = 0.055;
    this.scale = 1;

    const mat = new THREE.MeshBasicMaterial({
      map: starTexture(), transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: true, toneMapped: false, side: THREE.DoubleSide,
    });
    mat.color.setScalar(2.4);
    mat.userData.__gfxSkip = true;
    this.mat = mat;

    const plane = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(plane, mat);
      m.rotation.z = (i / 3) * Math.PI;
      m.frustumCulled = false;
      m.renderOrder = 14;
      this.group.add(m);
    }
    // A short cone gives the flash volume when seen from the side.
    const coneMat = mat.clone();
    coneMat.color.setScalar(1.5);
    coneMat.userData.__gfxSkip = true;
    this.coneMat = coneMat;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.35, 10, 1, true), coneMat);
    cone.geometry.rotateX(-Math.PI / 2);
    cone.geometry.translate(0, 0, -0.55);
    cone.frustumCulled = false;
    cone.renderOrder = 13;
    this.group.add(cone);
    this.cone = cone;

    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: glowTexture(), transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false,
    }));
    glow.material.color.setScalar(1.7);
    glow.material.userData.__gfxSkip = true;
    glow.frustumCulled = false;
    glow.renderOrder = 12;
    this.group.add(glow);
    this.glow = glow;
    this.glowMat = glow.material;

    // Local light so the gun itself is lit by its own flash.
    this.light = new THREE.PointLight(0xffcf95, 0, 2.4, 2);
    this.light.castShadow = false;
    this.light.userData.__gfx = true;
    this.group.add(this.light);
  }

  /** @param {number} size flash radius in metres, `rand` in [0,1) */
  fire(size, rand, life = 0.055) {
    this.t = 0;
    this.life = life;
    this.scale = size * (0.86 + rand * 0.34);
    this.group.visible = true;
    this.group.rotation.z = rand * Math.PI * 2;
    this.group.position.z = 0;
  }

  update(dt) {
    if (!this.group.visible) return;
    this.t += dt;
    const u = this.t / this.life;
    if (u >= 1) {
      this.group.visible = false;
      this.light.intensity = 0;
      return;
    }
    // Fast attack, exponential decay — a flash is over in ~2 frames.
    const env = u < 0.18 ? u / 0.18 : Math.pow(1 - (u - 0.18) / 0.82, 2.1);
    const s = this.scale * (0.62 + 0.55 * env);
    for (const c of this.group.children) {
      if (c === this.light) continue;
      c.scale.setScalar(c === this.cone ? s * 1.25 : s);
    }
    this.glow.scale.setScalar(s * 2.6);
    this.mat.opacity = env;
    this.coneMat.opacity = env * 0.55;
    this.glowMat.opacity = env * 0.5;
    this.light.intensity = env * 5.5;
  }
}

/* ------------------------------------------------------------ shell brass - */

const SHELL_COUNT = 14;

export class ShellPool {
  constructor(mat) {
    this.group = new THREE.Group();
    this.group.frustumCulled = false;
    this.items = [];
    const geo = new THREE.CylinderGeometry(0.0045, 0.0042, 0.021, 8, 1);
    geo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(0.0053, 0.0053, 0.003, 8, 1);
    rimGeo.rotateZ(Math.PI / 2);
    rimGeo.translate(-0.010, 0, 0);
    this.geo = geo; this.rimGeo = rimGeo;

    for (let i = 0; i < SHELL_COUNT; i++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(geo, mat);
      const rim = new THREE.Mesh(rimGeo, mat);
      body.frustumCulled = false; rim.frustumCulled = false;
      g.add(body, rim);
      g.visible = false;
      this.group.add(g);
      this.items.push({
        obj: g,
        vel: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        life: 0, maxLife: 1.1,
      });
    }
    this.next = 0;
  }

  /** Spawn one shell at a view-space position with a view-space velocity. */
  spawn(pos, vx, vy, vz, rand, scale = 1) {
    const it = this.items[this.next];
    this.next = (this.next + 1) % this.items.length;
    it.obj.visible = true;
    it.obj.position.copy(pos);
    it.obj.rotation.set(rand * 3.0, rand * 5.0, rand * 2.0);
    it.obj.scale.setScalar(scale);
    it.baseScale = scale;
    it.vel.set(vx, vy, vz);
    it.spin.set((rand - 0.5) * 26, (rand * 1.7 - 0.5) * 20, (rand * 2.3 % 1 - 0.5) * 30);
    it.life = 0;
    it.maxLife = 0.85 + rand * 0.4;
  }

  update(dt) {
    if (dt > 0.05) dt = 0.05;
    for (const it of this.items) {
      if (!it.obj.visible) continue;
      it.life += dt;
      if (it.life >= it.maxLife) { it.obj.visible = false; continue; }
      it.vel.y -= 9.4 * dt;
      it.vel.multiplyScalar(1 - Math.min(0.35, 1.6 * dt));
      it.obj.position.addScaledVector(it.vel, dt);
      it.obj.rotation.x += it.spin.x * dt;
      it.obj.rotation.y += it.spin.y * dt;
      it.obj.rotation.z += it.spin.z * dt;
      const fade = clamp01((it.maxLife - it.life) / 0.28);
      it.obj.scale.setScalar((it.baseScale || 1) * fade);
    }
  }

  dispose() {
    this.geo.dispose();
    this.rimGeo.dispose();
  }
}

export default { MuzzleFlash, ShellPool };
