import {
  COL, SHIELD_NAME, el, svg, setText, setVar, setStyle, setClass, retrigger,
  clamp, clamp01, damp, shieldTier, hexToRgba,
} from '../theme.js';
import { GLYPH, MARK } from '../icons.js';

const BAR_MAX_W = 300;   // px, health bar full width
const SEG_UNIT = 25;     // one notch every 25 points, Apex style

/**
 * A segmented bar with a slow "ghost" drain trail behind the live fill and a
 * white damage flash. Fill/ghost are driven purely by CSS transitions with
 * different durations + delay, which is what produces the momentum feel.
 */
class SegBar {
  constructor(parent, height) {
    this.root = el('div', 'hud-bar', parent);
    this.root.style.setProperty('--h', height + 'px');
    this.ghost = el('div', 'ghost', this.root);
    this.fill = el('div', 'fill', this.root);
    this.notch = el('div', 'notch', this.root);
    this.flash = el('div', 'flash', this.root);
    this.edge = el('div', 'edge', this.root);
    this.width = BAR_MAX_W;
  }

  layout(widthPx, capacity) {
    if (this.width !== widthPx) {
      this.width = widthPx;
      setStyle(this.root, 'width', widthPx + 'px');
    }
    const segs = Math.max(1, Math.round(capacity / SEG_UNIT));
    const w = widthPx / segs;
    setVar(this.root, '--notches',
      `repeating-linear-gradient(90deg,rgba(0,0,0,0) 0 ${(w - 2).toFixed(2)}px,` +
      `rgba(3,7,11,.92) ${(w - 2).toFixed(2)}px ${w.toFixed(2)}px)`);
  }

  colours(c1, c2, c3, glow, ghost, border) {
    setVar(this.root, '--c1', c1);
    setVar(this.root, '--c2', c2);
    setVar(this.root, '--c3', c3);
    setVar(this.root, '--glow', glow);
    setVar(this.root, '--gcol', ghost);
    setVar(this.root, '--brd', border);
  }

  set(frac) {
    const p = (clamp01(frac) * 100).toFixed(2) + '%';
    setStyle(this.fill, 'width', p);
    setStyle(this.ghost, 'width', p);
  }

  hit() { retrigger(this.flash, 'go'); }
  low(on) { setClass(this.root, 'low', on); }
}

export default class Vitals {
  constructor(root, cfg) {
    this.cfg = cfg;
    this.tiers = cfg?.combat?.shieldTiers ?? [50, 75, 100, 125];
    this.maxTier = this.tiers[this.tiers.length - 1];

    const w = el('div', 'hud-vitals anim-l', root);
    w.style.animationDelay = '.10s';

    el('div', 'badge-ring', w);
    const badge = el('div', 'badge', w);
    svg(GLYPH.legend, null, badge, '0 0 24 24');
    this.level = el('div', 'lv', badge);
    this.level.textContent = '112';

    const bars = el('div', 'bars', w);
    const rl = el('div', 'rowlbl', bars);
    this.who = el('div', 'who', rl);
    this.who.textContent = 'OPERATOR';
    this.tierLbl = el('div', 'tier', rl);

    this.shield = new SegBar(bars, 13);
    this.health = new SegBar(bars, 17);

    const vals = el('div', 'vals', w);
    this.vShield = el('div', 'v num vs', vals);
    this.vHealth = el('div', 'v num vh', vals);

    this._dh = -1; this._ds = -1;
    this._tier = -1;
    this._lastH = 100; this._lastS = 100;
  }

  setName(n) { setText(this.who, String(n || 'OPERATOR').toUpperCase()); }
  setLevel(n) { setText(this.level, String(n)); }

  /** Called from bus damage events so the bar can flash independently of value. */
  flash(shieldDamage) {
    (shieldDamage ? this.shield : this.health).hit();
  }

