import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

import CFG from '../core/Config.js';
import { makeRNG } from '../core/Rand.js';
import Sky from './Sky.js';
import LightingRig from './Lighting.js';
import {
  SSAOShader, AOBlurShader, AerialShader,
  MotionBlurShader, GradeShader, FinishShader,
} from './PostShaders.js';

/**
 * PostFX — owns the entire frame.
 *
 * `Engine._frame` hands rendering over to this system wholesale when it
 * exposes `render()`, so this file is responsible for the world pass, the
 * viewmodel pass, and everything in between.
 *
 * Chain (all linear HDR until OutputPass):
 *
 *   world  -> rtScene (RGBA16F + DepthTexture)
 *   [SSAO, half res]  -> [bilateral blur H] -> [bilateral blur V]
 *   1. aerial   AO apply + height fog with sky-cube inscatter
 *   2. motion   camera reprojection blur
 *   3. viewmodel  depth cleared, gun composited (no world fog / AO / smear)
 *   4. bloom    UnrealBloom on an HDR threshold
 *   5. grade    contrast / lift-gamma-gain / saturation / split tone   [linear]
 *   6. output   ACES tonemap + sRGB transfer                          <- boundary
 *   7. SMAA     edge AA on display-referred data (what the port expects)
 *   8. finish   chromatic aberration, unsharp, vignette, film grain   [sRGB]
 *
 * Colour management: the scene and every intermediate target are HalfFloat and
 * three only injects tonemapping/sRGB when rendering to the default
 * framebuffer, so nothing is encoded twice. `OutputPass` is the single place
 * the image becomes display-referred, and the passes after it are custom
 * ShaderMaterials which never include `<colorspace_fragment>`.
 */

const _viewProj = new THREE.Matrix4();
const _invViewProj = new THREE.Matrix4();
const _size = new THREE.Vector2();
const _dbSize = new THREE.Vector2();
const _sunV3 = new THREE.Vector3();
const _col = new THREE.Color();

/** Renders the weapon on top of the post-processed world with depth cleared. */
class ViewmodelPass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;   // draws straight into the read buffer
  }

  render(renderer, writeBuffer, readBuffer) {
    if (!this.scene || !this.camera) return;
    const target = this.renderToScreen ? null : readBuffer;
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = oldAutoClear;
  }
}

export default class PostFX {
  name = 'postfx';
  priority = 90;

  constructor() {
    this.enabled = true;
    this.composer = null;
    this.sky = null;
    this.lighting = null;
    this._w = 0;
    this._h = 0;
    this._firstFrame = true;
    this._time = 0;
  }

  async init(ctx) {
    const { renderer, scene, camera, viewmodelScene, viewmodelCamera } = ctx;
    const g = (ctx.cfg ?? CFG).gfx ?? {};
    this.g = g;
    this.ctx = ctx;
    this.renderer = renderer;

    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = g.exposure ?? 1.06;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;  // PCFSoft is deprecated in r185

    /* ---------------------------------------------------------- sky ----- */
    this.sky = new Sky({
      cubeSize: g.skyCubeSize ?? 320,
      skyIntensity: g.skyIntensity ?? 13,
      skyScale: g.skyScale ?? 1.0,
      sunAzimuth: g.sunAzimuth ?? 82,
      sunElevation: g.sunElevation ?? 26,
      sunAngularRadius: g.sunAngularRadius ?? 0.013,
      sunDiscIntensity: g.sunDiscIntensity ?? 15,
      sunGlowIntensity: g.sunGlowIntensity ?? 0.5,
      mieCoefficient: g.mieCoefficient ?? 3.2e-6,
      mieDirectionalG: g.mieDirectionalG ?? 0.72,
      cameraHeight: g.skyCameraHeight ?? 60,
      clouds: g.clouds !== false,
      cloudCoverage: g.cloudCoverage ?? 0.60,
      cloudDensity: g.cloudDensity ?? 0.8,
      cloudScale: g.cloudScale ?? 2.6e-4,
      cloudHeight: g.cloudHeight ?? 2600,
      skyDither: g.skyDither ?? 0.0016,
    });

    const envTex = this.sky.build(renderer);
    scene.add(this.sky.mesh);
    scene.background = null;
    scene.fog = null;
    if (viewmodelScene) viewmodelScene.fog = null;
    renderer.setClearColor(0x000000, 1);

    /* ------------------------------------------------------ lighting ---- */
    this.lighting = new LightingRig(g);
    this.lighting.init(scene, camera, viewmodelScene, this.sky);
    this.lighting.applyEnvironment(envTex);

    /* ------------------------------------------------------- targets ---- */
    renderer.getDrawingBufferSize(_dbSize);
    this._w = Math.max(1, _dbSize.x);
    this._h = Math.max(1, _dbSize.y);

    const depthTexture = new THREE.DepthTexture(this._w, this._h);
    depthTexture.format = THREE.DepthFormat;
    depthTexture.type = THREE.UnsignedIntType;
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;

    this.rtScene = new THREE.WebGLRenderTarget(this._w, this._h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      depthTexture,
      generateMipmaps: false,
    });
    this.rtScene.texture.name = 'gfx:sceneHDR';

