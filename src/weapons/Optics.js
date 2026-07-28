import * as THREE from 'three';
import { boxGeo, cylGeo, discGeo, latheGeo } from './Parts.js';

/**
 * Optics: housings plus the reticles that live inside them.
 *
 * Reticles are drawn into a canvas at load time (no image files anywhere) and
 * rendered as additive, non-tone-mapped quads so the bloom pass picks up the
 * emitter core the way a real illuminated dot blooms in a camera.
 */

const _texCache = new Map();

function canvas(size) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  return c;
}

function finish(c) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** Illuminated dot with a hot core and a soft halo. */
export function dotTexture(color = '#ff3a2a', coreScale = 1) {
  const key = `dot|${color}|${coreScale}`;
  if (_texCache.has(key)) return _texCache.get(key);
  const size = 128;
  const c = canvas(size);
  if (!c) return null;
  const g = c.getContext('2d');
  const h = size / 2;
  const grad = g.createRadialGradient(h, h, 0, h, h, h);
  grad.addColorStop(0.00, 'rgba(255,255,255,1)');
  grad.addColorStop(0.07 * coreScale, 'rgba(255,240,225,1)');
  grad.addColorStop(0.13 * coreScale, color);
  grad.addColorStop(0.30 * coreScale, 'rgba(255,40,20,0.45)');
  grad.addColorStop(0.62, 'rgba(255,20,10,0.10)');
  grad.addColorStop(1.00, 'rgba(255,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = finish(c);
  _texCache.set(key, t);
  return t;
}

/** Holographic ring-and-dot. */
export function holoTexture(color = '#ff3326') {
  const key = `holo|${color}`;
  if (_texCache.has(key)) return _texCache.get(key);
  const size = 256;
  const c = canvas(size);
  if (!c) return null;
  const g = c.getContext('2d');
  const h = size / 2;
  g.translate(h, h);
  g.strokeStyle = color; g.fillStyle = color;
  g.shadowColor = color; g.shadowBlur = 10;

  g.lineWidth = 5;
  g.beginPath(); g.arc(0, 0, h * 0.60, 0, Math.PI * 2); g.stroke();
  // ticks at 3, 6 and 9 o'clock
  g.lineWidth = 6;
  for (const a of [0, Math.PI * 0.5, Math.PI]) {
    g.beginPath();
    g.moveTo(Math.cos(a) * h * 0.60, Math.sin(a) * h * 0.60);
    g.lineTo(Math.cos(a) * h * 0.78, Math.sin(a) * h * 0.78);
    g.stroke();
  }
  g.shadowBlur = 18;
  g.beginPath(); g.arc(0, 0, h * 0.075, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffffff';
  g.beginPath(); g.arc(0, 0, h * 0.032, 0, Math.PI * 2); g.fill();
  const t = finish(c);
  _texCache.set(key, t);
  return t;
}

/** Mil-dot sniper crosshair with heavy outer posts. */
export function scopeTexture() {
  const key = 'scope';
  if (_texCache.has(key)) return _texCache.get(key);
  const size = 512;
  const c = canvas(size);
  if (!c) return null;
  const g = c.getContext('2d');
  const h = size / 2;
  g.translate(h, h);
  g.strokeStyle = '#0d1114'; g.fillStyle = '#0d1114';
  g.lineCap = 'butt';

  // heavy posts from the edge inward
  g.lineWidth = 13;
  for (const a of [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5]) {
    g.save(); g.rotate(a);
    g.beginPath(); g.moveTo(h * 0.97, 0); g.lineTo(h * 0.34, 0); g.stroke();
    g.restore();
  }
  // fine crosshair with a centre gap
  g.lineWidth = 3.2;
  for (const a of [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5]) {
    g.save(); g.rotate(a);
    g.beginPath(); g.moveTo(h * 0.34, 0); g.lineTo(h * 0.055, 0); g.stroke();
    g.restore();
  }
  // mil dots below and to the sides
  for (let i = 1; i <= 4; i++) {
    const d = h * 0.085 * i;
    g.beginPath(); g.arc(0, d + h * 0.03, 4.0, 0, Math.PI * 2); g.fill();
    if (i < 4) {
      g.beginPath(); g.arc(d + h * 0.03, 0, 3.4, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(-d - h * 0.03, 0, 3.4, 0, Math.PI * 2); g.fill();
    }
  }
  g.fillStyle = '#c8231b';
  g.shadowColor = '#ff2a1e'; g.shadowBlur = 12;
  g.beginPath(); g.arc(0, 0, 3.6, 0, Math.PI * 2); g.fill();
  const t = finish(c);
  _texCache.set(key, t);
  return t;
}

/* ------------------------------------------------------------- materials -- */

function reticleMaterial(map, intensity = 1.6) {
  const m = new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
    side: THREE.FrontSide,
  });
  m.color.setScalar(intensity);
  m.userData.__gfxSkip = true;
  return m;
}

function quad(size, mat, z, y = 0, x = 0) {
  const g = new THREE.PlaneGeometry(size, size);
  const mesh = new THREE.Mesh(g, mat);
  mesh.position.set(x, y, z);
  mesh.renderOrder = 20;
  mesh.frustumCulled = false;
  return mesh;
}

/* ---------------------------------------------------------------- build --- */

/**
 * Add an optic to an assembly.
 *
 * @returns {{sight:number[], reticle:THREE.Mesh|null, mask:THREE.Mesh|null,
 *            reticleMat:THREE.Material|null}}
 *          `sight` is the model-space point that must land on the screen
 *          centre when the weapon is aimed down sights.
 */
export function buildOptic(A, kind, x, y, z) {
  switch (kind) {
    case 'holo': return holoSight(A, x, y, z);
    case 'scope': return scope(A, x, y, z);
    case 'bead': return beadSight(A, x, y, z);
    case 'minidot': return miniDot(A, x, y, z);
    case 'reddot':
    default: return redDot(A, x, y, z);
  }
}

/** Tube red dot on a QD mount. */
function redDot(A, x, y, z) {
  const R = 0.0205, len = 0.062;
  const cy = y + 0.0295;

  // mount
  A.box('body', 'bodyDark', [0.026, 0.020, 0.036], [x, y + 0.010, z + 0.002], null, 0.0018);
  A.box('body', 'accent', [0.032, 0.006, 0.020], [x, y + 0.019, z + 0.010], null, 0.0012);
  A.cylY('body', 'steel', 0.0028, 0.0028, 0.012, [x + 0.014, y + 0.014, z + 0.008], [0, 0, Math.PI / 2], 8);
  // body tube
  A.cyl('body', 'bodyDark', R, R, len, [x, cy, z], null, 20, false);
  A.cyl('body', 'body', R + 0.0022, R + 0.0022, 0.010, [x, cy, z - len * 0.5 + 0.008], null, 20);
  A.cyl('body', 'body', R + 0.0022, R + 0.0022, 0.010, [x, cy, z + len * 0.5 - 0.008], null, 20);
  // sunshade lip
  A.cyl('body', 'bodyDark', R + 0.0012, R - 0.0005, 0.014, [x, cy, z - len * 0.5 - 0.006], null, 20, true);
  // adjustment turrets
  A.cylY('body', 'accent', 0.0062, 0.0068, 0.011, [x, cy + R + 0.004, z + 0.012], null, 10);
  A.cylY('body', 'accent', 0.0058, 0.0064, 0.010, [x - R - 0.004, cy, z + 0.012], [0, 0, Math.PI / 2], 10);
  A.cylY('body', 'steelDark', 0.0030, 0.0030, 0.004, [x, cy + R + 0.011, z + 0.012], null, 8);
  // brightness dial
  A.cylY('body', 'steelDark', 0.0075, 0.0075, 0.008, [x + R * 0.55, cy + R * 0.6, z - 0.012], [0.6, 0, 0.5], 10);

  // glass
  const glassFront = discGeo(R - 0.0018, 20);
  A.add('body', 'glass', glassFront, [x, cy, z - len * 0.5 + 0.004], [0, Math.PI, 0]);
  A.add('body', 'glass', discGeo(R - 0.0018, 20), [x, cy, z + len * 0.5 - 0.004]);

  const mat = reticleMaterial(dotTexture('#ff3524', 1), 2.1);
  const ret = quad(R * 2.5, mat, z - len * 0.32, cy, x);
  A.attach('body', ret);

  return { sight: [x, cy, z], reticle: ret, reticleMat: mat, mask: null };
}

/** Boxy holographic sight with an open window. */
function holoSight(A, x, y, z) {
  const w = 0.040, h = 0.034, d = 0.072;
  const cy = y + 0.0255;
  const wallT = 0.0055;

  A.box('body', 'bodyDark', [w, 0.014, d], [x, y + 0.008, z], null, 0.0018);            // base
  A.box('body', 'body', [w, h, 0.026], [x, cy, z + d * 0.5 - 0.013], null, 0.0022);     // rear hood
  A.box('body', 'body', [w, h * 0.42, 0.030], [x, cy + h * 0.29, z - d * 0.22], null, 0.0022); // top bridge
  // window frame uprights
  A.box('body', 'body', [wallT, h, 0.030], [x - w * 0.5 + wallT * 0.5, cy, z - d * 0.22], null, 0.0016);
  A.box('body', 'body', [wallT, h, 0.030], [x + w * 0.5 - wallT * 0.5, cy, z - d * 0.22], null, 0.0016);
  A.box('body', 'body', [w, 0.006, 0.030], [x, cy - h * 0.5 + 0.003, z - d * 0.22], null, 0.0014);
  // hood over the window
  A.box('body', 'bodyDark', [w * 1.02, 0.005, 0.020], [x, cy + h * 0.5 + 0.001, z - d * 0.42], null, 0.0012);
  // buttons + battery cap
  A.box('body', 'accent', [0.007, 0.007, 0.014], [x - w * 0.5 - 0.002, cy - 0.004, z + d * 0.28], null, 0.0015);
  A.box('body', 'accent', [0.007, 0.007, 0.014], [x - w * 0.5 - 0.002, cy - 0.004, z + d * 0.42], null, 0.0015);
  A.cylY('body', 'steelDark', 0.0062, 0.0062, 0.010, [x + w * 0.5 + 0.001, cy, z + d * 0.34], [0, 0, Math.PI / 2], 10);

  A.add('body', 'glass', discGeo(0.0145, 18), [x, cy, z - d * 0.22], [0, Math.PI, 0]);

  const mat = reticleMaterial(holoTexture('#ff3020'), 1.9);
  const ret = quad(0.036, mat, z - d * 0.30, cy, x);
  A.attach('body', ret);

  return { sight: [x, cy, z - d * 0.22], reticle: ret, reticleMat: mat, mask: null };
}

/** Long-range scope with objective/ocular bells, turrets and a masked picture. */
function scope(A, x, y, z) {
  const R = 0.0175, len = 0.185;
  const cy = y + 0.0345;
  const zF = z - len * 0.5, zR = z + len * 0.5;

  // rings + rail mounts
  for (const zz of [z - 0.052, z + 0.050]) {
    A.box('body', 'bodyDark', [0.026, 0.020, 0.020], [x, y + 0.010, zz], null, 0.0018);
    A.cyl('body', 'accent', R + 0.0055, R + 0.0055, 0.018, [x, cy, zz], null, 18);
    A.box('body', 'accent', [0.030, 0.005, 0.018], [x, cy - R - 0.001, zz], null, 0.0012);
  }
  // main tube
  A.cyl('body', 'bodyDark', R, R, len, [x, cy, z], null, 22);
  // objective bell
  A.lathe('body', 'bodyDark', [
    R, 0.0, R, 0.012, R + 0.0085, 0.030, R + 0.0095, 0.052, R + 0.0095, 0.058,
  ], [x, cy, zF - 0.001], [Math.PI, 0, 0], 22);
  A.cyl('body', 'body', R + 0.0105, R + 0.0105, 0.008, [x, cy, zF - 0.056], null, 22);
  // ocular bell
  A.lathe('body', 'bodyDark', [
    R, 0.0, R, 0.010, R + 0.0055, 0.024, R + 0.0062, 0.040,
  ], [x, cy, zR + 0.001], null, 22);
  A.cyl('body', 'body', R + 0.0072, R + 0.0072, 0.009, [x, cy, zR + 0.040], null, 22);
  // magnification ring with knurl bars
  A.cyl('body', 'body', R + 0.0035, R + 0.0035, 0.016, [x, cy, zR - 0.020], null, 22);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    A.box('body', 'accent', [0.0022, 0.0022, 0.014],
      [x + Math.cos(a) * (R + 0.0042), cy + Math.sin(a) * (R + 0.0042), zR - 0.020], [0, 0, a]);
  }
  // turrets
  A.cylY('body', 'accent', 0.0092, 0.0100, 0.017, [x, cy + R + 0.007, z - 0.012], null, 12);
  A.cylY('body', 'steelDark', 0.0048, 0.0048, 0.005, [x, cy + R + 0.017, z - 0.012], null, 10);
  A.cylY('body', 'accent', 0.0086, 0.0094, 0.015, [x - R - 0.006, cy, z - 0.012], [0, 0, Math.PI / 2], 12);
  A.cylY('body', 'accent', 0.0070, 0.0078, 0.012, [x, cy - R - 0.005, z + 0.014], [Math.PI, 0, 0], 10);

  A.add('body', 'glass', discGeo(R + 0.0075, 22), [x, cy, zF - 0.052], [0, Math.PI, 0]);
  A.add('body', 'glass', discGeo(R - 0.001, 20), [x, cy, zR + 0.030]);

  // The scope "picture": reticle plus a mask that only fades in when aiming.
  const mat = reticleMaterial(scopeTexture(), 1.0);
  mat.blending = THREE.NormalBlending;
  mat.opacity = 0;
  const ret = quad(0.052, mat, zR + 0.026, cy, x);

  const maskMat = new THREE.MeshBasicMaterial({
    color: 0x05070a, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
  });
  maskMat.userData.__gfxSkip = true;
  const mask = new THREE.Mesh(new THREE.RingGeometry(0.0255, 0.30, 40, 1), maskMat);
  mask.position.set(x, cy, zR + 0.030);
  mask.renderOrder = 19;
  mask.frustumCulled = false;

  A.attach('body', ret);
  A.attach('body', mask);

  return { sight: [x, cy, zR + 0.030], reticle: ret, reticleMat: mat, mask, maskMat };
}

