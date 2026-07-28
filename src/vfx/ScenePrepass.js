import * as THREE from 'three';

/**
 * Half-resolution colour + depth capture of the world *without* any VFX in it.
 *
 * Two things need it and neither can read the main framebuffer while the world
 * pass is writing to it:
 *   - soft particles need scene depth so smoke feathers into geometry instead
 *     of cutting a razor line across it;
 *   - heat shimmer needs scene colour to refract.
 *
 * One extra scene render at 0.5x with shadow updates frozen buys both. It runs
 * from VFXSystem.update(), which is after the camera has been driven for the
 * frame and before PostFX takes over rendering, so the capture matches the
 * frame it will be composited into exactly.
 */
export default class ScenePrepass {
  constructor(scale = 0.5) {
    this.scale = scale;
    this.rt = null;
    this.ok = false;
    this.w = 0;
    this.h = 0;
    this._size = new THREE.Vector2();
  }

  init(renderer) {
    try {
      renderer.getDrawingBufferSize(this._size);
      this.w = Math.max(2, Math.round(this._size.x * this.scale));
      this.h = Math.max(2, Math.round(this._size.y * this.scale));

      const depth = new THREE.DepthTexture(this.w, this.h);
      depth.format = THREE.DepthFormat;
      depth.type = THREE.UnsignedIntType;
      depth.minFilter = THREE.NearestFilter;
      depth.magFilter = THREE.NearestFilter;

      this.rt = new THREE.WebGLRenderTarget(this.w, this.h, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
        stencilBuffer: false,
        depthTexture: depth,
        generateMipmaps: false,
      });
      this.rt.texture.name = 'vfx:prepassColor';
      this.ok = true;
    } catch (err) {
      console.warn('[vfx] scene prepass unavailable, soft particles disabled', err);
      this.ok = false;
    }
    return this.ok;
  }

  get depthTexture() { return this.ok ? this.rt.depthTexture : null; }
  get colorTexture() { return this.ok ? this.rt.texture : null; }

  _resize(renderer) {
    renderer.getDrawingBufferSize(this._size);
    const w = Math.max(2, Math.round(this._size.x * this.scale));
    const h = Math.max(2, Math.round(this._size.y * this.scale));
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    const dt = this.rt.depthTexture;
    if (dt && dt.image) { dt.image.width = w; dt.image.height = h; dt.needsUpdate = true; }
    this.rt.setSize(w, h);
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {THREE.Object3D} hide root group to exclude from the capture
   */
  render(renderer, scene, camera, hide) {
    if (!this.ok) return;
    this._resize(renderer);

    const wasVisible = hide ? hide.visible : false;
    if (hide) hide.visible = false;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;

    try {
      // Shadow maps were rendered for the previous frame and are re-rendered
      // by the main pass anyway; re-running the cascade here would double the
      // cost for a capture that never samples anything shadow-critical.
      renderer.shadowMap.autoUpdate = false;
      renderer.autoClear = true;
      renderer.setRenderTarget(this.rt);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
    } catch (err) {
      console.warn('[vfx] prepass render failed, disabling', err);
      this.ok = false;
    } finally {
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
      if (hide) hide.visible = wasVisible;
    }
  }

  dispose() {
    this.rt?.depthTexture?.dispose();
    this.rt?.dispose();
    this.rt = null;
    this.ok = false;
  }
}
