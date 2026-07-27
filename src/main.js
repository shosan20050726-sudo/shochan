import Engine from './core/Engine.js';
import Input from './core/Input.js';

/**
 * Boot sequence. Systems are loaded *optionally* — a module that fails to
 * import (or does not exist yet) logs a warning and the game keeps running
 * without it. This is deliberate: it lets the subsystems be developed and
 * screenshotted in parallel without any one of them being able to black-screen
 * the build for everyone else.
 */
const MODULES = [
  ['world',   () => import('./world/World.js')],
  ['player',  () => import('./physics/PlayerSystem.js')],
  ['weapons', () => import('./weapons/WeaponSystem.js')],
  ['ai',      () => import('./ai/AISystem.js')],
  ['legends', () => import('./legends/LegendSystem.js')],
  ['vfx',     () => import('./vfx/VFXSystem.js')],
  ['audio',   () => import('./audio/AudioSystem.js')],
  ['ui',      () => import('./ui/UISystem.js')],
  ['match',   () => import('./game/MatchSystem.js')],
  ['postfx',  () => import('./gfx/PostFX.js')],
];

const bootEl = document.getElementById('boot');
const statusEl = document.getElementById('boot-status');
const barEl = document.getElementById('boot-bar');
const crashEl = document.getElementById('crash');

function setStatus(text, pct) {
  if (statusEl) statusEl.textContent = text;
  if (barEl) barEl.style.width = `${Math.round(pct * 100)}%`;
}

function crash(err) {
  console.error(err);
  if (crashEl) {
    crashEl.style.display = 'block';
    crashEl.textContent = `FATAL\n\n${err?.stack || err}`;
  }
}

async function boot() {
  const canvas = document.getElementById('game');
  const engine = new Engine(canvas);
  const input = new Input(canvas, engine.bus);
  engine.register(input);

  // Expose for the screenshot/critic harness and for debugging.
  window.__ENGINE = engine;
  window.__LOADED = [];
  window.__FAILED = [];

  for (let i = 0; i < MODULES.length; i++) {
    const [name, importer] = MODULES[i];
    setStatus(`loading ${name}`, i / MODULES.length);
    try {
      const mod = await importer();
      const Ctor = mod.default;
      if (typeof Ctor !== 'function') throw new Error(`${name}: no default export class`);
      engine.register(new Ctor());
      window.__LOADED.push(name);
    } catch (err) {
      window.__FAILED.push({ name, error: String(err?.message || err) });
      console.warn(`[boot] optional system "${name}" unavailable:`, err?.message || err);
    }
  }

  setStatus('building world', 0.9);
  await engine.init();

  // Input edge-flags must clear after every system has read them.
  engine.register({
    name: 'input-endframe', priority: 999,
    update: () => input.endFrame(),
  });

  setStatus('ready', 1);
  engine.start();

  // Give the first frames a moment to warm shader compilation before reveal.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    bootEl?.classList.add('hidden');
    window.__READY = true;
  }));
}

window.addEventListener('error', (e) => crash(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => crash(e.reason));
boot().catch(crash);
