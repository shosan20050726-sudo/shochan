import * as THREE from 'three';
import { Assembly, palette, boxGeo, cylGeo, torusGeo } from './Parts.js';
import { buildOptic } from './Optics.js';

/**
 * Procedural weapon frames.
 *
 * Model space convention, shared by every frame:
 *   origin = the shooting hand (top of the pistol grip, rear of the mag well)
 *   -Z     = down the bore
 *   +Y     = up
 *   +X     = the shooter's right (the ejection side)
 *
 * Keeping the origin at the hand means the sway/recoil rotations pivot where
 * a real wrist would, which is most of why the animation reads as "held".
 *
 * Every builder returns the model-space points the rest of the system needs:
 * the sight (for ADS alignment), the muzzle (flash/tracer origin) and the
 * ejection port (brass).
 */

/* ------------------------------------------------------------ sub-parts -- */

/** Angled pistol grip with finger grooves and a palm swell. */
function pistolGrip(A, x, y, z, tilt = 0.30, len = 0.105, mat = 'grip', w = 0.030) {
  const cz = z + Math.sin(tilt) * len * 0.5;
  const cy = y - Math.cos(tilt) * len * 0.5;
  A.box('body', mat, [w, len, 0.040], [x, cy, cz], [tilt, 0, 0], 0.0075, 2);
  A.box('body', 'body', [w + 0.004, 0.016, 0.046], [x, y - 0.006, z + 0.002], [tilt, 0, 0], 0.003);
  // grooves cut across the front strap
  for (let i = 0; i < 3; i++) {
    const t = 0.30 + i * 0.22;
    const gz = z + Math.sin(tilt) * len * t - Math.cos(tilt) * 0.019;
    const gy = y - Math.cos(tilt) * len * t - Math.sin(tilt) * 0.019;
    A.add('body', mat, new THREE.CylinderGeometry(0.0045, 0.0045, w * 0.95, 8, 1).rotateZ(Math.PI / 2),
      [x, gy, gz], [tilt, 0, 0]);
  }
  // butt cap
  A.box('body', 'body', [w + 0.002, 0.008, 0.038],
    [x + 0, y - Math.cos(tilt) * len, z + Math.sin(tilt) * len], [tilt, 0, 0], 0.0025);
}

/** Trigger guard loop plus the trigger itself (an animated node). */
function triggerGroup(A, x, y, z, r = 0.019) {
  A.torus('body', 'body', r, 0.0042, [x, y - r - 0.004, z], [0, Math.PI / 2, 0], 6, 20, Math.PI * 1.15);
  A.box('body', 'body', [0.010, 0.008, 0.030], [x, y - 0.004, z + 0.012], null, 0.002);
  A.node('trigger', x, y - 0.010, z);
  A.box('trigger', 'accent', [0.006, 0.024, 0.007], [x, y - 0.020, z - 0.002], [0.22, 0, 0], 0.0018);
}

/** Curved detachable box magazine, built as a stack of tilted slabs. */
function curvedMag(A, node, x, y, z, w, d, len, curve = 0.55, mat = 'poly', segs = 5) {
  const step = len / segs;
  let cz = z, cy = y, ang = 0;
  for (let i = 0; i < segs; i++) {
    ang += curve * 0.055;
    cy -= Math.cos(ang) * step;
    cz += Math.sin(ang) * step;
    A.box(node, mat, [w, step * 1.06, d], [x, cy + step * 0.5, cz - step * 0.0], [ang, 0, 0], 0.0035, 1);
    if (i === 0) A.box(node, 'body', [w + 0.003, 0.010, d + 0.003], [x, y - 0.004, z], null, 0.002);
  }
  // floor plate + witness holes
  A.box(node, 'body', [w + 0.004, 0.010, d + 0.004], [x, cy + 0.002, cz], [ang, 0, 0], 0.0022);
  for (let i = 1; i < segs; i++) {
    const t = i / segs;
    A.box(node, 'accent', [w * 0.16, 0.006, 0.006],
      [x + w * 0.5, y - len * t * 0.98, z + len * t * 0.10], [ang * t, 0, 0], 0.0012);
  }
}

/** Straight stick magazine (SMG). */
function stickMag(A, node, x, y, z, w, d, len, mat = 'poly', tilt = 0.06) {
  A.box(node, mat, [w, len, d], [x, y - len * 0.5, z + Math.sin(tilt) * len * 0.5], [tilt, 0, 0], 0.0035, 1);
  A.box(node, 'body', [w + 0.004, 0.012, d + 0.004], [x, y - 0.005, z], null, 0.0022);
  A.box(node, 'body', [w + 0.005, 0.009, d + 0.005],
    [x, y - len, z + Math.sin(tilt) * len], [tilt, 0, 0], 0.0022);
  for (let i = 1; i < 4; i++) {
    A.box(node, 'accent', [w * 0.9, 0.004, 0.005], [x, y - len * (i / 4), z + Math.sin(tilt) * len * (i / 4)], [tilt, 0, 0], 0.001);
  }
}

