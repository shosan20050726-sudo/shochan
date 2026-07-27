/**
 * Projectiles — ballistic integrator shared by weapons, AI and abilities.
 *
 * Rounds are pooled struct-of-arrays and swept against the BVH every physics
 * tick (segment from the previous position to the new one), so a 900 m/s rifle
 * round cannot tunnel through a wall even at 8 ms steps. Gravity and quadratic
 * drag give the drop/falloff that makes long shots read as ballistic.
 *
 * Usage from another system:
 *
 *   const phys = ctx.engine.get('player');
 *   phys.projectiles.spawn({
 *     x, y, z, dx, dy, dz, speed: 780, drag: 0.0012, gravityScale: 1,
 *     ownerId: 'player', damage: 18, weaponId: 'r301',
 *     onHit(h) { ... },
 *   });
 *
 * Entity hits are delegated: call `setEntityQuery(fn)` once and the integrator
 * will ask it for the closest character hit along every swept segment.
 */
import * as THREE from 'three';
import CFG from '../core/Config.js';
import { EV } from '../core/EventBus.js';

const MAX_PROJECTILES = 512;

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();

export class ProjectileWorld {
  constructor(collision, bus) {
    this.collision = collision;
    this.bus = bus;
    this.capacity = MAX_PROJECTILES;

    const c = this.capacity;
    this.active = new Uint8Array(c);
    this.pos = new Float32Array(c * 3);
    this.prev = new Float32Array(c * 3);
    this.vel = new Float32Array(c * 3);
    this.life = new Float32Array(c);
    this.maxLife = new Float32Array(c);
    this.radius = new Float32Array(c);
    this.drag = new Float32Array(c);
    this.gravityScale = new Float32Array(c);
    this.bounces = new Int8Array(c);
    this.restitution = new Float32Array(c);
    this.damage = new Float32Array(c);
    this.meta = new Array(c).fill(null);
    this.distance = new Float32Array(c);

    this._free = new Int32Array(c);
    for (let i = 0; i < c; i++) this._free[i] = c - 1 - i;
    this._freeCount = c;
    this.count = 0;
    this._entityQuery = null;

    // Shared hit record handed to callbacks (do not retain it).
    this.hit = {
      point: new THREE.Vector3(), normal: new THREE.Vector3(),
      surface: 'concrete', distance: 0, targetId: null,
      isHeadshot: false, object: null, id: -1, meta: null,
    };
  }

  /**
   * @param {(x0,y0,z0,x1,y1,z1,ownerId)=>null|{t:number,targetId:string,nx:number,ny:number,nz:number,isHeadshot:boolean}} fn
   */
  setEntityQuery(fn) { this._entityQuery = fn; }

  spawn(o) {
    if (this._freeCount <= 0) return -1;
    const i = this._free[--this._freeCount];
    const p = i * 3;
    let dx = o.dx ?? 0, dy = o.dy ?? 0, dz = o.dz ?? -1;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    const speed = o.speed ?? 300;

    this.pos[p] = this.prev[p] = o.x ?? 0;
    this.pos[p + 1] = this.prev[p + 1] = o.y ?? 0;
    this.pos[p + 2] = this.prev[p + 2] = o.z ?? 0;
    this.vel[p] = dx * speed; this.vel[p + 1] = dy * speed; this.vel[p + 2] = dz * speed;
    this.life[i] = 0;
    this.maxLife[i] = o.life ?? 4;
    this.radius[i] = o.radius ?? 0.015;
    this.drag[i] = o.drag ?? 0;
    this.gravityScale[i] = o.gravityScale ?? 1;
    this.bounces[i] = o.bounces ?? 0;
    this.restitution[i] = o.restitution ?? 0.32;
    this.damage[i] = o.damage ?? 0;
    this.distance[i] = 0;
    this.meta[i] = o;
    this.active[i] = 1;
    this.count++;
    return i;
  }

  kill(i) {
    if (!this.active[i]) return;
    this.active[i] = 0;
    this.meta[i] = null;
    this._free[this._freeCount++] = i;
    this.count--;
  }

  clear() {
    for (let i = 0; i < this.capacity; i++) if (this.active[i]) this.kill(i);
  }

  /** Position of projectile `i` (for tracer rendering). */
  getPosition(i, out) {
    const p = i * 3;
    return out.set(this.pos[p], this.pos[p + 1], this.pos[p + 2]);
  }

  getPrevious(i, out) {
    const p = i * 3;
    return out.set(this.prev[p], this.prev[p + 1], this.prev[p + 2]);
  }

