/**
 * CameraRig — everything that makes the view feel alive.
 *
 * Owns yaw/pitch, view-height smoothing, speed-driven bob, landing dip,
 * strafe/slide roll, an additive trauma shake channel and FOV blending.
 * The player controller feeds it state once per physics tick; the rig itself
 * runs on the variable-rate `update` so smoothing is frame-rate independent
 * and the mouse has no added latency.
 *
 * Nothing in here allocates: all maths uses module-scope scratch.
 */
import * as THREE from 'three';
import CFG from '../core/Config.js';

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
/** Frame-rate independent exponential smoothing factor. */
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

/** Cheap deterministic band-limited noise — no allocation, no RNG state. */
function noise1(t, seed) {
  return Math.sin(t * 1.000 + seed * 12.9898) * 0.58
       + Math.sin(t * 2.371 + seed * 7.233) * 0.29
       + Math.sin(t * 4.713 + seed * 3.117) * 0.13;
}

export class CameraRig {
  constructor() {
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;

    this.fovScale = 1;          // weapons set this for ADS
    this.fov = CFG.camera.fov;
    this._fovTarget = CFG.camera.fov;

    this.eyeHeight = CFG.move.player.height - CFG.move.player.eyeOffset;
    this._eyeSmooth = this.eyeHeight;
    this.stepOffset = 0;        // world-space Y the feet jumped without the camera

    this._bobPhase = 0;
    this._bobAmp = 0;
    this._bobX = 0; this._bobY = 0;

    this._dip = 0;              // landing dip offset (negative = down)
    this._dipVel = 0;

    this._rollTarget = 0;
    this._rollKick = 0;         // wall-bounce / impulse roll

    this.trauma = 0;
    this._shakeFreq = 26;
    this._shakeSustain = 0;
    this._shakeTime = 0;

    this._lookImpulseP = 0;     // weapon recoil, decays back out
    this._lookImpulseY = 0;
    this._recoverP = 0;
    this._recoverY = 0;

    this._mantleLag = 0;

    this.offset = new THREE.Vector3();     // final additive eye offset
    this.position = new THREE.Vector3();   // final world camera position
  }

  reset(yaw = 0, pitch = 0) {
    this.yaw = yaw; this.pitch = pitch; this.roll = 0;
    this._bobPhase = 0; this._bobAmp = 0; this._dip = 0; this._dipVel = 0;
    this.trauma = 0; this._rollKick = 0; this.stepOffset = 0;
    this._eyeSmooth = this.eyeHeight;
  }

