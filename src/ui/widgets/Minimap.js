import { COL, el, setText, sizeCanvas, clamp01, lerp, hexToRgba } from '../theme.js';

const SIZE = 208;
const RANGE = 118;          // metres from centre to rim
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/**
 * Rotating canvas minimap. World geometry is drawn as a footprint, the ring is
 * drawn as a lit circle with the danger zone tinted outside it, and gunfire
 * pings expand and fade so recent contact reads without a legend.
 */
export default class Minimap {
  constructor(root) {
    const w = el('div', 'hud-map anim-l', root);
    w.style.animationDelay = '.04s';
    this.canvas = el('canvas', null, w);
    el('div', 'frame', w);
    this.card = el('div', 'cardinal', w);
    this.zoom = el('div', 'zoom', w);
    this.zoom.textContent = `${RANGE * 2}M`;
    this.ctx = this.canvas.getContext('2d');
    this.dpr = sizeCanvas(this.canvas, SIZE, SIZE);
    this.blocks = [];
    this.pings = [];
    this.rotate = true;
    this._t = 0;
  }

  setBlocks(b) { this.blocks = b || []; }

  ping(x, z, type = 'gun') {
    if (this.pings.length > 26) this.pings.shift();
    this.pings.push({ x, z, age: 0, ttl: type === 'gun' ? 2.6 : 4.5, type });
  }

  agePings(dt) {
    for (let i = this.pings.length - 1; i >= 0; i--) {
      this.pings[i].age += dt;
      if (this.pings[i].age > this.pings[i].ttl) this.pings.splice(i, 1);
    }
  }

  update(dt, s) {
    this._t += dt;
    this.agePings(dt);

    const c = this.ctx;
    const p = s.player;
    const ppm = (SIZE / 2) / RANGE;
    const cx = SIZE / 2, cy = SIZE / 2;
    const theta = this.rotate ? (-Math.PI / 2 - Math.atan2(p.fz, p.fx)) : 0;

    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, SIZE, SIZE);
    c.save();
    c.beginPath();
    c.arc(cx, cy, SIZE / 2 - 1, 0, Math.PI * 2);
    c.clip();

    // base
    const g = c.createRadialGradient(cx, cy, 4, cx, cy, SIZE / 2);
    g.addColorStop(0, 'rgba(14,24,34,.94)');
    g.addColorStop(0.72, 'rgba(9,16,24,.92)');
    g.addColorStop(1, 'rgba(4,8,13,.96)');
    c.fillStyle = g;
    c.fillRect(0, 0, SIZE, SIZE);

    c.save();
    c.translate(cx, cy);
    c.rotate(theta);
    c.scale(ppm, ppm);
    c.translate(-p.x, -p.z);

    // 25m grid
    c.lineWidth = 1 / ppm;
    c.strokeStyle = 'rgba(110,170,210,.10)';
    c.beginPath();
    const g0 = 25;
    const x0 = Math.floor((p.x - RANGE * 1.5) / g0) * g0;
    const z0 = Math.floor((p.z - RANGE * 1.5) / g0) * g0;
    for (let i = 0; i <= 7; i++) {
      const gx = x0 + i * g0, gz = z0 + i * g0;
      c.moveTo(gx, z0); c.lineTo(gx, z0 + 7 * g0);
      c.moveTo(x0, gz); c.lineTo(x0 + 7 * g0, gz);
    }
    c.stroke();

    // world footprint
    const cull = RANGE * 1.45;
    c.lineWidth = 0.9 / ppm;
    for (const b of this.blocks) {
      if (Math.abs(b.x - p.x) > cull + b.hw || Math.abs(b.z - p.z) > cull + b.hd) continue;
      const t = clamp01((b.h - 3) / 20);
      c.fillStyle = `rgba(${Math.round(lerp(38, 96, t))},${Math.round(lerp(56, 124, t))},${Math.round(lerp(72, 150, t))},.92)`;
      c.fillRect(b.x - b.hw, b.z - b.hd, b.hw * 2, b.hd * 2);
      c.strokeStyle = `rgba(150,205,240,${(0.16 + t * 0.3).toFixed(2)})`;
      c.strokeRect(b.x - b.hw, b.z - b.hd, b.hw * 2, b.hd * 2);
    }

    // ring: tint everything outside the safe circle
    const r = s.ring;
    if (r && r.radius > 0) {
      c.save();
      c.beginPath();
      c.rect(p.x - RANGE * 2, p.z - RANGE * 2, RANGE * 4, RANGE * 4);
      c.arc(r.x, r.z, r.radius, 0, Math.PI * 2, true);
      c.fillStyle = 'rgba(150,26,74,.24)';
      c.fill('evenodd');
      c.restore();

      c.beginPath();
      c.arc(r.x, r.z, r.radius, 0, Math.PI * 2);
      c.lineWidth = 2.2 / ppm;
      c.strokeStyle = COL.ring;
      c.shadowColor = COL.ring; c.shadowBlur = 8;
      c.stroke();
      c.shadowBlur = 0;

      if (r.nextRadius > 0) {
        c.beginPath();
        c.arc(r.nextX, r.nextZ, r.nextRadius, 0, Math.PI * 2);
        c.lineWidth = 1.4 / ppm;
        c.setLineDash([5 / ppm, 4 / ppm]);
        c.strokeStyle = COL.ringNext;
        c.stroke();
        c.setLineDash([]);
      }
    }

