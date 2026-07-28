import * as THREE from 'three';
import { J } from './Skeleton.js';
import { BODY } from './BotBody.js';

/**
 * Separable hitboxes, resolved analytically against the live pose.
 *
 * Bots are drawn as instanced parts, so there is no per-bot Mesh for a
 * BVH/Raycaster to hit — and putting animated characters into the world BVH
 * would mean rebuilding it every frame. Instead the AI wraps `world.raycast`:
 * the static BVH answer is compared against a handful of ray/capsule tests and
 * the nearer one wins.
 *
 * The returned record is exactly the collision contract's shape, with
 * `surface: 'flesh'` (so impacts and audio pick the right response) and
 * `object.userData.entityId` set — which is all `WeaponSystem._traceShot`
 * needs to already deal damage to a bot with no changes on its side.
 * `object.userData.part` additionally carries head/torso/arm/leg, so the
 * hardcoded `isHeadshot: false` there can be fixed later without touching us.
 */

export const PART = {
  HEAD: 'head', TORSO: 'torso', ARM: 'arm', LEG: 'leg',
};

/**
 * Capsule chains per part. Each entry: [partKey, jointA, jointB, radiusKey].
 * The torso runs pelvis -> chest and is fattened; the head is a single sphere
 * (a capsule of zero length) at the head joint.
 */
const SEGMENTS = [
  [PART.TORSO, J.PELVIS, J.CHEST, 'torso'],
  [PART.TORSO, J.CHEST, J.HEAD, 'neck'],
  [PART.HEAD, J.HEAD, J.HEAD, 'head'],
  [PART.ARM, J.SHOULDER_L, J.ELBOW_L, 'arm'],
  [PART.ARM, J.ELBOW_L, J.HAND_L, 'arm'],
  [PART.ARM, J.SHOULDER_R, J.ELBOW_R, 'arm'],
  [PART.ARM, J.ELBOW_R, J.HAND_R, 'arm'],
  [PART.LEG, J.HIP_L, J.KNEE_L, 'leg'],
  [PART.LEG, J.KNEE_L, J.FOOT_L, 'leg'],
  [PART.LEG, J.HIP_R, J.KNEE_R, 'leg'],
  [PART.LEG, J.KNEE_R, J.FOOT_R, 'leg'],
];

const RADII = {
  head: BODY.headRadius,
  neck: 0.115,
  torso: BODY.torsoRadius,
  arm: BODY.armRadius,
  leg: BODY.legRadius,
};

/**
 * Ray vs. capsule (Inigo Quilez's formulation). `d` must be unit length.
 * @returns {number} nearest positive t, or -1.
 */
export function rayCapsule(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, r) {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const oax = ox - ax, oay = oy - ay, oaz = oz - az;
  const baba = bax * bax + bay * bay + baz * baz;
  const bard = bax * dx + bay * dy + baz * dz;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = dx * oax + dy * oay + dz * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;

  if (baba > 1e-9) {
    const A = baba - bard * bard;
    const B = baba * rdoa - baoa * bard;
    const C = baba * oaoa - baoa * baoa - r * r * baba;
    const h = B * B - A * C;
    if (h >= 0 && Math.abs(A) > 1e-9) {
      const t = (-B - Math.sqrt(h)) / A;
      const y = baoa + t * bard;
      if (y > 0 && y < baba && t >= 0) return t;
    }
  }
  // Spherical caps (also the whole test for a zero-length capsule).
  let best = -1;
  for (let cap = 0; cap < 2; cap++) {
    const cx = cap === 0 ? ax : bx, cy = cap === 0 ? ay : by, cz = cap === 0 ? az : bz;
    const ex = ox - cx, ey = oy - cy, ez = oz - cz;
    const B = ex * dx + ey * dy + ez * dz;
    const C = ex * ex + ey * ey + ez * ez - r * r;
    const h = B * B - C;
    if (h <= 0) continue;
    const t = -B - Math.sqrt(h);
    if (t >= 0 && (best < 0 || t < best)) best = t;
    if (baba <= 1e-9) break;
  }
  return best;
}

