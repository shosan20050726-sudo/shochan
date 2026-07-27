/**
 * Ragdoll — position-based (verlet) humanoid ragdolls.
 *
 * Deliberately simple and stable: particles integrate with verlet, bones are
 * distance constraints solved by relaxation, and each particle is depenetrated
 * against the world BVH as a sphere. No angular joints — cross-bracing
 * constraints give the body enough stiffness to read as a body rather than a
 * bag of peas, while still flopping convincingly.
 *
 * Another system uses it like:
 *
 *   const rw = ctx.engine.get('player')?.ragdolls;
 *   const rd = rw.spawn(position, { yaw, velocity, impulsePoint, impulse });
 *   ...
 *   rd.getBone(i, outA, outB);   // per frame, to drive skinned/box meshes
 */
import * as THREE from 'three';
import CFG from '../core/Config.js';

/* Particle indices */
export const JOINT = {
  HEAD: 0, CHEST: 1, PELVIS: 2,
  SHOULDER_L: 3, ELBOW_L: 4, HAND_L: 5,
  SHOULDER_R: 6, ELBOW_R: 7, HAND_R: 8,
  HIP_L: 9, KNEE_L: 10, FOOT_L: 11,
  HIP_R: 12, KNEE_R: 13, FOOT_R: 14,
};
const N = 15;

/** Local rest layout (metres, y up, facing -z), roughly a 1.8 m human. */
const REST = new Float32Array([
  0.00, 1.70, 0.00,   // head
  0.00, 1.42, 0.00,   // chest
  0.00, 1.00, 0.00,   // pelvis
  -0.19, 1.44, 0.00,  // shoulder L
  -0.24, 1.16, 0.02,  // elbow L
  -0.26, 0.90, 0.04,  // hand L
  0.19, 1.44, 0.00,   // shoulder R
  0.24, 1.16, 0.02,   // elbow R
  0.26, 0.90, 0.04,   // hand R
  -0.11, 0.98, 0.00,  // hip L
  -0.12, 0.55, 0.01,  // knee L
  -0.12, 0.09, 0.00,  // foot L
  0.11, 0.98, 0.00,   // hip R
  0.12, 0.55, 0.01,   // knee R
  0.12, 0.09, 0.00,   // foot R
]);

/** [a, b, stiffness] — the last group are bracing constraints. */
const BONES = [
  [JOINT.HEAD, JOINT.CHEST, 1], [JOINT.CHEST, JOINT.PELVIS, 1],
  [JOINT.CHEST, JOINT.SHOULDER_L, 1], [JOINT.SHOULDER_L, JOINT.ELBOW_L, 1], [JOINT.ELBOW_L, JOINT.HAND_L, 1],
  [JOINT.CHEST, JOINT.SHOULDER_R, 1], [JOINT.SHOULDER_R, JOINT.ELBOW_R, 1], [JOINT.ELBOW_R, JOINT.HAND_R, 1],
  [JOINT.PELVIS, JOINT.HIP_L, 1], [JOINT.HIP_L, JOINT.KNEE_L, 1], [JOINT.KNEE_L, JOINT.FOOT_L, 1],
  [JOINT.PELVIS, JOINT.HIP_R, 1], [JOINT.HIP_R, JOINT.KNEE_R, 1], [JOINT.KNEE_R, JOINT.FOOT_R, 1],
];
const BRACES = [
  [JOINT.SHOULDER_L, JOINT.SHOULDER_R, 0.9], [JOINT.HIP_L, JOINT.HIP_R, 0.9],
  [JOINT.SHOULDER_L, JOINT.PELVIS, 0.55], [JOINT.SHOULDER_R, JOINT.PELVIS, 0.55],
  [JOINT.HEAD, JOINT.PELVIS, 0.35],
  [JOINT.CHEST, JOINT.HIP_L, 0.5], [JOINT.CHEST, JOINT.HIP_R, 0.5],
  [JOINT.SHOULDER_L, JOINT.HAND_L, 0.16], [JOINT.SHOULDER_R, JOINT.HAND_R, 0.16],
  [JOINT.HIP_L, JOINT.FOOT_L, 0.16], [JOINT.HIP_R, JOINT.FOOT_R, 0.16],
];
const ALL = BONES.concat(BRACES);

const _tmp = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

