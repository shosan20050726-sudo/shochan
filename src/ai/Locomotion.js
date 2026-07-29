import * as THREE from 'three';
import { J, LEN, solveIK2, setJoint } from './Skeleton.js';

/**
 * Procedural locomotion.
 *
 * Feet are *planted in world space* and only move during an explicit swing —
 * distance-triggered stepping, the same technique used for quadruped rigs.
 * That is what removes foot sliding entirely: a stance foot is nailed to the
 * ground it was placed on, and the body moves over it. Everything above the
 * feet is then derived: pelvis bob and sway from the step phase, spine lean
 * from speed, arms solved by IK onto the weapon the bot is actually holding.
 *
 * No keyframes, no clips, no allocation per frame.
 */

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _aim = new THREE.Vector3();
const _aimR = new THREE.Vector3();
const _aimU = new THREE.Vector3();
const _p = new THREE.Vector3();
const _tmp = new THREE.Vector3();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Bind-pose offsets we rebuild the body from. */
const SPINE = LEN.spine;
const NECK = LEN.neck;
const HIP_X = 0.11;
const SHOULDER_X = 0.19;
const PELVIS_H = 1.00;

/**
 * Hip height as a fraction of the bind pose.
 *
 * The bind skeleton (shared with the ragdoll) has hip-to-ankle 0.874 against a
 * 0.89 m leg, i.e. legs locked straight. Standing at 0.885 buys ~0.44 m of
 * horizontal foot travel before the IK runs out of leg, which is exactly the
 * stride a sprint needs — without it the knees snap straight and the feet
 * skate.
 */
const STAND_K = 0.885;
/**
 * A combat crouch, not a squat. At 0.60 the pelvis dropped so far that the
 * knees had nowhere to go but sideways and the pose read as a sumo stance.
 */
const CROUCH_K = 0.76;
const DOWN_K = 0.40;

/** Furthest a foot may sit from its hip, laterally, before the leg locks. */
const MAX_HALF_STRIDE = 0.44;