/** Slotted muzzle brake. Slots are modelled as recessed dark bands. */
function muzzleBrake(A, x, y, z, r = 0.0135, len = 0.048) {
  A.cyl('body', 'steelDark', r, r, len, [x, y, z], null, 16);
  A.cyl('body', 'body', r + 0.0016, r + 0.0016, 0.008, [x, y, z + len * 0.5 - 0.004], null, 16);
  for (let i = 0; i < 3; i++) {
    const zz = z - len * 0.5 + 0.010 + i * 0.012;
    A.box('body', 'steelBlue', [r * 2.1, 0.0045, 0.005], [x, y + r * 0.55, zz], null, 0.0008);
    A.box('body', 'steelBlue', [r * 2.1, 0.0045, 0.005], [x, y - r * 0.55, zz], null, 0.0008);
  }
  // crown
  A.cyl('body', 'steelBlue', r * 0.62, r * 0.62, 0.006, [x, y, z - len * 0.5 - 0.001], null, 16);
}

/** Charging handle: an animated node so it can be yanked during a reload. */
function chargingHandle(A, x, y, z, side = 1, w = 0.052) {
  A.node('charge', x, y, z);
  A.box('charge', 'accent', [w, 0.010, 0.030], [x, y, z], null, 0.0022);
  A.box('charge', 'accent', [0.014, 0.020, 0.014], [x + side * (w * 0.5 - 0.004), y + 0.004, z - 0.004], [0, 0, side * 0.25], 0.003);
  A.box('charge', 'steelDark', [w * 0.5, 0.008, 0.014], [x, y - 0.002, z + 0.018], null, 0.0018);
}

/** Collapsible carbine stock: buffer tube, sliding cheek piece, rubber pad. */
function carbineStock(A, x, y, z, len = 0.145) {
  A.cyl('body', 'steelDark', 0.0155, 0.0155, len, [x, y, z + len * 0.5], null, 14);
  for (let i = 0; i < 4; i++) {
    A.cyl('body', 'body', 0.0172, 0.0172, 0.005, [x, y, z + 0.030 + i * 0.026], null, 14);
  }
  const bz = z + len * 0.78;
  A.box('body', 'poly', [0.040, 0.062, 0.090], [x, y - 0.004, bz], null, 0.006, 2);
  A.box('body', 'poly', [0.030, 0.022, 0.070], [x, y + 0.030, bz - 0.004], [-0.06, 0, 0], 0.005, 2);   // cheek weld
  A.box('body', 'grip', [0.042, 0.070, 0.014], [x, y - 0.008, bz + 0.050], [-0.10, 0, 0], 0.005, 2);   // recoil pad
  A.box('body', 'body', [0.012, 0.020, 0.024], [x, y - 0.036, bz - 0.010], null, 0.003);               // sling loop
  A.torus('body', 'accent', 0.008, 0.0022, [x + 0.020, y - 0.020, bz - 0.020], [0, Math.PI / 2, 0], 6, 12);
}

/** Skeletonised stock: a cut-away frame, much lighter silhouette. */
function skeletonStock(A, x, y, z, len = 0.155) {
  A.box('body', 'body', [0.026, 0.048, 0.055], [x, y - 0.002, z + 0.026], null, 0.004, 2);
  A.box('body', 'body', [0.020, 0.014, len], [x, y + 0.022, z + len * 0.5], [-0.03, 0, 0], 0.003, 2);   // top rail
  A.box('body', 'body', [0.020, 0.013, len * 0.82], [x, y - 0.028, z + len * 0.42], [0.09, 0, 0], 0.003, 2); // bottom strut
  A.box('body', 'body', [0.020, 0.018, 0.016], [x, y - 0.006, z + len * 0.52], [0.5, 0, 0], 0.003);    // diagonal web
  const bz = z + len;
  A.box('body', 'poly', [0.028, 0.078, 0.020], [x, y - 0.004, bz], [-0.08, 0, 0], 0.005, 2);
  A.box('body', 'grip', [0.030, 0.080, 0.012], [x, y - 0.004, bz + 0.014], [-0.08, 0, 0], 0.005, 2);
  A.box('body', 'poly', [0.024, 0.020, 0.058], [x, y + 0.040, z + len * 0.62], [-0.05, 0, 0], 0.005, 2); // cheek riser
}

/** Heavy fixed stock (LMG). */
function fixedStock(A, x, y, z, len = 0.185) {
  A.box('body', 'poly', [0.040, 0.070, len], [x, y - 0.006, z + len * 0.5], [-0.02, 0, 0], 0.008, 2);
  A.box('body', 'poly', [0.032, 0.026, len * 0.62], [x, y + 0.040, z + len * 0.46], [-0.05, 0, 0], 0.006, 2);
  A.box('body', 'grip', [0.044, 0.082, 0.016], [x, y - 0.010, z + len + 0.004], [-0.09, 0, 0], 0.006, 2);
  // lightening cut
  A.box('body', 'body', [0.044, 0.030, 0.045], [x, y - 0.012, z + len * 0.55], null, 0.004);
}

