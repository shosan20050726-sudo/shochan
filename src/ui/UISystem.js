import * as THREE from 'three';
import { EV } from '../core/EventBus.js';
import { makeRNG } from '../core/Rand.js';
import { injectStyles } from './styles.js';
import { el, clamp, clamp01, damp, setVar } from './theme.js';

import Vitals, { Squad } from './widgets/Vitals.js';
import WeaponPanel, { Abilities } from './widgets/Weapon.js';
import Crosshair from './widgets/Crosshair.js';
import DamageNumbers from './widgets/DamageNumbers.js';
import Minimap, { Compass } from './widgets/Minimap.js';
import KillFeed, { MatchStats, Banner } from './widgets/KillFeed.js';
import RingPanel from './widgets/RingPanel.js';
import Overlays from './widgets/Overlays.js';
import PauseMenu from './widgets/PauseMenu.js';

const _v = new THREE.Vector3();
const _box = new THREE.Box3();

/**
 * HUD / interface system.
 *
 * Everything is driven from the event bus so the HUD works standalone: when a
 * gameplay system that would own a piece of state is missing, the HUD falls
 * back to simulating just enough of it (reload progress, ability cooldowns,
 * ring countdown, ammo) to stay coherent. That fallback is also what makes
 * `window.__UI_DEMO = true` able to exercise every widget.
 *
 * In addition to the canonical EV names, these additive patch events are
 * accepted (all optional, all shallow-merged):
 *   ui:player  {name,level,x,z,fx,fz,speed,grounded,ads,downed}
 *   ui:vitals  {health,healthMax,shield,shieldMax,downed,bleedTime,bleedTotal}
 *   ui:weapon  {name,kind,mag,magMax,reserve,ammo,mode,reloading,reloadProgress}
 *   ui:slots   [{name,active}]
 *   ui:squad   [{name,health,shield,...,x,z,fx,fz,downed,dead,fighting}]
 *   ui:ability {tactical:{cd,cdMax,charges,maxCharges}, ultimate:{charge}}
 *   ui:match   {squads,alive,kills,damage}
 *   ui:contacts[{x,z}]
 *   ui:items   {syringe,medkit,cell,battery}
 */
export default class UISystem {
  name = 'ui';
  priority = 80;

  constructor() {
    this.s = {
      name: 'OPERATOR', level: 1,
      health: 100, healthMax: 100, shield: 100, shieldMax: 100,
      downed: false, bleedTime: 30, bleedTotal: 30,
      speed: 0, grounded: true, ads: false, bloom: 0, overEnemy: false,
      weapon: {
        name: 'CR-56 CARBINE', kind: 'ar', mag: 28, magMax: 28, reserve: 180,
        ammo: 'light', mode: 'AUTO', reloading: false, reloadProgress: 0, reloadDur: 2.3,
      },
      slots: [{ name: 'CR-56', active: true }, { name: 'TS-12', active: false }],
      abilities: {
        tactical: { cd: 0, cdMax: 20, charges: 2, maxCharges: 2 },
        ultimate: { charge: 0 },
      },
      squad: [], contacts: [],
      items: { syringe: 3, medkit: 1, cell: 4, battery: 2 },
      ring: {
        stage: 1, phase: 'wait', time: 45, total: 45,
        x: 0, z: 0, radius: 300, nextX: 0, nextZ: 0, nextRadius: 180,
      },
      match: { squads: 20, alive: 60, kills: 0, damage: 0 },
      player: { x: 0, z: 0, fx: 0, fz: -1 },
    };
    this.settings = { opacity: 1, damageNumbers: true, rotateMinimap: true, hitmarkers: true };
    this._offs = [];
    this._sinceHurt = 99;
    this._sawDamageNumber = -99;
    this._t = 0;
  }

  /* ------------------------------------------------------------- init -- */

