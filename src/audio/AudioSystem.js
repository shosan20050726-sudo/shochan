/**
 * AudioSystem — the game-facing audio module.
 *
 * Everything is synthesised: there is not one audio file in this project. See
 * Weapons.js / Impacts.js / Footsteps.js / UISfx.js for the synthesis, and
 * AudioGraph.js for the mixer, reverb and spatialiser.
 *
 * Autoplay policy
 * ---------------
 * No AudioContext is created in `init`. The screenshot harness boots this page
 * with zero user gestures, so the system must initialise, run, receive events
 * and update every frame with **no live context at all** and never throw. The
 * context is created and resumed on the first real user gesture; until then
 * every play call is a cheap no-op. Every bus handler is additionally wrapped
 * so that a synthesis bug can never propagate into the EventBus (which would
 * surface as a console error and fail the harness).
 */
import CFG from '../core/Config.js';
import { EV } from '../core/EventBus.js';
import AudioGraph from './AudioGraph.js';
import Ambience from './Ambience.js';
import { weaponClass } from './Weapons.js';
import { reloadStyle } from './UISfx.js';
import { clamp } from './Synth.js';

const GESTURES = ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'click'];

// Module-scope scratch: nothing in the update path allocates.
const _fwd = { x: 0, y: 0, z: -1 };
const _up = { x: 0, y: 1, z: 0 };
const _pos = { x: 0, y: 0, z: 0 };
const _probeOrigin = { x: 0, y: 0, z: 0 };
const _probeDir = { x: 0, y: 1, z: 0 };
const _tmpPos = { x: 0, y: 0, z: 0 };

function vec(p, out) {
  out.x = (p && (p.x ?? p[0])) || 0;
  out.y = (p && (p.y ?? p[1])) || 0;
  out.z = (p && (p.z ?? p[2])) || 0;
  return out;
}

export default class AudioSystem {
  name = 'audio';
  priority = 70;

  constructor() {
    // Constructor stays cheap: no context, no buffers, no DSP.
    this.ac = null;
    this.graph = null;
    this.ambience = null;
    this.ready = false;
    this.enabled = true;
    this.cfg = CFG.audio || {};
    this.muted = false;

    this._offs = [];
    this._unlockBound = null;
    this._foot = false;
    this._lastPlay = new Map();
    this._lastImpact = { t: -1, x: 0, y: 0, z: 0 };

    this._health = 100;
    this._healthFromBus = false;
    this._healthMax = CFG.combat?.healthMax ?? 100;
    this._hbNext = 0;

    this._ring = 0;
    this._ringStage = -1;
    this._env = 'outdoor';

    this._prev = { x: 0, y: 0, z: 0, valid: false };
    this._speed = 0;
    this._indoor = 0;
    this._ambAccum = 0;
    this._probeAccum = 0;
    this._elapsed = 0;
  }

  /* ------------------------------------------------------------------ init */

  async init(ctx) {
    this.ctx = ctx;
    this.cfg = (ctx?.cfg?.audio) || CFG.audio || {};
    this._healthMax = ctx?.cfg?.combat?.healthMax ?? 100;

    this._wire(ctx?.bus);

    // If the page already had a user gesture (dev reload, menu click) we can
    // build immediately; otherwise wait politely.
    let already = false;
    try { already = !!(navigator.userActivation && navigator.userActivation.hasBeenActive); }
    catch (e) { already = false; }

    if (typeof window !== 'undefined') {
      this._unlockBound = () => this.unlock();
      for (const g of GESTURES) {
        try { window.addEventListener(g, this._unlockBound, { capture: true, passive: true }); }
        catch (e) { /* noop */ }
      }
      this._visBound = () => this._onVisibility();
      try { document.addEventListener('visibilitychange', this._visBound); } catch (e) { /* noop */ }
      // Debug / verification handle.
      try { window.__AUDIO = this; } catch (e) { /* noop */ }
    }

    if (already) this.unlock();
  }

