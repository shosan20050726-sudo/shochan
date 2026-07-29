import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import Materials from '../materials/MaterialLibrary.js';
import { J, BIND, LEN, BONES, BONE_BIND, HIDDEN, boneMatrix, frameMatrix, scaleColumns } from './Skeleton.js';

/**
 * Procedural humanoid bodies, drawn as instanced parts.
 *
 * Every bot shares one geometry set; a body is eleven instance writes per
 * frame. Twelve bots therefore cost eleven draw calls, not a hundred and
 * thirty — which is the only way a squad-based AI stays inside the frame
 * budget alongside the map.
 *
 * Shapes follow the project's geometry rules: no perfectly sharp 90-degree
 * edges anywhere (every plate is a RoundedBoxGeometry, every limb a capsule),
 * and UVs are authored in *tile units* so texel density is identical on a
 * 6 cm pouch and a 30 cm chest plate.
 *
 * Local convention, matching the camera rig: +Y up, -Z forward.
 */

/** Texture tiles per metre. ~1 tile every 36 cm reads as fabric/plate weave. */
const TILES = 2.8;

const _m = new THREE.Matrix4();
const _ms = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3();

/* ---------------------------------------------------------- geometry -- */

/** UVs in metres * TILES so every part has the same texel density. */
function tileUv(g, metres) {
  const uv = g.attributes.uv;
  if (!uv) return g;
  const k = Math.max(0.04, metres) * TILES;
  const a = uv.array;
  for (let i = 0; i < a.length; i++) a[i] *= k;
  uv.needsUpdate = true;
  return g;
}

function place(g, x, y, z, rx = 0, ry = 0, rz = 0) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _v.set(x, y, z);
  _m.compose(_v, _q, _s);
  g.applyMatrix4(_m);
  return g;
}

/** Chamfered box. `r` is the bevel that catches the specular highlight. */
function box(w, h, d, r, x, y, z, rx, ry, rz) {
  const rad = Math.min(r, w * 0.49, h * 0.49, d * 0.49);
  const g = new RoundedBoxGeometry(w, h, d, 1, rad);
  tileUv(g, (w + h + d) / 3);
  return place(g, x, y, z, rx, ry, rz);
}

function capsule(radius, length, x, y, z, rx, ry, rz) {
  const g = new THREE.CapsuleGeometry(radius, Math.max(0.01, length), 3, 10).toNonIndexed();
  tileUv(g, radius * 2 + length);
  return place(g, x, y, z, rx, ry, rz);
}

function cyl(rt, rb, h, seg, x, y, z, rx, ry, rz) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1).toNonIndexed();
  tileUv(g, (rt + rb) + h);
  return place(g, x, y, z, rx, ry, rz);
}

function merge(list) {
  const clean = list.filter(Boolean);
  const g = clean.length === 1 ? clean[0] : mergeGeometries(clean, false);
  if (clean.length > 1) for (const c of clean) c.dispose();
  g.computeBoundingSphere();
  return g;
}

/* ------------------------------------------------------------- parts -- */

const HALF = { arm: LEN.upperArm * 0.5, fore: LEN.foreArm * 0.5, thigh: LEN.thigh * 0.5, shin: LEN.shin * 0.5 };

/**
 * Helmet + skull + neck. Origin at the HEAD joint.
 *
 * Sized deliberately small: at the original dimensions the helmet was about
 * 1/5.6 of standing height against a human's 1/7.5, which is the single thing
 * that made the whole figure read as a toy. It also sat low enough to swallow
 * the collar, so the head appeared welded to the shoulders with no neck.
 */
function buildHelmet() {
  return merge([
    box(0.170, 0.194, 0.196, 0.066, 0, 0.026, 0.004),
    box(0.190, 0.132, 0.210, 0.064, 0, 0.084, 0.008),
    box(0.106, 0.080, 0.064, 0.025, 0, 0.042, 0.103),
    box(0.112, 0.084, 0.090, 0.032, 0, -0.052, -0.050),
    box(0.050, 0.040, 0.082, 0.016, 0.089, 0.064, 0.010),
    capsule(0.052, 0.085, 0, -0.150, 0.006),
  ]);
}