  async init(ctx) {
    this.ctx = ctx;
    const host = document.getElementById('ui-root');
    if (!host) { console.warn('[ui] #ui-root missing'); return; }
    this.host = host;
    injectStyles(host);

    const root = el('div', 'hud', host);
    this.root = root;
    el('div', 'hud-scrim', root);
    const backLayer = el('div', 'hud-back', root);

    this.minimap = new Minimap(root);
    this.ringPanel = new RingPanel(root);
    this.compass = new Compass(root);
    this.stats = new MatchStats(root);
    this.feed = new KillFeed(root);
    this.squad = new Squad(root);
    this.vitals = new Vitals(root, ctx.cfg);
    this.abilities = new Abilities(root);
    this.weapon = new WeaponPanel(root);
    this.crosshair = new Crosshair(root);
    this.numbers = new DamageNumbers(root);
    this.banner = new Banner(root);
    this.overlays = new Overlays(root, backLayer);
    this.menu = new PauseMenu(root, ctx, this);

    this.squad.tiers = ctx.cfg?.combat?.shieldTiers;

    // Ring defaults from config so stage 1 reads correctly with no match system.
    const st0 = ctx.cfg?.ring?.stages?.[0];
    if (st0) {
      this.s.ring.radius = st0.radius;
      this.s.ring.time = st0.waitTime;
      this.s.ring.total = st0.waitTime;
      this.s.ring.nextRadius = ctx.cfg.ring.stages[1]?.radius ?? st0.radius * 0.6;
    }

    this.minimap.setBlocks(this._buildBlocks(ctx));
    this._resize();
    this._onWinResize = () => this._resize();
    window.addEventListener('resize', this._onWinResize);

    // Which state do we own because nobody else does?
    const eng = ctx.engine;
    this.autoVitals = !eng.get('player');
    this.autoWeapon = !eng.get('weapons');
    this.autoAbility = !eng.get('legends');
    this.autoRing = !eng.get('match');

    this._wire(ctx);
    this.applySettings();

    if (window.__UI_DEMO) {
      const { default: DemoDriver } = await import('./DemoDriver.js');
      this.demo = new DemoDriver(ctx, this);
      this.autoVitals = this.autoWeapon = this.autoAbility = this.autoRing = true;
    }

    // Expose a small imperative API for other systems / the console.
    window.__HUD = this;
  }

  applySettings() {
    setVar(this.root, 'opacity', String(this.settings.opacity));
    this.numbers.enabled = this.settings.damageNumbers;
    if (!this.settings.damageNumbers) this.numbers.clear();
    this.minimap.rotate = this.settings.rotateMinimap;
  }

  _resize() {
    this.W = window.innerWidth; this.H = window.innerHeight;
    this.numbers.resize(this.W, this.H);
  }

  /** Footprint for the minimap; falls back to seeded synthetic blocks. */
  _buildBlocks(ctx) {
    const out = [];
    const meshes = ctx.engine.get('world')?.colliderMeshes;
    if (meshes && meshes.length) {
      for (const m of meshes) {
        if (!m || !m.geometry) continue;
        _box.setFromObject(m);
        const hw = (_box.max.x - _box.min.x) / 2;
        const hd = (_box.max.z - _box.min.z) / 2;
        const h = _box.max.y - _box.min.y;
        if (hw > 90 || hd > 90 || h < 0.9) continue;   // skip ground slab
        out.push({ x: (_box.min.x + _box.max.x) / 2, z: (_box.min.z + _box.max.z) / 2, hw, hd, h });
      }
    }
    if (out.length) return out;

    // No world yet — synthesise a readable city block layout deterministically.
    const rng = makeRNG(ctx.cfg?.world?.seed ?? 0xA9EC);
    for (let i = 0; i < 110; i++) {
      const hw = 2 + rng() * 7, hd = 2 + rng() * 7;
      out.push({
        x: (rng() - 0.5) * 340, z: (rng() - 0.5) * 340,
        hw, hd, h: 3 + rng() * 20,
      });
    }
    return out;
  }

  /* ----------------------------------------------------------- events -- */

  _on(type, fn) { this._offs.push(this.ctx.bus.on(type, fn)); }

