import { COL, el, svg, setText, setStyle, setVar, retrigger } from '../theme.js';
import { weaponIcon, MARK } from '../icons.js';

const LIFE = 8.5;
const MAX = 6;

/** Top-right stacked kill notifications; newest slides in on top. */
export default class KillFeed {
  constructor(root) {
    this.root = el('div', 'hud-feed', root);
    this.items = [];
  }

  /**
   * @param {{killer:string, victim:string, weapon?:string, headshot?:boolean,
   *          knock?:boolean, self?:boolean, ally?:boolean, victimAlly?:boolean}} e
   */
  push(e) {
    const age = e.age || 0;
    const row = el('div', age > 0 ? 'hud-kf' : 'hud-kf in', null);
    const col = e.self ? COL.acc : e.ally ? COL.cy : e.victimAlly ? COL.bad : 'rgba(190,215,235,.85)';
    row.style.setProperty('--kfc', col);
    if (e.self) row.classList.add('self');

    const k = el('span', 'n ' + (e.self ? 'you' : e.ally ? 'ally' : 'foe'), row);
    k.textContent = String(e.killer || 'UNKNOWN').toUpperCase();

    const ic = el('span', 'ic', row);
    svg(weaponIcon(e.weapon || 'ar'), 'w', ic);
    if (e.headshot) svg(MARK.headshot, 'm', ic, '0 0 24 24');
    if (e.knock) svg(MARK.knock, 'm', ic, '0 0 24 24');
    else if (!e.headshot) svg(MARK.skull, 'm', ic, '0 0 24 24');

    const v = el('span', 'n ' + (e.victimAlly ? 'ally' : 'foe'), row);
    v.textContent = String(e.victim || 'UNKNOWN').toUpperCase();
    if (e.victimAlly) v.style.color = COL.bad;

    this.root.insertBefore(row, this.root.firstChild);
    this.items.unshift({ row, age });
    while (this.items.length > MAX) this._retire(this.items.pop());
  }

  _retire(it) {
    if (!it || it.dying) return;
    it.dying = true;
    it.row.classList.remove('in');
    it.row.classList.add('out');
    setTimeout(() => it.row.remove(), 520);
  }

  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.age += dt;
      if (it.age > LIFE && !it.dying) this._retire(it);
      if (it.age > LIFE + 0.6) this.items.splice(i, 1);
    }
  }
}

/* ---------------------------------------------------------- match stats -- */

export class MatchStats {
  constructor(root) {
    const w = el('div', 'hud-stats anim-r', root);
    w.style.animationDelay = '.02s';
    const mk = (label, hot) => {
      const s = el('div', 's' + (hot ? ' hot' : ''), w);
      const b = el('b', null, s);
      const l = el('div', 'lbl', s);
      l.textContent = label;
      return b;
    };
    this.squads = mk('squads');
    el('div', 'div', w);
    this.alive = mk('alive');
    el('div', 'div', w);
    this.kills = mk('kills', true);
    el('div', 'div', w);
    this.dmg = mk('damage', true);
    this._d = 0;
  }

  update(dt, s) {
    const m = s.match || {};
    setText(this.squads, String(m.squads ?? 20));
    setText(this.alive, String(m.alive ?? 60));
    setText(this.kills, String(m.kills ?? 0));
    // damage counter rolls up rather than snapping
    const target = m.damage ?? 0;
    if (this._first !== false) { this._first = false; this._d = target; }
    this._d += (target - this._d) * Math.min(1, dt * 7);
    if (Math.abs(target - this._d) < 1) this._d = target;
    setText(this.dmg, String(Math.round(this._d)));
  }
}

/* -------------------------------------------------------------- banner --- */

export class Banner {
  constructor(root) {
    this.root = el('div', 'hud-banner', root);
    this.pool = [];
    this.idx = 0;
    for (let i = 0; i < 3; i++) {
      const b = el('div', 'hud-bn', this.root);
      const t = el('div', 't', b);
      const v = el('div', 'v', b);
      this.pool.push({ b, t, v });
    }
  }

  show(title, value, kill) {
    const it = this.pool[this.idx];
    this.idx = (this.idx + 1) % this.pool.length;
    setText(it.t, String(title).toUpperCase());
    setText(it.v, String(value || '').toUpperCase());
    it.b.classList.toggle('kill', !!kill);
    retrigger(it.b, 'go');
  }
}
