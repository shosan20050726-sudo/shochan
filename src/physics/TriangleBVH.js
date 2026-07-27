/**
 * TriangleBVH — a binned-SAH bounding volume hierarchy over the world's
 * collision triangles.
 *
 * three-mesh-bvh is not available to us, so this is a hand-rolled equivalent:
 * triangles are baked once into flat typed arrays in world space, then a
 * top-down binned surface-area-heuristic tree is built over them and the
 * triangle soup is permuted into traversal order for cache locality.
 *
 * Everything here is allocation-free at query time — traversal uses a
 * preallocated stack and results are written into caller-supplied objects.
 *
 * Coordinate convention: all triangle data is stored in WORLD space. Rebuild
 * when the world changes.
 */
import * as THREE from 'three';

const LEAF_SIZE = 6;
const MAX_DEPTH = 42;
const BINS = 12;
const MAX_TRIANGLES = 700000;

/* ------------------------------------------------------------------ *
 * Scratch state (module scope — never allocate during a query)
 * ------------------------------------------------------------------ */
const _mat = new THREE.Matrix4();
const _stack = new Int32Array(128);
const _instMat = new THREE.Matrix4();

/** Shared result object for closest-point helpers. */
export const _pt = { x: 0, y: 0, z: 0 };
const _pt2 = { x: 0, y: 0, z: 0 };

/* ------------------------------------------------------------------ *
 * Triangle math primitives (float args, no allocation)
 * ------------------------------------------------------------------ */

/** Möller–Trumbore, double sided. Returns t along dir, or -1 for a miss. */
export function rayTriangle(
  ox, oy, oz, dx, dy, dz,
  ax, ay, az, bx, by, bz, cx, cy, cz,
) {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-12 && det < 1e-12) return -1;
  const inv = 1 / det;
  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-6 || u > 1.000001) return -1;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -1e-6 || u + v > 1.000001) return -1;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

/** Closest point on triangle abc to p. Writes into `out` ({x,y,z}). */
export function closestPointOnTriangle(
  px, py, pz,
  ax, ay, az, bx, by, bz, cx, cy, cz,
  out,
) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out.x = ax; out.y = ay; out.z = az; return; }

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out.x = bx; out.y = by; out.z = bz; return; }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out.x = ax + abx * v; out.y = ay + aby * v; out.z = az + abz * v; return;
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out.x = cx; out.y = cy; out.z = cz; return; }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out.x = ax + acx * w; out.y = ay + acy * w; out.z = az + acz * w; return;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    out.x = bx + (cx - bx) * w; out.y = by + (cy - by) * w; out.z = bz + (cz - bz) * w; return;
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  out.x = ax + abx * v + acx * w;
  out.y = ay + aby * v + acy * w;
  out.z = az + abz * v + acz * w;
}

/**
 * Closest points between segment p1->q1 and segment p2->q2 (Ericson, RTCD).
 * Writes the point on segment 1 into out1 and on segment 2 into out2.
 */
export function closestPointsSegmentSegment(
  p1x, p1y, p1z, q1x, q1y, q1z,
  p2x, p2y, p2z, q2x, q2y, q2z,
  out1, out2,
) {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
  const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s = 0, t = 0;
  const EPS = 1e-12;

  if (a <= EPS && e <= EPS) {
    // Both degenerate.
  } else if (a <= EPS) {
    t = f / e;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) {
      s = -c / a;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      if (denom > EPS) {
        s = (b * f - c * e) / denom;
        s = s < 0 ? 0 : s > 1 ? 1 : s;
      } else s = 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = -c / a; s = s < 0 ? 0 : s > 1 ? 1 : s; }
      else if (t > 1) { t = 1; s = (b - c) / a; s = s < 0 ? 0 : s > 1 ? 1 : s; }
    }
  }
  out1.x = p1x + d1x * s; out1.y = p1y + d1y * s; out1.z = p1z + d1z * s;
  out2.x = p2x + d2x * t; out2.y = p2y + d2y * t; out2.z = p2z + d2z * t;
}

/**
 * Result of a capsule/triangle proximity test. `depth` > 0 means overlap;
 * (nx,ny,nz) points FROM the triangle TOWARD the capsule axis.
 */
export const contactResult = {
  depth: 0, dist: 0,
  nx: 0, ny: 1, nz: 0,
  px: 0, py: 0, pz: 0,   // point on the triangle
  fnx: 0, fny: 1, fnz: 0, // raw triangle face normal (normalised)
};