/** Closest point on segment ab to p, written into out (3 floats). */
function closestOnSegment(px, py, pz, ax, ay, az, bx, by, bz, out) {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const l2 = bax * bax + bay * bay + baz * baz;
  let t = 0;
  if (l2 > 1e-9) {
    t = ((px - ax) * bax + (py - ay) * bay + (pz - az) * baz) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  out[0] = ax + bax * t; out[1] = ay + bay * t; out[2] = az + baz * t;
}

const _seg = new Float32Array(3);

/**
 * Registry of hittable bodies. Bots register a pose reference plus one marker
 * Object3D per damage region; nothing here allocates during a trace.
 */
export class HitRegistry {
  constructor() {
    this.bodies = [];       // { id, pose, scale, alive, centerY, radius, markers }
    this.byId = new Map();
    this.hit = {
      body: null, part: PART.TORSO, distance: 0,
      px: 0, py: 0, pz: 0, nx: 0, ny: 1, nz: 0, object: null,
    };
  }

  register(id, pose, scale = 1) {
    const markers = {};
    for (const key of [PART.HEAD, PART.TORSO, PART.ARM, PART.LEG]) {
      const o = new THREE.Object3D();
      o.name = `ai:hitbox:${id}:${key}`;
      o.userData.entityId = id;
      o.userData.part = key;
      o.userData.surface = 'flesh';
      o.userData.isBot = true;
      markers[key] = o;
    }
    const body = { id, pose, scale, alive: true, markers, cull: 1.35 * scale };
    this.bodies.push(body);
    this.byId.set(id, body);
    return body;
  }

  unregister(id) {
    const b = this.byId.get(id);
    if (!b) return;
    this.byId.delete(id);
    const i = this.bodies.indexOf(b);
    if (i >= 0) this.bodies.splice(i, 1);
  }

  clear() { this.bodies.length = 0; this.byId.clear(); }

  /**
   * Nearest bot hit along a ray.
   * @returns {object|null} the shared hit record (do not retain)
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist, skipId = null) {
    let bestT = maxDist;
    let bestBody = null;
    let bestPart = PART.TORSO;
    let bestA = 0, bestB = 0, bestR = 0;

    for (let i = 0; i < this.bodies.length; i++) {
      const body = this.bodies[i];
      if (!body.alive || body.id === skipId) continue;
      const pose = body.pose;

      // Broadphase: sphere around the pelvis/chest midpoint.
      const cx = (pose[J.PELVIS * 3] + pose[J.CHEST * 3]) * 0.5;
      const cy = (pose[J.PELVIS * 3 + 1] + pose[J.CHEST * 3 + 1]) * 0.5;
      const cz = (pose[J.PELVIS * 3 + 2] + pose[J.CHEST * 3 + 2]) * 0.5;
      const ex = cx - ox, ey = cy - oy, ez = cz - oz;
      const proj = ex * dx + ey * dy + ez * dz;
      if (proj < -body.cull || proj > bestT + body.cull) continue;
      const perp2 = (ex * ex + ey * ey + ez * ez) - proj * proj;
      if (perp2 > body.cull * body.cull) continue;

      const s = body.scale;
      for (let k = 0; k < SEGMENTS.length; k++) {
        const sg = SEGMENTS[k];
        const a = sg[1] * 3, b = sg[2] * 3;
        const r = RADII[sg[3]] * s;
        const t = rayCapsule(ox, oy, oz, dx, dy, dz,
          pose[a], pose[a + 1], pose[a + 2],
          pose[b], pose[b + 1], pose[b + 2], r);
        if (t >= 0 && t < bestT) {
          bestT = t; bestBody = body; bestPart = sg[0];
          bestA = a; bestB = b; bestR = r;
        }
      }
    }

    if (!bestBody) return null;
    const h = this.hit;
    h.body = bestBody;
    h.part = bestPart;
    h.distance = bestT;
    h.px = ox + dx * bestT; h.py = oy + dy * bestT; h.pz = oz + dz * bestT;
    const pose = bestBody.pose;
    closestOnSegment(h.px, h.py, h.pz,
      pose[bestA], pose[bestA + 1], pose[bestA + 2],
      pose[bestB], pose[bestB + 1], pose[bestB + 2], _seg);
    let nx = h.px - _seg[0], ny = h.py - _seg[1], nz = h.pz - _seg[2];
    const l = Math.hypot(nx, ny, nz) || 1;
    h.nx = nx / l; h.ny = ny / l; h.nz = nz / l;
    h.object = bestBody.markers[bestPart];
    return h;
  }
}

/** Damage multiplier for a resolved part. */
export function partMultiplier(part, cfg) {
  if (part === PART.HEAD) return cfg?.headshotMul ?? 2.0;
  if (part === PART.LEG) return cfg?.legshotMul ?? 0.8;
  if (part === PART.ARM) return cfg?.armshotMul ?? 0.9;
  return 1.0;
}

export default HitRegistry;
