import * as THREE from 'three';

/**
 * The bot skeleton.
 *
 * Fifteen joints, laid out to match `src/physics/Ragdoll.js` exactly — same
 * indices, same bind proportions. That is deliberate: when a bot dies we hand
 * its current pose to the shared RagdollWorld and keep rendering the *same*
 * instanced body from `ragdoll.pos`. One rig, one renderer, live and dead.
 *
 * A pose is a flat Float32Array(45) of world-space joint positions. No
 * Object3D hierarchy: transforms are composed straight into instance matrices,
 * so a body costs no scene-graph traversal at all.
 */

export const J = {
  HEAD: 0, CHEST: 1, PELVIS: 2,
  SHOULDER_L: 3, ELBOW_L: 4, HAND_L: 5,
  SHOULDER_R: 6, ELBOW_R: 7, HAND_R: 8,
  HIP_L: 9, KNEE_L: 10, FOOT_L: 11,
  HIP_R: 12, KNEE_R: 13, FOOT_R: 14,
};
export const JOINT_COUNT = 15;

/** Bind pose, metres, feet on y=0, facing -Z. Mirrors Ragdoll.REST. */
export const BIND = new Float32Array([
  0.00, 1.70, 0.00,
  0.00, 1.42, 0.00,
  0.00, 1.00, 0.00,
  -0.19, 1.44, 0.00,
  -0.24, 1.16, 0.02,
  -0.26, 0.90, 0.04,
  0.19, 1.44, 0.00,
  0.24, 1.16, 0.02,
  0.26, 0.90, 0.04,
  -0.11, 0.98, 0.00,
  -0.12, 0.55, 0.01,
  -0.12, 0.09, 0.00,
  0.11, 0.98, 0.00,
  0.12, 0.55, 0.01,
  0.12, 0.09, 0.00,
]);

const seg = (a, b) => Math.hypot(
  BIND[a * 3] - BIND[b * 3],
  BIND[a * 3 + 1] - BIND[b * 3 + 1],
  BIND[a * 3 + 2] - BIND[b * 3 + 2]);

/** Bind-pose bone lengths, used by the IK and by the mesh scaling. */
export const LEN = {
  neck: seg(J.HEAD, J.CHEST),
  spine: seg(J.CHEST, J.PELVIS),
  clavicle: seg(J.CHEST, J.SHOULDER_L),
  upperArm: seg(J.SHOULDER_L, J.ELBOW_L),
  foreArm: seg(J.ELBOW_L, J.HAND_L),
  pelvisHip: seg(J.PELVIS, J.HIP_L),
  thigh: seg(J.HIP_L, J.KNEE_L),
  shin: seg(J.KNEE_L, J.FOOT_L),
};

/** Rendered bone segments: [from, to, partKey]. */
export const BONES = [
  [J.SHOULDER_L, J.ELBOW_L, 'upperArm'],
  [J.SHOULDER_R, J.ELBOW_R, 'upperArm'],
  [J.ELBOW_L, J.HAND_L, 'foreArm'],
  [J.ELBOW_R, J.HAND_R, 'foreArm'],
  [J.HIP_L, J.KNEE_L, 'thigh'],
  [J.HIP_R, J.KNEE_R, 'thigh'],
  [J.KNEE_L, J.FOOT_L, 'shin'],
  [J.KNEE_R, J.FOOT_R, 'shin'],
];

/** Bind lengths per bone part, so a stretched bone scales rather than tears. */
export const BONE_BIND = {
  upperArm: LEN.upperArm, foreArm: LEN.foreArm,
  thigh: LEN.thigh, shin: LEN.shin,
};

/* ---------------------------------------------------------- scratch ---- */
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Read joint `i` of `pose` into `out`. */
export function getJoint(pose, i, out) {
  const o = i * 3;
  return out.set(pose[o], pose[o + 1], pose[o + 2]);
}

export function setJoint(pose, i, x, y, z) {
  const o = i * 3;
  pose[o] = x; pose[o + 1] = y; pose[o + 2] = z;
}

/**
 * Analytic two-bone IK. Writes the middle joint (elbow/knee) into `pose[mid]`
 * given fixed root and end positions, with `pole` biasing which way it bends.
 *
 * Allocation free; `pole` is a direction, not a point.
 */
