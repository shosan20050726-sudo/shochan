/**
 * CollisionWorld — capsule/ray queries against a TriangleBVH baked from the
 * world's collider meshes.
 *
 * This is the shared physics service: the player controller, the AI and the
 * projectile integrator all go through here, so there is exactly one notion of
 * "what is solid". Reach it from another system with:
 *
 *     const phys = ctx.engine.get('player')?.collision;
 *     const hit  = phys?.raycast(origin, dir, 50);
 *
 * CAPSULE CONVENTION: a capsule is described by its FEET position (the point
 * where the bottom hemisphere touches the floor), a radius and a total height.
 * The interior segment therefore runs from feet+radius*up to
 * feet+(height-radius)*up.
 *
 * Every per-tick entry point is allocation free: results are written into
 * caller-owned objects (see MoveResult / RayHit).
 */
import * as THREE from 'three';
import { TriangleBVH, capsuleTriangleContact, contactResult } from './TriangleBVH.js';

const SKIN = 0.004;          // resting gap kept between capsule and geometry
const MAX_RESOLVE_ITER = 6;
const MAX_SUBSTEPS = 32;

/* ---- module scratch ------------------------------------------------ */
const _v = new THREE.Vector3();
const _step = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _n = new THREE.Vector3();

/** Reusable ray hit record (raw floats + resolved metadata). */
export class RayHit {
  constructor() {
    this.distance = 0;
    this.px = 0; this.py = 0; this.pz = 0;
    this.nx = 0; this.ny = 1; this.nz = 0;
    this.triIndex = -1;
    this.surface = 'concrete';
    this.object = null;
  }
  get pointX() { return this.px; }
}

/**
 * Accumulated contact information for one `translate()` call.
 * Normals are deduplicated so corner cases stay cheap to clip against.
 */
export class MoveResult {
  constructor(maxNormals = 12) {
    this.normals = new Float32Array(maxNormals * 3);
    this.maxNormals = maxNormals;
    this.count = 0;
    this.hit = false;
    this.groundY = -1;                 // best normal.y seen
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.groundSurface = 'concrete';
    this.wallNormal = new THREE.Vector3();
    this.hasWall = false;
    this.wallSurface = 'concrete';
    this.ceiling = false;
    this.deepest = 0;
    this.drop = 0;
  }

  reset() {
    this.count = 0;
    this.hit = false;
    this.groundY = -1;
    this.hasWall = false;
    this.ceiling = false;
    this.deepest = 0;
    this.drop = 0;
    return this;
  }

  /**
   * @param nx,ny,nz  contact normal (capsule <- closest point). Used for
   *   sliding, because that is the direction that actually separates.
   * @param fx,fy,fz  the triangle's face normal, oriented toward the capsule.
   *   Walkability and wall classification use THIS: brushing the top edge of a
   *   stair produces a diagonal contact normal, and judging "is this ground?"
   *   from that is what makes characters skitter up steps instead of stepping.
   */
  add(nx, ny, nz, fx, fy, fz, surface, wallDot, walkableY) {
    this.hit = true;
    if (fy > this.groundY) {
      this.groundY = fy;
      this.groundNormal.set(fx, fy, fz);
      this.groundSurface = surface;
    }
    if (Math.abs(fy) <= wallDot) {
      // Keep the first (most head-on) wall we touched.
      if (!this.hasWall) { this.wallNormal.set(fx, fy, fz); this.wallSurface = surface; this.hasWall = true; }
    }
    if (fy < -0.6) this.ceiling = true;

    // Which normal to clip velocity against decides how stairs feel:
    //  - walkable face (a step's top, a ramp): clip against the FACE plane.
    //    Brushing the lip of a step gives a diagonal contact normal, and
    //    clipping with that is what bleeds all your speed on a staircase.
    //  - anything else (risers, walls, and edge contacts on them): clip
    //    against the CONTACT normal, the direction that actually separates —
    //    so resting on top of a riser's lip does not stop you dead against
    //    its vertical plane.
    const walkable = fy >= walkableY;
    const cx = walkable ? fx : nx, cy = walkable ? fy : ny, cz = walkable ? fz : nz;
    const n = this.normals;
    for (let i = 0; i < this.count; i++) {
      const o = i * 3;
      if (n[o] * cx + n[o + 1] * cy + n[o + 2] * cz > 0.995) return;   // duplicate
    }
    if (this.count >= this.maxNormals) return;
    const o = this.count * 3;
    n[o] = cx; n[o + 1] = cy; n[o + 2] = cz;
    this.count++;
  }

