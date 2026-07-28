import * as THREE from 'three';
import { Builder, tubeGeom, cylinderGeom, sphereGeom, coneGeom, torusGeom, catenary } from './Kit.js';
import { PAD } from './Layout.js';

/**
 * The seven points of interest.
 *
 * Each is a self-contained builder that receives its own Builder (so it merges
 * into its own handful of draw calls and can be frustum-culled independently)
 * and pushes traversal anchors, interior lights and spawn markers into a
 * shared context.
 *
 * Design intent, POI by POI:
 *   Souk Plaza    warm stone + saturated canvas. The social heart, at 0,0.
 *   Hangar 7      pale sage corrugated steel. One enormous interior volume.
 *   The Foundry   rust orange + oxide green. Vertical pipework, catwalk maze.
 *   Terrace Row   cream stucco + teal shutters. Dense low-rise, balcony play.
 *   The Bore      ochre machinery in a cut rock pit. Down-verticality.
 *   Relay Spire   white/red mast on a mesa. The map's focal landmark.
 *   The Aqueduct  weathered concrete spine that ties the east to the centre.
 */

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/* ------------------------------------------------------------- helpers -- */

/** Window band: punched openings plus glazing and sills. */
function windowRow(B, key, glassKey, x, y, z, len, dir, count, ww, wh, sill, thick) {
  const holes = [];
  const gap = (len - count * ww) / (count + 1);
  for (let i = 0; i < count; i++) holes.push([gap + i * (ww + gap), sill, ww, wh]);
  const s = Math.sin(dir), c = Math.cos(dir);
  for (const h of holes) {
    const uc = h[0] + ww / 2 - len / 2;
    const px = x + s * uc, pz = z + c * uc;
    B.box(glassKey, px, y + sill + wh / 2, pz, ww - 0.1, wh - 0.1, thick * 0.28, { ry: dir, nc: true, nb: true, c: 0.02 });
    // Reveal + sill: a hole with no frame reads as a decal, not a window.
    B.box(key, px, y + sill - 0.07, pz, ww + 0.22, 0.14, thick + 0.16, { ry: dir, nc: true, nb: true, c: 0.03 });
    B.box(key, px, y + sill + wh + 0.06, pz, ww + 0.22, 0.12, thick + 0.1, { ry: dir, nc: true, nb: true, c: 0.03 });
  }
  return holes;
}

/** Parapet cap around a rectangular roof. */
function parapet(B, key, x, y, z, w, d, h = 0.85, t = 0.28) {
  B.box(key, x, y + h / 2, z - d / 2 + t / 2, w, h, t, { c: 0.05 });
  B.box(key, x, y + h / 2, z + d / 2 - t / 2, w, h, t, { c: 0.05 });
  B.box(key, x - w / 2 + t / 2, y + h / 2, z, t, h, d - t * 2, { c: 0.05 });
  B.box(key, x + w / 2 - t / 2, y + h / 2, z, t, h, d - t * 2, { c: 0.05 });
  // Coping course, slightly proud so it catches a highlight along the top.
  B.box(key, x, y + h + 0.045, z - d / 2 + t / 2, w + 0.12, 0.09, t + 0.12, { nc: true, nb: true, c: 0.03 });
  B.box(key, x, y + h + 0.045, z + d / 2 - t / 2, w + 0.12, 0.09, t + 0.12, { nc: true, nb: true, c: 0.03 });
  B.box(key, x - w / 2 + t / 2, y + h + 0.045, z, t + 0.12, 0.09, d + 0.12, { nc: true, nb: true, c: 0.03 });
  B.box(key, x + w / 2 - t / 2, y + h + 0.045, z, t + 0.12, 0.09, d + 0.12, { nc: true, nb: true, c: 0.03 });
}

/** Flat awning on brackets — the cheapest way to break a blank facade. */
function awning(B, canvasKey, metalKey, x, y, z, w, depth, dir = 0) {
  const s = Math.sin(dir), c = Math.cos(dir);
  B.box(canvasKey, x + s * depth * 0.5, y, z + c * depth * 0.5, w, 0.06, depth,
    { ry: dir, rx: 0.14, nc: true, nb: true, c: 0.02 });
  for (const side of [-1, 1]) {
    const ox = c * side * (w / 2 - 0.15), oz = -s * side * (w / 2 - 0.15);
    B.geo(metalKey, tubeGeom([
      V(x + ox, y + 0.42, z + oz),
      V(x + ox + s * depth * 0.92, y - 0.02, z + oz + c * depth * 0.92)], 0.03, 5));
  }
  B.box(metalKey, x + s * depth, y - 0.05, z + c * depth, w, 0.07, 0.07, { ry: dir, nc: true, nb: true, c: 0.02 });
}

/** Rooftop clutter that makes a roof read as a place rather than a lid. */
function roofKit(B, ctx, x, y, z, w, d, rng, keys) {
  const n = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const px = x + (rng() - 0.5) * (w - 3);
    const pz = z + (rng() - 0.5) * (d - 3);
    ctx.props.push({ type: rng() < 0.5 ? 'ac' : 'vent', x: px, y, z: pz, ry: rng() * Math.PI });
  }
  // Water tank on a stand.
  if (rng() < 0.75) {
    const px = x + (rng() - 0.5) * (w - 4), pz = z + (rng() - 0.5) * (d - 4);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      B.box(keys.metal, px + sx * 0.7, y + 0.65, pz + sz * 0.7, 0.11, 1.3, 0.11, { nc: true, nb: true, c: 0.02 });
    }
    B.geo(keys.tank, cylinderGeom(0.95, 0.95, 1.5, 14), new THREE.Matrix4().makeTranslation(px, y + 2.05, pz));
    B.geo(keys.metal, torusGeom(0.97, 0.045, 5, 16), new THREE.Matrix4()
      .makeRotationX(Math.PI / 2).setPosition(px, y + 1.75, pz));
    ctx.props.push({ type: 'pipe_short', x: px + 0.9, y, z: pz, ry: 0 });
  }
  // Antennae / aerials: silhouette detail against the sky.
  const a = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < a; i++) {
    const px = x + (rng() - 0.5) * (w - 1.5), pz = z + (rng() - 0.5) * (d - 1.5);
    const hh = 1.6 + rng() * 3.2;
    B.geo(keys.metal, tubeGeom([V(px, y, pz), V(px + (rng() - 0.5) * 0.5, y + hh, pz + (rng() - 0.5) * 0.5)], 0.028, 5));
    if (rng() < 0.5) {
      B.box(keys.metal, px, y + hh * 0.72, pz, 0.7, 0.04, 0.04, { ry: rng() * 3, nc: true, nb: true, c: 0.01 });
      B.box(keys.metal, px, y + hh * 0.86, pz, 0.5, 0.04, 0.04, { ry: rng() * 3, nc: true, nb: true, c: 0.01 });
    }
  }
}

/** Slack cable between two points — reads as inhabited infrastructure. */
function cable(B, key, a, b, sag = 0.9, r = 0.035) {
  B.geo(key, tubeGeom(catenary(a, b, sag, 14), r, 5));
}

/* =========================================================== SOUK PLAZA == */

