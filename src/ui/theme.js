/**
 * Design tokens + tiny DOM/math helpers shared by every HUD widget.
 *
 * Nothing here touches the DOM at import time. Colours that are needed by
 * canvas widgets (minimap, damage numbers, compass) live in JS; everything
 * that only CSS needs lives in styles.js as custom properties so the browser
 * can animate it.
 */

export const COL = {
  tx: '#e4f0fa',
  dim: '#93aabd',
  dim2: '#5f7385',
  line: 'rgba(122,178,220,0.22)',

  acc: '#ff7a18',          // apex orange — attention / danger / self
  acc2: '#ffc247',         // amber — charge, warnings
  cy: '#5fd8ff',           // cyan — informational
  hp: '#5ce08d',           // health fill
  hpHi: '#d9ffe8',
  bad: '#ff4b5c',
  ring: '#b45cff',
  ringNext: '#6ad2ff',

  // white / blue / purple / red / gold evo tiers
  shield: ['#e8f2fc', '#4aa8ff', '#a45cff', '#ff4b5c', '#ffc63d'],
  shieldDim: ['#8fa5b8', '#2a6ba8', '#6a3aa8', '#a83440', '#a8811f'],

  squad: ['#ffb02e', '#4fd1ff', '#b78bff'],
  enemy: '#ff4b5c',
};

export const SHIELD_NAME = ['WHITE', 'BLUE', 'PURPLE', 'RED', 'GOLD'];

export const AMMO_TYPE = {
  light: { label: 'LIGHT', col: '#ffc63d' },
  heavy: { label: 'HEAVY', col: '#7fb4e6' },
  energy: { label: 'ENERGY', col: '#66e6a8' },
  shotgun: { label: 'SHOTGUN', col: '#ff8a5c' },
  sniper: { label: 'SNIPER', col: '#c08bff' },
  special: { label: 'SPECIAL', col: '#ff5c8a' },
};

/* ---------------------------------------------------------------- math -- */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
/** Frame-rate independent exponential approach. */
export const damp = (a, b, lambda, dt) => b + (a - b) * Math.exp(-lambda * dt);
export const smoothstep = (t) => t * t * (3 - 2 * t);

export const EASE = {
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inQuad: (t) => t * t,
  outBack: (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2),
};

export function fmtTime(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Which evo tier a shield capacity belongs to (index into COL.shield). */
export function shieldTier(capacity, tiers) {
  const t = tiers && tiers.length ? tiers : [50, 75, 100, 125];
  let idx = 0;
  for (let i = 0; i < t.length; i++) if (capacity >= t[i] - 0.5) idx = i;
  if (capacity > t[t.length - 1] + 0.5) idx = t.length; // gold / over-evo
  return clamp(idx, 0, COL.shield.length - 1);
}

export function hexToRgba(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* ----------------------------------------------------------------- dom -- */

export function el(tag, cls, parent, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;      // static author markup only
  if (parent) parent.appendChild(n);
  return n;
}

export function svg(markup, cls, parent, viewBox = '0 0 48 20') {
  const n = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  n.setAttribute('viewBox', viewBox);
  if (cls) n.setAttribute('class', cls);
  n.innerHTML = markup;
  if (parent) parent.appendChild(n);
  return n;
}

/** Write-on-change guards: the HUD updates every frame, the DOM must not. */
export function setText(node, v) {
  if (node.__t !== v) { node.__t = v; node.textContent = v; }
}
export function setVar(node, prop, v) {
  const k = '_v' + prop;
  if (node[k] !== v) { node[k] = v; node.style.setProperty(prop, v); }
}
export function setStyle(node, prop, v) {
  const k = '_s' + prop;
  if (node[k] !== v) { node[k] = v; node.style[prop] = v; }
}
export function setClass(node, cls, on) {
  const k = '_c' + cls;
  if (node[k] !== on) { node[k] = on; node.classList.toggle(cls, !!on); }
}

/** Restart a CSS animation on an element (class-toggle + reflow read). */
export function retrigger(node, cls) {
  node.classList.remove(cls);
  // eslint-disable-next-line no-unused-expressions
  void node.offsetWidth;
  node.classList.add(cls);
}

/** Crisp canvas sizing for the current DPR, returns the scale used. */
export function sizeCanvas(canvas, w, h, maxDpr = 2) {
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw; canvas.height = ph;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  }
  return dpr;
}
