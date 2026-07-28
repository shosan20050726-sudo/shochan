import * as THREE from 'three';
import { EV } from '../core/EventBus.js';
import AI from './AIConfig.js';
import { Mover } from './Mover.js';
import { Gait } from './Locomotion.js';
import { BotWeapon, AimSolver, pickWeapon } from './Combat.js';
import { JOINT_COUNT } from './Skeleton.js';
import { PART, partMultiplier } from './Hitboxes.js';
import CFG from '../core/Config.js';

/**
 * One enemy.
 *
 * Split of responsibilities:
 *   fixedUpdate  — steering, physics, trigger discipline (deterministic, 120 Hz)
 *   think        — goal selection, called by the scheduler at a few Hz
 *   sense        — vision cone + one LOS ray, also scheduled
 *   animate      — render-rate procedural locomotion and pose write
 *
 * The bot never queries the world every tick. Everything expensive is pulled
 * through the scheduler, and everything cheap is a couple of dot products.
 */

export const STATE = {
  IDLE: 'idle', PATROL: 'patrol', ADVANCE: 'advance', ENGAGE: 'engage',
  SUPPRESS: 'suppress', FLANK: 'flank', PUSH: 'push', RETREAT: 'retreat',
  REVIVE: 'revive', DOWNED: 'downed', DEAD: 'dead',
};

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _ZERO = new THREE.Vector3();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const angleWrap = (a) => (a > Math.PI ? a - Math.PI * 2 : a < -Math.PI ? a + Math.PI * 2 : a);

let NEXT_ID = 1;

export class Bot {
  constructor(W, slot, squad, role) {
    this.W = W;
    this.slot = slot;
    this.squad = squad;
    this.role = role;
    this.id = `bot_${NEXT_ID++}`;
    this.name = null;
    this.rng = W.rng;

    this.pose = new Float32Array(JOINT_COUNT * 3);
    this.mover = new Mover(W.collision);
    this.gait = new Gait(W.rng);
    this.aimer = new AimSolver(W.rng);
    this.weapon = new BotWeapon(pickWeapon(role, W.rng), W.rng);

    this.active = false;
    this.state = STATE.IDLE;
    this.stateTime = 0;
    this.yaw = 0;
    this.aim = new THREE.Vector3(0, 0, -1);
    this.eye = new THREE.Vector3();
    this.ready = 0.2;                       // weapon raise, 0 slung .. 1 shouldered
    // The rig stands ~1.71 m to the top of the helmet; this spreads the squad
    // over a believable 1.71–1.88 m range against the 1.82 m player capsule.
    this.scale = 1.0 + W.rng() * 0.10;

    this.health = AI.health;
    this.shield = AI.shield;
    this.downed = false;
    this.dead = true;
    this.bleed = 0;
    this.reviveT = 0;
    this.reviverId = null;

    // --- perception ---------------------------------------------------
    this.awareness = 0;
    this.visible = false;
    this.lastSeen = -999;
    this.lastKnown = new THREE.Vector3();
    this.hasContact = false;
    this.reaction = 0;
    this.suppressed = 0;
    this.losAge = 999;

    // --- navigation ---------------------------------------------------
    this.path = new Float32Array(48);
    this.pathLen = 0;
    this.pathAt = 0;
    this.goal = new THREE.Vector3();
    this.hasGoal = false;
    this.repath = 0;
    this.stuck = 0;
    this.lane = (W.rng() * 2 - 1) * AI.move.laneSpread;
    this.wantCrouch = false;
    this.strafeDir = W.rng() < 0.5 ? -1 : 1;
    this.strafeT = 0;

    this.order = { type: STATE.PATROL, x: 0, z: 0, valid: false, aggression: 0.5 };
    this._coverT = 0;
    /** Screenshot/showcase hold: animate but do not act. */
    this.frozen = false;
    this.showcaseWalk = null;
  }

  get position() { return this.mover.position; }
  get alive() { return this.active && !this.dead; }
  get combatReady() { return this.alive && !this.downed; }

  /** Strength contribution to the squad, 0..1. */
  get strength() {
    if (!this.alive) return 0;
    if (this.downed) return 0.12;
    return 0.35 + 0.65 * clamp((this.health + this.shield) / (AI.health + AI.shield), 0, 1);
  }