export function buildPlaza(B, ctx) {
  const P = PAD.plaza;
  const rng = ctx.rng;
  const Y = P.y;

  /* paving: overlapping slabs of slightly different stone */
  B.box('stone_paving', 4, Y - 0.14, 4, 116, 0.3, 104, { c: 0.08, nb: true });
  B.box('concrete_warm', -18, Y + 0.03, 6, 44, 0.12, 40, { c: 0.05, nc: true, nb: true });
  B.box('concrete_pale', 30, Y + 0.03, 26, 34, 0.1, 30, { c: 0.05, nc: true, nb: true });

  // Kerb ring around the central island, raised one step.
  B.box('stone_paving', 0, Y + 0.11, 0, 15, 0.26, 15, { c: 0.06, nb: true });
  B.box('concrete_warm', 0, Y + 0.2, 0, 13.6, 0.1, 13.6, { c: 0.04, nc: true, nb: true });

  /* ---- hero prop cluster at the origin (the contact-range frame) ---- */
  // Pallet
  for (let i = 0; i < 5; i++) {
    B.box('wood', -0.9 + i * 0.28, Y + 0.31, 0.2, 0.2, 0.09, 1.5, { c: 0.02, nb: true });
  }
  B.box('wood_pale', -0.35, Y + 0.23, 0.2, 1.7, 0.1, 1.5, { c: 0.02, nc: true, nb: true });
  // Crates: two stacked, with corner brackets and a stencil panel.
  const crate = (cx, cy, cz, s, key, ry) => {
    B.box(key, cx, cy, cz, s, s * 0.86, s * 0.92, { ry, c: 0.035 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      B.box('steel_dark', cx + sx * (s / 2 - 0.03), cy, cz + sz * (s * 0.92 / 2 - 0.03),
        0.07, s * 0.86 - 0.04, 0.07, { ry, nc: true, nb: true, c: 0.015 });
    }
    B.box('steel_dark', cx, cy + s * 0.43 - 0.02, cz, s + 0.05, 0.05, s * 0.92 + 0.05, { ry, nc: true, nb: true, c: 0.015 });
    B.box('paint_yellow', cx, cy, cz + s * 0.47, s * 0.5, s * 0.3, 0.03, { ry, nc: true, nb: true, c: 0.01 });
  };
  crate(-0.35, Y + 0.72, 0.2, 1.02, 'wood', 0.02);
  crate(-0.5, Y + 1.52, 0.05, 0.86, 'paint_teal', -0.14);
  // Fuel drum with ribs
  const drumX = 1.15, drumZ = -0.3;
  B.geo('paint_rust', cylinderGeom(0.29, 0.29, 0.88, 16), new THREE.Matrix4().makeTranslation(drumX, Y + 0.44, drumZ));
  for (const ry of [0.28, 0.6]) {
    B.geo('steel_dark', torusGeom(0.30, 0.035, 5, 16), new THREE.Matrix4()
      .makeRotationX(Math.PI / 2).setPosition(drumX, Y + ry, drumZ));
  }
  B.geo('steel_bright', cylinderGeom(0.07, 0.07, 0.06, 8), new THREE.Matrix4().makeTranslation(drumX + 0.14, Y + 0.9, drumZ));
  B.clip('metal', drumX, Y + 0.44, drumZ, 0.6, 0.9, 0.6);
  // Rolled tarp + a leaning length of pipe, to break the box silhouette
  B.geo('canvas_indigo', cylinderGeom(0.19, 0.19, 1.5, 10), new THREE.Matrix4()
    .makeRotationZ(Math.PI / 2).setPosition(0.5, Y + 0.42, 1.15));
  B.geo('steel', tubeGeom([V(1.9, Y + 0.02, 0.9), V(1.35, Y + 1.5, 0.35)], 0.055, 7));
  B.geo('steel', tubeGeom([V(2.05, Y + 0.02, 1.0), V(1.5, Y + 1.42, 0.45)], 0.045, 7));
  // Ammo case
  B.box('paint_green', 1.5, Y + 0.42, 1.7, 0.78, 0.34, 0.44, { ry: 0.5, c: 0.03 });
  B.box('steel_dark', 1.5, Y + 0.6, 1.7, 0.8, 0.05, 0.46, { ry: 0.5, nc: true, nb: true, c: 0.015 });
  // Small hazard bollard for a colour accent + a lit lamp head
  B.box('paint_yellow', -2.2, Y + 0.55, 1.6, 0.22, 1.1, 0.22, { c: 0.04 });
  B.box('steel_dark', -2.2, Y + 1.12, 1.6, 0.3, 0.06, 0.3, { nc: true, nb: true, c: 0.02 });

  /* ---- fountain / cistern basin ---- */
  const fx = 20, fz = 13;
  B.geo('stone_paving', cylinderGeom(4.6, 4.9, 0.9, 24), new THREE.Matrix4().makeTranslation(fx, Y + 0.35, fz));
  B.geo('stone_paving', cylinderGeom(4.1, 4.1, 0.5, 24, true), new THREE.Matrix4().makeTranslation(fx, Y + 0.6, fz));
  B.geo('water', cylinderGeom(4.05, 4.05, 0.05, 24), new THREE.Matrix4().makeTranslation(fx, Y + 0.62, fz));
  B.geo('stone_paving', cylinderGeom(0.5, 0.75, 2.1, 12), new THREE.Matrix4().makeTranslation(fx, Y + 1.4, fz));
  B.geo('steel', sphereGeom(0.42, 12, 8), new THREE.Matrix4().makeTranslation(fx, Y + 2.6, fz));
  B.clip('concrete', fx, Y + 0.5, fz, 9.4, 1.1, 9.4);

  /* ---- market hall: colonnade, two floors, roof terrace ---- */
  const hx = -30, hz = 4, hw = 28, hd = 22;
  B.box('concrete_warm', hx, Y + 0.22, hz, hw + 2, 0.5, hd + 2, { c: 0.06, nb: true });
  // Columns on the east arcade
  for (let i = 0; i < 7; i++) {
    const cz = hz - hd / 2 + 1.8 + i * ((hd - 3.6) / 6);
    B.box('concrete_pale', hx + hw / 2 - 0.6, Y + 2.6, cz, 0.75, 4.6, 0.75, { c: 0.07 });
    B.box('concrete_pale', hx + hw / 2 - 0.6, Y + 5.05, cz, 1.05, 0.35, 1.05, { nc: true, nb: true, c: 0.05 });
  }
  // Shell
  B.wall('concrete_pale', hx - hw / 2, Y + 0.45, hz, hd, 9.4, 0.5, Math.PI / 2,
    [[3, 1.2, 2.2, 2.6], [9, 1.2, 2.2, 2.6], [15, 1.2, 2.2, 2.6], [4, 6.0, 2.0, 2.2], [12, 6.0, 2.0, 2.2]]);
  B.wall('concrete_pale', hx, Y + 0.45, hz - hd / 2, hw, 9.4, 0.5, 0,
    [[4, 0, 3.4, 4.0], [12, 6.0, 2.4, 2.2], [20, 1.2, 2.4, 2.6]]);
  B.wall('concrete_pale', hx, Y + 0.45, hz + hd / 2, hw, 9.4, 0.5, 0,
    [[6, 0, 3.4, 4.0], [14, 1.2, 2.4, 2.6], [21, 6.0, 2.4, 2.2]]);
  B.wall('concrete_pale', hx + hw / 2, Y + 5.3, hz, hd, 4.5, 0.5, Math.PI / 2,
    [[3, 0.8, 2.4, 2.4], [8.5, 0.8, 2.4, 2.4], [14, 0.8, 2.4, 2.4]]);
  // Floors
  B.box('concrete_pale', hx, Y + 5.05, hz, hw, 0.45, hd, { c: 0.05, nb: true });
  B.box('concrete_pale', hx, Y + 9.95, hz, hw + 1.2, 0.5, hd + 1.2, { c: 0.06, nb: true });
  parapet(B, 'concrete_pale', hx, Y + 10.2, hz, hw + 1.2, hd + 1.2, 1.0, 0.3);
  // Interior stair (ground -> first -> roof)
  B.stairs('concrete_pale', hx - hw / 2 + 2.2, Y + 0.45, hz - 8, 1.6, 0.19, 0.29, 24, 0, { rail: 'steel_dark' });
  B.stairs('concrete_pale', hx - hw / 2 + 4.6, Y + 5.3, hz - 8, 1.6, 0.19, 0.29, 24, 0, { rail: 'steel_dark' });
  B.clip('concrete', hx - hw / 2 + 2.2, Y + 5.3, hz - 1.0, 1.8, 0.4, 1.6);
  // Interior columns so the volume is not an empty shed
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j += 2) {
      B.box('concrete_pale', hx + i * 8, Y + 2.75, hz + j * 6, 0.7, 4.6, 0.7, { c: 0.05 });
      B.box('concrete_pale', hx + i * 8, Y + 7.6, hz + j * 6, 0.6, 4.6, 0.6, { c: 0.05 });
    }
  }
  roofKit(B, ctx, hx, Y + 10.2, hz, hw, hd, rng, { metal: 'steel_dark', tank: 'paint_teal' });
  ctx.lights.push({ x: hx, y: Y + 3.2, z: hz, color: 0xffce8a, intensity: 26, distance: 22 });
  ctx.lights.push({ x: hx, y: Y + 8.0, z: hz + 4, color: 0xffd9a0, intensity: 18, distance: 18 });

  /* ---- canopy field: the plaza's colour signature ---- */
  const canvases = ['canvas_red', 'canvas_saffron', 'canvas_indigo', 'canvas_bone'];
  for (let i = 0; i < 26; i++) {
    const ang = rng() * Math.PI * 2;
    const rad = 9 + rng() * 26;
    const px = 4 + Math.cos(ang) * rad * 1.25;
    const pz = 6 + Math.sin(ang) * rad;
    if (Math.abs(px - hx) < hw / 2 + 3 && Math.abs(pz - hz) < hd / 2 + 3) continue;
    if (Math.hypot(px - fx, pz - fz) < 7) continue;
    if (Math.hypot(px, pz) < 6.5) continue;
    const w = 2.6 + rng() * 2.2, d = 2.4 + rng() * 1.8;
    const hgt = 2.5 + rng() * 0.5;
    const ry = rng() * Math.PI;
    const key = canvases[(i + Math.floor(rng() * 4)) % 4];
    // posts
    const cs = Math.cos(ry), sn = Math.sin(ry);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const ox = sx * (w / 2 - 0.12) * cs - sz * (d / 2 - 0.12) * sn;
      const oz = -sx * (w / 2 - 0.12) * sn - sz * (d / 2 - 0.12) * cs;
      B.box('wood', px + ox, Y + hgt / 2, pz + oz, 0.1, hgt, 0.1, { nc: true, nb: true, c: 0.02 });
    }
    // sagging canvas: two panels pitched from a ridge
    B.box(key, px, Y + hgt + 0.16, pz, w, 0.05, d * 0.55, { ry, rx: 0.16, nc: true, nb: true, c: 0.02 });
    B.box(key, px, Y + hgt + 0.16, pz, w, 0.05, d * 0.55, { ry, rx: -0.16, nc: true, nb: true, c: 0.02 });
    B.box('wood', px, Y + hgt + 0.3, pz, w + 0.3, 0.07, 0.07, { ry, nc: true, nb: true, c: 0.02 });
    // stall counter + goods
    B.box('wood_pale', px, Y + 0.45, pz, w * 0.8, 0.9, d * 0.5, { ry, c: 0.03 });
    B.box('wood', px, Y + 0.93, pz, w * 0.86, 0.07, d * 0.56, { ry, nc: true, nb: true, c: 0.02 });
    ctx.props.push({ type: rng() < 0.5 ? 'crate' : 'sack', x: px + (rng() - 0.5) * 2, y: Y, z: pz + (rng() - 0.5) * 2, ry: rng() * 3 });
    if (rng() < 0.4) ctx.props.push({ type: 'barrel', x: px + (rng() - 0.5) * 3, y: Y, z: pz + (rng() - 0.5) * 3, ry: rng() * 3 });
  }

  /* ---- bunting: cables strung across the plaza ---- */
  for (let i = 0; i < 7; i++) {
    const a = V(-14 + i * 2.2, Y + 5.4 + rng(), -16 - i * 1.5);
    const b = V(26 + i * 1.4, Y + 4.8 + rng(), 12 + i * 2.2);
    cable(B, 'steel_dark', a, b, 1.6 + rng(), 0.028);
  }

  /* ---- east shophouse row: 3 storeys, balconies, teal shutters ---- */
  for (let i = 0; i < 4; i++) {
    const bw = 13 + (i % 2) * 3;
    const bx = 44 + (i % 2) * 1.5;
    const bz = -22 + i * 15;
    const floors = 3 + (i % 2);
    const fh = 3.3;
    const H = floors * fh;
    B.box('concrete_warm', bx, Y + 0.25, bz, bw + 1.4, 0.5, 13.4, { c: 0.06, nb: true });
    for (let f = 0; f < floors; f++) {
      const fy = Y + 0.5 + f * fh;
      const holes = f === 0
        ? [[2, 0, 3.6, 3.0]]
        : [[1.6, 0.9, 1.5, 1.9], [bw * 0.45, 0.9, 1.5, 1.9], [bw - 3.1, 0.9, 1.5, 1.9]];
      B.wall(f === 0 ? 'concrete_warm' : 'paint_cream', bx - bw / 2, fy, bz, 13, fh, 0.42, Math.PI / 2,
        f === 0 ? [[4, 0, 3.4, 3.0]] : [[2, 0.9, 1.6, 2.0], [8, 0.9, 1.6, 2.0]]);
      B.wall(f === 0 ? 'concrete_warm' : 'paint_cream', bx, fy, bz - 6.5, bw, fh, 0.42, 0, holes);
      B.wall(f === 0 ? 'concrete_warm' : 'paint_cream', bx, fy, bz + 6.5, bw, fh, 0.42, 0,
        f === 0 ? [] : [[2, 0.9, 1.5, 1.9], [bw - 3.5, 0.9, 1.5, 1.9]]);
      B.wall('concrete_warm', bx + bw / 2, fy, bz, 13, fh, 0.42, Math.PI / 2, []);
      B.box('concrete_pale', bx, fy + fh, bz, bw + 0.3, 0.4, 13.3, { c: 0.05, nb: true });
      if (f > 0) {
        // Balcony over the street with real railings + a hanging line.
        B.box('concrete_pale', bx - bw / 2 - 0.9, fy + 0.15, bz, 2.0, 0.24, 8.0, { c: 0.04, nb: true });
        B.railing('steel_dark', [
          V(bx - bw / 2 - 1.85, fy + 0.27, bz - 4), V(bx - bw / 2 - 1.85, fy + 0.27, bz + 4),
        ], 1.0);
        B.railing('steel_dark', [
          V(bx - bw / 2 - 1.85, fy + 0.27, bz - 4), V(bx - bw / 2 + 0.1, fy + 0.27, bz - 4)], 1.0);
        B.railing('steel_dark', [
          V(bx - bw / 2 - 1.85, fy + 0.27, bz + 4), V(bx - bw / 2 + 0.1, fy + 0.27, bz + 4)], 1.0);
        cable(B, 'steel_dark', V(bx - bw / 2 - 1.8, fy + 2.2, bz - 3.4), V(bx - bw / 2 - 1.8, fy + 2.2, bz + 3.4), 0.35, 0.02);
        for (let k = 0; k < 4; k++) {
          const t = -3.0 + k * 2.0;
          B.box(['canvas_bone', 'canvas_indigo', 'canvas_red'][k % 3],
            bx - bw / 2 - 1.8, fy + 1.75, bz + t, 0.02, 0.85, 0.6, { nc: true, nb: true, c: 0.005 });
        }
        awning(B, i % 2 ? 'canvas_red' : 'canvas_saffron', 'steel_dark',
          bx - bw / 2 - 0.2, fy + 2.8, bz, 8.4, 1.5, Math.PI * 1.5);
      } else {
        awning(B, 'canvas_saffron', 'steel_dark', bx - bw / 2 - 0.2, fy + 3.0, bz, 9, 2.0, Math.PI * 1.5);
      }
    }
    parapet(B, 'paint_cream', bx, Y + 0.5 + H + 0.4, bz, bw + 0.3, 13.3, 0.9, 0.26);
    // External stair to the roof at the alley end
    B.stairs('concrete_warm', bx + bw / 2 + 1.2, Y + 0.5, bz - 6.4, 1.4, 0.185, 0.28, Math.round(H / 0.185), 0,
      { rail: 'steel_dark' });
    roofKit(B, ctx, bx, Y + 0.9 + H, bz, bw - 1, 12, rng, { metal: 'steel_dark', tank: 'paint_rust' });
    ctx.lights.push({ x: bx - bw / 2 - 1.0, y: Y + 3.2, z: bz, color: 0xffb066, intensity: 12, distance: 14 });
    ctx.anchors.roofs.push({ x: bx, y: Y + 0.9 + H, z: bz, name: 'plaza-shophouse' });
  }

  /* ---- south warehouse with loading dock ---- */
  const wx = 14, wz = 50, ww = 30, wd = 20, wh2 = 9.5;
  B.box('concrete', wx, Y + 0.55, wz, ww + 3, 1.1, wd + 3, { c: 0.07, nb: true });
  B.wall('paint_hangar', wx, Y + 1.1, wz - wd / 2, ww, wh2, 0.4, 0, [[6, 0, 7, 5.6], [20, 1.5, 3, 3]]);
  B.wall('paint_hangar', wx, Y + 1.1, wz + wd / 2, ww, wh2, 0.4, 0, [[12, 1.5, 5, 3.4]]);
  B.wall('paint_hangar', wx - ww / 2, Y + 1.1, wz, wd, wh2, 0.4, Math.PI / 2, [[7, 0, 4, 4.2]]);
  B.wall('paint_hangar', wx + ww / 2, Y + 1.1, wz, wd, wh2, 0.4, Math.PI / 2, [[6, 2, 3, 3]]);
  B.box('concrete', wx, Y + 1.1 + wh2 + 0.25, wz, ww + 1, 0.5, wd + 1, { c: 0.06, nb: true });
  parapet(B, 'paint_hangar', wx, Y + 1.1 + wh2 + 0.5, wz, ww + 1, wd + 1, 0.75, 0.25);
  for (let i = 0; i < 5; i++) {
    B.box('steel_dark', wx - ww / 2 + 3 + i * 6, Y + 1.1 + wh2 * 0.5, wz - wd / 2 - 0.28, 0.35, wh2, 0.2, { nc: true, nb: true, c: 0.03 });
  }
  B.ramp('concrete', wx - 12, Y, wz - wd / 2 - 6.5, 7, 6.5, 1.1, 0);
  B.stairs('concrete', wx + 12, Y, wz - wd / 2 - 2.4, 1.6, 0.22, 0.3, 5, 0);
  roofKit(B, ctx, wx, Y + 1.6 + wh2, wz, ww - 2, wd - 2, rng, { metal: 'steel_dark', tank: 'paint_hangar' });
  ctx.anchors.roofs.push({ x: wx, y: Y + 1.6 + wh2, z: wz, name: 'plaza-warehouse' });
  ctx.lights.push({ x: wx, y: Y + 4.5, z: wz, color: 0xbfd8ff, intensity: 14, distance: 20 });

  /* ---- The Cistern: plaza landmark tower, north side ---- */
  const tx = -4, tz = -36;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    B.box('concrete', tx + sx * 3.4, Y + 11, tz + sz * 3.4, 1.5, 22, 1.5, { c: 0.08 });
    // Cross bracing between the legs
    for (let i = 0; i < 3; i++) {
      const y0 = Y + 2 + i * 6.6;
      B.geo('steel_dark', tubeGeom([
        V(tx + sx * 3.4, y0, tz + sz * 3.4), V(tx + sx * 3.4 * -1, y0 + 6.2, tz + sz * 3.4)], 0.08, 6));
    }
  }
  for (let i = 0; i < 4; i++) {
    const yy = Y + 4.4 + i * 5.4;
    B.box('concrete', tx, yy, tz, 8.6, 0.5, 1.0, { nc: true, nb: true, c: 0.05 });
    B.box('concrete', tx, yy, tz, 1.0, 0.5, 8.6, { nc: true, nb: true, c: 0.05 });
  }
  B.box('concrete', tx, Y + 22.4, tz, 11, 0.8, 11, { c: 0.08, nb: true });
  B.geo('paint_teal', cylinderGeom(4.6, 4.6, 7.4, 24), new THREE.Matrix4().makeTranslation(tx, Y + 26.6, tz));
  B.geo('steel_dark', torusGeom(4.68, 0.13, 6, 24), new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(tx, Y + 24.2, tz));
  B.geo('steel_dark', torusGeom(4.68, 0.13, 6, 24), new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(tx, Y + 28.9, tz));
  B.geo('paint_teal', coneGeom(4.9, 2.2, 24), new THREE.Matrix4().makeTranslation(tx, Y + 31.4, tz));
  B.clip('concrete', tx, Y + 26.6, tz, 9.2, 7.6, 9.2);
  B.geo('steel', tubeGeom([V(tx, Y + 32.4, tz), V(tx, Y + 36.4, tz)], 0.09, 6));
  B.box('lamp_red', tx, Y + 36.6, tz, 0.4, 0.4, 0.4, { nc: true, nb: true, c: 0.1 });
  // Access: stair up the tower, catwalk ring at the tank
  B.stairs('steel_dark', tx + 5.5, Y, tz - 5.5, 1.4, 0.2, 0.3, 30, Math.PI / 2, { rail: 'steel_dark' });
  B.catwalk('grating', 'steel_dark', V(tx + 5.5, Y + 6.0, tz + 3.5), V(tx + 5.5, Y + 6.0, tz - 5.5), 1.4);
  B.stairs('steel_dark', tx + 5.5, Y + 6.0, tz + 3.6, 1.4, 0.2, 0.3, 30, -Math.PI / 2, { rail: 'steel_dark' });
  B.catwalk('grating', 'steel_dark', V(tx + 5.5, Y + 12.0, tz - 5.5), V(tx - 5.5, Y + 12.0, tz - 5.5), 1.4);
  B.stairs('steel_dark', tx - 5.5, Y + 12.0, tz - 5.5, 1.4, 0.2, 0.3, 30, 0, { rail: 'steel_dark' });
  B.catwalk('grating', 'steel_dark', V(tx - 5.5, Y + 18.0, tz + 3.5), V(tx - 5.5, Y + 18.0, tz - 5.4), 1.4);
  B.stairs('steel_dark', tx - 5.5, Y + 18.0, tz + 3.6, 1.4, 0.19, 0.3, 24, Math.PI / 2, { rail: 'steel_dark' });
  B.railing('steel_dark', [
    V(tx - 5.5, Y + 22.8, tz - 5.5), V(tx + 5.5, Y + 22.8, tz - 5.5),
    V(tx + 5.5, Y + 22.8, tz + 5.5), V(tx - 5.5, Y + 22.8, tz + 5.5),
    V(tx - 5.5, Y + 22.8, tz - 5.5)], 1.05);
  // Feed pipes down one leg
  B.pipe('steel', [V(tx + 3.4, Y + 24, tz + 4.2), V(tx + 3.4, Y + 2, tz + 4.2), V(tx + 9, Y + 1.2, tz + 4.2)], 0.24);
  ctx.anchors.roofs.push({ x: tx, y: Y + 23.2, z: tz, name: 'cistern' });
  ctx.anchors.high.push({ x: tx, y: Y + 23.2, z: tz, name: 'cistern' });

  /* ---- plaza lamp standards ---- */
  for (let i = 0; i < 10; i++) {
    const ang = (i / 10) * Math.PI * 2 + 0.3;
    const px = 4 + Math.cos(ang) * 36, pz = 6 + Math.sin(ang) * 30;
    B.box('steel_dark', px, Y + 2.6, pz, 0.16, 5.2, 0.16, { c: 0.03 });
    B.box('steel_dark', px, Y + 5.15, pz, 1.2, 0.12, 0.12, { nc: true, nb: true, c: 0.03 });
    B.box('lamp_warm', px + 0.5, Y + 4.98, pz, 0.42, 0.16, 0.3, { nc: true, nb: true, c: 0.05 });
    if (i % 3 === 0) ctx.lights.push({ x: px + 0.5, y: Y + 4.9, z: pz, color: 0xffbb66, intensity: 14, distance: 16 });
  }

  ctx.anchors.pads.push({ x: 26, y: Y, z: -8, dir: [0, 1, -0.25] });
  ctx.anchors.pads.push({ x: -18, y: Y, z: 30, dir: [-0.2, 1, 0] });
  return { name: 'Souk Plaza', x: 4, z: 4, y: Y };
}