/**
 * Closest approach between capsule segment (s0 -> s1) and triangle abc.
 * Exact: considers the face-interior case, both segment endpoints, and all
 * three triangle edges. Fills `contactResult` and returns the distance
 * between the segment and the triangle (before the radius is applied).
 */
export function capsuleTriangleContact(
  s0x, s0y, s0z, s1x, s1y, s1z, radius,
  ax, ay, az, bx, by, bz, cx, cy, cz,
) {
  // Triangle face normal.
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  let fnx = e1y * e2z - e1z * e2y;
  let fny = e1z * e2x - e1x * e2z;
  let fnz = e1x * e2y - e1y * e2x;
  const fl = Math.sqrt(fnx * fnx + fny * fny + fnz * fnz);
  if (fl < 1e-12) { contactResult.depth = -1; contactResult.dist = Infinity; return Infinity; }
  fnx /= fl; fny /= fl; fnz /= fl;
  contactResult.fnx = fnx; contactResult.fny = fny; contactResult.fnz = fnz;

  let best = Infinity;
  let bsx = 0, bsy = 0, bsz = 0, btx = 0, bty = 0, btz = 0;

  const consider = (sx, sy, sz, tx, ty, tz) => {
    const dx = sx - tx, dy = sy - ty, dz = sz - tz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < best) {
      best = d2;
      bsx = sx; bsy = sy; bsz = sz;
      btx = tx; bty = ty; btz = tz;
    }
  };

  // (1) Face case: intersect the capsule axis with the triangle plane, clamp
  //     into the segment, then take the closest triangle point to that.
  const dsx = s1x - s0x, dsy = s1y - s0y, dsz = s1z - s0z;
  const denom = fnx * dsx + fny * dsy + fnz * dsz;
  let tRef = 0;
  if (Math.abs(denom) > 1e-9) {
    tRef = (fnx * (ax - s0x) + fny * (ay - s0y) + fnz * (az - s0z)) / denom;
    tRef = tRef < 0 ? 0 : tRef > 1 ? 1 : tRef;
  } else {
    tRef = 0.5;
  }
  const rx = s0x + dsx * tRef, ry = s0y + dsy * tRef, rz = s0z + dsz * tRef;
  closestPointOnTriangle(rx, ry, rz, ax, ay, az, bx, by, bz, cx, cy, cz, _pt);
  // Closest point on the segment to that triangle point.
  {
    const wx = _pt.x - s0x, wy = _pt.y - s0y, wz = _pt.z - s0z;
    const dd = dsx * dsx + dsy * dsy + dsz * dsz;
    let t = dd > 1e-12 ? (wx * dsx + wy * dsy + wz * dsz) / dd : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    consider(s0x + dsx * t, s0y + dsy * t, s0z + dsz * t, _pt.x, _pt.y, _pt.z);
  }

  // (2) Segment endpoints against the triangle.
  closestPointOnTriangle(s0x, s0y, s0z, ax, ay, az, bx, by, bz, cx, cy, cz, _pt);
  consider(s0x, s0y, s0z, _pt.x, _pt.y, _pt.z);
  closestPointOnTriangle(s1x, s1y, s1z, ax, ay, az, bx, by, bz, cx, cy, cz, _pt);
  consider(s1x, s1y, s1z, _pt.x, _pt.y, _pt.z);

  // (3) Segment against each triangle edge.
  closestPointsSegmentSegment(s0x, s0y, s0z, s1x, s1y, s1z, ax, ay, az, bx, by, bz, _pt, _pt2);
  consider(_pt.x, _pt.y, _pt.z, _pt2.x, _pt2.y, _pt2.z);
  closestPointsSegmentSegment(s0x, s0y, s0z, s1x, s1y, s1z, bx, by, bz, cx, cy, cz, _pt, _pt2);
  consider(_pt.x, _pt.y, _pt.z, _pt2.x, _pt2.y, _pt2.z);
  closestPointsSegmentSegment(s0x, s0y, s0z, s1x, s1y, s1z, cx, cy, cz, ax, ay, az, _pt, _pt2);
  consider(_pt.x, _pt.y, _pt.z, _pt2.x, _pt2.y, _pt2.z);

  const dist = Math.sqrt(best);
  contactResult.dist = dist;
  contactResult.depth = radius - dist;
  contactResult.px = btx; contactResult.py = bty; contactResult.pz = btz;
  if (dist > 1e-7) {
    const inv = 1 / dist;
    contactResult.nx = (bsx - btx) * inv;
    contactResult.ny = (bsy - bty) * inv;
    contactResult.nz = (bsz - btz) * inv;
  } else {
    // Axis passes exactly through the surface — fall back to the face normal.
    contactResult.nx = fnx; contactResult.ny = fny; contactResult.nz = fnz;
  }
  return dist;
}

