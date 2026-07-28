import * as THREE from 'three';

/**
 * Geometry kit for the map builder.
 *
 * Everything is authored NON-INDEXED into flat JS arrays and merged per
 * material into one BufferGeometry, so a whole point-of-interest costs a
 * handful of draw calls no matter how many pieces it is made of.
 *
 * Two conventions matter:
 *
 *  1. UVs are in METRES. Every material is created with `repeat` expressed as
 *     "texture tiles per metre", so texel density is identical on a 0.2 m bolt
 *     plate and a 40 m hangar wall without authoring a single UV by hand.
 *  2. Boxes are CHAMFERED. A perfectly sharp 90 degree edge has no specular
 *     highlight running along it, which is the loudest "untextured box" tell
 *     there is. The chamfer strip costs 32 extra triangles and buys a lit edge.
 */

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
const _up = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _nm = new THREE.Matrix3();

/** Accumulates triangles for one material. */
export class GeoBuf {
  constructor() {
    this.p = [];
    this.n = [];
    this.u = [];
  }

  get triangles() { return this.p.length / 9; }

  /**
   * Convex polygon with a known outward normal. Winding is fixed
   * automatically, and UVs are projected in world-metre units onto the face
   * plane so tiling is continuous and correctly scaled.
   * @param {number[][]} pts ordered ring of [x,y,z]
   * @param {number[]} nrm outward normal (need not be unit)
   * @param {{uo?:number, vo?:number}} [o] uv offset in metres
   */
  face(pts, nrm, o) {
    _n.set(nrm[0], nrm[1], nrm[2]).normalize();
    // Winding: compare the geometric normal of the ring with the desired one.
    _v0.set(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]);
    _v1.set(pts[2][0] - pts[0][0], pts[2][1] - pts[0][1], pts[2][2] - pts[0][2]);
    _v2.crossVectors(_v0, _v1);
    const ring = _v2.dot(_n) < 0 ? pts.slice().reverse() : pts;

    // UV frame on the face plane.
    if (Math.abs(_n.y) > 0.92) _up.set(0, 0, 1); else _up.set(0, 1, 0);
    _t.crossVectors(_up, _n).normalize();
    _b.crossVectors(_n, _t).normalize();
    const uo = o?.uo ?? 0, vo = o?.vo ?? 0;

    const p = this.p, nn = this.n, uu = this.u;
    for (let i = 1; i < ring.length - 1; i++) {
      const tri = [ring[0], ring[i], ring[i + 1]];
      for (let k = 0; k < 3; k++) {
        const q = tri[k];
        p.push(q[0], q[1], q[2]);
        nn.push(_n.x, _n.y, _n.z);
        uu.push(q[0] * _t.x + q[1] * _t.y + q[2] * _t.z + uo,
                q[0] * _b.x + q[1] * _b.y + q[2] * _b.z + vo);
      }
    }
  }

  /** Smooth-shaded triangle with explicit per-vertex normals + uvs. */
  triN(a, b, c, na, nb, nc, ua, ub, uc) {
    const p = this.p, n = this.n, u = this.u;
    p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    n.push(na[0], na[1], na[2], nb[0], nb[1], nb[2], nc[0], nc[1], nc[2]);
    u.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
  }

  /**
   * Append an existing BufferGeometry, transformed. UVs are multiplied so
   * addon geometries (cylinders, tubes) land in metre space too.
   */
  append(geom, matrix, uvScaleX = 1, uvScaleY = 1) {
    let g = geom;
    if (g.index) g = g.toNonIndexed();
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    const uv = g.attributes.uv;
    _m.copy(matrix || _m.identity());
    _nm.getNormalMatrix(_m);
    const pa = pos.array, na = nor ? nor.array : null, ua = uv ? uv.array : null;
    const p = this.p, n = this.n, u = this.u;
    for (let i = 0; i < pos.count; i++) {
      _v0.set(pa[i * 3], pa[i * 3 + 1], pa[i * 3 + 2]).applyMatrix4(_m);
      p.push(_v0.x, _v0.y, _v0.z);
      if (na) {
        _v1.set(na[i * 3], na[i * 3 + 1], na[i * 3 + 2]).applyMatrix3(_nm).normalize();
        n.push(_v1.x, _v1.y, _v1.z);
      } else n.push(0, 1, 0);
      if (ua) u.push(ua[i * 2] * uvScaleX, ua[i * 2 + 1] * uvScaleY);
      else u.push(0, 0);
    }
    if (g !== geom) g.dispose();
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.p), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.n), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.u), 2));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/* ------------------------------------------------------------------ boxes */