/* ============================================================= HANGAR 7 == */

export function buildHangar(B, ctx) {
  const P = PAD.hangar;
  const rng = ctx.rng;
  const Y = P.y;
  const cx = P.x, cz = P.z;
  const W = 76, D = 46, H = 17;      // clear internal volume
  const t = 0.55;

  /* apron */
  B.box('concrete', cx, Y - 0.15, cz, W + 46, 0.5, D + 44, { c: 0.08, nb: true });
  B.box('concrete_dark', cx, Y + 0.06, cz + D / 2 + 22, W + 30, 0.06, 26, { c: 0.03, nc: true, nb: true });
  // Apron markings
  for (let i = -3; i <= 3; i++) {
    B.box('paint_yellow', cx + i * 11, Y + 0.1, cz + D / 2 + 20, 0.35, 0.04, 22, { nc: true, nb: true, c: 0.01 });
  }
  B.box('paint_yellow', cx, Y + 0.1, cz + D / 2 + 8, 44, 0.04, 0.45, { nc: true, nb: true, c: 0.01 });

  /* slab + walls */
  B.box('concrete', cx, Y + 0.15, cz, W + 2, 0.6, D + 2, { c: 0.06, nb: true });
  const doorW = 26, doorH = 12.5;
  // Long walls with a high clerestory band
  for (const s of [-1, 1]) {
    B.wall('paint_hangar', cx, Y + 0.45, cz + s * D / 2, W, H, t, 0,
      [[8, 10.5, 7, 3.2], [22, 10.5, 7, 3.2], [W - 29, 10.5, 7, 3.2], [W - 15, 10.5, 7, 3.2],
       [W * 0.5 - 3, 0, 4.2, 4.6]]);
    // Glazing in the clerestory
    for (const u of [8, 22, W - 29, W - 15]) {
      B.box('glass_dirty', cx + u + 3.5 - W / 2, Y + 0.45 + 12.1, cz + s * D / 2, 6.8, 3.0, 0.14, { nc: true, nb: true, c: 0.02 });
    }
    // Pilasters + a plinth course
    for (let i = 0; i <= 9; i++) {
      B.box('paint_hangar', cx - W / 2 + i * (W / 9), Y + 0.45 + H / 2, cz + s * (D / 2 + t / 2 + 0.12),
        0.5, H, 0.26, { nc: true, nb: true, c: 0.04 });
    }
    B.box('concrete_dark', cx, Y + 0.9, cz + s * (D / 2 + 0.14), W + 0.6, 1.5, 0.3, { nc: true, nb: true, c: 0.04 });
    // Corrugation: shallow ribs, cheap but they carry the raking sunlight.
    for (let i = 0; i < 46; i++) {
      B.box('paint_hangar', cx - W / 2 + 0.9 + i * (W / 46), Y + 0.45 + H / 2, cz + s * (D / 2 + t / 2 + 0.05),
        0.16, H - 0.2, 0.1, { nc: true, nb: true, c: 0.02 });
    }
  }
  // Gable ends: big door opening on the south, half-open sliders on the north
  B.wall('paint_hangar', cx, Y + 0.45, cz + D / 2 + 0, 0.01, 0.01, 0.01, 0, []);
  for (const s of [-1, 1]) {
    B.wall('paint_hangar', cx + s * W / 2, Y + 0.45, cz, D, H, t, Math.PI / 2,
      [[(D - doorW) / 2, 0, doorW, doorH], [3, 13.5, 4, 2.4], [D - 7, 13.5, 4, 2.4]]);
    for (const u of [3, D - 7]) {
      B.box('glass_dirty', cx + s * W / 2, Y + 0.45 + 14.7, cz + u + 2 - D / 2, 0.14, 2.2, 3.8, { nc: true, nb: true, c: 0.02 });
    }
    // Door head beam + track
    B.box('steel_dark', cx + s * (W / 2 + 0.35), Y + 0.45 + doorH + 0.5, cz, 0.7, 1.0, doorW + 3, { nc: true, nb: true, c: 0.05 });
  }
  // Sliding door leaves, parked open on the north end
  for (const off of [-1, 1]) {
    B.box('paint_hangar', cx - W / 2 - 0.5, Y + 0.45 + doorH / 2, cz + off * (doorW / 2 + 3.4),
      0.35, doorH, 7.5, { c: 0.05 });
    for (let i = 0; i < 8; i++) {
      B.box('steel_dark', cx - W / 2 - 0.72, Y + 0.9 + i * 1.5, cz + off * (doorW / 2 + 3.4), 0.1, 0.12, 7.4, { nc: true, nb: true, c: 0.02 });
    }
  }

  /* gable roof: trusses, deck, skylight strips */
  const ridge = Y + 0.45 + H + 6.2;
  const eave = Y + 0.45 + H;
  const bays = 9;
  for (let i = 0; i <= bays; i++) {
    const px = cx - W / 2 + i * (W / bays);
    B.truss('steel_dark', V(px, eave, cz - D / 2), V(px, ridge, cz), 0.85);
    B.truss('steel_dark', V(px, ridge, cz), V(px, eave, cz + D / 2), 0.85);
    B.geo('steel_dark', tubeGeom([V(px, eave + 0.2, cz - D / 2 + 1), V(px, eave + 0.2, cz + D / 2 - 1)], 0.06, 6));
  }
  for (let i = 0; i < bays; i++) {
    const px = cx - W / 2 + (i + 0.5) * (W / bays);
    B.geo('steel_dark', tubeGeom([V(px, ridge - 0.4, cz - D / 2 + 2), V(px, ridge - 0.4, cz + D / 2 - 2)], 0.05, 5));
  }
  // Purlins running the length of the shed
  for (let j = 1; j <= 5; j++) {
    const t2 = j / 6;
    for (const s of [-1, 1]) {
      const yy = eave + (ridge - eave) * t2;
      const zz = cz + s * (D / 2) * (1 - t2);
      B.geo('steel_dark', tubeGeom([V(cx - W / 2, yy, zz), V(cx + W / 2, yy, zz)], 0.05, 5));
    }
  }
  // Roof planes, split so skylight strips can be punched between them
  const pitch = Math.atan2(6.2, D / 2);
  const slopeLen = Math.hypot(6.2, D / 2);
  const segs = [[0, 0.30], [0.36, 0.62], [0.68, 1.0]];
  for (const s of [-1, 1]) {
    for (const [a, b] of segs) {
      const midT = (a + b) / 2;
      const yy = ridge - (ridge - eave) * midT;
      const zz = cz + s * (D / 2) * midT;
      B.box('paint_hangar', cx, yy, zz, W + 1.4, 0.3, slopeLen * (b - a),
        { rx: s * pitch, c: 0.05, nb: true });
      // Standing seams
      for (let i = 0; i < 26; i++) {
        B.box('paint_hangar', cx - W / 2 + i * (W / 25), yy + 0.2, zz, 0.12, 0.14, slopeLen * (b - a),
          { rx: s * pitch, nc: true, nb: true, c: 0.02 });
      }
    }
    // Skylight ribbons between the roof segments — these are the god-ray shafts.
    for (const g of [0.33, 0.65]) {
      const yy = ridge - (ridge - eave) * g;
      const zz = cz + s * (D / 2) * g;
      B.box('glass', cx, yy, zz, W - 3, 0.1, slopeLen * 0.055, { rx: s * pitch, nc: true, nb: true, c: 0.02 });
      B.box('steel_dark', cx, yy + 0.14, zz, W - 3, 0.12, slopeLen * 0.07, { rx: s * pitch, nc: true, nb: true, c: 0.02 });
    }
  }
  B.box('paint_hangar', cx, ridge + 0.55, cz, W + 1.6, 0.55, 2.4, { c: 0.07, nb: true });
  for (let i = 0; i < 6; i++) {
    B.box('steel_dark', cx - W / 2 + 6 + i * 13, ridge + 1.2, cz, 1.6, 0.8, 3.0, { nc: true, nb: true, c: 0.06 });
  }
  // Roof is reachable: external stair cage on the east wall
  B.stairs('grating', cx + W / 2 + 2.2, Y + 0.45, cz - 14, 1.3, 0.2, 0.29, 30, 0, { rail: 'steel_dark' });
  B.catwalk('grating', 'steel_dark', V(cx + W / 2 + 2.2, Y + 6.45, cz - 5.3), V(cx + W / 2 + 2.2, Y + 6.45, cz + 6), 1.3);
  B.stairs('grating', cx + W / 2 + 2.2, Y + 6.45, cz + 6, 1.3, 0.2, 0.29, 30, -Math.PI, { rail: 'steel_dark' });
  B.stairs('grating', cx + W / 2 + 2.2, Y + 12.45, cz - 3.4, 1.3, 0.2, 0.29, 30, 0, { rail: 'steel_dark' });
  B.catwalk('grating', 'steel_dark', V(cx + W / 2 + 2.2, eave + 0.4, cz + 5.4), V(cx + W / 2 - 1.5, eave + 0.4, cz + 5.4), 1.3);

  /* interior: mezzanine, offices, cranes */
  for (const s of [-1, 1]) {
    const mz = cz + s * (D / 2 - 4.2);
    B.box('grating', cx, Y + 8.0, mz, W - 8, 0.3, 6.0, { c: 0.04, nb: true });
    B.railing('steel_dark', [V(cx - W / 2 + 4, Y + 8.15, mz - s * 3), V(cx + W / 2 - 4, Y + 8.15, mz - s * 3)], 1.05);
    for (let i = 0; i < 8; i++) {
      const px = cx - W / 2 + 5 + i * ((W - 10) / 7);
      B.box('steel_dark', px, Y + 4.2, mz - s * 2.6, 0.3, 7.6, 0.3, { c: 0.03 });
      B.geo('steel_dark', tubeGeom([V(px, Y + 7.7, mz - s * 2.6), V(px, Y + 5.2, mz + s * 1.2)], 0.06, 6));
    }
  }
  B.stairs('grating', cx - 26, Y + 0.45, cz + D / 2 - 9.5, 1.5, 0.2, 0.3, 38, 0, { rail: 'steel_dark' });
  B.stairs('grating', cx + 24, Y + 0.45, cz - D / 2 + 9.5, 1.5, 0.2, 0.3, 38, Math.PI, { rail: 'steel_dark' });
  // Overhead crane rail + gantry
  for (const s of [-1, 1]) {
    B.box('steel_dark', cx, Y + 12.4, cz + s * (D / 2 - 2.4), W, 0.55, 0.4, { nc: true, nb: true, c: 0.05 });
  }
  B.box('paint_yellow', cx - 12, Y + 12.9, cz, 2.2, 1.1, D - 5, { c: 0.06 });
  B.box('steel_dark', cx - 12, Y + 11.9, cz + 3, 1.4, 1.4, 1.4, { c: 0.05 });
  cable(B, 'steel_dark', V(cx - 12, Y + 11.4, cz + 3), V(cx - 12, Y + 3.2, cz + 3), 0.05, 0.035);
  B.box('steel_dark', cx - 12, Y + 2.8, cz + 3, 1.0, 0.5, 0.7, { c: 0.04 });
  // Interior offices along the west wall (two floors, enterable)
  const ox = cx + W / 2 - 11;
  B.box('paint_cream', ox, Y + 0.6, cz - D / 2 + 5, 18, 0.3, 9, { c: 0.04, nb: true });
  B.wall('paint_cream', ox, Y + 0.75, cz - D / 2 + 9.5, 18, 3.4, 0.3, 0, [[2, 0, 1.6, 2.4], [8, 0.9, 3.2, 1.8], [14, 0.9, 2.4, 1.8]]);
  B.box('glass_dirty', ox - 9 + 9.6, Y + 0.75 + 1.8, cz - D / 2 + 9.5, 3.1, 1.7, 0.1, { nc: true, nb: true, c: 0.02 });
  B.box('glass_dirty', ox - 9 + 15.2, Y + 0.75 + 1.8, cz - D / 2 + 9.5, 2.3, 1.7, 0.1, { nc: true, nb: true, c: 0.02 });
  B.box('paint_cream', ox, Y + 4.3, cz - D / 2 + 5, 18, 0.35, 9, { c: 0.04, nb: true });
  B.wall('paint_cream', ox, Y + 4.5, cz - D / 2 + 9.5, 18, 3.4, 0.3, 0, [[3, 0.9, 3.2, 1.8], [11, 0.9, 3.2, 1.8]]);
  B.box('paint_cream', ox, Y + 8.1, cz - D / 2 + 5, 18, 0.35, 9, { c: 0.04, nb: true });
  B.railing('steel_dark', [V(ox - 9, Y + 8.3, cz - D / 2 + 9.5), V(ox + 9, Y + 8.3, cz - D / 2 + 9.5)], 1.05);
  B.stairs('grating', ox + 7.5, Y + 0.75, cz - D / 2 + 10.6, 1.4, 0.2, 0.3, 18, 0, { rail: 'steel_dark' });

  ctx.lights.push({ x: cx - 20, y: Y + 9, z: cz, color: 0xdfeaff, intensity: 90, distance: 46 });
  ctx.lights.push({ x: cx + 18, y: Y + 9, z: cz, color: 0xdfeaff, intensity: 90, distance: 46 });
  ctx.lights.push({ x: cx, y: Y + 12, z: cz, color: 0xffe6c0, intensity: 70, distance: 40 });
  ctx.lights.push({ x: ox, y: Y + 2.4, z: cz - D / 2 + 5, color: 0xfff0d0, intensity: 16, distance: 14 });

  /* exterior kit */
  for (let i = 0; i < 9; i++) {
    ctx.props.push({ type: 'container', x: cx - 34 + (i % 3) * 7, y: Y, z: cz + D / 2 + 12 + Math.floor(i / 3) * 3.4, ry: 0, stack: i % 2 });
  }
  for (let i = 0; i < 16; i++) {
    ctx.props.push({ type: rng() < 0.5 ? 'barrel' : 'crate', x: cx + 20 + rng() * 26, y: Y, z: cz + 8 + (rng() - 0.5) * 30, ry: rng() * 3 });
  }
  ctx.anchors.roofs.push({ x: cx, y: ridge + 0.9, z: cz, name: 'hangar-ridge' });
  ctx.anchors.high.push({ x: cx, y: ridge + 0.9, z: cz, name: 'hangar-ridge' });
  ctx.anchors.pads.push({ x: cx + W / 2 + 12, y: Y, z: cz + 10, dir: [0.35, 1, 0.1] });
  return { name: 'Hangar 7', x: cx, z: cz, y: Y };
}