  /** Mouse look, in radians (already scaled by sensitivity). */
  look(dYaw, dPitch) {
    this.yaw += dYaw;
    this.pitch = clamp(this.pitch + dPitch, -CFG.camera.maxPitch, CFG.camera.maxPitch);
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  /** Weapon recoil: kicks the view and then recovers most of it. */
  addLookImpulse(pitchRad, yawRad, recover = 0.75) {
    this._lookImpulseP += pitchRad;
    this._lookImpulseY += yawRad;
    this._recoverP += pitchRad * recover;
    this._recoverY += yawRad * recover;
  }

  /** Additive camera shake. Matches the EV.CAMERA_SHAKE payload. */
  addTrauma(amplitude = 0.3, frequency = 26, duration = 0.2) {
    this.trauma = Math.min(1.6, this.trauma + Math.max(0, amplitude));
    this._shakeFreq = frequency || 26;
    this._shakeSustain = Math.max(this._shakeSustain, duration || 0);
  }

  /** Landing dip, scaled by impact speed. */
  land(impactSpeed) {
    const g = clamp(impactSpeed / 14, 0, 1.35);
    this._dipVel -= CFG.camera.landDip * (0.35 + g * 1.35) * 9.0;
  }

  /** Sideways impulse used by the wall-bounce. */
  kickRoll(amount) { this._rollKick += amount; }

  /** Direction the view is facing (unit). Written into `out`. */
  forward(out) {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    out.set(-Math.sin(this.yaw) * cp, sp, -Math.cos(this.yaw) * cp);
    return out;
  }

  /** Horizontal forward (unit, y=0). */
  forwardFlat(out) {
    out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    return out;
  }

  rightFlat(out) {
    out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    return out;
  }

  /**
   * Advance all procedural channels and write the final transform onto the
   * camera. `s` is the player state snapshot.
   */
  apply(camera, dt, s) {
    dt = Math.min(dt, 0.1);

    // --- recoil recovery -------------------------------------------------
    if (this._recoverP !== 0 || this._recoverY !== 0) {
      const k = damp(9, dt);
      const dp = this._recoverP * k, dy = this._recoverY * k;
      this._lookImpulseP -= dp; this._recoverP -= dp;
      this._lookImpulseY -= dy; this._recoverY -= dy;
    }

    // --- eye height ------------------------------------------------------
    // Crouch/slide transitions are smoothed; step-ups are absorbed by
    // stepOffset so climbing stairs never punches the camera upward.
    this._eyeSmooth += (this.eyeHeight - this._eyeSmooth) * damp(14, dt);
    this.stepOffset -= this.stepOffset * damp(19, dt);
    if (Math.abs(this.stepOffset) < 0.0008) this.stepOffset = 0;

    // --- view bob (driven by real speed, not a fixed timer) --------------
    const sprint = CFG.move.sprintSpeed;
    const moveFrac = clamp(s.speed / sprint, 0, 1.5);
    const grounded = s.onGround && !s.isSliding && !s.mantling;
    const ampTarget = grounded ? CFG.camera.bobAmount * clamp(moveFrac, 0, 1.2) : 0;
    this._bobAmp += (ampTarget - this._bobAmp) * damp(grounded ? 9 : 5, dt);
    if (grounded) this._bobPhase += dt * CFG.camera.bobSpeed * clamp(moveFrac, 0.0, 1.3);
    const bobY = Math.sin(this._bobPhase * 2) * this._bobAmp;
    const bobX = Math.sin(this._bobPhase) * this._bobAmp * 0.85;
    this._bobY = bobY; this._bobX = bobX;

    // --- landing dip (critically damped spring) --------------------------
    const stiffness = 150, damping = 2 * Math.sqrt(stiffness) * 0.92;
    this._dipVel += (-stiffness * this._dip - damping * this._dipVel) * dt;
    this._dip += this._dipVel * dt;
    if (this._dip < -0.6) { this._dip = -0.6; this._dipVel = 0; }

    // --- roll ------------------------------------------------------------
    let rollTarget = -s.strafe * CFG.camera.strafeRoll;
    rollTarget += clamp(-s.yawRate * 0.09, -0.05, 0.05);
    if (s.isSliding) {
      rollTarget += CFG.camera.slideRoll * clamp(s.slideLean + s.strafe * 0.6, -1.3, 1.3);
    }
    this._rollKick -= this._rollKick * damp(6.5, dt);
    this.roll += (rollTarget + this._rollKick - this.roll) * damp(9, dt);

    // --- shake -----------------------------------------------------------
    let shakeX = 0, shakeY = 0, shakeP = 0, shakeYa = 0, shakeR = 0;
    if (this.trauma > 0.0005) {
      this._shakeTime += dt;
      const decay = this._shakeSustain > 0 ? CFG.camera.shakeDecay * 0.22 : CFG.camera.shakeDecay;
      this._shakeSustain = Math.max(0, this._shakeSustain - dt);
      this.trauma *= Math.exp(-decay * dt);
      if (this.trauma < 0.0005) this.trauma = 0;
      const t = this._shakeTime * this._shakeFreq;
      const k = this.trauma * this.trauma;
      shakeX = noise1(t, 1.7) * k * 0.085;
      shakeY = noise1(t, 4.3) * k * 0.085;
      shakeP = noise1(t, 8.1) * k * 0.045;
      shakeYa = noise1(t, 12.9) * k * 0.045;
      shakeR = noise1(t, 19.4) * k * 0.05;
    } else {
      this.trauma = 0;
    }

    // --- FOV -------------------------------------------------------------
    let fov = CFG.camera.fov;
    if (s.isSprinting) fov += CFG.camera.sprintFovBoost * clamp(s.speed / sprint, 0, 1);
    if (s.isSliding) fov += CFG.camera.slideFovBoost * clamp(s.speed / (sprint * 0.9), 0.25, 1.25);
    // Anything above sprint speed (bhop chains, wall-bounces) opens it further.
    fov += clamp((s.speed - sprint) / Math.max(1, CFG.move.maxSpeedCap - sprint), 0, 1) * 5.5;
    this._fovTarget = fov * this.fovScale;
    this.fov += (this._fovTarget - this.fov) * damp(s.isSliding ? 11 : 7, dt);

    // --- compose ---------------------------------------------------------
    this.forwardFlat(_fwd);
    this.rightFlat(_right);

    const eye = this._eyeSmooth - this.stepOffset + this._dip + bobY + shakeY;
    this.offset.set(
      _right.x * (bobX + shakeX), eye - this._eyeSmooth, _right.z * (bobX + shakeX),
    );

    this.position.set(
      s.px + _right.x * (bobX + shakeX),
      s.py + eye,
      s.pz + _right.z * (bobX + shakeX),
    );

    camera.position.copy(this.position);
    _euler.set(
      clamp(this.pitch + this._lookImpulseP + shakeP, -CFG.camera.maxPitch, CFG.camera.maxPitch),
      this.yaw + this._lookImpulseY + shakeYa,
      this.roll + shakeR,
      'YXZ',
    );
    _q.setFromEuler(_euler);
    camera.quaternion.copy(_q);
    if (Math.abs(camera.fov - this.fov) > 0.01) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
  }
}

export default CameraRig;
