/**
 * PlayerSystem — Apex-style momentum movement.
 *
 * Design notes, because the feel here is the whole point:
 *
 *  - Source-engine acceleration model. Ground movement uses friction +
 *    `accelerate()`; air movement uses the classic capped-wishspeed
 *    `airAccelerate()` so steering mid-air *gains* speed. Friction is skipped
 *    on the tick you jump, which is what makes bunnyhopping preserve speed.
 *  - Slide is the signature move: a sprint entry gives an impulse, gravity is
 *    projected along the ground plane so downhill slides accelerate, and flat
 *    slides bleed linearly. Slide -> jump -> air-strafe -> slide is the loop
 *    the whole game is built around, so the slide never eats your momentum.
 *  - Wall-bounce redirects the momentum you arrived with (captured *before*
 *    the collision clipped it) outward + up, blended toward where you are
 *    looking. That's the skill expression.
 *  - Everything integrates in fixedUpdate at 1/120. `update()` only does mouse
 *    look, interpolation and procedural camera smoothing.
 *
 * The capsule is FEET-anchored: `position` is the point where the bottom of
 * the capsule touches the floor, so crouching lowers your head rather than
 * sinking you into the ground.
 *
 * Other systems can reuse the physics:
 *   const p = ctx.engine.get('player');
 *   p.collision.raycast(o, d, 50);   p.projectiles.spawn({...});   p.ragdolls.spawn(v);
 */
import * as THREE from 'three';
import CFG from '../core/Config.js';
import { EV } from '../core/EventBus.js';
import { ACTION } from '../core/Input.js';
import { CollisionWorld, MoveResult } from './CollisionWorld.js';
import CameraRig from './CameraRig.js';
import ProjectileWorld from './Projectiles.js';
import { RagdollWorld } from './Ragdoll.js';

/* ---- module scratch: nothing in the tick allocates ---- */
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _slope = new THREE.Vector3();
const _startPos = new THREE.Vector3();
const _stepPos = new THREE.Vector3();
const _probePos = new THREE.Vector3();
const _preVel = new THREE.Vector3();
const _lerpPos = new THREE.Vector3();
const _target = new THREE.Vector3();
const _dirFlat = new THREE.Vector3();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const smootherstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (t * (t * 6 - 15) + 10));

export default class PlayerSystem {
  name = 'player';
  priority = 20;

  constructor() {
    // --- public state ---------------------------------------------------
    this.enabled = true;
    this.position = new THREE.Vector3(0, 2, 0);     // feet
    this.prevPosition = new THREE.Vector3(0, 2, 0);
    this.velocity = new THREE.Vector3();
    this.eyePosition = new THREE.Vector3(0, 3.7, 0);
    this.onGround = false;
    this.isSliding = false;
    this.isSprinting = false;
    this.isCrouching = false;
    this.isMantling = false;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.groundSurface = 'concrete';
    this.airTime = 0;

    // --- services -------------------------------------------------------
    this.collision = new CollisionWorld();
    this.collision.walkableY = Math.cos(CFG.move.player.maxSlopeAngle);
    this.collision.wallDot = CFG.move.wallBounce.maxWallAngle ?? 0.62;
    this.rig = new CameraRig();
    this.projectiles = new ProjectileWorld(this.collision, null);
    this.ragdolls = new RagdollWorld(this.collision);

    // --- internals ------------------------------------------------------
    this.capsuleHeight = CFG.move.player.height;
    this._targetHeight = CFG.move.player.height;
    this.moveRes = new MoveResult();
    this._probeRes = new MoveResult();
    this._stepRes = new MoveResult();

    this.moveX = 0; this.moveZ = 0;
    this.wishActive = false;
    this.jumpHeld = false; this.crouchHeld = false; this.sprintHeld = false;
    this._prevCrouch = false;

    this.coyote = 0;
    this.jumpBuffer = 0;
    this._justJumped = 0;
    this._preMoveVelY = 0;

    this.slideTime = 0;
    this.slideCooldown = 0;
    this.slideAirTime = 0;
    this.slideLean = 0;

    this.wallNormal = new THREE.Vector3();
    this.wallSurface = 'concrete';
    this.wallTimer = 0;
    this.wallSpeed = 0;
    this._wallVelX = 0; this._wallVelZ = 0;
    this.wallBounceCooldown = 0;

    this.mantle = {
      active: false, t: 0, duration: 0.4,
      from: new THREE.Vector3(), to: new THREE.Vector3(),
      dir: new THREE.Vector3(), entrySpeed: 0, arc: 0,
    };
    this.mantleCooldown = 0;

    this._footAccum = 0;
    this._colliderCount = -1;
    this._rebuildTimer = 0;
    this._needsRebuild = false;
    this._ready = false;
    this._yawPrev = 0;
    this._yawRate = 0;

    this._camState = {
      px: 0, py: 0, pz: 0, speed: 0, onGround: false, isSliding: false,
      isSprinting: false, mantling: false, strafe: 0, slideLean: 0, yawRate: 0,
    };
    this._unsub = [];
  }

  /* =================================================================== */
  /* lifecycle                                                            */
  /* =================================================================== */