  /* ================================================================== */
  /* lifecycle                                                           */
  /* ================================================================== */

  spawn(x, y, z, yaw) {
    this.mover.teleport(x, y, z);
    this.yaw = yaw;
    this.aim.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    this.gait.reset(this.mover.position.x, this.mover.position.y, this.mover.position.z, yaw);
    this.health = AI.health;
    this.shield = AI.shield;
    this.downed = false;
    this.dead = false;
    this.active = true;
    this.bleed = 0;
    this.reviveT = 0;
    this.awareness = 0;
    this.hasContact = false;
    this.visible = false;
    this.lastSeen = -999;
    this.pathLen = 0;
    this.hasGoal = false;
    this.state = STATE.PATROL;
    this.stateTime = 0;
    this.ready = 0.25;
    this.frozen = false;
    this.showcaseWalk = null;
    this.wantCrouch = false;
    this.suppressed = 0;
    this.reaction = 0;
    this._coverT = 0;
    this.order.valid = false;
    this.weapon.mag = this.weapon.def.magSize ?? 30;
    this.weapon.reloading = false;
    this.weapon.burstLeft = 0;
    this.aimer.reset();
    this.animate(0.016);
    return this;
  }

  despawn() {
    this.active = false;
    this.dead = true;
    this.state = STATE.DEAD;
  }

  /* ================================================================== */
  /* damage                                                              */
  /* ================================================================== */

  /**
   * @returns {{killed:boolean, downed:boolean, applied:number, shield:number}}
   */
  applyDamage(amount, part, point, byPlayer) {
    const out = { killed: false, downed: false, applied: 0, shield: 0 };
    if (!this.alive) return out;

    const mul = partMultiplier(part, CFG.combat);
    let dmg = amount * mul;
    out.applied = dmg;

    this.gait.addFlinch(clamp(dmg / 45, 0.05, 0.6));
    this.suppressed = Math.max(this.suppressed, AI.combat.suppressedTime);

    if (this.downed) {
      this.health -= dmg;
      if (this.health <= 0) { out.killed = true; this._die(); }
      return out;
    }

    if (this.shield > 0) {
      const s = Math.min(this.shield, dmg);
      this.shield -= s;
      dmg -= s;
      out.shield = s;
    }
    this.health -= dmg;

    // Being shot at from an unknown direction is itself information.
    if (point && !this.hasContact) {
      this.lastKnown.copy(point);
      this.awareness = Math.max(this.awareness, AI.vision.confirm * 0.75);
    }

    if (this.health <= 0) {
      // A big enough hit skips the knock entirely.
      if (dmg > AI.health * 0.9 || part === PART.HEAD) { out.killed = true; this._die(); }
      else { out.downed = true; this._goDown(); }
    }
    return out;
  }

  _goDown() {
    this.downed = true;
    this.health = AI.downedHealth;
    this.bleed = AI.bleedTime;
    this.state = STATE.DOWNED;
    this.stateTime = 0;
    this.weapon.burstLeft = 0;
    this.pathLen = 0;
    this.reviveT = 0;
  }

  _die() {
    this.dead = true;
    this.active = false;
    this.downed = false;
    this.state = STATE.DEAD;
    this.pathLen = 0;
    this.hasContact = false;
  }

  reviveBy(other) {
    this.downed = false;
    this.health = Math.max(35, AI.health * 0.4);
    this.shield = 0;
    this.bleed = 0;
    this.state = STATE.ADVANCE;
    this.reviveT = 0;
    this.reviverId = null;
  }

  /* ================================================================== */
  /* perception (scheduled)                                              */
  /* ================================================================== */

