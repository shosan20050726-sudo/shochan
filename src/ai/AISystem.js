import * as THREE from 'three';
import CFG from '../core/Config.js';
import { EV } from '../core/EventBus.js';
import { makeRNG } from '../core/Rand.js';
import Materials from '../materials/MaterialLibrary.js';
import AI from './AIConfig.js';
import NavMesh from './Nav.js';
import { BodyRenderer } from './BotBody.js';
import { HitRegistry, PART, rayCapsule } from './Hitboxes.js';
import { Bot } from './Bot.js';
import { Squad } from './Squad.js';
import { J, JOINT_COUNT } from './Skeleton.js';

/**
 * AISystem — enemy squads.
 *
 * ARCHITECTURE
 *   AISystem      services, scheduling, events, spawning, corpses
 *   Squad         shared contact, roles, cover assignment, revives
 *   Bot           per-entity state machine, steering, trigger discipline
 *   Mover         capsule controller on the shared CollisionWorld
 *   Gait          procedural locomotion (planted feet, IK arms)
 *   BodyRenderer  instanced procedural humanoid, one draw call per part
 *   NavMesh       A* + string pulling over world.navGrid
 *   HitRegistry   analytic head/torso/arm/leg hitboxes
 *
 * COST CONTROL
 *   Nothing expensive runs for every bot every tick. A round-robin scheduler
 *   hands out a fixed number of line-of-sight rays, at most one A* search and
 *   at most one cover evaluation per rendered frame. Steering, physics and
 *   animation are pure arithmetic over preallocated buffers.
 *
 * HITBOXES
 *   `world.raycast` is wrapped (not replaced) so the existing weapon trace
 *   already hits bots and already reads `hit.object.userData.entityId`. The
 *   wrapper also records which region was hit, so headshots resolve correctly
 *   on this side even though WeaponSystem still reports `isHeadshot: false`.
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _pt = new THREE.Vector3();
const _n = new THREE.Vector3();

const CORPSE_SLOTS = 6;
/** Bot simulation rate. See fixedUpdate for why this is not the physics rate. */
const SIM_STEP = 1 / 40;
/** Showcase framing: preferred depths, and the range placement may use. */
const SHOW_DIST = [7.0, 10.5, 5.2];
const SHOW_LATERAL = [-2.2, 0.6, 2.8];
/** Yaw applied to each showcase bot's aim so the rifle is not end-on. */
const SHOW_AIM_YAW = [0.62, 0, -0.95];
const SHOW_MIN = 3.4;
const SHOW_MAX = 26;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export default class AISystem {
  name = 'ai';
  priority = 40;

  constructor() {
    this.rng = makeRNG(AI.seed);
    this.bots = [];
    this.squads = [];
    this.byId = new Map();
    this.registry = new HitRegistry();
    this.nav = null;
    this.renderer = null;
    this.collision = null;
    this.enabled = true;
    this.showcase = false;
    this.time = 0;

    this.corpses = [];
    this._corpsePose = new Float32Array(JOINT_COUNT * 3);
    this._freeCorpseSlots = [];

    this._unsub = [];
    this._worldRaycastOriginal = null;
    this._worldRef = null;
    this._ledger = { id: null, part: PART.TORSO, x: 0, y: 0, z: 0, live: false };

    this._senseAt = 0;
    this._thinkAt = 0;
    this._pathAt = 0;
    this._squadAt = 0;
    this._respawnTimer = AI.respawnDelay * 0.35;
    this._simAccum = 0;
    this._contactPush = 0;
    this._groundBudget = 0;

    this.playerHealth = CFG.combat?.healthMax ?? 100;
    this.playerShield = CFG.combat?.shieldTiers?.[0] ?? 50;
    this._playerHurtT = 99;
    this._playerDownT = 0;

    this.stats = { alive: 0, squads: 0, kills: 0 };
  }

  /* ================================================================== */
  /* init                                                                */
  /* ================================================================== */

  async init(ctx) {
    this.ctx = ctx;
    this.bus = ctx.bus;
    await Materials.init(ctx.renderer);

    const world = ctx.engine.get('world');
    const player = ctx.engine.get('player');
    this.collision = world?.collision ?? player?.collision ?? null;
    this.world = world;
    this.player = player;
    this.nav = new NavMesh(world?.navGrid ?? null);

    const botCount = Math.min(AI.maxBots, AI.squads * AI.squadSize);
    this.renderer = new BodyRenderer(botCount + CORPSE_SLOTS).build(ctx.scene);
    for (let i = 0; i < CORPSE_SLOTS; i++) this._freeCorpseSlots.push(botCount + i);

    this._buildWorldContext();
    this._createSquads(botCount);
    this._hookRaycast(world);
    this._subscribe(ctx);

    // The map may not have finished building its BVH when we boot; the first
    // update retries until it has.
    this._spawnPending = true;
  }

  _buildWorldContext() {
    const self = this;
    this.W = {
      rng: this.rng,
      bus: this.bus,
      collision: this.collision,
      nav: this.nav,
      bots: this.bots,
      time: 0,
      player: {
        position: new THREE.Vector3(),
        eye: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        speed: 0, alive: true, downed: false, crouch: false, height: CFG.move.player.height,
      },
      groundAt: (x, z, y) => self._groundAt(x, z, y),
      losRay: (origin, dir, dist) => self._losRay(origin, dir, dist),
      losBetween: (a, b) => self._losBetween(a, b),
      onBotFire: (bot, dist, suppressing) => self._botFire(bot, dist, suppressing),
      onFootstep: (bot) => self._footstep(bot),
      onKilled: (bot, killer, byPlayer) => self._onKilled(bot, killer, byPlayer),
      onDowned: (bot, byPlayer) => self._onDowned(bot, byPlayer),
      onRevived: (bot, medic) => self._onRevived(bot, medic),
    };
  }

  _createSquads(botCount) {
    const roles = ['anchor', 'support', 'point'];
    let slot = 0;
    for (let s = 0; s < AI.squads && slot < botCount; s++) {
      const squad = new Squad(this.W, s);
      for (let i = 0; i < AI.squadSize && slot < botCount; i++) {
        const bot = new Bot(this.W, slot, squad, roles[i % roles.length]);
        squad.add(bot);
        this.bots.push(bot);
        this.byId.set(bot.id, bot);
        this.registry.register(bot.id, bot.pose, bot.scale);
        this.registry.byId.get(bot.id).alive = false;
        slot++;
      }
      this.squads.push(squad);
    }
  }

  /** Wrap world.raycast so bots are hittable by the existing weapon trace. */
  _hookRaycast(world) {
    if (!world || typeof world.raycast !== 'function' || world.__aiRaycastHook) return;
    const original = world.raycast.bind(world);
    this._worldRaycastOriginal = world.raycast;
    this._worldRef = world;
    world.__aiRaycastHook = true;
    world.raycast = (origin, dir, maxDist = 1000) => this._raycast(original, origin, dir, maxDist);
  }

  _subscribe(ctx) {
    const on = (type, fn) => this._unsub.push(ctx.bus.on(type, fn));
    on(EV.DAMAGE_DEALT, (p) => this._onDamage(p));
    on(EV.SHOT_FIRED, (p) => this._onShotHeard(p));
    on(EV.FOOTSTEP, (p) => this._onFootstepHeard(p));
    on(EV.IMPACT, (p) => this._onImpactHeard(p));
  }

  /* ================================================================== */
  /* raycast hook + damage resolution                                    */
  /* ================================================================== */

  _raycast(original, origin, dir, maxDist) {
    const wHit = original(origin, dir, maxDist);
    if (!this.registry.bodies.length) return wHit;

    const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const dx = dir.x / dl, dy = dir.y / dl, dz = dir.z / dl;
    const limit = wHit ? wHit.distance : maxDist;
    const b = this.registry.raycast(origin.x, origin.y, origin.z, dx, dy, dz, limit);
    if (!b) return wHit;

    const L = this._ledger;
    L.id = b.body.id; L.part = b.part;
    L.x = b.px; L.y = b.py; L.z = b.pz;
    L.live = true;

    return {
      point: new THREE.Vector3(b.px, b.py, b.pz),
      normal: new THREE.Vector3(b.nx, b.ny, b.nz),
      distance: b.distance,
      surface: 'flesh',
      object: b.object,
    };
  }

  /** Public helper for anything that wants a bot-aware trace. */
  raycast(origin, dir, maxDist = 1000) {
    const original = this._worldRaycastOriginal
      ? this._worldRaycastOriginal.bind(this._worldRef)
      : () => null;
    return this._raycast(original, origin, dir, maxDist);
  }

  _onDamage(p) {
    if (!p || p.team === 'ai') return;
    const bot = this.byId.get(p.targetId);
    if (!bot || !bot.alive) return;

    // Recover which region the shot actually entered. The weapon system does
    // raycast -> emit in one synchronous step, so the ledger entry is ours.
    let part = PART.TORSO;
    const L = this._ledger;
    if (L.live && L.id === p.targetId) {
      if (!p.point || Math.abs(p.point.x - L.x) + Math.abs(p.point.y - L.y)
        + Math.abs(p.point.z - L.z) < 0.05) {
        part = L.part;
      }
      L.live = false;
    }

    const res = bot.applyDamage(p.amount ?? 0, part, p.point, true);
    if (res.applied <= 0) return;

    const head = part === PART.HEAD;
    this.bus.emit(EV.DAMAGE_NUMBER, {
      amount: Math.round(res.applied),
      isHeadshot: head,
      crit: head,
      shield: res.shield > 0,
      point: p.point,
      targetId: bot.id,
    });
    // The weapon already fired a body hitmarker; upgrade it when it was better.
    if (head || res.killed || res.downed) {
      this.bus.emit(EV.HITMARKER, {
        isHeadshot: head, isKill: res.killed || res.downed, shieldBreak: res.shield > 0 && bot.shield <= 0,
      });
    }
    if (res.downed) this._onDowned(bot, true);
    if (res.killed) this._onKilled(bot, 'player', true);
  }

  /* ================================================================== */
  /* hearing                                                             */
  /* ================================================================== */

  _onShotHeard(p) {
    if (!p?.origin || p.team === 'ai') return;
    this._hear(p.origin, AI.hearing.shotRadius);
  }

  _onFootstepHeard(p) {
    if (!p?.position || p.team === 'ai') return;
    this._hear(p.position, AI.hearing.footstepRadius * clamp((p.speed ?? 4) / 4.6, 0.5, 1.6));
  }

  _onImpactHeard(p) {
    if (!p?.point || p.team === 'ai' || p.surface === 'flesh') return;
    this._hear(p.point, AI.hearing.impactRadius);
    // Rounds cracking into the wall next to you are what put your head down.
    this._suppressNear(p.point, 3.5, null);
  }

  _hear(pos, radius) {
    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i];
      if (!b.combatReady) continue;
      b.hear(pos.x, pos.y, pos.z, radius);
    }
  }

  /* ================================================================== */
  /* services used by bots                                               */
  /* ================================================================== */

  _groundAt(x, z, y) {
    const c = this.collision;
    if (!c?.ready) return this.world?.groundHeight?.(x, z) ?? y;
    const h = c.raycastRef(x, y + 1.4, z, 0, -1, 0, 4.0);
    if (h) return h.py;
    const g = this.world?.groundHeight?.(x, z);
    return typeof g === 'number' ? g : y;
  }

  _losRay(origin, dir, dist) {
    const c = this.collision;
    if (!c?.ready) return true;
    return !c.raycastRef(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, Math.max(0.1, dist));
  }

  _losBetween(a, b) {
    const c = this.collision;
    if (!c?.ready) return true;
    _dir.copy(b).sub(a);
    const d = _dir.length();
    if (d < 1e-3) return true;
    _dir.multiplyScalar(1 / d);
    return !c.raycastRef(a.x, a.y, a.z, _dir.x, _dir.y, _dir.z, d - 0.25);
  }

  _footstep(bot) {
    const p = bot.mover.position;
    const d = p.distanceTo(this.W.player.position);
    if (d > 42) return;
    this.bus.emit(EV.FOOTSTEP, {
      position: _pt.copy(p).clone(),
      surface: bot.mover.groundSurface || 'concrete',
      speed: bot.mover.speed,
      entityId: bot.id,
      team: 'ai',
    });
  }

  /* ================================================================== */
  /* bot gunfire                                                         */
  /* ================================================================== */

  _botFire(bot, dist, suppressing) {
    const w = bot.weapon;
    const def = w.def;
    const origin = bot.gait.muzzle;
    const dir = bot.aim;

    this.bus.emit(EV.SHOT_FIRED, {
      weaponId: def.id,
      origin: origin.clone(),
      dir: dir.clone(),
      spread: suppressing ? 2.4 : 1.1,
      entityId: bot.id,
      team: 'ai',
    });

    const range = def.maxRange ?? 400;
    const c = this.collision;
    let worldT = range;
    let hit = null;
    if (c?.ready) {
      hit = c.raycastRef(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, range);
      if (hit) worldT = hit.distance;
    }

    // Player capsule test — bots resolve their own hits so damage, headshots
    // and feedback are all consistent with what the model is actually doing.
    const P = this.player;
    let playerT = -1, playerHead = false;
    if (P && this.W.player.alive) {
      const pp = P.position;
      const h = P.capsuleHeight ?? CFG.move.player.height;
      const r = CFG.move.player.radius;
      const ay = pp.y + r, by = pp.y + Math.max(r, h - r);
      const t = rayCapsule(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
        pp.x, ay, pp.z, pp.x, by, pp.z, r);
      if (t >= 0 && t < worldT) {
        playerT = t;
        playerHead = (origin.y + dir.y * t) > pp.y + h - 0.30;
      }
    }

    if (playerT >= 0) {
      _pt.set(origin.x + dir.x * playerT, origin.y + dir.y * playerT, origin.z + dir.z * playerT);
      this._damagePlayer(bot, w.damageAt(playerT), playerHead, _pt);
      this._tracer(origin, _pt, def);
      return;
    }

    if (hit) {
      _pt.set(hit.px, hit.py, hit.pz);
      _n.set(hit.nx, hit.ny, hit.nz);
      this.bus.emit(EV.IMPACT, {
        point: _pt.clone(), normal: _n.clone(),
        surface: hit.surface || 'concrete', scale: 0.85, team: 'ai',
      });
      // Rounds cracking past cover push the player's squad-mates' heads down;
      // here it also suppresses any bot standing near the impact.
      this._suppressNear(_pt, 3.2, bot);
      this._tracer(origin, _pt, def);
    } else {
      _pt.copy(origin).addScaledVector(dir, range);
      this._tracer(origin, _pt, def);
    }
  }

  _tracer(origin, end, def) {
    if ((this._tracerSkip = (this._tracerSkip ?? 0) + 1) % 2) return;
    this.bus.emit('vfx:tracer', {
      origin: origin.clone(), end: end.clone(),
      speed: def.hitscan === false ? (def.projectileSpeed || 700) : 900,
    });
  }

  _suppressNear(point, radius, shooter) {
    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i];
      if (b === shooter || !b.combatReady) continue;
      if (b.mover.position.distanceToSquared(point) < radius * radius) {
        b.suppressed = Math.max(b.suppressed, AI.combat.suppressedTime * 0.6);
      }
    }
  }

  _damagePlayer(bot, base, isHeadshot, point) {
    // A knocked player still gets shot at — that reads correctly and keeps the
    // squad pushing — but the HUD is not spammed with damage they cannot lose.
    if (this.W.player.downed) {
      this.bus.emit(EV.IMPACT, {
        point: point.clone(), normal: _n.set(0, 1, 0).clone(),
        surface: 'flesh', scale: 0.7, team: 'ai',
      });
      return;
    }
    const mul = isHeadshot ? (CFG.combat?.headshotMul ?? 2) : 1;
    let amount = base * mul * AI.combat.damageScale;
    let shieldDamage = 0;
    if (this.playerShield > 0) {
      shieldDamage = Math.min(this.playerShield, amount);
      this.playerShield -= shieldDamage;
    }
    this.playerHealth -= Math.max(0, amount - shieldDamage);
    this._playerHurtT = 0;

    this.bus.emit(EV.DAMAGE_DEALT, {
      targetId: 'player',
      amount,
      isHeadshot,
      point: point.clone(),
      shieldDamage,
      sourceId: bot.id,
      team: 'ai',
    });
    this.bus.emit(EV.IMPACT, {
      point: point.clone(), normal: _n.set(0, 1, 0).clone(),
      surface: 'flesh', scale: 0.8, team: 'ai',
    });
    this.bus.emit(EV.CAMERA_SHAKE, {
      amplitude: isHeadshot ? 0.36 : 0.2, frequency: 30, duration: 0.14,
    });

    if (this.playerHealth <= 0 && !this.W.player.downed) {
      this.W.player.downed = true;
      this._playerDownT = 0;
    }
  }

  /* ================================================================== */
  /* death / down / revive                                               */
  /* ================================================================== */

  _onDowned(bot, byPlayer) {
    const reg = this.registry.byId.get(bot.id);
    if (reg) reg.alive = true;                 // still shootable while knocked
    this.bus.emit(EV.ENTITY_DOWNED, {
      id: bot.id, name: bot.name, victim: bot.name,
      by: byPlayer ? 'player' : 'ai', byPlayer: !!byPlayer,
      position: bot.mover.position.clone(),
      point: bot.mover.position.clone(),
      weapon: 'ar', squad: bot.squad?.name,
    });
  }

  _onKilled(bot, killer, byPlayer) {
    if (!bot.active && bot.dead && !this.byId.has(bot.id)) return;
    bot._die();
    const reg = this.registry.byId.get(bot.id);
    if (reg) reg.alive = false;
    this.stats.kills += byPlayer ? 1 : 0;

    _pt.copy(bot.mover.position);
    _pt.y += 1.0;
    this.bus.emit(EV.ENTITY_KILLED, {
      id: bot.id, name: bot.name, victim: bot.name,
      by: byPlayer ? 'player' : 'world', byPlayer: !!byPlayer,
      killer: byPlayer ? 'player' : (bot.squad?.name ?? 'WORLD'),
      position: _pt.clone(), point: _pt.clone(),
      weapon: 'ar', headshot: false,
    });
    // The HUD builds its own feed row from ENTITY_KILLED; only publish the
    // dedicated feed event when nothing else is going to do it, otherwise the
    // same elimination is listed twice.
    if (!this._uiPresent) {
      this.bus.emit(EV.KILLFEED, {
        killer: byPlayer ? 'YOU' : (bot.squad?.name ?? 'WORLD'),
        victim: bot.name, weapon: 'ar', headshot: false, self: !!byPlayer,
      });
    }

    this._spawnCorpse(bot);
    this.renderer.hide(bot.slot);
  }

  _onRevived(bot, medic) {
    this.bus.emit('entity:revived', {
      id: bot.id, name: bot.name, by: medic?.id, position: bot.mover.position.clone(),
    });
  }

  /** Hand the live pose to the shared ragdoll world so bodies fall properly. */
  _spawnCorpse(bot) {
    const rw = this.player?.ragdolls;
    const slot = this._freeCorpseSlots.pop();
    if (!rw || slot === undefined) {
      if (slot !== undefined) this._freeCorpseSlots.push(slot);
      return;
    }
    const rd = rw.spawn(bot.mover.position, {
      yaw: bot.yaw,
      vx: bot.mover.velocity.x, vy: bot.mover.velocity.y + 0.6, vz: bot.mover.velocity.z,
      scale: bot.scale,
    });
    if (!rd) { this._freeCorpseSlots.push(slot); return; }
    // Seed the ragdoll with the exact pose the bot died in. Bind lengths match
    // (Skeleton.BIND mirrors Ragdoll.REST) so the constraints stay satisfied.
    if (rd.pos?.length === JOINT_COUNT * 3) {
      for (let i = 0; i < JOINT_COUNT * 3; i++) {
        rd.pos[i] = bot.pose[i];
        rd.old[i] = bot.pose[i];
      }
    }
    this.corpses.push({ rd, slot, age: 0 });
  }

  /* ================================================================== */
  /* spawning                                                            */
  /* ================================================================== */

  _spawnSquad(squad) {
    const anchor = this._pickSpawnAnchor();
    if (!anchor) return false;
    const yaw = this.rng() * Math.PI * 2;
    let placed = 0;
    for (let i = 0; i < squad.members.length; i++) {
      const bot = squad.members[i];
      const a = yaw + (i / squad.members.length) * Math.PI * 2;
      const r = 1.8 + this.rng() * 2.6;
      const x = anchor.x + Math.cos(a) * r;
      const z = anchor.z + Math.sin(a) * r;
      const y = this._groundAt(x, z, anchor.y) + 0.05;
      bot.spawn(x, y, z, yaw + Math.PI);
      const reg = this.registry.byId.get(bot.id);
      if (reg) { reg.alive = true; reg.scale = bot.scale; }
      placed++;
    }
    squad.hasContact = false;
    squad.contactTime = -999;
    squad.hasRoam = false;
    return placed > 0;
  }

  _pickSpawnAnchor() {
    const pts = this.world?.spawnPoints;
    const pp = this.W.player.position;
    const cand = [];
    if (pts?.length) {
      for (const p of pts) {
        const d = Math.hypot(p.x - pp.x, p.z - pp.z);
        if (d >= AI.spawnMin && d <= AI.spawnMax) cand.push(p);
      }
      if (!cand.length) for (const p of pts) cand.push(p);
    }
    if (cand.length) {
      const p = cand[Math.floor(this.rng() * cand.length) % cand.length];
      _v.set(p.x, this._groundAt(p.x, p.z, p.y) + 0.05, p.z);
      return _v;
    }
    if (!this.nav?.ready) return null;
    for (let i = 0; i < 24; i++) {
      const a = this.rng() * Math.PI * 2;
      const d = AI.spawnMin + this.rng() * (AI.spawnMax - AI.spawnMin);
      const x = pp.x + Math.cos(a) * d, z = pp.z + Math.sin(a) * d;
      if (this.nav.walkable(x, z)) {
        _v.set(x, this._groundAt(x, z, pp.y) + 0.05, z);
        return _v;
      }
    }
    return null;
  }

  /* ================================================================== */
  /* tick                                                                */
  /* ================================================================== */

  fixedUpdate(dt, ctx) {
    if (!this.enabled) return;
    this.time += dt;
    this.W.time = this.time;
    this._syncPlayer(dt, ctx);

    // Bots step at 40 Hz, not the physics 120 Hz. Each step runs a full
    // collide-and-slide translate plus a ground probe against the BVH, so
    // running twelve of them three times more often than necessary is the
    // single biggest cost the AI could inflict on the frame. 25 ms is far
    // finer than any decision the AI makes and finer than any weapon's
    // interval, so nothing observable changes.
    this._simAccum += dt;
    let steps = 0;
    while (this._simAccum >= SIM_STEP && steps < 3) {
      this._simAccum -= SIM_STEP;
      steps++;
      for (let i = 0; i < this.bots.length; i++) {
        const b = this.bots[i];
        if (!b.active) continue;
        if (b.frozen) { b.weapon.update(SIM_STEP); continue; }
        b.fixedUpdate(SIM_STEP);
      }
      if (this.showcase) this._showcaseWalk(SIM_STEP);
    }
    if (steps >= 3) this._simAccum = 0;
  }

  _syncPlayer(dt, ctx) {
    const P = this.player;
    const p = this.W.player;
    if (P?.position) {
      p.position.copy(P.position);
      p.eye.copy(P.eyePosition ?? P.position);
      if (!P.eyePosition) p.eye.y += CFG.move.player.height - 0.14;
      p.velocity.copy(P.velocity ?? _v.set(0, 0, 0));
      p.speed = Math.hypot(p.velocity.x, p.velocity.z);
      p.crouch = !!P.isCrouching;
      p.height = P.capsuleHeight ?? CFG.move.player.height;
    } else if (ctx?.camera) {
      ctx.camera.getWorldPosition(p.eye);
      p.position.copy(p.eye);
      p.position.y -= CFG.move.player.height - 0.14;
      p.velocity.set(0, 0, 0);
      p.speed = 0;
    }

    // Health model for the player, mirrored from what our own bots have dealt.
    this._playerHurtT += dt;
    if (p.downed) {
      this._playerDownT += dt;
      if (this._playerDownT > (CFG.combat?.reviveTime ?? 6) * 5) {
        p.downed = false;
        this.playerHealth = 45;
        this.playerShield = 0;
        this._playerHurtT = 0;
      }
    } else if (this._playerHurtT > 7) {
      const max = CFG.combat?.healthMax ?? 100;
      this.playerHealth = Math.min(max, this.playerHealth + 9 * dt);
    }
    // A knocked player is still a target — that is the whole point of pushing
    // one. `alive` only ever goes false if the player object disappears.
    p.alive = !!P || !!ctx?.camera;
  }

  update(dt, alpha, ctx) {
    if (!this.enabled) return;
    // The engine's first frame can produce a negative dt; everything below
    // integrates, so sanitise once at the boundary.
    dt = dt > 0 ? (dt < 0.1 ? dt : 0.1) : 0;
    if (this._uiPresent === undefined) this._uiPresent = !!ctx.engine.get('ui');

    if (this._spawnPending) this._trySpawnInitial();

    if (!this.showcase) {
      this._schedule(dt);
      this._respawn(dt);
    }

    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i];
      if (!b.active || b.dead) continue;
      b.animate(dt);
      this.renderer.writeBody(b.slot, b.pose, b.gait.facing, b.gait.aim, b.gait.gunPos, b.scale);
    }

    this._updateCorpses(dt);
    this.renderer.flush();
    this._publishContacts(dt);
  }

  _trySpawnInitial() {
    if (!this.collision?.ready && !this.nav?.ready) return;
    this._spawnPending = false;
    // Only the first squad drops immediately; the rest trickle in so the map
    // does not fill with bots the instant the match starts.
    if (this.squads.length) this._spawnSquad(this.squads[0]);
  }

  /**
   * Round-robin scheduler. Each rendered frame spends a fixed, small budget:
   * a handful of LOS rays, one path, one cover evaluation, one squad brain.
   */
  _schedule(dt) {
    const n = this.bots.length;
    if (!n) return;

    // --- perception -------------------------------------------------------
    let budget = AI.budget.losPerFrame;
    for (let i = 0; i < n && budget > 0; i++) {
      const b = this.bots[this._senseAt = (this._senseAt + 1) % n];
      if (!b.combatReady) continue;
      const d = b.mover.position.distanceToSquared(this.W.player.position);
      if (d > AI.cullDistance * AI.cullDistance) continue;
      // Awareness must integrate real elapsed time, not the frame's dt — a bot
      // that is only looked at every third frame would otherwise spot you at
      // three times the intended rate.
      b.sense(clamp(b.losAge, 0.008, 1.0));
      budget--;
    }

    // --- decisions ---------------------------------------------------------
    let think = Math.max(1, Math.ceil(n / 4));
    for (let i = 0; i < n && think > 0; i++) {
      const b = this.bots[this._thinkAt = (this._thinkAt + 1) % n];
      if (!b.active || b.dead) continue;
      b.think();
      think--;
    }

    // --- pathfinding -------------------------------------------------------
    let paths = AI.budget.pathsPerFrame;
    for (let i = 0; i < n && paths > 0; i++) {
      const b = this.bots[this._pathAt = (this._pathAt + 1) % n];
      if (!b.alive || b.downed || !b.hasGoal || b.repath > 0) continue;
      b.buildPath();
      paths--;
    }

    // --- squad brains -------------------------------------------------------
    if (this.squads.length) {
      this._squadAt = (this._squadAt + 1) % this.squads.length;
      const sq = this.squads[this._squadAt];
      const step = dt * this.squads.length;
      sq.tickCover(step);
      sq.think(step);
    }
  }

  _respawn(dt) {
    this._respawnTimer -= dt;
    if (this._respawnTimer > 0) return;
    this._respawnTimer = AI.respawnDelay;
    for (const sq of this.squads) {
      if (sq.members.some((b) => b.alive)) continue;
      if (this._spawnSquad(sq)) break;
    }
  }

  _updateCorpses(dt) {
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.age += dt;
      const rd = c.rd;
      if (!rd?.alive || c.age > 26) {
        this.renderer.hide(c.slot);
        this._freeCorpseSlots.push(c.slot);
        this.corpses.splice(i, 1);
        continue;
      }
      const pose = this._corpsePose;
      for (let k = 0; k < JOINT_COUNT * 3; k++) pose[k] = rd.pos[k];
      // Facing from the shoulder line and the spine: forward = up x right.
      _v.set(pose[J.SHOULDER_R * 3] - pose[J.SHOULDER_L * 3],
        pose[J.SHOULDER_R * 3 + 1] - pose[J.SHOULDER_L * 3 + 1],
        pose[J.SHOULDER_R * 3 + 2] - pose[J.SHOULDER_L * 3 + 2]);
      _v2.set(pose[J.CHEST * 3] - pose[J.PELVIS * 3],
        pose[J.CHEST * 3 + 1] - pose[J.PELVIS * 3 + 1],
        pose[J.CHEST * 3 + 2] - pose[J.PELVIS * 3 + 2]);
      _fwd.crossVectors(_v2, _v);
      if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1); else _fwd.normalize();
      // The rifle stays in the right hand, pointing along the forearm.
      _dir.set(pose[J.HAND_R * 3] - pose[J.ELBOW_R * 3],
        pose[J.HAND_R * 3 + 1] - pose[J.ELBOW_R * 3 + 1],
        pose[J.HAND_R * 3 + 2] - pose[J.ELBOW_R * 3 + 2]);
      if (_dir.lengthSq() < 1e-6) _dir.copy(_fwd); else _dir.normalize();
      _v.set(pose[J.HAND_R * 3], pose[J.HAND_R * 3 + 1], pose[J.HAND_R * 3 + 2]);
      this.renderer.writeBody(c.slot, pose, _fwd, _dir, _v, 1);
    }
  }

  _publishContacts(dt) {
    this._contactPush -= dt;
    if (this._contactPush > 0) return;
    this._contactPush = 0.4;
    const out = this._contactList ||= [];
    const pool = this._contactPool ||= [];
    out.length = 0;
    let n = 0;
    for (const b of this.bots) {
      if (!b.alive) continue;
      // Only bots that can currently see the player show up as known hostiles.
      if (!b.visible && this.time - b.lastSeen > 3) continue;
      const e = pool[n] ||= { x: 0, z: 0, downed: false };
      e.x = b.mover.position.x; e.z = b.mover.position.z; e.downed = b.downed;
      out.push(e);
      n++;
    }
    if (out.length) this.bus.emit('ui:contacts', out);
  }

  /* ================================================================== */
  /* screenshot harness                                                  */
  /* ================================================================== */

  /**
   * Put a squad in front of the camera in a readable pose: one holding a
   * firing stance, one walking across frame, one crouched behind the others.
   * Called by tools/review.mjs before the gameplay frame is captured.
   *
   * Placement is *searched*, not assumed. The default spawn sits about 1.9 m
   * from a hangar wall, so anything dropped at a fixed distance down the
   * camera axis ends up behind it — visible only as a pair of legs under the
   * wall's bottom edge. Instead: probe a fan of directions for open ground,
   * pick the three roomiest that are far enough apart to read as a group, and
   * then verify line of sight to each bot's chest before committing.
   */
  debugPresent() {
    this.showcase = true;
    if (!this.squads.length) return;

    const P = this.player;
    const cam = this.ctx?.camera;
    _eye.copy(this.W.player.eye);
    if (P?.eyePosition) _eye.copy(P.eyePosition);
    else if (cam) cam.getWorldPosition(_eye);

    // Face the way the player is looking, not the way the review camera was
    // parked for the previous frame.
    let yaw = P?.yaw;
    if (yaw === undefined || yaw === null) {
      if (cam) { cam.getWorldDirection(_fwd); yaw = Math.atan2(-_fwd.x, -_fwd.z); }
      else yaw = 0;
    }
    _fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));

    const dirs = this._openDirections(_eye);
    const squad = this.squads[0];
    const modes = ['aim', 'walk', 'crouch'];

    for (let i = 0; i < squad.members.length; i++) {
      const bot = squad.members[i];
      const slotDir = dirs[i % Math.max(1, dirs.length)];
      const mode = modes[i % modes.length];
      if (!slotDir) { bot.despawn(); this.renderer.hide(bot.slot); continue; }

      const dx = slotDir.dx, dz = slotDir.dz;
      // Stagger the group in depth, but never past what the direction affords.
      const want = SHOW_DIST[i % SHOW_DIST.length];
      let dist = Math.min(want, slotDir.open - 1.5);
      if (dist < SHOW_MIN) dist = Math.min(want, Math.max(SHOW_MIN, slotDir.open - 0.8));

      // In a corridor the fan may only find one usable bearing; spreading the
      // squad sideways off it keeps three separate silhouettes rather than
      // three figures stacked on the same screen column. The offset is a
      // *preference*, not a commitment — the search below drops it rather than
      // park a bot behind a wall.
      const lateral = dirs.length >= 3 ? 0 : SHOW_LATERAL[i % SHOW_LATERAL.length];
      const spot = this._findVisibleSpot(_eye, dx, dz, dist, lateral);
      if (!spot) { bot.despawn(); this.renderer.hide(bot.slot); continue; }
      const x = spot.x, y = spot.y, z = spot.z;

      const face = Math.atan2(-(_eye.x - x), -(_eye.z - z));
      bot.spawn(x, y, z, face);
      const reg = this.registry.byId.get(bot.id);
      if (reg) { reg.alive = true; reg.scale = bot.scale; }

      bot.frozen = true;
      bot.hasContact = false;
      bot.awareness = 0;
      bot.wantCrouch = mode === 'crouch';
      bot.ready = mode === 'walk' ? 0.35 : 1;
      // Cover an angle *past* the camera rather than staring down the lens: a
      // rifle aimed straight at the viewer is fully foreshortened and reads as
      // nothing at all. Yawing the aim gives the weapon a silhouette.
      _v.set(_eye.x - x, (_eye.y + 0.05) - (y + 1.55 * bot.scale), _eye.z - z).normalize();
      const off = SHOW_AIM_YAW[i % SHOW_AIM_YAW.length];
      if (off) {
        const ca = Math.cos(off), sa = Math.sin(off);
        const ax = _v.x * ca - _v.z * sa, az = _v.x * sa + _v.z * ca;
        _v.set(ax, _v.y, az).normalize();
      }
      bot.aim.copy(_v);

      if (mode === 'walk') {
        // Cross the frame at a shallow angle rather than square-on, so the
        // body still reads three-quarter and the rifle is not slung fully
        // across the chest.
        const wx = dx * -0.45 - dz * 0.89;
        const wz = dx * 0.89 - dz * 0.45;
        bot.showcaseWalk = { dirX: wx, dirZ: wz, t: 0, sign: 1, speed: 2.0 };
        // Walk it in from behind so the gait genuinely lands mid-stride.
        this._prime(bot, wx, wz, 2.0, 30);
        bot.yaw = Math.atan2(-wx, -wz);
        bot.aim.set(wx, -0.10, wz).normalize();
      } else {
        bot.showcaseWalk = null;
        for (let k = 0; k < 6; k++) bot.animate(1 / 30);
      }
      this.renderer.writeBody(bot.slot, bot.pose, bot.gait.facing, bot.gait.aim, bot.gait.gunPos, bot.scale);
    }
    this.renderer.flush();
  }

  /**
   * Fan of horizontal directions in front of the eye, each scored by how much
   * open ground it has. Probed at eye height *and* chest height, because the
   * thing most likely to be in the way is a wall whose bottom edge is above
   * knee height — exactly the case that made a squad render as three pairs of
   * boots.
   * @returns {Array<{dx,dz,open}>} up to three well-separated directions,
   *   roomiest first, or [] when there is no collision world to probe.
   */
  _openDirections(eye) {
    const out = this._dirScratch ||= [];
    out.length = 0;
    const c = this.collision;
    if (!c?.ready) {
      for (const ang of [-0.30, 0.06, 0.34]) {
        const ca = Math.cos(ang), sa = Math.sin(ang);
        out.push({ dx: _fwd.x * ca - _fwd.z * sa, dz: _fwd.x * sa + _fwd.z * ca, open: SHOW_MAX });
      }
      return out;
    }

    // Stay inside the *actual* frustum. camera.fov is vertical, so the
    // horizontal half-angle needs the aspect folded in, and the whole fan is
    // biased left because the viewmodel owns the right third of the frame.
    const cam = this.ctx?.camera;
    const vfov = ((cam?.fov ?? CFG.camera?.fov ?? 96) * Math.PI) / 180;
    const aspect = cam?.aspect > 0.1 ? cam.aspect : 16 / 9;
    const halfH = Math.atan(Math.tan(vfov * 0.5) * aspect);
    const maxL = halfH * 0.88, maxR = halfH * 0.15;

    const pool = this._fanScratch ||= [];
    pool.length = 0;
    const FAN = 29;
    for (let i = 0; i < FAN; i++) {
      const ang = -maxL + ((maxL + maxR) * i) / (FAN - 1);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const dx = _fwd.x * ca - _fwd.z * sa;
      const dz = _fwd.x * sa + _fwd.z * ca;
      let open = SHOW_MAX;
      for (let h = 0; h < 2; h++) {
        const oy = eye.y - (h === 0 ? 0 : 0.40);
        const hit = c.raycastRef(eye.x, oy, eye.z, dx, 0, dz, SHOW_MAX);
        if (hit && hit.distance < open) open = hit.distance;
      }
      // Room matters, but only up to a point; past ~18 m a bot is too small to
      // judge anyway, so prefer a roomy direction nearer the centre of frame.
      pool.push({ ang, dx, dz, open, score: Math.min(open, 18) - Math.abs(ang) * 2.2 });
    }

    // Best first, then greedily keep directions that are far enough apart to
    // read as three separate figures rather than one clump.
    pool.sort((a, b) => b.score - a.score);
    for (const cand of pool) {
      if (out.length >= 3) break;
      if (cand.open < SHOW_MIN + 1.2) continue;
      let ok = true;
      for (const chosen of out) if (Math.abs(chosen.ang - cand.ang) < 0.19) { ok = false; break; }
      if (ok) out.push(cand);
    }
    if (!out.length && pool.length) out.push(pool[0]);   // corridor: take the best we have
    // Left to right, so the depth stagger below reads as a formation.
    out.sort((a, b) => a.ang - b.ang);
    return out;
  }

  /**
   * Search (lateral offset x distance) along a bearing for ground that is
   * unoccluded from the eye and roomy enough to stand in. Returns the first
   * spot that passes both tests, preferring the requested framing.
   */
  _findVisibleSpot(eye, dx, dz, wantDist, lateral) {
    const perpX = -dz, perpZ = dx;
    const lats = this._latScratch ||= [0, 0, 0, 0, 0];
    lats[0] = lateral; lats[1] = lateral * 0.45; lats[2] = 0;
    lats[3] = -lateral * 0.5; lats[4] = -lateral;
    const out = this._spotScratch ||= { x: 0, y: 0, z: 0 };
    const c = this.collision;

    for (let li = 0; li < lats.length; li++) {
      for (let d = wantDist; d >= 2.8; d -= 0.9) {
        const x = eye.x + dx * d + perpX * lats[li];
        const z = eye.z + dz * d + perpZ * lats[li];
        const y = this._groundAt(x, z, this.W.player.position.y) + 0.005;
        if (!this._visibleFrom(eye, x, y + 1.35, z)) continue;
        if (c?.ready) {
          _v.set(x, y + 0.02, z);
          if (!c.isFree(_v, AI.move.radius * 0.9, AI.move.height * 0.9, 0.06)) continue;
        }
        out.x = x; out.y = y; out.z = z;
        return out;
      }
    }
    return null;
  }

  /** True when nothing solid sits between the eye and a world point. */
  _visibleFrom(eye, x, y, z) {
    const c = this.collision;
    if (!c?.ready) return true;
    _dir.set(x - eye.x, y - eye.y, z - eye.z);
    const d = _dir.length();
    if (d < 0.2) return false;
    _dir.multiplyScalar(1 / d);
    return !c.raycastRef(eye.x, eye.y, eye.z, _dir.x, _dir.y, _dir.z, d - 0.35);
  }

  /** Advance a bot's locomotion as if it had been walking, without physics. */
  _prime(bot, dx, dz, speed, steps) {
    const step = 1 / 30;
    const p = bot.mover.position;
    bot.yaw = Math.atan2(-dx, -dz);
    p.x -= dx * speed * step * steps;
    p.z -= dz * speed * step * steps;
    p.y = this._groundAt(p.x, p.z, p.y) + 0.005;
    bot.gait.reset(p.x, p.y, p.z, bot.yaw);
    bot.mover.velocity.set(dx * speed, 0, dz * speed);
    bot.aim.set(dx, -0.1, dz).normalize();
    for (let k = 0; k < steps; k++) {
      p.x += dx * speed * step;
      p.z += dz * speed * step;
      p.y = this._groundAt(p.x, p.z, p.y) + 0.005;
      bot.animate(step);
    }
  }

  _showcaseWalk(dt) {
    for (const b of this.bots) {
      const w = b.showcaseWalk;
      if (!w || !b.active) continue;
      w.t += dt * w.sign;
      if (w.t > 2.2) w.sign = -1;
      else if (w.t < -2.2) w.sign = 1;
      const p = b.mover.position;
      const vx = w.dirX * w.speed * w.sign, vz = w.dirZ * w.speed * w.sign;
      p.x += vx * dt;
      p.z += vz * dt;
      p.y = this._groundAt(p.x, p.z, p.y) + 0.005;
      b.mover.velocity.set(vx, 0, vz);
      b.yaw = Math.atan2(-vx, -vz);
      b.aim.set(vx, -0.10 * w.speed, vz).normalize();
    }
  }

  /* ================================================================== */

  /** Snapshot for the HUD / debug overlays. */
  getState() {
    let alive = 0, squads = 0;
    for (const s of this.squads) {
      const n = s.members.filter((b) => b.alive).length;
      if (n) { squads++; alive += n; }
    }
    this.stats.alive = alive;
    this.stats.squads = squads;
    return this.stats;
  }

  dispose() {
    for (const off of this._unsub) off?.();
    this._unsub.length = 0;
    if (this._worldRef && this._worldRaycastOriginal) {
      this._worldRef.raycast = this._worldRaycastOriginal;
      this._worldRef.__aiRaycastHook = false;
    }
    this.registry.clear();
    this.renderer?.dispose();
    this.bots.length = 0;
    this.squads.length = 0;
    this.byId.clear();
  }
}