  _wire(ctx) {
    const s = this.s;

    /* ---- additive UI patch events ---- */
    this._on('ui:player', (p = {}) => {
      if (p.name != null) { s.name = p.name; this.vitals.setName(p.name); }
      if (p.level != null) { s.level = p.level; this.vitals.setLevel(p.level); }
      if (p.x != null) s.player.x = p.x;
      if (p.z != null) s.player.z = p.z;
      if (p.fx != null) s.player.fx = p.fx;
      if (p.fz != null) s.player.fz = p.fz;
      if (p.speed != null) s.speed = p.speed;
      if (p.grounded != null) s.grounded = p.grounded;
      if (p.ads != null) s.ads = p.ads;
      if (p.downed != null) s.downed = p.downed;
      this._extPlayer = true;
    });
    this._on('ui:vitals', (p = {}) => { Object.assign(s, p); });
    this._on('ui:weapon', (p = {}) => { Object.assign(s.weapon, p); });
    this._on('ui:slots', (p) => { if (Array.isArray(p)) s.slots = p; });
    this._on('ui:squad', (p) => { if (Array.isArray(p)) s.squad = p; });
    this._on('ui:contacts', (p) => { if (Array.isArray(p)) s.contacts = p; });
    this._on('ui:items', (p = {}) => { Object.assign(s.items, p); });
    this._on('ui:match', (p = {}) => { Object.assign(s.match, p); });
    this._on('ui:ability', (p = {}) => {
      if (p.tactical) Object.assign(s.abilities.tactical, p.tactical);
      if (p.ultimate) Object.assign(s.abilities.ultimate, p.ultimate);
    });

    /* ---- combat ---- */
    this._on(EV.SHOT_FIRED, (p = {}) => {
      s.bloom = clamp01(s.bloom + (p.spread ? 0.16 : 0.13));
      if (this.autoWeapon && !s.weapon.reloading) {
        s.weapon.mag = Math.max(0, s.weapon.mag - 1);
      }
    });

    this._on(EV.DAMAGE_NUMBER, (p = {}) => {
      this._sawDamageNumber = this._t;
      this._spawnNumber(p);
    });

    this._on(EV.DAMAGE_DEALT, (p = {}) => {
      const incoming = p.targetId === 'player' || p.targetId === 'self' || p.toPlayer;
      if (incoming) { this._takeDamage(p); return; }
      s.match.damage += p.amount || 0;
      // Only synthesise a number if the game is not emitting explicit ones.
      if (this._t - this._sawDamageNumber > 3) this._spawnNumber(p);
    });

    this._on(EV.HITMARKER, (p = {}) => {
      if (!this.settings.hitmarkers || this._ff) return;
      const type = p.isKill ? 'kill' : p.shieldBreak ? 'shield' : p.isHeadshot ? 'head' : 'body';
      this.crosshair.hitmarker(type);
    });

    this._on(EV.RELOAD_START, (p = {}) => {
      s.weapon.reloading = true;
      s.weapon.reloadProgress = 0;
      s.weapon.reloadDur = p.duration ?? p.time ?? 2.3;
      this._reloadT = 0;
    });
    this._on(EV.RELOAD_END, () => this._finishReload());

    this._on(EV.WEAPON_SWITCH, (p = {}) => {
      const w = p.weapon || p;
      if (w.name) s.weapon.name = w.name;
      if (w.kind || w.class) s.weapon.kind = w.kind || w.class;
      if (w.magMax || w.magSize) s.weapon.magMax = w.magMax || w.magSize;
      if (typeof w.mag === 'number') s.weapon.mag = w.mag;
      if (typeof w.reserve === 'number') s.weapon.reserve = w.reserve;
      if (w.ammoType) s.weapon.ammo = w.ammoType;
      if (w.fireMode || w.mode) s.weapon.mode = w.fireMode || w.mode;
      s.weapon.reloading = false;
      const idx = p.slot ?? p.index;
      if (idx != null) s.slots.forEach((x, i) => { x.active = i === idx; });
    });

    /* ---- kills ---- */
    this._on(EV.KILLFEED, (p = {}) => this.feed.push(p));

    this._on(EV.ENTITY_KILLED, (p = {}) => {
      const victim = p.name ?? p.victimName ?? p.victim ?? p.id ?? 'UNKNOWN';
      const killer = p.byName ?? p.killerName ?? p.killer ?? p.by ?? 'UNKNOWN';
      const self = p.by === 'player' || p.killer === 'player' || p.byPlayer === true;
      this.feed.push({
        killer: self ? s.name : killer, victim, self,
        weapon: p.weapon || s.weapon.kind, headshot: !!p.headshot,
      });
      if (self) {
        s.match.kills++;
        if (!this._ff) this.banner.show('ELIMINATED', victim, true);
      }
    });

    this._on(EV.ENTITY_DOWNED, (p = {}) => {
      const victim = p.name ?? p.victim ?? p.id ?? 'UNKNOWN';
      const self = p.by === 'player' || p.byPlayer === true;
      if (p.isPlayer || p.id === 'player') { s.downed = true; s.bleedTime = s.bleedTotal; return; }
      this.feed.push({
        killer: self ? s.name : (p.byName ?? p.by ?? 'UNKNOWN'), victim, self,
        weapon: p.weapon || s.weapon.kind, knock: true,
      });
      if (self && !this._ff) this.banner.show('KNOCKED DOWN', victim, false);
    });

    /* ---- abilities ---- */
    this._on(EV.ABILITY_USED, (p = {}) => {
      if (p.slot === 'ultimate') {
        s.abilities.ultimate.charge = 0;
        if (!this._ff) this.banner.show('ULTIMATE DEPLOYED', p.legendId || '', false);
      } else {
        const t = s.abilities.tactical;
        t.charges = Math.max(0, t.charges - 1);
        if (t.cd <= 0) t.cd = t.cdMax;
      }
    });
    this._on(EV.ABILITY_READY, (p = {}) => {
      if (p.slot === 'ultimate') s.abilities.ultimate.charge = 1;
      else {
        const t = s.abilities.tactical;
        t.charges = Math.min(t.maxCharges, t.charges + 1);
        t.cd = 0;
      }
    });

    /* ---- ring ---- */
    this._on(EV.RING_STAGE, (p = {}) => {
      const r = s.ring;
      r.stage = p.stage ?? r.stage;
      r.phase = p.phase ?? 'close';
      r.time = p.time ?? p.closeTime ?? p.waitTime ?? r.time;
      r.total = p.total ?? r.time;
      const c = p.center || p.position;
      if (c) { r.x = c.x; r.z = c.z; r.nextX = c.x; r.nextZ = c.z; }
      if (p.radius != null) r.radius = p.radius;
      if (p.nextRadius != null) r.nextRadius = p.nextRadius;
      if (!this._ff) this.banner.show(`RING ${r.stage} ${r.phase === 'close' ? 'CLOSING' : 'INCOMING'}`, '', false);
    });
    this._on(EV.RING_DAMAGE, (p = {}) => this._takeDamage({ amount: p.amount ?? 2, ring: true }));

    this._on(EV.MATCH_END, (p = {}) => this.banner.show(p.won ? 'CHAMPION SQUAD' : 'SQUAD ELIMINATED', '', true));

    this._on('engine:resize', () => this._resize());
    this._on('input:lock', (locked) => { if (locked) this.menu.setOpen(false); });
  }