  /**
   * One vision update. Costs at most a single raycast, and only when the
   * target is inside the cone — the cheap tests gate the expensive one.
   */
  sense(dt) {
    const W = this.W;
    const t = W.time;
    this.losAge = 0;
    if (!this.combatReady || !W.player.alive) { this._decay(dt); return; }

    _v.copy(W.player.eye);
    this.eyePosition(_eye);
    _dir.copy(_v).sub(_eye);
    const dist = _dir.length();
    if (dist > AI.vision.range) { this._decay(dt); return; }
    _dir.multiplyScalar(1 / Math.max(dist, 1e-4));

    // Facing test: full cone up close, narrower at range.
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const cosA = fx * _dir.x + fz * _dir.z;
    const halfFov = Math.cos((dist < AI.vision.peripheralRange
      ? AI.vision.peripheralFov : AI.vision.fov) * 0.5);
    if (cosA < halfFov) { this._decay(dt); return; }

    const clear = W.losRay(_eye, _dir, dist - 0.35, this.id);
    if (!clear) { this._decay(dt); return; }

    // Visible. Awareness climbs faster when the target is close and moving.
    const near = 1 - clamp((dist / AI.vision.range - AI.vision.falloffStart)
      / (1 - AI.vision.falloffStart), 0, 1);
    const motion = clamp(W.player.speed / (CFG.move?.sprintSpeed ?? 6.9), 0, 1) * AI.vision.motionBonus;
    const stance = W.player.crouch ? AI.vision.crouchPenalty : 1;
    const rate = AI.vision.gain * (0.25 + near * 0.75) * (1 + motion) * stance;

    this.awareness = Math.min(AI.vision.confirm * 1.6, this.awareness + rate * dt);
    this.visible = true;
    this.lastSeen = t;
    this.lastKnown.copy(W.player.position);

    if (this.awareness >= AI.vision.confirm && !this.hasContact) {
      this.hasContact = true;
      this.reaction = AI.reaction.min
        + (AI.reaction.max - AI.reaction.min) * (1 - AI.difficulty) * (0.5 + this.rng());
      this.squad?.reportContact(W.player.position, t, this);
    }
  }

  _decay(dt) {
    this.visible = false;
    this.awareness = Math.max(0, this.awareness - AI.vision.decay * dt);
    if (this.hasContact && this.W.time - this.lastSeen > AI.vision.memory) {
      this.hasContact = false;
      this.aimer.reset();
    }
  }

  /** Sound contact. `error` blurs the reported position. */
  hear(x, y, z, loudness) {
    if (!this.combatReady) return;
    const p = this.mover.position;
    const d = Math.hypot(p.x - x, p.z - z);
    const radius = loudness * (AI.hearing.occlusion + 0.45);
    if (d > radius) return;
    const k = 1 - d / Math.max(radius, 1e-3);
    const err = AI.hearing.error * (1 - k);
    this.lastKnown.set(
      x + (this.rng() * 2 - 1) * err,
      y,
      z + (this.rng() * 2 - 1) * err);
    this.awareness = Math.min(AI.vision.confirm * 1.2, this.awareness + 0.45 + k * 0.65);
    if (this.awareness >= AI.vision.confirm && !this.hasContact) {
      this.hasContact = true;
      this.lastSeen = this.W.time - 0.5;
      this.reaction = AI.reaction.min + AI.reaction.audio
        + (AI.reaction.max - AI.reaction.min) * (1 - AI.difficulty) * this.rng();
      this.squad?.reportContact(this.lastKnown, this.W.time, this);
    }
  }

  eyePosition(out) {
    const p = this.mover.position;
    // Matches the rig: standing head 1.55, crouched 1.27, downed ~0.8.
    const h = this.downed ? 0.80 : (this.wantCrouch ? 1.30 : 1.60);
    return out.set(p.x, p.y + h * this.scale, p.z);
  }

  /* ================================================================== */
  /* decision (scheduled, a few Hz)                                      */
  /* ================================================================== */