export class Ragdoll {
  constructor(id) {
    this.id = id;
    this.alive = false;
    this.pos = new Float32Array(N * 3);
    this.old = new Float32Array(N * 3);
    this.radius = new Float32Array(N);
    this.rest = new Float32Array(ALL.length);
    this.age = 0;
    this.sleep = 0;
    this.userData = null;
  }

  init(origin, opts = {}) {
    const yaw = opts.yaw ?? 0;
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const scale = opts.scale ?? 1;
    const vx = opts.vx ?? 0, vy = opts.vy ?? 0, vz = opts.vz ?? 0;
    const dt = CFG.time.fixedStep;

    for (let i = 0; i < N; i++) {
      const r = i * 3;
      const lx = REST[r] * scale, ly = REST[r + 1] * scale, lz = REST[r + 2] * scale;
      const wx = origin.x + lx * cs + lz * sn;
      const wy = origin.y + ly;
      const wz = origin.z + (-lx * sn + lz * cs);
      this.pos[r] = wx; this.pos[r + 1] = wy; this.pos[r + 2] = wz;
      // Seed the implicit velocity through the previous position.
      this.old[r] = wx - vx * dt;
      this.old[r + 1] = wy - vy * dt;
      this.old[r + 2] = wz - vz * dt;
      this.radius[i] = 0.11 * scale;
    }
    this.radius[JOINT.HEAD] = 0.15 * scale;
    this.radius[JOINT.CHEST] = 0.18 * scale;
    this.radius[JOINT.PELVIS] = 0.17 * scale;

    for (let c = 0; c < ALL.length; c++) {
      const a = ALL[c][0] * 3, b = ALL[c][1] * 3;
      this.rest[c] = Math.hypot(
        this.pos[a] - this.pos[b], this.pos[a + 1] - this.pos[b + 1], this.pos[a + 2] - this.pos[b + 2]);
    }
    this.age = 0;
    this.sleep = 0;
    this.alive = true;
    this.userData = opts.userData ?? null;
    if (opts.impulse) this.applyImpulse(opts.impulse, opts.impulsePoint ?? origin, opts.impulseRadius ?? 0.9);
    return this;
  }

  /** Push particles near `point` outward — explosions, killing blows. */
  applyImpulse(strength, point, radius = 1.0) {
    const dt = CFG.time.fixedStep;
    for (let i = 0; i < N; i++) {
      const r = i * 3;
      const dx = this.pos[r] - point.x, dy = this.pos[r + 1] - point.y, dz = this.pos[r + 2] - point.z;
      const d = Math.hypot(dx, dy, dz);
      const k = Math.max(0, 1 - d / Math.max(radius, 1e-3));
      if (k <= 0) continue;
      const inv = d > 1e-5 ? 1 / d : 0;
      const s = strength * k * k * dt;
      this.old[r] -= dx * inv * s;
      this.old[r + 1] -= (dy * inv + 0.35) * s;
      this.old[r + 2] -= dz * inv * s;
    }
    this.sleep = 0;
  }

  /** Bounding centre (chest/pelvis average) — for culling and audio. */
  center(out) {
    const c = JOINT.CHEST * 3, p = JOINT.PELVIS * 3;
    return out.set(
      (this.pos[c] + this.pos[p]) * 0.5,
      (this.pos[c + 1] + this.pos[p + 1]) * 0.5,
      (this.pos[c + 2] + this.pos[p + 2]) * 0.5);
  }

  /** Endpoints of bone `i` (0..BONES.length-1). */
  getBone(i, outA, outB) {
    const a = BONES[i][0] * 3, b = BONES[i][1] * 3;
    outA.set(this.pos[a], this.pos[a + 1], this.pos[a + 2]);
    outB.set(this.pos[b], this.pos[b + 1], this.pos[b + 2]);
    return BONES[i];
  }

  static get boneCount() { return BONES.length; }

  /** Transform for a capsule/box mesh representing bone `i`. */
  getBoneTransform(i, outPos, outQuat) {
    const a = BONES[i][0] * 3, b = BONES[i][1] * 3;
    const ax = this.pos[a], ay = this.pos[a + 1], az = this.pos[a + 2];
    const bx = this.pos[b], by = this.pos[b + 1], bz = this.pos[b + 2];
    outPos.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
    _tmp.set(bx - ax, by - ay, bz - az);
    const len = _tmp.length() || 1e-5;
    _tmp.multiplyScalar(1 / len);
    outQuat.setFromUnitVectors(_up, _tmp);
    return len;
  }