  /** Remove every velocity component that pushes into a contact plane. */
  clip(vec, bounce = 1.0) {
    const n = this.normals;
    for (let pass = 0; pass < 2; pass++) {
      let changed = false;
      for (let i = 0; i < this.count; i++) {
        const o = i * 3;
        const d = vec.x * n[o] + vec.y * n[o + 1] + vec.z * n[o + 2];
        if (d < 0) {
          vec.x -= n[o] * d * bounce;
          vec.y -= n[o + 1] * d * bounce;
          vec.z -= n[o + 2] * d * bounce;
          changed = true;
        }
      }
      if (!changed) break;
    }
    return vec;
  }
}

export class CollisionWorld {
  constructor() {
    this.bvh = new TriangleBVH();
    this.wallDot = 0.6;
    this.walkableY = Math.cos(0.78);   // overwritten from CFG by PlayerSystem
    this._hit = new RayHit();
    this._scratchResult = new MoveResult();
    this._probeResult = new MoveResult();
    this._sourceCount = -1;

    // Resolution state, read by the (allocation-free) BVH callbacks.
    this._rPos = null;
    this._rRadius = 0;
    this._rHeight = 0;
    this._rRes = null;
    this._rPrevX = 0; this._rPrevY = 0; this._rPrevZ = 0;
    this._rDeepest = 0;
    this._rHasPrev = false;

    this._dBest = Infinity;
    this._dNx = 0; this._dNy = 1; this._dNz = 0;
    this._dSurface = 'concrete';

    this._resolveCb = (i) => this._resolveTriangle(i);
    this._distanceCb = (i) => this._distanceTriangle(i);
    this._overlapCb = (i) => this._overlapTriangle(i);
    this._overlapOut = null;
  }

  get ready() { return this.bvh.ready; }
  get triangleCount() { return this.bvh.triCount; }

  /** (Re)bake the BVH from a mesh list. Safe to call at any time. */
  build(meshes) {
    this.bvh.build(meshes || []);
    this._sourceCount = (meshes || []).length;
    return this;
  }

  /** Cheap change detector so a world that grows later still collides. */
  needsRebuild(meshes) {
    return !!meshes && meshes.length !== this._sourceCount;
  }

  /* ---------------- capsule helpers ---------------- */

  segmentA(feetY, radius) { return feetY + radius; }
  segmentB(feetY, radius, height) { return feetY + Math.max(radius, height - radius); }

  /* ---------------- depenetration ---------------- */

