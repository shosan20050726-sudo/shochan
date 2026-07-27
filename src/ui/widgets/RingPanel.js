import { COL, el, svg, setText, setStyle, setVar, setClass, fmtTime, clamp01 } from '../theme.js';

const ARROW = `<path d="M12 2.5 21.5 21 12 16.2 2.5 21z"/>`;

/** Stage / countdown / bearing-to-safe-zone block under the minimap. */
export default class RingPanel {
  constructor(root) {
    const w = el('div', 'hud-ring anim-l', root);
    w.style.animationDelay = '.08s';
    this.root = w;

    const top = el('div', 'top', w);
    this.icon = svg(
      `<circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="2.2"/>` +
      `<circle cx="12" cy="12" r="3.4" fill="currentColor" opacity=".8"/>`,
      null, top, '0 0 24 24');
    this.stage = el('div', 'stg', top);
    this.state = el('div', 'state', top);

    const mid = el('div', 'mid', w);
    this.arrow = svg(ARROW, 'arrow', mid, '0 0 24 24');
    this.arrow.style.fill = 'currentColor';
    this.clock = el('div', 'clock', mid);
    const d = el('div', 'dist', mid);
    this.dist = el('b', null, d);
    this.distLbl = el('div', 'lbl', d);
    this.distLbl.textContent = 'to zone';

    this.prog = el('div', 'prog', w);
    this.progFill = el('i', null, this.prog);
  }

  update(dt, s) {
    const r = s.ring;
    if (!r) { setStyle(this.root, 'opacity', '0'); return; }
    setStyle(this.root, 'opacity', '1');

    const closing = r.phase === 'close';
    const col = closing ? COL.ring : COL.ringNext;
    setVar(this.root, '--ringc', col);

    setText(this.stage, `RING ${r.stage ?? 1}`);
    setText(this.state, closing ? 'CLOSING' : 'NEXT IN');
    setText(this.clock, fmtTime(r.time ?? 0));
    setClass(this.root, 'urgent', (r.time ?? 99) < 10 && closing);

    const p = s.player;
    const dx = r.x - p.x, dz = r.z - p.z;
    const dcent = Math.hypot(dx, dz);
    const edge = dcent - r.radius;
    setText(this.dist, `${Math.max(0, Math.round(Math.abs(edge)))}M`);
    setText(this.distLbl, edge > 0 ? 'OUTSIDE' : 'TO EDGE');
    setVar(this.dist, 'color', edge > 0 ? COL.bad : COL.tx);

    // arrow points at the zone centre relative to where the player is facing
    const bearing = Math.atan2(dx, dz);
    const facing = Math.atan2(p.fx, p.fz);
    let rel = bearing - facing;
    while (rel > Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    setStyle(this.arrow, 'transform', `rotate(${(rel * 180 / Math.PI).toFixed(1)}deg)`);
    setStyle(this.arrow, 'opacity', edge > -8 ? '1' : '0.5');

    setStyle(this.progFill, 'width', (clamp01(1 - (r.time ?? 0) / Math.max(1, r.total ?? 1)) * 100).toFixed(1) + '%');
  }
}