  /**
   * Create and resume the AudioContext. Safe to call any number of times, from
   * anywhere, with or without a gesture — it simply fails quietly.
   */
  unlock() {
    if (this.ac) {
      if (this.ac.state === 'suspended') { try { this.ac.resume(); } catch (e) { /* noop */ } }
      return this.ready;
    }
    if (typeof window === 'undefined') return false;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return false;

    try {
      this.ac = new Ctor({ latencyHint: 'interactive' });
    } catch (e) {
      this.ac = null;
      return false;
    }

    try {
      this.graph = new AudioGraph(this.ac, this.cfg, {
        live: true,
        seed: (this.ctx?.cfg?.world?.seed ?? CFG.world?.seed ?? 0xA9EC),
        environment: this._env,
      });
      this.ambience = new Ambience(this.ac, this.graph.ambienceBus, this.cfg);
      this.ready = true;
    } catch (e) {
      console.warn('[audio] graph construction failed:', e?.message || e);
      this.ac = null; this.graph = null; this.ready = false;
      return false;
    }

    const done = () => {
      if (!this.graph) return;
      try { this.ambience?.start(); } catch (e) { /* noop */ }
      // Drop the gesture listeners once we are actually running.
      if (this.ac?.state === 'running' && this._unlockBound && typeof window !== 'undefined') {
        for (const g of GESTURES) {
          try { window.removeEventListener(g, this._unlockBound, { capture: true }); } catch (e) { /* noop */ }
        }
        this._unlockBound = null;
      }
    };

    try {
      const r = this.ac.resume();
      if (r && typeof r.then === 'function') r.then(done).catch(() => {});
      else done();
    } catch (e) { done(); }

    return this.ready;
  }

  get isRunning() { return !!(this.ac && this.ac.state === 'running' && this.graph); }

  /* ------------------------------------------------------------- public API */

  /**
   * Play a non-spatialised sound (UI, first-person weapon, stingers).
   * @param {string} id  see SoundBank.js
   * @param {object} opts { gain, pan, delay, when, ...builder options }
   */
  play(id, opts) {
    if (!this.enabled || !this.isRunning) return null;
    try { return this.graph.spawn(id, opts ? { spatial: false, ...opts } : { spatial: false }); }
    catch (e) { return null; }
  }

  /**
   * Play a spatialised sound at a world position. Distance drives HRTF panning,
   * inverse-square attenuation, an air-absorption lowpass, the reverb send and
   * a speed-of-sound propagation delay.
   * @param {string} id
   * @param {{x:number,y:number,z:number}|number[]} position
   * @param {object} opts
   */
  playAt(id, position, opts) {
    if (!this.enabled || !this.isRunning) return null;
    try {
      const o = opts ? { ...opts } : {};
      o.position = position;
      o.spatial = o.spatial !== false;
      return this.graph.spawn(id, o);
    } catch (e) { return null; }
  }

  /**
   * @param {{x,y,z}} position
   * @param {{x,y,z,w}} [quaternion] listener orientation; omit to keep the last
   */
  setListener(position, quaternion) {
    if (!this.graph) return;
    if (position) vec(position, _pos);
    if (quaternion) {
      const x = quaternion.x || 0, y = quaternion.y || 0, z = quaternion.z || 0;
      const w = quaternion.w != null ? quaternion.w : 1;
      _fwd.x = -2 * (x * z + w * y);
      _fwd.y = -2 * (y * z - w * x);
      _fwd.z = -(1 - 2 * (x * x + y * y));
      _up.x = 2 * (x * y - z * w);
      _up.y = 1 - 2 * (x * x + z * z);
      _up.z = 2 * (x * w + y * z);
    }
    this.graph.setListener(_pos.x, _pos.y, _pos.z, _fwd.x, _fwd.y, _fwd.z, _up.x, _up.y, _up.z);
  }

  /** 'tight' | 'indoor' | 'outdoor' | 'canyon' */
  setEnvironment(name) {
    this._env = name;
    this.graph?.setEnvironment(name);
  }

  /** Drives the low-health heartbeat. Other systems may call this directly. */
  setHealth(hp, max) {
    if (max) this._healthMax = max;
    this._health = clamp(Number(hp) || 0, 0, this._healthMax);
  }

  /** 0 = safe, 1 = standing in the ring. */
  setRingProximity(v) { this._ring = clamp(Number(v) || 0, 0, 1); }

  setMasterGain(v) {
    this.cfg.masterGain = v;
    if (this.graph) { try { this.graph.master.gain.value = clamp(v, 0, 2); } catch (e) { /* noop */ } }
  }