/** Shotgun rib with a ghost ring and a glowing front bead. */
function beadSight(A, x, y, z) {
  const cy = y + 0.010;
  // ventilated rib
  A.box('body', 'bodyDark', [0.014, 0.005, 0.30], [x, cy, z - 0.10], null, 0.0012);
  for (let i = 0; i < 9; i++) {
    A.box('body', 'body', [0.016, 0.006, 0.006], [x, cy - 0.0015, z - 0.24 + i * 0.030], null, 0.0012);
  }
  // rear ghost ring
  A.torus('body', 'accent', 0.0072, 0.0018, [x, cy + 0.008, z + 0.045], null, 6, 16);
  A.box('body', 'accent', [0.004, 0.010, 0.005], [x, cy + 0.003, z + 0.045], null, 0.001);
  // front post + bead
  A.box('body', 'accent', [0.003, 0.008, 0.004], [x, cy + 0.005, z - 0.245], null, 0.0008);

  const mat = reticleMaterial(dotTexture('#ff8c1a', 1.25), 1.5);
  const ret = quad(0.011, mat, z - 0.247, cy + 0.0095, x);
  A.attach('body', ret);

  return { sight: [x, cy + 0.0095, z - 0.10], reticle: ret, reticleMat: mat, mask: null };
}

/** Compact reflex sight for the sidearm. */
function miniDot(A, x, y, z) {
  const cy = y + 0.016;
  A.box('body', 'bodyDark', [0.024, 0.008, 0.032], [x, y + 0.004, z], null, 0.0014);
  A.box('body', 'body', [0.0045, 0.022, 0.030], [x - 0.0098, cy, z], null, 0.0012);
  A.box('body', 'body', [0.0045, 0.022, 0.030], [x + 0.0098, cy, z], null, 0.0012);
  A.box('body', 'body', [0.024, 0.005, 0.011], [x, cy + 0.0105, z + 0.010], null, 0.0012);
  A.add('body', 'glass', boxGeo(0.016, 0.019, 0.0022, 0.0006, 1), [x, cy, z - 0.008], [0.13, 0, 0]);

  const mat = reticleMaterial(dotTexture('#ff3a24', 1), 1.9);
  const ret = quad(0.018, mat, z - 0.010, cy, x);
  A.attach('body', ret);

  return { sight: [x, cy, z - 0.008], reticle: ret, reticleMat: mat, mask: null };
}

export default { buildOptic, dotTexture, holoTexture, scopeTexture };