/**
 * Chamfered box, centred on the origin.
 * 6 inset faces + 12 edge strips + 8 corner triangles = 44 triangles.
 */
export function chamferBox(buf, w, h, d, c, mat) {
  const a = w / 2, b = h / 2, e = d / 2;
  const ch = Math.min(c, a * 0.45, b * 0.45, e * 0.45);
  const ai = a - ch, bi = b - ch, ei = e - ch;

  const P = (x, y, z) => {
    if (!mat) return [x, y, z];
    _v0.set(x, y, z).applyMatrix4(mat);
    return [_v0.x, _v0.y, _v0.z];
  };
  const N = (x, y, z) => {
    if (!mat) return [x, y, z];
    _v1.set(x, y, z).transformDirection(mat);
    return [_v1.x, _v1.y, _v1.z];
  };

  for (const s of [-1, 1]) {
    // +-X faces
    buf.face([P(s * a, -bi, -ei), P(s * a, bi, -ei), P(s * a, bi, ei), P(s * a, -bi, ei)], N(s, 0, 0));
    // +-Y faces
    buf.face([P(-ai, s * b, -ei), P(ai, s * b, -ei), P(ai, s * b, ei), P(-ai, s * b, ei)], N(0, s, 0));
    // +-Z faces
    buf.face([P(-ai, -bi, s * e), P(ai, -bi, s * e), P(ai, bi, s * e), P(-ai, bi, s * e)], N(0, 0, s));
  }
  if (ch <= 1e-5) return;

  const R2 = Math.SQRT1_2;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      buf.face([P(sx * a, sy * bi, -ei), P(sx * a, sy * bi, ei), P(sx * ai, sy * b, ei), P(sx * ai, sy * b, -ei)],
        N(sx * R2, sy * R2, 0));
    }
    for (const sz of [-1, 1]) {
      buf.face([P(sx * a, -bi, sz * ei), P(sx * a, bi, sz * ei), P(sx * ai, bi, sz * e), P(sx * ai, -bi, sz * e)],
        N(sx * R2, 0, sz * R2));
    }
  }
  for (const sy of [-1, 1]) {
    for (const sz of [-1, 1]) {
      buf.face([P(-ai, sy * b, sz * ei), P(ai, sy * b, sz * ei), P(ai, sy * bi, sz * e), P(-ai, sy * bi, sz * e)],
        N(0, sy * R2, sz * R2));
    }
  }
  const R3 = 1 / Math.sqrt(3);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        buf.face([P(sx * a, sy * bi, sz * ei), P(sx * ai, sy * b, sz * ei), P(sx * ai, sy * bi, sz * e)],
          N(sx * R3, sy * R3, sz * R3));
      }
    }
  }
}

/** Cheap 12-triangle box for collision buffers. */
export function plainBox(buf, w, h, d, mat) {
  const a = w / 2, b = h / 2, e = d / 2;
  const P = (x, y, z) => {
    if (!mat) return [x, y, z];
    _v0.set(x, y, z).applyMatrix4(mat);
    return [_v0.x, _v0.y, _v0.z];
  };
  const N = (x, y, z) => {
    if (!mat) return [x, y, z];
    _v1.set(x, y, z).transformDirection(mat);
    return [_v1.x, _v1.y, _v1.z];
  };
  for (const s of [-1, 1]) {
    buf.face([P(s * a, -b, -e), P(s * a, b, -e), P(s * a, b, e), P(s * a, -b, e)], N(s, 0, 0));
    buf.face([P(-a, s * b, -e), P(a, s * b, -e), P(a, s * b, e), P(-a, s * b, e)], N(0, s, 0));
    buf.face([P(-a, -b, s * e), P(a, -b, s * e), P(a, b, s * e), P(-a, b, s * e)], N(0, 0, s));
  }
}