/** Emissive optics band — the enemy read at distance. */
function buildVisor() {
  return merge([
    box(0.138, 0.054, 0.042, 0.019, 0, 0.020, -0.088),
    box(0.026, 0.024, 0.026, 0.009, 0.092, 0.066, -0.026),
  ]);
}

/** Torso, chest rig, pack. Origin at the CHEST joint. */
function buildChest() {
  return merge([
    box(0.345, 0.440, 0.235, 0.085, 0, -0.105, 0),
    box(0.300, 0.235, 0.070, 0.030, 0, -0.036, -0.112),
    box(0.240, 0.140, 0.058, 0.024, 0, -0.238, -0.100),
    box(0.080, 0.106, 0.060, 0.022, -0.096, -0.146, -0.134),
    box(0.080, 0.106, 0.060, 0.022, 0.096, -0.146, -0.134),
    box(0.276, 0.300, 0.146, 0.055, 0, -0.102, 0.156),
    box(0.062, 0.098, 0.300, 0.022, -0.116, 0.046, 0.004),
    box(0.062, 0.098, 0.300, 0.022, 0.116, 0.046, 0.004),
    // Collar kept low and narrow so the neck capsule above it stays visible.
    box(0.168, 0.068, 0.168, 0.040, 0, 0.104, 0.005),
  ]);
}

/** Hips, belt, holster. Origin at the PELVIS joint. */
function buildPelvis() {
  return merge([
    box(0.300, 0.236, 0.216, 0.075, 0, -0.030, 0),
    box(0.326, 0.056, 0.238, 0.022, 0, 0.056, 0),
    box(0.076, 0.132, 0.076, 0.026, -0.166, -0.092, 0.010),
    box(0.066, 0.136, 0.062, 0.022, 0.162, -0.096, 0.020),
  ]);
}

/** Shoulder plate. Symmetric so one geometry serves both sides. */
function buildShoulder() {
  return merge([
    box(0.138, 0.118, 0.190, 0.052, 0, 0.010, 0),
    box(0.100, 0.040, 0.150, 0.018, 0, -0.056, 0),
  ]);
}

function buildUpperArm() {
  return merge([
    capsule(0.062, Math.max(0.02, LEN.upperArm - 0.124), 0, 0, 0),
    box(0.118, 0.042, 0.118, 0.016, 0, 0.030, 0),
  ]);
}

function buildForeArm() {
  return merge([
    capsule(0.050, Math.max(0.02, LEN.foreArm - 0.100), 0, 0, 0),
    box(0.104, 0.132, 0.100, 0.030, 0, 0.026, -0.008),
    box(0.086, 0.100, 0.082, 0.030, 0, HALF.fore - 0.012, 0.010),
  ]);
}

/**
 * Thighs are the easiest thing on a humanoid to get wrong: at radius 0.086 the
 * two capsules together were wider than the pelvis and read as inflated shorts.
 * A real thigh is roughly 0.07 m in radius at the hip.
 */
function buildThigh() {
  return merge([
    capsule(0.070, Math.max(0.02, LEN.thigh - 0.140), 0, 0, 0),
    box(0.112, 0.100, 0.114, 0.034, 0, -HALF.thigh + 0.080, -0.006),
  ]);
}

function buildShin() {
  return merge([
    capsule(0.058, Math.max(0.02, LEN.shin - 0.116), 0, 0, 0),
    box(0.102, 0.094, 0.094, 0.029, 0, -HALF.shin + 0.052, -0.026),
    box(0.098, 0.192, 0.096, 0.029, 0, -0.048, -0.012),
  ]);
}

/** Origin at the FOOT (ankle) joint; the sole lands on y = 0 in bind pose. */
function buildBoot() {
  return merge([
    box(0.106, 0.096, 0.254, 0.035, 0, -0.043, -0.034),
    box(0.092, 0.052, 0.078, 0.020, 0, -0.066, 0.056),
  ]);
}

