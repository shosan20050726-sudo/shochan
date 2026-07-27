import { el, setStyle, setClass, retrigger, clamp01, fmtTime, setText } from '../theme.js';

/**
 * Full-screen feedback: low-health vignette + desaturation, incoming-damage
 * flash, and the downed state overlay with its bleedout timer.
 */
export default class Overlays {
  /**
   * @param {HTMLElement} back  layer painted *under* the HUD widgets
   * @param {HTMLElement} root  layer painted over everything
   */
  constructor(root, back) {
    const b = back || root;
    this.vig = el('div', 'hud-vig', b);
    this.desat = el('div', 'hud-desat', b);
    this.flash = el('div', 'hud-hitflash', b);

    const d = el('div', 'hud-downed', root);
    this.downed = d;
    const box = el('div', 'box', d);
    const t = el('div', 'ttl', box);
    t.textContent = 'YOU ARE DOWN';
    this.sub = el('div', 'sub', box);
    this.sub.textContent = 'CRAWL TO COVER · TEAMMATE CAN REVIVE';
    const bl = el('div', 'bleed', box);
    this.bleedFill = el('i', null, bl);
    this.bleedTxt = el('div', 'sub', box);

    const hint = el('div', 'hud-hint', root);
    hint.innerHTML = '<b>ESC</b>&nbsp; SETTINGS';
    this.hint = hint;
  }

  hit() { retrigger(this.flash, 'go'); }

  update(dt, s) {
    const f = clamp01(s.health / (s.healthMax || 100));
    // ramps in below 45%, saturates at 8%
    const k = clamp01((0.45 - f) / 0.37);
    setStyle(this.vig, 'opacity', (k * 0.92).toFixed(3));
    setClass(this.vig, 'on', k > 0.35);
    setStyle(this.desat, 'opacity', (k * 0.85).toFixed(3));

    const dn = !!s.downed;
    setClass(this.downed, 'on', dn);
    setStyle(this.hint, 'opacity', dn ? '0' : '1');
    if (dn) {
      const p = clamp01((s.bleedTime ?? 0) / Math.max(1, s.bleedTotal ?? 30));
      setStyle(this.bleedFill, 'width', (p * 100).toFixed(1) + '%');
      setText(this.bleedTxt, `BLEEDOUT ${fmtTime(s.bleedTime ?? 0)}`);
    }
  }
}