/** Wooden shotgun stock with a comb and a steel butt plate. */
function woodStock(A, x, y, z, len = 0.20) {
  A.box('body', 'wood', [0.038, 0.056, len * 0.55], [x, y + 0.004, z + len * 0.26], [-0.05, 0, 0], 0.010, 2);
  A.box('body', 'wood', [0.042, 0.072, len * 0.55], [x, y - 0.010, z + len * 0.74], [-0.10, 0, 0], 0.012, 2);
  A.box('body', 'wood', [0.036, 0.030, len * 0.42], [x, y + 0.034, z + len * 0.42], [-0.07, 0, 0], 0.008, 2);
  A.box('body', 'steelDark', [0.044, 0.088, 0.012], [x, y - 0.020, z + len + 0.006], [-0.12, 0, 0], 0.004, 2);
  A.torus('body', 'accent', 0.007, 0.0022, [x, y - 0.048, z + len * 0.70], [0, Math.PI / 2, 0], 6, 12);
}

/** Side-folding skeletal stock (SMG) — folded flat against the receiver. */
function foldingStock(A, x, y, z, len = 0.125) {
  A.box('body', 'body', [0.020, 0.030, 0.030], [x, y, z + 0.013], null, 0.004, 2);   // hinge block
  A.cylY('body', 'steel', 0.006, 0.006, 0.034, [x + 0.004, y, z + 0.020], null, 10);
  const side = x + 0.030;
  A.box('body', 'body', [0.010, 0.013, len], [side, y + 0.012, z + len * 0.5], [0, 0.06, 0], 0.0025, 2);
  A.box('body', 'body', [0.010, 0.013, len], [side, y - 0.018, z + len * 0.5], [0, 0.06, 0], 0.0025, 2);
  A.box('body', 'poly', [0.012, 0.052, 0.016], [side + 0.008, y - 0.003, z + len], [0, 0.06, 0], 0.004, 2);
}

/* ------------------------------------------------------------- AR frame -- */

function buildAR(A, def) {
  const m = def.model;
  const bore = 0.046;
  const recLen = m.receiver;
  const z0 = 0.058, z1 = z0 - recLen, cz = (z0 + z1) * 0.5;
  const heavy = !!m.heavy;
  const w = heavy ? 0.056 : 0.050;

  // ---- lower receiver / mag well
  A.box('body', 'body', [w, 0.046, recLen], [0, 0.023, cz], null, 0.004, 2);
  A.box('body', 'body', [w + 0.004, 0.030, 0.070], [0, 0.014, -0.058], null, 0.004, 2);   // mag well flare
  A.box('body', 'bodyDark', [w + 0.006, 0.010, 0.062], [0, -0.002, -0.058], null, 0.003);
  // magazine release + bolt catch
  A.cylY('body', 'accent', 0.0055, 0.0055, 0.010, [w * 0.5, 0.020, -0.030], [0, 0, Math.PI / 2], 8);
  A.box('body', 'accent', [0.008, 0.016, 0.020], [-w * 0.5 - 0.002, 0.018, -0.020], null, 0.002);
  // fire selector
  A.cylY('body', 'accent', 0.0075, 0.0075, 0.011, [-w * 0.5, 0.030, 0.020], [0, 0, Math.PI / 2], 10);
  A.box('body', 'accent', [0.006, 0.008, 0.026], [-w * 0.5 - 0.004, 0.030, 0.014], [0, 0, 0], 0.0015);

  // ---- upper receiver
  A.box('body', 'body', [w - 0.006, 0.038, recLen * 0.97], [0, 0.062, cz - 0.002], null, 0.004, 2);
  A.box('body', 'bodyDark', [w - 0.002, 0.012, recLen * 0.55], [0, 0.048, cz - 0.030], null, 0.003);
  // ejection port, brass deflector, forward assist
  A.box('body', 'steelBlue', [0.005, 0.026, 0.062], [w * 0.5 - 0.004, 0.060, -0.020], null, 0.0018);
  A.box('body', 'body', [0.010, 0.020, 0.030], [w * 0.5 - 0.001, 0.074, 0.004], [0, 0, -0.5], 0.003);
  A.cyl('body', 'accent', 0.0068, 0.0068, 0.016, [w * 0.5 - 0.004, 0.070, 0.030], null, 10);
  A.node('bolt', w * 0.5 - 0.006, 0.060, -0.020);
  A.box('bolt', 'steel', [0.006, 0.022, 0.040], [w * 0.5 - 0.008, 0.060, -0.020], null, 0.0015);
  A.cyl('bolt', 'steelDark', 0.008, 0.008, 0.010, [w * 0.5 - 0.008, 0.060, -0.040], null, 12);

  // ---- top rail + iron sights
  A.rail('body', 'accent', recLen * 0.82, [0, 0.083, cz - 0.014], 0.022);
  A.box('body', 'accent', [0.018, 0.020, 0.006], [0, 0.096, z0 - 0.018], [0, 0, 0], 0.0015);   // folded rear sight
  A.box('body', 'accent', [0.014, 0.018, 0.005], [0, 0.095, z1 - 0.148], null, 0.0015);        // folded front sight

  // ---- handguard
  const hgLen = m.barrel * 0.86 + 0.02;
  const hgZ = z1 - hgLen * 0.5 - 0.004;
  A.cyl('body', 'bodyDark', 0.0215, 0.0215, hgLen, [0, bore, hgZ], null, 14, true);
  A.shroud('body', 'body', 0.0248, hgLen * 0.94, [0, bore, hgZ], 8, 0.0060, 0.0165, 0.39);
  A.cyl('body', 'body', 0.0292, 0.0292, 0.014, [0, bore, z1 - 0.010], null, 16);
  A.cyl('body', 'body', 0.0282, 0.0282, 0.012, [0, bore, hgZ - hgLen * 0.5 + 0.008], null, 16);
  A.screws('body', 'accent', 0.0255, 4, [0, bore, z1 - 0.010], 0.0022);
  // bottom rail on the handguard + hand stop
  A.rail('body', 'accent', hgLen * 0.6, [0, bore - 0.0272, hgZ + 0.008], 0.017);
  A.box('body', 'grip', [0.020, 0.020, 0.030], [0, bore - 0.040, hgZ - hgLen * 0.20], [0.18, 0, 0], 0.005, 2);

  // ---- barrel + gas block + muzzle
  const bLen = m.barrel + 0.05;
  const bz = z1 - bLen * 0.5;
  A.cyl('body', 'steelDark', 0.0098, 0.0104, bLen, [0, bore, bz], null, 14);
  A.box('body', 'steelDark', [0.020, 0.026, 0.026], [0, bore + 0.004, z1 - m.barrel * 0.80], null, 0.002);
  A.cyl('body', 'steelBlue', 0.0062, 0.0062, m.barrel * 0.5, [0, bore + 0.014, z1 - m.barrel * 0.55], null, 10);
  const muzzleZ = z1 - bLen - 0.020;
  muzzleBrake(A, 0, bore, muzzleZ + 0.004, 0.0138, 0.046);

  // ---- grip, trigger, stock
  pistolGrip(A, 0, -0.002, 0.020, 0.30, 0.105, 'grip', 0.031);
  triggerGroup(A, 0, 0.000, -0.014, 0.020);
  if (m.stock === 'skeleton') skeletonStock(A, 0, 0.052, z0, 0.150);
  else carbineStock(A, 0, 0.052, z0, 0.145);
  chargingHandle(A, 0, 0.080, z0 - 0.004, 1, 0.048);

  // ---- optic
  const optic = buildOptic(A, m.optic, 0, 0.086, cz - 0.040);

  return {
    sight: optic.sight,
    muzzle: [0, bore, muzzleZ - 0.028],
    eject: [w * 0.5 + 0.004, 0.062, -0.020],
    optic,
    magOpen: -0.055,
  };
}

