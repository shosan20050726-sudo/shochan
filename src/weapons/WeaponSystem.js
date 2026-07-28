import * as THREE from 'three';
import CFG from '../core/Config.js';
import { EV } from '../core/EventBus.js';
import { ACTION } from '../core/Input.js';
import { makeRNG } from '../core/Rand.js';
import WEAPONS, { DEFAULT_LOADOUT, fireInterval, falloffMul } from './WeaponDefs.js';
import buildViewmodel from './Frames.js';
import ViewmodelRig from './ViewmodelRig.js';
import { MuzzleFlash, ShellPool } from './MuzzleFX.js';
import { palette } from './Parts.js';
import { clamp01 } from './MathKit.js';

/**
 * Weapon handling: fire timing, recoil, spread, reloads, and the viewmodel.
 *
 * The viewmodel lives in ctx.viewmodelScene, which the engine renders as a
 * second pass with depth cleared, so the gun never intersects world geometry.
 *
 * Recoil is deterministic. Each weapon carries a pattern of (up, side) pairs
 * indexed by shot number, so a spray is learnable and can be counter-pulled;
 * only a small jitter is random. The kick goes through the camera rig's
 * addLookImpulse, which recovers most of it once firing stops.
 */

const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _end = new THREE.Vector3();
const _shellPos = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

export default class WeaponSystem {
  name = 'weapons';
  priority = 30;

  constructor() {
    this.rig = new ViewmodelRig();
    this.slots = [];
    this.active = 0;
    this.rng = makeRNG(0x5EED);

    this.wantAds = false;
    this.cooldown = 0;
    this.shotIndex = 0;       // index into the recoil pattern
    this.spread = 1.4;        // current bloom, degrees
    this.burstLeft = 0;
    this.burstGap = 0;
    this.reloading = false;
    this.reloadTimer = 0;
    this.switchTimer = 0;
    this.triggerHeld = false;
    this.present = false;

    this._pendingSlot = null;
    this._triggerLatched = false;
    this._patternDecay = 0;
    this._fireFlashT = 0;
    this._prevYaw = 0;
    this._prevPitch = 0;
    this._yawRate = 0;
    this._pitchRate = 0;
  }

  get weapon() { return this.slots[this.active]; }

  async init(ctx) {
    this.ctx = ctx;
    ctx.viewmodelScene.add(this.rig.root);

    for (const id of DEFAULT_LOADOUT) {
      const def = WEAPONS[id];
      if (!def) continue;
      this.slots.push({ def, vm: buildViewmodel(def), mag: def.magSize, reserve: def.reserve });
    }
    if (!this.slots.length) return;

    // Flash and brass parent to the viewmodel, so they inherit every bit of
    // the procedural gun animation for free.
    this.flash = new MuzzleFlash();
    const pal = palette({});
    this.shells = new ShellPool(pal.brass || pal.body || pal.accent);
    this.rig.root.add(this.shells.group);

    this._equip(0, true);
  }

  _equip(index, instant = false) {
    const slot = this.slots[index];
    if (!slot) return;
    this.active = index;
    this.rig.setWeapon(slot.vm, slot.def);
    if (this.flash) {
      slot.vm.root.add(this.flash.group);
      this.flash.group.position.copy(slot.vm.muzzle);
    }
    if (instant) this.rig.snap();
    this.shotIndex = 0;
    this.spread = slot.def.spread?.hipBase ?? 1.4;
    this.ctx?.bus.emit(EV.WEAPON_SWITCH, { weaponId: slot.def.id });
  }

  /* ------------------------------------------------------------- input -- */

  _readInput(ctx) {
    const input = ctx.engine.get('input');
    if (!input || this.present) return;

    this.triggerHeld = input.down(ACTION.FIRE);
    this.wantAds = input.down(ACTION.ADS) && !this.reloading;

    if (input.pressed(ACTION.RELOAD)) this._startReload();
    if (input.pressed(ACTION.SLOT1)) this._switchTo(0);
    if (input.pressed(ACTION.SLOT2)) this._switchTo(1);
    if (input.wheel) this._switchTo((this.active + 1) % this.slots.length);
  }

  _switchTo(index) {
    if (index === this.active || !this.slots[index] || this.switchTimer > 0) return;
    this.rig.startSwitch('out', 0.22);
    this.switchTimer = 0.22;
    this._pendingSlot = index;
    this.reloading = false;
    this.rig.cancelReload();
  }

  _startReload() {
    const s = this.weapon;
    if (!s || this.reloading) return;
    if (s.mag >= s.def.magSize || s.reserve <= 0) return;
    const empty = s.mag <= 0;
    this.reloading = true;
    this.reloadTimer = empty ? s.def.reloadEmpty : s.def.reloadTactical;
    this.rig.startReload(s.def, empty);
    this.ctx.bus.emit(EV.RELOAD_START, { weaponId: s.def.id, empty });
  }