export class Gait {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.phase = rng();
    this.foot = [
      { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0, swing: 0, dur: 0.3, planted: true },
      { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0, swing: 0, dur: 0.3, planted: true },
    ];
    this.bob = 0;
    this.sway = 0;
    this.lean = 0;
    this.legScale = 1;
    this.breathe = rng() * 6.28;
    this.downedT = 0;
    this.recoil = 0;
    this.hurt = 0;
    // Public, so the combat code can fire from where the barrel actually is.
    this.muzzle = new THREE.Vector3();
    this.gunPos = new THREE.Vector3();
    this.facing = new THREE.Vector3(0, 0, -1);
    this.aim = new THREE.Vector3(0, 0, -1);
    this._stepSide = rng() < 0.5 ? 0 : 1;
    this._sinceStep = 0;
  }

  /** Snap both feet under the body — used on spawn and after a teleport. */
  reset(x, y, z, yaw) {
    _fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    _right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? -1 : 1;
      const f = this.foot[s];
      // foot.y is the GROUND the foot is standing on; the ankle joint is the
      // bind pose's 0.09 m above it.
      f.x = x + _right.x * side * HIP_X;
      f.y = y;
      f.z = z + _right.z * side * HIP_X;
      f.fx = f.x; f.fy = f.y; f.fz = f.z;
      f.tx = f.x; f.ty = f.y; f.tz = f.z;
      f.swing = 0; f.planted = true;
    }
    this.phase = 0;
    this.downedT = 0;
  }

  /** Kick the upper body when the bot fires. */
  addRecoil(a) { this.recoil = Math.min(1.2, this.recoil + a); }
  addFlinch(a) { this.hurt = Math.min(1, this.hurt + a); }

  /**
   * @param {number} dt
   * @param {object} s  {x,y,z,yaw,speed,crouch,downed,ready,aimX,aimY,aimZ,groundAt}
   * @param {Float32Array} pose  destination, 45 floats
   */
  update(dt, s, pose) {
    // HARD CLAMP. Every smoothing term here is `x += (target - x) * (1 -
    // exp(-k*dt))`, which inverts sign for dt < 0 and multiplies the state by a
    // large negative number instead of easing it. The engine's very first frame
    // can hand out a negative dt (the rAF timestamp predates the
    // performance.now() captured when the loop started), and one such frame is
    // enough to launch a bot's smoothed state to 1e36 and put the body in orbit.
    dt = dt > 0 ? (dt < 0.05 ? dt : 0.05) : 0;

    this.recoil *= Math.exp(-11 * dt);
    this.hurt *= Math.exp(-6 * dt);
    this.breathe += dt * 1.35;

    _fwd.set(-Math.sin(s.yaw), 0, -Math.cos(s.yaw));
    _right.set(Math.cos(s.yaw), 0, -Math.sin(s.yaw));
    this.facing.copy(_fwd);

    _aim.set(s.aimX, s.aimY, s.aimZ);
    if (_aim.lengthSq() < 1e-8) _aim.copy(_fwd);
    _aim.normalize();
    this.aim.copy(_aim);
    _aimR.crossVectors(_aim, _up);
    if (_aimR.lengthSq() < 1e-6) _aimR.copy(_right);
    _aimR.normalize();
    _aimU.crossVectors(_aimR, _aim).normalize();

    const targetLeg = s.downed ? DOWN_K : (s.crouch ? CROUCH_K : STAND_K);
    this.legScale += (targetLeg - this.legScale) * (1 - Math.exp(-9 * dt));
    // Belt and braces: these are the two values a bad frame can turn into a
    // catapult, so they are also range-clamped, not just eased.
    this.legScale = clamp(this.legScale, DOWN_K * 0.5, 1.05);

    if (s.downed) this.downedT = Math.min(1, this.downedT + dt * 2.4);
    else this.downedT = Math.max(0, this.downedT - dt * 2.0);
    this.downedT = clamp(this.downedT, 0, 1);

    this._steps(dt, s);
    this._build(dt, s, pose);
  }

  /* ------------------------------------------------------------ feet -- */

  _steps(dt, s) {
    const speed = s.speed;
    // Real gait mechanics, derived rather than tuned by eye:
    //   half   how far ahead of / behind the hip a foot may be planted
    //   stance how long it stays down (it must travel 2*half in that time)
    //   swing  the rest of the cycle
    // Solving it this way means the cadence rises with speed on its own and
    // the foot is *never* asked to reach further than the leg can go.
    const crouchK = s.crouch ? 0.62 : 1;
    const half = clamp(0.16 + speed * 0.055, 0.15, MAX_HALF_STRIDE) * crouchK;
    const stance = clamp((half * 2) / Math.max(speed, 0.35), 0.15, 0.62);
    const swingFrac = clamp(0.40 + speed * 0.021, 0.40, 0.54);
    const cycle = stance / (1 - swingFrac);
    const swingDur = cycle * swingFrac;
    const trigger = Math.max(0.15, half);
    this._sinceStep += dt;
    this._half = half;

    const anySwing = !this.foot[0].planted || !this.foot[1].planted;

    for (let i = 0; i < 2; i++) {
      const f = this.foot[i];
      if (f.planted) continue;
      f.swing += dt / Math.max(0.06, f.dur);
      const t = clamp(f.swing, 0, 1);
      const e = smooth(t);
      f.x = f.fx + (f.tx - f.fx) * e;
      f.z = f.fz + (f.tz - f.fz) * e;
      const lift = 0.05 + half * 0.24;
      f.y = f.fy + (f.ty - f.fy) * e + Math.sin(Math.PI * t) * lift;
      if (t >= 1) {
        f.planted = true;
        f.x = f.tx; f.y = f.ty; f.z = f.tz;
        this._sinceStep = 0;
      }
    }

    if (anySwing) return;

    // Both planted: does either need to move?
    let worst = -1, worstErr = 0;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const nx = s.x + _right.x * side * HIP_X;
      const nz = s.z + _right.z * side * HIP_X;
      const f = this.foot[i];
      const err = Math.hypot(f.x - nx, f.z - nz) + Math.abs(f.y - s.y) * 0.7;
      if (err > worstErr) { worstErr = err; worst = i; }
    }
    if (worst < 0 || worstErr < trigger) return;
    // The foot furthest from where it should be goes next, which alternates on
    // its own: planting one forward leaves the other trailing.
    const i = worst;
    const side = i === 0 ? -1 : 1;
    const f = this.foot[i];

    // Land where the hip *will be* when the swing ends, plus half a stride —
    // that is what stops the legs trailing further behind every step.
    const ahead = speed > 0.25 ? speed * swingDur + half : 0;
    let tx = s.x + _right.x * side * HIP_X + _fwd.x * ahead;
    let tz = s.z + _right.z * side * HIP_X + _fwd.z * ahead;
    let ty = s.y;
    if (s.groundAt) ty = s.groundAt(tx, tz, s.y);

    f.fx = f.x; f.fy = f.y; f.fz = f.z;
    f.tx = tx; f.ty = ty; f.tz = tz;
    f.swing = 0;
    f.dur = clamp(swingDur, 0.14, 0.5);
    f.planted = false;
    this._stepSide = 1 - i;
  }

  /* ------------------------------------------------------------ pose -- */

  _build(dt, s, pose) {
    const speed = s.speed;
    const legK = this.legScale;

    // Step phase, derived from the swinging foot, drives bob and sway.
    let swingT = 0, swingSide = 0;
    for (let i = 0; i < 2; i++) {
      if (!this.foot[i].planted) { swingT = clamp(this.foot[i].swing, 0, 1); swingSide = i === 0 ? -1 : 1; }
    }
    const moving = speed > 0.35;
    const bobTarget = moving ? -Math.sin(Math.PI * swingT) * (0.016 + Math.min(0.028, speed * 0.006)) : 0;
    this.bob += (bobTarget - this.bob) * (1 - Math.exp(-16 * dt));
    const swayTarget = moving ? swingSide * Math.sin(Math.PI * swingT) * 0.035 : 0;
    this.sway += (swayTarget - this.sway) * (1 - Math.exp(-11 * dt));
    const leanTarget = s.downed ? 0 : clamp(speed * 0.030, 0, 0.24) + this.recoil * 0.05;
    this.lean += (leanTarget - this.lean) * (1 - Math.exp(-7 * dt));
    this.bob = clamp(this.bob, -0.12, 0.12);
    this.sway = clamp(this.sway, -0.12, 0.12);
    this.lean = clamp(this.lean, -0.3, 0.6);

    const breath = Math.sin(this.breathe) * (moving ? 0.002 : 0.008);

    // --- pelvis ---------------------------------------------------------
    const pelvisY = s.y + PELVIS_H * legK + this.bob + breath;
    let px = s.x + _right.x * this.sway;
    let pz = s.z + _right.z * this.sway;
    if (this.downedT > 0.01) {
      // Slumped onto one hip.
      px += _right.x * this.downedT * 0.10;
      pz += _right.z * this.downedT * 0.10;
    }
    setJoint(pose, J.PELVIS, px, pelvisY, pz);

    // --- spine ----------------------------------------------------------
    const lean = this.lean + this.downedT * 0.85 + this.hurt * 0.12;
    const spineLen = SPINE * (s.crouch && !s.downed ? 0.98 : 1);
    const cs = Math.cos(lean), sn = Math.sin(lean);
    const chestX = px + (_up.x * cs + _fwd.x * sn) * spineLen;
    const chestY = pelvisY + (_up.y * cs + _fwd.y * sn) * spineLen;
    const chestZ = pz + (_up.z * cs + _fwd.z * sn) * spineLen;
    setJoint(pose, J.CHEST, chestX, chestY, chestZ);

    // --- head: looks along the aim, with the neck resisting extremes ----
    const headLean = lean * 0.35 + this.downedT * 0.5;
    _tmp.set(
      _up.x * Math.cos(headLean) + _fwd.x * Math.sin(headLean),
      _up.y * Math.cos(headLean) + _fwd.y * Math.sin(headLean),
      _up.z * Math.cos(headLean) + _fwd.z * Math.sin(headLean));
    setJoint(pose, J.HEAD,
      chestX + _tmp.x * NECK, chestY + _tmp.y * NECK, chestZ + _tmp.z * NECK);

    // --- shoulders -------------------------------------------------------
    const sx = _right.x * SHOULDER_X, sz = _right.z * SHOULDER_X;
    const shY = chestY + 0.02;
    setJoint(pose, J.SHOULDER_L, chestX - sx, shY, chestZ - sz);
    setJoint(pose, J.SHOULDER_R, chestX + sx, shY, chestZ + sz);

    // --- hips -------------------------------------------------------------
    const hx = _right.x * HIP_X, hz = _right.z * HIP_X;
    setJoint(pose, J.HIP_L, px - hx, pelvisY - 0.02, pz - hz);
    setJoint(pose, J.HIP_R, px + hx, pelvisY - 0.02, pz + hz);

    // --- feet + knees ------------------------------------------------------
    if (this.downedT > 0.5) {
      this._downedLegs(pose, px, pelvisY, pz);
    } else {
      for (let i = 0; i < 2; i++) {
        const f = this.foot[i];
        const foot = i === 0 ? J.FOOT_L : J.FOOT_R;
        const knee = i === 0 ? J.KNEE_L : J.KNEE_R;
        const hip = i === 0 ? J.HIP_L : J.HIP_R;
        setJoint(pose, foot, f.x, f.y + 0.09, f.z);
        // Knees always break forward, and outward a touch when crouched.
        const outward = (i === 0 ? -1 : 1) * (s.crouch ? 0.11 : 0.12);
        solveIK2(pose, hip, knee, foot, LEN.thigh, LEN.shin,
          _fwd.x + _right.x * outward, 0.08, _fwd.z + _right.z * outward);
      }
    }

    // --- weapon + arms ------------------------------------------------------
    this._arms(pose, s, chestX, chestY, chestZ);
  }

  /** Kneeling collapse: knees on the deck, feet tucked behind. */
  _downedLegs(pose, px, py, pz) {
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const foot = i === 0 ? J.FOOT_L : J.FOOT_R;
      const knee = i === 0 ? J.KNEE_L : J.KNEE_R;
      const kx = px + _fwd.x * 0.22 + _right.x * side * 0.16;
      const kz = pz + _fwd.z * 0.22 + _right.z * side * 0.16;
      const ky = py - 0.34;
      setJoint(pose, knee, kx, ky, kz);
      setJoint(pose, foot,
        kx - _fwd.x * 0.40 + _right.x * side * 0.03,
        ky - 0.06,
        kz - _fwd.z * 0.40 + _right.z * side * 0.03);
    }
  }

  /**
   * Hands go on the gun, then the arms are solved to the hands. Doing it in
   * that order is why the rifle never floats away from the grip.
   */
  _arms(pose, s, cx, cy, cz) {
    const ready = s.downed ? 0 : clamp(s.ready ?? 1, 0, 1);
    // Lowered carry drops the muzzle and pulls the weapon into the body.
    const lowered = 1 - ready;
    _p.set(cx, cy, cz);

    // Held out far enough that the receiver clears the chest plate and the
    // arms actually extend; the left-hand reach below is what caps how far
    // forward this can go before the support arm locks straight.
    const outX = 0.11 + lowered * 0.04;
    const upY = -0.04 - lowered * 0.20 - this.downedT * 0.16;
    const fwdZ = 0.22 - lowered * 0.03 - this.recoil * 0.05;

    this.gunPos.set(
      _p.x + _aimR.x * outX + _aimU.x * upY + _aim.x * fwdZ,
      _p.y + _aimR.y * outX + _aimU.y * upY + _aim.y * fwdZ,
      _p.z + _aimR.z * outX + _aimU.z * upY + _aim.z * fwdZ);

    // The barrel line: shots leave here, so tracers line up with the model.
    this.muzzle.set(
      this.gunPos.x + _aim.x * 0.60 + _aimU.x * 0.04,
      this.gunPos.y + _aim.y * 0.60 + _aimU.y * 0.04,
      this.gunPos.z + _aim.z * 0.60 + _aimU.z * 0.04);

    // Right hand on the grip, left on the handguard.
    setJoint(pose, J.HAND_R, this.gunPos.x, this.gunPos.y, this.gunPos.z);
    const lh = 0.22 - lowered * 0.04;
    let lx = this.gunPos.x + _aim.x * lh + _aimU.x * 0.035;
    let ly = this.gunPos.y + _aim.y * lh + _aimU.y * 0.035;
    let lz = this.gunPos.z + _aim.z * lh + _aimU.z * 0.035;
    // Never ask the support arm for more than it has. Aiming hard to one side
    // or dropping to low ready both stretch this reach, and a locked-straight
    // arm is the tell that a rig is being driven past its limits.
    const sl = J.SHOULDER_L * 3;
    const dxl = lx - pose[sl], dyl = ly - pose[sl + 1], dzl = lz - pose[sl + 2];
    const dl = Math.hypot(dxl, dyl, dzl);
    const maxL = (LEN.upperArm + LEN.foreArm) * 0.94;
    if (dl > maxL) {
      const k = maxL / dl;
      lx = pose[sl] + dxl * k; ly = pose[sl + 1] + dyl * k; lz = pose[sl + 2] + dzl * k;
    }
    setJoint(pose, J.HAND_L, lx, ly, lz);

    // Elbows: right flares out, left tucks under. Classic rifle stance.
    solveIK2(pose, J.SHOULDER_R, J.ELBOW_R, J.HAND_R, LEN.upperArm, LEN.foreArm,
      -_aimU.x * 0.75 + _aimR.x * 0.62,
      -_aimU.y * 0.75 + _aimR.y * 0.62,
      -_aimU.z * 0.75 + _aimR.z * 0.62);
    solveIK2(pose, J.SHOULDER_L, J.ELBOW_L, J.HAND_L, LEN.upperArm, LEN.foreArm,
      -_aimU.x * 0.92 - _aimR.x * 0.28,
      -_aimU.y * 0.92 - _aimR.y * 0.28,
      -_aimU.z * 0.92 - _aimR.z * 0.28);
  }
}

export default Gait;