/* ------------------------------------------------------------ SMG frame -- */

function buildSMG(A, def) {
  const m = def.model;
  const bore = 0.042;
  const recLen = m.receiver;
  const z0 = 0.040, z1 = z0 - recLen, cz = (z0 + z1) * 0.5;
  const w = 0.046;

  // polymer chassis
  A.box('body', 'poly', [w, 0.050, recLen], [0, 0.020, cz], null, 0.005, 2);
  A.box('body', 'body', [w - 0.008, 0.036, recLen * 0.92], [0, 0.058, cz - 0.004], null, 0.004, 2);
  A.box('body', 'poly', [w + 0.005, 0.034, 0.058], [0, 0.012, -0.048], null, 0.005, 2);      // mag well
  A.box('body', 'bodyDark', [w + 0.007, 0.008, 0.050], [0, -0.006, -0.048], null, 0.003);
  // ejection port + bolt
  A.box('body', 'steelBlue', [0.005, 0.022, 0.050], [w * 0.5 - 0.004, 0.058, -0.010], null, 0.0016);
  A.node('bolt', w * 0.5 - 0.006, 0.058, -0.010);
  A.box('bolt', 'steel', [0.006, 0.018, 0.034], [w * 0.5 - 0.008, 0.058, -0.010], null, 0.0014);
  // rail + irons
  A.rail('body', 'accent', recLen * 0.74, [0, 0.079, cz - 0.010], 0.020);
  A.box('body', 'accent', [0.016, 0.016, 0.005], [0, 0.090, z1 + 0.012], null, 0.0012);

  // stubby handguard with finger stop and vent windows
  const hgLen = 0.10;
  const hgZ = z1 - hgLen * 0.5 - 0.002;
  A.box('body', 'poly', [0.040, 0.046, hgLen], [0, bore - 0.002, hgZ], null, 0.005, 2);
  for (let i = 0; i < 3; i++) {
    A.box('body', 'bodyDark', [0.044, 0.012, 0.016], [0, bore - 0.014, hgZ - 0.030 + i * 0.028], null, 0.002);
  }
  A.box('body', 'grip', [0.024, 0.026, 0.020], [0, bore - 0.036, hgZ - 0.026], [0.28, 0, 0], 0.005, 2);
  A.rail('body', 'accent', hgLen * 0.7, [0, bore - 0.026, hgZ], 0.016);

  // barrel + big flash hider
  const bLen = m.barrel + 0.04;
  A.cyl('body', 'steelDark', 0.0088, 0.0092, bLen, [0, bore, z1 - bLen * 0.5], null, 12);
  const muzzleZ = z1 - bLen - 0.014;
  A.cyl('body', 'steelDark', 0.0125, 0.0145, 0.030, [0, bore, muzzleZ + 0.004], null, 14);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    A.box('body', 'steelBlue', [0.004, 0.010, 0.018], [Math.cos(a) * 0.0115, bore + Math.sin(a) * 0.0115, muzzleZ], [0, 0, a]);
  }

  stickMag(A, 'mag', 0, -0.002, -0.048, 0.030, 0.036, 0.155, 'poly', 0.05);
  A.node('mag', 0, -0.002, -0.048);
  pistolGrip(A, 0, -0.004, 0.014, 0.34, 0.098, 'grip', 0.030);
  triggerGroup(A, 0, -0.002, -0.010, 0.018);
  foldingStock(A, 0, 0.050, z0, 0.120);
  chargingHandle(A, 0, 0.078, z0 - 0.006, 1, 0.042);

  const optic = buildOptic(A, m.optic, 0, 0.082, cz - 0.028);

  return {
    sight: optic.sight,
    muzzle: [0, bore, muzzleZ - 0.018],
    eject: [w * 0.5 + 0.004, 0.058, -0.010],
    optic,
    magOpen: -0.048,
  };
}