  /* -------------------------------------------------------- behaviour -- */

  _spawnNumber(p) {
    const amount = p.amount ?? p.damage ?? 0;
    if (!(amount > 0)) return;
    let scr = p.screen;
    if (!scr && p.point) scr = this._project(p.point);
    if (!scr) {
      scr = { x: this.W * 0.5 + (Math.random() - 0.5) * 90, y: this.H * 0.44 + (Math.random() - 0.5) * 60 };
    }
    this.numbers.spawn(scr, amount, {
      crit: !!(p.isHeadshot ?? p.crit),
      shield: !!(p.shieldDamage ?? p.shield),
      kill: !!p.kill,
      targetId: p.targetId,
    });
  }

  _project(point) {
    const cam = this.ctx.camera;
    _v.set(point.x, point.y, point.z).project(cam);
    if (_v.z > 1) return null;
    return { x: (_v.x * 0.5 + 0.5) * this.W, y: (-_v.y * 0.5 + 0.5) * this.H };
  }

  _takeDamage(p = {}) {
    const s = this.s;
    const amount = p.amount ?? 0;
    this._sinceHurt = 0;

    let toShield = 0, toHealth = amount;
    if (!p.ring && s.shield > 0) {
      toShield = Math.min(s.shield, amount);
      toHealth = amount - toShield;
    }
    if (this.autoVitals) {
      s.shield = Math.max(0, s.shield - toShield);
      s.health = Math.max(0, s.health - toHealth);
      if (s.health <= 0 && !s.downed) { s.downed = true; s.bleedTime = s.bleedTotal; }
    }
    if (!this._ff) {
      if (toShield > 0) this.vitals.flash(true);
      if (toHealth > 0) this.vitals.flash(false);
      this.overlays.hit();
    }

    // direction arc
    let bearing = p.fromAngle;
    if (bearing == null) {
      const src = p.sourcePosition || p.from || p.point;
      if (src) {
        const pl = s.player;
        const dx = src.x - pl.x, dz = src.z - pl.z;
        const len = Math.hypot(dx, dz) || 1;
        const nx = dx / len, nz = dz / len;
        bearing = Math.atan2(-pl.fz * nx + pl.fx * nz, pl.fx * nx + pl.fz * nz);
      }
    } else {
      // world bearing supplied — convert to player-relative
      const pl = s.player;
      const face = Math.atan2(pl.fx, -pl.fz);
      bearing = bearing - face;
    }
    if (bearing != null && !this._ff) this.crosshair.damageFrom(bearing);
  }

