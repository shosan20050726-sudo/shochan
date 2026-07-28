import * as THREE from 'three';
import { EV } from '../core/EventBus.js';
import { ACTION } from '../core/Input.js';
import LEGENDS, { DEFAULT_LEGEND } from './LegendDefs.js';

/**
 * Legend abilities: a passive, a charge-based tactical, and an ultimate that
 * fills over time and faster while you are dealing damage.
 *
 * Abilities are data rather than code paths — each definition supplies an
 * `onUse` hook that receives a small world-facing API — so adding a legend
 * never touches this file. The HUD is driven purely through the `ui:ability`
 * event it already understands.
 */

const _fwd = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _hit = new THREE.Vector3();

export default class LegendSystem {
  name = 'legends';
  priority = 50;

  constructor() {
    this.legend = LEGENDS[DEFAULT_LEGEND];
    this.tacticalCharges = this.legend.tactical.charges;
    this.tacticalCd = 0;
    this.ultCharge = 0;
    this.effects = [];
    this._unsub = [];
  }

  async init(ctx) {
    this.ctx = ctx;
    this._push();

    // The ultimate fills faster when you are actually fighting, which is what
    // stops it feeling like a timer you wait out in a corner.
    this._unsub.push(ctx.bus.on(EV.DAMAGE_DEALT, (e) => {
      if (e?.source === 'ring' || e?.targetId === 'player') return;
      this._chargeUlt((e?.amount ?? 0) * (this.legend.ultDamageGain ?? 0.0012));
    }));
  }

  /** World-facing API handed to ability implementations. */
  _api(ctx) {
    const player = ctx.engine.get('player');
    const world = ctx.engine.get('world');
    ctx.camera.getWorldDirection(_fwd);
    _pos.copy(player?.eyePosition ?? ctx.camera.position);
    const self = this;
    return {
      ctx,
      bus: ctx.bus,
      scene: ctx.scene,
      origin: _pos,
      direction: _fwd,
      player,
      world,
      /** First world hit along the aim ray, or a point at maxDist. */
      aimPoint(maxDist = 40, out = _hit) {
        const h = world?.raycast?.(_pos, _fwd, maxDist);
        return h ? out.copy(h.point) : out.copy(_pos).addScaledVector(_fwd, maxDist);
      },
      /** Register a timed world effect; the system ticks and disposes it. */
      spawn(effect) { self.effects.push(effect); },
    };
  }

  _push() {
    const t = this.legend.tactical;
    this.ctx?.bus.emit('ui:ability', {
      tactical: {
        cd: Math.max(this.tacticalCd, 0),
        cdMax: t.cooldown,
        charges: this.tacticalCharges,
        maxCharges: t.charges,
      },
      ultimate: { charge: this.ultCharge },
    });
  }

  _chargeUlt(amount) {
    if (this.ultCharge >= 1) return;
    const was = this.ultCharge;
    this.ultCharge = Math.min(1, this.ultCharge + amount);
    if (was < 1 && this.ultCharge >= 1) {
      this.ctx?.bus.emit(EV.ABILITY_READY, { legendId: this.legend.id, slot: 'ultimate' });
      this._push();
    }
  }

  fixedUpdate(dt, ctx) {
    const input = ctx.engine.get('input');
    const t = this.legend.tactical;

    if (this.tacticalCharges < t.charges) {
      this.tacticalCd -= dt;
      if (this.tacticalCd <= 0) {
        this.tacticalCharges++;
        this.tacticalCd = this.tacticalCharges < t.charges ? t.cooldown : 0;
        ctx.bus.emit(EV.ABILITY_READY, { legendId: this.legend.id, slot: 'tactical' });
        this._push();
      }
    }

    // Passive trickle, so the ultimate still arrives in a quiet match.
    this._chargeUlt(dt * (this.legend.ultPassiveRate ?? 0.0045));

    if (input?.pressed?.(ACTION.TACTICAL)) this.useTactical(ctx);
    if (input?.pressed?.(ACTION.ULTIMATE)) this.useUltimate(ctx);

    this._tickEffects(dt, ctx);
  }

  useTactical(ctx = this.ctx) {
    if (this.tacticalCharges <= 0) return false;
    this.tacticalCharges--;
    if (this.tacticalCd <= 0) this.tacticalCd = this.legend.tactical.cooldown;

    const api = this._api(ctx);
    this.legend.tactical.onUse?.(api);
    ctx.bus.emit(EV.ABILITY_USED, {
      legendId: this.legend.id, slot: 'tactical', position: api.origin.clone(),
    });
    this._push();
    return true;
  }

  useUltimate(ctx = this.ctx) {
    if (this.ultCharge < 1) return false;
    this.ultCharge = 0;

    const api = this._api(ctx);
    this.legend.ultimate.onUse?.(api);
    ctx.bus.emit(EV.ABILITY_USED, {
      legendId: this.legend.id, slot: 'ultimate', position: api.origin.clone(),
    });
    this._push();
    return true;
  }

  _tickEffects(dt, ctx) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.life -= dt;
      e.update?.(dt, ctx);
      if (e.life <= 0) {
        e.dispose?.(ctx);
        this.effects.splice(i, 1);
      }
    }
  }

  /** Swap legend between matches. */
  setLegend(id) {
    const l = LEGENDS[id];
    if (!l) return false;
    this.legend = l;
    this.tacticalCharges = l.tactical.charges;
    this.tacticalCd = 0;
    this.ultCharge = 0;
    this._push();
    return true;
  }

  update(dt, alpha, ctx) {
    for (const e of this.effects) e.render?.(dt, alpha, ctx);
  }

  /** Fire both abilities, for the screenshot harness. */
  debugPresent() {
    if (!this.ctx) return;
    this.ultCharge = 1;
    this.useTactical(this.ctx);
    this.useUltimate(this.ctx);
  }

  dispose() {
    for (const off of this._unsub) off();
    for (const e of this.effects) e.dispose?.(this.ctx);
    this.effects.length = 0;
  }
}
