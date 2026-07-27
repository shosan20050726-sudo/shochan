import {
  COL, AMMO_TYPE, el, svg, setText, setStyle, setVar, setClass, retrigger, clamp01,
} from '../theme.js';
import { weaponIcon, GLYPH, ITEM } from '../icons.js';

const MAX_PIPS = 30;

/** Bottom-right weapon block: name, mag/reserve, round strip, reload, slots. */
export default class WeaponPanel {
  constructor(root) {
    const w = el('div', 'hud-weapon anim-r', root);
    w.style.animationDelay = '.12s';
    this.root = w;

    const row = el('div', 'wrow', w);
    this.modeChip = el('div', 'chip', row, '<b></b>');
    this.ammoChip = el('div', 'chip', row, '<b></b>');
    this.name = el('div', 'wname', row);

    this.iconWrap = el('div', 'wicon', w);
    this.icon = svg(weaponIcon('ar'), null, this.iconWrap);

    const ammo = el('div', 'ammo', w);
    this.mag = el('div', 'mag', ammo);
    this.sep = el('div', 'sep', ammo);
    this.sep.textContent = '/';
    this.res = el('div', 'res', ammo);

    this.strip = el('div', 'strip', w);
    this.pips = [];

    const rw = el('div', 'rwrap', w);
    this.rtxt = el('div', 'rtxt', rw);
    this.rtxt.textContent = 'RELOADING';
    this.rbar = el('div', 'rload', rw);
    this.rfill = el('i', null, this.rbar);

    this.slotsWrap = el('div', 'slots', w);
    this.slots = [];

    this._kind = null;
    this._magMax = -1;
  }

  _ensurePips(n) {
    while (this.pips.length < n) this.pips.push(el('i', null, this.strip));
    for (let i = 0; i < this.pips.length; i++) {
      setStyle(this.pips[i], 'display', i < n ? '' : 'none');
    }
  }

  _ensureSlots(list) {
    while (this.slots.length < list.length) {
      const i = this.slots.length;
      const s = el('div', 'slot', this.slotsWrap);
      const k = el('div', 'k', s); k.textContent = String(i + 1);
      const n = el('div', 'n', s);
      this.slots.push({ root: s, n });
    }
    for (let i = 0; i < this.slots.length; i++) {
      setStyle(this.slots[i].root, 'display', i < list.length ? '' : 'none');
    }
  }

  update(dt, s) {
    const wp = s.weapon;
    if (!wp) { setStyle(this.root, 'opacity', '0'); return; }
    setStyle(this.root, 'opacity', '1');

    setText(this.name, String(wp.name || 'UNARMED').toUpperCase());
    setText(this.modeChip.firstChild, String(wp.mode || 'AUTO').toUpperCase());

    const at = AMMO_TYPE[wp.ammo] || AMMO_TYPE.light;
    setText(this.ammoChip.firstChild, at.label);
    setVar(this.ammoChip, 'color', at.col);

    if (this._kind !== wp.kind) {
      this._kind = wp.kind;
      this.icon.innerHTML = weaponIcon(wp.kind);
      retrigger(this.iconWrap, 'anim-r');
    }

    const magMax = Math.max(1, wp.magMax || 1);
    const mag = Math.max(0, Math.round(wp.mag ?? 0));
    setText(this.mag, String(mag).padStart(2, '0'));
    setText(this.res, String(Math.round(wp.reserve ?? 0)));

    const frac = mag / magMax;
    setClass(this.root, 'low', frac <= 0.34 && mag > 0);
    setClass(this.root, 'empty', mag === 0);

    // Round strip: one pip per round, collapsed into groups for big mags.
    const pipCount = Math.min(magMax, MAX_PIPS);
    if (this._magMax !== magMax) { this._magMax = magMax; this._ensurePips(pipCount); }
    const per = magMax / pipCount;
    const lit = Math.ceil(mag / per);
    const col = frac <= 0.34 ? COL.acc : at.col;
    for (let i = 0; i < pipCount; i++) {
      setClass(this.pips[i], 'off', i >= lit);
      setStyle(this.pips[i], 'background', i < lit ? col : '');
      setVar(this.pips[i], '--acc2', col);
    }

    const reloading = !!wp.reloading;
    setClass(this.root, 'reloading', reloading);
    if (reloading) {
      const p = clamp01(wp.reloadProgress ?? 0);
      setStyle(this.rfill, 'width', (p * 100).toFixed(1) + '%');
    }

    const list = s.slots || [];
    this._ensureSlots(list);
    for (let i = 0; i < list.length; i++) {
      setText(this.slots[i].n, String(list[i].name || '—').toUpperCase());
      setClass(this.slots[i].root, 'on', !!list[i].active);
    }
  }
}