/* ------------------------------------------------------------ LMG frame -- */

function buildLMG(A, def) {
  const m = def.model;
  const bore = 0.052;
  const recLen = m.receiver;
  const z0 = 0.072, z1 = z0 - recLen, cz = (z0 + z1) * 0.5;
  const w = 0.062;

  A.box('body', 'body', [w, 0.058, recLen], [0, 0.026, cz], null, 0.005, 2);
  A.box('body', 'body', [w - 0.006, 0.046, recLen * 0.94], [0, 0.070, cz - 0.004], null, 0.005, 2);
  A.box('body', 'bodyDark', [w + 0.004, 0.014, recLen * 0.5], [0, 0.050, cz - 0.040], null, 0.003);
  // feed tray cover hinge + carry handle
  A.box('body', 'accent', [0.018, 0.010, 0.070], [0, 0.096, cz + 0.010], null, 0.002);
  A.box('body', 'accent', [0.014, 0.032, 0.012], [0, 0.110, cz - 0.020], null, 0.003);
  A.box('body', 'accent', [0.014, 0.032, 0.012], [0, 0.110, cz + 0.040], null, 0.003);
  A.box('body', 'grip', [0.020, 0.014, 0.070], [0, 0.128, cz + 0.010], null, 0.005, 2);
  // ejection port
  A.box('body', 'steelBlue', [0.006, 0.030, 0.070], [w * 0.5 - 0.004, 0.062, -0.020], null, 0.002);
  A.node('bolt', w * 0.5 - 0.006, 0.062, -0.020);
  A.box('bolt', 'steel', [0.007, 0.026, 0.046], [w * 0.5 - 0.008, 0.062, -0.020], null, 0.0016);

  A.rail('body', 'accent', recLen * 0.40, [0, 0.095, cz - 0.075], 0.022);

  // huge box magazine
  A.node('mag', 0, 0.000, -0.060);
  A.box('mag', 'poly', [0.070, 0.115, 0.098], [0, -0.062, -0.060], [0.03, 0, 0], 0.008, 2);
  A.box('mag', 'body', [0.076, 0.012, 0.104], [0, -0.004, -0.060], null, 0.003);
  A.box('mag', 'bodyDark', [0.074, 0.030, 0.020], [0, -0.050, -0.108], null, 0.004);
  A.box('mag', 'accent', [0.010, 0.070, 0.012], [0.036, -0.060, -0.060], null, 0.002);
  A.box('mag', 'accent', [0.010, 0.070, 0.012], [-0.036, -0.060, -0.060], null, 0.002);

  // heavy barrel with heat-sink fins inside a ventilated shroud
  const bLen = m.barrel + 0.05;
  const bz = z1 - bLen * 0.5;
  A.cyl('body', 'steelDark', 0.0125, 0.0135, bLen, [0, bore, bz], null, 14);
  A.fins('body', 'steelDark', 0.0195, 7, -0.055, -0.185, [0, bore, z1], 0.0055);
  A.shroud('body', 'body', 0.0295, m.barrel * 0.52, [0, bore, z1 - m.barrel * 0.28], 6, 0.0065, 0.020, 0.0);
  A.cyl('body', 'body', 0.0330, 0.0330, 0.016, [0, bore, z1 - 0.014], null, 16);
  A.screws('body', 'accent', 0.0290, 6, [0, bore, z1 - 0.014], 0.0026);
  // gas system
  A.cyl('body', 'steelBlue', 0.0080, 0.0080, m.barrel * 0.55, [0, bore - 0.020, z1 - m.barrel * 0.45], null, 10);
  const muzzleZ = z1 - bLen - 0.024;
  muzzleBrake(A, 0, bore, muzzleZ + 0.006, 0.0175, 0.052);

  // folded bipod under the muzzle end
  A.node('bipod', 0, bore - 0.030, z1 - m.barrel * 0.72);
  A.box('bipod', 'accent', [0.026, 0.014, 0.030], [0, bore - 0.032, z1 - m.barrel * 0.72], null, 0.003);
  for (const s of [-1, 1]) {
    A.cyl('bipod', 'steelDark', 0.0042, 0.0042, 0.105,
      [s * 0.012, bore - 0.038, z1 - m.barrel * 0.72 + 0.050], [0.42, 0, s * 0.10], 8);
    A.box('bipod', 'grip', [0.010, 0.010, 0.020], [s * 0.014, bore - 0.058, z1 - m.barrel * 0.72 + 0.094], [0.42, 0, 0], 0.002);
  }

  pistolGrip(A, 0, 0.000, 0.030, 0.28, 0.112, 'grip', 0.034);
  triggerGroup(A, 0, 0.002, -0.006, 0.021);
  fixedStock(A, 0, 0.058, z0, 0.175);
  chargingHandle(A, 0.030, 0.062, z0 - 0.030, 1, 0.030);

  const optic = buildOptic(A, m.optic, 0, 0.098, cz - 0.072);

  return {
    sight: optic.sight,
    muzzle: [0, bore, muzzleZ - 0.030],
    eject: [w * 0.5 + 0.006, 0.062, -0.020],
    optic,
    magOpen: -0.060,
  };
}

