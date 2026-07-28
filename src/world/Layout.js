import * as THREE from 'three';

/**
 * The map's design document, in data.
 *
 * Terrain flattening, POI placement, road spines and traversal endpoints all
 * read from here so the landscape and the architecture can never disagree
 * about where the ground is.
 *
 * Convention: -Z is north. The sun sits at azimuth ~82 deg (roughly due east,
 * 26 deg up), so every POI is oriented to present a lit face and a shadowed
 * face rather than a flat frontal read.
 */

export const MAP_RADIUS = 360;        // fine-terrain half extent (metres)
export const FAR_RADIUS = 1900;       // silhouette skirt

/** Water level of the wadi that splits the basin. */
export const WATER_Y = -2.35;

/** Flattened building pads. Terrain lerps to `y` inside, blends out over `blend`. */
export const PADS = [
  { id: 'plaza',   x: 4,    z: 4,    hw: 62, hd: 58, y: 0.0,  blend: 34 },
  { id: 'hangar',  x: -56,  z: -148, hw: 58, hd: 48, y: 1.4,  blend: 30 },
  { id: 'foundry', x: 98,   z: -112, hw: 58, hd: 54, y: 5.2,  blend: 32 },
  { id: 'terrace', x: -116, z: 44,   hw: 40, hd: 62, y: 2.2,  blend: 26 },
  { id: 'bore',    x: 74,   z: 148,  hw: 62, hd: 48, y: -5.5, blend: 40 },
  { id: 'relay',   x: 196,  z: 6,    hw: 32, hd: 28, y: 48.0, blend: 30 },
];

export const PAD = {};
for (const p of PADS) PAD[p.id] = p;

/** Road spines. Terrain is smoothed along these, and ribbons are laid on top. */
export const ROADS = [
  {
    id: 'canyon', width: 11.5, kerb: true,
    pts: [[13, 128], [12, 74], [11, 34], [7, -12], [1, -58], [-16, -104], [-40, -136]],
  },
  {
    id: 'foundry-spur', width: 8.5, kerb: true,
    pts: [[16, -22], [46, -40], [74, -64], [92, -88], [98, -104]],
  },
  {
    id: 'west-lane', width: 8.5, kerb: true,
    pts: [[-26, 18], [-52, 32], [-80, 40], [-104, 44], [-118, 46]],
  },
  {
    id: 'haul', width: 13.5, kerb: false,
    pts: [[18, 56], [36, 92], [54, 124], [72, 144]],
  },
  {
    id: 'relay-track', width: 6.5, kerb: false,
    pts: [[60, -10], [104, -6], [146, 2], [176, 6], [192, 6]],
  },
];

/** The wadi: a dry-season river channel that cuts the west side of the basin. */
export function wadiCenter(z) {
  return -78 + 34 * Math.sin(z * 0.0112) + 9 * Math.sin(z * 0.031 + 1.7);
}

export const SPAWN_HINTS = [
  { x: 12, z: 30, note: 'Canyon Road south of Souk Plaza' },
  { x: -22, z: 18, note: 'Souk Plaza west colonnade' },
  { x: 28, z: -22, note: 'Plaza north gate' },
  { x: -52, z: -124, note: 'Hangar 7 apron' },
  { x: 88, z: -96, note: 'Foundry tank farm' },
  { x: -112, z: 26, note: 'Terrace Row street' },
  { x: 66, z: 128, note: 'The Bore haul road' },
  { x: 186, z: 14, note: 'Relay Spire pad' },
  { x: -46, z: 60, note: 'Wadi crossing' },
  { x: 44, z: 52, note: 'South workshops' },
];

/** Helper: distance from p to segment ab, plus the parameter along it. */
const _pa = new THREE.Vector2();
const _ba = new THREE.Vector2();
export function segDist(px, pz, ax, az, bx, bz, out) {
  _pa.set(px - ax, pz - az);
  _ba.set(bx - ax, bz - az);
  const len2 = _ba.lengthSq() || 1e-6;
  let t = (_pa.x * _ba.x + _pa.y * _ba.y) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + _ba.x * t, cz = az + _ba.y * t;
  if (out) { out.x = cx; out.z = cz; out.t = t; }
  return Math.hypot(px - cx, pz - cz);
}

export function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
}