    this.aoScale = Math.min(1, Math.max(0.25, g.ssaoScale ?? 0.5));
    const aw = Math.max(1, Math.round(this._w * this.aoScale));
    const ah = Math.max(1, Math.round(this._h * this.aoScale));
    const aoOpts = {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    };
    this.rtAO = new THREE.WebGLRenderTarget(aw, ah, aoOpts);
    this.rtAOTmp = new THREE.WebGLRenderTarget(aw, ah, aoOpts);
    this.rtAO.texture.name = 'gfx:ao';

    this._quad = new FullScreenQuad(null);

    /* ---------------------------------------------------- AO material --- */
    this.ssaoMat = new THREE.ShaderMaterial({
      name: SSAOShader.name,
      defines: { ...SSAOShader.defines },
      uniforms: THREE.UniformsUtils.clone(SSAOShader.uniforms),
      vertexShader: SSAOShader.vertexShader,
      fragmentShader: SSAOShader.fragmentShader,
      depthTest: false, depthWrite: false,
    });
    this.ssaoMat.uniforms.tDepth.value = depthTexture;
    this.ssaoMat.uniforms.uKernel.value = this._makeKernel(SSAOShader.defines.KERNEL_SIZE);
    this.ssaoMat.uniforms.uRadius.value = g.ssaoRadius ?? 0.55;
    this.ssaoMat.uniforms.uIntensity.value = g.ssaoIntensity ?? 0.9;
    this.ssaoMat.uniforms.uBias.value = g.ssaoBias ?? 0.025;
    this.ssaoMat.uniforms.uPower.value = g.ssaoPower ?? 1.6;
    this.ssaoMat.uniforms.uMaxDistance.value = g.ssaoMaxDistance ?? 120;

    this.aoBlurMat = new THREE.ShaderMaterial({
      name: AOBlurShader.name,
      uniforms: THREE.UniformsUtils.clone(AOBlurShader.uniforms),
      vertexShader: AOBlurShader.vertexShader,
      fragmentShader: AOBlurShader.fragmentShader,
      depthTest: false, depthWrite: false,
    });
    this.aoBlurMat.uniforms.tDepth.value = depthTexture;