/* ============================================================ THE FOUNDRY = */

export function buildFoundry(B, ctx) {
  const P = PAD.foundry;
  const rng = ctx.rng;
  const Y = P.y, cx = P.x, cz = P.z;

  B.box('concrete_dark', cx, Y - 0.2, cz, 118, 0.6, 108, { c: 0.08, nb: true });
  B.box('concrete', cx - 20, Y + 0.08, cz + 10, 60, 0.1, 52, { nc: true, nb: true, c: 0.04 });

  /* --- tank farm: four cylinders in bunded pits --- */
  const tanks = [[-34, -26, 8.5, 13], [-34, 2, 8.5, 13], [-12, -26, 7.0, 16], [-12, 2, 7.0, 16]];
  for (let i = 0; i < tanks.length; i++) {
    const [dx, dz, r, h] = tanks[i];
    const px = cx + dx, pz = cz + dz;
    const key = i % 2 ? 'paint_copper' : 'paint_rust';
    // bund wall
    B.box('concrete', px, Y + 0.7, pz - r - 1.6, r * 2 + 4, 1.4, 0.55, { c: 0.05 });
    B.box('concrete', px, Y + 0.7, pz + r + 1.6, r * 2 + 4, 1.4, 0.55, { c: 0.05 });
    B.box('concrete', px - r - 1.6, Y + 0.7, pz, 0.55, 1.4, r * 2 + 3.2, { c: 0.05 });
    B.box('concrete', px + r + 1.6, Y + 0.7, pz, 0.55, 1.4, r * 2 + 3.2, { c: 0.05 });
    B.geo('concrete_dark', cylinderGeom(r + 0.5, r + 0.7, 0.9, 24), new THREE.Matrix4().makeTranslation(px, Y + 0.45, pz));
    B.geo(key, cylinderGeom(r, r, h, 26), new THREE.Matrix4().makeTranslation(px, Y + 0.9 + h / 2, pz));
    // Girth rings + vertical seams: a bare cylinder reads as a primitive.
    for (let k = 1; k < 4; k++) {
      B.geo('steel_dark', torusGeom(r + 0.06, 0.09, 5, 26), new THREE.Matrix4()
        .makeRotationX(Math.PI / 2).setPosition(px, Y + 0.9 + (h * k) / 4, pz));
    }
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      B.box(key, px + Math.cos(a) * (r + 0.04), Y + 0.9 + h / 2, pz + Math.sin(a) * (r + 0.04),
        0.1, h - 0.3, 0.1, { ry: -a, nc: true, nb: true, c: 0.02 });
    }
    B.geo(key, coneGeom(r + 0.2, 1.5, 26), new THREE.Matrix4().makeTranslation(px, Y + 0.9 + h + 0.7, pz));
    B.clip('metal', px, Y + 0.9 + h / 2, pz, r * 1.9, h, r * 1.9);
    // spiral-ish access stair, four straight flights around the tank
    let sy = Y + 0.9;
    for (let f = 0; f < 4 && sy < Y + h - 1; f++) {
      const a0 = f * Math.PI / 2;
      const sx2 = px + Math.cos(a0) * (r + 1.1), sz2 = pz + Math.sin(a0) * (r + 1.1);
      B.stairs('grating', sx2, sy, sz2, 1.15, 0.2, 0.3, 16, a0 + Math.PI / 2, { rail: 'steel_dark' });
      sy += 16 * 0.2;
    }
    // Top ring catwalk
    const ringPts = [];
    for (let k = 0; k <= 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      ringPts.push(V(px + Math.cos(a) * (r + 0.9), Y + 0.9 + h + 0.1, pz + Math.sin(a) * (r + 0.9)));
    }
    B.geo('grating', tubeGeom(ringPts, 0.55, 6, false));
    B.railing('steel_dark', ringPts, 1.0, { solid: false });
    ctx.anchors.roofs.push({ x: px, y: Y + 0.9 + h + 0.4, z: pz, name: 'foundry-tank' });
  }
  // Catwalk web between tanks
  B.catwalk('grating', 'steel_dark', V(cx - 34, Y + 14.4, cz - 17), V(cx - 34, Y + 14.4, cz - 7), 1.5);
  B.catwalk('grating', 'steel_dark', V(cx - 25.5, Y + 15.5, cz - 26), V(cx - 20.5, Y + 17.2, cz - 26), 1.5);
  B.catwalk('grating', 'steel_dark', V(cx - 12, Y + 17.4, cz - 19), V(cx - 12, Y + 17.4, cz - 5), 1.5);

  /* --- spherical LPG vessels on legs --- */
  for (let i = 0; i < 2; i++) {
    const px = cx + 12 + i * 18, pz = cz - 30;
    B.geo('paint_white', sphereGeom(5.2, 22, 14), new THREE.Matrix4().makeTranslation(px, Y + 9.4, pz));
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      B.geo('steel_dark', tubeGeom([
        V(px + Math.cos(a) * 3.9, Y, pz + Math.sin(a) * 3.9),
        V(px + Math.cos(a) * 4.3, Y + 8.2, pz + Math.sin(a) * 4.3)], 0.19, 7));
    }
    B.geo('steel_dark', torusGeom(4.3, 0.1, 5, 20), new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(px, Y + 4.2, pz));
    B.clip('metal', px, Y + 9.4, pz, 9.4, 10.4, 9.4);
    B.geo('paint_red', torusGeom(5.24, 0.22, 5, 24), new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(px, Y + 9.4, pz));
  }

  /* --- cracking column + flare stack: the vertical signature --- */
  const colx = cx + 6, colz = cz + 16;
  B.geo('concrete', cylinderGeom(3.6, 4.0, 1.4, 20), new THREE.Matrix4().makeTranslation(colx, Y + 0.7, colz));
  B.geo('paint_rust', cylinderGeom(2.7, 3.0, 30, 22), new THREE.Matrix4().makeTranslation(colx, Y + 16.4, colz));
  B.geo('paint_rust', coneGeom(3.0, 3.0, 22), new THREE.Matrix4().makeTranslation(colx, Y + 32.8, colz));
  for (let k = 1; k <= 6; k++) {
    B.geo('steel_dark', torusGeom(3.02, 0.12, 5, 22), new THREE.Matrix4()
      .makeRotationX(Math.PI / 2).setPosition(colx, Y + 1.4 + k * 4.6, colz));
  }
  B.clip('metal', colx, Y + 16.4, colz, 6, 32, 6);
  let ly = Y + 1.4;
  for (let f = 0; f < 6; f++) {
    const a0 = f * 1.1;
    const sx2 = colx + Math.cos(a0) * 4.2, sz2 = colz + Math.sin(a0) * 4.2;
    B.stairs('grating', sx2, ly, sz2, 1.1, 0.2, 0.3, 14, a0 + Math.PI / 2, { rail: 'steel_dark' });
    ly += 14 * 0.2;
    if (f % 2 === 1) {
      const ring = [];
      for (let k = 0; k <= 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        ring.push(V(colx + Math.cos(a) * 3.9, ly, colz + Math.sin(a) * 3.9));
      }
      B.geo('grating', tubeGeom(ring, 0.5, 6));
      B.railing('steel_dark', ring, 1.0, { solid: false });
    }
  }
  ctx.anchors.high.push({ x: colx, y: ly + 0.4, z: colz, name: 'foundry-column' });
  ctx.anchors.roofs.push({ x: colx, y: ly + 0.4, z: colz, name: 'foundry-column' });

  // Flare stack: open lattice so it reads against the sky
  const flx = cx + 34, flz = cz + 24;
  const flH = 54;
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    B.geo('steel_dark', tubeGeom([
      V(flx + Math.cos(a) * 3.2, Y, flz + Math.sin(a) * 3.2),
      V(flx + Math.cos(a) * 1.1, Y + flH, flz + Math.sin(a) * 1.1)], 0.16, 7));
  }
  for (let i = 0; i < 20; i++) {
    const t0 = i / 20, t1 = (i + 1) / 20;
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2, b = ((k + 1) / 3) * Math.PI * 2;
      const r0 = 3.2 + (1.1 - 3.2) * t0, r1 = 3.2 + (1.1 - 3.2) * t1;
      B.geo('steel_dark', tubeGeom([
        V(flx + Math.cos(a) * r0, Y + flH * t0, flz + Math.sin(a) * r0),
        V(flx + Math.cos(b) * r1, Y + flH * t1, flz + Math.sin(b) * r1)], 0.06, 5));
      B.geo('steel_dark', tubeGeom([
        V(flx + Math.cos(a) * r0, Y + flH * t0, flz + Math.sin(a) * r0),
        V(flx + Math.cos(b) * r0, Y + flH * t0, flz + Math.sin(b) * r0)], 0.05, 5));
    }
  }
  B.geo('paint_rust', cylinderGeom(0.65, 0.65, flH + 3, 12), new THREE.Matrix4().makeTranslation(flx, Y + (flH + 3) / 2, flz));
  B.geo('steel_bright', cylinderGeom(1.0, 0.7, 2.4, 12), new THREE.Matrix4().makeTranslation(flx, Y + flH + 4, flz));
  B.box('lamp_red', flx, Y + flH + 5.6, flz, 0.5, 0.5, 0.5, { nc: true, nb: true, c: 0.12 });
  B.clip('metal', flx, Y + flH / 2, flz, 5, flH, 5);
  ctx.lights.push({ x: flx, y: Y + flH + 5, z: flz, color: 0xff5522, intensity: 40, distance: 40 });

  /* --- pipe racks: the connective tissue --- */
  const rackY = Y + 6.2;
  for (let i = 0; i <= 10; i++) {
    const px = cx - 44 + i * 8.4;
    B.box('concrete', px, Y + rackY / 2 - Y / 2 + 3.1 - 3.1 + (rackY - Y) / 2, cz + 34, 0.7, rackY - Y, 0.7, { c: 0.05 });
    B.box('steel_dark', px, rackY + 0.2, cz + 34, 1.2, 0.4, 4.6, { nc: true, nb: true, c: 0.04 });
    B.box('steel_dark', px, rackY + 2.6, cz + 34, 1.2, 0.35, 4.0, { nc: true, nb: true, c: 0.04 });
  }
  const rackKeys = ['steel', 'paint_copper', 'paint_rust', 'paint_yellow', 'steel_dark'];
  for (let k = 0; k < 6; k++) {
    const zz = cz + 32 + (k % 3) * 1.7;
    const yy = rackY + 0.5 + Math.floor(k / 3) * 2.4;
    const rr = 0.16 + (k % 3) * 0.09;
    B.pipe(rackKeys[k % rackKeys.length], [V(cx - 46, yy, zz), V(cx + 44, yy, zz)], rr, false);
  }
  // Risers linking the rack to the tanks and column
  B.pipe('paint_copper', [V(cx - 34, Y + 14.5, cz + 2), V(cx - 34, rackY + 1.2, cz + 20), V(cx - 34, rackY + 1.2, cz + 31)], 0.22);
  B.pipe('steel', [V(colx, Y + 20, colz + 3), V(colx, rackY + 3.0, cz + 28), V(cx + 20, rackY + 3.0, cz + 32)], 0.26);
  B.pipe('paint_rust', [V(flx, Y + 12, flz - 2), V(flx - 6, rackY + 1.2, cz + 32)], 0.3);
  // A long spur running back toward the plaza — ties the map together.
  B.pipe('paint_copper', [V(cx - 46, rackY + 0.5, cz + 33), V(cx - 70, rackY - 1.5, cz + 26), V(cx - 96, Y + 2.5, cz + 12)], 0.28);

  /* --- control building: two floors, enterable, roof deck --- */
  const bx = cx + 30, bz = cz - 6, bw = 22, bd = 14;
  B.box('concrete', bx, Y + 0.3, bz, bw + 2, 0.6, bd + 2, { c: 0.06, nb: true });
  for (let f = 0; f < 2; f++) {
    const fy = Y + 0.6 + f * 4.0;
    B.wall('concrete_pale', bx, fy, bz - bd / 2, bw, 4.0, 0.4, 0,
      f === 0 ? [[3, 0, 1.8, 2.6], [9, 1.1, 6.0, 1.9]] : [[3, 1.1, 6.0, 1.9], [13, 1.1, 5.0, 1.9]]);
    B.wall('concrete_pale', bx, fy, bz + bd / 2, bw, 4.0, 0.4, 0, [[8, 1.1, 5.0, 1.9]]);
    B.wall('concrete_pale', bx - bw / 2, fy, bz, bd, 4.0, 0.4, Math.PI / 2, f === 0 ? [[5, 0, 2.0, 2.6]] : []);
    B.wall('concrete_pale', bx + bw / 2, fy, bz, bd, 4.0, 0.4, Math.PI / 2, [[5, 1.1, 4.0, 1.9]]);
    B.box('concrete', bx, fy + 4.0, bz, bw, 0.4, bd, { c: 0.05, nb: true });
    // Glazing
    const glass = f === 0 ? [[9, 1.1, 6.0, 1.9]] : [[3, 1.1, 6.0, 1.9], [13, 1.1, 5.0, 1.9]];
    for (const g of glass) {
      B.box('glass', bx + g[0] + g[2] / 2 - bw / 2, fy + g[1] + g[3] / 2, bz - bd / 2, g[2] - 0.15, g[3] - 0.15, 0.12,
        { nc: true, nb: true, c: 0.02 });
    }
  }
  B.box('concrete', bx, Y + 8.85, bz, bw + 1.4, 0.5, bd + 1.4, { c: 0.06, nb: true });
  parapet(B, 'concrete_pale', bx, Y + 9.1, bz, bw + 1.4, bd + 1.4, 0.95, 0.28);
  B.stairs('concrete_pale', bx - bw / 2 - 1.5, Y + 0.6, bz - 5, 1.5, 0.2, 0.3, 21, 0, { rail: 'steel_dark' });
  B.stairs('grating', bx + bw / 2 + 1.6, Y + 4.6, bz + 4, 1.4, 0.2, 0.3, 22, -Math.PI, { rail: 'steel_dark' });
  roofKit(B, ctx, bx, Y + 9.1, bz, bw - 2, bd - 2, rng, { metal: 'steel_dark', tank: 'paint_rust' });
  ctx.lights.push({ x: bx, y: Y + 2.5, z: bz, color: 0xfff0cc, intensity: 20, distance: 18 });
  ctx.lights.push({ x: bx, y: Y + 6.5, z: bz, color: 0xcfe4ff, intensity: 18, distance: 18 });
  ctx.anchors.roofs.push({ x: bx, y: Y + 9.1, z: bz, name: 'foundry-control' });

  /* --- yard clutter --- */
  for (let i = 0; i < 30; i++) {
    ctx.props.push({
      type: ['barrel', 'barrel', 'crate', 'spool', 'pipe_pile'][Math.floor(rng() * 5)],
      x: cx - 50 + rng() * 100, y: Y, z: cz + 42 + rng() * 16, ry: rng() * 3,
    });
  }
  for (let i = 0; i < 14; i++) {
    ctx.props.push({ type: 'barrel', x: cx + 18 + rng() * 22, y: Y, z: cz + 2 + rng() * 22, ry: rng() * 3 });
  }
  ctx.anchors.pads.push({ x: cx - 46, y: Y, z: cz + 18, dir: [-0.3, 1, 0.15] });
  return { name: 'The Foundry', x: cx, z: cz, y: Y };
}

