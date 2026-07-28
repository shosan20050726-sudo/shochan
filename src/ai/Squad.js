import * as THREE from 'three';
import AI from './AIConfig.js';
import { STATE } from './Bot.js';

/**
 * The squad brain. This is the layer that makes three bots read as a fireteam
 * rather than three deathmatch bots that happen to be near each other.
 *
 * It owns:
 *  - the shared contact (one squad-level belief about where the enemy is,
 *    updated by whichever member last saw or heard something),
 *  - role assignment: an anchor that holds the front, a support that stays in
 *    cover on the anchor's flank, and a point man that pushes or flanks wide,
 *  - the decision to push a knocked enemy or break contact and retreat,
 *  - revives: a healthy member is peeled off to pick a knocked squadmate up.
 *
 * Cover is evaluated properly: a candidate is cover only if the threat's line
 * to a *crouched* body there is blocked while a *standing* body can still see
 * out. That single test is what makes them tuck behind walls instead of
 * standing in doorways.
 */

const _v = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _dir = new THREE.Vector3();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

let NEXT_SQUAD = 1;

/** Callsigns, so the kill feed reads like a match and not like a debug log. */
const CALLSIGNS = [
  'VANTAGE', 'HALLOW', 'DRIFTER', 'KESTREL', 'SABLE', 'MERIDIAN',
  'ONYX', 'PALLAS', 'RONIN', 'TALLOW', 'VESPER', 'WARDEN',
  'CINDER', 'HOLLOWPOINT', 'MARROW', 'NOCTIS', 'QUILL', 'SEVEN',
];
let CALL_AT = 0;

export class Squad {
  constructor(W, index) {
    this.W = W;
    this.index = index;
    this.id = `squad_${NEXT_SQUAD++}`;
    this.name = CALLSIGNS[(CALL_AT++) % CALLSIGNS.length];
    this.members = [];
    this.anchor = new THREE.Vector3();
    this.contact = new THREE.Vector3();
    this.contactTime = -999;
    this.hasContact = false;
    this.state = 'patrol';
    this.strength = 1;
    this.thinkT = 0;
    this.coverCursor = 0;
    this.roam = new THREE.Vector3();
    this.hasRoam = false;
    // Reused every think() so the squad brain never allocates.
    this._live = [];
    this._down = [];
    this._fighters = [];
  }

  get alive() { return this.members.some((b) => b.alive); }
  get liveCount() { return this.members.reduce((n, b) => n + (b.combatReady ? 1 : 0), 0); }

  add(bot) {
    bot.squad = this;
    bot.name = `${this.name}-${this.members.length + 1}`;
    this.members.push(bot);
    return bot;
  }

  /** Any member's sighting becomes the squad's. */
  reportContact(pos, time, source) {
    if (time < this.contactTime - 0.05) return;
    this.contact.copy(pos);
    this.contactTime = time;
    this.hasContact = true;

    for (const b of this.members) {
      if (b === source || !b.combatReady) continue;
      if (b.hasContact && b.lastSeen > time - 1.5) continue;
      b.lastKnown.copy(pos);
      b.awareness = Math.max(b.awareness, AI.vision.confirm);
      if (!b.hasContact) {
        b.hasContact = true;
        b.lastSeen = time - 0.4;
        // Called contacts take longer to act on than ones you saw yourself.
        b.reaction = AI.reaction.min + AI.reaction.audio * 1.4
          + (AI.reaction.max - AI.reaction.min) * (1 - AI.difficulty) * b.rng();
      }
    }
  }

  /* ================================================================== */

