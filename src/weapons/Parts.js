import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import Materials from '../materials/MaterialLibrary.js';

/**
 * Procedural gun-part kit.
 *
 * Two ideas carry the whole viewmodel:
 *
 *  1. NOTHING IS A SHARP BOX. Every structural part is a RoundedBoxGeometry
 *     with a 1.5-4 mm chamfer. Real machined aluminium always has a broken
 *     edge, and that chamfer is what catches the key light and gives the gun
 *     its readable silhouette highlights.
 *
 *  2. EVERY PART IS MERGED BY (animation node, material). A weapon is
 *     assembled from ~120 primitives but draws in ~8 calls, because parts that
 *     never move relative to each other are baked into one buffer.
 */

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Vector3();

/* ------------------------------------------------------------- materials -- */

const TEX_SCALE = 0.22;   // texture repeats per UV unit; gun parts are small

const _palCache = new Map();

/**
 * Material set for one weapon. Cached per tint triple so two weapons sharing a
 * colourway share GPU state.
 */
export function palette(tint = {}) {
  const body = tint.body ?? 0x2f333a;
  const poly = tint.poly ?? 0x23262b;
  const accent = tint.accent ?? 0x7d858f;
  const key = `${body}|${poly}|${accent}`;
  const hit = _palCache.get(key);
  if (hit) return hit;

  const M = {
    // Anodised/parkerised receiver: painted_metal carries chipped paint over
    // bare steel, which is exactly what a well-used gun looks like.
    body: Materials.get('painted_metal', { color: body, scale: TEX_SCALE, roughness: 0.52, metalness: 0.42 }),
    bodyDark: Materials.get('painted_metal', { color: mul(body, 0.62), scale: TEX_SCALE * 1.4, roughness: 0.58, metalness: 0.40 }),
    accent: Materials.get('painted_metal', { color: accent, scale: TEX_SCALE * 1.6, roughness: 0.44, metalness: 0.60 }),
    steel: Materials.get('metal', { color: 0xb9c0c9, scale: TEX_SCALE * 1.3, roughness: 0.30, metalness: 1.0 }),
    steelDark: Materials.get('metal', { color: 0x5c626b, scale: TEX_SCALE * 1.1, roughness: 0.44, metalness: 1.0 }),
    steelBlue: Materials.get('metal', { color: 0x3d444e, scale: TEX_SCALE * 0.9, roughness: 0.28, metalness: 1.0 }),
    brass: Materials.get('metal', { color: 0xd8a748, scale: TEX_SCALE * 2.2, roughness: 0.26, metalness: 1.0 }),
    poly: Materials.get('plastic', { color: poly, scale: TEX_SCALE * 1.2, roughness: 0.62 }),
    polyLight: Materials.get('plastic', { color: mul(poly, 1.55), scale: TEX_SCALE * 1.5, roughness: 0.55 }),
    grip: Materials.get('rubber', { color: 0x8a8c92, scale: TEX_SCALE * 2.0, roughness: 0.95 }),
    wood: Materials.get('wood', { color: 0xa9764a, scale: TEX_SCALE * 0.75, roughness: 0.62 }),
    glass: Materials.get('glass', { color: 0x9fc8e8, scale: TEX_SCALE, roughness: 0.05, opacity: 0.34 }),
  };
  _palCache.set(key, M);
  return M;
}

function mul(hex, k) {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k));
  const b = Math.min(255, Math.round((hex & 255) * k));
  return (r << 16) | (g << 8) | b;
}

export function clearPaletteCache() { _palCache.clear(); }

/* ------------------------------------------------------------ primitives -- */

/** Chamfered box. `r` is the edge break in metres. */
export function boxGeo(w, h, d, r = 0.0025, seg = 1) {
  const rr = Math.max(0.0004, Math.min(r, Math.min(w, h, d) * 0.45));
  return new RoundedBoxGeometry(w, h, d, seg, rr);
}

/** Cylinder whose axis runs along +Z (the barrel axis convention). */
export function cylGeo(rTop, rBot, len, seg = 14, open = false) {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, open);
  g.rotateX(Math.PI / 2);
  return g;
}