  async init(ctx) {
    this.ctx = ctx;
    this.bus = ctx.bus;
    this.projectiles.bus = ctx.bus;

    this._buildCollision(ctx);

    this._unsub.push(ctx.bus.on(EV.CAMERA_SHAKE, (p) => {
      this.rig.addTrauma(p?.amplitude ?? 0.25, p?.frequency ?? 26, p?.duration ?? 0.2);
    }));
    // Any system that rebuilds geometry can ask for a fresh BVH.
    for (const evt of ['world:ready', 'world:changed', 'world:rebuilt']) {
      this._unsub.push(ctx.bus.on(evt, () => { this._needsRebuild = true; }));
    }

    this._spawn(ctx);
    this._ready = true;
  }

  _buildCollision(ctx) {
    const world = ctx.engine.get('world');
    const meshes = world?.colliderMeshes;
    if (meshes && meshes.length) {
      this.collision.build(meshes);
      this._colliderCount = meshes.length;
    }
  }

  _spawn(ctx) {
    const world = ctx.engine.get('world');
    const pts = world?.spawnPoints;
    if (pts && pts.length) this.position.copy(pts[0]);
    else this.position.set(0, 2, 0);

    // Settle on to the surface below the spawn marker.
    if (this.collision.ready) {
      const g = this.collision.raycastRef(
        this.position.x, this.position.y + 4, this.position.z, 0, -1, 0, 80);
      if (g) this.position.y = g.py + 0.02;
      this.collision.resolve(this.position, CFG.move.player.radius, this.capsuleHeight);
    }
    this.prevPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.rig.eyeHeight = this.capsuleHeight - CFG.move.player.eyeOffset;
    this.rig.reset(this.rig.yaw, 0);
    this._syncEye();
  }

  /** Move the player somewhere safe (respawn, teleport ability, debug). */
  teleport(pos, keepVelocity = false) {
    this.position.copy(pos);
    this.prevPosition.copy(pos);
    if (!keepVelocity) this.velocity.set(0, 0, 0);
    this.mantle.active = false; this.isMantling = false;
    this.isSliding = false;
    if (this.collision.ready) {
      this.collision.resolve(this.position, CFG.move.player.radius, this.capsuleHeight);
    }
    this._syncEye();
  }

  respawn(ctx = this.ctx) { this._spawn(ctx); }

  /** External impulse (explosions, abilities, launch pads). */
  addImpulse(v) {
    this.velocity.add(v);
    if (v.y > 0.5) { this.onGround = false; this.coyote = 0; this._justJumped = 0.12; }
  }

  dispose() {
    for (const off of this._unsub) off?.();
    this._unsub.length = 0;
    this.projectiles.clear();
    this.ragdolls.clear();
  }

  /* =================================================================== */
  /* accessors for the rest of the game                                   */
  /* =================================================================== */

  /** Horizontal speed — what a speedometer / bob / audio wants. */
  get speed() { return Math.hypot(this.velocity.x, this.velocity.z); }
  get speed3D() { return this.velocity.length(); }
  get eyeHeight() { return this.capsuleHeight - CFG.move.player.eyeOffset; }
  get yaw() { return this.rig.yaw; }
  get pitch() { return this.rig.pitch; }
  get radius() { return CFG.move.player.radius; }
  get height() { return this.capsuleHeight; }

  getViewDirection(out) { return this.rig.forward(out); }
  addTrauma(a, f, d) { this.rig.addTrauma(a, f, d); }
  addLookImpulse(p, y, r) { this.rig.addLookImpulse(p, y, r); }
  /** Weapons set this to 1 (hipfire) or CFG.camera.adsFovScale (ADS). */
  setFovScale(s) { this.rig.fovScale = s; }

  /* Collision contract mirrors so AI/weapons can use us directly. */
  raycast(origin, dir, maxDist = 1000) { return this.collision.raycast(origin, dir, maxDist); }
  capsuleCast(start, end, radius, height) { return this.collision.capsuleCast(start, end, radius, height); }
  overlapCapsule(position, radius, height) { return this.collision.overlapCapsule(position, radius, height); }

  /* =================================================================== */
  /* main tick                                                            */
  /* =================================================================== */

  fixedUpdate(dt, ctx) {
    if (this._needsRebuild) { this._needsRebuild = false; this._buildCollision(ctx); }

    if (this.enabled && this._ready) this._step(dt, ctx);

    // World simulation keeps running even when the controller is frozen for
    // a screenshot, otherwise bullets and bodies hang in the air.
    this.projectiles.fixedUpdate(dt);
    this.ragdolls.fixedUpdate(dt);
  }

