import * as THREE from 'three';
import { EV } from '../core/EventBus.js';
import { makeRNG } from '../core/Rand.js';

const _v = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();

const FOES = ['V1PER', 'ROOKWOOD', 'S. ORTEGA', 'BLACKOUT', 'ZEN-7', 'HALCYON', 'D. OKONKWO', 'KESTREL'];
const MATES = ['ECHO-4', 'MAVERICK'];
const KINDS = ['ar', 'smg', 'sniper', 'shotgun', 'lmg', 'pistol'];

/**
 * Self-test driver. When window.__UI_DEMO is set, this synthesises a plausible
 * stream of gameplay events on the real bus so the HUD can be exercised (and
 * screenshotted fully populated) with none of the gameplay systems present.
 * Deterministic: same seed -> same fight, every run.
 */
export default class DemoDriver {
  constructor(ctx, hud) {
    this.ctx = ctx;
    this.bus = ctx.bus;
    this.hud = hud;
    this.rng = makeRNG(0x51D3);
    this.t = 0;
    this.yaw = 0.6;
    this.px = 18; this.pz = 24;
    this.burst = 0;
    this.tNextBurst = 0.35;
    this.tShot = 0;
    this.tHurt = 2.4;
    this.tKill = 5.2;
    this.tAbility = 6.5;
    this.tFeed = 9;
    this.tRing = 38;
    this.stage = 3;
    this._primed = false;
  }

  _r(a, b) { return a + (b - a) * this.rng(); }
  _pick(a) { return a[Math.floor(this.rng() * a.length) % a.length]; }

  prime() {
    if (this._primed) return;
    this._primed = true;
    const bus = this.bus;

    bus.emit('ui:player', { name: 'V-07 REVENANT', level: 118 });
    bus.emit('ui:vitals', { health: 71, healthMax: 100, shield: 78, shieldMax: 100 });
    bus.emit('ui:weapon', {
      name: 'R-301 CARBINE', kind: 'ar', mag: 21, magMax: 28, reserve: 184,
      ammo: 'light', mode: 'AUTO',
    });
    bus.emit('ui:slots', [
      { name: 'R-301', active: true }, { name: 'PEACEKEEPER', active: false },
    ]);
    bus.emit('ui:squad', [
      { name: 'ECHO-4', health: 88, healthMax: 100, shield: 42, shieldMax: 100, fighting: true, x: 26, z: 12, fx: -0.4, fz: -0.9 },
      { name: 'MAVERICK', health: 34, healthMax: 100, shield: 0, shieldMax: 75, downed: true, x: 6, z: 44, fx: 0.9, fz: 0.3 },
    ]);
    bus.emit('ui:match', { squads: 7, alive: 21, kills: 4, damage: 1268 });
    bus.emit('ui:ability', {
      tactical: { charges: 0, maxCharges: 2, cd: 13.4, cdMax: 22 },
      ultimate: { charge: 0.78 },
    });
    bus.emit(EV.RING_STAGE, {
      stage: this.stage, phase: 'close', time: 47, total: 60,
      center: { x: -34, z: -18 }, radius: 148, nextRadius: 74,
    });
    bus.emit('ui:contacts', [
      { x: 62, z: -14 }, { x: -28, z: 58 }, { x: 44, z: 66 },
    ]);

    // Muzzle flashes on the minimap around the player, as if a fight is running.
    for (let i = 0; i < 5; i++) {
      const a = this.rng() * Math.PI * 2, d = 25 + this.rng() * 70;
      this.hud.minimap.ping(this.px + Math.cos(a) * d, this.pz + Math.sin(a) * d, 'gun');
    }
  }

  /**
   * Drop a plausible recent history into the kill feed. Called at the end of a
   * fast-forward so the entries are not immediately aged out again.
   */
  seedFeed() {
    if (this._seeded) return;
    this._seeded = true;
    const seed = [
      { killer: 'BLACKOUT', victim: 'K. NOVAK', weapon: 'sniper', headshot: true, victimAlly: true, age: 6.9 },
      { killer: 'RING', victim: 'D. OKONKWO', weapon: 'ring', age: 5.2 },
      { killer: 'MAVERICK', victim: 'HALCYON', weapon: 'shotgun', ally: true, age: 3.6 },
      { killer: 'V-07 REVENANT', victim: 'ZEN-7', weapon: 'ar', self: true, age: 2.1 },
      { killer: 'V-07 REVENANT', victim: 'ROOKWOOD', weapon: 'ar', headshot: true, self: true, age: 0.6 },
    ];
    for (const e of seed) this.hud.feed.push(e);
  }

  /** A world point roughly where a target would be, so projection is exercised. */
  _targetPoint(spreadX = 0.9, spreadY = 0.55) {
    const cam = this.ctx.camera;
    cam.getWorldDirection(_f);
    _r.set(_f.z, 0, -_f.x).normalize();
    const dist = 9 + this.rng() * 12;
    _v.copy(cam.position).addScaledVector(_f, dist)
      .addScaledVector(_r, (this.rng() - 0.5) * spreadX * dist * 0.16);
    _v.y += (this.rng() - 0.5) * spreadY + 0.35;
    return _v;
  }

