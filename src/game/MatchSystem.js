import * as THREE from 'three';
import CFG from '../core/Config.js';
import { EV } from '../core/EventBus.js';
import { makeRNG } from '../core/Rand.js';

/**
 * Match flow: the closing ring, and the damage it does to anyone outside it.
 *
 * Each stage waits, then closes over a fixed duration onto a new centre that
 * is always reachable — the next circle is chosen inside the current one, so
 * the safe zone never jumps somewhere a player could not run to. That
 * constraint is the whole reason the format works: the ring has to compress
 * players together without ever being unfair about it.
 *
 * Emits EV.RING_STAGE on every transition. The VFX system builds the wall from
 * those events, and the HUD reads them for the timer and the direction arrow.
 */

const PHASE = { WAIT: 'wait', CLOSE: 'close', DONE: 'done' };

const _tmp = new THREE.Vector3();

export default class MatchSystem {
  name = 'match';
  priority = 85;

  constructor() {
    this.rng = makeRNG((CFG.world.seed ^ 0x1D07) >>> 0);
    this.stageIndex = -1;
    this.phase = PHASE.WAIT;
    this.timer = 0;

    // Current ring, and the one we are shrinking toward.
    this.center = new THREE.Vector2(0, 0);
    this.radius = CFG.ring.stages[0]?.radius ?? 300;
    this.fromCenter = new THREE.Vector2(0, 0);
    this.fromRadius = this.radius;
    this.nextCenter = new THREE.Vector2(0, 0);
    this.nextRadius = this.radius;

    this.running = false;
    this._damageAccum = 0;
    this._lastOutside = false;
  }

  async init(ctx) {
    this.ctx = ctx;
    const first = CFG.ring.stages[0];
    this.radius = this.fromRadius = first?.radius ?? 300;
    this._advance();     // arm stage 0
    this.running = true;
  }

  /** Pick the next circle wholly inside the current one. */
  _pickNextCircle(nextRadius) {
    // Uniform over the annulus of valid centres: sqrt keeps it area-uniform
    // instead of clustering every circle near the middle.
    const maxOffset = Math.max(0, this.radius - nextRadius);
    const a = this.rng() * Math.PI * 2;
    const r = Math.sqrt(this.rng()) * maxOffset;
    this.nextCenter.set(
      this.center.x + Math.cos(a) * r,
      this.center.y + Math.sin(a) * r,
    );
    this.nextRadius = nextRadius;
  }

  _advance() {
    this.stageIndex++;
    const stages = CFG.ring.stages;
    if (this.stageIndex >= stages.length) {
      this.phase = PHASE.DONE;
      this._emitStage();
      this.ctx?.bus.emit(EV.MATCH_END, { reason: 'ring-closed' });
      return;
    }
    const stage = stages[this.stageIndex];
    this.fromCenter.copy(this.center);
    this.fromRadius = this.radius;
    this._pickNextCircle(stage.radius);
    this.phase = PHASE.WAIT;
    this.timer = stage.waitTime;
    this._emitStage();
  }

  _emitStage() {
    const stage = CFG.ring.stages[Math.min(this.stageIndex, CFG.ring.stages.length - 1)];
    this.ctx?.bus.emit(EV.RING_STAGE, {
      stage: this.stageIndex + 1,
      phase: this.phase,
      time: this.timer,
      total: this.phase === PHASE.WAIT ? stage.waitTime : stage.closeTime,
      center: { x: this.center.x, z: this.center.y },
      radius: this.radius,
      nextCenter: { x: this.nextCenter.x, z: this.nextCenter.y },
      nextRadius: this.nextRadius,
      dps: stage.dps,
    });
  }

  fixedUpdate(dt, ctx) {
    if (!this.running || this.phase === PHASE.DONE) return;
    const stage = CFG.ring.stages[this.stageIndex];
    if (!stage) return;

    this.timer -= dt;

    if (this.phase === PHASE.WAIT) {
      if (this.timer <= 0) {
        this.phase = PHASE.CLOSE;
        this.timer = stage.closeTime;
        this._emitStage();
      }
    } else if (this.phase === PHASE.CLOSE) {
      const t = 1 - Math.max(this.timer, 0) / Math.max(stage.closeTime, 0.001);
      // Ease so the wall starts and finishes gently rather than lurching.
      const e = t * t * (3 - 2 * t);
      this.radius = this.fromRadius + (this.nextRadius - this.fromRadius) * e;
      this.center.set(
        this.fromCenter.x + (this.nextCenter.x - this.fromCenter.x) * e,
        this.fromCenter.y + (this.nextCenter.y - this.fromCenter.y) * e,
      );
      if (this.timer <= 0) {
        this.radius = this.nextRadius;
        this.center.copy(this.nextCenter);
        this._advance();
        return;
      }
      // The wall is moving, so the HUD needs a fresh position every so often.
      this._emitTick = (this._emitTick ?? 0) + dt;
      if (this._emitTick >= 0.5) { this._emitTick = 0; this._emitStage(); }
    }

    this._applyRingDamage(dt, ctx, stage);
  }

  _applyRingDamage(dt, ctx, stage) {
    const player = ctx.engine.get('player');
    if (!player?.position) return;

    const dx = player.position.x - this.center.x;
    const dz = player.position.z - this.center.y;
    const dist = Math.hypot(dx, dz);
    const outside = dist > this.radius;

    if (outside !== this._lastOutside) {
      this._lastOutside = outside;
      ctx.bus.emit('ring:outside', { outside, distance: dist - this.radius });
    }
    if (!outside) { this._damageAccum = 0; return; }

    // Tick damage on a fixed cadence so it reads as pulses, not a drain.
    this._damageAccum += dt;
    const interval = 1.0;
    while (this._damageAccum >= interval) {
      this._damageAccum -= interval;
      ctx.bus.emit(EV.RING_DAMAGE, { amount: stage.dps, distance: dist - this.radius });
      ctx.bus.emit(EV.DAMAGE_DEALT, {
        targetId: 'player',
        amount: stage.dps,
        isHeadshot: false,
        point: _tmp.copy(player.position).clone(),
        shieldDamage: 0,
        source: 'ring',
      });
    }
  }

  /** Read by the HUD and the AI for "where is safe". */
  getRingState() {
    return {
      stage: this.stageIndex + 1,
      phase: this.phase,
      time: Math.max(this.timer, 0),
      center: { x: this.center.x, z: this.center.y },
      radius: this.radius,
      nextCenter: { x: this.nextCenter.x, z: this.nextCenter.y },
      nextRadius: this.nextRadius,
    };
  }

  dispose() { this.running = false; }
}