  think() {
    if (!this.alive) return;
    const W = this.W;

    if (this.downed) {
      this.state = STATE.DOWNED;
      return;
    }

    const o = this.order;
    const contact = this.hasContact && (W.time - this.lastSeen) < AI.squad.contactMemory;
    const dist = contact ? this.mover.position.distanceTo(this.lastKnown) : Infinity;

    let next = o.valid ? o.type : STATE.PATROL;

    if (contact) {
      if (o.type === STATE.RETREAT) next = STATE.RETREAT;
      else if (o.type === STATE.REVIVE) next = STATE.REVIVE;
      else if (o.type === STATE.FLANK && dist > AI.combat.minRange * 1.5) next = STATE.FLANK;
      else if (o.type === STATE.PUSH) next = STATE.PUSH;
      else if (this.visible && dist < AI.combat.maxEngage) next = STATE.ENGAGE;
      else if (dist < AI.combat.suppressRange) next = STATE.SUPPRESS;
      else next = STATE.ADVANCE;
    } else if (o.type === STATE.REVIVE) {
      next = STATE.REVIVE;
    }

    if (next !== this.state) { this.state = next; this.stateTime = 0; }

    // --- goal selection ---------------------------------------------------
    switch (this.state) {
      case STATE.ENGAGE:
        // Hold the assigned firing position; only shuffle if it went bad.
        if (o.valid) this._setGoal(o.x, o.z);
        else this._holdGround(dist);
        break;
      case STATE.SUPPRESS:
      case STATE.ADVANCE:
      case STATE.FLANK:
      case STATE.PUSH:
      case STATE.RETREAT:
      case STATE.REVIVE:
        if (o.valid) this._setGoal(o.x, o.z);
        else if (contact) this._setGoal(this.lastKnown.x, this.lastKnown.z);
        break;
      default:
        if (o.valid) this._setGoal(o.x, o.z);
        else this._wander();
        break;
    }

    // Crouch behind cover when holding a firing position under fire.
    this.wantCrouch = (this.state === STATE.ENGAGE || this.state === STATE.SUPPRESS)
      && this.suppressed > 0.05 && this._nearGoal(1.6);

    this.ready = (contact || this.awareness > 0.25) ? 1 : 0.18;
  }

  _holdGround(dist) {
    const ideal = AI.combat.idealRange;
    if (dist > ideal * 1.6 || dist < AI.combat.minRange) {
      _v.copy(this.lastKnown).sub(this.mover.position);
      _v.y = 0;
      const l = _v.length() || 1;
      _v.multiplyScalar(1 / l);
      const target = dist < AI.combat.minRange ? -ideal * 0.6 : (dist - ideal);
      this._setGoal(
        this.mover.position.x + _v.x * target,
        this.mover.position.z + _v.z * target);
    } else {
      this.hasGoal = false;
      this.pathLen = 0;
    }
  }

  _wander() {
    if (this.hasGoal && !this._nearGoal(2.2) && this.stateTime < 12) return;
    const nav = this.W.nav;
    const anchor = this.squad?.anchor || this.mover.position;
    for (let i = 0; i < 6; i++) {
      const a = this.rng() * Math.PI * 2;
      const r = 8 + this.rng() * 26;
      const x = anchor.x + Math.cos(a) * r;
      const z = anchor.z + Math.sin(a) * r;
      if (!nav || nav.walkable(x, z)) { this._setGoal(x, z); return; }
    }
    this.hasGoal = false;
  }

  _setGoal(x, z) {
    if (this.hasGoal && Math.hypot(this.goal.x - x, this.goal.z - z) < AI.nav.goalDrift * 0.4) return;
    this.goal.set(x, this.mover.position.y, z);
    this.hasGoal = true;
    this.repath = 0;          // ask the scheduler for a path
  }

  _nearGoal(r) {
    if (!this.hasGoal) return true;
    const p = this.mover.position;
    return Math.hypot(p.x - this.goal.x, p.z - this.goal.z) < r;
  }

  /** Called by the scheduler when this bot wins the pathfinding slot. */
  buildPath() {
    this.repath = AI.nav.repath * (0.75 + this.rng() * 0.5);
    if (!this.hasGoal || !this.W.nav?.ready) { this.pathLen = 0; return; }
    const p = this.mover.position;
    const n = this.W.nav.findPath(p.x, p.z, this.goal.x, this.goal.z, this.path, 24);
    this.pathLen = n;
    this.pathAt = n > 1 ? 1 : 0;
    if (n === 0) {
      // No route: head straight at it and let collision sort it out.
      this.path[0] = this.goal.x; this.path[1] = this.goal.z;
      this.pathLen = 1; this.pathAt = 0;
    }
  }

  /* ================================================================== */
  /* simulation                                                          */
  /* ================================================================== */

