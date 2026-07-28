import { makeRNG } from '../core/Rand.js';
import { lerp } from './MathKit.js';

/**
 * The weapon roster.
 *
 * Everything that defines how a gun *handles* lives here so the feel can be
 * retuned in one file. Numbers are in real units: metres, seconds, degrees,
 * rounds-per-minute. Damage is per bullet before the headshot/leg multipliers
 * in CFG.combat.
 *
 * The ids are deliberately conventional (r301, flatline, r99, spitfire,
 * peacekeeper, longbow, wingman) because the audio system's `weaponClass()`
 * regex-matches them to pick the right gunshot synthesis.
 */

/* ---------------------------------------------------------------- recoil -- */

/**
 * Build a deterministic, learnable recoil pattern.
 *
 * A pattern is a flat Float32Array of [pitchDeg, yawDeg] pairs, one per shot.
 * Each segment interpolates a spine (the shape the player memorises) and adds
 * a *seeded* wobble that is identical every single time the gun is fired — so
 * the spray is a fixed curve in the air, not a random cone. That difference is
 * the entire skill ceiling of the gunplay.
 *
 * @param {number} seed
 * @param {Array<{n:number, up:[number,number], side:[number,number], ju?:number, js?:number}>} segs
 */
export function buildPattern(seed, segs) {
  const rng = makeRNG(seed);
  const out = [];
  for (const s of segs) {
    for (let i = 0; i < s.n; i++) {
      const k = s.n > 1 ? i / (s.n - 1) : 0;
      const up = lerp(s.up[0], s.up[1], k) + (rng() * 2 - 1) * (s.ju ?? 0);
      const side = lerp(s.side[0], s.side[1], k) + (rng() * 2 - 1) * (s.js ?? 0);
      out.push(up, side);
    }
  }
  return Float32Array.from(out);
}

/* ------------------------------------------------------------- prototype -- */

const BASE = {
  fireMode: 'auto',        // auto | semi | burst
  burstCount: 3,
  burstGap: 0.28,
  pellets: 1,
  hitscan: true,
  projectileSpeed: 0,      // m/s when !hitscan
  projectileDrop: 0,       // m/s^2
  tracerEvery: 1,
  maxRange: 700,
  falloff: { start: 40, end: 120, far: 0.7 },
  reserve: 200,
  reserveMax: 400,
  adsFovMul: 1.0,          // multiplies CFG.camera.adsFovScale
  adsSensMul: 1.0,
  eyeRelief: 0.30,
  swapIn: 0.44,
  swapOut: 0.22,
  patternReset: 0.42,      // seconds of no fire before the pattern rewinds
  recoilRecover: 0.92,     // fraction of view kick that returns on its own
  shake: { amplitude: 0.16, frequency: 30, duration: 0.10 },
  shellDelay: 0.0,
};

const SPREAD = {
  hipBase: 1.5, hipMax: 5.0, hipPerShot: 0.35, hipRecover: 5.0,
  adsBase: 0.10, adsMax: 1.1, adsPerShot: 0.10, adsRecover: 5.0,
  moveMul: 1.7, airMul: 2.4, crouchMul: 0.72, sprintMul: 2.2,
};

function def(o) {
  return {
    ...BASE, ...o,
    falloff: { ...BASE.falloff, ...(o.falloff || {}) },
    shake: { ...BASE.shake, ...(o.shake || {}) },
    spread: { ...SPREAD, ...(o.spread || {}) },
  };
}

/* ----------------------------------------------------------------- guns --- */