/* --------------------------------------------------------------- polyline */

/** Catenary sag between two points — a straight cable reads as fake. */
export function catenary(a, b, sag, steps = 18) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = new THREE.Vector3().lerpVectors(a, b, t);
    p.y -= sag * 4 * t * (1 - t);
    pts.push(p);
  }
  return pts;
}

/** Tube along a polyline with metre-scaled UVs. */
export function tubeGeom(points, radius, radial = 8, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points, closed, 'catmullrom', 0.2);
  const len = curve.getLength();
  const seg = Math.max(2, Math.min(160, Math.round(len / 1.2)));
  const g = new THREE.TubeGeometry(curve, seg, radius, radial, closed);
  scaleUV(g, len, radius * Math.PI * 2);
  return g;
}

export function scaleUV(geom, sx, sy) {
  const uv = geom.attributes.uv;
  if (!uv) return geom;
  const a = uv.array;
  for (let i = 0; i < a.length; i += 2) { a[i] *= sx; a[i + 1] *= sy; }
  uv.needsUpdate = true;
  return geom;
}

/* ------------------------------------------------------------------ misc */

export function cylinderGeom(rTop, rBot, h, seg = 12, open = false) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open);
  scaleUV(g, Math.PI * 2 * Math.max(rTop, rBot), h);
  return g;
}

export function sphereGeom(r, wSeg = 16, hSeg = 10) {
  const g = new THREE.SphereGeometry(r, wSeg, hSeg);
  scaleUV(g, Math.PI * 2 * r, Math.PI * r);
  return g;
}

export function coneGeom(r, h, seg = 10) {
  const g = new THREE.ConeGeometry(r, h, seg);
  scaleUV(g, Math.PI * 2 * r, h);
  return g;
}

export function torusGeom(r, tube, radial = 8, tubular = 20, arc = Math.PI * 2) {
  const g = new THREE.TorusGeometry(r, tube, radial, tubular, arc);
  scaleUV(g, arc * r, Math.PI * 2 * tube);
  return g;
}

/* --------------------------------------------------------------- Builder */

/**
 * Collects geometry into per-material buckets plus a parallel set of
 * simplified per-surface collision buckets.
 *
 * The visual mesh can be as detailed as it likes; what reaches
 * `colliderMeshes` is always plain boxes, so the physics BVH stays small.
 */
export class Builder {
  constructor(matFor) {
    this.matFor = matFor;          // key -> { material, surface }
    this.vis = new Map();          // key -> GeoBuf
    this.col = new Map();          // surface -> GeoBuf
    this.blockers = [];            // { x, z, hw, hd, cos, sin, y0, y1 } for nav
  }

  _v(key) {
    let b = this.vis.get(key);
    if (!b) { b = new GeoBuf(); this.vis.set(key, b); }
    return b;
  }

  /** Direct access to a material bucket, for hand-built triangle strips. */
  bucket(key) { return this._v(key); }

  _c(surface) {
    let b = this.col.get(surface);
    if (!b) { b = new GeoBuf(); this.col.set(surface, b); }
    return b;
  }

  /** Raw geometry (already in world space unless a matrix is given). */
  geo(key, geometry, matrix, uvx = 1, uvy = 1) {
    this._v(key).append(geometry, matrix, uvx, uvy);
    return this;
  }