  _finishReload() {
    const s = this.weapon;
    this.reloading = false;
    if (!s) return;
    const take = Math.min(s.def.magSize - s.mag, s.reserve);
    s.mag += take;
    s.reserve -= take;
    this.ctx.bus.emit(EV.RELOAD_END, { weaponId: s.def.id, mag: s.mag, reserve: s.reserve });
  }

  /* ------------------------------------------------------------ firing -- */

  fixedUpdate(dt, ctx) {
    if (!this.slots.length) return;
    this._readInput(ctx);

    if (this.switchTimer > 0) {
      this.switchTimer -= dt;
      if (this.switchTimer <= 0 && this._pendingSlot != null) {
        this._equip(this._pendingSlot);
        this._pendingSlot = null;
        this.rig.startSwitch('in', 0.26);
        this.switchTimer = 0.26;
      }
    }

    if (this.reloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) this._finishReload();
    }

    const s = this.weapon;
    const def = s.def;
    this.cooldown -= dt;

    // Bloom recovers toward the stance baseline whenever we are not firing.
    const sp = def.spread || {};
    const base = this.wantAds ? (sp.adsBase ?? 0.06) : (sp.hipBase ?? 1.4);
    this.spread += (base - this.spread) * Math.min(1, dt * 7.5);

    const canFire = !this.reloading && this.switchTimer <= 0;
    let wantShot = false;

    if (def.fireMode === 'auto') {
      wantShot = this.triggerHeld;
    } else if (def.fireMode === 'semi') {
      wantShot = this.triggerHeld && !this._triggerLatched;
    } else {
      if (this.triggerHeld && !this._triggerLatched && this.burstLeft <= 0 && this.burstGap <= 0) {
        this.burstLeft = def.burstCount;
      }
      this.burstGap = Math.max(0, this.burstGap - dt);
      wantShot = this.burstLeft > 0 && this.burstGap <= 0;
    }
    this._triggerLatched = this.triggerHeld;

    // The pattern walks back to the start once the trigger is released.
    if (this.triggerHeld) {
      this._patternDecay = 0;
    } else if (this.shotIndex > 0) {
      this._patternDecay += dt;
      if (this._patternDecay > 0.28) { this.shotIndex = 0; this._patternDecay = 0; }
    }