  fixedUpdate(dt) {
    if (this.count === 0) return;
    const g = CFG.move.gravity;
    const coll = this.collision;

    for (let i = 0; i < this.capacity; i++) {
      if (!this.active[i]) continue;
      const p = i * 3;
      this.life[i] += dt;

      let vx = this.vel[p], vy = this.vel[p + 1], vz = this.vel[p + 2];
      // Quadratic drag: a = -k|v|v. Keeps supersonic rounds honest downrange.
      const k = this.drag[i];
      if (k > 0) {
        const sp = Math.hypot(vx, vy, vz);
        const f = k * sp * dt;
        if (f < 1) { vx -= vx * f; vy -= vy * f; vz -= vz * f; }
      }
      vy -= g * this.gravityScale[i] * dt;

      const x0 = this.pos[p], y0 = this.pos[p + 1], z0 = this.pos[p + 2];
      let dx = vx * dt, dy = vy * dt, dz = vz * dt;
      let len = Math.hypot(dx, dy, dz);
      this.prev[p] = x0; this.prev[p + 1] = y0; this.prev[p + 2] = z0;

      let consumed = false;
      if (len > 1e-9) {
        const inv = 1 / len;
        const ux = dx * inv, uy = dy * inv, uz = dz * inv;

        // --- character hit first (usually much closer than the wall behind)
        let entHit = null;
        if (this._entityQuery) {
          entHit = this._entityQuery(x0, y0, z0, x0 + dx, y0 + dy, z0 + dz, this.meta[i]?.ownerId ?? null);
        }
        const wallHit = coll?.ready
          ? coll.raycastRef(x0, y0, z0, ux, uy, uz, len + this.radius[i])
          : null;

        const entT = entHit ? entHit.t * len : Infinity;
        const wallT = wallHit ? wallHit.distance : Infinity;

        if (entT <= wallT && entHit) {
          this.hit.point.set(x0 + ux * entT, y0 + uy * entT, z0 + uz * entT);
          this.hit.normal.set(entHit.nx ?? -ux, entHit.ny ?? -uy, entHit.nz ?? -uz);
          this.hit.surface = 'flesh';
          this.hit.distance = this.distance[i] + entT;
          this.hit.targetId = entHit.targetId ?? null;
          this.hit.isHeadshot = !!entHit.isHeadshot;
          this.hit.object = null;
          this.hit.id = i;
          this.hit.meta = this.meta[i];
          this._report(i, true);
          consumed = true;
        } else if (wallHit) {
          const t = Math.max(0, wallHit.distance - this.radius[i] * 0.5);
          this.hit.point.set(x0 + ux * t, y0 + uy * t, z0 + uz * t);
          this.hit.normal.set(wallHit.nx, wallHit.ny, wallHit.nz);
          this.hit.surface = wallHit.surface;
          this.hit.distance = this.distance[i] + t;
          this.hit.targetId = null;
          this.hit.isHeadshot = false;
          this.hit.object = wallHit.object;
          this.hit.id = i;
          this.hit.meta = this.meta[i];

          if (this.bounces[i] > 0) {
            this.bounces[i]--;
            const nx = wallHit.nx, ny = wallHit.ny, nz = wallHit.nz;
            const d = vx * nx + vy * ny + vz * nz;
            const e = this.restitution[i];
            vx = (vx - 2 * d * nx) * e;
            vy = (vy - 2 * d * ny) * e;
            vz = (vz - 2 * d * nz) * e;
            // Tangential friction so grenades settle instead of skating.
            const dn = vx * nx + vy * ny + vz * nz;
            const tx = vx - dn * nx, ty = vy - dn * ny, tz = vz - dn * nz;
            const fr = 0.82;
            vx = dn * nx + tx * fr; vy = dn * ny + ty * fr; vz = dn * nz + tz * fr;
            this.pos[p] = this.hit.point.x + nx * (this.radius[i] + 0.005);
            this.pos[p + 1] = this.hit.point.y + ny * (this.radius[i] + 0.005);
            this.pos[p + 2] = this.hit.point.z + nz * (this.radius[i] + 0.005);
            this.vel[p] = vx; this.vel[p + 1] = vy; this.vel[p + 2] = vz;
            this.distance[i] += t;
            this._report(i, false);
            continue;
          }
          this._report(i, true);
          consumed = true;
        }
      }

      if (consumed) continue;

      this.pos[p] = x0 + dx; this.pos[p + 1] = y0 + dy; this.pos[p + 2] = z0 + dz;
      this.vel[p] = vx; this.vel[p + 1] = vy; this.vel[p + 2] = vz;
      this.distance[i] += len;

      if (this.life[i] >= this.maxLife[i]) {
        const m = this.meta[i];
        _p.set(this.pos[p], this.pos[p + 1], this.pos[p + 2]);
        m?.onExpire?.(_p, i);
        this.kill(i);
      }
    }
  }

  _report(i, terminal) {
    const m = this.meta[i];
    try { m?.onHit?.(this.hit, i); } catch (e) { console.error('[Projectiles] onHit threw', e); }
    if (this.bus && (m?.emitImpact ?? true)) {
      this.bus.emit(EV.IMPACT, {
        point: this.hit.point.clone(),
        normal: this.hit.normal.clone(),
        surface: this.hit.surface,
        scale: m?.impactScale ?? 1,
      });
    }
    if (terminal) {
      if (m?.onExpire) { _p.copy(this.hit.point); m.onExpire(_p, i); }
      this.kill(i);
    }
  }
}

export default ProjectileWorld;