/* ----------------------------------------------------------- abilities -- */

class AbilityCell {
  constructor(parent, opts) {
    const r = el('div', 'hud-ab', parent);
    r.style.setProperty('--s', opts.size + 'px');
    r.style.setProperty('--c', opts.col);
    this.root = r;
    el('div', 'hexbg', r);
    const fg = el('div', 'hexfg', r);
    svg(opts.glyph, null, fg, '0 0 24 24');
    this.sweep = el('div', 'sweep', r);
    this.flash = el('div', 'flash', r);
    this.cd = el('div', 'cd', r);
    const k = el('div', 'key', r);
    k.textContent = opts.key;
    this.keyEl = k;
    if (opts.charges) {
      this.chargeWrap = el('div', 'charges', r);
      this.chargeEls = [];
    }
    if (opts.pct) this.pct = el('div', 'pct', r);
    this._ready = null;
  }

  setCharges(n, max) {
    if (!this.chargeWrap) return;
    while (this.chargeEls.length < max) this.chargeEls.push(el('i', null, this.chargeWrap));
    for (let i = 0; i < this.chargeEls.length; i++) {
      setStyle(this.chargeEls[i], 'display', i < max ? '' : 'none');
      setClass(this.chargeEls[i], 'off', i >= n);
    }
  }

  /** p = 0..1 charged. */
  set(p, ready, cdText) {
    setVar(this.sweep, '--p', (clamp01(p) * 100).toFixed(1) + '%');
    setClass(this.root, 'cooling', !ready);
    setClass(this.root, 'ready', ready);
    setText(this.cd, cdText);
    if (this._ready !== ready) {
      if (this._ready === false && ready) retrigger(this.flash, 'go');
      this._ready = ready;
    }
  }
}

export class Abilities {
  constructor(root) {
    const w = el('div', 'hud-abil anim-in', root);
    w.style.animationDelay = '.22s';
    this.tac = new AbilityCell(w, {
      size: 56, col: COL.cy, glyph: GLYPH.tactical, key: 'Q', charges: true,
    });
    this.ult = new AbilityCell(w, {
      size: 68, col: COL.acc, glyph: GLYPH.ultimate, key: 'Z', pct: true,
    });
    this.tac.keyEl.textContent = 'Q';
    this.ult.keyEl.textContent = 'Z';

    // Consumables — reads as inventory at a glance, dims to nothing at zero.
    const items = el('div', 'hud-items', w);
    this.items = [
      ['syringe', '#6be08d'], ['medkit', '#6be08d'],
      ['cell', '#5fb8ff'], ['battery', '#5fb8ff'],
    ].map(([k, c]) => {
      const cell = el('div', 'hud-item', items);
      cell.style.setProperty('--ic', c);
      svg(ITEM[k], null, cell, '0 0 24 24');
      return { key: k, n: el('b', null, cell), root: cell };
    });
  }

  update(dt, s) {
    const a = s.abilities || {};
    const t = a.tactical || {};
    const tReady = (t.charges ?? 1) > 0;
    const tp = tReady ? 1 : 1 - clamp01((t.cd ?? 0) / Math.max(0.001, t.cdMax ?? 1));
    this.tac.set(tp, tReady, tReady ? '' : String(Math.ceil(t.cd ?? 0)));
    this.tac.setCharges(t.charges ?? 1, t.maxCharges ?? 2);

    const u = a.ultimate || {};
    const uc = clamp01(u.charge ?? 0);
    this.ult.set(uc, uc >= 1, uc >= 1 ? '' : Math.floor(uc * 100) + '%');

    const inv = s.items || {};
    for (const it of this.items) {
      const n = inv[it.key] ?? 0;
      setText(it.n, String(n));
      setClass(it.root, 'empty', n <= 0);
    }
  }
}