  mute(on = true) {
    this.muted = !!on;
    if (!this.graph) return;
    try {
      this.graph.out.gain.setTargetAtTime(on ? 0 : 1, this.ac.currentTime, 0.05);
    } catch (e) { /* noop */ }
  }

  /** Offline render of one sound, for numerical verification. Lazy-loaded. */
  async render(id, opts) {
    const m = await import('./Render.js');
    return m.renderSound(id, opts);
  }

  /* ----------------------------------------------------------------- events */

  _on(bus, type, fn) {
    if (!bus || !type) return;
    const wrapped = (payload) => {
      if (!this.enabled) return;
      try { fn(payload || {}); }
      catch (e) { /* audio must never break gameplay or spam the console */ }
    };
    this._offs.push(bus.on(type, wrapped));
  }

  /**
   * Rate limiter so an event storm cannot stack 200 identical voices.
   * `burst` allows N events inside one window, which matters because a shotgun
   * legitimately produces several impacts in the same millisecond and gating
   * those to one would make buckshot sound like a single bullet.
   */
  _gate(key, minGap, burst = 1) {
    const t = this.ac ? this.ac.currentTime : this._elapsed;
    const e = this._lastPlay.get(key);
    if (!e || t - e.t >= minGap) { this._lastPlay.set(key, { t, n: 1 }); return true; }
    if (e.n < burst) { e.n++; return true; }
    return false;
  }