    /* ------------------------------------------------------ composer ---- */
    renderer.getSize(_size);
    this.composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(this._w, this._h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    }));
    this.composer.setPixelRatio(renderer.getPixelRatio());

    // 1. AO apply + aerial perspective. Reads rtScene directly (textureID is
    //    deliberately bogus so ShaderPass does not overwrite tDiffuse).
    this.aerialPass = new ShaderPass(AerialShader, '__src');
    this.aerialPass.material.uniforms.tDiffuse.value = this.rtScene.texture;
    this.aerialPass.material.uniforms.tDepth.value = depthTexture;
    this.aerialPass.material.uniforms.tAO.value = this.rtAO.texture;
    this.aerialPass.material.uniforms.tSky.value = this.sky.cubeTexture;
    this.composer.addPass(this.aerialPass);

    // 2. Camera motion blur.
    this.motionPass = new ShaderPass(MotionBlurShader);
    this.motionPass.material.uniforms.tDepth.value = depthTexture;
    this.motionPass.material.defines.MB_SAMPLES = g.motionBlurSamples ?? 8;
    this.composer.addPass(this.motionPass);

    // 3. Viewmodel on top, depth cleared so the gun never clips into walls.
    this.viewmodelPass = new ViewmodelPass(viewmodelScene, viewmodelCamera);
    this.composer.addPass(this.viewmodelPass);

    // 4. Bloom.
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(this._w, this._h),
      g.bloomStrength ?? 0.42,
      g.bloomRadius ?? 0.55,
      g.bloomThreshold ?? 0.92,
    );
    this.composer.addPass(this.bloomPass);

    // 5. Filmic grade, still linear.
    this.gradePass = new ShaderPass(GradeShader);
    this.composer.addPass(this.gradePass);

    // 6. ACES + sRGB. Everything after this is display-referred.
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    // 7. SMAA. The three.js port linearises internally with pow(2.2), i.e. it
    //    expects gamma-encoded input, so it belongs after OutputPass.
    this.smaaPass = new SMAAPass();
    this.composer.addPass(this.smaaPass);

    // 8. Lens + film finishing.
    this.finishPass = new ShaderPass(FinishShader);
    this.composer.addPass(this.finishPass);

    this._applyConfig();
    this._resize(true);

    this._onResize = () => { this._pendingResize = true; };
    ctx.bus?.on?.('engine:resize', this._onResize);
  }

  /** Deterministic hemisphere kernel — same AO pattern every run. */
  _makeKernel(n) {
    const rng = makeRNG(0x5EED ^ n);
    const out = [];
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3(rng() * 2 - 1, rng() * 2 - 1, rng() * 0.92 + 0.08);
      v.normalize();
      let s = (i + 1) / n;
      s = 0.12 + 0.88 * s * s;   // bias samples towards the origin
      v.multiplyScalar(s);
      out.push(v);
    }
    return out;
  }

  /** Toggle passes + push CFG values into uniforms. Cheap; safe to re-run. */
  _applyConfig() {
    const g = this.g;

    const on = (k, d) => (g[k] === undefined ? d : !!g[k]);
    this.useSSAO = on('ssao', true) && (g.ssaoIntensity ?? 0.9) > 0;
    this.useAerial = on('aerialPerspective', true);
    this.useMotion = on('motionBlur', true) && (g.motionBlurStrength ?? 0.42) > 0;
    this.useBloom = on('bloom', true) && (g.bloomStrength ?? 0.42) > 0;
    this.useGrade = on('colorGrade', true);
    this.useSMAA = (g.antialias ?? 'smaa') !== 'none' && on('smaa', true);

    // Aerial pass defines
    const am = this.aerialPass.material;
    const wantAO = this.useSSAO ? '' : undefined;
    const wantAP = this.useAerial ? '' : undefined;
    let dirty = false;
    if ((am.defines.USE_AO !== undefined) !== this.useSSAO) {
      if (this.useSSAO) am.defines.USE_AO = wantAO; else delete am.defines.USE_AO;
      dirty = true;
    }
    if ((am.defines.USE_AERIAL !== undefined) !== this.useAerial) {
      if (this.useAerial) am.defines.USE_AERIAL = wantAP; else delete am.defines.USE_AERIAL;
      dirty = true;
    }
    if (dirty) am.needsUpdate = true;
    this.aerialPass.enabled = true;   // always on: it is the blit from rtScene

    const au = am.uniforms;
    au.uFogDensity.value = g.fogDensity ?? 0.0021;
    au.uFogFalloff.value = g.fogHeightFalloff ?? 0.011;
    au.uFogBase.value = g.fogBaseHeight ?? 0;
    au.uFogMax.value = g.fogMax ?? 0.90;
    au.uFogInscatter.value = g.fogInscatter ?? 0.85;
    au.uSunScatter.value = g.fogSunScatter ?? 0.15;
    const aoc = g.aoColor ?? [0.40, 0.47, 0.62];
    au.uAOColor.value.set(aoc[0], aoc[1], aoc[2]);

    // Motion blur
    this.motionPass.enabled = this.useMotion;
    this.motionPass.material.uniforms.uStrength.value = g.motionBlurStrength ?? 0.42;
    this.motionPass.material.uniforms.uMaxBlur.value = g.motionBlurMax ?? 0.035;

    // Bloom
    this.bloomPass.enabled = this.useBloom;
    this.bloomPass.strength = g.bloomStrength ?? 0.42;
    this.bloomPass.radius = g.bloomRadius ?? 0.55;
    this.bloomPass.threshold = g.bloomThreshold ?? 0.92;

    // Grade
    this.gradePass.enabled = this.useGrade;
    const gu = this.gradePass.material.uniforms;
    const v3 = (key, def) => {
      const a = g[key];
      return Array.isArray(a) && a.length === 3 ? a : def;
    };
    gu.uContrast.value = g.gradeContrast ?? 1.22;
    gu.uSaturation.value = g.gradeSaturation ?? 1.24;
    gu.uExposureComp.value = g.gradeExposure ?? 0.94;
    let a = v3('gradeWhiteBalance', [1.02, 1.0, 0.975]); gu.uWhiteBalance.value.set(a[0], a[1], a[2]);
    a = v3('gradeLift', [0.0018, 0.0022, 0.0048]); gu.uLift.value.set(a[0], a[1], a[2]);
    a = v3('gradeGain', [1.0, 1.0, 1.0]); gu.uGain.value.set(a[0], a[1], a[2]);
    a = v3('gradeGamma', [1.0, 1.0, 1.0]); gu.uGamma.value.set(a[0], a[1], a[2]);
    a = v3('gradeShadowTint', [0.90, 0.985, 1.13]); gu.uShadowTint.value.set(a[0], a[1], a[2]);
    a = v3('gradeHighlightTint', [1.07, 1.005, 0.925]); gu.uHighlightTint.value.set(a[0], a[1], a[2]);
    gu.uSplitPivot.value = g.gradeSplitPivot ?? 0.16;
    gu.uSplitSoft.value = g.gradeSplitSoftness ?? 0.20;

    this.smaaPass.enabled = this.useSMAA;

    // Finishing
    const fm = this.finishPass.material;
    const fu = fm.uniforms;
    fu.uCA.value = g.chromaticAberration ?? 0.0016;
    fu.uVignette.value = g.vignette ?? 0.32;
    fu.uVignetteSoft.value = g.vignetteSoftness ?? 0.42;
    fu.uGrain.value = g.filmGrain ?? 0.022;
    fu.uSharpen.value = g.sharpen ?? 0.18;

    const flag = (name, want) => {
      const has = fm.defines[name] !== undefined;
      if (has === want) return false;
      if (want) fm.defines[name] = ''; else delete fm.defines[name];
      return true;
    };
    let fdirty = false;
    fdirty = flag('USE_CA', fu.uCA.value > 0) || fdirty;
    fdirty = flag('USE_SHARPEN', fu.uSharpen.value > 0) || fdirty;
    fdirty = flag('USE_VIGNETTE', fu.uVignette.value > 0) || fdirty;
    fdirty = flag('USE_GRAIN', fu.uGrain.value > 0) || fdirty;
    if (fdirty) fm.needsUpdate = true;
    this.finishPass.enabled = fu.uCA.value > 0 || fu.uSharpen.value > 0 ||
                              fu.uVignette.value > 0 || fu.uGrain.value > 0;
  }

  _resize(force = false) {
    const renderer = this.renderer;
    renderer.getDrawingBufferSize(_dbSize);
    const w = Math.max(1, _dbSize.x), h = Math.max(1, _dbSize.y);
    if (!force && w === this._w && h === this._h) return;
    this._w = w; this._h = h;

    // RenderTarget.setSize only resizes colour attachments; an attached
    // DepthTexture keeps its old dimensions and the FBO goes incomplete.
    const dt = this.rtScene.depthTexture;
    if (dt && dt.image) {
      dt.image.width = w;
      dt.image.height = h;
      dt.needsUpdate = true;
    }
    this.rtScene.setSize(w, h);
    const aw = Math.max(1, Math.round(w * this.aoScale));
    const ah = Math.max(1, Math.round(h * this.aoScale));
    this.rtAO.setSize(aw, ah);
    this.rtAOTmp.setSize(aw, ah);

    renderer.getSize(_size);
    this.composer.setSize(_size.x, _size.y);

    this.ssaoMat.uniforms.uResolution.value.set(aw, ah);
    this.aoBlurMat.uniforms.uTexel.value.set(1 / aw, 1 / ah);
    this.motionPass.material.uniforms.uResolution.value.set(w, h);
    this.finishPass.material.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.finishPass.material.uniforms.uResolution.value.set(w, h);
  }

  /* --------------------------------------------------------------------- */

  update(dt, alpha, ctx) {
    this._time += dt;
    this.lighting?.update(dt);
  }

  /**
   * Engine hands the whole frame to us. Both scenes are drawn here.
   * @param {object} ctx
   */
  render(ctx) {
    const { renderer, scene, camera } = ctx;
    const dt = Math.max(ctx.clock?.dt ?? 1 / 60, 1e-4);

    if (this._pendingResize) { this._pendingResize = false; this._resize(); }
    else this._resize();

    camera.updateMatrixWorld();
    if (ctx.viewmodelCamera) ctx.viewmodelCamera.updateMatrixWorld();

    // Another system may have re-asserted a flat background/fog; ours wins.
    if (scene.background !== null) scene.background = null;
    if (scene.fog !== null && this.useAerial) scene.fog = null;

    /* ---- shared per-frame matrices -------------------------------------- */
    _viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _invViewProj.copy(_viewProj).invert();

    const au = this.aerialPass.material.uniforms;
    au.uInvViewProj.value.copy(_invViewProj);
    au.uCameraPos.value.setFromMatrixPosition(camera.matrixWorld);
    _sunV3.copy(this.sky.sunDirection);
    au.uSunDir.value.copy(_sunV3);
    _col.copy(this.sky.sunColor);
    au.uSunColor.value.set(_col.r, _col.g, _col.b);

    const mu = this.motionPass.material.uniforms;
    mu.uInvViewProj.value.copy(_invViewProj);
    if (this._firstFrame) mu.uPrevViewProj.value.copy(_viewProj);
    // Long frames (shader warm-up, tab-out) would otherwise smear the whole
    // screen; scale the reprojection towards a nominal 60 Hz step.
    mu.uDtScale.value = Math.min(1, (1 / 60) / dt);

    this.finishPass.material.uniforms.uTime.value = this._time;

    /* ---- 0. world ------------------------------------------------------- */
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    renderer.setRenderTarget(this.rtScene);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);

    /* ---- 1. ambient occlusion ------------------------------------------ */
    if (this.useSSAO) {
      const su = this.ssaoMat.uniforms;
      su.uProjection.value.copy(camera.projectionMatrix);
      su.uInvProjection.value.copy(camera.projectionMatrixInverse);
      this.aoBlurMat.uniforms.uInvProjection.value.copy(camera.projectionMatrixInverse);

      renderer.autoClear = false;
      this._quad.material = this.ssaoMat;
      renderer.setRenderTarget(this.rtAO);
      this._quad.render(renderer);

      this._quad.material = this.aoBlurMat;
      this.aoBlurMat.uniforms.tDiffuse.value = this.rtAO.texture;
      this.aoBlurMat.uniforms.uDirection.value.set(1, 0);
      renderer.setRenderTarget(this.rtAOTmp);
      this._quad.render(renderer);

      this.aoBlurMat.uniforms.tDiffuse.value = this.rtAOTmp.texture;
      this.aoBlurMat.uniforms.uDirection.value.set(0, 1);
      renderer.setRenderTarget(this.rtAO);
      this._quad.render(renderer);
    }

    /* ---- 2..8. post chain ---------------------------------------------- */
    renderer.autoClear = false;
    this.composer.render(dt);
    renderer.autoClear = oldAutoClear;
    renderer.setRenderTarget(null);

    mu.uPrevViewProj.value.copy(_viewProj);
    this._firstFrame = false;
  }

  /* ------------------------------------------------------------ public -- */

  /** Move the sun; rebakes the sky cube + IBL. Not per-frame cheap. */
  setSun(azimuthDeg, elevationDeg) {
    this.sky.setSunFromAngles(azimuthDeg, elevationDeg);
    const env = this.sky.build(this.renderer);
    this.lighting.applySun();
    this.lighting.applyEnvironment(env);
    this.aerialPass.material.uniforms.tSky.value = this.sky.cubeTexture;
  }

  /** Re-read CFG.gfx after a live tweak. */
  refresh() { this._applyConfig(); }

  dispose() {
    this.ctx?.bus?.off?.('engine:resize', this._onResize);
    this.lighting?.dispose();
    this.sky?.mesh?.parent?.remove(this.sky.mesh);
    this.sky?.dispose();
    this.rtScene?.dispose();
    this.rtAO?.dispose();
    this.rtAOTmp?.dispose();
    this.ssaoMat?.dispose();
    this.aoBlurMat?.dispose();
    this._quad?.dispose();
    if (this.composer) {
      for (const p of this.composer.passes) p.dispose?.();
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
    }
  }
}