  fixedUpdate(dt) {
    if (!this.active) return;
    this.stateTime += dt;
    this.losAge += dt;
    this.suppressed = Math.max(0, this.suppressed - dt);
    this.reaction = Math.max(0, this.reaction - dt);
    this.repath -= dt;
    this.weapon.update(dt);

    if (this.dead) return;

    if (this.downed) {
      this._downedTick(dt);
      return;
    }

    this._steer(dt);
    this._aim(dt);
    this._trigger(dt);
  }

  _downedTick(dt) {
    this.bleed -= dt;
    if (this.bleed <= 0) { this._die(); this.W.onKilled(this, null, false); return; }
    // Crawl slowly away from the last known threat.
    let wx = 0, wz = 0;
    if (this.hasContact) {
      _v.copy(this.mover.position).sub(this.lastKnown);
      _v.y = 0;
      const l = _v.length();
      if (l > 0.1) { wx = (_v.x / l) * AI.move.crawl; wz = (_v.z / l) * AI.move.crawl; }
    }
    this.mover.move(dt, wx, wz, AI.move.crouchHeight * 0.7);
    const want = Math.atan2(-wx, -wz);
    if (wx || wz) this.yaw += angleWrap(want - this.yaw) * Math.min(1, dt * 2.2);
    this.aim.set(-Math.sin(this.yaw), -0.35, -Math.cos(this.yaw)).normalize();
  }

  /* ------------------------------------------------------ steering ---- */

