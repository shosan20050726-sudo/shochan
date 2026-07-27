/**
 * Minimal synchronous pub/sub. Systems talk through this instead of holding
 * references to each other, which is what keeps the modules independently
 * replaceable.
 */
export class EventBus {
  constructor() { this.handlers = new Map(); }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (payload) => { off(); fn(payload); });
    return off;
  }

  off(type, fn) { this.handlers.get(type)?.delete(fn); }

  emit(type, payload) {
    const set = this.handlers.get(type);
    if (!set) return;
    // Copy so handlers can unsubscribe during dispatch without skipping peers.
    for (const fn of [...set]) {
      try { fn(payload); }
      catch (err) { console.error(`[EventBus] handler for "${type}" threw`, err); }
    }
  }

  clear() { this.handlers.clear(); }
}

/**
 * Canonical event names. Subsystems must use these constants rather than
 * raw strings so a typo fails loudly at import time instead of silently
 * never firing.
 */
export const EV = {
  // combat
  SHOT_FIRED: 'shot:fired',
  SHOT_HIT: 'shot:hit',
  DAMAGE_DEALT: 'damage:dealt',
  ENTITY_DOWNED: 'entity:downed',
  ENTITY_KILLED: 'entity:killed',
  RELOAD_START: 'weapon:reload:start',
  RELOAD_END: 'weapon:reload:end',
  WEAPON_SWITCH: 'weapon:switch',

  // movement
  PLAYER_JUMP: 'player:jump',
  PLAYER_LAND: 'player:land',
  SLIDE_START: 'player:slide:start',
  SLIDE_END: 'player:slide:end',
  MANTLE_START: 'player:mantle:start',
  WALL_BOUNCE: 'player:wallbounce',
  FOOTSTEP: 'player:footstep',

  // abilities
  ABILITY_USED: 'ability:used',
  ABILITY_READY: 'ability:ready',

  // match
  RING_STAGE: 'ring:stage',
  RING_DAMAGE: 'ring:damage',
  MATCH_END: 'match:end',

  // ui / fx
  HITMARKER: 'ui:hitmarker',
  DAMAGE_NUMBER: 'ui:damagenumber',
  KILLFEED: 'ui:killfeed',
  CAMERA_SHAKE: 'camera:shake',
  IMPACT: 'vfx:impact',
};

export default EventBus;