/* -------------------------------------------------------- shotgun frame -- */

function buildShotgun(A, def) {
  const m = def.model;
  const bore = 0.050;
  const recLen = m.receiver;
  const z0 = 0.050, z1 = z0 - recLen, cz = (z0 + z1) * 0.5;
  const w = 0.048;

  // milled steel receiver
  A.box('body', 'body', [w, 0.062, recLen], [0, 0.030, cz], null, 0.005, 2);
  A.box('body', 'bodyDark', [w + 0.003, 0.020, recLen * 0.62], [0, 0.050, cz - 0.010], null, 0.004);
  A.box('body', 'steelBlue', [0.006, 0.026, 0.058], [w * 0.5 - 0.003, 0.038, -0.020], null, 0.002);  // ejection port
  A.box('body', 'steelBlue', [0.006, 0.020, 0.062], [-w * 0.5 + 0.003, 0.016, -0.030], null, 0.002); // loading gate
  A.node('bolt', w * 0.5 - 0.006, 0.038, -0.020);
  A.box('bolt', 'steel', [0.007, 0.022, 0.042], [w * 0.5 - 0.008, 0.038, -0.020], null, 0.0016);
  A.box('body', 'accent', [0.010, 0.012, 0.020], [w * 0.5 - 0.001, 0.056, 0.024], null, 0.002);      // safety

  // barrel + magazine tube
  const bLen = m.barrel;
  const bz = z1 - bLen * 0.5;
  A.cyl('body', 'steelDark', 0.0192, 0.0200, bLen, [0, bore, bz], null, 18);
  A.cyl('body', 'body', 0.0215, 0.0215, 0.020, [0, bore, z1 - 0.012], null, 18);
  A.cyl('body', 'steelDark', 0.0135, 0.0135, bLen * 0.72, [0, bore - 0.031, z1 - bLen * 0.36], null, 14);
  A.cyl('body', 'accent', 0.0148, 0.0148, 0.014, [0, bore - 0.031, z1 - bLen * 0.72], null, 14);     // tube cap
  A.box('body', 'accent', [0.030, 0.008, 0.018], [0, bore - 0.016, z1 - bLen * 0.70], null, 0.002);  // barrel clamp
  A.box('body', 'accent', [0.030, 0.008, 0.018], [0, bore - 0.016, z1 - bLen * 0.30], null, 0.002);
  // choke
  A.cyl('body', 'steelBlue', 0.0206, 0.0198, 0.024, [0, bore, z1 - bLen - 0.008], null, 18);

  // pump fore-end (animated node)
  const pumpZ = z1 - bLen * 0.46;
  A.node('pump', 0, bore - 0.016, pumpZ);
  A.box('pump', 'poly', [0.046, 0.052, 0.118], [0, bore - 0.018, pumpZ], null, 0.010, 2);
  for (let i = 0; i < 6; i++) {
    A.box('pump', 'bodyDark', [0.050, 0.007, 0.009], [0, bore - 0.034, pumpZ - 0.046 + i * 0.019], null, 0.0015);
    A.box('pump', 'bodyDark', [0.007, 0.044, 0.009], [0.024, bore - 0.018, pumpZ - 0.046 + i * 0.019], null, 0.0015);
    A.box('pump', 'bodyDark', [0.007, 0.044, 0.009], [-0.024, bore - 0.018, pumpZ - 0.046 + i * 0.019], null, 0.0015);
  }
  A.cyl('pump', 'accent', 0.0165, 0.0165, 0.012, [0, bore - 0.031, pumpZ + 0.062], null, 14);

  // stock + grip: wood, no separate pistol grip
  woodStock(A, 0, 0.028, z0 - 0.006, 0.205);
  triggerGroup(A, 0, 0.004, -0.006, 0.022);
  // shell carrier detail on the underside
  A.box('body', 'bodyDark', [0.030, 0.010, 0.050], [0, -0.004, -0.030], null, 0.002);

  const optic = buildOptic(A, m.optic, 0, 0.068, z1 - bLen * 0.42);

  return {
    sight: optic.sight,
    muzzle: [0, bore, z1 - bLen - 0.022],
    eject: [w * 0.5 + 0.004, 0.040, -0.020],
    optic,
    magOpen: -0.030,
  };
}