  _steer(dt) {
    const M = AI.move;
    const p = this.mover.position;
    let wx = 0, wz = 0;
    let speed = M.walk;

    const contact = this.hasContact;
    const engaging = this.state === STATE.ENGAGE || this.state === STATE.SUPPRESS;

    // --- follow the path -------------------------------------------------
    if (this.pathLen > 0) {
      // Advance through waypoints we have effectively reached.
      while (this.pathAt < this.pathLen - 1) {
        const wxp = this.path[this.pathAt * 2], wzp = this.path[this.pathAt * 2 + 1];
        if (Math.hypot(p.x - wxp, p.z - wzp) > M.arrive) break;
        this.pathAt++;
      }
      const tx = this.path[this.pathAt * 2], tz = this.path[this.pathAt * 2 + 1];
      _dir.set(tx - p.x, 0, tz - p.z);
      const d = _dir.length();
      if (d > 1e-3) {
        _dir.multiplyScalar(1 / d);
        // Lane offset keeps a squad from walking single file down one line.
        const last = this.pathAt >= this.pathLen - 1;
        const lane = last ? 0 : this.lane;
        wx = _dir.x + (-_dir.z) * lane * 0.35;
        wz = _dir.z + (_dir.x) * lane * 0.35;
        const l = Math.hypot(wx, wz) || 1;
        wx /= l; wz /= l;
      }
      const remaining = this._goalDistance();
      if (remaining <= M.arrive * 0.9) this.pathLen = 0;
      speed = this._travelSpeed(remaining);
    } else if (this.hasGoal && !this._nearGoal(M.arrive)) {
      _dir.set(this.goal.x - p.x, 0, this.goal.z - p.z);
      const d = _dir.length() || 1;
      wx = _dir.x / d; wz = _dir.z / d;
      speed = this._travelSpeed(d);
    }

    // --- combat strafing --------------------------------------------------
    if (engaging && contact && this._nearGoal(2.4)) {
      this.strafeT -= dt;
      if (this.strafeT <= 0) {
        this.strafeT = 0.7 + this.rng() * 1.6;
        this.strafeDir = this.rng() < 0.5 ? -1 : 1;
      }
      _dir.set(this.lastKnown.x - p.x, 0, this.lastKnown.z - p.z);
      const d = _dir.length() || 1;
      _dir.multiplyScalar(1 / d);
      const amt = this.suppressed > 0.05 ? 0.85 : 0.5;
      wx += -_dir.z * this.strafeDir * amt;
      wz += _dir.x * this.strafeDir * amt;
      speed = Math.max(speed, M.strafe * (0.55 + 0.45 * amt));
    }

    // --- separation from squadmates --------------------------------------
    const bots = this.W.bots;
    for (let i = 0; i < bots.length; i++) {
      const o = bots[i];
      if (o === this || !o.alive) continue;
      const dx = p.x - o.mover.position.x, dz = p.z - o.mover.position.z;
      const d2 = dx * dx + dz * dz;
      const r = M.separationRadius;
      if (d2 > r * r || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const k = (1 - d / r) * M.separation;
      wx += (dx / d) * k;
      wz += (dz / d) * k;
    }

    // --- stuck recovery ----------------------------------------------------
    if (this.mover.blocked > 0.55 && (Math.abs(wx) + Math.abs(wz)) > 0.05) {
      this.stuck += dt;
      if (this.stuck > AI.nav.stuckTime * 0.4) {
        // Slide along the obstruction rather than grinding into it.
        const s = this.strafeDir;
        const nx = -wz * s, nz = wx * s;
        wx = wx * 0.35 + nx * 0.9;
        wz = wz * 0.35 + nz * 0.9;
      }
      if (this.stuck > AI.nav.stuckTime) {
        this.stuck = 0;
        this.strafeDir = -this.strafeDir;
        this.repath = 0;
        this.mover.hop();
      }
    } else {
      this.stuck = Math.max(0, this.stuck - dt * 2);
    }

    const wl = Math.hypot(wx, wz);
    if (wl > 1e-4) { wx /= wl; wz /= wl; } else { wx = 0; wz = 0; }

    if (this.wantCrouch) speed = Math.min(speed, M.crouch);
    const height = this.wantCrouch ? AI.move.crouchHeight : AI.move.height;
    this.mover.move(dt, wx * speed, wz * speed, height * this.scale);

    // --- facing -------------------------------------------------------------
    let wantYaw = this.yaw;
    if (contact && (engaging || this.state === STATE.PUSH || this.state === STATE.ENGAGE)) {
      wantYaw = Math.atan2(-(this.lastKnown.x - p.x), -(this.lastKnown.z - p.z));
    } else if (wl > 1e-4) {
      wantYaw = Math.atan2(-wx, -wz);
    } else if (contact) {
      wantYaw = Math.atan2(-(this.lastKnown.x - p.x), -(this.lastKnown.z - p.z));
    }
    const turn = (this.hasContact && this.reaction > 0)
      ? AI.reaction.turnAcquire : AI.move.turnRate;
    this.yaw += angleWrap(wantYaw - this.yaw) * Math.min(1, dt * turn);
    this.yaw = angleWrap(this.yaw);
  }

  _goalDistance() {
    if (!this.hasGoal) return 0;
    const p = this.mover.position;
    return Math.hypot(p.x - this.goal.x, p.z - this.goal.z);
  }

  _travelSpeed(remaining) {
    const M = AI.move;
    const urgent = this.state === STATE.PUSH || this.state === STATE.FLANK
      || this.state === STATE.RETREAT || this.state === STATE.REVIVE
      || (this.hasContact && this.state === STATE.ADVANCE);
    let s = urgent ? M.run : M.walk;
    if (this.state === STATE.PATROL) s = M.walk * 0.72;
    // Ease in to the goal so they do not overshoot and jitter.
    if (remaining < 2.5) s *= clamp(remaining / 2.5, 0.25, 1);
    return s;
  }

  /* ---------------------------------------------------------- aim ----- */

  _aim(dt) {
    const W = this.W;
    this.eyePosition(_eye);

    if (this.hasContact && W.player.alive) {
      const latency = AI.reaction.min + (1 - AI.difficulty) * 0.18
        + (this.visible ? 0 : 0.35);
      _v.copy(this.visible ? W.player.position : this.lastKnown);
      _v2.copy(this.visible ? W.player.velocity : _ZERO);
      this.aimer.observe(dt, _v, _v2, latency);
      const skill = clamp(AI.difficulty * (this.visible ? 1 : 0.7)
        * (this.suppressed > 0 ? 0.72 : 1), 0, 1);
      const bias = W.player.crouch ? 0.55 : 0.95;   // aim at the chest, not the feet
      this.aimer.solve(dt, _eye, skill, this.suppressed > 0 ? 1 : 0, this.aim, bias);
    } else {
      // Idle: look where we walk, muzzle a little low.
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      _dir.set(fx, -0.12 - (1 - this.ready) * 0.18, fz).normalize();
      this.aim.lerp(_dir, Math.min(1, dt * 4));
      this.aim.normalize();
      this.aimer.onTarget = 0;
    }
  }

  /* -------------------------------------------------------- trigger --- */

  _trigger(dt) {
    const W = this.W;
    if (!this.hasContact || this.reaction > 0 || !W.player.alive) return;
    if (this.state === STATE.RETREAT && !this.visible) return;
    if (this.state === STATE.REVIVE) return;

    const w = this.weapon;
    if (w.reloading) return;
    if (w.empty || (w.lowAmmo && w.burstLeft <= 0 && !this.visible)) { w.startReload(); return; }

    if (!this.aimer.valid) return;
    const dist = this.mover.position.distanceTo(this.lastKnown);
    if (dist > Math.min(w.def.maxRange ?? 500, AI.combat.maxEngage)) return;

    const suppressing = !this.visible;
    if (suppressing && (dist > AI.combat.suppressRange || this.W.time - this.lastSeen > 4.5)) return;

    // Only shoot once actually pointing near the target.
    this.eyePosition(_eye);
    _dir.copy(this.aimer.track).sub(_eye);
    const d = _dir.length() || 1;
    _dir.multiplyScalar(1 / d);
    const align = _dir.dot(this.aim);
    if (align < (suppressing ? 0.985 : 0.9955)) return;

    if (w.burstLeft <= 0) {
      if (w.burstGap > 0) return;
      w.beginBurst(dist, AI.difficulty);
    }
    if (!w.canFire()) return;

    w.consume(dist, AI.difficulty);
    this.gait.addRecoil(0.35);
    W.onBotFire(this, dist, suppressing);
  }

  /* ================================================================== */
  /* animation + pose                                                    */
  /* ================================================================== */

  animate(dt) {
    if (!this.active) return;
    const p = this.mover.position;
    const s = this._animState ||= {
      x: 0, y: 0, z: 0, yaw: 0, speed: 0, crouch: false, downed: false,
      ready: 1, aimX: 0, aimY: 0, aimZ: -1, groundAt: null,
    };
    s.x = p.x; s.y = p.y; s.z = p.z;
    s.yaw = this.yaw;
    s.speed = this.mover.speed;
    s.crouch = this.wantCrouch;
    s.downed = this.downed;
    s.ready = this.ready;
    s.aimX = this.aim.x; s.aimY = this.aim.y; s.aimZ = this.aim.z;
    s.groundAt = this.W.groundAt;

    const before0 = this.gait.foot[0].planted, before1 = this.gait.foot[1].planted;
    this.gait.update(dt > 0 ? Math.min(dt, 0.05) : 0, s, this.pose);
    if (this.scale !== 1) this._applyScale();

    // Footsteps come from the actual plant, so they always match the stride.
    if (!this.downed && this.mover.onGround && this.mover.speed > 0.8) {
      if ((!before0 && this.gait.foot[0].planted) || (!before1 && this.gait.foot[1].planted)) {
        this.W.onFootstep(this);
      }
    }
  }

  /** Uniform body scale about the feet, applied to the finished pose. */
  _applyScale() {
    const p = this.mover.position;
    const s = this.scale;
    const pose = this.pose;
    for (let i = 0; i < JOINT_COUNT; i++) {
      const o = i * 3;
      pose[o] = p.x + (pose[o] - p.x) * s;
      pose[o + 1] = p.y + (pose[o + 1] - p.y) * s;
      pose[o + 2] = p.z + (pose[o + 2] - p.z) * s;
    }
    this.gait.gunPos.set(
      p.x + (this.gait.gunPos.x - p.x) * s,
      p.y + (this.gait.gunPos.y - p.y) * s,
      p.z + (this.gait.gunPos.z - p.z) * s);
    this.gait.muzzle.set(
      p.x + (this.gait.muzzle.x - p.x) * s,
      p.y + (this.gait.muzzle.y - p.y) * s,
      p.z + (this.gait.muzzle.z - p.z) * s);
  }
}

export default Bot;
