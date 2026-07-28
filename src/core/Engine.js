import * as THREE from 'three';
import CFG from './Config.js';
import { EventBus } from './EventBus.js';

/**
 * Engine owns the render target, the two camera layers, and the clock.
 * It knows nothing about gameplay: systems register themselves and are
 * driven through a fixed-timestep loop with interpolated rendering.
 *
 * Two-layer camera rendering (world pass + viewmodel pass with cleared depth)
 * is the standard FPS trick: it lets the world run a wide 96deg FOV for speed
 * while the gun renders at 62deg so it doesn't look warped, and stops the
 * weapon clipping through geometry.
 */
export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.bus = new EventBus();
    this.cfg = CFG;
    this.systems = [];
    this.running = false;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,        // resolved by post-process AA instead
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = CFG.gfx.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      CFG.camera.fov, 1, CFG.camera.near, CFG.camera.far);

    // Viewmodel lives in its own scene so world lighting/fog/post can differ.
    this.viewmodelScene = new THREE.Scene();
    this.viewmodelCamera = new THREE.PerspectiveCamera(
      CFG.camera.viewmodelFov, 1, 0.008, 12);

    this.clock = { last: 0, accumulator: 0, elapsed: 0, frame: 0, dt: 0, fps: 60 };
    this._fpsAccum = 0; this._fpsFrames = 0;

    this._onResize = this.resize.bind(this);
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  /** ctx is the shared service locator handed to every system. */
  get ctx() {
    return {
      engine: this,
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      viewmodelScene: this.viewmodelScene,
      viewmodelCamera: this.viewmodelCamera,
      bus: this.bus,
      cfg: this.cfg,
      clock: this.clock,
    };
  }

  /**
   * @param {{name:string, priority?:number, init?:Function,
   *          fixedUpdate?:Function, update?:Function, dispose?:Function}} system
   */
  register(system) {
    if (!system?.name) throw new Error('[Engine] system needs a name');
    system.priority ??= 100;
    this.systems.push(system);
    this.systems.sort((a, b) => a.priority - b.priority);
    return system;
  }

  get(name) { return this.systems.find((s) => s.name === name); }

  async init() {
    for (const s of this.systems) {
      if (s.init) await s.init(this.ctx);
    }
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    const aspect = w / Math.max(h, 1);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.viewmodelCamera.aspect = aspect;
    this.viewmodelCamera.updateProjectionMatrix();
    this.bus.emit('engine:resize', { width: w, height: h });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.last = performance.now();
    this.frameErrors = [];
    const loop = (now) => {
      if (!this.running) return;
      // Reschedule FIRST. If _frame throws, an exception escaping this
      // callback would otherwise skip the next requestAnimationFrame and
      // permanently kill the loop -- one bad system bricking the whole game
      // with no visible cause beyond a frozen image.
      this._raf = requestAnimationFrame(loop);
      try {
        this._frame(now);
      } catch (err) {
        this._reportFrameError(err);
      }
    };
    this._raf = requestAnimationFrame(loop);
  }

  /** Log each distinct frame error once; a per-frame throw would flood. */
  _reportFrameError(err) {
    const key = String(err?.stack || err).split('\n').slice(0, 3).join('|');
    if (this._seenErrors ??= new Set(), this._seenErrors.has(key)) return;
    this._seenErrors.add(key);
    this.frameErrors.push(String(err?.stack || err));
    console.error('[Engine] frame error (loop continues):', err);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  _frame(now) {
    const c = this.clock;
    // Clamp so a tab-out or a slow first frame can't spiral the accumulator.
    let dt = Math.min((now - c.last) / 1000, 0.25);
    c.last = now;
    c.dt = dt;
    c.elapsed += dt;
    c.frame++;

    this._fpsAccum += dt; this._fpsFrames++;
    if (this._fpsAccum >= 0.5) {
      c.fps = this._fpsFrames / this._fpsAccum;
      this._fpsAccum = 0; this._fpsFrames = 0;
    }

    const step = this.cfg.time.fixedStep;
    c.accumulator += dt;
    let steps = 0;
    const ctx = this.ctx;
    while (c.accumulator >= step && steps < this.cfg.time.maxSubSteps) {
      for (const s of this.systems) s.fixedUpdate?.(step, ctx);
      c.accumulator -= step;
      steps++;
    }
    if (steps >= this.cfg.time.maxSubSteps) c.accumulator = 0;

    // alpha lets renderers interpolate between the last two physics states.
    const alpha = c.accumulator / step;
    for (const s of this.systems) s.update?.(dt, alpha, ctx);

    this.renderer.info.reset();
    const post = this.get('postfx');
    if (post?.render) {
      post.render(ctx);
    } else {
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.viewmodelScene, this.viewmodelCamera);
      this.renderer.autoClear = true;
    }
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    for (const s of this.systems) s.dispose?.();
    this.renderer.dispose();
  }
}

export default Engine;
