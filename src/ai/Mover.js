import * as THREE from 'three';
import { MoveResult } from '../physics/CollisionWorld.js';
import AI from './AIConfig.js';

/**
 * Capsule character controller for bots.
 *
 * Reuses the shared CollisionWorld rather than inventing a second notion of
 * "solid": same BVH, same slide/step semantics as the player, so a bot can
 * physically go anywhere the player can and nowhere they cannot. Stepping and
 * falling are handled here; steering is not — the bot hands this a desired
 * horizontal velocity and it does the physics.
 */

const _delta = new THREE.Vector3();
const _start = new THREE.Vector3();
const _step = new THREE.Vector3();
const _probe = new THREE.Vector3();

export class Mover {
  constructor(collision) {
    this.collision = collision;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.onGround = false;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.groundSurface = 'concrete';
    this.height = AI.move.height;
    this.radius = AI.move.radius;
    this.airTime = 0;
    this.landImpact = 0;
    this.blocked = 0;               // 0..1, how much of the last move was eaten
    this._res = new MoveResult();
    this._stepRes = new MoveResult();
    this._probeRes = new MoveResult();
  }

  get speed() { return Math.hypot(this.velocity.x, this.velocity.z); }

  teleport(x, y, z) {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.onGround = false;
    this.airTime = 0;
    const c = this.collision;
    if (c?.ready) {
      const g = c.raycastRef(x, y + 6, z, 0, -1, 0, 60);
      if (g) this.position.y = g.py + 0.02;
      c.resolve(this.position, this.radius, this.height);
    }
  }

  /**
   * @param {number} dt
   * @param {number} wx desired horizontal velocity x
   * @param {number} wz desired horizontal velocity z
   * @param {number} height current capsule height (crouch shrinks it)
   */
  move(dt, wx, wz, height) {
    const c = this.collision;
    this.height = height;
    const wasGround = this.onGround;

    // Horizontal: accelerate toward the wish velocity, decelerate when idle.
    const dvx = wx - this.velocity.x, dvz = wz - this.velocity.z;
    const want = Math.hypot(wx, wz);
    const rate = (want > 0.05 ? AI.move.accel : AI.move.decel) * dt;
    const dl = Math.hypot(dvx, dvz);
    if (dl > 1e-5) {
      const k = Math.min(1, rate / dl);
      this.velocity.x += dvx * k;
      this.velocity.z += dvz * k;
    }

    if (this.onGround) {
      if (this.velocity.y < 0) this.velocity.y = 0;
    } else {
      this.velocity.y -= AI.move.gravity * dt;
      if (this.velocity.y < -70) this.velocity.y = -70;
    }

    if (!c?.ready) {
      this.position.addScaledVector(this.velocity, dt);
      this.onGround = true;
      this.velocity.y = 0;
      return;
    }

    _start.copy(this.position);
    _delta.copy(this.velocity).multiplyScalar(dt);
    const wantH = Math.hypot(_delta.x, _delta.z);

    c.translate(this.position, _delta, this.radius, this.height, this._res);
    this._res.clip(this.velocity);

    const gotH = Math.hypot(this.position.x - _start.x, this.position.z - _start.z);
    this.blocked = wantH > 1e-4 ? Math.max(0, 1 - gotH / wantH) : 0;

    // Step up — same up/forward/down probe the player controller uses.
    if (this.blocked > 0.25 && (wasGround || this.onGround) && this.velocity.y < 2) {
      this._tryStep(_start, _delta);
    }

    // Ground probe / snap.
    const preVy = this.velocity.y;
    let grounded = false;
    if (preVy <= 0.6) {
      const drop = wasGround ? Math.max(0.10, AI.move.stepHeight) : 0.10;
      _probe.copy(this.position);
      const found = c.probeGround(_probe, this.radius, this.height, drop, this._probeRes);
      if (found && this._probeRes.groundY >= (c.walkableY ?? 0.7)) {
        grounded = true;
        this.groundNormal.copy(this._probeRes.groundNormal);
        this.groundSurface = this._probeRes.groundSurface;
        this.position.y = _probe.y;
      }
    }
    if (!grounded && this._res.groundY >= (c.walkableY ?? 0.7) && preVy <= 0.1) {
      grounded = true;
      this.groundNormal.copy(this._res.groundNormal);
      this.groundSurface = this._res.groundSurface;
    }

    this.landImpact = 0;
    if (grounded) {
      if (!wasGround) this.landImpact = Math.max(0, -preVy);
      this.airTime = 0;
      if (this.velocity.y < 0) this.velocity.y = 0;
    } else {
      this.airTime += dt;
    }
    this.onGround = grounded;

    // Never let a bot fall out of the world.
    if (this.position.y < -180) this.velocity.set(0, 0, 0);
  }

  _tryStep(startPos, delta) {
    const c = this.collision;
    const h = this.height, r = this.radius;
    _probe.copy(startPos);
    _step.set(0, AI.move.stepHeight, 0);
    c.translate(_probe, _step, r, h, this._stepRes);
    const rose = _probe.y - startPos.y;
    if (rose < 0.03) return false;
    _step.set(delta.x, 0, delta.z);
    c.translate(_probe, _step, r, h, this._stepRes);
    const landed = c.probeGround(_probe, r, h, rose + 0.04, this._stepRes);
    if (!landed || this._stepRes.groundY < (c.walkableY ?? 0.7)) return false;
    const rise = _probe.y - this.position.y;
    if (rise > AI.move.stepHeight + 0.06 || rise < -0.02) return false;
    const gained = Math.hypot(_probe.x - this.position.x, _probe.z - this.position.z);
    if (gained < 0.004 && rise <= 0.02) return false;
    this.position.copy(_probe);
    this.onGround = true;
    this.groundNormal.copy(this._stepRes.groundNormal);
    this.groundSurface = this._stepRes.groundSurface;
    return true;
  }

  /** Vertical hop, used to clear low rails and to break out of a stuck pocket. */
  hop(v = 5.4) {
    if (!this.onGround) return false;
    this.velocity.y = v;
    this.onGround = false;
    this.airTime = 0;
    return true;
  }
}

export default Mover;