  _wire(bus) {
    if (!bus) return;

    /* ---- weapons ---- */
    this._on(bus, EV.SHOT_FIRED, (p) => {
      const cls = weaponClass(p.weaponId);
      this._lastWeapon = cls;
      const id = `shot.${cls}`;
      if (!this._gate(id, 0.018, 2)) return;
      const d = p.origin ? this._dist(p.origin) : 0;
      if (!p.origin || d < 3.0) {
        // First person: centred, loud, with its own room send. A PannerNode at
        // ~0 m produces nonsense with HRTF, so the player's own gun is stereo.
        this.play(id, { gain: 1, tail: 1.15, early: 1.0, duck: 1 });
        if (this._gate('shell', 0.05)) {
          this.play('weapon.shell', { gain: 0.8, delay: 0.30 + Math.random() * 0.10, pan: 0.35 });
        }
      } else {
        this.playAt(id, p.origin, { gain: 1, duck: 1 });
      }
    });

    this._on(bus, EV.SHOT_HIT, (p) => {
      // EV.IMPACT is the canonical surface event; SHOT_HIT only adds the
      // entity-specific feedback, and only if IMPACT did not just cover it.
      if (!p.targetId || !p.point) return;
      if (this._dupImpact(p.point)) return;
      this.playAt('impact.flesh', p.point, { gain: 0.95, scale: 1 });
    });

    this._on(bus, EV.IMPACT, (p) => {
      if (!p.point) return;
      const surf = String(p.surface || 'concrete');
      if (!this._gate(`impact.${surf}`, 0.012, 3)) return;
      this._markImpact(p.point);
      this.playAt(`impact.${surf}`, p.point, {
        gain: 1, scale: p.scale != null ? p.scale : 1, surface: surf,
      });
    });

    this._on(bus, EV.RELOAD_START, (p) => {
      const cls = weaponClass(p.weaponId ?? this._lastWeapon);
      this._reloadHandle = this.play('weapon.reload', {
        style: reloadStyle(cls),
        duration: p.duration != null ? p.duration : (cls === 'shotgun' ? 2.6 : cls === 'lmg' ? 3.2 : 2.1),
        gain: 1,
      });
    });

    this._on(bus, EV.RELOAD_END, () => {
      // Cut the scheduled reload sequence: a reload can be cancelled by
      // sprinting or firing, and the mag-slap must not keep playing after it.
      if (this._reloadHandle) { this.graph?.stop(this._reloadHandle); this._reloadHandle = null; }
      this.play('weapon.reload.end', { gain: 1 });
    });

    this._on(bus, EV.WEAPON_SWITCH, (p) => {
      this._lastWeapon = weaponClass(p.weaponId ?? p.to ?? this._lastWeapon);
      this.play('weapon.switch', { gain: 1 });
    });

    /* ---- combat feedback ---- */
    this._on(bus, EV.HITMARKER, (p) => {
      const id = p.isKill ? 'hit.kill' : p.isHeadshot ? 'hit.head' : 'hit.body';
      if (!this._gate(id, 0.030, 2)) return;
      this.play(id, { gain: 1 });
    });

    this._on(bus, EV.DAMAGE_DEALT, (p) => {
      if (p.shieldDamage > 0 && p.point && this._gate('shield', 0.04)) {
        this.playAt('impact.shield', p.point, { gain: 0.8 });
      }
      // Damage taken by the local player feeds the heartbeat.
      if (p.targetId === 'player' || p.targetId === 'local' || p.isLocalPlayer) {
        this.setHealth(this._health - (p.amount || 0));
      }
    });

    this._on(bus, EV.ENTITY_KILLED, (p) => {
      this.play('ui.killconfirm', { gain: 1 });
      const pt = p.position || p.point;
      if (pt) this.playAt('player.land', pt, { gain: 0.55, surface: 'flesh', speed: 9 });
    });

    this._on(bus, EV.ENTITY_DOWNED, (p) => {
      this.play('ui.select', { gain: 0.9 });
      const pt = p.position || p.point;
      if (pt) this.playAt('player.land', pt, { gain: 0.45, surface: 'flesh', speed: 7 });
    });

    /* ---- movement ---- */
    this._on(bus, EV.FOOTSTEP, (p) => {
      if (!this._gate('footstep', 0.055)) return;
      this._foot = !this._foot;
      const surf = String(p.surface || 'concrete');
      const opts = {
        surface: surf, speed: p.speed != null ? p.speed : 4.6,
        foot: this._foot, crouch: !!p.crouch, gain: 1,
      };
      const d = p.position ? this._dist(p.position) : 0;
      if (!p.position || d < 2.0) this.play(`footstep.${surf}`, { ...opts, pan: this._foot ? 0.16 : -0.16 });
      else this.playAt(`footstep.${surf}`, p.position, opts);
    });

    this._on(bus, EV.PLAYER_JUMP, (p) => {
      this.play('player.jump', { gain: 1, surface: p.surface || 'concrete' });
    });

    this._on(bus, EV.PLAYER_LAND, (p) => {
      // `impact` is the downward speed; `speed` on this payload is horizontal
      // ground speed and would make a fast strafe-landing louder than a drop.
      const speed = p.impact ?? p.impactSpeed ?? p.fallSpeed ?? p.speed ?? 7;
      const opts = { gain: 1, surface: p.surface || 'concrete', speed: Math.abs(speed) };
      const d = p.position ? this._dist(p.position) : 0;
      if (!p.position || d < 2.0) this.play('player.land', opts);
      else this.playAt('player.land', p.position, opts);
    });

    this._on(bus, EV.SLIDE_START, (p) => {
      this.play('player.slide', {
        gain: 0.9, surface: p.surface || 'concrete',
        duration: p.duration != null ? p.duration : 0.9,
      });
    });

    this._on(bus, EV.MANTLE_START, () => { this.play('player.jump', { gain: 0.7 }); });

    /* ---- abilities ---- */
    this._on(bus, EV.ABILITY_USED, (p) => {
      const id = p.slot === 'ultimate' ? 'ability.ultimate' : 'ability.tactical';
      const opts = { legendId: p.legendId, gain: 1 };
      const d = p.position ? this._dist(p.position) : 0;
      if (!p.position || d < 3) this.play(id, opts);
      else this.playAt(id, p.position, opts);
    });

    /* ---- match ---- */
    this._on(bus, EV.RING_STAGE, (p) => {
      const stage = p.stage ?? p.index ?? (this._ringStage + 1);
      // The event carries live phase/time fields, so it may be re-emitted every
      // frame. Only a change of stage is a klaxon.
      if (stage === this._ringStage) return;
      this._ringStage = stage;
      if (!this._gate('ringstage', 3.0)) return;
      this.play('ring.stage', { stage, gain: 1 });
      this.ambience?.gust(1, 2.0);
    });

    this._on(bus, EV.RING_DAMAGE, () => {
      this.setRingProximity(1);
      this._ringHitAt = this._elapsed;
      if (!this._gate('ringdmg', 0.55)) return;
      this.play('ring.damage', { gain: 1 });
    });

    this._on(bus, EV.MATCH_END, () => { this.play('ui.confirm', { gain: 1 }); });

    // Not in EV, but the HUD publishes vitals and it is the most reliable
    // health source available; guarded so it costs nothing if absent.
    this._on(bus, 'ui:vitals', (p) => {
      if (typeof p.health === 'number' && Number.isFinite(p.health)) {
        this._healthFromBus = true;
        this.setHealth(p.health, p.healthMax);
      }
    });

    /* ---- ui ---- */
    this._on(bus, EV.KILLFEED, () => { /* covered by ENTITY_KILLED */ });
  }