  _finishReload() {
    const w = this.s.weapon;
    w.reloading = false;
    w.reloadProgress = 0;
    if (this.autoWeapon) {
      const need = w.magMax - w.mag;
      const take = Math.min(need, w.reserve);
      w.mag += take;
      w.reserve -= take;
      if (w.reserve <= 0) w.reserve = 260;   // demo/standalone: never dry out
    }
  }

  /* ------------------------------------------------------- per frame --- */

  _ingest(ctx) {
    const s = this.s;
    const eng = ctx.engine;

    // camera-derived facing unless something authoritative told us otherwise
    if (!this._extPlayer) {
      ctx.camera.getWorldDirection(_v);
      const l = Math.hypot(_v.x, _v.z) || 1;
      s.player.fx = _v.x / l; s.player.fz = _v.z / l;
      s.player.x = ctx.camera.position.x;
      s.player.z = ctx.camera.position.z;
    }

    const pl = eng.get('player');
    if (pl) {
      const pos = pl.position || pl.pos;
      if (pos) { s.player.x = pos.x; s.player.z = pos.z; }
      if (typeof pl.health === 'number') s.health = pl.health;
      if (typeof pl.shield === 'number') s.shield = pl.shield;
      if (typeof pl.shieldMax === 'number') s.shieldMax = pl.shieldMax;
      if (typeof pl.downed === 'boolean') s.downed = pl.downed;
      if (typeof pl.ads === 'boolean') s.ads = pl.ads;
      else if (typeof pl.isAiming === 'boolean') s.ads = pl.isAiming;
      const gnd = pl.grounded ?? pl.onGround;
      if (typeof gnd === 'boolean') s.grounded = gnd;
      if (typeof pl.speed === 'number') s.speed = pl.speed;
      else if (pl.velocity) s.speed = Math.hypot(pl.velocity.x, pl.velocity.z);
    }

    const wp = eng.get('weapons');
    if (wp) {
      const cur = (typeof wp.hudState === 'function' ? wp.hudState() : null)
        || wp.current || wp.currentWeapon || null;
      if (cur) {
        const w = s.weapon;
        if (cur.name) w.name = cur.name;
        if (cur.kind || cur.class || cur.category) w.kind = cur.kind || cur.class || cur.category;
        if (typeof cur.mag === 'number') w.mag = cur.mag;
        else if (typeof cur.ammoInMag === 'number') w.mag = cur.ammoInMag;
        if (typeof cur.magMax === 'number') w.magMax = cur.magMax;
        else if (typeof cur.magSize === 'number') w.magMax = cur.magSize;
        if (typeof cur.reserve === 'number') w.reserve = cur.reserve;
        else if (typeof cur.reserveAmmo === 'number') w.reserve = cur.reserveAmmo;
        if (typeof cur.ammoType === 'string') w.ammo = cur.ammoType;
        if (typeof cur.fireMode === 'string') w.mode = cur.fireMode;
        if (typeof cur.reloading === 'boolean') w.reloading = cur.reloading;
        if (typeof cur.reloadProgress === 'number') w.reloadProgress = cur.reloadProgress;
      }
    }
  }