    // gunfire / contact pings
    for (const q of this.pings) {
      const t = clamp01(q.age / q.ttl);
      const a = 1 - t;
      const rad = 2 + t * 13;
      c.beginPath();
      c.arc(q.x, q.z, rad, 0, Math.PI * 2);
      c.lineWidth = 1.8 / ppm;
      c.strokeStyle = q.type === 'gun' ? `rgba(255,150,50,${(a * 0.9).toFixed(2)})` : `rgba(95,216,255,${(a * 0.9).toFixed(2)})`;
      c.stroke();
      c.beginPath();
      c.arc(q.x, q.z, 2.2, 0, Math.PI * 2);
      c.fillStyle = q.type === 'gun' ? `rgba(255,190,110,${(a).toFixed(2)})` : `rgba(140,230,255,${a.toFixed(2)})`;
      c.fill();
    }

    // squad
    const mates = s.squad || [];
    for (let i = 0; i < mates.length; i++) {
      const m = mates[i];
      if (m.dead || m.x == null) continue;
      c.save();
      c.translate(m.x, m.z);
      c.rotate(Math.atan2(m.fx ?? 0, -(m.fz ?? -1)));
      c.scale(1 / ppm, 1 / ppm);
      c.beginPath();
      c.moveTo(0, -6); c.lineTo(4.6, 5); c.lineTo(0, 2.6); c.lineTo(-4.6, 5);
      c.closePath();
      c.fillStyle = m.downed ? COL.bad : COL.squad[i % COL.squad.length];
      c.strokeStyle = 'rgba(0,0,0,.75)'; c.lineWidth = 1.2;
      c.fill(); c.stroke();
      c.restore();
    }

    // known hostiles
    for (const e of (s.contacts || [])) {
      c.save();
      c.translate(e.x, e.z);
      c.scale(1 / ppm, 1 / ppm);
      c.beginPath();
      c.moveTo(0, -5); c.lineTo(5, 0); c.lineTo(0, 5); c.lineTo(-5, 0);
      c.closePath();
      c.fillStyle = COL.enemy;
      c.strokeStyle = 'rgba(0,0,0,.7)'; c.lineWidth = 1.2;
      c.fill(); c.stroke();
      c.restore();
    }

    c.restore();

    // player: view cone + chevron, always pointing up
    const upAng = this.rotate ? -Math.PI / 2 : (-Math.PI / 2 + Math.atan2(p.fx, -p.fz));
    c.save();
    c.translate(cx, cy);
    c.rotate(upAng + Math.PI / 2);
    const cone = c.createRadialGradient(0, 0, 2, 0, 0, 52);
    cone.addColorStop(0, 'rgba(230,250,255,.32)');
    cone.addColorStop(1, 'rgba(230,250,255,0)');
    c.beginPath();
    c.moveTo(0, 0);
    c.arc(0, 0, 52, -Math.PI / 2 - 0.52, -Math.PI / 2 + 0.52);
    c.closePath();
    c.fillStyle = cone;
    c.fill();
    c.beginPath();
    c.moveTo(0, -7.5); c.lineTo(5.4, 6); c.lineTo(0, 3); c.lineTo(-5.4, 6);
    c.closePath();
    c.fillStyle = '#ffffff';
    c.strokeStyle = 'rgba(0,0,0,.85)'; c.lineWidth = 1.3;
    c.fill(); c.stroke();
    c.restore();

    c.restore(); // clip

    // rim: ticks + cardinals
    c.save();
    c.translate(cx, cy);
    const R = SIZE / 2 - 1;
    for (let i = 0; i < 36; i++) {
      const a = theta - Math.PI / 2 + (i / 36) * Math.PI * 2;
      const major = i % 9 === 0;
      const l = major ? 7 : 3.4;
      c.beginPath();
      c.moveTo(Math.cos(a) * (R - l), Math.sin(a) * (R - l));
      c.lineTo(Math.cos(a) * (R - 1), Math.sin(a) * (R - 1));
      c.lineWidth = major ? 1.6 : 1;
      c.strokeStyle = major ? 'rgba(180,220,245,.55)' : 'rgba(150,195,225,.22)';
      c.stroke();
    }
    // four accent arcs on the rim — reads as a designed instrument, not a circle
    for (let i = 0; i < 4; i++) {
      const a0 = -Math.PI / 2 + i * Math.PI / 2 + 0.22;
      c.beginPath();
      c.arc(0, 0, R - 2.5, a0, a0 + Math.PI / 2 - 0.44);
      c.lineWidth = 1.6;
      c.strokeStyle = i === 0 ? 'rgba(255,160,60,.55)' : 'rgba(150,205,240,.28)';
      c.stroke();
    }