export function solveIK2(pose, root, mid, end, l1, l2, poleX, poleY, poleZ) {
  const r = root * 3, e = end * 3;
  const rx = pose[r], ry = pose[r + 1], rz = pose[r + 2];
  const ex = pose[e], ey = pose[e + 1], ez = pose[e + 2];
  let dx = ex - rx, dy = ey - ry, dz = ez - rz;
  let d = Math.hypot(dx, dy, dz);
  const dmin = Math.abs(l1 - l2) + 1e-3;
  const dmax = l1 + l2 - 1e-3;
  if (d < 1e-5) { dx = 0; dy = -1; dz = 0; d = 1e-5; }
  const dc = d < dmin ? dmin : d > dmax ? dmax : d;
  const inv = 1 / d;
  dx *= inv; dy *= inv; dz *= inv;

  // Distance along the root->end axis at which the joint sits, plus its offset.
  const a = (l1 * l1 - l2 * l2 + dc * dc) / (2 * dc);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));

  // Orthogonalise the pole against the axis so the bend plane is well defined.
  let px = poleX, py = poleY, pz = poleZ;
  const dot = px * dx + py * dy + pz * dz;
  px -= dx * dot; py -= dy * dot; pz -= dz * dot;
  let pl = Math.hypot(px, py, pz);
  if (pl < 1e-4) {
    // Degenerate pole: any perpendicular will do.
    px = dy; py = -dx; pz = 0;
    pl = Math.hypot(px, py, pz) || 1;
  }
  px /= pl; py /= pl; pz /= pl;

  const m = mid * 3;
  pose[m] = rx + dx * a + px * h;
  pose[m + 1] = ry + dy * a + py * h;
  pose[m + 2] = rz + dz * a + pz * h;
}

/**
 * Compose the instance matrix for a bone-aligned capsule: centred on the bone
 * midpoint, +Y along the bone, Y-scaled by actual/bind length.
 */
export function boneMatrix(pose, from, to, bindLen, out) {
  const f = from * 3, t = to * 3;
  const ax = pose[f], ay = pose[f + 1], az = pose[f + 2];
  const bx = pose[t], by = pose[t + 1], bz = pose[t + 2];
  _d.set(bx - ax, by - ay, bz - az);
  const len = _d.length() || 1e-4;
  _d.multiplyScalar(1 / len);
  _p.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
  const s = len / bindLen;
  basisFromUp(_d, out);
  out.setPosition(_p);
  scaleColumns(out, 1, s, 1);
  return out;
}

/** Build a rotation matrix whose +Y is `dir` (unit), with a stable roll. */
export function basisFromUp(dir, out) {
  // Pick any reference not parallel to dir.
  if (Math.abs(dir.y) < 0.95) _a.set(0, 1, 0); else _a.set(1, 0, 0);
  _b.crossVectors(_a, dir).normalize();     // X
  // Z = X cross Y. Taking Y cross X here instead flips the determinant and
  // renders every limb inside out — the cheapest possible way to lose an hour.
  _a.crossVectors(_b, dir);                 // Z
  const e = out.elements;
  e[0] = _b.x; e[1] = _b.y; e[2] = _b.z; e[3] = 0;
  e[4] = dir.x; e[5] = dir.y; e[6] = dir.z; e[7] = 0;
  e[8] = _a.x; e[9] = _a.y; e[10] = _a.z; e[11] = 0;
  e[12] = 0; e[13] = 0; e[14] = 0; e[15] = 1;
  return out;
}

/**
 * Orthonormal frame from an up vector and a forward hint (-Z convention, to
 * match the camera rig). Used for the head, chest, pelvis and feet, which need
 * a real facing rather than just a bone direction.
 */
export function frameMatrix(upX, upY, upZ, fwdX, fwdY, fwdZ, out) {
  _a.set(upX, upY, upZ);
  const ul = _a.length() || 1;
  _a.multiplyScalar(1 / ul);
  _b.set(fwdX, fwdY, fwdZ);
  // Local -Z is forward, so the Z column is -forward.
  _b.multiplyScalar(-1);
  const dot = _b.dot(_a);
  _b.addScaledVector(_a, -dot);
  if (_b.lengthSq() < 1e-8) _b.set(0, 0, 1);
  _b.normalize();
  _d.crossVectors(_a, _b);   // X = Y cross Z
  const e = out.elements;
  e[0] = _d.x; e[1] = _d.y; e[2] = _d.z; e[3] = 0;
  e[4] = _a.x; e[5] = _a.y; e[6] = _a.z; e[7] = 0;
  e[8] = _b.x; e[9] = _b.y; e[10] = _b.z; e[11] = 0;
  e[12] = 0; e[13] = 0; e[14] = 0; e[15] = 1;
  return out;
}

/** Multiply the basis columns in place (non-uniform local scale). */
export function scaleColumns(m, sx, sy, sz) {
  const e = m.elements;
  e[0] *= sx; e[1] *= sx; e[2] *= sx;
  e[4] *= sy; e[5] *= sy; e[6] *= sy;
  e[8] *= sz; e[9] *= sz; e[10] *= sz;
  return m;
}

/**
 * Parking matrix for unused instance slots: a sub-micrometre body far under
 * the map. Kept invertible (rather than a zero matrix) so the normal matrix
 * never degenerates into NaNs in the shader.
 */
export const HIDDEN = new THREE.Matrix4().set(
  1e-5, 0, 0, 0,
  0, 1e-5, 0, -9999,
  0, 0, 1e-5, 0,
  0, 0, 0, 1);

export { UP };
