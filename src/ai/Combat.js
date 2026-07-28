import * as THREE from 'three';
import WEAPONS, { fireInterval, falloffMul } from '../weapons/WeaponDefs.js';
import AI from './AIConfig.js';

/**
 * Bot gunplay: magazine handling, burst discipline, and the aim model.
 *
 * The aim model is the difference between "enemy AI" and "aimbot". Three
 * things do the work:
 *
 *  1. TRACKING LAG — the bot does not know where you are, it knows where you
 *     were. A first-order lag on the target position means a strafing player
 *     is genuinely hard to hit and a stationary one is not.
 *  2. CONVERGING ERROR — the aim offset starts wide and shrinks the longer the
 *     bot holds the target, so the opening shots of a fight miss and staying in
 *     the open gets you killed.
 *  3. WANDER, NOT JITTER — the error vector is a damped random walk. Per-frame
 *     white noise reads as a machine; a slow drift reads as a hand.
 */

const FALLBACK = {
  id: 'bot_rifle', name: 'RIFLE', rpm: 620, damage: 13, magSize: 30, reserve: 240,
  reloadTactical: 2.3, reloadEmpty: 3.0, maxRange: 400, pellets: 1,
  falloff: { start: 40, end: 130, far: 0.7 },
};

/** Loadouts by squad role, so a squad has a spread of engagement ranges. */
export const ROLE_WEAPON = {
  point: ['vx4_smg', 'cr56_carbine'],
  anchor: ['cr56_carbine', 'hx9_assault'],
  support: ['m77_lmg', 'hx9_assault'],
  marksman: ['mk8_marksman', 'cr56_carbine'],
};

export function pickWeapon(role, rng) {
  const list = ROLE_WEAPON[role] || ROLE_WEAPON.anchor;
  for (let i = 0; i < list.length; i++) {
    const id = list[Math.floor(rng() * list.length) % list.length];
    if (WEAPONS[id]) return WEAPONS[id];
    if (WEAPONS[list[i]]) return WEAPONS[list[i]];
  }
  return FALLBACK;
}

const _v = new THREE.Vector3();

/** Cheap approximately-normal deviate (Irwin-Hall, n=3), zero alloc. */
function gauss(rng) { return (rng() + rng() + rng() - 1.5) * 1.1547; }

export class BotWeapon {
  constructor(def, rng) {
    this.def = def || FALLBACK;
    this.rng = rng;
    this.mag = this.def.magSize ?? 30;
    this.reserve = this.def.reserve ?? 200;
    this.cooldown = 0;
    this.reloading = false;
    this.reloadTimer = 0;
    this.burstLeft = 0;
    this.burstGap = 0;
    this.shotsThisBurst = 0;
  }

  get interval() { return fireInterval(this.def); }
  get empty() { return this.mag <= 0; }
  get lowAmmo() { return this.mag <= Math.ceil((this.def.magSize ?? 30) * AI.combat.reloadAt); }

  update(dt) {
    this.cooldown -= dt;
    this.burstGap -= dt;
    if (this.reloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) this._finishReload();
    }
  }

  startReload() {
    if (this.reloading || this.reserve <= 0) return false;
    if (this.mag >= (this.def.magSize ?? 30)) return false;
    this.reloading = true;
    this.reloadTimer = this.empty
      ? (this.def.reloadEmpty ?? 3.0)
      : (this.def.reloadTactical ?? 2.3);
    this.burstLeft = 0;
    return true;
  }

  _finishReload() {
    this.reloading = false;
    const size = this.def.magSize ?? 30;
    const take = Math.min(size - this.mag, this.reserve);
    this.mag += take;
    this.reserve -= take;
    if (this.reserve <= 0) this.reserve = Math.max(60, size * 4);   // bots resupply offscreen
  }

  /** Start a burst sized by range and discipline. */
  beginBurst(distance, discipline) {
    const c = AI.combat;
    const far = Math.min(1, distance / Math.max(1, c.suppressRange));
    const span = c.burstMax - c.burstMin;
    const n = c.burstMin + Math.round(span * (1 - far * 0.75) * (0.5 + this.rng() * 0.5));
    this.burstLeft = Math.max(1, Math.min(this.def.magSize ?? 30, n));
    this.shotsThisBurst = 0;
  }

  canFire() {
    return !this.reloading && this.cooldown <= 0 && this.burstGap <= 0
      && this.burstLeft > 0 && this.mag > 0;
  }

  consume(distance, discipline) {
    this.mag--;
    this.shotsThisBurst++;
    this.cooldown = this.interval;
    this.burstLeft--;
    if (this.burstLeft <= 0 || this.mag <= 0) {
      const c = AI.combat;
      const far = Math.min(1, distance / Math.max(1, c.suppressRange));
      this.burstGap = c.burstGapMin
        + (c.burstGapMax - c.burstGapMin) * (0.25 + far * 0.75) * (0.6 + this.rng() * 0.8)
        * (1.25 - discipline * 0.5);
    }
  }

  damageAt(distance) {
    return (this.def.damage ?? 12) * falloffMul(this.def, distance);
  }
}