  /**
   * The workhorse. Places a chamfered box centred at (x,y,z).
   * @param {string} key material key
   * @param {object} [o] { ry, rx, rz, c (chamfer), nc (no collision), cs (collision surface) }
   */
  box(key, x, y, z, w, h, d, o = {}) {
    const m = _m.identity();
    if (o.ry || o.rx || o.rz) {
      m.makeRotationFromEuler(new THREE.Euler(o.rx || 0, o.ry || 0, o.rz || 0, 'YXZ'));
      m.setPosition(x, y, z);
    } else {
      m.makeTranslation(x, y, z);
    }
    const c = o.c ?? Math.min(0.055, w * 0.16, h * 0.16, d * 0.16);
    chamferBox(this._v(key), w, h, d, c, m);
    if (!o.nc) {
      const surf = o.cs || this.matFor(key).surface;
      plainBox(this._c(surf), w, h, d, m);
      if (o.nb !== true) {
        this.blockers.push({
          x, z, hw: w / 2, hd: d / 2,
          cos: Math.cos(o.ry || 0), sin: Math.sin(o.ry || 0),
          y0: y - h / 2, y1: y + h / 2,
        });
      }
    }
    return this;
  }

  /** Collision-only box (invisible), e.g. to seal a decorative gap. */
  clip(surface, x, y, z, w, h, d, ry = 0) {
    const m = _m.identity();
    if (ry) { m.makeRotationY(ry); m.setPosition(x, y, z); } else m.makeTranslation(x, y, z);
    plainBox(this._c(surface), w, h, d, m);
    this.blockers.push({ x, z, hw: w / 2, hd: d / 2, cos: Math.cos(ry), sin: Math.sin(ry), y0: y - h / 2, y1: y + h / 2 });
    return this;
  }

  /* ---- composite pieces ---- */

