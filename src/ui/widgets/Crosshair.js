import { COL, el, svg, setVar, setStyle, setClass, retrigger, clamp, clamp01, damp } from '../theme.js';

/** 4 diagonal ticks, drawn between two radii. */
function ticks(r1, r2, w) {
  const d = [];
  for (let i = 0; i < 4; i++) {
    const a = (Math.PI / 4) + i * (Math.PI / 2);
    const c = Math.cos(a), s = Math.sin(a);
    d.push(`M${(34 + c * r1).toFixed(1)} ${(34 + s * r1).toFixed(1)}L${(34 + c * r2).toFixed(1)} ${(34 + s * r2).toFixed(1)}`);
  }
  return `<path d="${d.join('')}" stroke="currentColor" stroke-width="${w}" fill="none" stroke-linecap="butt"/>`;
}

const HITMARK = {
  body: ticks(9, 19, 3),
  head: ticks(8, 23, 3.8) +
    `<circle cx="34" cy="34" r="25" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".6"/>`,
  shield: ticks(10, 19, 3) +
    `<path d="M34 15 47 22.5v15L34 45 21 37.5v-15z" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".8" stroke-dasharray="7 5"/>`,
  kill: `<path d="M22 22 46 46M46 22 22 46" stroke="currentColor" stroke-width="3.6" fill="none" stroke-linecap="butt"/>` +
    ticks(20, 27, 2.4),
};

const DIR_ARC =
  `<path d="M98.5 43.6A92 92 0 0 1 161.5 43.6" fill="none" stroke="currentColor" stroke-width="7" opacity=".92"/>` +
  `<path d="M104 32.2A104 104 0 0 1 156 32.2" fill="none" stroke="currentColor" stroke-width="2" opacity=".42"/>` +
  `<path d="M130 20.5 137.5 32h-15z" fill="currentColor" opacity=".95"/>`;

export default class Crosshair {
  constructor(root) {
    const c = el('div', 'hud-center', root);
    this.center = c;

    // damage direction arcs sit furthest out
    this.dirWrap = el('div', 'hud-dmgdir', c);
    this.dirPool = [];
    for (let i = 0; i < 6; i++) {
      const s = svg(DIR_ARC, null, this.dirWrap, '0 0 260 260');
      s.style.color = COL.bad;
      this.dirPool.push(s);
    }
    this.dirIdx = 0;

    this.x = el('div', 'hud-xhair', c);
    el('div', 'hud-adsring', this.x);
    for (const k of ['xt', 'xr', 'xb', 'xl', 'xdot']) el('i', k, this.x);

    this.hit = el('div', 'hud-hit', c);
    this.mark = svg('', null, this.hit, '0 0 68 68');
    this.burst = svg(
      `<circle cx="34" cy="34" r="26" fill="none" stroke="currentColor" stroke-width="2.4"/>`,
      null, this.hit, '0 0 68 68');
    this.burst.style.opacity = '0';

    this.spread = 0;
    this._gap = 8;
  }

  /** type: 'body' | 'head' | 'shield' | 'kill' */
  hitmarker(type) {
    const t = HITMARK[type] ? type : 'body';
    const col = t === 'kill' ? COL.bad : t === 'head' ? '#ffdf6a' : t === 'shield' ? COL.cy : '#f2fbff';
    this.mark.innerHTML = HITMARK[t];
    this.mark.style.color = col;
    this.mark.classList.remove('go', 'go-kill');
    void this.mark.offsetWidth;
    this.mark.classList.add(t === 'kill' ? 'go-kill' : 'go');
    if (t === 'kill' || t === 'shield') {
      this.burst.style.color = col;
      this.burst.style.opacity = '1';
      retrigger(this.burst, 'burst');
    }
  }

  /** bearing in radians, 0 = straight ahead, positive = clockwise on screen. */
  damageFrom(bearing) {
    const s = this.dirPool[this.dirIdx];
    this.dirIdx = (this.dirIdx + 1) % this.dirPool.length;
    s.style.transform = `rotate(${(bearing * 180 / Math.PI).toFixed(1)}deg)`;
    retrigger(s, 'go');
  }

  update(dt, s) {
    // Spread: movement + recoil bloom, tightened hard by ADS.
    const move = clamp01((s.speed || 0) / 8) * (s.grounded === false ? 1.5 : 1);
    const target = clamp01(0.14 + move * 0.5 + (s.bloom || 0)) * (s.ads ? 0.28 : 1);
    this.spread = damp(this.spread, target, 12, dt);

    const gap = 4 + this.spread * 24;
    const len = s.ads ? 5 : 8 + this.spread * 5;
    setVar(this.x, '--gap', gap.toFixed(2) + 'px');
    setVar(this.x, '--len', len.toFixed(2) + 'px');
    setVar(this.x, '--thk', (s.ads ? 1.8 : 2.4).toFixed(1) + 'px');
    setClass(this.x, 'ads', !!s.ads);

    // Friendly / enemy tint + hostile-focus dot.
    const col = s.overEnemy ? COL.bad : '#eafaff';
    setVar(this.x, '--xc', col);
  }
}