/* --------------------------------------------------------- sniper frame -- */

function buildSniper(A, def) {
  const m = def.model;
  const bore = 0.048;
  const recLen = m.receiver;
  const z0 = 0.062, z1 = z0 - recLen, cz = (z0 + z1) * 0.5;
  const w = 0.044;

  // chassis
  A.box('body', 'body', [w, 0.052, recLen], [0, 0.024, cz], null, 0.004, 2);
  A.box('body', 'body', [w - 0.004, 0.040, recLen * 0.86], [0, 0.062, cz - 0.010], null, 0.004, 2);
  A.box('body', 'bodyDark', [w + 0.004, 0.016, recLen * 0.44], [0, 0.046, cz - 0.030], null, 0.003);
  // chassis lightening cuts
  for (let i = 0; i < 3; i++) {
    A.box('body', 'bodyDark', [w + 0.006, 0.020, 0.030], [0, 0.024, cz - 0.055 + i * 0.055], null, 0.004);
  }
  // rail
  A.rail('body', 'accent', recLen * 0.80, [0, 0.084, cz - 0.014], 0.022);

  // bolt (animated) on the right
  A.node('bolt', 0.030, 0.066, z0 - 0.048);
  A.cyl('bolt', 'steel', 0.0105, 0.0105, 0.070, [0.020, 0.066, z0 - 0.058], null, 14);
  A.cyl('bolt', 'steel', 0.0060, 0.0060, 0.044, [0.034, 0.062, z0 - 0.036], [0, -0.55, 0.30], 10);
  A.sphere('bolt', 'accent', 0.0092, [0.050, 0.054, z0 - 0.026], 12);
  A.box('bolt', 'steelDark', [0.014, 0.014, 0.016], [0.020, 0.066, z0 - 0.020], null, 0.002);

  // long fluted barrel
  const bLen = m.barrel;
  A.cyl('body', 'steelDark', 0.0105, 0.0135, bLen, [0, bore, z1 - bLen * 0.5], null, 14);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.25;
    A.box('body', 'steelBlue', [0.0035, 0.0035, bLen * 0.42],
      [Math.cos(a) * 0.0118, bore + Math.sin(a) * 0.0118, z1 - bLen * 0.42], [0, 0, a]);
  }
  A.cyl('body', 'body', 0.0165, 0.0165, 0.018, [0, bore, z1 - 0.010], null, 16);
  // handguard / forend
  const hgLen = bLen * 0.42;
  const hgZ = z1 - hgLen * 0.5 - 0.014;
  A.box('body', 'body', [0.040, 0.036, hgLen], [0, bore - 0.008, hgZ], null, 0.005, 2);
  for (let i = 0; i < 5; i++) {
    A.box('body', 'bodyDark', [0.044, 0.012, 0.016], [0, bore - 0.014, hgZ - hgLen * 0.34 + i * hgLen * 0.17], null, 0.002);
  }
  A.rail('body', 'accent', hgLen * 0.5, [0, bore - 0.028, hgZ], 0.017);
  // muzzle brake
  const muzzleZ = z1 - bLen - 0.026;
  muzzleBrake(A, 0, bore, muzzleZ + 0.006, 0.0165, 0.052);

  // straight box magazine
  A.node('mag', 0, 0.000, -0.052);
  A.box('mag', 'body', [0.030, 0.086, 0.070], [0, -0.046, -0.052], [0.04, 0, 0], 0.005, 2);
  A.box('mag', 'bodyDark', [0.034, 0.010, 0.074], [0, -0.002, -0.052], null, 0.003);
  A.box('mag', 'accent', [0.034, 0.008, 0.076], [0, -0.090, -0.050], [0.04, 0, 0], 0.003);

  pistolGrip(A, 0, -0.002, 0.020, 0.24, 0.108, 'grip', 0.030);
  triggerGroup(A, 0, 0.000, -0.012, 0.019);
  skeletonStock(A, 0, 0.050, z0, 0.175);

  const optic = buildOptic(A, m.optic, 0, 0.087, cz - 0.030);

  return {
    sight: optic.sight,
    muzzle: [0, bore, muzzleZ - 0.032],
    eject: [w * 0.5 + 0.006, 0.066, z0 - 0.058],
    optic,
    magOpen: -0.052,
  };
}

/* --------------------------------------------------------- pistol frame -- */