  getPoint(i, out) {
    const r = i * 3;
    return out.set(this.pos[r], this.pos[r + 1], this.pos[r + 2]);
  }
}

export class RagdollWorld {
  constructor(collision, capacity = 12) {
    this.collision = collision;
    this.pool = [];
    for (let i = 0; i < capacity; i++) this.pool.push(new Ragdoll(i));
    this.active = [];
    this.gravity = CFG.move.gravity;
    this.damping = 0.995;
    this.iterations = 6;
    this.maxAge = 14;
    this._feet = new THREE.Vector3();
    this._prevFeet = new THREE.Vector3();
  }

  spawn(origin, opts = {}) {
    let rd = this.pool.find((r) => !r.alive);
    if (!rd) {
      // Recycle the oldest.
      rd = this.active.reduce((a, b) => (a.age > b.age ? a : b), this.active[0]);
      if (!rd) return null;
      this.despawn(rd);
    }
    rd.init(origin, opts);
    this.active.push(rd);
    return rd;
  }

  despawn(rd) {
    rd.alive = false;
    const i = this.active.indexOf(rd);
    if (i >= 0) this.active.splice(i, 1);
  }

  clear() { while (this.active.length) this.despawn(this.active[0]); }

  fixedUpdate(dt) {
    if (!this.active.length) return;
    const g = this.gravity * dt * dt;
    const coll = this.collision;

    for (let r = this.active.length - 1; r >= 0; r--) {
      const rd = this.active[r];
      rd.age += dt;
      if (rd.age > this.maxAge) { this.despawn(rd); continue; }
      if (rd.sleep > 1.5) continue;

      const pos = rd.pos, old = rd.old;
      let motion = 0;

      // --- verlet integrate ---
      for (let i = 0; i < N; i++) {
        const o = i * 3;
        for (let k = 0; k < 3; k++) {
          const cur = pos[o + k];
          let v = (cur - old[o + k]) * this.damping;
          if (v > 0.6) v = 0.6; else if (v < -0.6) v = -0.6;   // stability clamp
          old[o + k] = cur;
          pos[o + k] = cur + v + (k === 1 ? -g : 0);
          motion += v * v;
        }
      }

      // --- bone constraints (relaxation) ---
      for (let it = 0; it < this.iterations; it++) {
        for (let c = 0; c < ALL.length; c++) {
          const ai = ALL[c][0] * 3, bi = ALL[c][1] * 3, stiff = ALL[c][2];
          const dx = pos[bi] - pos[ai], dy = pos[bi + 1] - pos[ai + 1], dz = pos[bi + 2] - pos[ai + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
          const diff = ((d - rd.rest[c]) / d) * 0.5 * stiff;
          const ox = dx * diff, oy = dy * diff, oz = dz * diff;
          pos[ai] += ox; pos[ai + 1] += oy; pos[ai + 2] += oz;
          pos[bi] -= ox; pos[bi + 1] -= oy; pos[bi + 2] -= oz;
        }
      }

      // --- world collision: one sphere sweep per particle, once per tick ---
      if (coll?.ready) {
        for (let i = 0; i < N; i++) {
          const o = i * 3;
          const rad = rd.radius[i];
          this._feet.set(pos[o], pos[o + 1] - rad, pos[o + 2]);
          // The verlet "previous position" doubles as the known-good pose for
          // the tunnelling guard, so a fast limb can never end up inside a wall.
          this._prevFeet.set(old[o], old[o + 1] - rad, old[o + 2]);
          const depth = coll.resolve(this._feet, rad, rad * 2, null, this._prevFeet);
          if (depth > 0) {
            pos[o] = this._feet.x;
            pos[o + 1] = this._feet.y + rad;
            pos[o + 2] = this._feet.z;
            // Surface friction: bleed tangential velocity so limbs settle.
            old[o] += (pos[o] - old[o]) * 0.25;
            old[o + 2] += (pos[o + 2] - old[o + 2]) * 0.25;
          }
        }
      }

      rd.sleep = motion < 1e-6 ? rd.sleep + dt : 0;
    }
  }
}

export default RagdollWorld;