/** Cylinder along +Y (grips, posts). */
export function cylYGeo(rTop, rBot, len, seg = 12, open = false) {
  return new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, open);
}

export function sphereGeo(r, seg = 12) {
  return new THREE.SphereGeometry(r, seg, Math.max(6, seg >> 1));
}

/** Torus in the XY plane (axis +Z). */
export function torusGeo(r, tube, radial = 8, tubular = 16, arc = Math.PI * 2) {
  return new THREE.TorusGeometry(r, tube, radial, tubular, arc);
}

/** Flat disc facing +Z. */
export function discGeo(r, seg = 20) {
  return new THREE.CircleGeometry(r, seg);
}

/** Annulus facing +Z. */
export function ringGeo(inner, outer, seg = 20) {
  return new THREE.RingGeometry(inner, outer, seg, 1);
}

/** Profile of revolution about +Y, then tipped so the axis runs along +Z. */
export function latheGeo(profile, seg = 18) {
  const pts = [];
  for (let i = 0; i < profile.length; i += 2) pts.push(new THREE.Vector2(Math.max(0.0001, profile[i]), profile[i + 1]));
  const g = new THREE.LatheGeometry(pts, seg);
  g.rotateX(Math.PI / 2);
  return g;
}

/* -------------------------------------------------------------- assembly -- */

/**
 * Collects primitives into per-(node, material) buckets and merges them.
 *
 * `node` names an animation group ('body', 'mag', 'bolt', 'charge', 'trigger',
 * 'pump', 'cylinder', 'bipod'). Geometry added to a node is baked relative to
 * that node's pivot, so animating the node rotates around a sane axis.
 */
export class Assembly {
  constructor(mats) {
    this.mats = mats;
    this.bins = new Map();
    this.pivots = new Map();
    this.extras = [];        // [{node, object}] — non-merged children (lights, sprites)
    this.pivots.set('body', new THREE.Vector3(0, 0, 0));
    this.tris = 0;
  }

  /** Declare an animated sub-node and where it pivots, in model space. */
  node(name, x = 0, y = 0, z = 0) {
    this.pivots.set(name, new THREE.Vector3(x, y, z));
    return this;
  }

  attach(node, object3d) { this.extras.push({ node, object: object3d }); return this; }

  add(node, mat, geo, pos, rot, scale) {
    const pivot = this.pivots.get(node) || _zero;
    if (rot) { _e.set(rot[0] || 0, rot[1] || 0, rot[2] || 0, 'XYZ'); _q.setFromEuler(_e); }
    else _q.identity();
    _v.set(pos ? (pos[0] || 0) : 0, pos ? (pos[1] || 0) : 0, pos ? (pos[2] || 0) : 0);
    if (scale) _s.set(scale[0], scale[1], scale[2]); else _s.set(1, 1, 1);
    _m.compose(_v, _q, _s);
    _m2.makeTranslation(-pivot.x, -pivot.y, -pivot.z);
    _m.premultiply(_m2);
    geo.applyMatrix4(_m);

    const key = `${node}|${mat}`;
    let bin = this.bins.get(key);
    if (!bin) { bin = { node, mat, geos: [] }; this.bins.set(key, bin); }
    bin.geos.push(geo);
    this.tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    return this;
  }

  box(node, mat, size, pos, rot, r = 0.0025, seg = 1) {
    return this.add(node, mat, boxGeo(size[0], size[1], size[2], r, seg), pos, rot);
  }

  cyl(node, mat, rTop, rBot, len, pos, rot, seg = 14, open = false) {
    return this.add(node, mat, cylGeo(rTop, rBot, len, seg, open), pos, rot);
  }

  cylY(node, mat, rTop, rBot, len, pos, rot, seg = 12) {
    return this.add(node, mat, cylYGeo(rTop, rBot, len, seg), pos, rot);
  }

  sphere(node, mat, r, pos, seg = 10) { return this.add(node, mat, sphereGeo(r, seg), pos); }

  torus(node, mat, r, tube, pos, rot, radial = 8, tubular = 16, arc = Math.PI * 2) {
    return this.add(node, mat, torusGeo(r, tube, radial, tubular, arc), pos, rot);
  }