/* ------------------------------------------------------------------ *
 * The BVH
 * ------------------------------------------------------------------ */

export class TriangleBVH {
  constructor() {
    this.triCount = 0;
    this.nodeCount = 0;
    this.tri = new Float32Array(0);        // 9 floats per triangle (world space)
    this.surfaceOf = new Uint16Array(0);   // index into this.surfaces
    this.objectOf = new Uint16Array(0);    // index into this.objects
    this.surfaces = ['concrete'];
    this.objects = [];
    this.nodeBox = new Float32Array(0);    // 6 floats per node
    this.nodeA = new Int32Array(0);        // internal: left child; leaf: first tri
    this.nodeN = new Int32Array(0);        // 0 => internal node
    this.bounds = new THREE.Box3();
    this.buildMs = 0;
  }

  get ready() { return this.triCount > 0; }

  /**
   * Bake a list of meshes (including InstancedMesh) into the tree.
   * Meshes opt out with `userData.collision === false` / `userData.noCollide`.
   */
  build(meshes) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const sources = [];
    let total = 0;

    for (const m of meshes || []) {
      if (!m || !m.isMesh) continue;
      if (m.userData?.collision === false || m.userData?.noCollide) continue;
      const geom = m.geometry;
      const pos = geom?.attributes?.position;
      if (!pos) continue;
      const index = geom.index;
      const triPer = ((index ? index.count : pos.count) / 3) | 0;
      if (triPer <= 0) continue;
      const instances = m.isInstancedMesh ? m.count : 1;
      const n = triPer * instances;
      if (total + n > MAX_TRIANGLES) {
        console.warn('[TriangleBVH] triangle budget exceeded, skipping', m.name || m.type);
        continue;
      }
      m.updateWorldMatrix(true, false);
      sources.push({ mesh: m, pos, index, triPer, instances });
      total += n;
    }

    this.triCount = total;
    this.tri = new Float32Array(total * 9);
    this.surfaceOf = new Uint16Array(total);
    this.objectOf = new Uint16Array(total);
    this.surfaces = [];
    this.objects = [];
    const surfaceIds = new Map();

    const tri = this.tri;
    let w = 0, t = 0;
    const px = pos => pos; // (readability shim)
    void px;