  _resolveTriangle(i) {
    const bvh = this.bvh;
    const t = bvh.tri;
    const p = i * 9;
    const pos = this._rPos;
    const r = this._rRadius;
    const ay = pos.y + r;
    const by = pos.y + Math.max(r, this._rHeight - r);
    const rr = r + SKIN;

    capsuleTriangleContact(
      pos.x, ay, pos.z, pos.x, by, pos.z, rr,
      t[p], t[p + 1], t[p + 2], t[p + 3], t[p + 4], t[p + 5], t[p + 6], t[p + 7], t[p + 8],
    );
    let depth = contactResult.depth;
    if (depth <= 0) return;

    let nx = contactResult.nx, ny = contactResult.ny, nz = contactResult.nz;

    // Face normal oriented toward the capsule.
    const side = (nx * contactResult.fnx + ny * contactResult.fny + nz * contactResult.fnz) >= 0 ? 1 : -1;
    const fx = contactResult.fnx * side, fy = contactResult.fny * side, fz = contactResult.fnz * side;

    // Vertical mode (ground probing): resolve straight up so the probe cannot
    // slide the character down a ramp and hand it free speed. Walls and
    // undersides are ignored — they do not hold you up.
    if (this._rVertical) {
      if (ny < 0.05 || fy < 0.2) return;
      // Divide by the FACE slope, not the contact slope: on a stair edge the
      // contact normal is diagonal and dividing by it overshoots, leaving the
      // capsule hovering above the step. Undershooting converges instead.
      const push = depth / Math.max(fy, 0.3);
      pos.y += push;
      if (push > this._rDeepest) this._rDeepest = push;
      if (this._rRes) {
        this._rRes.add(nx, ny, nz, fx, fy, fz,
          bvh.surfaces[bvh.surfaceOf[i]] || 'concrete', this.wallDot, this.walkableY);
      }
      return;
    }

    // Tunnelling guard: if the capsule axis has crossed the triangle plane
    // since the last known-good pose, push it back the way it came instead of
    // shoving it further through. Only trusted for FACE contacts — for an edge
    // or vertex contact the plane-side test lies (a capsule legitimately
    // perched on a step's top edge sits "behind" the riser's plane) and acting
    // on it would fire the player across the level.
    const faceOn = Math.abs(nx * contactResult.fnx + ny * contactResult.fny + nz * contactResult.fnz) > 0.98;
    if (this._rHasPrev && faceOn) {
      const fnx = contactResult.fnx, fny = contactResult.fny, fnz = contactResult.fnz;
      const ax = t[p], ayy = t[p + 1], az = t[p + 2];
      // Signed side of the previous capsule mid point.
      const pmy = this._rPrevY + (ay + by) * 0.5 - pos.y;
      const prevS = fnx * (this._rPrevX - ax) + fny * (pmy - ayy) + fnz * (this._rPrevZ - az);
      // Signed side of the current closest point on the axis.
      const cx = contactResult.px + nx * contactResult.dist;
      const cy = contactResult.py + ny * contactResult.dist;
      const cz = contactResult.pz + nz * contactResult.dist;
      const curS = fnx * (cx - ax) + fny * (cy - ayy) + fnz * (cz - az);
      if (Math.abs(prevS) > 1e-4 && (prevS > 0) !== (curS > 0)) {
        const s = prevS > 0 ? 1 : -1;
        nx = fnx * s; ny = fny * s; nz = fnz * s;
        depth = rr + contactResult.dist;
      }
    }

    pos.x += nx * depth;
    pos.y += ny * depth;
    pos.z += nz * depth;
    if (depth > this._rDeepest) this._rDeepest = depth;
    if (this._rRes) {
      this._rRes.add(nx, ny, nz, fx, fy, fz,
        bvh.surfaces[bvh.surfaceOf[i]] || 'concrete', this.wallDot, this.walkableY);
      if (depth > this._rRes.deepest) this._rRes.deepest = depth;
    }
  }

  /**
   * Push a capsule out of anything it intersects, in place.
   * `prev` (optional) is the last known non-penetrating feet position and
   * makes the resolution tunnelling-proof.
   * @returns {number} deepest penetration resolved (0 = was already free)
   */
  resolve(pos, radius, height, res = null, prev = null) {
    if (!this.bvh.ready) return 0;
    this._rVertical = false;
    this._rPos = pos;
    this._rRadius = radius;
    this._rHeight = height;
    this._rRes = res;
    this._rHasPrev = !!prev;
    if (prev) { this._rPrevX = prev.x; this._rPrevY = prev.y; this._rPrevZ = prev.z; }

    let deepest = 0;
    for (let iter = 0; iter < MAX_RESOLVE_ITER; iter++) {
      this._rDeepest = 0;
      const r = radius + SKIN + 0.02;
      const y0 = pos.y + radius - r, y1 = pos.y + Math.max(radius, height - radius) + r;
      this.bvh.queryBox(pos.x - r, y0, pos.z - r, pos.x + r, y1, pos.z + r, this._resolveCb);
      if (this._rDeepest > deepest) deepest = this._rDeepest;
      if (this._rDeepest < 1e-4) break;
    }
    this._rPos = null; this._rRes = null;
    return deepest;
  }