    c.font = '700 9px "Rajdhani","DIN Alternate",system-ui,sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let i = 0; i < 4; i++) {
      const a = theta - Math.PI / 2 + i * Math.PI / 2;
      const L = ['N', 'E', 'S', 'W'][i];
      const rx = Math.cos(a) * (R - 15), ry = Math.sin(a) * (R - 15);
      c.fillStyle = i === 0 ? COL.acc2 : 'rgba(190,220,240,.5)';
      c.fillText(L, rx, ry);
    }
    c.restore();

    const head = ((Math.atan2(p.fx, -p.fz) * 180 / Math.PI) + 360) % 360;
    setText(this.card, DIRS[Math.round(head / 45) % 8]);
  }
}

/* --------------------------------------------------------------- compass */

const CW = 540, CH = 30, PPD = 3.2;

export class Compass {
  constructor(root) {
    const w = el('div', 'hud-compass anim-in', root);
    w.style.animationDelay = '.06s';
    this.canvas = el('canvas', null, w);
    this.ctx = this.canvas.getContext('2d');
    this.dpr = sizeCanvas(this.canvas, CW, CH);
  }

  update(dt, s) {
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, CW, CH);

    const p = s.player;
    const head = ((Math.atan2(p.fx, -p.fz) * 180 / Math.PI) + 360) % 360;
    const mid = CW / 2;

    // fade mask via gradient overlay drawn last; tape first
    c.font = '800 11px "Rajdhani","DIN Alternate",system-ui,sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineJoin = 'round';
    c.shadowColor = 'rgba(0,0,0,.85)';
    c.shadowBlur = 4;

    const half = CW / 2 / PPD;
    const start = Math.floor((head - half) / 5) * 5;
    for (let d = start; d <= head + half; d += 5) {
      let delta = d - head;
      while (delta > 180) delta -= 360;
      while (delta < -180) delta += 360;
      const x = mid + delta * PPD;
      if (x < -20 || x > CW + 20) continue;
      const dd = ((d % 360) + 360) % 360;
      const cardinal = dd % 45 === 0;
      const fade = clamp01(1 - Math.abs(delta) / half) ** 0.6;
      if (cardinal) {
        const li = Math.round(dd / 45) % 8;
        c.fillStyle = `rgba(${li === 0 ? '255,207,92' : '226,241,252'},${(0.98 * fade).toFixed(2)})`;
        c.fillText(DIRS[li], x, 9);
        c.fillRect(x - 0.6, 17, 1.2, 8);
      } else {
        c.fillStyle = `rgba(178,212,235,${(0.5 * fade).toFixed(2)})`;
        c.fillRect(x - 0.5, 19, 1, 4.5);
      }
    }
    c.shadowBlur = 0;

    // baseline
    const grad = c.createLinearGradient(0, 0, CW, 0);
    grad.addColorStop(0, 'rgba(140,190,225,0)');
    grad.addColorStop(0.5, 'rgba(140,190,225,.4)');
    grad.addColorStop(1, 'rgba(140,190,225,0)');
    c.fillStyle = grad;
    c.fillRect(0, 26.5, CW, 1);

    // world markers
    const mark = (bearing, col, shape) => {
      let delta = bearing - head;
      while (delta > 180) delta -= 360;
      while (delta < -180) delta += 360;
      if (Math.abs(delta) > half) return;
      const x = mid + delta * PPD;
      c.fillStyle = col;
      c.beginPath();
      if (shape === 'diamond') {
        c.moveTo(x, 20); c.lineTo(x + 4, 24); c.lineTo(x, 28); c.lineTo(x - 4, 24);
      } else {
        c.arc(x, 24.5, 2.6, 0, Math.PI * 2);
      }
      c.closePath();
      c.fill();
    };

    const r = s.ring;
    if (r && r.radius > 0) {
      const b = (Math.atan2(r.x - p.x, -(r.z - p.z)) * 180 / Math.PI + 360) % 360;
      mark(b, COL.ring, 'diamond');
    }
    const mates = s.squad || [];
    for (let i = 0; i < mates.length; i++) {
      const m = mates[i];
      if (m.dead || m.x == null) continue;
      const b = (Math.atan2(m.x - p.x, -(m.z - p.z)) * 180 / Math.PI + 360) % 360;
      mark(b, COL.squad[i % COL.squad.length], 'dot');
    }

    // centre reticle + bearing readout (cleared so the tape never collides)
    c.fillStyle = COL.acc;
    c.beginPath();
    c.moveTo(mid, 30); c.lineTo(mid - 5, 22); c.lineTo(mid + 5, 22);
    c.closePath(); c.fill();

    c.clearRect(mid - 18, 0, 36, 16);
    c.font = '800 12px "Rajdhani","DIN Alternate",system-ui,sans-serif';
    const txt = String(Math.round(head)).padStart(3, '0');
    c.lineWidth = 3.4;
    c.strokeStyle = 'rgba(2,5,9,.92)';
    c.strokeText(txt, mid, 8);
    c.fillStyle = '#ffffff';
    c.fillText(txt, mid, 8);
  }
}