/** Compact carbine. Origin at the grip (the right hand), -Z down the bore. */
function buildWeapon() {
  return merge([
    box(0.052, 0.096, 0.360, 0.016, 0, 0.036, -0.050),
    box(0.048, 0.058, 0.220, 0.014, 0, 0.038, -0.292),
    cyl(0.014, 0.014, 0.230, 10, 0, 0.040, -0.440, Math.PI * 0.5, 0, 0),
    cyl(0.022, 0.019, 0.062, 10, 0, 0.040, -0.556, Math.PI * 0.5, 0, 0),
    box(0.030, 0.042, 0.106, 0.012, 0, 0.100, -0.062),
    box(0.032, 0.150, 0.066, 0.013, 0, -0.052, -0.104, 0.16, 0, 0),
    box(0.042, 0.082, 0.200, 0.018, 0, 0.020, 0.188),
    box(0.038, 0.106, 0.050, 0.016, 0, -0.042, 0.020, -0.26, 0, 0),
  ]);
}

/**
 * Part table. `per` is instances per body; `frame` names how the transform is
 * produced. Order is fixed — `slot * per + k` is a stable instance index, so
 * per-body instance colours only need writing once, at spawn.
 */
const PARTS = [
  { key: 'helmet', mat: 'armor', per: 1, build: buildHelmet },
  { key: 'visor', mat: 'visor', per: 1, build: buildVisor },
  { key: 'chest', mat: 'armor', per: 1, build: buildChest },
  { key: 'pelvis', mat: 'suit', per: 1, build: buildPelvis },
  { key: 'shoulder', mat: 'armor', per: 2, build: buildShoulder },
  { key: 'upperArm', mat: 'suit', per: 2, build: buildUpperArm, bone: true },
  { key: 'foreArm', mat: 'armor', per: 2, build: buildForeArm, bone: true },
  { key: 'thigh', mat: 'suit', per: 2, build: buildThigh, bone: true },
  { key: 'shin', mat: 'armor', per: 2, build: buildShin, bone: true },
  { key: 'boot', mat: 'suit', per: 2, build: buildBoot },
  { key: 'weapon', mat: 'gun', per: 1, build: buildWeapon },
];

/** Per-bone write cursors, reused every frame (module scope: no allocation). */
const CURSOR = { upperArm: 0, foreArm: 0, thigh: 0, shin: 0 };

/* --------------------------------------------------------- renderer -- */

export class BodyRenderer {
  constructor(maxBodies) {
    this.max = maxBodies;
    this.meshes = new Map();
    this.parts = new Map();        // key -> { mesh, per }
    this.group = new THREE.Group();
    this.group.name = 'ai:bodies';
    this.group.frustumCulled = false;
    this.materials = null;
    this.slotScale = new Float32Array(maxBodies).fill(1);
    this._built = false;
    this._dirty = false;
    this._scale = 1;
  }

  /** Materials come from the shared library so bots shade like the world. */
  _buildMaterials() {
    // metalness is a *multiplier* on the surface's baked map, so passing the
    // surface's own value (0.25) means "painted plate with bare steel showing
    // through the chips" rather than "solid machined metal".
    const armor = Materials.get('painted_metal', {
      color: 0x5d6a63, scale: 1, roughness: 0.58, metalness: 0.24,
      detail: { fadeStart: 4, fadeEnd: 26, strength: 0.55 },
    });
    const suit = Materials.get('rubber', {
      color: 0x2c3138, scale: 1, roughness: 0.86,
      detail: { fadeStart: 4, fadeEnd: 22, strength: 0.6 },
    });
    const visor = Materials.get('plastic', {
      color: 0x16222e, scale: 1, roughness: 0.16,
      emissive: 0x37a0ff, emissiveIntensity: 2.4,
    });
    // Deliberately rough and dark: at roughness 0.44 with full metalness the
    // receiver caught the sun and clipped to pure white, and the bloom
    // threshold then turned a rifle into a lens flare.
    const gun = Materials.get('metal', {
      color: 0x2e333a, scale: 1, roughness: 0.66, metalness: 0.8,
    });
    this.materials = { armor, suit, visor, gun };
  }