function buildPistol(A, def) {
  const m = def.model;
  const bore = 0.038;
  const z0 = 0.048, z1 = z0 - m.receiver, cz = (z0 + z1) * 0.5;
  const w = 0.030;

  // frame + top strap
  A.box('body', 'body', [w, 0.040, m.receiver], [0, 0.022, cz], null, 0.004, 2);
  A.box('body', 'body', [w - 0.004, 0.020, m.receiver * 0.92], [0, 0.050, cz - 0.002], null, 0.004, 2);
  A.box('body', 'bodyDark', [w + 0.003, 0.010, 0.050], [0, 0.008, cz + 0.010], null, 0.003);
  // recoil shield + hammer
  A.box('body', 'body', [w + 0.002, 0.034, 0.014], [0, 0.034, z0 - 0.006], null, 0.003);
  A.box('body', 'accent', [0.009, 0.024, 0.014], [0, 0.062, z0 + 0.004], [-0.35, 0, 0], 0.0025);
  A.box('body', 'accent', [0.011, 0.010, 0.010], [0, 0.073, z0 + 0.010], [-0.35, 0, 0], 0.002);

  // cylinder (animated node — swings out on reload)
  const cylZ = cz + 0.006;
  A.node('cyl', 0, bore, cylZ);
  A.cyl('cyl', 'steelBlue', 0.0215, 0.0215, 0.046, [0, bore, cylZ], null, 18);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.2;
    A.cyl('cyl', 'steelDark', 0.0052, 0.0052, 0.050,
      [Math.cos(a) * 0.0140, bore + Math.sin(a) * 0.0140, cylZ], null, 10);
    A.box('cyl', 'body', [0.005, 0.010, 0.030],
      [Math.cos(a + 0.52) * 0.0215, bore + Math.sin(a + 0.52) * 0.0215, cylZ], [0, 0, a + 0.52], 0.001);
  }
  A.cyl('cyl', 'accent', 0.0068, 0.0068, 0.054, [0, bore, cylZ], null, 12);
  A.cyl('cyl', 'accent', 0.0090, 0.0090, 0.006, [0, bore, cylZ - 0.026], null, 12);

  // barrel with a vented rib and underlug
  const bLen = m.barrel;
  const bz = z1 - bLen * 0.5 + 0.010;
  A.cyl('body', 'steelBlue', 0.0092, 0.0092, bLen, [0, bore, bz], null, 14);
  A.box('body', 'body', [0.016, 0.030, bLen], [0, bore + 0.004, bz], null, 0.003, 2);
  A.box('body', 'body', [0.020, 0.018, bLen * 0.86], [0, bore - 0.020, bz - 0.004], null, 0.003, 2);   // underlug
  for (let i = 0; i < 5; i++) {
    A.box('body', 'bodyDark', [0.018, 0.007, 0.007], [0, bore + 0.018, bz - bLen * 0.32 + i * bLen * 0.16], null, 0.0012);
  }
  A.cyl('body', 'steelDark', 0.0110, 0.0110, 0.010, [0, bore, z1 - bLen + 0.008], null, 14);
  A.box('body', 'accent', [0.004, 0.010, 0.006], [0, bore + 0.020, z1 - bLen + 0.016], null, 0.001);   // front sight

  // wooden target grip
  const gTilt = 0.42;
  A.box('body', 'wood', [0.034, 0.100, 0.048], [0, -0.048, 0.026], [gTilt, 0, 0], 0.010, 2);
  A.box('body', 'body', [0.024, 0.104, 0.030], [0, -0.048, 0.020], [gTilt, 0, 0], 0.004, 2);
  A.box('body', 'wood', [0.036, 0.026, 0.036], [0, -0.014, 0.014], [gTilt, 0, 0], 0.008, 2);
  A.box('body', 'accent', [0.036, 0.008, 0.040], [0, -0.096, 0.048], [gTilt, 0, 0], 0.003);
  triggerGroup(A, 0, -0.002, -0.006, 0.020);

  const optic = buildOptic(A, m.optic, 0, 0.058, cz - 0.030);

  return {
    sight: optic.sight,
    muzzle: [0, bore, z1 - bLen + 0.002],
    eject: [w * 0.5 + 0.004, bore, cylZ],
    optic,
    magOpen: 0,
  };
}

/* ----------------------------------------------------------------- api --- */

const BUILDERS = {
  ar: buildAR, smg: buildSMG, lmg: buildLMG,
  shotgun: buildShotgun, sniper: buildSniper, pistol: buildPistol,
};

/**
 * Build a complete viewmodel for a weapon definition.
 * @returns {{root:THREE.Group, nodes:Object, sight:THREE.Vector3,
 *            muzzle:THREE.Vector3, eject:THREE.Vector3, optic:Object, tris:number}}
 */
export function buildViewmodel(def) {
  const mats = palette(def.model.tint);
  const A = new Assembly(mats);
  const fn = BUILDERS[def.model.frame] || buildAR;
  const info = fn(A, def);
  const built = A.build();

  return {
    root: built.root,
    nodes: built.nodes,
    mats,
    tris: built.tris,
    sight: new THREE.Vector3(info.sight[0], info.sight[1], info.sight[2]),
    muzzle: new THREE.Vector3(info.muzzle[0], info.muzzle[1], info.muzzle[2]),
    eject: new THREE.Vector3(info.eject[0], info.eject[1], info.eject[2]),
    optic: info.optic,
  };
}

export default buildViewmodel;
