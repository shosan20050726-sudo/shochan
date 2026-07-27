import { el, svg, setText, setClass } from '../theme.js';
import { UIICON } from '../icons.js';

/**
 * Pause / settings panel. Every control writes straight back into CFG (and,
 * where it is safe to do so, applies the change live to the camera) so the
 * rest of the engine picks the value up on its next read.
 */
export default class PauseMenu {
  constructor(root, ctx, hud) {
    this.cfg = ctx.cfg;
    this.ctx = ctx;
    this.hud = hud;
    this.open = false;
    this._stash = {};

    const w = el('div', 'hud-pause', root);
    this.root = w;
    const panel = el('div', 'panel', w);

    const ph = el('div', 'ph', panel);
    svg(UIICON.gear, null, ph, '0 0 24 24');
    const h = el('h2', null, ph);
    h.textContent = 'SETTINGS';
    const esc = el('div', 'esc', ph);
    esc.textContent = 'ESC TO CLOSE';

    const body = el('div', 'body', panel);
    this.body = body;

    this.group('CONTROLS');
    this.slider('SENSITIVITY', 0.4, 5.0, 0.05,
      () => this.cfg.camera.sensitivity * 1000,
      (v) => { this.cfg.camera.sensitivity = v / 1000; },
      (v) => v.toFixed(2));
    this.slider('ADS SENS', 0.3, 1.5, 0.01,
      () => this.cfg.camera.adsSensScale,
      (v) => { this.cfg.camera.adsSensScale = v; },
      (v) => v.toFixed(2));
    this.slider('FIELD OF VIEW', 70, 120, 1,
      () => this.cfg.camera.fov,
      (v) => {
        this.cfg.camera.fov = v;
        const cam = this.ctx.camera;
        if (cam && !this.ctx.engine?.get?.('player')) { cam.fov = v; cam.updateProjectionMatrix(); }
      },
      (v) => String(Math.round(v)));
    this.slider('WEAPON FOV', 45, 90, 1,
      () => this.cfg.camera.viewmodelFov,
      (v) => { this.cfg.camera.viewmodelFov = v; },
      (v) => String(Math.round(v)));

    this.group('GRAPHICS');
    this.slider('EXPOSURE', 0.6, 1.6, 0.01,
      () => this.cfg.gfx.exposure,
      (v) => {
        this.cfg.gfx.exposure = v;
        if (this.ctx.renderer) this.ctx.renderer.toneMappingExposure = v;
      },
      (v) => v.toFixed(2));
    this.gfxToggle('BLOOM', 'bloomStrength', 0.42);
    this.gfxToggle('MOTION BLUR', 'motionBlurStrength', 0.42);
    this.gfxToggle('OCCLUSION (SSAO)', 'ssaoIntensity', 0.9);
    this.gfxToggle('FILM GRAIN', 'filmGrain', 0.022);
    this.gfxToggle('CHROMATIC AB.', 'chromaticAberration', 0.0016);
    this.gfxToggle('VIGNETTE', 'vignette', 0.32);

    this.group('INTERFACE');
    this.toggle('DAMAGE NUMBERS',
      () => hud.settings.damageNumbers,
      (v) => { hud.settings.damageNumbers = v; hud.applySettings(); });
    this.toggle('ROTATE MINIMAP',
      () => hud.settings.rotateMinimap,
      (v) => { hud.settings.rotateMinimap = v; hud.applySettings(); });
    this.toggle('HIT MARKERS',
      () => hud.settings.hitmarkers,
      (v) => { hud.settings.hitmarkers = v; });
    this.slider('HUD OPACITY', 0.35, 1, 0.01,
      () => hud.settings.opacity,
      (v) => { hud.settings.opacity = v; hud.applySettings(); },
      (v) => Math.round(v * 100) + '%');

    const pf = el('div', 'pf', panel);
    const resume = el('button', 'hud-btn primary', pf, '<span>RESUME</span>');
    resume.addEventListener('click', () => this.setOpen(false));
    const reset = el('button', 'hud-btn', pf, '<span>RESET DEFAULTS</span>');
    reset.addEventListener('click', () => this.reset());

    this._onKey = (e) => {
      if (e.code === 'Escape' || e.code === 'F1') {
        e.preventDefault();
        this.setOpen(!this.open);
      }
    };
    window.addEventListener('keydown', this._onKey);
    this.rows = this.rows || [];
  }

  group(t) {
    const g = el('div', 'grp', this.body);
    g.textContent = t;
  }

  slider(label, min, max, step, get, set, fmt) {
    const r = el('div', 'hud-row', this.body);
    const l = el('label', null, r);
    l.textContent = label;
    const i = el('input', null, r);
    i.type = 'range'; i.min = min; i.max = max; i.step = step;
    const v = el('div', 'val', r);
    const sync = () => {
      i.value = String(get());
      setText(v, fmt(get()));
    };
    i.addEventListener('input', () => { set(parseFloat(i.value)); sync(); });
    sync();
    (this.rows ||= []).push(sync);
  }

  toggle(label, get, set) {
    const r = el('div', 'hud-row', this.body);
    const l = el('label', null, r);
    l.textContent = label;
    const t = el('div', 'hud-tog', r);
    el('i', null, t);
    const sync = () => setClass(t, 'on', !!get());
    t.addEventListener('click', () => { set(!get()); sync(); });
    sync();
    (this.rows ||= []).push(sync);
    return t;
  }

  /** Graphics toggles zero the constant and restore the previous value. */
  gfxToggle(label, key, dflt) {
    this._stash[key] = this.cfg.gfx[key] || dflt;
    this.toggle(label,
      () => (this.cfg.gfx[key] ?? 0) > 0,
      (v) => {
        if (v) this.cfg.gfx[key] = this._stash[key] || dflt;
        else { this._stash[key] = this.cfg.gfx[key] || dflt; this.cfg.gfx[key] = 0; }
      });
  }

  reset() {
    const c = this.cfg;
    c.camera.sensitivity = 0.0021;
    c.camera.adsSensScale = 0.65;
    c.camera.fov = 96;
    c.camera.viewmodelFov = 62;
    c.gfx.exposure = 1.06;
    c.gfx.bloomStrength = 0.42;
    c.gfx.motionBlurStrength = 0.42;
    c.gfx.ssaoIntensity = 0.9;
    c.gfx.filmGrain = 0.022;
    c.gfx.chromaticAberration = 0.0016;
    c.gfx.vignette = 0.32;
    this.hud.settings.opacity = 1;
    this.hud.settings.damageNumbers = true;
    this.hud.settings.rotateMinimap = true;
    this.hud.settings.hitmarkers = true;
    this.hud.applySettings();
    if (this.ctx.renderer) this.ctx.renderer.toneMappingExposure = c.gfx.exposure;
    for (const s of this.rows) s();
  }

  setOpen(v) {
    if (this.open === v) return;
    this.open = v;
    setClass(this.root, 'on', v);
    if (v) {
      for (const s of this.rows) s();
      document.exitPointerLock?.();
    }
  }

  dispose() { window.removeEventListener('keydown', this._onKey); }
}