export const WEAPONS = {

  /* ============================ ASSAULT RIFLE ============================ */
  r301: def({
    id: 'r301', name: 'R-301 CARBINE', kind: 'ar', ammoType: 'light',
    fireMode: 'auto', rpm: 810,
    damage: 14, hitscan: true, maxRange: 500,
    falloff: { start: 42, end: 130, far: 0.70 },
    magSize: 28, reserve: 184, reserveMax: 280,
    reloadTactical: 2.25, reloadEmpty: 3.05,
    adsTime: 0.24, adsFovMul: 1.0, eyeRelief: 0.315,
    // Classic learnable AR spray: hard vertical climb, then a left hook, then
    // a wide right sweep. Compensating it is a skill you can actually acquire.
    pattern: buildPattern(0x3011, [
      { n: 4, up: [0.95, 0.80], side: [0.04, -0.05], ju: 0.03, js: 0.05 },
      { n: 8, up: [0.66, 0.44], side: [-0.22, -0.46], ju: 0.05, js: 0.09 },
      { n: 8, up: [0.40, 0.30], side: [0.30, 0.58], ju: 0.05, js: 0.11 },
      { n: 8, up: [0.28, 0.24], side: [-0.40, 0.36], ju: 0.06, js: 0.16 },
    ]),
    recoilRecover: 0.93,
    kick: { back: 0.85, up: 0.34, side: 0.20, pitch: 3.4, yaw: 1.5, roll: 2.1 },
    shake: { amplitude: 0.13, frequency: 34, duration: 0.08 },
    spread: { hipBase: 1.45, hipMax: 4.6, hipPerShot: 0.30, adsBase: 0.06, adsMax: 0.95, adsPerShot: 0.085 },
    model: {
      frame: 'ar', optic: 'reddot', tint: { body: 0x2f333a, poly: 0x23262b, accent: 0x6d7480 },
      barrel: 0.185, receiver: 0.285, stock: 'carbine', rail: true,
    },
    hip: { pos: [0.128, -0.132, -0.285], rot: [0.028, 0.175, -0.055] },
  }),

  flatline: def({
    id: 'flatline', name: 'VK-47 FLATLINE', kind: 'ar', ammoType: 'heavy',
    fireMode: 'auto', rpm: 600,
    damage: 19, hitscan: true, maxRange: 500,
    falloff: { start: 34, end: 110, far: 0.66 },
    magSize: 20, reserve: 120, reserveMax: 240,
    reloadTactical: 2.4, reloadEmpty: 3.35,
    adsTime: 0.30, adsFovMul: 1.0, eyeRelief: 0.325,
    // Brutal, wide, mostly horizontal — the anti-R301. Big first-shot jump.
    pattern: buildPattern(0x47AF, [
      { n: 3, up: [1.35, 1.10], side: [-0.10, 0.22], ju: 0.05, js: 0.08 },
      { n: 6, up: [0.92, 0.62], side: [0.55, 0.86], ju: 0.07, js: 0.14 },
      { n: 6, up: [0.55, 0.40], side: [-0.62, -1.05], ju: 0.07, js: 0.18 },
      { n: 5, up: [0.36, 0.30], side: [0.75, -0.55], ju: 0.08, js: 0.22 },
    ]),
    recoilRecover: 0.90,
    kick: { back: 1.15, up: 0.42, side: 0.30, pitch: 4.6, yaw: 2.3, roll: 3.0 },
    shake: { amplitude: 0.19, frequency: 30, duration: 0.11 },
    spread: { hipBase: 1.9, hipMax: 5.4, hipPerShot: 0.42, adsBase: 0.08, adsMax: 1.2, adsPerShot: 0.11 },
    model: {
      frame: 'ar', optic: 'holo', tint: { body: 0x3a3126, poly: 0x2a2620, accent: 0x7d6b4c },
      barrel: 0.205, receiver: 0.30, stock: 'skeleton', rail: true, heavy: true,
    },
    hip: { pos: [0.132, -0.138, -0.295], rot: [0.030, 0.170, -0.060] },
  }),

  /* ================================= SMG ================================= */
  r99: def({
    id: 'r99', name: 'R-99 SMG', kind: 'smg', ammoType: 'light',
    fireMode: 'auto', rpm: 1080,
    damage: 11, hitscan: true, maxRange: 380,
    falloff: { start: 22, end: 70, far: 0.58 },
    magSize: 20, reserve: 200, reserveMax: 300,
    reloadTactical: 1.75, reloadEmpty: 2.45,
    adsTime: 0.17, adsFovMul: 1.06, eyeRelief: 0.29,
    // Rips straight up for the first third then whips left-right very fast.
    pattern: buildPattern(0x99C1, [
      { n: 5, up: [0.80, 0.64], side: [0.06, -0.14], ju: 0.04, js: 0.07 },
      { n: 6, up: [0.52, 0.36], side: [-0.42, -0.72], ju: 0.05, js: 0.15 },
      { n: 9, up: [0.30, 0.22], side: [0.66, -0.72], ju: 0.06, js: 0.26 },
    ]),
    recoilRecover: 0.95,
    kick: { back: 0.62, up: 0.26, side: 0.22, pitch: 2.7, yaw: 1.7, roll: 1.8 },
    shake: { amplitude: 0.10, frequency: 40, duration: 0.06 },
    spread: { hipBase: 1.15, hipMax: 5.2, hipPerShot: 0.26, adsBase: 0.18, adsMax: 1.5, adsPerShot: 0.12, moveMul: 1.28 },
    model: {
      frame: 'smg', optic: 'reddot', tint: { body: 0x2b2e33, poly: 0x1d2024, accent: 0x8a939e },
      barrel: 0.095, receiver: 0.215, stock: 'folding', rail: true,
    },
    hip: { pos: [0.125, -0.122, -0.255], rot: [0.030, 0.185, -0.050] },
  }),

  /* ================================= LMG ================================= */
  spitfire: def({
    id: 'spitfire', name: 'M600 SPITFIRE', kind: 'lmg', ammoType: 'heavy',
    fireMode: 'auto', rpm: 540,
    damage: 18, hitscan: true, maxRange: 550,
    falloff: { start: 46, end: 150, far: 0.74 },
    magSize: 35, reserve: 140, reserveMax: 240,
    reloadTactical: 3.35, reloadEmpty: 4.15,
    adsTime: 0.38, adsFovMul: 0.96, eyeRelief: 0.335,
    // Heavy weapon logic: violent for six rounds, then it *settles* and the
    // pattern becomes almost a straight line you can hold through.
    pattern: buildPattern(0x5917, [
      { n: 6, up: [1.05, 0.62], side: [0.14, 0.40], ju: 0.06, js: 0.10 },
      { n: 10, up: [0.42, 0.26], side: [-0.30, -0.42], ju: 0.04, js: 0.09 },
      { n: 19, up: [0.22, 0.18], side: [0.28, -0.30], ju: 0.04, js: 0.13 },
    ]),
    recoilRecover: 0.88,
    kick: { back: 1.35, up: 0.46, side: 0.26, pitch: 4.2, yaw: 1.8, roll: 2.4 },
    shake: { amplitude: 0.22, frequency: 26, duration: 0.13 },
    spread: { hipBase: 2.4, hipMax: 6.2, hipPerShot: 0.36, adsBase: 0.10, adsMax: 1.1, adsPerShot: 0.08, moveMul: 2.1 },
    model: {
      frame: 'lmg', optic: 'reddot', tint: { body: 0x33383d, poly: 0x212429, accent: 0x6b737d },
      barrel: 0.26, receiver: 0.34, stock: 'fixed', rail: true, bipod: true,
    },
    hip: { pos: [0.140, -0.148, -0.300], rot: [0.026, 0.160, -0.062] },
  }),

  /* =============================== SHOTGUN =============================== */
  peacekeeper: def({
    id: 'peacekeeper', name: 'PEACEKEEPER', kind: 'shotgun', ammoType: 'shotgun',
    fireMode: 'semi', rpm: 63,               // ~1.05 s between shells
    damage: 9, pellets: 11, hitscan: true, maxRange: 120,
    falloff: { start: 12, end: 42, far: 0.42 },
    magSize: 5, reserve: 32, reserveMax: 64,
    reloadTactical: 2.6, reloadEmpty: 3.3,
    shellReload: true, shellTime: 0.46, shellPrime: 0.55, shellFinish: 0.55,
    adsTime: 0.34, adsFovMul: 1.12, eyeRelief: 0.30,
    pattern: buildPattern(0x9EE7, [
      { n: 2, up: [3.30, 3.05], side: [-0.35, 0.42], ju: 0.10, js: 0.20 },
      { n: 6, up: [2.85, 2.55], side: [0.55, -0.60], ju: 0.14, js: 0.40 },
    ]),
    recoilRecover: 0.86,
    kick: { back: 2.60, up: 0.70, side: 0.34, pitch: 9.5, yaw: 2.2, roll: 4.0 },
    shake: { amplitude: 0.42, frequency: 22, duration: 0.20 },
    spread: { hipBase: 0.9, hipMax: 2.2, hipPerShot: 0.6, adsBase: 0.5, adsMax: 1.4, adsPerShot: 0.4 },
    pelletSpread: { hip: 5.6, ads: 3.4 },     // degrees, cone half-angle
    model: {
      frame: 'shotgun', optic: 'bead', tint: { body: 0x2c2f34, poly: 0x4a3524, accent: 0x8d939b },
      barrel: 0.33, receiver: 0.235, stock: 'wood',
    },
    hip: { pos: [0.135, -0.140, -0.290], rot: [0.034, 0.165, -0.058] },
  }),

  /* ================================ SNIPER =============================== */
  longbow: def({
    id: 'longbow', name: 'LONGBOW DMR', kind: 'sniper', ammoType: 'sniper',
    fireMode: 'semi', rpm: 78,
    damage: 55, hitscan: false, projectileSpeed: 470, projectileDrop: 5.2,
    maxRange: 900,
    falloff: { start: 200, end: 420, far: 0.86 },
    magSize: 6, reserve: 28, reserveMax: 48,
    reloadTactical: 2.7, reloadEmpty: 3.6,
    adsTime: 0.46, adsFovMul: 0.58, adsSensMul: 0.72, eyeRelief: 0.345,
    boltAction: true, boltTime: 0.62,
    pattern: buildPattern(0x1B0B, [
      { n: 2, up: [3.60, 3.35], side: [0.18, -0.24], ju: 0.06, js: 0.10 },
      { n: 6, up: [3.10, 2.80], side: [-0.42, 0.50], ju: 0.10, js: 0.22 },
    ]),
    recoilRecover: 0.90,
    kick: { back: 2.05, up: 0.60, side: 0.20, pitch: 8.0, yaw: 1.4, roll: 2.6 },
    shake: { amplitude: 0.34, frequency: 20, duration: 0.22 },
    spread: { hipBase: 3.4, hipMax: 6.0, hipPerShot: 1.0, adsBase: 0.0, adsMax: 0.6, adsPerShot: 0.35, moveMul: 2.6 },
    model: {
      frame: 'sniper', optic: 'scope', tint: { body: 0x2a2d31, poly: 0x1c1f22, accent: 0x767d86 },
      barrel: 0.45, receiver: 0.30, stock: 'skeleton',
    },
    hip: { pos: [0.142, -0.150, -0.305], rot: [0.024, 0.150, -0.050] },
  }),

  /* ================================ PISTOL =============================== */
  wingman: def({
    id: 'wingman', name: 'WINGMAN', kind: 'pistol', ammoType: 'heavy',
    fireMode: 'semi', rpm: 156,
    damage: 45, hitscan: false, projectileSpeed: 330, projectileDrop: 6.5,
    maxRange: 600,
    falloff: { start: 90, end: 240, far: 0.82 },
    magSize: 6, reserve: 36, reserveMax: 60,
    reloadTactical: 2.15, reloadEmpty: 2.55,
    adsTime: 0.21, adsFovMul: 1.14, eyeRelief: 0.275,
    revolver: true,
    pattern: buildPattern(0x7A1D, [
      { n: 2, up: [2.55, 2.30], side: [0.22, -0.28], ju: 0.06, js: 0.12 },
      { n: 8, up: [2.10, 1.85], side: [-0.50, 0.62], ju: 0.12, js: 0.30 },
    ]),
    recoilRecover: 0.94,
    kick: { back: 1.55, up: 0.72, side: 0.26, pitch: 8.6, yaw: 2.0, roll: 3.4 },
    shake: { amplitude: 0.26, frequency: 32, duration: 0.13 },
    spread: { hipBase: 1.7, hipMax: 4.4, hipPerShot: 0.9, adsBase: 0.0, adsMax: 1.0, adsPerShot: 0.45 },
    model: {
      frame: 'pistol', optic: 'minidot', tint: { body: 0x2e3136, poly: 0x5a4029, accent: 0xa8b0ba },
      barrel: 0.135, receiver: 0.155, stock: 'none',
    },
    hip: { pos: [0.108, -0.118, -0.245], rot: [0.040, 0.200, -0.045] },
  }),
};

export const WEAPON_IDS = Object.keys(WEAPONS);

/** Default two-slot loadout. */
export const DEFAULT_LOADOUT = ['r301', 'peacekeeper'];

/** Seconds between rounds. */
export function fireInterval(d) { return 60 / Math.max(1, d.rpm); }

/**
 * Damage multiplier from range. Linear between `start` and `end`, flat outside.
 */
export function falloffMul(d, dist) {
  const f = d.falloff;
  if (dist <= f.start) return 1;
  if (dist >= f.end) return f.far;
  const k = (dist - f.start) / Math.max(0.001, f.end - f.start);
  return 1 + (f.far - 1) * k;
}

export default WEAPONS;