  build(scene) {
    if (this._built) return this;
    this._buildMaterials();

    for (const part of PARTS) {
      const geo = part.build();
      const capacity = this.max * part.per;
      const mesh = new THREE.InstancedMesh(geo, this.materials[part.mat], capacity);
      mesh.name = `ai:${part.key}`;
      mesh.castShadow = true;
      mesh.receiveShadow = part.key !== 'visor';
      mesh.frustumCulled = false;             // instances move far outside the base bounds
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < capacity; i++) mesh.setMatrixAt(i, HIDDEN);
      mesh.instanceMatrix.needsUpdate = true;
      this.meshes.set(part.key, mesh);
      this.parts.set(part.key, { mesh, per: part.per, bone: !!part.bone });
      this.group.add(mesh);
    }

    scene?.add(this.group);
    this._built = true;
    return this;
  }

  hide(slot) {
    if (!this._built) return;
    for (const part of PARTS) {
      const mesh = this.meshes.get(part.key);
      if (!mesh) continue;
      for (let k = 0; k < part.per; k++) mesh.setMatrixAt(slot * part.per + k, HIDDEN);
    }
    this._dirty = true;
  }

  /**
   * Never scales `m` in place: the head matrix is handed to both the helmet
   * and the visor, and mutating it would scale the visor twice and float it
   * off the face.
   */
  _set(key, slot, k, m) {
    const p = this.parts.get(key);
    if (!p) return;
    let out = m;
    if (this._scale !== 1) {
      out = _ms.copy(m);
      // Bone-aligned parts already carry the body scale in their Y column
      // (the bone got longer), so only the cross-section is scaled again.
      if (p.bone) scaleColumns(out, this._scale, 1, this._scale);
      else scaleColumns(out, this._scale, this._scale, this._scale);
    }
    p.mesh.setMatrixAt(slot * p.per + k, out);
  }

  /**
   * Write one body's transforms.
   *
   * @param {number} slot          stable instance slot
   * @param {Float32Array} pose    45 floats, world joint positions
   * @param {THREE.Vector3} fwd    body facing (unit, world)
   * @param {THREE.Vector3} aim    where the head/weapon point (unit, world)
   * @param {THREE.Vector3} gunPos world position of the weapon grip
   */
  writeBody(slot, pose, fwd, aim, gunPos, scale = 1) {
    if (!this._built) return;
    this._scale = scale;

    // --- torso / pelvis ------------------------------------------------
    _up.set(pose[J.CHEST * 3] - pose[J.PELVIS * 3],
      pose[J.CHEST * 3 + 1] - pose[J.PELVIS * 3 + 1],
      pose[J.CHEST * 3 + 2] - pose[J.PELVIS * 3 + 2]);
    if (_up.lengthSq() < 1e-8) _up.set(0, 1, 0);

    frameMatrix(_up.x, _up.y, _up.z, fwd.x, fwd.y, fwd.z, _m);
    _m.setPosition(pose[J.CHEST * 3], pose[J.CHEST * 3 + 1], pose[J.CHEST * 3 + 2]);
    this._set('chest', slot, 0, _m);

    frameMatrix(_up.x, _up.y, _up.z, fwd.x, fwd.y, fwd.z, _m);
    _m.setPosition(pose[J.PELVIS * 3], pose[J.PELVIS * 3 + 1], pose[J.PELVIS * 3 + 2]);
    this._set('pelvis', slot, 0, _m);

    // --- shoulders (chest orientation, shoulder positions) --------------
    frameMatrix(_up.x, _up.y, _up.z, fwd.x, fwd.y, fwd.z, _m);
    _m.setPosition(pose[J.SHOULDER_L * 3], pose[J.SHOULDER_L * 3 + 1], pose[J.SHOULDER_L * 3 + 2]);
    this._set('shoulder', slot, 0, _m);
    frameMatrix(_up.x, _up.y, _up.z, fwd.x, fwd.y, fwd.z, _m);
    _m.setPosition(pose[J.SHOULDER_R * 3], pose[J.SHOULDER_R * 3 + 1], pose[J.SHOULDER_R * 3 + 2]);
    this._set('shoulder', slot, 1, _m);

    // --- head (looks where the bot aims) --------------------------------
    _up.set(pose[J.HEAD * 3] - pose[J.CHEST * 3],
      pose[J.HEAD * 3 + 1] - pose[J.CHEST * 3 + 1],
      pose[J.HEAD * 3 + 2] - pose[J.CHEST * 3 + 2]);
    if (_up.lengthSq() < 1e-8) _up.set(0, 1, 0);
    frameMatrix(_up.x, _up.y, _up.z, aim.x, aim.y, aim.z, _m);
    _m.setPosition(pose[J.HEAD * 3], pose[J.HEAD * 3 + 1], pose[J.HEAD * 3 + 2]);
    this._set('helmet', slot, 0, _m);
    this._set('visor', slot, 0, _m);

    // --- limbs ----------------------------------------------------------
    CURSOR.upperArm = 0; CURSOR.foreArm = 0; CURSOR.thigh = 0; CURSOR.shin = 0;
    for (let i = 0; i < BONES.length; i++) {
      const b = BONES[i];
      boneMatrix(pose, b[0], b[1], BONE_BIND[b[2]], _m);
      this._set(b[2], slot, CURSOR[b[2]]++, _m);
    }

    // --- boots (foot facing, softened toward the shin direction) ---------
    this._boot(slot, 0, pose, J.KNEE_L, J.FOOT_L, fwd);
    this._boot(slot, 1, pose, J.KNEE_R, J.FOOT_R, fwd);

    // --- weapon ----------------------------------------------------------
    // Roll the gun so its "up" is genuinely perpendicular to the bore.
    _up.set(0, 1, 0).addScaledVector(aim, -aim.y);
    if (_up.lengthSq() < 1e-6) _up.set(0, 1, 0);
    frameMatrix(_up.x, _up.y, _up.z, aim.x, aim.y, aim.z, _m);
    _m.setPosition(gunPos.x, gunPos.y, gunPos.z);
    this._set('weapon', slot, 0, _m);

    this._scale = 1;
    this._dirty = true;
  }

  _boot(slot, k, pose, knee, foot, fwd) {
    _up.set(pose[knee * 3] - pose[foot * 3],
      pose[knee * 3 + 1] - pose[foot * 3 + 1],
      pose[knee * 3 + 2] - pose[foot * 3 + 2]);
    if (_up.lengthSq() < 1e-8) _up.set(0, 1, 0); else _up.normalize();
    // Mostly level, with a little of the leg's lean so a raised foot rolls.
    _up.set(_up.x * 0.34, _up.y * 0.34 + 0.66, _up.z * 0.34);
    frameMatrix(_up.x, _up.y, _up.z, fwd.x, fwd.y, fwd.z, _m);
    _m.setPosition(pose[foot * 3], pose[foot * 3 + 1], pose[foot * 3 + 2]);
    this._set('boot', slot, k, _m);
  }

  flush() {
    if (!this._built || !this._dirty) return;
    this._dirty = false;
    for (const mesh of this.meshes.values()) mesh.instanceMatrix.needsUpdate = true;
  }

  setVisible(v) { this.group.visible = v; }

  dispose() {
    for (const mesh of this.meshes.values()) {
      mesh.geometry.dispose();
      this.group.remove(mesh);
      mesh.dispose?.();
    }
    this.meshes.clear();
    this.group.parent?.remove(this.group);
    this._built = false;
  }
}

/** Bind-pose reference heights, used for hitbox sizing and eye offsets. */
export const BODY = {
  eyeHeight: BIND[J.HEAD * 3 + 1] + 0.02,
  chestHeight: BIND[J.CHEST * 3 + 1],
  pelvisHeight: BIND[J.PELVIS * 3 + 1],
  headRadius: 0.145,
  torsoRadius: 0.185,
  armRadius: 0.095,
  legRadius: 0.125,
  total: BIND[J.HEAD * 3 + 1] + 0.16,
};

export default BodyRenderer;