/**
 * Where a bot is actually pointing. Owns the lagged target estimate and the
 * wandering error, and produces a unit aim direction each tick.
 */
export class AimSolver {
  constructor(rng) {
    this.rng = rng;
    this.track = new THREE.Vector3();
    this.trackVel = new THREE.Vector3();
    this.aim = new THREE.Vector3(0, 0, -1);
    this.onTarget = 0;
    this.errX = 0; this.errY = 0;
    this.errVX = 0; this.errVY = 0;
    this.valid = false;
  }

  reset() {
    this.onTarget = 0;
    this.valid = false;
    this.errX = 0; this.errY = 0;
    this.errVX = 0; this.errVY = 0;
  }

  /** First-order lag toward the true target state. */
  observe(dt, pos, vel, latency) {
    if (!this.valid) {
      this.track.copy(pos);
      this.trackVel.copy(vel);
      this.valid = true;
      return;
    }
    const k = 1 - Math.exp(-dt / Math.max(0.02, latency));
    this.track.lerp(pos, k);
    this.trackVel.lerp(vel, k);
  }

  /**
   * @param {THREE.Vector3} eye     where the shot comes from
   * @param {number} skill          0..1 (difficulty * state modifiers)
   * @param {number} suppression    0..1, widens the cone
   * @param {THREE.Vector3} out     unit aim direction
   * @returns {THREE.Vector3} out
   */
  solve(dt, eye, skill, suppression, out, aimHeightBias = 0) {
    const c = AI.combat;
    _v.copy(this.track);
    _v.y += aimHeightBias;

    const dist = _v.distanceTo(eye);
    // Lead: latency plus a slice of flight time, scaled by how good they are.
    const leadT = c.lead * (c.leadLatency + dist / 900) * (0.6 + skill * 0.8);
    _v.addScaledVector(this.trackVel, leadT);

    out.copy(_v).sub(eye);
    const len = out.length() || 1;
    out.multiplyScalar(1 / len);

    // Converging error cone.
    this.onTarget += dt;
    const conv = Math.min(1, this.onTarget / Math.max(0.05, c.converge));
    const lateral = Math.hypot(this.trackVel.x, this.trackVel.z);
    let sigma = (c.aimErrorBase * (1 - conv) + c.aimErrorMin)
      * (1.35 - skill * 0.7)
      + lateral * c.motionError * (1.2 - skill * 0.5)
      + suppression * c.suppressError;
    // Distant targets are harder in angle terms too, but not unfairly so.
    sigma *= 1 + Math.min(0.9, dist / 220);

    // Ornstein-Uhlenbeck drift: unit variance, ~0.32 s correlation time. The
    // exact discretisation matters — a naive damped random walk settles to a
    // stationary spread orders of magnitude smaller than intended, and a bot
    // whose aim error is numerically zero is just an aimbot with a cone drawn
    // around it.
    const tau = AI.combat.wanderTau ?? 0.32;
    const a = Math.exp(-dt / tau);
    const s = Math.sqrt(Math.max(0, 1 - a * a));
    this.errX = this.errX * a + gauss(this.rng) * s;
    this.errY = this.errY * a + gauss(this.rng) * s;
    const ex = Math.max(-2.2, Math.min(2.2, this.errX)) * sigma;
    const ey = Math.max(-2.2, Math.min(2.2, this.errY)) * sigma * 0.75;

    // Offset in the plane perpendicular to the aim.
    _v.set(-out.z, 0, out.x);
    if (_v.lengthSq() < 1e-6) _v.set(1, 0, 0);
    _v.normalize();
    out.x += _v.x * ex; out.z += _v.z * ex;
    out.y += ey;
    out.normalize();
    return out;
  }
}

export default BotWeapon;