    for (const src of sources) {
      const { mesh, pos, index, triPer, instances } = src;
      const surface = mesh.userData?.surface || 'concrete';
      let sid = surfaceIds.get(surface);
      if (sid === undefined) { sid = this.surfaces.length; this.surfaces.push(surface); surfaceIds.set(surface, sid); }
      const oid = this.objects.length;
      this.objects.push(mesh);

      const arr = pos.array;
      const itemSize = pos.itemSize;
      const idx = index ? index.array : null;

      for (let inst = 0; inst < instances; inst++) {
        if (mesh.isInstancedMesh) {
          mesh.getMatrixAt(inst, _instMat);
          _mat.multiplyMatrices(mesh.matrixWorld, _instMat);
        } else {
          _mat.copy(mesh.matrixWorld);
        }
        const e = _mat.elements;
        for (let f = 0; f < triPer; f++) {
          for (let k = 0; k < 3; k++) {
            const vi = idx ? idx[f * 3 + k] : (f * 3 + k);
            const o = vi * itemSize;
            const x = arr[o], y = arr[o + 1], z = arr[o + 2];
            const iw = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15] || 1);
            tri[w++] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * iw;
            tri[w++] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * iw;
            tri[w++] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * iw;
          }
          this.surfaceOf[t] = sid;
          this.objectOf[t] = oid;
          t++;
        }
      }
    }

    if (this.surfaces.length === 0) this.surfaces.push('concrete');
    if (total === 0) { this.nodeCount = 0; this.buildMs = 0; return this; }

    this._buildTree();
    this.buildMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    return this;
  }

  _buildTree() {
    const n = this.triCount;
    const tri = this.tri;
    const centroid = new Float32Array(n * 3);
    const tbox = new Float32Array(n * 6);
    const order = new Uint32Array(n);

    for (let i = 0; i < n; i++) {
      const o = i * 9;
      const ax = tri[o], ay = tri[o + 1], az = tri[o + 2];
      const bx = tri[o + 3], by = tri[o + 4], bz = tri[o + 5];
      const cx = tri[o + 6], cy = tri[o + 7], cz = tri[o + 8];
      const b = i * 6;
      tbox[b] = Math.min(ax, bx, cx); tbox[b + 1] = Math.min(ay, by, cy); tbox[b + 2] = Math.min(az, bz, cz);
      tbox[b + 3] = Math.max(ax, bx, cx); tbox[b + 4] = Math.max(ay, by, cy); tbox[b + 5] = Math.max(az, bz, cz);
      centroid[i * 3] = (ax + bx + cx) / 3;
      centroid[i * 3 + 1] = (ay + by + cy) / 3;
      centroid[i * 3 + 2] = (az + bz + cz) / 3;
      order[i] = i;
    }

    const maxNodes = Math.max(1, 2 * n);
    const nodeBox = new Float32Array(maxNodes * 6);
    const nodeA = new Int32Array(maxNodes);
    const nodeN = new Int32Array(maxNodes);
    let nodes = 0;

    const binCount = new Int32Array(BINS);
    const binBox = new Float32Array(BINS * 6);
    const leftArea = new Float32Array(BINS);
    const leftCount = new Int32Array(BINS);

    const boundsOf = (start, count, out, off) => {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity;
      let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let i = start; i < start + count; i++) {
        const b = order[i] * 6;
        if (tbox[b] < x0) x0 = tbox[b];
        if (tbox[b + 1] < y0) y0 = tbox[b + 1];
        if (tbox[b + 2] < z0) z0 = tbox[b + 2];
        if (tbox[b + 3] > x1) x1 = tbox[b + 3];
        if (tbox[b + 4] > y1) y1 = tbox[b + 4];
        if (tbox[b + 5] > z1) z1 = tbox[b + 5];
      }
      out[off] = x0; out[off + 1] = y0; out[off + 2] = z0;
      out[off + 3] = x1; out[off + 4] = y1; out[off + 5] = z1;
    };

    const area = (x0, y0, z0, x1, y1, z1) => {
      const dx = Math.max(0, x1 - x0), dy = Math.max(0, y1 - y0), dz = Math.max(0, z1 - z0);
      return 2 * (dx * dy + dy * dz + dz * dx);
    };

    // NOTE: children are allocated as an adjacent pair so traversal can find
    // the right child at `left + 1`.
    const build = (self, start, count, depth) => {
      const off = self * 6;
      boundsOf(start, count, nodeBox, off);

      if (count <= LEAF_SIZE || depth >= MAX_DEPTH) {
        nodeA[self] = start; nodeN[self] = count; return;
      }

      // Centroid bounds pick the split axis.
      let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity;
      let cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
      for (let i = start; i < start + count; i++) {
        const c = order[i] * 3;
        if (centroid[c] < cx0) cx0 = centroid[c];
        if (centroid[c] > cx1) cx1 = centroid[c];
        if (centroid[c + 1] < cy0) cy0 = centroid[c + 1];
        if (centroid[c + 1] > cy1) cy1 = centroid[c + 1];
        if (centroid[c + 2] < cz0) cz0 = centroid[c + 2];
        if (centroid[c + 2] > cz1) cz1 = centroid[c + 2];
      }
      const ex = cx1 - cx0, ey = cy1 - cy0, ez = cz1 - cz0;
      let axis = 0, extent = ex, lo = cx0;
      if (ey > extent) { axis = 1; extent = ey; lo = cy0; }
      if (ez > extent) { axis = 2; extent = ez; lo = cz0; }
      if (extent < 1e-7) { nodeA[self] = start; nodeN[self] = count; return; }

      // Bin the primitives.
      binCount.fill(0);
      for (let b = 0; b < BINS; b++) {
        const o = b * 6;
        binBox[o] = binBox[o + 1] = binBox[o + 2] = Infinity;
        binBox[o + 3] = binBox[o + 4] = binBox[o + 5] = -Infinity;
      }
      const scale = BINS / extent;
      for (let i = start; i < start + count; i++) {
        const ti = order[i];
        let bi = ((centroid[ti * 3 + axis] - lo) * scale) | 0;
        if (bi < 0) bi = 0; else if (bi >= BINS) bi = BINS - 1;
        binCount[bi]++;
        const o = bi * 6, tb = ti * 6;
        if (tbox[tb] < binBox[o]) binBox[o] = tbox[tb];
        if (tbox[tb + 1] < binBox[o + 1]) binBox[o + 1] = tbox[tb + 1];
        if (tbox[tb + 2] < binBox[o + 2]) binBox[o + 2] = tbox[tb + 2];
        if (tbox[tb + 3] > binBox[o + 3]) binBox[o + 3] = tbox[tb + 3];
        if (tbox[tb + 4] > binBox[o + 4]) binBox[o + 4] = tbox[tb + 4];
        if (tbox[tb + 5] > binBox[o + 5]) binBox[o + 5] = tbox[tb + 5];
      }

      // Sweep left, then right, evaluating SAH at each of the BINS-1 planes.
      let ax0 = Infinity, ay0 = Infinity, az0 = Infinity;
      let ax1 = -Infinity, ay1 = -Infinity, az1 = -Infinity;
      let acc = 0;
      for (let b = 0; b < BINS - 1; b++) {
        const o = b * 6;
        if (binCount[b]) {
          ax0 = Math.min(ax0, binBox[o]); ay0 = Math.min(ay0, binBox[o + 1]); az0 = Math.min(az0, binBox[o + 2]);
          ax1 = Math.max(ax1, binBox[o + 3]); ay1 = Math.max(ay1, binBox[o + 4]); az1 = Math.max(az1, binBox[o + 5]);
          acc += binCount[b];
        }
        leftCount[b] = acc;
        leftArea[b] = acc ? area(ax0, ay0, az0, ax1, ay1, az1) : 0;
      }

      let bestCost = Infinity, bestSplit = -1;
      ax0 = ay0 = az0 = Infinity; ax1 = ay1 = az1 = -Infinity;
      acc = 0;
      for (let b = BINS - 1; b > 0; b--) {
        const o = b * 6;
        if (binCount[b]) {
          ax0 = Math.min(ax0, binBox[o]); ay0 = Math.min(ay0, binBox[o + 1]); az0 = Math.min(az0, binBox[o + 2]);
          ax1 = Math.max(ax1, binBox[o + 3]); ay1 = Math.max(ay1, binBox[o + 4]); az1 = Math.max(az1, binBox[o + 5]);
          acc += binCount[b];
        }
        const lc = leftCount[b - 1], rc = acc;
        if (!lc || !rc) continue;
        const cost = leftArea[b - 1] * lc + area(ax0, ay0, az0, ax1, ay1, az1) * rc;
        if (cost < bestCost) { bestCost = cost; bestSplit = b; }
      }

      const parentArea = area(nodeBox[off], nodeBox[off + 1], nodeBox[off + 2],
        nodeBox[off + 3], nodeBox[off + 4], nodeBox[off + 5]);
      const leafCost = parentArea * count;
      if (bestSplit < 0 || (bestCost >= leafCost && count <= 24)) {
        nodeA[self] = start; nodeN[self] = count; return;
      }

      // Partition in place around the chosen plane.
      const plane = lo + (bestSplit / BINS) * extent;
      let i = start, j = start + count - 1;
      while (i <= j) {
        if (centroid[order[i] * 3 + axis] < plane) i++;
        else { const tmp = order[i]; order[i] = order[j]; order[j] = tmp; j--; }
      }
      let leftN = i - start;
      if (leftN === 0 || leftN === count) leftN = count >> 1;   // degenerate guard

      nodeN[self] = 0;
      const l = nodes;
      nodes += 2;
      nodeA[self] = l;
      build(l, start, leftN, depth + 1);
      build(l + 1, start + leftN, count - leftN, depth + 1);
    };

    nodes = 1;
    build(0, 0, n, 0);

    // Permute triangle payloads into traversal order for locality.
    const newTri = new Float32Array(n * 9);
    const newSurf = new Uint16Array(n);
    const newObj = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      const src = order[i] * 9, dst = i * 9;
      for (let k = 0; k < 9; k++) newTri[dst + k] = tri[src + k];
      newSurf[i] = this.surfaceOf[order[i]];
      newObj[i] = this.objectOf[order[i]];
    }
    this.tri = newTri;
    this.surfaceOf = newSurf;
    this.objectOf = newObj;

    this.nodeBox = nodeBox;
    this.nodeA = nodeA;
    this.nodeN = nodeN;
    this.nodeCount = nodes;
    this.bounds.min.set(nodeBox[0], nodeBox[1], nodeBox[2]);
    this.bounds.max.set(nodeBox[3], nodeBox[4], nodeBox[5]);
  }

  /**
   * Visit every triangle whose AABB overlaps the given box.
   * `cb(triIndex)` — called with the triangle index; no allocation.
   */
  queryBox(x0, y0, z0, x1, y1, z1, cb) {
    if (!this.nodeCount) return;
    const box = this.nodeBox, A = this.nodeA, N = this.nodeN;
    let sp = 0;
    _stack[sp++] = 0;
    while (sp > 0) {
      const node = _stack[--sp];
      const o = node * 6;
      if (box[o] > x1 || box[o + 3] < x0 ||
          box[o + 1] > y1 || box[o + 4] < y0 ||
          box[o + 2] > z1 || box[o + 5] < z0) continue;
      const count = N[node];
      if (count) {
        const start = A[node];
        for (let i = start; i < start + count; i++) cb(i);
      } else {
        const l = A[node];
        if (sp < 126) { _stack[sp++] = l; _stack[sp++] = l + 1; }
      }
    }
  }

  /**
   * Closest hit along a ray. Writes into `out` and returns it, or null.
   * out: { distance, px,py,pz, nx,ny,nz, triIndex, surface, object }
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist, out) {
    if (!this.nodeCount) return null;
    const box = this.nodeBox, A = this.nodeA, N = this.nodeN, tri = this.tri;
    // Guard against exact zeros so the slab test never produces NaN.
    const sx = dx === 0 ? 1e-12 : dx, sy = dy === 0 ? 1e-12 : dy, sz = dz === 0 ? 1e-12 : dz;
    const idx = 1 / sx, idy = 1 / sy, idz = 1 / sz;
    let best = maxDist, bestTri = -1;

    let sp = 0;
    _stack[sp++] = 0;
    while (sp > 0) {
      const node = _stack[--sp];
      const o = node * 6;
      let t0 = (box[o] - ox) * idx, t1 = (box[o + 3] - ox) * idx;
      let tmin = t0 < t1 ? t0 : t1, tmax = t0 < t1 ? t1 : t0;
      t0 = (box[o + 1] - oy) * idy; t1 = (box[o + 4] - oy) * idy;
      tmin = Math.max(tmin, t0 < t1 ? t0 : t1); tmax = Math.min(tmax, t0 < t1 ? t1 : t0);
      t0 = (box[o + 2] - oz) * idz; t1 = (box[o + 5] - oz) * idz;
      tmin = Math.max(tmin, t0 < t1 ? t0 : t1); tmax = Math.min(tmax, t0 < t1 ? t1 : t0);
      if (tmax < 0 || tmin > tmax || tmin > best) continue;

      const count = N[node];
      if (count) {
        const start = A[node];
        for (let i = start; i < start + count; i++) {
          const p = i * 9;
          const t = rayTriangle(ox, oy, oz, dx, dy, dz,
            tri[p], tri[p + 1], tri[p + 2], tri[p + 3], tri[p + 4], tri[p + 5],
            tri[p + 6], tri[p + 7], tri[p + 8]);
          if (t >= 0 && t < best) { best = t; bestTri = i; }
        }
      } else {
        const l = A[node];
        if (sp < 126) { _stack[sp++] = l; _stack[sp++] = l + 1; }
      }
    }

    if (bestTri < 0) return null;
    const p = bestTri * 9;
    const ax = tri[p], ay = tri[p + 1], az = tri[p + 2];
    const bx = tri[p + 3], by = tri[p + 4], bz = tri[p + 5];
    const cx = tri[p + 6], cy = tri[p + 7], cz = tri[p + 8];
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz; }
    out.distance = best;
    out.px = ox + dx * best; out.py = oy + dy * best; out.pz = oz + dz * best;
    out.nx = nx; out.ny = ny; out.nz = nz;
    out.triIndex = bestTri;
    out.surface = this.surfaces[this.surfaceOf[bestTri]] || 'concrete';
    out.object = this.objects[this.objectOf[bestTri]] || null;
    return out;
  }

  /** Copy triangle `i` vertices into a THREE.Triangle (debug/util, allocates nothing). */
  getTriangle(i, target) {
    const p = i * 9, t = this.tri;
    target.a.set(t[p], t[p + 1], t[p + 2]);
    target.b.set(t[p + 3], t[p + 4], t[p + 5]);
    target.c.set(t[p + 6], t[p + 7], t[p + 8]);
    return target;
  }
}

export default TriangleBVH;