/* =========================================================== TERRACE ROW = */

export function buildTerrace(B, ctx) {
  const P = PAD.terrace;
  const rng = ctx.rng;
  const Y = P.y, cx = P.x, cz = P.z;

  B.box('concrete_warm', cx, Y - 0.1, cz, 78, 0.4, 132, { c: 0.06, nb: true });
  B.box('asphalt', cx + 2, Y + 0.09, cz, 11, 0.08, 128, { c: 0.03, nc: true, nb: true });
  for (let i = -8; i <= 8; i++) {
    B.box('paint_cream', cx + 2, Y + 0.14, cz + i * 8, 0.3, 0.03, 3.4, { nc: true, nb: true, c: 0.01 });
  }
  B.box('concrete_pale', cx + 8.2, Y + 0.19, cz, 2.4, 0.28, 128, { c: 0.05, nb: true });
  B.box('concrete_pale', cx - 4.2, Y + 0.19, cz, 2.4, 0.28, 128, { c: 0.05, nb: true });

  const rowKeys = ['paint_cream', 'concrete_warm', 'paint_cream', 'concrete_pale', 'concrete_warm'];
  for (let side = 0; side < 2; side++) {
    const sgn = side ? 1 : -1;
    const bx = cx + 2 + sgn * 16;
    for (let i = 0; i < 5; i++) {
      const bd = 18 + (i % 3) * 4;
      const bz = cz - 52 + i * 24 + (side ? 8 : 0);
      const floors = 3 + ((i + side) % 2);
      const fh = 3.2, bw = 17;
      const key = rowKeys[(i + side) % rowKeys.length];
      const H = floors * fh;
      B.box('concrete_warm', bx, Y + 0.3, bz, bw + 1.2, 0.6, bd + 1.2, { c: 0.06, nb: true });
      for (let f = 0; f < floors; f++) {
        const fy = Y + 0.6 + f * fh;
        const front = sgn > 0 ? bx - bw / 2 : bx + bw / 2;
        // street facade
        B.wall(f === 0 ? 'concrete_warm' : key, front, fy, bz, bd, fh, 0.4, Math.PI / 2,
          f === 0
            ? [[bd * 0.2, 0, 3.4, 2.9], [bd * 0.65, 0, 2.2, 2.6]]
            : [[2.2, 0.95, 1.4, 1.9], [bd * 0.42, 0.95, 1.4, 1.9], [bd - 3.6, 0.95, 1.4, 1.9]]);
        // rear + sides
        B.wall(key, bx - sgn * bw / 2, fy, bz, bd, fh, 0.4, Math.PI / 2,
          f === 0 ? [] : [[bd * 0.3, 1.0, 1.2, 1.6], [bd * 0.7, 1.0, 1.2, 1.6]]);
        B.wall(key, bx, fy, bz - bd / 2, bw, fh, 0.4, 0, f === 0 ? [] : [[6, 1.0, 1.3, 1.7]]);
        B.wall(key, bx, fy, bz + bd / 2, bw, fh, 0.4, 0, f === 0 ? [] : [[9, 1.0, 1.3, 1.7]]);
        B.box('concrete_pale', bx, fy + fh, bz, bw + 0.2, 0.4, bd + 0.2, { c: 0.05, nb: true });

        if (f > 0) {
          // Glazing + shutters + balcony
          for (const u of [2.2, bd * 0.42, bd - 3.6]) {
            const pz = bz + u + 0.7 - bd / 2;
            B.box('glass_dirty', front, fy + 1.9, pz, 0.12, 1.8, 1.3, { nc: true, nb: true, c: 0.02 });
            for (const s2 of [-1, 1]) {
              B.box('paint_teal', front - sgn * 0.28, fy + 1.9, pz + s2 * 0.86, 0.09, 1.9, 0.62,
                { nc: true, nb: true, c: 0.02, ry: s2 * 0.32 });
            }
          }
          const balY = fy + 0.15;
          B.box('concrete_pale', bx - sgn * (bw / 2 + 0.85), balY, bz, 2.1, 0.26, bd * 0.62, { c: 0.04, nb: true });
          const bl = bd * 0.31;
          B.railing('paint_teal', [
            V(bx - sgn * (bw / 2 + 1.85), balY + 0.28, bz - bl), V(bx - sgn * (bw / 2 + 1.85), balY + 0.28, bz + bl)], 1.0);
          B.railing('paint_teal', [
            V(bx - sgn * (bw / 2 + 1.85), balY + 0.28, bz - bl), V(bx - sgn * (bw / 2 - 0.1), balY + 0.28, bz - bl)], 1.0);
          B.railing('paint_teal', [
            V(bx - sgn * (bw / 2 + 1.85), balY + 0.28, bz + bl), V(bx - sgn * (bw / 2 - 0.1), balY + 0.28, bz + bl)], 1.0);
          if (f === 1) awning(B, ['canvas_red', 'canvas_saffron', 'canvas_indigo'][i % 3], 'steel_dark',
            bx - sgn * (bw / 2 + 0.1), fy + 2.9, bz, bd * 0.7, 1.7, sgn > 0 ? Math.PI * 1.5 : Math.PI * 0.5);
          // laundry line
          cable(B, 'steel_dark', V(bx - sgn * (bw / 2 + 1.7), fy + 2.3, bz - bl + 0.4),
            V(bx - sgn * (bw / 2 + 1.7), fy + 2.3, bz + bl - 0.4), 0.3, 0.018);
          for (let k = 0; k < 4; k++) {
            B.box(['canvas_bone', 'canvas_indigo', 'canvas_red', 'canvas_saffron'][(k + i) % 4],
              bx - sgn * (bw / 2 + 1.7), fy + 1.85, bz - bl + 1.0 + k * ((bl * 2 - 2) / 3), 0.02, 0.8, 0.55,
              { nc: true, nb: true, c: 0.005 });
          }
        } else {
          awning(B, 'canvas_bone', 'steel_dark', bx - sgn * (bw / 2 + 0.1), fy + 3.0, bz, bd * 0.75, 1.9,
            sgn > 0 ? Math.PI * 1.5 : Math.PI * 0.5);
          ctx.lights.push({ x: bx - sgn * (bw / 2 + 1.4), y: Y + 3.0, z: bz, color: 0xffb268, intensity: 11, distance: 12 });
        }
      }
      parapet(B, key, bx, Y + 0.6 + H + 0.4, bz, bw + 0.2, bd + 0.2, 0.95, 0.24);
      // Rear external stair to the roof
      B.stairs('concrete_warm', bx + sgn * (bw / 2 + 1.3), Y + 0.6, bz - bd / 2 + 1.4, 1.4, 0.19, 0.28,
        Math.round(H / 0.19), 0, { rail: 'paint_teal' });
      roofKit(B, ctx, bx, Y + 1.0 + H, bz, bw - 2, bd - 2, rng, { metal: 'steel_dark', tank: 'paint_teal' });
      ctx.anchors.roofs.push({ x: bx, y: Y + 1.0 + H, z: bz, name: 'terrace-roof' });
      // Cables strung across the street between facing blocks
      if (side === 0 && i < 4) {
        cable(B, 'steel_dark', V(bx + bw / 2, Y + 7.5 + rng(), bz + 3),
          V(cx + 18 - 8.5, Y + 8.2 + rng(), bz + 9), 1.1, 0.026);
      }
    }
  }
  // Street bridge between the two rows: mantle-height ledge play
  B.box('concrete_pale', cx + 2, Y + 7.2, cz + 4, 26, 0.4, 3.4, { c: 0.05, nb: true });
  B.railing('paint_teal', [V(cx - 11, Y + 7.4, cz + 2.4), V(cx + 15, Y + 7.4, cz + 2.4)], 1.0);
  B.railing('paint_teal', [V(cx - 11, Y + 7.4, cz + 5.6), V(cx + 15, Y + 7.4, cz + 5.6)], 1.0);
  ctx.anchors.pads.push({ x: cx + 2, y: Y, z: cz + 40, dir: [0.1, 1, -0.2] });

  for (let i = 0; i < 24; i++) {
    ctx.props.push({
      type: ['crate', 'barrel', 'sack', 'bench', 'planter'][Math.floor(rng() * 5)],
      x: cx + 2 + (rng() < 0.5 ? -1 : 1) * (6 + rng() * 4), y: Y, z: cz - 56 + rng() * 116, ry: rng() * 3,
    });
  }
  return { name: 'Terrace Row', x: cx, z: cz, y: Y };
}