    if (wantShot && canFire && this.cooldown > 0) return;
    if (wantShot && canFire) {
      if (s.mag > 0) {
        this._fire(ctx, s, def);
        this.cooldown = fireInterval(def);
        if (def.fireMode === 'burst' && --this.burstLeft <= 0) this.burstGap = def.burstGap;
      } else {
        this._startReload();
      }
    }
  }

  _fire(ctx, slot, def) {
    slot.mag--;
    this._fireFlashT = 0.06;

    const player = ctx.engine.get('player');
    const camera = ctx.camera;
    camera.getWorldPosition(_origin);
    camera.getWorldDirection(_dir);
    _right.crossVectors(_dir, WORLD_UP).normalize();
    _up.crossVectors(_right, _dir).normalize();

    const spreadRad = (this.spread * Math.PI) / 180;
    const pellets = def.pellets || 1;

    for (let p = 0; p < pellets; p++) {
      _tmp.copy(_dir);
      if (spreadRad > 0) {
        // sqrt keeps the distribution even across the cone instead of
        // clustering everything at the centre.
        const a = this.rng() * Math.PI * 2;
        const r = Math.sqrt(this.rng()) * spreadRad;
        _tmp.addScaledVector(_right, Math.cos(a) * r)
            .addScaledVector(_up, Math.sin(a) * r).normalize();
      }
      this._traceShot(ctx, def, _origin, _tmp, p === 0);
    }

    const pat = def.pattern;
    if (pat && pat.length >= 2) {
      const i = Math.min(this.shotIndex, pat.length / 2 - 1) | 0;
      const k = def.kick || {};
      const adsMul = this.wantAds ? 0.62 : 1;
      player?.addLookImpulse(
        pat[i * 2] * (k.pitch ?? 3) * 0.0045 * adsMul,
        pat[i * 2 + 1] * (k.yaw ?? 1.5) * 0.0045 * adsMul,
        def.recoilRecover ?? 0.9,
      );
    }
    this.shotIndex++;

    const perShot = this.wantAds ? (def.spread?.adsPerShot ?? 0.08) : (def.spread?.hipPerShot ?? 0.3);
    const maxSp = this.wantAds ? (def.spread?.adsMax ?? 1) : (def.spread?.hipMax ?? 4.5);
    this.spread = Math.min(maxSp, this.spread + perShot);

    const sh = def.shake || {};
    ctx.bus.emit(EV.CAMERA_SHAKE, {
      amplitude: (sh.amplitude ?? 0.12) * (this.wantAds ? 0.6 : 1),
      frequency: sh.frequency ?? 32,
      duration: sh.duration ?? 0.08,
    });

    this.rig.onFire(def, this.rng() * 2 - 1, this.rng(), this.wantAds ? 0.55 : 1);
    this.flash?.fire(1 + this.rng() * 0.3, this.rng());

    if (this.shells && slot.vm.eject) {
      _shellPos.copy(slot.vm.eject);
      this.shells.spawn(_shellPos, 1.5 + this.rng(), 1.2 + this.rng() * 0.6,
        -0.4 + this.rng() * 0.4, this.rng());
    }

    ctx.bus.emit(EV.SHOT_FIRED, {
      weaponId: def.id, origin: _origin.clone(), dir: _dir.clone(),
      spread: this.spread, mag: slot.mag, reserve: slot.reserve,
    });
  }

  _traceShot(ctx, def, origin, dir, isFirstPellet) {
    const world = ctx.engine.get('world');
    const range = def.maxRange ?? 700;
    const hit = world?.raycast?.(origin, dir, range) ?? null;

    if (def.tracerEvery && this.shotIndex % def.tracerEvery === 0) {
      _end.copy(hit ? hit.point : _tmp.copy(origin).addScaledVector(dir, range));
      ctx.bus.emit('vfx:tracer', {
        origin: origin.clone(), end: _end.clone(),
        speed: def.hitscan ? 900 : (def.projectileSpeed || 900),
      });
    }
    if (!hit) return;

    ctx.bus.emit(EV.IMPACT, {
      point: hit.point.clone(), normal: hit.normal.clone(),
      surface: hit.surface, scale: 1,
    });

    const targetId = hit.object?.userData?.entityId;
    ctx.bus.emit(EV.SHOT_HIT, {
      point: hit.point.clone(), normal: hit.normal.clone(),
      surface: hit.surface, targetId,
    });

    if (targetId) {
      ctx.bus.emit(EV.DAMAGE_DEALT, {
        targetId,
        amount: (def.damage ?? 10) * falloffMul(def, hit.distance),
        isHeadshot: false, point: hit.point.clone(), shieldDamage: 0,
      });
      if (isFirstPellet) ctx.bus.emit(EV.HITMARKER, { isHeadshot: false, isKill: false });
    }
  }

  /* ------------------------------------------------------------ update -- */

  update(dt, alpha, ctx) {
    if (!this.slots.length) return;
    const player = ctx.engine.get('player');

    // Look rates drive the viewmodel's sway lag.
    const yaw = player?.yaw ?? 0, pitch = player?.pitch ?? 0;
    if (dt > 0) {
      this._yawRate = (yaw - this._prevYaw) / dt;
      this._pitchRate = (pitch - this._prevPitch) / dt;
    }
    this._prevYaw = yaw; this._prevPitch = pitch;

    const vx = player?.velocity?.x ?? 0;
    const st = {
      wantAds: this.wantAds,
      firing: this._fireFlashT > 0,
      sprinting: !!player?.isSprinting && !this.wantAds,
      crouching: !!player?.isCrouching,
      onGround: player?.onGround !== false,
      moveFrac: clamp01((player?.speed ?? 0) / Math.max(CFG.move.sprintSpeed, 0.001)),
      strafe: clamp01(Math.abs(vx) / 6) * Math.sign(vx),
      vy: player?.velocity?.y ?? 0,
      yawRate: this._yawRate,
      pitchRate: this._pitchRate,
      t: ctx.clock.elapsed,
      mode: this.reloading ? 'reload' : 'idle',
      dur: this.reloadTimer,
    };

    this._fireFlashT = Math.max(0, this._fireFlashT - dt);
    this.rig.update(dt, st);
    this.flash?.update(dt);
    this.shells?.update(dt);

    // ADS narrows the world FOV; the rig owns the gun pose itself.
    const def = this.weapon?.def;
    if (def && player?.setFovScale) {
      const t = this.rig.ads ?? 0;
      player.setFovScale(1 + (CFG.camera.adsFovScale * (def.adsFovMul ?? 1) - 1) * t);
    }
  }

  /** Ammo readout for the HUD. */
  getState() {
    const s = this.weapon;
    if (!s) return null;
    return {
      weaponId: s.def.id, name: s.def.name, mag: s.mag, magSize: s.def.magSize,
      reserve: s.reserve, ammoType: s.def.ammoType, fireMode: s.def.fireMode,
      reloading: this.reloading, ads: this.rig.ads ?? 0, spread: this.spread,
    };
  }

  /** Showcase pose for the screenshot harness. */
  debugPresent() {
    this.present = true;
    this.triggerHeld = false;
    this.wantAds = false;
    this.rig.setPresent?.(true);
    this.rig.snap();
  }

  dispose() {
    this.rig.dispose?.();
    this.shells?.dispose?.();
  }
}