  _tickAutonomous(dt) {
    const s = this.s;

    if (s.weapon.reloading && this.autoWeapon) {
      this._reloadT = (this._reloadT || 0) + dt;
      s.weapon.reloadProgress = clamp01(this._reloadT / Math.max(0.05, s.weapon.reloadDur));
      if (s.weapon.reloadProgress >= 1) this._finishReload();
    }

    if (this.autoAbility) {
      const t = s.abilities.tactical;
      if (t.cd > 0) {
        t.cd = Math.max(0, t.cd - dt);
        if (t.cd === 0) {
          t.charges = Math.min(t.maxCharges, t.charges + 1);
          if (t.charges < t.maxCharges) t.cd = t.cdMax;
        }
      }
    }

    if (this.autoRing) {
      const r = s.ring;
      r.time = Math.max(0, r.time - dt);
      if (r.time <= 0) {
        const stages = this.ctx.cfg?.ring?.stages || [];
        if (r.phase === 'wait') {
          r.phase = 'close';
          r.total = r.time = stages[r.stage - 1]?.closeTime ?? 60;
        } else {
          r.stage = Math.min(stages.length, r.stage + 1);
          r.phase = 'wait';
          r.total = r.time = stages[r.stage - 1]?.waitTime ?? 40;
          r.radius = r.nextRadius;
          r.nextRadius = (stages[r.stage]?.radius ?? r.radius * 0.5) * 0.5;
        }
      }
      // closing rings shrink smoothly toward the next radius
      if (r.phase === 'close' && r.total > 0) {
        const k = clamp01(1 - r.time / r.total);
        r.radius = r.radius + (r.nextRadius - r.radius) * Math.min(1, dt / Math.max(0.2, r.time));
        void k;
      }
    }

    if (this.autoVitals) {
      this._sinceHurt += dt;
      if (this._sinceHurt > 7 && !s.downed) {
        s.shield = Math.min(s.shieldMax, s.shield + dt * 11);
        if (s.shield >= s.shieldMax) s.health = Math.min(s.healthMax, s.health + dt * 4);
      }
      if (s.downed) {
        s.bleedTime = Math.max(0, s.bleedTime - dt);
        if (s.bleedTime <= 0) { s.downed = false; s.health = 45; s.shield = 0; this._sinceHurt = 0; }
      }
    }
  }

  update(dt, alpha, ctx) {
    if (!this.root) return;
    // The engine's first frame can hand out a negative dt (the rAF timestamp
    // predates start()), so clamp into a sane band before anything integrates.
    const d = dt > 0 ? Math.min(dt, 0.05) : 1 / 60;
    this._t += d;
    const s = this.s;

    // In demo mode the driver is authoritative — never let a real gameplay
    // system fight it for the same state.
    if (this.demo) this.demo.update(d);
    else this._ingest(ctx);
    this._tickAutonomous(d);

    s.bloom = damp(s.bloom, 0, 4.2, d);

    this.minimap.update(d, s);
    this.compass.update(d, s);
    this.ringPanel.update(d, s);
    this.stats.update(d, s);
    this.feed.update(d);
    this.squad.update(d, s);
    this.vitals.update(d, s);
    this.abilities.update(d, s);
    this.weapon.update(d, s);
    this.crosshair.update(d, s);
    this.numbers.update(d);
    this.overlays.update(d, s);
  }

  /**
   * Advance the demo/self-test by `seconds` of simulated time without waiting
   * for frames. The screenshot harness uses this because the software renderer
   * runs at a few fps, which would otherwise make "wait 8 seconds" meaningless.
   * Only state is stepped — painting still happens on the next real frames.
   */
  fastForward(seconds = 8, wantNumbers = 2) {
    const step = 1 / 60;
    this._ff = true;
    const run = (n) => {
      for (let i = 0; i < n; i++) {
        if (this.demo) this.demo.update(step);
        this._tickAutonomous(step);
        this.numbers.simulate(step);
        this.minimap.agePings(step);
        this.feed.update(step);
        this._t += step;
      }
    };
    run(Math.min(3600, Math.round(seconds / step)));
    this.demo?.seedFeed?.();
    // Stop on a frame where a firefight is actually visible.
    let guard = 0;
    while (this.numbers.items.length < wantNumbers && guard++ < 240) run(1);
    this._ff = false;
    return { t: this.demo?.t ?? 0, numbers: this.numbers.items.length };
  }

  /* --------------------------------------------------- imperative API -- */

  setVitals(p) { Object.assign(this.s, p); }
  setWeapon(p) { Object.assign(this.s.weapon, p); }
  setSquad(a) { this.s.squad = a; }
  setMatch(p) { Object.assign(this.s.match, p); }
  notify(title, value, hot) { if (!this._ff) this.banner.show(title, value, hot); }
  killfeed(e) { this.feed.push(e); }
  ping(x, z, type) { this.minimap.ping(x, z, type); }

  dispose() {
    for (const off of this._offs) off();
    this._offs.length = 0;
    window.removeEventListener('resize', this._onWinResize);
    this.menu?.dispose();
    this.host?.querySelector('#hud-style')?.remove();
    this.root?.remove();
    if (window.__HUD === this) delete window.__HUD;
  }
}