  update(dt, s) {
    const hMax = s.healthMax || 100;
    const sMax = Math.max(1, s.shieldMax || 100);

    const tier = shieldTier(sMax, this.tiers);
    if (tier !== this._tier) {
      this._tier = tier;
      const c = COL.shield[tier];
      this.shield.colours(c, '#ffffff', COL.shieldDim[tier] || c,
        hexToRgba(c, 0.75), hexToRgba(c, 0.85), hexToRgba(c, 0.45));
      setText(this.tierLbl, `${SHIELD_NAME[tier]} · ${sMax}`);
      setVar(this.tierLbl, 'color', c);
      setVar(this.vShield, 'color', c);
    }

    // Shield bar physically widens with evo tier — instant read of your armour.
    const shW = Math.round(BAR_MAX_W * (0.52 + 0.48 * (sMax / this.maxTier)));
    this.shield.layout(shW, sMax);
    this.health.layout(BAR_MAX_W, hMax);

    const hf = clamp01(s.health / hMax);
    const sf = clamp01(s.shield / sMax);
    this.shield.set(sf);
    this.health.set(hf);
    this.shield.low(sf > 0 && sf < 0.26);
    this.health.low(hf < 0.3);

    const hurt = hf < 0.3;
    if (this._hurt !== hurt) {
      this._hurt = hurt;
      setClass(this.vHealth, 'hurt', hurt);
      this.health.colours(
        hurt ? '#ff6a5c' : COL.hp,
        hurt ? '#ffd2c8' : COL.hpHi,
        hurt ? '#a8231f' : '#25a862',
        hurt ? 'rgba(255,80,70,.8)' : 'rgba(92,224,141,.55)',
        'rgba(255,255,255,.6)',
        hurt ? 'rgba(255,110,100,.45)' : 'rgba(150,200,235,.30)');
    }

    // Numeric readouts tween so they never snap.
    this._dh = this._dh < 0 ? s.health : damp(this._dh, s.health, 16, dt);
    this._ds = this._ds < 0 ? s.shield : damp(this._ds, s.shield, 16, dt);
    if (Math.abs(this._dh - s.health) < 0.6) this._dh = s.health;
    if (Math.abs(this._ds - s.shield) < 0.6) this._ds = s.shield;
    setText(this.vShield, String(Math.round(this._ds)));
    setText(this.vHealth, String(Math.round(this._dh)));
  }
}

/* --------------------------------------------------------------- squad -- */

export class Squad {
  constructor(root) {
    const w = el('div', 'hud-squad anim-l', root);
    w.style.animationDelay = '.18s';
    const hd = el('div', 'hd', w);
    svg(MARK.squad, null, hd, '0 0 24 24');
    const t = el('div', 'lbl', hd);
    t.textContent = 'squad';
    this.count = el('div', 'lbl', hd);
    this.count.style.marginLeft = 'auto';
    this.list = el('div', null, w);
    this.rows = [];
  }

  _row(i) {
    if (this.rows[i]) return this.rows[i];
    const r = el('div', 'hud-mate', this.list);
    r.style.setProperty('--mc', COL.squad[i % COL.squad.length]);
    r.style.animation = `hud-in-l .6s var(--ez) both ${0.24 + i * 0.07}s`;
    const nm = el('div', 'nm', r);
    const bars = el('div', 'mbars', r);
    const sb = el('div', 'mb', bars); const si = el('i', null, sb);
    const hb = el('div', 'mb', bars); const hi = el('i', null, hb);
    const st = el('div', 'st', r);
    const row = { root: r, nm, si, hi, st };
    this.rows[i] = row;
    return row;
  }

  update(dt, s) {
    const mates = s.squad || [];
    for (let i = 0; i < mates.length; i++) {
      const m = mates[i];
      const r = this._row(i);
      setStyle(r.root, 'display', '');
      setText(r.nm, String(m.name || '').toUpperCase());
      const tier = shieldTier(m.shieldMax || 100, this.tiers || [50, 75, 100, 125]);
      const sc = COL.shield[tier];
      setStyle(r.si, 'width', (clamp01(m.shield / (m.shieldMax || 100)) * 100).toFixed(1) + '%');
      setStyle(r.si, 'background', sc);
      setStyle(r.hi, 'width', (clamp01(m.health / (m.healthMax || 100)) * 100).toFixed(1) + '%');
      setStyle(r.hi, 'background', m.downed ? COL.bad : COL.hp);
      const st = m.dead ? 'DEAD' : m.downed ? 'DOWN' : m.fighting ? 'FIGHT' : 'OK';
      setText(r.st, st);
      setClass(r.root, 'downed', !!m.downed && !m.dead);
      setClass(r.root, 'dead', !!m.dead);
    }
    for (let i = mates.length; i < this.rows.length; i++) setStyle(this.rows[i].root, 'display', 'none');
    const alive = mates.filter((m) => !m.dead).length + 1;
    setText(this.count, `${alive}/${mates.length + 1}`);
  }
}