  _step(dt, ctx) {
    const M = CFG.move, P = M.player;
    this.prevPosition.copy(this.position);
    const wasOnGround = this.onGround;

    this._readInput(ctx);
    this._advanceTimers(dt);
    this._buildWishDir();

    if (this.mantle.active) { this._updateMantle(dt, ctx); this._finishTick(dt, ctx, wasOnGround); return; }

    // --- crouch / stand ---------------------------------------------------
    this._updateStance(dt);

    // --- jump, wall-bounce, mantle (before friction => bhop keeps speed) --
    this._handleJump(dt, ctx);
    // Auto-mantle: airborne, pressing into something we already touched.
    if (!this.mantle.active && !this.onGround && this.velocity.y < 1.5
        && this.wishActive && this.airTime > 0.04 && this.wallTimer > 0) {
      this._tryMantle(ctx);
    }
    if (this.mantle.active) { this._finishTick(dt, ctx, wasOnGround); return; }

    // --- slide state machine ---------------------------------------------
    this._updateSlide(dt, ctx);

    // --- acceleration -----------------------------------------------------
    if (this.isSliding && this.onGround) this._slideMove(dt);
    else if (this.onGround) this._groundMove(dt);
    else this._airMove(dt);

    // --- gravity / ground plane -------------------------------------------
    if (this.onGround && this._justJumped <= 0) {
      this._projectOntoGround();
    } else {
      this.velocity.y -= M.gravity * dt;
    }

    // --- speed cap ---------------------------------------------------------
    const hs = this.speed;
    if (hs > M.maxSpeedCap) {
      const k = M.maxSpeedCap / hs;
      this.velocity.x *= k; this.velocity.z *= k;
    }
    if (this.velocity.y < -80) this.velocity.y = -80;

    // --- integrate ---------------------------------------------------------
    this._moveWithCollision(dt);
    this._groundCheck(dt, wasOnGround);
    this._finishTick(dt, ctx, wasOnGround);
  }

  _finishTick(dt, ctx, wasOnGround) {
    this._events(dt, ctx, wasOnGround);
    this._syncEye();
    this._prevCrouch = this.crouchHeld;
  }

  /* ---------------- input ---------------- */

  _readInput(ctx) {
    const input = ctx?.engine?.get?.('input');
    if (!input) {
      // Headless / scripted: keep whatever setInput() last supplied.
      if (this._scripted) return;
      this.moveX = 0; this.moveZ = 0;
      this.jumpHeld = false; this.crouchHeld = false; this.sprintHeld = false;
      return;
    }
    this.moveX = (input.down(ACTION.RIGHT) ? 1 : 0) - (input.down(ACTION.LEFT) ? 1 : 0);
    this.moveZ = (input.down(ACTION.FORWARD) ? 1 : 0) - (input.down(ACTION.BACK) ? 1 : 0);
    this.jumpHeld = input.down(ACTION.JUMP);
    this.crouchHeld = input.down(ACTION.CROUCH);
    this.sprintHeld = input.down(ACTION.SPRINT);
  }

  /** Test/AI hook: drive the controller without an Input instance. */
  setInput(moveX, moveZ, jump, crouch, sprint) {
    this.moveX = moveX; this.moveZ = moveZ;
    this.jumpHeld = !!jump; this.crouchHeld = !!crouch; this.sprintHeld = !!sprint;
    this._scripted = true;
  }

  _advanceTimers(dt) {
    const M = CFG.move;
    this.slideCooldown = Math.max(0, this.slideCooldown - dt);
    this.wallBounceCooldown = Math.max(0, this.wallBounceCooldown - dt);
    this.mantleCooldown = Math.max(0, this.mantleCooldown - dt);
    this.wallTimer = Math.max(0, this.wallTimer - dt);
    this._justJumped = Math.max(0, this._justJumped - dt);

    // Holding jump keeps the buffer alive => auto-bhop, jumps never drop.
    if (this.jumpHeld) this.jumpBuffer = M.jumpBuffer;
    else this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);