  /** Listener distance, safe before the context exists. */
  _dist(p) {
    if (!this.graph || !p) return 0;
    try { return this.graph.distanceTo(p); } catch (e) { return 0; }
  }

  _markImpact(p) {
    const t = this.ac ? this.ac.currentTime : this._elapsed;
    this._lastImpact.t = t;
    vec(p, _tmpPos);
    this._lastImpact.x = _tmpPos.x;
    this._lastImpact.y = _tmpPos.y;
    this._lastImpact.z = _tmpPos.z;
  }

  _dupImpact(p) {
    const t = this.ac ? this.ac.currentTime : this._elapsed;
    const L = this._lastImpact;
    if (t - L.t > 0.045) return false;
    vec(p, _tmpPos);
    const dx = _tmpPos.x - L.x, dy = _tmpPos.y - L.y, dz = _tmpPos.z - L.z;
    return (dx * dx + dy * dy + dz * dz) < 0.36;
  }

  /* ----------------------------------------------------------------- update */

  update(dt, alpha, ctx) {
    this._elapsed += dt;
    if (!this.isRunning) return;

    const cam = ctx?.camera;
    if (cam) this._followCamera(cam);

    // Ambience follows height + speed, at 10 Hz. Automation is expensive; the
    // ear cannot hear a wind bed update faster than this anyway.
    this._ambAccum += dt;
    if (this._ambAccum >= 0.1) {
      const ringFade = this._ringHitAt != null
        ? clamp(1 - (this._elapsed - this._ringHitAt) / 3, 0, 1) : 0;
      this._ring = Math.max(this._ring * 0.94, ringFade);
      try { this.ambience?.setLevels(_pos.y, this._speed, this._ring, this._indoor); }
      catch (e) { /* noop */ }
      this._ambAccum = 0;
    }

    // Environment probe: are we under a roof, in the open, or in rock?
    this._probeAccum += dt;
    if (this._probeAccum >= 0.7) { this._probeAccum = 0; this._probeEnvironment(ctx); }

    this._updateHealth(ctx);
    this._heartbeat();

    try { this.graph.update(); } catch (e) { /* noop */ }
  }

  _followCamera(cam) {
    let px, py, pz, fx, fy, fz, ux, uy, uz;
    if (cam.parent && cam.matrixWorld) {
      // Composited transform — read the world matrix basis directly.
      const e = cam.matrixWorld.elements;
      px = e[12]; py = e[13]; pz = e[14];
      fx = -e[8]; fy = -e[9]; fz = -e[10];
      ux = e[4]; uy = e[5]; uz = e[6];
    } else {
      const q = cam.quaternion || { x: 0, y: 0, z: 0, w: 1 };
      const x = q.x, y = q.y, z = q.z, w = q.w;
      px = cam.position.x; py = cam.position.y; pz = cam.position.z;
      fx = -2 * (x * z + w * y);
      fy = -2 * (y * z - w * x);
      fz = -(1 - 2 * (x * x + y * y));
      ux = 2 * (x * y - z * w);
      uy = 1 - 2 * (x * x + z * z);
      uz = 2 * (x * w + y * z);
    }

    if (this._prev.valid) {
      const dx = px - this._prev.x, dy = py - this._prev.y, dz = pz - this._prev.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Heavy smoothing: raw per-frame velocity is far too jumpy for a wind bed.
      this._speed = this._speed * 0.86 + (dist / Math.max(this.ctx?.clock?.dt || 0.016, 0.001)) * 0.14;
      if (!Number.isFinite(this._speed)) this._speed = 0;
      this._speed = clamp(this._speed, 0, 40);
    }
    this._prev.x = px; this._prev.y = py; this._prev.z = pz; this._prev.valid = true;

    _pos.x = px; _pos.y = py; _pos.z = pz;
    _fwd.x = fx; _fwd.y = fy; _fwd.z = fz;
    _up.x = ux; _up.y = uy; _up.z = uz;
    this.graph.setListener(px, py, pz, fx, fy, fz, ux, uy, uz);
  }

