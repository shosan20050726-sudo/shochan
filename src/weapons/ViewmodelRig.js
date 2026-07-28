import * as THREE from 'three';
import CFG from '../core/Config.js';
import {
  Spring, Spring3, clamp, clamp01, lerp, damp, smooth, track, pulse,
  valueNoise, EASE, DEG,
} from './MathKit.js';

/**
 * Procedural viewmodel animation.
 *
 * There is no keyframe data anywhere in this file that a hand could not have
 * been placed on: everything is springs, curves and phase offsets. The rules
 * that make it read as a heavy metal object rather than a floating prop:
 *
 *   - Nothing moves linearly. Pose changes ride critically-to-under damped
 *     springs so they overshoot slightly and settle.
 *   - Rotation happens about the hand (model origin) for sway and about a
 *     point behind the receiver for recoil, which is where a shoulder is.
 *   - The gun always LAGS the camera. Sway targets are driven by angular
 *     *rate*, not by absolute angles, so a flick throws the weapon and a slow
 *     pan barely moves it.
 *   - Every discrete event (shot, mag seat, bolt release, weapon raise) adds
 *     a velocity impulse rather than setting a position, so impacts add up.
 *
 * Transform chain (outermost first):
 *   root -> kick -> kickIn -> pose -> sway -> model
 */

const _v = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'XYZ');
const _q = new THREE.Quaternion();

const RELOAD = {
  /* mag-fed rifle/SMG/LMG reload, normalised time */
  tipRot: [[0, 0], [0.14, 1, 'out3'], [0.72, 1], [0.94, 0, 'inOut'], [1, 0]],
  magDrop: [[0, 0], [0.13, 0], [0.30, 1, 'in2'], [0.42, 1]],
  magIn: [[0, 1], [0.44, 1], [0.62, 0.12, 'out3'], [0.70, 0, 'outSlam'], [1, 0]],
  chargePull: [[0, 0], [0.74, 0], [0.84, 1, 'out2'], [0.90, 0, 'in3'], [1, 0]],
};

export default class ViewmodelRig {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'vm-root';
    this.kick = new THREE.Group();
    this.kickIn = new THREE.Group();
    this.pose = new THREE.Group();
    this.sway = new THREE.Group();
    this.root.add(this.kick);
    this.kick.add(this.kickIn);
    this.kickIn.add(this.pose);
    this.pose.add(this.sway);
    for (const g of [this.root, this.kick, this.kickIn, this.pose, this.sway]) g.frustumCulled = false;

    // recoil pivot: behind the receiver, roughly at the shoulder
    this.pivot = new THREE.Vector3(0.02, -0.03, 0.20);
    this.kick.position.copy(this.pivot);
    this.kickIn.position.copy(this.pivot).multiplyScalar(-1);

    this.posS = new Spring3(30, 0.86);
    this.rotS = new Spring3(27, 0.80);
    this.kickPos = new Spring3(38, 0.42);
    this.kickRot = new Spring3(34, 0.38);
    this.swayRot = new Spring3(12, 0.60);
    this.swayPos = new Spring3(14, 0.68);
    this.landS = new Spring(24, 0.45);

    this.hipPos = new THREE.Vector3(0.13, -0.13, -0.29);
    this.hipRot = new THREE.Vector3(0.03, 0.17, -0.05);
    this.adsPos = new THREE.Vector3();
    this.adsRot = new THREE.Vector3();
    this.presentPos = new THREE.Vector3(0.112, -0.118, -0.285);
    this.presentRot = new THREE.Vector3(0.035, 0.46, -0.085);

    this.addPos = new THREE.Vector3();
    this.addRot = new THREE.Vector3();

    this.ads = 0;             // eased 0..1
    this.adsRaw = 0;
    this.sprintT = 0;
    this.crouchT = 0;
    this.bobPhase = 0;
    this.time = 0;
    this.presentT = 0;
    this.present = false;

    this.reload = { active: false, t: 0, dur: 1, empty: false, style: 'mag', shells: 0, shellT: 0, phase: '' };
    this.swap = { mode: null, t: 0, dur: 0.2 };
    this.inspect = { active: false, t: 0, dur: 2.3 };
    this.boltCycle = { active: false, t: 0, dur: 0.6 };