    if (this.onGround) { this.coyote = M.coyoteTime; this.airTime = 0; }
    else { this.coyote = Math.max(0, this.coyote - dt); this.airTime += dt; }
  }

  _buildWishDir() {
    this.rig.forwardFlat(_fwd);
    this.rig.rightFlat(_right);
    _wish.set(
      _fwd.x * this.moveZ + _right.x * this.moveX, 0,
      _fwd.z * this.moveZ + _right.z * this.moveX);
    const len = Math.hypot(_wish.x, _wish.z);
    this.wishActive = len > 1e-4;
    if (this.wishActive) { _wish.x /= len; _wish.z /= len; }

    this.isSprinting = this.sprintHeld && this.wishActive && this.moveZ >= 0
      && !this.crouchHeld && !this.isSliding && this.onGround && this.speed > 1.0;
  }

  /* ---------------- stance ---------------- */

  _updateStance(dt) {
    const P = CFG.move.player, S = CFG.move.slide;
    const standH = P.height;
    const crouchH = S.heightCrouch;

    if (this.isSliding) this._targetHeight = crouchH;
    else if (this.crouchHeld && this.onGround) this._targetHeight = crouchH;
    else this._targetHeight = standH;

    if (this._targetHeight > this.capsuleHeight) {
      // Standing up: only if there is room above.
      _tmp.copy(this.position);
      if (this.collision.ready && !this.collision.isFree(_tmp, P.radius * 0.98, this._targetHeight)) {
        this._targetHeight = this.capsuleHeight;
      }
    }
    const rate = this.isSliding ? 22 : 16;
    const k = 1 - Math.exp(-rate * dt);
    this.capsuleHeight += (this._targetHeight - this.capsuleHeight) * k;
    if (Math.abs(this._targetHeight - this.capsuleHeight) < 0.002) this.capsuleHeight = this._targetHeight;
    this.isCrouching = this.capsuleHeight < standH - 0.05;
    this.rig.eyeHeight = this.capsuleHeight - P.eyeOffset;
  }

  /* ---------------- acceleration models ---------------- */

  _accelerate(wishDir, wishSpeed, accel, dt) {
    const current = this.velocity.x * wishDir.x + this.velocity.z * wishDir.z;
    const add = wishSpeed - current;
    if (add <= 0) return;
    let a = accel * wishSpeed * dt;
    if (a > add) a = add;
    this.velocity.x += wishDir.x * a;
    this.velocity.z += wishDir.z * a;
  }

  /**
   * Quake/Source air acceleration. The wishspeed used for the "can I still
   * add speed" test is clamped to a small value, so steering sideways always
   * has headroom to add velocity perpendicular to your motion — that is the
   * whole trick behind air-strafing and bunnyhop speed gain.
   */
  _airAccelerate(wishDir, wishSpeed, dt) {
    const M = CFG.move;
    const cap = M.airStrafeCap ?? 1.15;
    const wish = Math.min(wishSpeed, cap);
    const current = this.velocity.x * wishDir.x + this.velocity.z * wishDir.z;
    const add = wish - current;
    if (add <= 0) return;
    let a = M.accelAir * M.airStrafeGain * wish * dt;
    if (a > add) a = add;
    this.velocity.x += wishDir.x * a;
    this.velocity.z += wishDir.z * a;
  }

  _friction(dt, scale = 1) {
    const M = CFG.move;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (speed < 0.05) { this.velocity.x = 0; this.velocity.z = 0; return; }
    const control = Math.max(speed, M.stopSpeed);
    const drop = control * M.friction * scale * dt;
    const k = Math.max(0, speed - drop) / speed;
    this.velocity.x *= k; this.velocity.z *= k;
  }

  _wishSpeed() {
    const M = CFG.move;
    if (this.isCrouching && !this.isSliding) return M.crouchSpeed;
    if (this.isSprinting) return M.sprintSpeed;
    return M.walkSpeed;
  }

  _groundMove(dt) {
    this._friction(dt);
    if (this.wishActive) this._accelerate(_wish, this._wishSpeed(), CFG.move.accelGround, dt);
  }

  _airMove(dt) {
    const M = CFG.move;
    const wishSpeed = this.isSliding ? M.sprintSpeed : this._wishSpeed();
    if (!this.wishActive) return;
    // Classic strafe gain.
    this._airAccelerate(_wish, wishSpeed, dt);
    // A little omnidirectional control, but only while slow, so it can never
    // wash out the strafe model at speed.
    const hs = this.speed;
    const floor = M.walkSpeed * 0.55;
    if (hs < floor) this._accelerate(_wish, floor, M.accelAir * 0.9, dt);
  }

  /**
   * Keep velocity in the ground plane so ramps neither launch nor brake you.
   * The rescale preserves HORIZONTAL speed (not total), otherwise the slope
   * would quietly pump energy into the player every tick.
   */
  _projectOntoGround() {
    const n = this.groundNormal;
    if (n.y > 0.9997) { this.velocity.y = 0; return; }
    const sp = Math.hypot(this.velocity.x, this.velocity.z);
    const d = this.velocity.dot(n);
    this.velocity.addScaledVector(n, -d);
    const nh = Math.hypot(this.velocity.x, this.velocity.z);
    if (nh > 1e-5 && sp > 1e-5) this.velocity.multiplyScalar(sp / nh);
  }

  /* ---------------- jump / wall-bounce ---------------- */

  _handleJump(dt, ctx) {
    const M = CFG.move;
    if (this.jumpBuffer <= 0) return;

    if (this.onGround || this.coyote > 0) {
      const slideJump = this.isSliding;
      if (slideJump) this._endSlide(ctx, 'jump');
      this.velocity.y = M.jumpVelocity;
      this.onGround = false;
      this.coyote = 0;
      this.jumpBuffer = 0;
      this._justJumped = 0.1;
      this.airTime = 0;
      this.rig.stepOffset *= 0.4;
      this.bus?.emit(EV.PLAYER_JUMP, {
        position: this.position.clone(),
        velocity: this.velocity.clone(),
        speed: this.speed,
        fromSlide: slideJump,
      });
      return;
    }

    // Airborne: ledges first (mantling beats bouncing), then wall-bounce.
    if (this._tryMantle(ctx)) return;
    if (this.wallTimer > 0 && this.wallBounceCooldown <= 0 && (CFG.move.wallBounce.enabled ?? true)) {
      this._wallBounce(ctx);
    }
  }

  _wallBounce(ctx) {
    const W = CFG.move.wallBounce, M = CFG.move;
    const n = this.wallNormal;
    if (Math.abs(n.x) + Math.abs(n.z) < 1e-4) return;

    // Momentum as it was *before* the wall clipped it.
    let vx = this._wallVelX, vz = this._wallVelZ;
    let s = Math.hypot(vx, vz);
    if (s < this.speed) { vx = this.velocity.x; vz = this.velocity.z; s = this.speed; }
    const minSpeed = (W.minSpeed ?? M.walkSpeed * 0.8);
    if (s < minSpeed) return;

    // Mirror the incoming direction across the wall, then bias it toward
    // where the player is aiming: that is the part you get better at.
    const d = (vx * n.x + vz * n.z) / s;
    let rx = vx / s - 2 * d * n.x;
    let rz = vz / s - 2 * d * n.z;
    this.rig.forwardFlat(_fwd);
    const blend = W.lookBlend ?? 0.55;
    let dx = rx * (1 - blend) + _fwd.x * blend;
    let dz = rz * (1 - blend) + _fwd.z * blend;
    let dl = Math.hypot(dx, dz) || 1;
    dx /= dl; dz /= dl;
    // Never let the redirect point back into the wall.
    const into = dx * n.x + dz * n.z;
    if (into < 0.15) {
      dx += n.x * (0.15 - into) * 1.6; dz += n.z * (0.15 - into) * 1.6;
      dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
    }

    const out = Math.max(s * W.speedRetain, M.sprintSpeed);
    this.velocity.x = dx * out + n.x * W.outwardImpulse;
    this.velocity.z = dz * out + n.z * W.outwardImpulse;
    this.velocity.y = Math.max(this.velocity.y * 0.4, 0) + W.upImpulse;

    const hs = this.speed;
    if (hs > M.maxSpeedCap) { const k = M.maxSpeedCap / hs; this.velocity.x *= k; this.velocity.z *= k; }

    this.wallTimer = 0;
    this.jumpBuffer = 0;
    this.wallBounceCooldown = W.cooldown ?? 0.3;
    this._justJumped = 0.1;

    const side = (_fwd.x * n.z - _fwd.z * n.x) > 0 ? 1 : -1;
    this.rig.kickRoll(side * (CFG.camera.slideRoll ?? 0.08) * 0.9);
    this.rig.addTrauma(0.22, 24, 0.1);
    this.bus?.emit(EV.WALL_BOUNCE, {
      position: this.position.clone(),
      normal: n.clone(),
      speed: this.speed,
      surface: this.wallSurface || 'concrete',
    });
  }

  /* ---------------- slide ---------------- */

  _updateSlide(dt, ctx) {
    const S = CFG.move.slide;
    const hs = this.speed;
    const crouchPressed = this.crouchHeld && !this._prevCrouch;

    if (!this.isSliding) {
      if (crouchPressed && this.onGround && hs >= S.minEntrySpeed
          && this.slideCooldown <= 0 && !this.mantle.active) {
        this._startSlide(ctx);
      }
      return;
    }

    // Airborne mid-slide: keep the tuck for a moment (slide off a ledge and
    // land straight back into it), but bail if the drop is long.
    if (!this.onGround) {
      this.slideAirTime += dt;
      if (this.slideAirTime > (S.airGrace ?? 0.45)) { this._endSlide(ctx, 'air'); return; }
    } else {
      this.slideAirTime = 0;
    }

    // Downhill slides do not expire — that's how you carry huge speed.
    const downhill = this._slopeFactor() > 0.08 && this._isDescending();
    if (!downhill) this.slideTime += dt;

    if (this.slideTime > S.maxDuration) { this._endSlide(ctx, 'timeout'); return; }
    if (this.onGround && hs < S.minExitSpeed) { this._endSlide(ctx, 'slow'); return; }
    if (!this.crouchHeld) {
      _tmp.copy(this.position);
      if (!this.collision.ready || this.collision.isFree(_tmp, CFG.move.player.radius * 0.98, CFG.move.player.height)) {
        this._endSlide(ctx, 'release');
      }
    }
  }

  _slopeFactor() {
    // sin(slope angle) — 0 on flat ground, 1 on a wall.
    const n = this.groundNormal;
    return Math.sqrt(Math.max(0, 1 - n.y * n.y));
  }

  _isDescending() {
    this._downhillDir(_slope);
    return (this.velocity.x * _slope.x + this.velocity.z * _slope.z) > 0.05;
  }

  /** Steepest-descent direction in the ground plane: down - n*(down·n). */
  _downhillDir(out) {
    const n = this.groundNormal;
    out.set(n.x * n.y, n.y * n.y - 1, n.z * n.y);
    const l = out.length();
    if (l > 1e-5) out.multiplyScalar(1 / l); else out.set(0, 0, 0);
    return out;
  }

  _startSlide(ctx) {
    const S = CFG.move.slide, M = CFG.move;
    this.isSliding = true;
    this.slideTime = 0;
    this.slideAirTime = 0;
    const hs = this.speed;
    // Entry impulse along the current heading — full value out of a sprint.
    // (isSprinting is already false by now: crouch cancels it the same tick.)
    const sprinting = this.sprintHeld || hs >= M.sprintSpeed * 0.95;
    const boost = sprinting ? S.boost : S.boost * 0.5;
    if (hs > 0.2) {
      const k = 1 + boost / hs;
      this.velocity.x *= k;
      this.velocity.z *= k;
    }
    const cap = M.maxSpeedCap;
    const ns = this.speed;
    if (ns > cap) { const k = cap / ns; this.velocity.x *= k; this.velocity.z *= k; }

    this.slideLean = this.moveX !== 0 ? Math.sign(this.moveX) : (this.slideLean || 1) * 0.6;
    this.isSprinting = false;
    this.rig.addTrauma(0.12, 18, 0.08);
    this.bus?.emit(EV.SLIDE_START, {
      position: this.position.clone(), speed: this.speed, surface: this.groundSurface,
    });
  }

  _endSlide(ctx, reason) {
    if (!this.isSliding) return;
    this.isSliding = false;
    this.slideCooldown = CFG.move.slide.cooldown;
    this.slideAirTime = 0;
    this.bus?.emit(EV.SLIDE_END, {
      position: this.position.clone(), speed: this.speed, reason,
      duration: this.slideTime,
    });
    this.slideTime = 0;
  }

  _slideMove(dt) {
    const S = CFG.move.slide, M = CFG.move;
    const sin = this._slopeFactor();

    // Gravity projected along the slope — this is what makes downhill fast.
    if (sin > 0.02) {
      this._downhillDir(_slope);
      this.velocity.addScaledVector(_slope, S.slopeAccel * sin * dt);
    }

    // Friction as a linear deceleration: a flat slide bleeds off predictably
    // instead of dying exponentially, so it stays useful for its full duration.
    let speed = this.velocity.length();
    const descending = sin > 0.05 && this._isDescending();
    const f = descending ? S.frictionDownhill : S.frictionFlat;
    let newSpeed = Math.max(0, speed - f * dt);

    // Steering rotates the velocity without adding energy.
    if (this.moveX !== 0 && speed > 0.5) {
      const steer = (S.steerAccel ?? 9.5) * dt * this.moveX;
      this.velocity.x += _right.x * steer;
      this.velocity.z += _right.z * steer;
      speed = this.velocity.length();
    }
    if (speed > 1e-4) this.velocity.multiplyScalar(newSpeed / speed);

    this.slideLean += ((this.moveX !== 0 ? Math.sign(this.moveX) : 0.35) - this.slideLean) * (1 - Math.exp(-6 * dt));

    const hs = this.speed;
    if (hs > M.maxSpeedCap) { const k = M.maxSpeedCap / hs; this.velocity.x *= k; this.velocity.z *= k; }
  }

  /* ---------------- mantle ---------------- */

  _tryMantle(ctx) {
    const M = CFG.move.mantle, P = CFG.move.player;
    if (this.mantle.active || this.mantleCooldown > 0 || !this.collision.ready) return false;
    if (!this.wishActive && this.onGround) return false;

    if (this.wishActive) _dirFlat.set(_wish.x, 0, _wish.z);
    else this.rig.forwardFlat(_dirFlat);
    const dl = Math.hypot(_dirFlat.x, _dirFlat.z);
    if (dl < 1e-4) return false;
    _dirFlat.x /= dl; _dirFlat.z /= dl; _dirFlat.y = 0;

    const reach = P.radius + M.reach;
    // 1) Is there a face in front of us at knee height?
    const wall = this.collision.raycastRef(
      this.position.x, this.position.y + 0.3, this.position.z,
      _dirFlat.x, 0, _dirFlat.z, reach);
    if (!wall) return false;
    if (wall.ny > 0.7) return false;                   // it's a ramp — just walk up
    const wallDist = wall.distance;

    // 2) Find the top of it just past the face.
    const px = this.position.x + _dirFlat.x * (wallDist + 0.14);
    const pz = this.position.z + _dirFlat.z * (wallDist + 0.14);
    const topY = this.position.y + M.maxHeight + 0.35;
    const top = this.collision.raycastRef(px, topY, pz, 0, -1, 0, M.maxHeight + 0.5);
    if (!top) return false;
    const ledgeY = top.py;
    const rise = ledgeY - this.position.y;
    // Clamp the lower bound so there is never a band of ledges that is both
    // too tall to step onto and too short to mantle.
    const minRise = Math.min(M.minHeight, P.stepHeight + 0.05);
    if (rise < minRise || rise > M.maxHeight) return false;
    if (top.ny < Math.cos(P.maxSlopeAngle)) return false;

    // 3) Does a body fit up there?
    _target.set(
      this.position.x + _dirFlat.x * (wallDist + P.radius + 0.1),
      ledgeY + 0.03,
      this.position.z + _dirFlat.z * (wallDist + P.radius + 0.1));
    const clearance = Math.max(M.minClearance, P.radius * 2.05);
    if (!this.collision.isFree(_target, P.radius * 0.92, clearance)) return false;

    // Commit.
    const mt = this.mantle;
    mt.active = true;
    this.isMantling = true;
    mt.t = 0;
    mt.duration = M.duration * (0.62 + 0.38 * clamp(rise / M.maxHeight, 0, 1));
    mt.from.copy(this.position);
    mt.to.copy(_target);
    mt.dir.copy(_dirFlat);
    mt.entrySpeed = this.speed;
    mt.arc = (M.arc ?? 0.12) * clamp(rise / M.maxHeight, 0.3, 1);

    if (this.isSliding) this._endSlide(ctx, 'mantle');
    this.velocity.set(0, 0, 0);
    this.onGround = false;
    this.jumpBuffer = 0;
    this.wallTimer = 0;
    this.rig.addTrauma(0.1, 16, 0.08);
    this.bus?.emit(EV.MANTLE_START, {
      position: this.position.clone(),
      target: _target.clone(),
      height: rise,
      duration: mt.duration,
    });
    return true;
  }

  _updateMantle(dt, ctx) {
    const mt = this.mantle;
    mt.t += dt;
    const t = clamp(mt.t / mt.duration, 0, 1);
    // Vertical leads, horizontal follows — reads as reaching up and pulling on.
    const yT = smootherstep(clamp(t / 0.62, 0, 1));
    const xzT = smoothstep(clamp((t - 0.18) / 0.82, 0, 1));
    const prevY = this.position.y;

    this.position.x = mt.from.x + (mt.to.x - mt.from.x) * xzT;
    this.position.z = mt.from.z + (mt.to.z - mt.from.z) * xzT;
    this.position.y = mt.from.y + (mt.to.y - mt.from.y) * yT + mt.arc * Math.sin(Math.PI * t);

    // Let the camera trail the body a little so it eases rather than snaps.
    this.rig.stepOffset = clamp(this.rig.stepOffset + (this.position.y - prevY) * 0.42,
      -CFG.move.player.stepHeight * 1.5, CFG.move.player.stepHeight * 1.5);

    if (t >= 1) {
      mt.active = false;
      this.isMantling = false;
      this.mantleCooldown = 0.18;
      this.position.copy(mt.to);
      if (this.collision.ready) {
        this.collision.resolve(this.position, CFG.move.player.radius, this.capsuleHeight);
      }
      const exit = Math.min(mt.entrySpeed * 0.75, CFG.move.walkSpeed);
      this.velocity.set(mt.dir.x * exit, 0.4, mt.dir.z * exit);
      this.onGround = false;
      this.coyote = CFG.move.coyoteTime;
    }
  }

  /* ---------------- integration ---------------- */

  _moveWithCollision(dt) {
    const P = CFG.move.player;
    const r = P.radius, h = this.capsuleHeight;
    this._preMoveVelY = this.velocity.y;
    _preVel.copy(this.velocity);
    _startPos.copy(this.position);

    _delta.copy(this.velocity).multiplyScalar(dt);

    if (!this.collision.ready) {
      this.position.add(_delta);
      if (this.position.y < 0) { this.position.y = 0; this.velocity.y = 0; }
      this.moveRes.reset();
      return;
    }

    this.collision.translate(this.position, _delta, r, h, this.moveRes);
    this.moveRes.clip(this.velocity);

    // --- step up ---------------------------------------------------------
    const wantH = Math.hypot(_delta.x, _delta.z);
    const gotH = Math.hypot(this.position.x - _startPos.x, this.position.z - _startPos.z);
    const blocked = this.moveRes.hit && wantH > 1e-5 && gotH < wantH - 1e-4;
    // Test the PRE-move vertical velocity: clipping against a step lip turns
    // blocked forward motion into upward motion, and reading that back would
    // look like a jump and veto the step-up on every stair.
    if (blocked && (this.onGround || this.coyote > 0) && _preVel.y < 2.0) {
      if (this._tryStepUp(_startPos, _delta, gotH)) {
        // A step must not cost you speed — restore the horizontal momentum
        // the wall clip just ate, and drop the upward kick the lip gave us.
        this.velocity.x = _preVel.x; this.velocity.z = _preVel.z;
        this.velocity.y = Math.min(0, _preVel.y);
      }
    }

    // --- wall memory for the bounce window --------------------------------
    if (this.moveRes.hasWall && !this.onGround) {
      const n = this.moveRes.wallNormal;
      const l = Math.hypot(n.x, n.z);
      if (l > 1e-4) {
        this.wallNormal.set(n.x / l, 0, n.z / l);
        this.wallSurface = this.moveRes.wallSurface;
        this.wallTimer = CFG.move.wallBounce.window;
        this._wallVelX = _preVel.x; this._wallVelZ = _preVel.z;
        this.wallSpeed = Math.hypot(_preVel.x, _preVel.z);
      }
    }
  }

  /**
   * Quake-style up / forward / down step, run whenever a grounded move is
   * blocked. Combined with the contact-normal clipping in MoveResult this
   * carries the player up a staircase at essentially full speed (measured:
   * 6.87 of 6.90 m/s on 0.3 m x 0.5 m steps) with no teleporting — each tick
   * still advances exactly one tick's worth of motion.
   *
   * The height gained is handed to the camera as `rig.stepOffset` and eased
   * out, so the view glides instead of ratcheting.
   */
  _tryStepUp(startPos, delta, gotH) {
    const P = CFG.move.player;
    const r = P.radius, h = this.capsuleHeight;
    const step = P.stepHeight;
    _stepPos.copy(startPos);

    _tmp.set(0, step, 0);
    this.collision.translate(_stepPos, _tmp, r, h, this._stepRes);
    const rose = _stepPos.y - startPos.y;
    if (rose < 0.03) return false;

    _tmp.set(delta.x, 0, delta.z);
    this.collision.translate(_stepPos, _tmp, r, h, this._stepRes);
    const advanced = Math.hypot(_stepPos.x - startPos.x, _stepPos.z - startPos.z);

    const landed = this.collision.probeGround(_stepPos, r, h, rose + 0.03, this._stepRes);
    if (!landed || this._stepRes.groundY < Math.cos(P.maxSlopeAngle)) return false;  // nothing walkable underneath

    const rise = _stepPos.y - this.position.y;
    if (rise > step + 0.06 || rise < -0.02) return false;   // never "step" downward
    // The step has to buy us something: either horizontal progress the plain
    // move could not get, or real height onto a walkable surface.
    if (advanced <= gotH + 1e-3 && rise <= 0.02) return false;

    this.position.copy(_stepPos);
    this.groundNormal.copy(this._stepRes.groundNormal);
    this.groundSurface = this._stepRes.groundSurface;
    this.onGround = true;
    this.rig.stepOffset = clamp(this.rig.stepOffset + rise, -step * 1.6, step * 1.6);
    return true;
  }

  _groundCheck(dt, wasOnGround) {
    const P = CFG.move.player;
    const cos = Math.cos(P.maxSlopeAngle);
    const r = P.radius, h = this.capsuleHeight;

    if (!this.collision.ready) {
      this.onGround = this.position.y <= 1e-4;
      if (this.onGround) this.groundNormal.set(0, 1, 0);
      return;
    }

    let grounded = false;
    // Probe whenever we were already grounded (running up a ramp gives a
    // legitimately positive vy) or whenever we are descending.
    if ((wasOnGround || this.velocity.y <= 0.6) && this._justJumped <= 0) {
      // Snap down: keeps you glued to stairs and to ramps you run down.
      const probe = wasOnGround ? Math.max(0.09, P.stepHeight) : 0.09;
      _probePos.copy(this.position);
      const found = this.collision.probeGround(_probePos, r, h, probe, this._probeRes);
      const drop = this._probeRes.drop;
      if (found && this._probeRes.groundY >= cos) {
        grounded = true;
        this.groundNormal.copy(this._probeRes.groundNormal);
        this.groundSurface = this._probeRes.groundSurface;
        if (drop > 0.004 && wasOnGround) {
          this.rig.stepOffset = clamp(this.rig.stepOffset - drop, -P.stepHeight * 1.6, P.stepHeight * 1.6);
        }
        this.position.y = _probePos.y;
      }
    }

    // Contacts from the move itself also count (e.g. landing hard).
    if (!grounded && this.moveRes.groundY >= cos && (wasOnGround || this.velocity.y <= 0.1)
        && this._justJumped <= 0) {
      grounded = true;
      this.groundNormal.copy(this.moveRes.groundNormal);
      this.groundSurface = this.moveRes.groundSurface;
    }
    this.onGround = grounded;
    if (grounded && this.velocity.y > 0 && this._justJumped <= 0) this.velocity.y = 0;
  }

  /* ---------------- events / bookkeeping ---------------- */

  _events(dt, ctx, wasOnGround) {
    // --- landing ---------------------------------------------------------
    if (this.onGround && !wasOnGround) {
      const impact = Math.max(0, -this._preMoveVelY);
      this.velocity.y = 0;
      this.rig.land(impact);
      if (impact > 7) this.rig.addTrauma(clamp((impact - 7) / 18, 0, 0.45), 20, 0.12);
      this.bus?.emit(EV.PLAYER_LAND, {
        position: this.position.clone(),
        impact,
        speed: this.speed,
        surface: this.groundSurface,
        hard: impact > 9,
      });
      // Landing while still holding crouch with speed re-enters the slide.
      if (this.crouchHeld && !this.isSliding && this.slideCooldown <= 0
          && this.speed >= CFG.move.slide.minEntrySpeed) {
        this._startSlide(ctx);
      }
    }

    // --- footsteps: distance based, so they always match the stride ------
    if (this.onGround && !this.isSliding && !this.mantle.active) {
      const sp = this.speed;
      if (sp > 0.7) {
        this._footAccum += sp * dt;
        const stride = (this.isCrouching ? 2.6 : 1.95) + sp * 0.055;
        if (this._footAccum >= stride) {
          this._footAccum = 0;
          this.bus?.emit(EV.FOOTSTEP, {
            position: this.position.clone(),
            surface: this.groundSurface,
            speed: sp,
          });
        }
      } else {
        this._footAccum = Math.min(this._footAccum, 1.2);
      }
    }
  }

  _syncEye() {
    this.eyePosition.set(
      this.position.x,
      this.position.y + this.capsuleHeight - CFG.move.player.eyeOffset,
      this.position.z);
  }

  /* =================================================================== */
  /* render-rate update: look, interpolation, procedural camera            */
  /* =================================================================== */

  update(dt, alpha, ctx) {
    // Cheap watchdog: pick up world geometry that appeared after we booted.
    this._rebuildTimer += dt;
    if (this._rebuildTimer > 1.0) {
      this._rebuildTimer = 0;
      const meshes = ctx.engine.get('world')?.colliderMeshes;
      if (meshes && meshes.length !== this._colliderCount) {
        this.collision.build(meshes);
        this._colliderCount = meshes.length;
        if (!this._ready) this._ready = true;
      }
    }

    if (!this.enabled) return;

    const input = ctx.engine.get('input');
    if (input?.consumeLook) {
      const look = input.consumeLook(this.rig.fovScale < 0.999 ? CFG.camera.adsSensScale : 1);
      this.rig.look(look.yaw, look.pitch);
    }

    const dy = this.rig.yaw - this._yawPrev;
    this._yawPrev = this.rig.yaw;
    const wrapped = dy > Math.PI ? dy - Math.PI * 2 : dy < -Math.PI ? dy + Math.PI * 2 : dy;
    this._yawRate += (wrapped / Math.max(dt, 1e-4) - this._yawRate) * Math.min(1, dt * 14);

    _lerpPos.lerpVectors(this.prevPosition, this.position, clamp(alpha, 0, 1));
    const s = this._camState;
    s.px = _lerpPos.x; s.py = _lerpPos.y; s.pz = _lerpPos.z;
    s.speed = this.speed;
    s.onGround = this.onGround;
    s.isSliding = this.isSliding;
    s.isSprinting = this.isSprinting;
    s.mantling = this.mantle.active;
    s.strafe = this.moveX;
    s.slideLean = this.slideLean;
    s.yawRate = this._yawRate;

    this.rig.apply(ctx.camera, dt, s);
    this.eyePosition.copy(this.rig.position);
  }
}