/* ============================================================== THE BORE = */

export function buildBore(B, ctx) {
  const P = PAD.bore;
  const rng = ctx.rng;
  const Y = P.y, cx = P.x, cz = P.z;

  /* terraced pit: three benches stepping down, cut in rock */
  const benches = [[46, 40, 0], [34, 29, -6], [22, 19, -12]];
  for (let i = 0; i < benches.length; i++) {
    const [rw, rd, dy] = benches[i];
    const yy = Y + dy;
    // Bench face (a ring of chunky rock blocks reads better than a smooth wall)
    for (let k = 0; k < 30; k++) {
      const a = (k / 30) * Math.PI * 2;
      const jitter = 0.85 + rng() * 0.3;
      const px = cx + Math.cos(a) * rw * jitter;
      const pz = cz + Math.sin(a) * rd * jitter;
      B.box('cliff', px, yy + 3.2, pz, 7 + rng() * 5, 7.5, 7 + rng() * 5,
        { ry: a + rng(), c: 0.35, nb: true });
    }
    B.box('gravel', cx, yy - 0.35, cz, rw * 1.6, 0.7, rd * 1.6, { c: 0.1, nb: true });
  }
  // Haul ramp spiralling into the pit
  for (let i = 0; i < 3; i++) {
    const a = i * 2.1;
    B.ramp('gravel', cx + Math.cos(a) * 40, Y - i * 6, cz + Math.sin(a) * 34, 9, 26, -6, a + 1.6, 0.8);
  }

  /* silos + conveyor gantry */
  for (let i = 0; i < 3; i++) {
    const px = cx - 40 + i * 11, pz = cz - 40;
    B.geo('concrete_pale', cylinderGeom(4.2, 4.2, 17, 20), new THREE.Matrix4().makeTranslation(px, Y + 12.5, pz));
    B.geo('paint_ochre', coneGeom(4.4, 4.2, 20), new THREE.Matrix4().makeRotationZ(Math.PI).setPosition(px, Y + 2.2, pz));
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      B.geo('steel_dark', tubeGeom([
        V(px + Math.cos(a) * 3.4, Y, pz + Math.sin(a) * 3.4),
        V(px + Math.cos(a) * 3.9, Y + 4.4, pz + Math.sin(a) * 3.9)], 0.17, 6));
    }
    B.geo('paint_ochre', coneGeom(4.5, 2.4, 20), new THREE.Matrix4().makeTranslation(px, Y + 22.2, pz));
    B.clip('concrete', px, Y + 12.5, pz, 8.4, 18, 8.4);
    B.geo('steel', tubeGeom([V(px, Y + 2.2, pz), V(px, Y + 0.4, pz + 3.2)], 0.28, 8));
  }
  B.box('concrete_pale', cx - 40, Y + 23.6, cz - 40, 26, 1.0, 3.0, { c: 0.06, nb: true });
  B.catwalk('grating', 'steel_dark', V(cx - 46, Y + 24.6, cz - 40), V(cx - 12, Y + 24.6, cz - 40), 1.4);
  B.stairs('grating', cx - 12, Y, cz - 44, 1.3, 0.2, 0.3, 40, 0, { rail: 'steel_dark' });
  B.catwalk('grating', 'steel_dark', V(cx - 12, Y + 8.0, cz - 32), V(cx - 12, Y + 8.0, cz - 39), 1.3);
  B.stairs('grating', cx - 12, Y + 8.0, cz - 32, 1.3, 0.2, 0.3, 40, Math.PI, { rail: 'steel_dark' });
  B.catwalk('grating', 'steel_dark', V(cx - 12, Y + 16.0, cz - 44), V(cx - 12, Y + 16.0, cz - 40), 1.3);
  B.stairs('grating', cx - 12, Y + 16.0, cz - 44, 1.3, 0.2, 0.3, 44, 0, { rail: 'steel_dark' });

  // Conveyor: long inclined gantry from the pit floor to the silo tops
  const ca = V(cx + 14, Y - 10, cz + 8);
  const cb = V(cx - 26, Y + 22, cz - 36);
  B.truss('steel_dark', ca, cb, 1.5);
  const dir = new THREE.Vector3().subVectors(cb, ca).normalize();
  const segs = 16;
  for (let i = 0; i <= segs; i++) {
    const p = ca.clone().lerp(cb, i / segs);
    B.box('rubber', p.x, p.y + 0.55, p.z, 1.5, 0.1, 3.0,
      { ry: Math.atan2(dir.x, dir.z), rx: -Math.asin(dir.y), nc: true, nb: true, c: 0.02 });
    if (i % 3 === 0 && p.y > Y - 6) {
      B.box('steel_dark', p.x, (p.y + Y) / 2 - 0.4, p.z, 0.35, Math.max(0.5, p.y - Y + 0.8), 0.35, { c: 0.03 });
    }
  }
  B.box('paint_ochre', cb.x, cb.y + 1.6, cb.z, 4.2, 3.0, 4.2, { c: 0.08 });
  B.box('paint_ochre', ca.x, ca.y + 1.4, ca.z, 5.0, 3.2, 5.0, { c: 0.08 });
  ctx.anchors.high.push({ x: cb.x, y: cb.y + 3.4, z: cb.z, name: 'bore-conveyor' });

  /* processing shed: enterable, mezzanine */
  const sx = cx + 34, sz = cz - 30, sw = 24, sd = 18, sh = 11;
  B.box('concrete', sx, Y + 0.3, sz, sw + 3, 0.6, sd + 3, { c: 0.06, nb: true });
  B.wall('paint_ochre', sx, Y + 0.6, sz - sd / 2, sw, sh, 0.4, 0, [[8, 0, 7, 6.5], [19, 5, 3, 2.6]]);
  B.wall('paint_ochre', sx, Y + 0.6, sz + sd / 2, sw, sh, 0.4, 0, [[3, 0, 5, 5], [16, 5, 4, 2.6]]);
  B.wall('paint_ochre', sx - sw / 2, Y + 0.6, sz, sd, sh, 0.4, Math.PI / 2, [[6, 0, 3, 4]]);
  B.wall('paint_ochre', sx + sw / 2, Y + 0.6, sz, sd, sh, 0.4, Math.PI / 2, [[4, 5, 4, 2.6], [12, 5, 4, 2.6]]);
  for (const u of [[19, 5, 3, 2.6]]) {
    B.box('glass_dirty', sx + u[0] + u[2] / 2 - sw / 2, Y + 0.6 + u[1] + u[3] / 2, sz - sd / 2, u[2] - 0.1, u[3] - 0.1, 0.1,
      { nc: true, nb: true, c: 0.02 });
  }
  B.box('paint_ochre', sx, Y + 0.6 + sh + 0.2, sz, sw + 1.6, 0.4, sd + 1.6, { c: 0.06, nb: true });
  for (let i = 0; i < 7; i++) {
    B.box('steel_dark', sx - sw / 2 + 1.5 + i * 3.5, Y + 0.6 + sh + 0.7, sz, 0.5, 0.7, sd + 1.6, { nc: true, nb: true, c: 0.04 });
  }
  B.box('grating', sx, Y + 5.4, sz + 4.5, sw - 4, 0.25, 7, { c: 0.04, nb: true });
  B.railing('steel_dark', [V(sx - sw / 2 + 2, Y + 5.55, sz + 1), V(sx + sw / 2 - 2, Y + 5.55, sz + 1)], 1.05);
  B.stairs('grating', sx - sw / 2 + 3, Y + 0.6, sz + sd / 2 - 2, 1.4, 0.2, 0.3, 24, Math.PI, { rail: 'steel_dark' });
  B.stairs('grating', sx + sw / 2 + 1.6, Y + 0.6, sz - 6, 1.3, 0.2, 0.3, 55, 0, { rail: 'steel_dark' });
  ctx.lights.push({ x: sx, y: Y + 4, z: sz, color: 0xffd9a0, intensity: 34, distance: 24 });
  ctx.anchors.roofs.push({ x: sx, y: Y + 0.6 + sh + 0.5, z: sz, name: 'bore-shed' });

  /* pit clutter */
  for (let i = 0; i < 34; i++) {
    const a = rng() * Math.PI * 2, r = rng();
    ctx.props.push({
      type: ['rock_big', 'rock_med', 'skip', 'tirestack', 'barrel'][Math.floor(rng() * 5)],
      x: cx + Math.cos(a) * 44 * r, y: Y - 12 * r, z: cz + Math.sin(a) * 38 * r, ry: rng() * 3,
    });
  }
  for (let i = 0; i < 16; i++) {
    ctx.props.push({ type: 'rock_med', x: cx - 60 + rng() * 40, y: Y, z: cz - 20 + rng() * 60, ry: rng() * 3 });
  }
  ctx.anchors.pads.push({ x: cx, y: Y - 12, z: cz, dir: [-0.35, 1, -0.35] });
  return { name: 'The Bore', x: cx, z: cz, y: Y };
}