  /**
   * Collide-and-slide translation. `pos` is advanced by `delta` in substeps
   * small enough that nothing can tunnel, depenetrating after each one and
   * clipping the remaining motion against whatever was hit.
   *
   * @param {THREE.Vector3} pos    feet position, mutated
   * @param {THREE.Vector3} delta  desired displacement (not mutated)
   * @param {MoveResult}    res    contact accumulator (reset internally)
   */
  translate(pos, delta, radius, height, res) {
    res.reset();
    if (!this.bvh.ready) { pos.add(delta); return res; }

    const len = delta.length();
    if (len < 1e-7) { this.resolve(pos, radius, height, res, null); return res; }

    const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(len / (radius * 0.5))));
    _step.copy(delta).multiplyScalar(1 / steps);

    for (let s = 0; s < steps; s++) {
      _prev.copy(pos);
      pos.add(_step);
      const before = res.count;
      this.resolve(pos, radius, height, res, _prev);
      if (res.count !== before && s < steps - 1) res.clip(_step);
      if (_step.lengthSq() < 1e-12) break;
    }
    return res;
  }

  /* ---------------- distance / sweep ---------------- */

  _distanceTriangle(i) {
    const t = this.bvh.tri;
    const p = i * 9;
    const pos = this._rPos;
    const r = this._rRadius;
    const d = capsuleTriangleContact(
      pos.x, pos.y + r, pos.z, pos.x, pos.y + Math.max(r, this._rHeight - r), pos.z, r,
      t[p], t[p + 1], t[p + 2], t[p + 3], t[p + 4], t[p + 5], t[p + 6], t[p + 7], t[p + 8],
    );
    if (d < this._dBest) {
      this._dBest = d;
      this._dNx = contactResult.nx; this._dNy = contactResult.ny; this._dNz = contactResult.nz;
      this._dSurface = this.bvh.surfaces[this.bvh.surfaceOf[i]] || 'concrete';
    }
  }

  /** Distance from the capsule surface to the nearest geometry (may be < 0). */
  capsuleDistance(pos, radius, height, search = 0.6) {
    this._rPos = pos; this._rRadius = radius; this._rHeight = height;
    this._dBest = Infinity;
    const r = radius + search;
    this.bvh.queryBox(
      pos.x - r, pos.y + radius - r, pos.z - r,
      pos.x + r, pos.y + Math.max(radius, height - radius) + r, pos.z + r,
      this._distanceCb);
    this._rPos = null;
    return this._dBest - radius;
  }

  /**
   * Conservative-advancement capsule sweep. Returns the RayHit-shaped record
   * (distance/normal/surface) or null when the whole path is clear.
   */
  capsuleSweep(start, dirX, dirY, dirZ, maxDist, radius, height, out = this._hit) {
    if (!this.bvh.ready) return null;
    const dl = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ) || 1;
    const dx = dirX / dl, dy = dirY / dl, dz = dirZ / dl;
    let t = 0;
    _probe.copy(start);
    for (let iter = 0; iter < 24 && t <= maxDist; iter++) {
      _probe.set(start.x + dx * t, start.y + dy * t, start.z + dz * t);
      const remaining = maxDist - t;
      const search = Math.min(Math.max(0.2, remaining), 1.5);
      const d = this.capsuleDistance(_probe, radius, height, search);
      if (d <= SKIN * 2) {
        out.distance = t;
        out.px = _probe.x; out.py = _probe.y + height * 0.5; out.pz = _probe.z;
        out.nx = this._dNx; out.ny = this._dNy; out.nz = this._dNz;
        out.surface = this._dSurface;
        out.object = null;
        out.triIndex = -1;
        return out;
      }
      if (!isFinite(d)) t += search;                    // nothing nearby, jump ahead
      else t += Math.max(d, 1e-3);
    }
    return null;
  }

  /* ---------------- raycast ---------------- */

  /** Fast path: writes into a caller-owned RayHit, no allocation. */
  raycastRef(ox, oy, oz, dx, dy, dz, maxDist, out = this._hit) {
    return this.bvh.raycast(ox, oy, oz, dx, dy, dz, maxDist, out);
  }

  /**
   * Contract-shaped raycast (allocates a result — for one-off external use).
   * @returns {null|{point:THREE.Vector3, normal:THREE.Vector3, distance:number, surface:string, object:any}}
   */
  raycast(origin, dir, maxDist = 1000) {
    const h = this.bvh.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxDist, this._hit);
    if (!h) return null;
    return {
      point: new THREE.Vector3(h.px, h.py, h.pz),
      normal: new THREE.Vector3(h.nx, h.ny, h.nz),
      distance: h.distance,
      surface: h.surface,
      object: h.object,
    };
  }

  /** Contract-shaped capsule cast between two feet positions. */
  capsuleCast(start, end, radius, height = 1.8) {
    _dir.copy(end).sub(start);
    const dist = _dir.length();
    if (dist < 1e-6) return null;
    const h = this.capsuleSweep(start, _dir.x, _dir.y, _dir.z, dist, radius, height, this._hit);
    if (!h) return null;
    return {
      point: new THREE.Vector3(h.px, h.py, h.pz),
      normal: new THREE.Vector3(h.nx, h.ny, h.nz),
      distance: h.distance,
      surface: h.surface,
    };
  }

  _overlapTriangle(i) {
    const t = this.bvh.tri;
    const p = i * 9;
    const pos = this._rPos;
    const r = this._rRadius;
    capsuleTriangleContact(
      pos.x, pos.y + r, pos.z, pos.x, pos.y + Math.max(r, this._rHeight - r), pos.z, r,
      t[p], t[p + 1], t[p + 2], t[p + 3], t[p + 4], t[p + 5], t[p + 6], t[p + 7], t[p + 8],
    );
    if (contactResult.depth > 0) {
      this._overlapOut.push({
        normal: new THREE.Vector3(contactResult.nx, contactResult.ny, contactResult.nz),
        depth: contactResult.depth,
        surface: this.bvh.surfaces[this.bvh.surfaceOf[i]] || 'concrete',
      });
    }
  }

  /** Contract-shaped overlap test (allocates — external/debug use). */
  overlapCapsule(position, radius, height = 1.8) {
    const out = [];
    if (!this.bvh.ready) return out;
    this._rPos = position; this._rRadius = radius; this._rHeight = height;
    this._overlapOut = out;
    const r = radius + 0.02;
    this.bvh.queryBox(
      position.x - r, position.y + radius - r, position.z - r,
      position.x + r, position.y + Math.max(radius, height - radius) + r, position.z + r,
      this._overlapCb);
    this._rPos = null; this._overlapOut = null;
    return out;
  }

  /**
   * True when a capsule of this size fits here. `tolerance` forgives the
   * resting contact a standing character always has with the floor/wall it is
   * already touching, so stand-up and mantle-clearance checks only fail on a
   * genuine obstruction.
   */
  isFree(position, radius, height, tolerance = 0.02) {
    if (!this.bvh.ready) return true;
    return this.capsuleDistance(position, radius, height, 0.08) > -tolerance;
  }

  /**
   * Lower a capsule until it rests on something walkable, resolving purely
   * along +Y. Used for ground snapping and for the down leg of a step-up:
   * a sliding resolve here would convert the drop into horizontal speed and
   * rocket the player down every ramp in the level.
   *
   * @returns {boolean} true when something was found. `res.drop` is how far
   *   `pos` actually fell (can be slightly negative when the probe had to
   *   depenetrate upward), and res carries the ground normal and surface.
   */
  probeGround(pos, radius, height, maxDrop, res = this._probeResult) {
    res.reset();
    res.drop = 0;
    if (!this.bvh.ready) return false;
    const startY = pos.y;
    const steps = Math.max(1, Math.ceil(maxDrop / 0.1));
    const dy = maxDrop / steps;

    for (let s = 0; s < steps; s++) {
      pos.y -= dy;
      this._rVertical = true;
      this._rPos = pos;
      this._rRadius = radius;
      this._rHeight = height;
      this._rRes = res;
      this._rHasPrev = false;
      let pushed = 0;
      for (let iter = 0; iter < 6; iter++) {
        this._rDeepest = 0;
        const r = radius + SKIN + 0.02;
        const y0 = pos.y + radius - r, y1 = pos.y + Math.max(radius, height - radius) + r;
        this.bvh.queryBox(pos.x - r, y0, pos.z - r, pos.x + r, y1, pos.z + r, this._resolveCb);
        pushed += this._rDeepest;
        if (this._rDeepest < 1e-4) break;
      }
      this._rVertical = false;
      this._rPos = null; this._rRes = null;
      if (pushed > 1e-4) { res.drop = startY - pos.y; return true; }
    }
    res.drop = maxDrop;
    return false;
  }

  /** Height of the ground under a point (or null). Cheap ray version. */
  groundHeight(x, y, z, maxDrop = 50) {
    const h = this.bvh.raycast(x, y, z, 0, -1, 0, maxDrop, this._hit);
    return h ? h.py : null;
  }
}

export default CollisionWorld;