  update(dt) {
    this.prime();
    this.t += dt;
    const bus = this.bus;
    const rng = this.rng;

    // player drifts and pans so the minimap / compass are visibly alive
    this.yaw += dt * 0.16;
    const sp = 3.1 + Math.sin(this.t * 0.7) * 1.6;
    this.px += Math.sin(this.yaw) * sp * dt;
    this.pz += -Math.cos(this.yaw) * sp * dt;
    bus.emit('ui:player', {
      x: this.px, z: this.pz,
      fx: Math.sin(this.yaw), fz: -Math.cos(this.yaw),
      speed: sp, grounded: true,
    });

    // --- weapon fire -------------------------------------------------------
    this.tNextBurst -= dt;
    if (this.burst <= 0 && this.tNextBurst <= 0) {
      this.burst = 3 + Math.floor(rng() * 4);
      this.target = 'foe-' + (this._tgt = ((this._tgt | 0) + 1) % 3);
      this.tNextBurst = 0.85 + rng() * 1.2;
    }
    if (this.burst > 0) {
      this.tShot -= dt;
      if (this.tShot <= 0) {
        this.tShot = 0.085;
        this.burst--;
        const w = this.hud.s.weapon;
        if (w.mag > 0 && !w.reloading) {
          bus.emit(EV.SHOT_FIRED, { weaponId: 'r301', spread: 0.2 });
          if (this.burst % 4 === 0) this.hud.minimap.ping(this.px, this.pz, 'gun');
          if (rng() < 0.82) {
            const crit = rng() < 0.2;
            const shield = rng() < 0.45;
            const amount = Math.round((crit ? 26 : 13) * (0.85 + rng() * 0.4));
            bus.emit(EV.DAMAGE_NUMBER, {
              amount, isHeadshot: crit, shieldDamage: shield,
              targetId: this.target || 'foe-a', point: this._targetPoint(),
            });
            bus.emit(EV.HITMARKER, { isHeadshot: crit, isKill: false, shieldBreak: shield && rng() < 0.2 });
          }
        } else if (!w.reloading) {
          bus.emit(EV.RELOAD_START, { duration: 2.3 });
        }
        if (this.burst === 0 && w.mag > 0 && w.mag < w.magMax * 0.42 && !w.reloading && rng() < 0.55) {
          bus.emit(EV.RELOAD_START, { duration: 2.3 });
        }
      }
    }

    // --- incoming fire -----------------------------------------------------
    this.tHurt -= dt;
    if (this.tHurt <= 0) {
      this.tHurt = 2.2 + rng() * 2.2;
      const shots = 1 + Math.floor(rng() * 3);
      const ang = rng() * Math.PI * 2;
      for (let i = 0; i < shots; i++) {
        setTimeout(() => {
          bus.emit(EV.DAMAGE_DEALT, {
            targetId: 'player', amount: 9 + Math.floor(rng() * 11),
            isHeadshot: false, shieldDamage: this.hud.s.shield > 0,
            fromAngle: ang + (rng() - 0.5) * 0.2,
          });
        }, i * 110);
      }
    }

    // --- eliminations ------------------------------------------------------
    this.tKill -= dt;
    if (this.tKill <= 0) {
      this.tKill = 9 + rng() * 7;
      const foe = this._pick(FOES);
      bus.emit(EV.DAMAGE_NUMBER, {
        amount: 45 + Math.floor(rng() * 40), isHeadshot: true, kill: true,
        targetId: 'foe-b', point: this._targetPoint(1.4, 0.8),
      });
      bus.emit(EV.HITMARKER, { isHeadshot: true, isKill: true });
      bus.emit(EV.ENTITY_KILLED, {
        id: foe, name: foe, by: 'player', byName: 'V-07 REVENANT',
        weapon: 'ar', headshot: true,
      });
    }

    // --- abilities ---------------------------------------------------------
    this.tAbility -= dt;
    if (this.tAbility <= 0) {
      this.tAbility = 11 + rng() * 6;
      const ult = this.hud.s.abilities.ultimate.charge >= 1;
      bus.emit(EV.ABILITY_USED, {
        legendId: 'revenant', slot: ult ? 'ultimate' : 'tactical',
        position: this.ctx.camera.position,
      });
    }

    // --- ambient feed ------------------------------------------------------
    this.tFeed -= dt;
    if (this.tFeed <= 0) {
      this.tFeed = 7 + rng() * 8;
      const a = this._pick(FOES), b = this._pick(FOES);
      if (a !== b) {
        bus.emit(EV.KILLFEED, { killer: a, victim: b, weapon: this._pick(KINDS), headshot: rng() < 0.3 });
        bus.emit('ui:match', { squads: Math.max(2, 7 - Math.floor(this.t / 60)), alive: Math.max(4, 21 - Math.floor(this.t / 9)) });
      }
      const ang = rng() * Math.PI * 2, d = 40 + rng() * 60;
      this.hud.minimap.ping(this.px + Math.cos(ang) * d, this.pz + Math.sin(ang) * d, 'gun');
    }

    // --- ring --------------------------------------------------------------
    this.tRing -= dt;
    if (this.tRing <= 0) {
      this.tRing = 42;
      this.stage = Math.min(6, this.stage + 1);
      const st = this.ctx.cfg.ring.stages[Math.min(this.stage, this.ctx.cfg.ring.stages.length) - 1];
      bus.emit(EV.RING_STAGE, {
        stage: this.stage, phase: 'close', time: st.closeTime, total: st.closeTime,
        center: { x: this.px + (rng() - 0.5) * 60, z: this.pz + (rng() - 0.5) * 60 },
        radius: st.radius * 0.55, nextRadius: st.radius * 0.3,
      });
    }

    // ultimate charges over time
    const ab = this.hud.s.abilities.ultimate;
    if (ab.charge < 1) bus.emit('ui:ability', { ultimate: { charge: Math.min(1, ab.charge + dt * 0.045) } });
  }
}