  /**
   * Straight run of steps. Walkable by the character controller because each
   * riser is below CFG.move.player.stepHeight.
   * @param {number} dir yaw of the climb direction
   */
  stairs(key, x, y, z, width, rise, run, steps, dir = 0, o = {}) {
    const c = Math.cos(dir), s = Math.sin(dir);
    const railKey = o.rail;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) * run;
      const px = x + s * t, pz = z + c * t;
      const py = y + (i + 1) * rise - rise / 2;
      this.box(key, px, py, pz, width, rise * (i + 1) > 0 ? rise : rise, run,
        { ry: dir, c: 0.03, nb: true });
      // Solid skirt below the tread so the stair reads as a cast block.
      if (i > 0) {
        this.box(key, px, y + (i * rise) / 2, pz, width, i * rise, run, { ry: dir, c: 0.02, nc: true, nb: true });
      }
    }
    if (railKey) {
      const total = steps * run;
      for (const side of [-1, 1]) {
        const ox = c * side * (width / 2 - 0.08), oz = -s * side * (width / 2 - 0.08);
        const a = new THREE.Vector3(x + ox, y + 0.95, z + oz);
        const b = new THREE.Vector3(x + ox + s * total, y + steps * rise + 0.95, z + oz + c * total);
        this.geo(railKey, tubeGeom([a, b], 0.035, 6));
        const posts = Math.max(2, Math.round(total / 1.6));
        for (let i = 0; i <= posts; i++) {
          const t = i / posts;
          const px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t;
          const py = a.y + (b.y - a.y) * t;
          this.box(railKey, px, py - 0.475, pz, 0.05, 0.95, 0.05, { nc: true, nb: true, c: 0.012 });
        }
      }
    }
    return this;
  }

  /** Sloped ramp slab. */
  ramp(key, x, y, z, width, length, rise, dir = 0, thick = 0.35) {
    const pitch = Math.atan2(rise, length);
    const len = Math.hypot(rise, length);
    const m = new THREE.Matrix4().makeRotationY(dir);
    m.multiply(new THREE.Matrix4().makeRotationX(-pitch));
    m.setPosition(x + Math.sin(dir) * length / 2, y + rise / 2, z + Math.cos(dir) * length / 2);
    chamferBox(this._v(key), width, thick, len, 0.05, m);
    plainBox(this._c(this.matFor(key).surface), width, thick, len, m);
    return this;
  }

  /**
   * Railing along a polyline: two rails + posts + a kick plate.
   * Collision is a single thin wall so the physics stays cheap.
   */
  railing(key, pts, h = 1.05, o = {}) {
    const solid = o.solid !== false;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      const dir = Math.atan2(dx, dz);
      const midx = (a.x + b.x) / 2, midz = (a.z + b.z) / 2;
      const midy = (a.y + b.y) / 2;
      this.geo(key, tubeGeom([
        new THREE.Vector3(a.x, a.y + h, a.z), new THREE.Vector3(b.x, b.y + h, b.z)], 0.035, 6));
      this.geo(key, tubeGeom([
        new THREE.Vector3(a.x, a.y + h * 0.55, a.z), new THREE.Vector3(b.x, b.y + h * 0.55, b.z)], 0.026, 6));
      this.box(key, midx, midy + 0.09, midz, 0.035, 0.18, len, { ry: dir, c: 0.01, nc: true, nb: true });
      const posts = Math.max(1, Math.round(len / 1.7));
      for (let k = 0; k <= posts; k++) {
        const t = k / posts;
        this.box(key, a.x + dx * t, midy + h / 2, a.z + dz * t, 0.055, h, 0.055, { nc: true, nb: true, c: 0.014 });
      }
      if (solid) this.clip('metal', midx, midy + h * 0.5, midz, 0.08, h, len, dir);
    }
    return this;
  }

  /** Grated catwalk with railings on both sides. */
  catwalk(key, railKey, a, b, width = 1.6) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    const dir = Math.atan2(dx, dz);
    const midx = (a.x + b.x) / 2, midz = (a.z + b.z) / 2, midy = (a.y + b.y) / 2;
    this.box(key, midx, midy - 0.06, midz, width, 0.12, len, { ry: dir, c: 0.03, nb: true });
    // Under-truss so it does not read as a floating plank.
    const nx = Math.cos(dir), nz = -Math.sin(dir);
    for (const s of [-1, 1]) {
      this.box(key, midx + nx * s * (width / 2 - 0.1), midy - 0.28, midz + nz * s * (width / 2 - 0.1),
        0.08, 0.32, len, { ry: dir, c: 0.02, nc: true, nb: true });
    }
    const braces = Math.max(1, Math.round(len / 2.4));
    for (let i = 0; i <= braces; i++) {
      const t = i / braces;
      this.box(key, a.x + dx * t, midy - 0.28, a.z + dz * t, width, 0.1, 0.1,
        { ry: dir, nc: true, nb: true, c: 0.02 });
    }
    for (const s of [-1, 1]) {
      const ox = nx * s * (width / 2 - 0.05), oz = nz * s * (width / 2 - 0.05);
      this.railing(railKey, [
        new THREE.Vector3(a.x + ox, a.y, a.z + oz),
        new THREE.Vector3(b.x + ox, b.y, b.z + oz)], 1.05, { solid: true });
    }
    return this;
  }

  /** Lattice truss between two points (roof structure, gantries, masts). */
  truss(key, a, b, depth = 0.9, bays = 0) {
    const A = a.clone(), B = b.clone();
    const len = A.distanceTo(B);
    const n = bays || Math.max(2, Math.round(len / 2.2));
    const dir = new THREE.Vector3().subVectors(B, A).normalize();
    const side = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    const up = new THREE.Vector3().crossVectors(dir, side).normalize();
    const r = 0.055;
    for (const s of [-1, 1]) {
      const o = side.clone().multiplyScalar(s * depth * 0.5);
      this.geo(key, tubeGeom([A.clone().add(o), B.clone().add(o)], r, 6));
      const o2 = o.clone().add(up.clone().multiplyScalar(depth * 0.55));
      this.geo(key, tubeGeom([A.clone().add(o2), B.clone().add(o2)], r, 6));
    }
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      const p0 = A.clone().lerp(B, t0), p1 = A.clone().lerp(B, t1);
      for (const s of [-1, 1]) {
        const o = side.clone().multiplyScalar(s * depth * 0.5);
        const q0 = p0.clone().add(o);
        const q1 = p1.clone().add(o).add(up.clone().multiplyScalar(depth * 0.55));
        this.geo(key, tubeGeom([q0, q1], r * 0.75, 5));
      }
      const c0 = p0.clone().add(side.clone().multiplyScalar(-depth * 0.5));
      const c1 = p0.clone().add(side.clone().multiplyScalar(depth * 0.5));
      this.geo(key, tubeGeom([c0, c1], r * 0.75, 5));
    }
    return this;
  }

  /** Pipe run through a list of points, with support collars. */
  pipe(key, pts, radius, collars = true) {
    const v = pts.map((p) => (p.isVector3 ? p : new THREE.Vector3(p[0], p[1], p[2])));
    this.geo(key, tubeGeom(v, radius, radius > 0.25 ? 12 : 8));
    if (collars) {
      for (let i = 1; i < v.length - 1; i++) {
        const g = torusGeom(radius * 1.12, radius * 0.22, 6, 12);
        const m = new THREE.Matrix4();
        const d = new THREE.Vector3().subVectors(v[i + 1], v[i - 1]).normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), d);
        m.makeRotationFromQuaternion(q);
        m.setPosition(v[i]);
        this.geo(key, g, m);
        g.dispose();
      }
    }
    return this;
  }

  /** Wall-mounted ladder (climbable via mantle at the top). */
  ladder(key, x, y, z, height, dir = 0) {
    const c = Math.cos(dir), s = Math.sin(dir);
    for (const side of [-1, 1]) {
      this.box(key, x + c * side * 0.22, y + height / 2, z - s * side * 0.22,
        0.05, height, 0.05, { ry: dir, nc: true, nb: true, c: 0.012 });
    }
    const rungs = Math.floor(height / 0.32);
    for (let i = 1; i < rungs; i++) {
      this.box(key, x, y + i * 0.32, z, 0.44, 0.035, 0.035, { ry: dir, nc: true, nb: true, c: 0.01 });
    }
    return this;
  }

  /**
   * Wall with rectangular openings punched out, built as a set of boxes.
   * @param {number[][]} holes list of [uOffset, vOffset, width, height] in the
   *   wall's local frame (u along the wall, v up from its base)
   */
  wall(key, x, y, z, length, height, thick, dir, holes = [], o = {}) {
    const c = Math.cos(dir), s = Math.sin(dir);
    const put = (u0, u1, v0, v1) => {
      const w = u1 - u0, h = v1 - v0;
      if (w < 0.02 || h < 0.02) return;
      const uc = (u0 + u1) / 2 - length / 2;
      this.box(key, x + s * uc, y + (v0 + v1) / 2, z + c * uc, w, h, thick,
        { ry: dir, c: o.c ?? 0.05, nb: o.nb });
    };
    if (!holes.length) { put(0, length, 0, height); return this; }
    const sorted = holes.slice().sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    for (const hh of sorted) {
      const [hu, hv, hw, hh2] = hh;
      if (hu > cursor) put(cursor, hu, 0, height);
      put(hu, hu + hw, 0, hv);
      put(hu, hu + hw, hv + hh2, height);
      cursor = Math.max(cursor, hu + hw);
    }
    if (cursor < length) put(cursor, length, 0, height);
    return this;
  }

  /** Emit merged meshes into a group. */
  finish(name) {
    const group = new THREE.Group();
    group.name = name;
    let tris = 0;
    for (const [key, buf] of this.vis) {
      if (!buf.p.length) continue;
      const info = this.matFor(key);
      const mesh = new THREE.Mesh(buf.toGeometry(), info.material);
      mesh.name = `${name}:${key}`;
      mesh.castShadow = info.cast !== false;
      mesh.receiveShadow = true;
      mesh.userData.surface = info.surface;
      tris += buf.triangles;
      group.add(mesh);
    }
    group.userData.triangles = tris;
    return group;
  }

  /** Simplified world-space collision meshes (never added to the scene). */
  finishColliders(prefix) {
    const out = [];
    for (const [surface, buf] of this.col) {
      if (!buf.p.length) continue;
      const mesh = new THREE.Mesh(buf.toGeometry());
      mesh.name = `${prefix}:col:${surface}`;
      mesh.userData.surface = surface;
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      out.push(mesh);
    }
    return out;
  }
}

export default Builder;