  think(dt) {
    const W = this.W;
    const live = this._live, downedMates = this._down;
    live.length = 0; downedMates.length = 0;
    let seen = false;
    for (const b of this.members) {
      if (b.combatReady) { live.push(b); if (b.visible) seen = true; }
      else if (b.alive && b.downed) downedMates.push(b);
    }
    if (!live.length) { this.hasContact = false; return; }

    // --- anchor + strength -------------------------------------------------
    this.anchor.set(0, 0, 0);
    let str = 0;
    for (const b of live) { this.anchor.add(b.mover.position); str += b.strength; }
    this.anchor.multiplyScalar(1 / live.length);
    this.strength = str / Math.max(1, this.members.length);

    // --- contact freshness -------------------------------------------------
    if (seen) {
      this.contact.copy(W.player.position);
      this.contactTime = W.time;
      this.hasContact = true;
    } else if (W.time - this.contactTime > AI.squad.contactMemory) {
      this.hasContact = false;
    }

    // --- state -------------------------------------------------------------
    const enemyDown = !!W.player.downed;

    let state = 'patrol';
    if (this.hasContact) {
      if (this.strength < AI.squad.retreatAt && !enemyDown) state = 'retreat';
      else if (enemyDown && this.strength > AI.squad.pushAt) state = 'push';
      else state = 'engage';
    }
    this.state = state;

    // --- revive assignment --------------------------------------------------
    let reviver = null;
    if (downedMates.length && state !== 'retreat') {
      const target = downedMates[0];
      let best = null, bestD = 1e9;
      for (const b of live) {
        // Under fire, only peel someone off if the squad still has depth.
        if (state === 'engage' && live.length < 2) break;
        const d = b.mover.position.distanceTo(target.mover.position);
        if (d < bestD) { bestD = d; best = b; }
      }
      if (best && bestD < 55) {
        reviver = best;
        best.order.type = STATE.REVIVE;
        best.order.x = target.mover.position.x;
        best.order.z = target.mover.position.z;
        best.order.valid = true;
        best.order.aggression = 0.2;
        this._runRevive(best, target, dt);
      }
    }

    // --- orders --------------------------------------------------------------
    const fighters = this._fighters;
    fighters.length = 0;
    for (const b of live) if (b !== reviver) fighters.push(b);
    if (state === 'patrol') this._orderPatrol(fighters);
    else if (state === 'retreat') this._orderRetreat(fighters);
    else if (state === 'push') this._orderPush(fighters);
    else this._orderEngage(fighters);
  }

  _runRevive(medic, target, dt) {
    const d = medic.mover.position.distanceTo(target.mover.position);
    if (d > AI.squad.reviveRange) { target.reviveT = 0; target.reviverId = null; return; }
    target.reviverId = medic.id;
    target.reviveT += dt;
    medic.wantCrouch = true;
    if (target.reviveT >= AI.reviveTime) {
      target.reviveBy(medic);
      this.W.onRevived(target, medic);
    }
  }

  /* ---------------------------------------------------------- patrol -- */