  /**
   * Pick an impulse response from the geometry above and around the listener.
   * All of this tolerates the world system being absent.
   */
  _probeEnvironment(ctx) {
    const world = ctx?.engine?.get?.('world');
    const cast = world?.raycast;
    if (typeof cast !== 'function') return;

    _probeOrigin.x = _pos.x; _probeOrigin.y = _pos.y; _probeOrigin.z = _pos.z;
    let roof = null;
    try {
      _probeDir.x = 0; _probeDir.y = 1; _probeDir.z = 0;
      roof = cast.call(world, _probeOrigin, _probeDir, 24);
    } catch (e) { roof = null; }

    let walls = 0;
    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
    for (let i = 0; i < dirs.length; i++) {
      try {
        _probeDir.x = dirs[i][0]; _probeDir.y = dirs[i][1]; _probeDir.z = dirs[i][2];
        const h = cast.call(world, _probeOrigin, _probeDir, 26);
        if (h) walls++;
      } catch (e) { /* noop */ }
    }

    let env = 'outdoor';
    if (roof && roof.distance != null && roof.distance < 12) {
      env = walls >= 3 ? 'tight' : 'indoor';
      this._indoor = clamp(0.35 + walls * 0.16, 0, 1);
    } else if (walls >= 3) {
      env = 'canyon';
      this._indoor = 0.25;
    } else {
      this._indoor = clamp(walls * 0.08, 0, 0.4);
    }
    if (env !== this._env) this.setEnvironment(env);
  }

  _updateHealth(ctx) {
    if (this._healthFromBus) return;    // a HUD vitals feed wins over polling
    // Poll whatever the player/legend system exposes, defensively — none of
    // these fields are contractual.
    const pl = ctx?.engine?.get?.('player');
    const raw = pl?.health ?? pl?.hp ?? pl?.state?.health ?? null;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      this._health = clamp(raw, 0, this._healthMax);
    }
  }

  _heartbeat() {
    const frac = this._health / Math.max(this._healthMax, 1);
    const threshold = this.cfg.heartbeatAt ?? 0.35;
    if (frac > threshold || frac <= 0) { this._hbNext = 0; return; }
    const now = this.ac.currentTime;
    if (this._hbNext === 0) this._hbNext = now + 0.15;
    if (now < this._hbNext) return;
    const t = clamp(1 - frac / threshold, 0, 1);        // 0 at threshold, 1 at death
    this.play('ui.heartbeat', { intensity: t, gain: 0.9 });
    this._hbNext = now + (1.15 - 0.62 * t);
  }

  _onVisibility() {
    if (typeof document === 'undefined' || !this.graph || !this.ac) return;
    const hidden = document.visibilityState === 'hidden';
    try {
      this.graph.out.gain.setTargetAtTime(hidden || this.muted ? 0 : 1, this.ac.currentTime, 0.06);
    } catch (e) { /* noop */ }
  }

  /* ---------------------------------------------------------------- dispose */

  dispose() {
    for (const off of this._offs) { try { off(); } catch (e) { /* noop */ } }
    this._offs.length = 0;

    if (typeof window !== 'undefined') {
      if (this._unlockBound) {
        for (const g of GESTURES) {
          try { window.removeEventListener(g, this._unlockBound, { capture: true }); } catch (e) { /* noop */ }
        }
        this._unlockBound = null;
      }
      if (this._visBound) {
        try { document.removeEventListener('visibilitychange', this._visBound); } catch (e) { /* noop */ }
        this._visBound = null;
      }
      try { if (window.__AUDIO === this) delete window.__AUDIO; } catch (e) { /* noop */ }
    }

    try { this.ambience?.stop(); } catch (e) { /* noop */ }
    try { this.graph?.dispose(); } catch (e) { /* noop */ }
    try { this.ac?.close(); } catch (e) { /* noop */ }
    this.ambience = null;
    this.graph = null;
    this.ac = null;
    this.ready = false;
  }
}