/* =========================================================== RELAY SPIRE = */

export function buildRelay(B, ctx) {
  const P = PAD.relay;
  const rng = ctx.rng;
  const Y = P.y, cx = P.x, cz = P.z;

  /* mesa edge: a rock skirt so the pad does not read as a floating disc */
  for (let k = 0; k < 26; k++) {
    const a = (k / 26) * Math.PI * 2;
    const r = 30 + rng() * 8;
    B.box('cliff', cx + Math.cos(a) * r, Y - 3.5 + rng() * 2, cz + Math.sin(a) * r * 0.9,
      9 + rng() * 6, 10, 9 + rng() * 6, { ry: a + rng(), c: 0.4, nb: true });
  }
  B.box('concrete_dark', cx, Y - 0.25, cz, 54, 0.6, 48, { c: 0.08, nb: true });
  B.box('concrete', cx, Y + 0.06, cz, 44, 0.08, 38, { nc: true, nb: true, c: 0.03 });
  // Helipad markings
  B.geo('paint_white', torusGeom(5.4, 0.22, 4, 28), new THREE.Matrix4()
    .makeRotationX(Math.PI / 2).setPosition(cx + 13, Y + 0.12, cz + 12));
  B.box('paint_white', cx + 13, Y + 0.12, cz + 12, 1.0, 0.05, 6.0, { nc: true, nb: true, c: 0.02 });
  B.box('paint_white', cx + 13, Y + 0.12, cz + 12, 4.4, 0.05, 1.0, { nc: true, nb: true, c: 0.02 });

  /* bunker: two rooms, roof deck */
  const bw = 20, bd = 14, bh = 4.6;
  B.wall('concrete', cx, Y + 0.1, cz - bd / 2, bw, bh, 0.55, 0, [[3, 0, 2.0, 2.7], [12, 1.4, 4.5, 1.5]]);
  B.wall('concrete', cx, Y + 0.1, cz + bd / 2, bw, bh, 0.55, 0, [[9, 1.4, 4.0, 1.5]]);
  B.wall('concrete', cx - bw / 2, Y + 0.1, cz, bd, bh, 0.55, Math.PI / 2, [[5, 0, 2.2, 2.7]]);
  B.wall('concrete', cx + bw / 2, Y + 0.1, cz, bd, bh, 0.55, Math.PI / 2, [[4, 1.4, 3.0, 1.5]]);
  B.wall('concrete', cx + 2, Y + 0.1, cz, bd, bh, 0.4, Math.PI / 2, [[6, 0, 1.9, 2.6]]);   // internal partition
  B.box('concrete', cx, Y + 0.1 + bh + 0.25, cz, bw + 1.6, 0.5, bd + 1.6, { c: 0.07, nb: true });
  parapet(B, 'concrete', cx, Y + 0.1 + bh + 0.5, cz, bw + 1.6, bd + 1.6, 0.95, 0.3);
  for (const u of [[12, 1.4, 4.5, 1.5]]) {
    B.box('glass_dirty', cx + u[0] + u[2] / 2 - bw / 2, Y + 0.1 + u[1] + u[3] / 2, cz - bd / 2, u[2] - 0.1, u[3] - 0.1, 0.12,
      { nc: true, nb: true, c: 0.02 });
  }
  B.stairs('concrete', cx - bw / 2 - 1.6, Y + 0.1, cz - 4, 1.5, 0.2, 0.3, 27, 0, { rail: 'paint_red' });
  ctx.lights.push({ x: cx - 5, y: Y + 2.6, z: cz, color: 0x9fd8ff, intensity: 18, distance: 16 });
  ctx.lights.push({ x: cx + 6, y: Y + 2.6, z: cz, color: 0xffd9a0, intensity: 16, distance: 14 });

  /* the mast: focal landmark, visible from the whole valley */
  const mx = cx - 2, mz = cz - 2, mH = 62;
  const legR = (t) => 3.4 + (0.9 - 3.4) * t;
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    B.geo('steel_dark', tubeGeom([
      V(mx + Math.cos(a) * legR(0), Y + 5.4, mz + Math.sin(a) * legR(0)),
      V(mx + Math.cos(a) * legR(1), Y + 5.4 + mH, mz + Math.sin(a) * legR(1))], 0.15, 7));
    B.box('concrete', mx + Math.cos(a) * legR(0), Y + 2.8, mz + Math.sin(a) * legR(0), 1.5, 5.6, 1.5, { c: 0.07 });
  }
  const rungs = 26;
  for (let i = 0; i < rungs; i++) {
    const t0 = i / rungs, t1 = (i + 1) / rungs;
    const band = Math.floor(i / (rungs / 7)) % 2 ? 'paint_red' : 'paint_white';
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      const b = ((k + 1) / 4) * Math.PI * 2 + Math.PI / 4;
      const r0 = legR(t0), r1 = legR(t1);
      B.geo(band, tubeGeom([
        V(mx + Math.cos(a) * r0, Y + 5.4 + mH * t0, mz + Math.sin(a) * r0),
        V(mx + Math.cos(b) * r0, Y + 5.4 + mH * t0, mz + Math.sin(b) * r0)], 0.06, 5));
      B.geo(band, tubeGeom([
        V(mx + Math.cos(a) * r0, Y + 5.4 + mH * t0, mz + Math.sin(a) * r0),
        V(mx + Math.cos(b) * r1, Y + 5.4 + mH * t1, mz + Math.sin(b) * r1)], 0.05, 5));
    }
  }
  B.clip('metal', mx, Y + 5.4 + mH / 2, mz, 5, mH, 5);
  // Mast platform at 24 m: zipline anchor
  const platY = Y + 5.4 + mH * 0.32;
  B.box('grating', mx, platY, mz, 7.5, 0.25, 7.5, { c: 0.05, nb: true });
  B.railing('paint_red', [
    V(mx - 3.6, platY + 0.15, mz - 3.6), V(mx + 3.6, platY + 0.15, mz - 3.6),
    V(mx + 3.6, platY + 0.15, mz + 3.6), V(mx - 3.6, platY + 0.15, mz + 3.6),
    V(mx - 3.6, platY + 0.15, mz - 3.6)], 1.05);
  B.ladder('steel_dark', mx + 2.4, Y + 5.6, mz + 3.0, platY - Y - 5.6, 0);
  B.stairs('grating', cx + 5, Y + 5.3, cz + 5, 1.4, 0.2, 0.3, 34, -2.3, { rail: 'paint_red' });
  // Dishes and antennae
  for (let i = 0; i < 4; i++) {
    const a = 0.6 + i * 1.3;
    const yy = platY + 2 + i * 6;
    const r = 2.2 - i * 0.28;
    const px = mx + Math.cos(a) * (legR((yy - Y - 5.4) / mH) + r * 0.7);
    const pz = mz + Math.sin(a) * (legR((yy - Y - 5.4) / mH) + r * 0.7);
    const m = new THREE.Matrix4().makeRotationY(a).multiply(new THREE.Matrix4().makeRotationX(-0.5));
    m.setPosition(px, yy, pz);
    B.geo('paint_white', new THREE.SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.36), m);
    B.geo('steel_dark', tubeGeom([V(px, yy, pz), V(px - Math.cos(a) * r, yy - 0.2, pz - Math.sin(a) * r)], 0.07, 6));
  }
  B.geo('steel_bright', tubeGeom([V(mx, Y + 5.4 + mH, mz), V(mx, Y + 5.4 + mH + 9, mz)], 0.12, 8));
  B.box('lamp_red', mx, Y + 5.4 + mH + 9.4, mz, 0.6, 0.6, 0.6, { nc: true, nb: true, c: 0.15 });
  ctx.lights.push({ x: mx, y: Y + 5.4 + mH + 9.4, z: mz, color: 0xff2a18, intensity: 60, distance: 60 });
  // Guy wires with real sag
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    const anchorX = mx + Math.cos(a) * 22, anchorZ = mz + Math.sin(a) * 22;
    B.box('concrete', anchorX, Y + 0.5, anchorZ, 1.6, 1.2, 1.6, { c: 0.06 });
    cable(B, 'steel_dark', V(mx + Math.cos(a) * legR(0.75), Y + 5.4 + mH * 0.75, mz + Math.sin(a) * legR(0.75)),
      V(anchorX, Y + 1.0, anchorZ), 1.6, 0.045);
    cable(B, 'steel_dark', V(mx + Math.cos(a) * legR(0.42), Y + 5.4 + mH * 0.42, mz + Math.sin(a) * legR(0.42)),
      V(anchorX, Y + 1.0, anchorZ), 1.1, 0.04);
  }
  // Cable trays running off the mesa toward the aqueduct
  B.pipe('steel_dark', [V(cx - 12, Y + 5.4, cz + 4), V(cx - 24, Y + 3.0, cz + 2), V(cx - 32, Y - 2, cz - 2)], 0.2);

  for (let i = 0; i < 12; i++) {
    ctx.props.push({ type: ['crate', 'barrel', 'spool'][Math.floor(rng() * 3)], x: cx + (rng() - 0.5) * 34, y: Y, z: cz + (rng() - 0.5) * 30, ry: rng() * 3 });
  }
  ctx.anchors.high.push({ x: mx, y: platY + 0.4, z: mz, name: 'relay-mast' });
  ctx.anchors.roofs.push({ x: cx, y: Y + 5.4, z: cz, name: 'relay-bunker' });
  ctx.anchors.pads.push({ x: cx + 16, y: Y, z: cz - 12, dir: [-0.5, 1, 0] });
  return { name: 'Relay Spire', x: cx, z: cz, y: Y };
}