    this.vm = null;
    this.def = null;
    this.hidden = false;
  }

  /* ------------------------------------------------------------- equip -- */

  setWeapon(vm, def) {
    if (this.vm && this.vm.root.parent === this.sway) this.sway.remove(this.vm.root);
    this.vm = vm;
    this.def = def;
    if (!vm) return;
    this.sway.add(vm.root);

    const h = def.hip || {};
    if (h.pos) this.hipPos.set(h.pos[0], h.pos[1], h.pos[2]);
    if (h.rot) this.hipRot.set(h.rot[0], h.rot[1], h.rot[2]);

    // ADS pose: put the sight exactly on the optical axis, eye relief in front.
    const relief = def.eyeRelief ?? 0.30;
    this.adsPos.set(-vm.sight.x, -vm.sight.y, -relief - vm.sight.z);
    this.adsRot.set(0, 0, 0);

    // The showcase pose is the hip pose rotated to present the left flank.
    this.presentPos.set(this.hipPos.x - 0.012, this.hipPos.y + 0.004, this.hipPos.z - 0.012);
    this.presentRot.set(this.hipRot.x + 0.010, this.hipRot.y + 0.255, this.hipRot.z - 0.030);

    this.nodes = vm.nodes;
    this.restBolt = vm.nodes.bolt ? vm.nodes.bolt.position.clone() : null;
    this.restMag = vm.nodes.mag ? vm.nodes.mag.position.clone() : null;
    this.restCharge = vm.nodes.charge ? vm.nodes.charge.position.clone() : null;
    this.restPump = vm.nodes.pump ? vm.nodes.pump.position.clone() : null;
    this.restCyl = vm.nodes.cyl ? vm.nodes.cyl.position.clone() : null;
    this.restTrigger = vm.nodes.trigger ? vm.nodes.trigger.position.clone() : null;
  }

  /** Drop the rig straight onto its current target — used by debugPresent. */
  snap() {
    this._composeTarget(1 / 60, null, true);
    this.posS.snap();
    this.rotS.snap();
    this.kickPos.set(0, 0, 0);
    this.kickRot.set(0, 0, 0);
    this.swayRot.set(0, 0, 0);
    this.swayPos.set(0, 0, 0);
    this._apply();
  }

  /* ------------------------------------------------------------ events -- */

  /** Recoil impulse. `side` is the horizontal component of the pattern step. */
  onFire(def, side = 0, rand = 0.5, adsMul = 1) {
    const k = def.kick || {};
    const s = (1 - this.ads * 0.42) * adsMul;
    const dir = side >= 0 ? 1 : -1;
    this.kickPos.kick(
      (k.side ?? 0.2) * dir * (0.35 + rand * 0.5) * s,
      (k.up ?? 0.3) * (0.8 + rand * 0.4) * s,
      (k.back ?? 0.8) * (0.85 + rand * 0.3) * s,
    );
    this.kickRot.kick(
      -(k.pitch ?? 3) * DEG * 10 * (0.85 + rand * 0.3) * s,
      (k.yaw ?? 1.5) * DEG * 10 * -dir * (0.5 + rand * 0.7) * s,
      (k.roll ?? 2) * DEG * 10 * dir * (0.6 + rand * 0.6) * s,
    );
    // trigger finger + bolt slam
    this._triggerT = 0.09;
    if (this.nodes?.bolt && !this.def?.boltAction) this._boltT = 0.055;
    this.sprintT = 0;
  }

  startReload(def, empty) {
    const style = def.shellReload ? 'shell' : def.revolver ? 'revolver' : 'mag';
    const dur = empty ? def.reloadEmpty : def.reloadTactical;
    this.reload.active = true;
    this.reload.t = 0;
    this.reload.dur = Math.max(0.2, dur);
    this.reload.empty = !!empty;
    this.reload.style = style;
    this.inspect.active = false;
  }

  /** Shell-by-shell guns report each inserted round so the rig can jolt. */
  onShellLoaded() {
    this.kickPos.kick(0, -0.10, 0.10);
    this.kickRot.kick(0.5, 0.25, -0.35);
  }

  cancelReload() { this.reload.active = false; }

  startSwitch(mode, dur) {
    this.swap.mode = mode;
    this.swap.t = 0;
    this.swap.dur = Math.max(0.08, dur);
    if (mode === 'in') {
      // a raise is a throw, not a slide
      this.posS.x.y -= 0.16;
      this.posS.v.y += 0.35;
      this.rotS.x.x += 0.30;
    }
  }

  startInspect() {
    if (this.reload.active || this.swap.mode) return;
    this.inspect.active = true;
    this.inspect.t = 0;
  }

  startBoltCycle(dur) {
    this.boltCycle.active = true;
    this.boltCycle.t = 0;
    this.boltCycle.dur = Math.max(0.15, dur);
  }

  land(speed) {
    const g = clamp(speed / 12, 0, 1.6);
    this.landS.kick(-1.6 - g * 3.4);
    this.kickRot.kick(-3.0 * g, 0, 1.2 * g);
  }

  jump() { this.landS.kick(0.9); }

  setPresent(on) { this.present = !!on; }

  /* ------------------------------------------------------------ update -- */

  update(dt, st) {
    if (dt > 0.1) dt = 0.1;
    this.time += dt;
    this._composeTarget(dt, st, false);

    this.posS.step(dt);
    this.rotS.step(dt);
    this.kickPos.step(dt);
    this.kickRot.step(dt);
    this.swayRot.step(dt);
    this.swayPos.step(dt);
    this.landS.step(dt);

    this._apply();
    this._animateNodes(dt);
  }

  _composeTarget(dt, st, instant) {
    const s = st || {};
    const def = this.def || {};

    /* ---- ADS ------------------------------------------------------------ */
    const adsTime = Math.max(0.05, def.adsTime ?? 0.25);
    const want = s.wantAds ? 1 : 0;
    const rate = want ? 1 / adsTime : 1 / (adsTime * 0.78);
    this.adsRaw = clamp01(this.adsRaw + (want ? rate : -rate) * dt);
    if (instant) this.adsRaw = want;
    // Slight ease-out at the end so the sight "arrives" instead of stopping.
    this.ads = want ? EASE.out3(this.adsRaw) : EASE.inOut(this.adsRaw);

    /* ---- stance blends -------------------------------------------------- */
    const sprintWant = s.sprinting && !this.reload.active && !s.firing ? 1 : 0;
    this.sprintT += (sprintWant - this.sprintT) * damp(sprintWant ? 8.5 : 13, dt);
    const crouchWant = s.crouching ? 1 : 0;
    this.crouchT += (crouchWant - this.crouchT) * damp(9, dt);
    if (instant) { this.sprintT = 0; this.crouchT = 0; }

    /* ---- base pose ------------------------------------------------------ */
    const presentWant = this.present ? 1 : 0;
    this.presentT += (presentWant - this.presentT) * damp(7, dt);
    if (instant) this.presentT = presentWant;

    const a = this.ads * (1 - this.presentT);
    const P = _v.set(
      lerp(this.hipPos.x, this.adsPos.x, a),
      lerp(this.hipPos.y, this.adsPos.y, a),
      lerp(this.hipPos.z, this.adsPos.z, a),
    );
    const tx = lerp(P.x, this.presentPos.x, this.presentT);
    const ty = lerp(P.y, this.presentPos.y, this.presentT);
    const tz = lerp(P.z, this.presentPos.z, this.presentT);
    let rx = lerp(lerp(this.hipRot.x, this.adsRot.x, a), this.presentRot.x, this.presentT);
    let ry = lerp(lerp(this.hipRot.y, this.adsRot.y, a), this.presentRot.y, this.presentT);
    let rz = lerp(lerp(this.hipRot.z, this.adsRot.z, a), this.presentRot.z, this.presentT);

    const add = this.addPos.set(0, 0, 0);
    const rot = this.addRot.set(0, 0, 0);
    const hipW = 1 - a;   // most additive motion is suppressed while aiming

    /* ---- walk / sprint bob --------------------------------------------- */
    const moveFrac = clamp(s.moveFrac ?? 0, 0, 1.5);
    const grounded = s.onGround !== false;
    const bobSpeed = (CFG.camera.bobSpeed ?? 11) * (this.sprintT > 0.5 ? 0.62 : 1);
    if (grounded) this.bobPhase += dt * bobSpeed * clamp(moveFrac, 0, 1.3);
    const bobAmp = (CFG.camera.bobAmount ?? 0.028) * clamp(moveFrac, 0, 1.2)
      * (grounded ? 1 : 0.25) * (0.30 + 0.70 * hipW) * (1 + this.sprintT * 1.35);
    const p = this.bobPhase;
    add.x += Math.sin(p) * bobAmp * 1.55;
    add.y += (Math.cos(p * 2) * 0.5 - 0.5) * bobAmp * 1.05;
    add.z += Math.sin(p * 2 + 0.8) * bobAmp * 0.55;
    rot.z += Math.sin(p) * 0.055 * moveFrac * hipW;
    rot.x += Math.sin(p * 2 + 1.1) * 0.028 * moveFrac * hipW;
    rot.y += Math.sin(p) * 0.038 * moveFrac * hipW;

    /* ---- idle breathing ------------------------------------------------- */
    const idle = (1 - clamp01(moveFrac * 2)) * (0.35 + 0.65 * hipW);
    const t = this.time;
    add.x += valueNoise(t * 0.42, 3) * 0.0042 * idle;
    add.y += (valueNoise(t * 0.37, 11) * 0.0038 + Math.sin(t * 1.15) * 0.0016) * idle;
    rot.x += Math.sin(t * 1.15 + 0.4) * 0.0085 * idle;
    rot.y += valueNoise(t * 0.31, 23) * 0.014 * idle;
    rot.z += valueNoise(t * 0.27, 41) * 0.012 * idle;

    /* ---- sprint pose ---------------------------------------------------- */
    if (this.sprintT > 0.001) {
      const k = this.sprintT * hipW;
      add.x += 0.030 * k; add.y += -0.052 * k; add.z += 0.058 * k;
      rot.x += -0.30 * k; rot.y += -0.62 * k; rot.z += 0.50 * k;
    }

    /* ---- crouch --------------------------------------------------------- */
    add.y += 0.012 * this.crouchT * hipW;
    add.z += 0.010 * this.crouchT * hipW;

    /* ---- air / land ----------------------------------------------------- */
    const vy = clamp(s.vy ?? 0, -18, 12);
    if (!grounded) {
      add.y += clamp(-vy * 0.0045, -0.045, 0.045) * hipW;
      rot.x += clamp(-vy * 0.006, -0.07, 0.07) * hipW;
    }
    this.landS.target = 0;
    add.y += this.landS.x * 0.022 * (0.35 + 0.65 * hipW);
    rot.x += this.landS.x * 0.030 * (0.35 + 0.65 * hipW);

    /* ---- timelines ------------------------------------------------------ */
    if (!instant) {
      this._reloadPose(dt, add, rot, hipW);
      this._swapPose(dt, add, rot);
      this._inspectPose(dt, add, rot, hipW);
    }

    this.posS.target.set(tx + add.x, ty + add.y, tz + add.z);
    this.rotS.target.set(rx + rot.x, ry + rot.y, rz + rot.z);

    /* ---- sway ----------------------------------------------------------- */
    const swayK = (0.20 + 0.80 * hipW);
    const yawRate = clamp(s.yawRate ?? 0, -9, 9);
    const pitchRate = clamp(s.pitchRate ?? 0, -9, 9);
    const lim = 0.16 * swayK;
    this.swayRot.target.set(
      clamp(-pitchRate * 0.042, -lim, lim) * swayK,
      clamp(-yawRate * 0.050, -lim * 1.3, lim * 1.3) * swayK,
      clamp(yawRate * 0.030, -lim, lim) * swayK,
    );
    const plim = 0.030 * swayK;
    this.swayPos.target.set(
      clamp(yawRate * 0.0105, -plim, plim),
      clamp(-pitchRate * 0.0085, -plim, plim),
      clamp(Math.abs(yawRate) * 0.0022, 0, plim * 0.6),
    );
    // Strafing pushes the weapon sideways in the hands.
    this.swayPos.target.x += clamp(-(s.strafe ?? 0) * 0.016, -0.02, 0.02) * hipW;
    this.swayRot.target.z += clamp((s.strafe ?? 0) * 0.055, -0.07, 0.07) * hipW;

    if (instant) {
      this.swayRot.target.set(0, 0, 0);
      this.swayPos.target.set(0, 0, 0);
    }
  }

  /* --------------------------------------------------------- timelines -- */

  _reloadPose(dt, add, rot, hipW) {
    const r = this.reload;
    if (!r.active) return;
    r.t += dt;
    const u = clamp01(r.t / r.dur);
    if (r.t >= r.dur) r.active = false;

    if (r.style === 'shell') return this._shellPose(u, add, rot);
    if (r.style === 'revolver') return this._revolverPose(u, add, rot);

    const tip = track(u, RELOAD.tipRot);
    add.x += -0.030 * tip; add.y += -0.052 * tip; add.z += 0.030 * tip;
    rot.x += 0.26 * tip; rot.y += 0.30 * tip; rot.z += -0.44 * tip;
    // hand pulls the gun down a touch as the fresh mag is driven home
    add.y += -0.020 * pulse(u, 0.56, 0.66, 0.78, 'out2', 'out3');
    rot.x += 0.10 * pulse(u, 0.56, 0.64, 0.80, 'out2', 'out3');
    if (r.empty) rot.z += -0.10 * pulse(u, 0.74, 0.84, 0.95, 'out2', 'in2');
    this._reloadU = u;
  }

  _shellPose(u, add, rot) {
    // Gun rolls over so the loading gate faces the hand, stays there, then a
    // hard pump at the end.
    const hold = track(u, [[0, 0], [0.20, 1, 'out3'], [0.80, 1], [0.96, 0, 'inOut'], [1, 0]]);
    add.x += -0.040 * hold; add.y += -0.030 * hold; add.z += 0.026 * hold;
    rot.x += 0.14 * hold; rot.y += 0.44 * hold; rot.z += -0.62 * hold;
    const pump = pulse(u, 0.80, 0.88, 0.98, 'out2', 'out3');
    add.z += 0.022 * pump;
    rot.x += -0.10 * pump;
    this._pumpU = pump;
  }

  _revolverPose(u, add, rot) {
    const open = track(u, [[0, 0], [0.16, 1, 'out3'], [0.74, 1], [0.90, 0, 'outBack'], [1, 0]]);
    add.x += -0.026 * open; add.y += -0.040 * open; add.z += 0.030 * open;
    rot.x += 0.24 * open; rot.y += 0.52 * open; rot.z += -0.80 * open;
    this._cylU = open;
    this._cylSpin = track(u, [[0, 0], [0.30, 0], [0.62, 1, 'out3'], [1, 1]]);
    // wrist flick that snaps the cylinder shut
    rot.z += 0.22 * pulse(u, 0.86, 0.92, 1.0, 'out2', 'in2');
  }

  _swapPose(dt, add, rot) {
    const s = this.swap;
    if (!s.mode) return;
    s.t += dt;
    const u = clamp01(s.t / s.dur);
    if (u >= 1) { s.mode = null; this.hidden = false; return; }
    const k = s.mode === 'out' ? EASE.in2(u) : 1 - EASE.out3(u);
    add.y += -0.28 * k;
    add.z += 0.10 * k;
    rot.x += 0.95 * k;
    rot.z += -0.35 * k;
    rot.y += 0.30 * k;
  }

  _inspectPose(dt, add, rot, hipW) {
    const i = this.inspect;
    if (!i.active) return;
    i.t += dt;
    const u = clamp01(i.t / i.dur);
    if (u >= 1) { i.active = false; this._inspectMag = 0; return; }
    const w = hipW;
    const turn = track(u, [[0, 0], [0.16, 1, 'out3'], [0.42, 1], [0.55, -0.55, 'inOut'],
      [0.72, -0.55], [0.90, 0, 'inOut'], [1, 0]]);
    const lift = track(u, [[0, 0], [0.14, 1, 'out3'], [0.80, 1], [0.96, 0, 'inOut'], [1, 0]]);
    add.x += -0.055 * lift * w;
    add.y += 0.020 * lift * w;
    add.z += 0.075 * lift * w;
    rot.y += 1.15 * turn * w;
    rot.z += -0.35 * turn * w;
    rot.x += 0.16 * lift * w + 0.22 * turn * w;
    this._inspectMag = pulse(u, 0.44, 0.55, 0.70, 'out2', 'out3');
  }

  /* ------------------------------------------------------------- apply -- */

  _apply() {
    this.pose.position.copy(this.posS.x);
    _e.set(this.rotS.x.x, this.rotS.x.y, this.rotS.x.z, 'XYZ');
    this.pose.quaternion.setFromEuler(_e);

    this.sway.position.copy(this.swayPos.x);
    _e.set(this.swayRot.x.x, this.swayRot.x.y, this.swayRot.x.z, 'XYZ');
    this.sway.quaternion.setFromEuler(_e);

    this.kick.position.set(
      this.pivot.x + this.kickPos.x.x,
      this.pivot.y + this.kickPos.x.y,
      this.pivot.z + this.kickPos.x.z,
    );
    _e.set(this.kickRot.x.x, this.kickRot.x.y, this.kickRot.x.z, 'XYZ');
    this.kick.quaternion.setFromEuler(_e);
  }

  /** Moving parts: bolt, magazine, charging handle, pump, cylinder, trigger. */
  _animateNodes(dt) {
    const n = this.nodes;
    if (!n) return;
    const r = this.reload;
    const u = r.active ? clamp01(r.t / r.dur) : -1;

    // --- bolt / slide reciprocation
    if (n.bolt && this.restBolt) {
      let z = 0;
      if (this._boltT != null && this._boltT > 0) {
        this._boltT -= dt;
        const k = clamp01(this._boltT / 0.055);
        z = Math.sin(k * Math.PI) * 0.026;
      }
      if (this.boltCycle.active) {
        this.boltCycle.t += dt;
        const bu = clamp01(this.boltCycle.t / this.boltCycle.dur);
        if (bu >= 1) this.boltCycle.active = false;
        z = track(bu, [[0, 0], [0.10, 0.004, 'out2'], [0.42, 0.055, 'out3'],
          [0.72, 0.055], [0.92, 0, 'in3'], [1, 0]]);
        n.bolt.rotation.z = track(bu, [[0, 0], [0.12, -0.9, 'out3'], [0.80, -0.9], [0.95, 0, 'in2'], [1, 0]]);
      } else n.bolt.rotation.z = 0;
      if (u >= 0 && r.empty && r.style === 'mag') {
        z = Math.max(z, track(u, RELOAD.chargePull) * 0.05);
      }
      n.bolt.position.z = this.restBolt.z + z;
    }

    // --- magazine
    if (n.mag && this.restMag) {
      let drop = 0, ins = 0;
      if (u >= 0 && r.style === 'mag') {
        drop = track(u, RELOAD.magDrop);
        ins = track(u, RELOAD.magIn);
      }
      const insertOff = ins * 0.30;
      n.mag.position.set(
        this.restMag.x + drop * 0.012 - insertOff * 0.16,
        this.restMag.y - drop * 0.46 - insertOff,
        this.restMag.z + drop * 0.02 + insertOff * 0.10,
      );
      n.mag.rotation.set(-drop * 0.55 + ins * 0.30, 0, drop * 0.22);
      n.mag.scale.setScalar(1);
      const inspectMag = this._inspectMag || 0;
      if (inspectMag > 0) {
        n.mag.position.y -= inspectMag * 0.030;
        n.mag.rotation.x -= inspectMag * 0.18;
      }
      n.mag.visible = !(drop > 0.55 && ins > 0.55);
    }

    // --- charging handle
    if (n.charge && this.restCharge) {
      let z = 0;
      if (u >= 0 && r.empty && r.style === 'mag') z = track(u, RELOAD.chargePull) * 0.062;
      if (this._boltT != null && this._boltT > 0) z = Math.max(z, Math.sin(clamp01(this._boltT / 0.055) * Math.PI) * 0.010);
      n.charge.position.z = this.restCharge.z + z;
    }

    // --- shotgun pump
    if (n.pump && this.restPump) {
      let z = (this._pumpU || 0) * 0.062;
      if (this._cycleT != null && this._cycleT > 0) {
        this._cycleT -= dt;
        const k = 1 - clamp01(this._cycleT / 0.34);
        z = Math.max(z, Math.sin(k * Math.PI) * 0.070);
      }
      n.pump.position.z = this.restPump.z + z;
      this._pumpU = 0;
    }

    // --- revolver cylinder
    if (n.cyl && this.restCyl) {
      const open = this._cylU || 0;
      n.cyl.position.set(this.restCyl.x - open * 0.030, this.restCyl.y, this.restCyl.z);
      n.cyl.rotation.set(0, open * 1.15, 0);
      const spin = (this._cylSpin || 0) * Math.PI * 0.66 + (this._cylIdx || 0);
      if (open < 0.02) n.cyl.rotation.z = spin;
      this._cylU = 0;
    }

    // --- trigger finger
    if (n.trigger && this.restTrigger) {
      let k = 0;
      if (this._triggerT != null && this._triggerT > 0) {
        this._triggerT -= dt;
        k = clamp01(this._triggerT / 0.09);
      }
      n.trigger.rotation.x = -k * 0.42;
    }
  }

  /** Advance the revolver cylinder one chamber. */
  indexCylinder(step = 1) {
    this._cylIdx = (this._cylIdx || 0) + (Math.PI * 2 / 6) * step;
  }

  /** Shotgun/bolt cycle: rack the action. */
  cycleAction(time = 0.34) { this._cycleT = time; }

  dispose() {
    if (this.vm && this.vm.root.parent) this.vm.root.parent.remove(this.vm.root);
    this.vm = null;
  }
}
