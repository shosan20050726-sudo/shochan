import { el, sizeCanvas, clamp01, COL } from '../theme.js';

const FONT = '"Rajdhani","DIN Alternate","Bahnschrift",system-ui,sans-serif';
const MAX = 48;
const MERGE_WINDOW = 0.55;  // seconds — extra hits on the same target stack

/**
 * Floating damage numbers on a full-screen 2D canvas. Hits on the same target
 * inside MERGE_WINDOW accumulate into the existing number (and re-pop it),
 * which is what stops sustained fire from spamming the screen.
 */
export default class DamageNumbers {
  constructor(root) {
    this.canvas = el('canvas', 'hud-dmgcanvas', root);
    this.ctx = this.canvas.getContext('2d');
    this.items = [];
    this.w = 0; this.h = 0; this.dpr = 1;
    this.enabled = true;
    this._dirty = true;
  }

  resize(w, h) {
    this.w = w; this.h = h;
    this.dpr = sizeCanvas(this.canvas, w, h);
    this._dirty = true;
  }

  clear() { this.items.length = 0; this._dirty = true; }

  /**
   * @param {{x:number,y:number}} scr screen-space anchor
   * @param {number} amount
   * @param {{crit?:boolean, shield?:boolean, kill?:boolean, targetId?:string}} o
   */
  spawn(scr, amount, o = {}) {
    if (!this.enabled || !(amount > 0)) return;
    const id = o.targetId;
    if (id) {
      for (let i = this.items.length - 1; i >= 0; i--) {
        const it = this.items[i];
        if (it.id === id && it.age - it.lastAdd < MERGE_WINDOW && !it.kill && it.hits < 6) {
          it.amount += amount;
          it.hits++;
          it.lastAdd = it.age;
          it.pop = 1;
          it.crit = it.crit || !!o.crit;
          it.shield = it.shield && !!o.shield;
          it.kill = it.kill || !!o.kill;
          it.ttl = Math.max(it.ttl, it.age + 0.95);
          return;
        }
      }
    }
    if (this.items.length >= MAX) this.items.shift();
    const spread = o.crit ? 10 : 22;
    this.items.push({
      x: scr.x + (Math.random() - 0.5) * spread,
      y: scr.y + (Math.random() - 0.5) * spread * 0.6,
      vx: (Math.random() - 0.5) * 46 + (o.crit ? 0 : 8),
      vy: -(104 + Math.random() * 30) * (o.crit ? 1.2 : 1),
      amount, crit: !!o.crit, shield: !!o.shield, kill: !!o.kill,
      id, age: 0, lastAdd: 0, hits: 1, ttl: 1.4 + Math.random() * 0.25, pop: 1,
    });
    this._dirty = true;
  }

  /** Integrate only — used by the demo fast-forward, which must not paint. */
  simulate(dt) {
    const list = this.items;
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i];
      it.age += dt;
      it.vy += 96 * dt;              // gentle gravity: rises, then settles
      it.vx *= (1 - 2.4 * dt);
      it.x += it.vx * dt;
      it.y += it.vy * dt;
      it.pop *= Math.exp(-dt * 11);
      if (it.age >= it.ttl) list.splice(i, 1);
    }
  }

  update(dt) {
    const list = this.items;
    if (!list.length) {
      if (this._dirty) { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); this._dirty = false; }
      return;
    }
    this._dirty = true;
    this.simulate(dt);
    if (!list.length) { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); return; }

    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineJoin = 'round';
    c.miterLimit = 2;

    for (const it of list) {
      const t = it.age / it.ttl;
      const a = t < 0.06 ? t / 0.06 : t > 0.62 ? 1 - (t - 0.62) / 0.38 : 1;
      if (a <= 0) continue;
      const amt = Math.round(it.amount);
      const base = 15 + Math.min(amt, 110) * 0.125;
      const size = (it.crit ? base * 1.34 : base) * (1 + it.pop * 0.42);
      const col = it.kill ? '#ff5f5f' : it.crit ? '#ffd24a' : it.shield ? '#7cc8ff' : '#fff3e2';

      c.globalAlpha = a;
      c.font = `italic 800 ${size.toFixed(1)}px ${FONT}`;
      c.lineWidth = Math.max(3, size * 0.16);
      c.strokeStyle = 'rgba(2,5,9,.88)';
      c.strokeText(amt, it.x, it.y);
      c.fillStyle = col;
      c.shadowColor = it.crit ? 'rgba(255,190,60,.8)' : 'rgba(0,0,0,0)';
      c.shadowBlur = it.crit ? 12 : 0;
      c.fillText(amt, it.x, it.y);
      c.shadowBlur = 0;

      if (it.crit) {
        // crit chevron above the number
        const y = it.y - size * 0.78;
        c.beginPath();
        c.moveTo(it.x - size * 0.26, y + size * 0.16);
        c.lineTo(it.x, y - size * 0.16);
        c.lineTo(it.x + size * 0.26, y + size * 0.16);
        c.lineWidth = Math.max(2, size * 0.1);
        c.strokeStyle = 'rgba(2,5,9,.85)';
        c.stroke();
        c.strokeStyle = col;
        c.lineWidth = Math.max(1.4, size * 0.075);
        c.stroke();
      }
      if (it.shield) {
        c.globalAlpha = a * 0.55;
        c.strokeStyle = '#7cc8ff';
        c.lineWidth = 1.4;
        const w = size * 0.62;
        c.beginPath();
        c.moveTo(it.x - w, it.y + size * 0.62);
        c.lineTo(it.x + w, it.y + size * 0.62);
        c.stroke();
      }
    }
    c.globalAlpha = 1;
  }
}