  _orderPatrol(list) {
    if (!this.hasRoam || this.anchor.distanceTo(this.roam) < 8) {
      const nav = this.W.nav;
      for (let i = 0; i < 8; i++) {
        const a = this.W.rng() * Math.PI * 2;
        const r = 25 + this.W.rng() * 70;
        const x = this.anchor.x + Math.cos(a) * r;
        const z = this.anchor.z + Math.sin(a) * r;
        if (!nav || nav.walkable(x, z)) { this.roam.set(x, 0, z); this.hasRoam = true; break; }
      }
    }
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const a = (i / Math.max(1, list.length)) * Math.PI * 2;
      b.order.type = STATE.PATROL;
      b.order.x = this.roam.x + Math.cos(a) * AI.squad.spacing;
      b.order.z = this.roam.z + Math.sin(a) * AI.squad.spacing;
      b.order.valid = this.hasRoam;
      b.order.aggression = 0.2;
    }
  }

  /* ---------------------------------------------------------- engage -- */

  _orderEngage(list) {
    const threat = this.contact;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      b.order.aggression = 0.6;

      if (b.role === 'point' && list.length > 1) {
        // Wide flank: swing around the threat rather than walking down its sights.
        const side = (this.index + i) % 2 === 0 ? 1 : -1;
        _dir.copy(this.anchor).sub(threat);
        _dir.y = 0;
        const len = _dir.length() || 1;
        _dir.multiplyScalar(1 / len);
        const a = AI.squad.flankAngle * side;
        const cs = Math.cos(a), sn = Math.sin(a);
        const fx = _dir.x * cs - _dir.z * sn;
        const fz = _dir.x * sn + _dir.z * cs;
        // A flank has to actually close, not just sidestep: the point man ends
        // up nearer than the anchor, at an angle the anchor is not covering.
        const r = clamp(len * 0.55, AI.combat.idealRange * 0.55, AI.combat.idealRange * 1.15);
        b.order.type = STATE.FLANK;
        b.order.x = threat.x + fx * r;
        b.order.z = threat.z + fz * r;
        b.order.valid = true;
        continue;
      }

      // Anchor and support hold cover facing the threat, offset from each other.
      const side = b.role === 'support' ? 1 : -1;
      const found = this._coverFor(b, threat, side);
      b.order.type = STATE.ENGAGE;
      b.order.valid = found;
      if (!found) {
        _dir.copy(b.mover.position).sub(threat);
        _dir.y = 0;
        const l = _dir.length() || 1;
        b.order.x = threat.x + (_dir.x / l) * AI.combat.idealRange;
        b.order.z = threat.z + (_dir.z / l) * AI.combat.idealRange;
        b.order.valid = true;
      }
    }
  }

  _orderPush(list) {
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const a = (i / Math.max(1, list.length)) * Math.PI * 2;
      b.order.type = STATE.PUSH;
      b.order.x = this.contact.x + Math.cos(a) * 3.2;
      b.order.z = this.contact.z + Math.sin(a) * 3.2;
      b.order.valid = true;
      b.order.aggression = 1;
    }
  }

  _orderRetreat(list) {
    _dir.copy(this.anchor).sub(this.contact);
    _dir.y = 0;
    const l = _dir.length() || 1;
    _dir.multiplyScalar(1 / l);
    const nav = this.W.nav;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      let x = b.mover.position.x + _dir.x * 34;
      let z = b.mover.position.z + _dir.z * 34;
      if (nav && !nav.walkable(x, z)) {
        x = b.mover.position.x + _dir.x * 14;
        z = b.mover.position.z + _dir.z * 14;
      }
      b.order.type = STATE.RETREAT;
      b.order.x = x;
      b.order.z = z;
      b.order.valid = true;
      b.order.aggression = 0.1;
    }
  }

  /* ------------------------------------------------------------ cover -- */

  /**
   * Find a firing position for `bot` against `threat`, biased to `side`.
   * Budgeted: only one member re-evaluates per call.
   */
  _coverFor(bot, threat, side) {
    if (bot._coverT > 0 && bot.order.valid && bot.order.type === STATE.ENGAGE) {
      return true;                       // keep the position we already chose
    }
    bot._coverT = 2.4 + this.W.rng() * 2.2;

    const W = this.W;
    const nav = W.nav;
    const samples = AI.squad.coverSamples;
    const ideal = AI.combat.idealRange;

    // Search around a point that is already at the range we want to fight at.
    _dir.copy(bot.mover.position).sub(threat);
    _dir.y = 0;
    const dist = _dir.length() || 1;
    _dir.multiplyScalar(1 / dist);
    const baseX = threat.x + _dir.x * ideal;
    const baseZ = threat.z + _dir.z * ideal;

    let bestScore = -1e9, bx = 0, bz = 0, found = false;

    for (let i = 0; i < samples; i++) {
      const a = (i / samples) * Math.PI * 2 + this.index * 0.7;
      const r = AI.squad.coverRadius * (0.35 + (i % 3) * 0.33);
      const x = baseX + Math.cos(a) * r;
      const z = baseZ + Math.sin(a) * r;
      if (nav && !nav.walkable(x, z)) continue;

      const y = W.groundAt(x, z, bot.mover.position.y);
      if (!isFinite(y) || Math.abs(y - bot.mover.position.y) > 6) continue;

      // Cover test: crouched body hidden, standing eye exposed.
      _from.set(x, y + 1.05, z);
      _to.copy(threat); _to.y += 1.5;
      const crouchClear = W.losBetween(_from, _to);
      _from.y = y + 1.66;
      const standClear = W.losBetween(_from, _to);

      const coverScore = (!crouchClear && standClear) ? 3.2 : (!crouchClear ? 1.6 : 0);
      const range = Math.hypot(x - threat.x, z - threat.z);
      const rangeScore = -Math.abs(range - ideal) * 0.09;
      const travel = -Math.hypot(x - bot.mover.position.x, z - bot.mover.position.z) * 0.07;
      // Push squadmates apart so they do not stack behind the same crate.
      let spread = 0;
      for (const m of this.members) {
        if (m === bot || !m.combatReady || !m.order.valid) continue;
        const d = Math.hypot(x - m.order.x, z - m.order.z);
        if (d < AI.squad.spacing) spread -= (AI.squad.spacing - d) * 0.55;
      }
      const sideBias = side * Math.sin(a) * 0.4;
      const clear = nav ? Math.min(1.2, nav.clearanceAt(x, z) * 0.25) : 0.4;
      const score = coverScore + rangeScore + travel + spread + sideBias + clear;

      if (score > bestScore) { bestScore = score; bx = x; bz = z; found = true; }
    }

    if (found) { bot.order.x = bx; bot.order.z = bz; }
    return found;
  }

  tickCover(dt) {
    for (const b of this.members) {
      if (b._coverT === undefined) b._coverT = 0;
      b._coverT -= dt;
    }
  }
}

export default Squad;