/* ============================================================ THE AQUEDUCT */

export function buildAqueduct(B, ctx, field) {
  const rng = ctx.rng;
  const a = new THREE.Vector2(172, 4);
  const b = new THREE.Vector2(26, -30);
  const n = 9;
  const deckY = [];
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = a.x + (b.x - a.x) * t;
    const z = a.y + (b.y - a.y) * t;
    const g = field.height(x, z);
    const y = 44 * (1 - t) + 15 * t;
    pts.push(new THREE.Vector2(x, z));
    deckY.push({ x, z, g, y: Math.max(y, g + 8) });
  }

  for (let i = 0; i < n; i++) {
    const p0 = deckY[i], p1 = deckY[i + 1];
    const dir = Math.atan2(p1.x - p0.x, p1.z - p0.z);
    const len = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    const mx = (p0.x + p1.x) / 2, mz = (p0.z + p1.z) / 2, my = (p0.y + p1.y) / 2;
    // Deck: a walkable channel with low parapets
    B.box('concrete', mx, my, mz, 5.4, 1.0, len + 0.4, { ry: dir, c: 0.08, nb: true });
    B.box('concrete_dark', mx, my + 0.75, mz - 0, 1.2, 0.5, len, { ry: dir, c: 0.05, nb: true });
    for (const s of [-1, 1]) {
      B.box('concrete', mx + Math.cos(dir) * s * 2.5, my + 1.0, mz - Math.sin(dir) * s * 2.5,
        0.45, 1.0, len + 0.4, { ry: dir, c: 0.05 });
    }
    // Arch under each span
    const archN = 5;
    for (let k = 1; k < archN; k++) {
      const t = k / archN;
      const px = p0.x + (p1.x - p0.x) * t, pz = p0.z + (p1.z - p0.z) * t;
      const py = p0.y + (p1.y - p0.y) * t;
      const drop = Math.sin(t * Math.PI) * 3.2;
      B.box('concrete', px, py - 0.5 - drop / 2, pz, 3.4, drop + 0.6, len / archN + 0.3, { ry: dir, c: 0.06, nc: true, nb: true });
    }
    // Pier
    const g = p1.g;
    const pierH = p1.y - g - 0.5;
    if (pierH > 1) {
      B.box('concrete', p1.x, g + pierH / 2, p1.z, 4.6, pierH, 4.0, { ry: dir, c: 0.1 });
      B.box('concrete_dark', p1.x, g + 0.6, p1.z, 6.4, 1.2, 5.8, { ry: dir, c: 0.08 });
      for (let k = 1; k < 4; k++) {
        B.box('concrete_dark', p1.x, g + (pierH * k) / 4, p1.z, 4.9, 0.35, 4.3, { ry: dir, nc: true, nb: true, c: 0.05 });
      }
    }
  }
  // Stair towers at both ends so the deck is actually reachable
  for (const e of [deckY[0], deckY[n]]) {
    const h = e.y - e.g;
    const flights = Math.max(1, Math.round(h / 4.2));
    let sy = e.g;
    for (let f = 0; f < flights; f++) {
      const d2 = (f % 2) * Math.PI;
      B.stairs('concrete_dark', e.x + 5.5, sy, e.z - 4 + (f % 2) * 8, 1.5, 0.2, 0.3, 21, d2, { rail: 'steel_dark' });
      sy += 21 * 0.2;
      B.box('concrete_dark', e.x + 5.5, sy + 0.1, e.z + (f % 2 ? -4.6 : 4.6), 2.2, 0.35, 2.2, { c: 0.05, nb: true });
    }
    B.catwalk('grating', 'steel_dark', V(e.x + 5.5, sy + 0.3, e.z), V(e.x + 0.5, sy + 0.3, e.z), 1.5);
  }
  // A big pipe riding the deck, and lamps
  const spine = deckY.map((p) => V(p.x, p.y + 1.4, p.z));
  B.pipe('paint_copper', spine, 0.5);
  for (let i = 0; i < deckY.length; i += 2) {
    const p = deckY[i];
    B.box('steel_dark', p.x, p.y + 2.2, p.z + 2.3, 0.12, 3.2, 0.12, { nc: true, nb: true, c: 0.03 });
    B.box('lamp_warm', p.x, p.y + 3.7, p.z + 2.3, 0.34, 0.14, 0.26, { nc: true, nb: true, c: 0.05 });
  }
  ctx.anchors.high.push({ x: deckY[3].x, y: deckY[3].y + 2.0, z: deckY[3].z, name: 'aqueduct' });
  ctx.anchors.high.push({ x: deckY[7].x, y: deckY[7].y + 2.0, z: deckY[7].z, name: 'aqueduct-west' });
  ctx.anchors.roofs.push({ x: deckY[5].x, y: deckY[5].y + 1.2, z: deckY[5].z, name: 'aqueduct-mid' });
  void rng;
  return { name: 'The Aqueduct', x: (a.x + b.x) / 2, z: (a.y + b.y) / 2, y: deckY[5].y };
}

/* ------------------------------------------------ roads, bridge, outposts */

export function buildInfrastructure(B, ctx, field) {
  const rng = ctx.rng;

  /* --- wadi crossing on West Lane --- */
  const bz = 38, bx = -63;
  const g0 = field.height(bx - 26, bz), g1 = field.height(bx + 26, bz);
  const deck = Math.max(g0, g1) + 0.6;
  B.box('concrete_dark', bx, deck, bz, 54, 1.0, 11, { c: 0.08, nb: true });
  for (const s of [-1, 1]) {
    B.railing('steel_dark', [V(bx - 26, deck + 0.5, bz + s * 5.2), V(bx + 26, deck + 0.5, bz + s * 5.2)], 1.05);
  }
  for (let i = -1; i <= 1; i++) {
    const px = bx + i * 15;
    const g = field.height(px, bz);
    const h = deck - g - 0.5;
    if (h > 0.6) B.box('concrete_dark', px, g + h / 2, bz, 3.0, h, 8.0, { c: 0.07 });
  }

  /* --- water in the wadi --- */
  const wpts = [];
  for (let z = -170; z <= 200; z += 18) {
    wpts.push(V(-78 + 34 * Math.sin(z * 0.0112) + 9 * Math.sin(z * 0.031 + 1.7), -2.35, z));
  }
  B.geo('water', tubeGeom(wpts, 7.5, 5), null, 1, 1);

  /* --- a scatter of outbuildings across the middle ground --- */
  const spots = [
    [-24, 90, 0.4], [44, 84, -0.6], [-150, -40, 0.9], [120, 60, 0.3],
    [-6, -90, 0.1], [58, -46, -0.4], [-120, -96, 0.7], [150, -160, 0.2],
    [-176, 118, -0.3], [96, 196, 0.5], [-70, 168, 0.15], [186, -110, -0.8],
  ];
  for (let i = 0; i < spots.length; i++) {
    const [px, pz, ry] = spots[i];
    const g = field.height(px, pz);
    const w = 7 + rng() * 9, d = 6 + rng() * 8, h = 3.4 + rng() * 4.2;
    const key = ['concrete_warm', 'paint_hangar', 'paint_cream', 'concrete_pale'][i % 4];
    B.box('concrete_dark', px, g + 0.2, pz, w + 1.6, 0.5, d + 1.6, { ry, c: 0.06, nb: true });
    B.wall(key, px + Math.cos(ry) * w / 2, g + 0.4, pz - Math.sin(ry) * w / 2, d, h, 0.35, ry + Math.PI / 2, [[d * 0.4, 0, 1.7, 2.3]]);
    B.wall(key, px - Math.cos(ry) * w / 2, g + 0.4, pz + Math.sin(ry) * w / 2, d, h, 0.35, ry + Math.PI / 2, [[d * 0.3, 1.2, 1.2, 1.4]]);
    B.wall(key, px + Math.sin(ry) * d / 2, g + 0.4, pz + Math.cos(ry) * d / 2, w, h, 0.35, ry, [[w * 0.5, 1.2, 1.4, 1.4]]);
    B.wall(key, px - Math.sin(ry) * d / 2, g + 0.4, pz - Math.cos(ry) * d / 2, w, h, 0.35, ry, []);
    B.box(i % 2 ? 'paint_hangar' : 'concrete_pale', px, g + 0.4 + h + 0.2, pz, w + 1.2, 0.4, d + 1.2, { ry, c: 0.06, nb: true });
    if (i % 3 === 0) parapet(B, key, px, g + 0.6 + h, pz, w + 1.2, d + 1.2, 0.7, 0.22);
    else {
      // Mono-pitch roof for silhouette variety
      B.box(i % 2 ? 'paint_hangar' : 'paint_ochre', px, g + 0.4 + h + 0.9, pz, w + 1.4, 0.25, d + 1.4,
        { ry, rx: 0.16, c: 0.05, nb: true });
    }
    roofKit(B, ctx, px, g + 0.6 + h, pz, w - 1, d - 1, rng, { metal: 'steel_dark', tank: 'paint_teal' });
    for (let k = 0; k < 4; k++) {
      ctx.props.push({
        type: ['barrel', 'crate', 'rock_med', 'pipe_pile'][Math.floor(rng() * 4)],
        x: px + (rng() - 0.5) * 16, y: g, z: pz + (rng() - 0.5) * 16, ry: rng() * 3,
      });
    }
  }

  /* --- ridge-line radio pylons: middle-ground silhouette --- */
  const pylons = [[-232, -150], [-300, 60], [250, -230], [300, 140], [-150, 260], [60, -300]];
  for (const [px, pz] of pylons) {
    const g = field.height(px, pz);
    const h = 22 + rng() * 12;
    for (let k = 0; k < 4; k++) {
      const ang = (k / 4) * Math.PI * 2 + Math.PI / 4;
      B.geo('steel_dark', tubeGeom([
        V(px + Math.cos(ang) * 2.4, g, pz + Math.sin(ang) * 2.4),
        V(px + Math.cos(ang) * 0.6, g + h, pz + Math.sin(ang) * 0.6)], 0.12, 6));
    }
    for (let i = 0; i < 8; i++) {
      const t0 = i / 8;
      const r0 = 2.4 + (0.6 - 2.4) * t0;
      for (let k = 0; k < 4; k++) {
        const a1 = (k / 4) * Math.PI * 2 + Math.PI / 4;
        const a2 = ((k + 1) / 4) * Math.PI * 2 + Math.PI / 4;
        B.geo('steel_dark', tubeGeom([
          V(px + Math.cos(a1) * r0, g + h * t0, pz + Math.sin(a1) * r0),
          V(px + Math.cos(a2) * r0, g + h * t0, pz + Math.sin(a2) * r0)], 0.045, 4));
      }
    }
    B.box('paint_red', px, g + h + 0.6, pz, 1.2, 1.2, 1.2, { nc: true, nb: true, c: 0.1 });
  }
}

export default {
  buildPlaza, buildHangar, buildFoundry, buildTerrace, buildBore, buildRelay,
  buildAqueduct, buildInfrastructure,
};