  disc(node, mat, r, pos, rot, seg = 20) { return this.add(node, mat, discGeo(r, seg), pos, rot); }

  lathe(node, mat, profile, pos, rot, seg = 18) { return this.add(node, mat, latheGeo(profile, seg), pos, rot); }

  /* --------------------------------------------------------- detail kits -- */

  /** Picatinny rail: base plate plus cross teeth. Reads instantly as "gun". */
  rail(node, mat, len, pos, width = 0.021, rot = null) {
    const [x, y, z] = pos;
    this.box(node, mat, [width, 0.0055, len], [x, y, z], rot, 0.0012);
    const n = Math.max(3, Math.round(len / 0.0125));
    const step = len / n;
    for (let i = 0; i < n; i++) {
      const zz = z - len / 2 + step * (i + 0.5);
      this.box(node, mat, [width * 0.92, 0.0055, step * 0.44], [x, y + 0.0042, zz], rot, 0.0009);
    }
    return this;
  }

  /** Ventilated handguard: N slats around the bore with cooling gaps between. */
  shroud(node, mat, r, len, pos, slats = 8, thick = 0.0055, width = 0.016, phase = 0) {
    const [x, y, z] = pos;
    for (let i = 0; i < slats; i++) {
      const a = phase + (i / slats) * Math.PI * 2;
      const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      this.box(node, mat, [width, thick, len], [px, py, z], [0, 0, a + Math.PI / 2], 0.0012);
    }
    return this;
  }

  /** Ring of bolts/screws around a joint. */
  screws(node, mat, r, count, pos, headR = 0.0026) {
    const [x, y, z] = pos;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + 0.4;
      this.cyl(node, mat, headR, headR, 0.004, [x + Math.cos(a) * r, y + Math.sin(a) * r, z], null, 6);
    }
    return this;
  }

  /** Heat-sink fins along a barrel. */
  fins(node, mat, r, count, from, to, pos, thick = 0.0035) {
    const [x, y, z] = pos;
    for (let i = 0; i < count; i++) {
      const t = count > 1 ? i / (count - 1) : 0;
      this.cyl(node, mat, r, r, thick, [x, y, z + from + (to - from) * t], null, 14);
    }
    return this;
  }

  /** Finger grooves on a pistol grip. */
  grooves(node, mat, count, pos, rot, w = 0.030, r = 0.0042, step = 0.019) {
    const [x, y, z] = pos;
    for (let i = 0; i < count; i++) {
      this.add(node, mat, new THREE.CylinderGeometry(r, r, w, 8, 1).rotateZ(Math.PI / 2),
        [x, y - i * step, z], rot);
    }
    return this;
  }

  /* -------------------------------------------------------------- build --- */

  build() {
    const root = new THREE.Group();
    root.name = 'weapon';
    const nodes = {};
    for (const [name, pivot] of this.pivots) {
      const g = new THREE.Group();
      g.name = name;
      g.position.copy(pivot);
      g.userData.rest = pivot.clone();
      root.add(g);
      nodes[name] = g;
    }

    for (const bin of this.bins.values()) {
      const parent = nodes[bin.node] || nodes.body;
      const mat = this.mats[bin.mat] || this.mats.body;
      let geo = null;
      if (bin.geos.length === 1) geo = bin.geos[0];
      else {
        geo = mergeGeometries(bin.geos, false);
        if (!geo) {
          // Attribute mismatch — fall back to one mesh per primitive.
          for (const g of bin.geos) {
            const m = new THREE.Mesh(g, mat);
            m.frustumCulled = false;
            parent.add(m);
          }
          continue;
        }
        for (const g of bin.geos) g.dispose();
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.name = `${bin.node}:${bin.mat}`;
      parent.add(mesh);
    }

    for (const e of this.extras) (nodes[e.node] || nodes.body).add(e.object);

    return { root, nodes, tris: this.tris };
  }
}

export default { palette, Assembly, boxGeo, cylGeo, cylYGeo, sphereGeo, torusGeo, discGeo, ringGeo, latheGeo };
