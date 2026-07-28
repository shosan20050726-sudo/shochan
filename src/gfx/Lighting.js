import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';

/**
 * The lighting rig: one sun, cascaded shadow maps, image-based ambient.
 *
 * Cascades come from the stock `three/addons/csm` implementation, driven by
 * `CFG.gfx.cascadeCount` / `cascadeSplits` / `shadowDistance`, with three
 * hardening changes on top:
 *
 *  - `setupMaterial` is *chained* rather than clobbering `onBeforeCompile`, so
 *    another agent's material patch and CSM can coexist. A periodic sweep
 *    re-applies the chain if somebody overwrote it (which would otherwise
 *    silently kill all directional light in the scene).
 *  - Per-cascade `normalBias` is derived from the cascade's texel world size
 *    each frame. A single global bias cannot be right for a 13 m cascade and a
 *    220 m cascade at once — that is where acne / peter-panning come from.
 *  - Foreign directional / hemisphere / ambient lights are suppressed. Two
 *    shadow-casting directional lights plus CSM would index the cascade array
 *    out of bounds, and double ambient is what makes a scene look washed out.
 *
 * Ambient is a PMREM of the procedural sky (see Sky.js) on `scene.environment`,
 * so rough metal picks up the sky gradient and polished metal picks up the sun
 * side of it. No env map is the single most obvious "amateur" tell there is.
 */

const LIT_TYPES = [
  'isMeshStandardMaterial', 'isMeshPhysicalMaterial',
  'isMeshLambertMaterial', 'isMeshPhongMaterial', 'isMeshToonMaterial',
];

function isLitMaterial(m) {
  for (let i = 0; i < LIT_TYPES.length; i++) if (m[LIT_TYPES[i]]) return true;
  return false;
}

export default class LightingRig {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.csm = null;
    this.sunLight = null;         // convenience handle: cascade 0
    this.bounce = null;
    this.viewmodelLights = [];
    this._suppressed = [];
    this._scanTimer = 0;
    this._lastFov = -1;
    this._lastAspect = -1;
    this._lastNear = -1;
    this._lastFar = -1;
    this._enabled = true;
  }

  /**
   * @param {THREE.Scene} scene world scene
   * @param {THREE.PerspectiveCamera} camera world camera
   * @param {Sky} sky provides sun direction + colour
   */
  init(scene, camera, viewmodelScene, sky) {
    this.scene = scene;
    this.camera = camera;
    this.viewmodelScene = viewmodelScene;
    this.sky = sky;

    const g = this.cfg;
    const cascades = Math.max(1, Math.min(4, g.cascadeCount ?? 3));
    const splits = Array.isArray(g.cascadeSplits) && g.cascadeSplits.length === cascades
      ? g.cascadeSplits.slice()
      : null;
    const shadowDistance = g.shadowDistance ?? 220;
    const mapSize = g.shadowMapSize ?? 2048;
    const lightMargin = g.shadowLightMargin ?? 180;

    this.shadowMapSize = mapSize;
    this.shadowDistance = shadowDistance;

    this.csm = new CSM({
      camera,
      parent: scene,
      cascades,
      maxFar: shadowDistance,
      mode: splits ? 'custom' : 'practical',
      customSplitsCallback: splits
        ? (amount, near, far, target) => { for (let i = 0; i < amount; i++) target.push(splits[i]); }
        : undefined,
      shadowMapSize: mapSize,
      shadowBias: g.shadowBias ?? -0.00006,
      lightIntensity: g.sunIntensity ?? 6.4,
      lightDirection: sky.sunDirection.clone().multiplyScalar(-1).normalize(),
      lightNear: 1,
      lightFar: lightMargin * 2 + shadowDistance + 120,
      lightMargin,
    });
    this.csm.fade = g.cascadeFade !== false;
    this.csm.updateFrustums();

    for (const l of this.csm.lights) {
      l.userData.__gfx = true;
      l.target.userData.__gfx = true;
      l.name = 'gfx:sun';
      l.shadow.normalBias = 0.02;
      l.shadow.camera.updateProjectionMatrix();
    }
    this.sunLight = this.csm.lights[0];

    // Sky bounce: a very dim inverted-sun fill so surfaces facing away from
    // the sun still have a direction to their shading instead of going flat.
    this.bounce = new THREE.DirectionalLight(0xffffff, 0);
    this.bounce.userData.__gfx = true;
    this.bounce.name = 'gfx:bounce';
    this.bounce.castShadow = false;
    scene.add(this.bounce);
    scene.add(this.bounce.target);

    this._buildViewmodelLights();
    this.applySun();
    this.sweep(true);
  }

  _buildViewmodelLights() {
    const vs = this.viewmodelScene;
    if (!vs) return;
    const g = this.cfg;
    const base = g.sunIntensity ?? 6.4;
    const mk = (name, intensity, color) => {
      const l = new THREE.DirectionalLight(color, intensity);
      l.castShadow = false;
      l.userData.__gfx = true;
      l.name = name;
      vs.add(l);
      vs.add(l.target);
      this.viewmodelLights.push(l);
      return l;
    };
    // Classic three-point rig so the weapon has readable form even when the
    // world sun is behind the player.
    this.vmKey = mk('gfx:vm-key', base * (g.viewmodelKey ?? 0.85), 0xffffff);
    this.vmFill = mk('gfx:vm-fill', base * (g.viewmodelFill ?? 0.16), 0x9fc4ee);
    this.vmRim = mk('gfx:vm-rim', base * (g.viewmodelRim ?? 0.45), 0xffe6c4);
  }

  /** Push the current sun direction/colour into every light + shadow camera. */
  applySun() {
    if (!this.csm) return;
    const g = this.cfg;
    const sun = this.sky.sunDirection;
    const intensity = g.sunIntensity ?? 6.4;

    this.csm.lightDirection.copy(sun).multiplyScalar(-1).normalize();
    for (const l of this.csm.lights) {
      l.color.copy(this.sky.sunColor);
      l.intensity = intensity;
    }

    // Bounce comes from below/behind the sun, tinted by the ground.
    const b = this.bounce;
    if (b) {
      b.position.set(-sun.x * 60, Math.max(-sun.y, 0.25) * 60 - 40, -sun.z * 60);
      b.target.position.set(0, 0, 0);
      b.color.setRGB(0.62, 0.53, 0.40, THREE.LinearSRGBColorSpace);
      b.intensity = intensity * (g.bounceIntensity ?? 0.18);
    }

    if (this.vmKey) {
      this.vmKey.position.copy(sun).multiplyScalar(10);
      this.vmKey.target.position.set(0, 0, 0);
      this.vmKey.color.copy(this.sky.sunColor);
      this.vmFill.position.set(-sun.x * 6 - 3, 4, -sun.z * 6 + 4);
      this.vmFill.target.position.set(0, 0, 0);
      this.vmRim.position.set(-sun.x * 8, 3, -sun.z * 8 - 9);
      this.vmRim.target.position.set(0, 0, 0);
    }
  }

  /** Environment map from the sky PMREM. */
  applyEnvironment(envTexture) {
    const g = this.cfg;
    const intensity = g.envIntensity ?? 1.25;
    this._envTexture = envTexture;
    this._envIntensity = intensity;
    if (this.scene) {
      this.scene.environment = envTexture;
      this.scene.environmentIntensity = intensity;
    }
    if (this.viewmodelScene) {
      this.viewmodelScene.environment = envTexture;
      this.viewmodelScene.environmentIntensity = intensity * (g.viewmodelEnvIntensity ?? 0.9);
    }
  }

  /**
   * Periodic maintenance: adopt materials created after init, suppress lights
   * added by other systems, repair a clobbered CSM patch.
   */
  sweep(force = false) {
    const scene = this.scene;
    if (!scene) return;

    // Another system may install its own probe; the sky PMREM wins so the
    // ambient always agrees with the sky that is actually being drawn.
    if (this._envTexture && scene.environment !== this._envTexture) {
      this.applyEnvironment(this._envTexture);
    }

    // Suppress foreign global lights (point/spot are left alone — muzzle
    // flashes and ability FX rely on them).
    scene.traverse((o) => {
      if (o.isLight && !o.userData.__gfx) {
        if (o.isDirectionalLight || o.isHemisphereLight || o.isAmbientLight) {
          if (o.visible || o.castShadow) {
            this._suppressed.push({ light: o, visible: o.visible, castShadow: o.castShadow });
          }
          o.visible = false;
          o.castShadow = false;
        }
        return;
      }
      const m = o.material;
      if (!m) return;
      if (Array.isArray(m)) { for (let i = 0; i < m.length; i++) this._adopt(m[i]); }
      else this._adopt(m);
    });

    // A shadow-casting light inside the viewmodel scene would make the CSM
    // branch take over there and black the weapon out.
    if (this.viewmodelScene) {
      this.viewmodelScene.traverse((o) => {
        if (o.isDirectionalLight && !o.userData.__gfx) o.castShadow = false;
      });
    }
  }

  _adopt(m) {
    if (!m || !isLitMaterial(m)) return;
    if (m.userData.__gfxSkip) return;
    if (m.userData.__csmChain === m.onBeforeCompile && m.defines && m.defines.USE_CSM) return;
    this._patchMaterial(m);
  }

  _patchMaterial(mat) {
    const csm = this.csm;
    if (!csm) return;

    // Preserve whatever hook was already installed by another system.
    const existing = mat.onBeforeCompile;
    if (existing && existing !== mat.userData.__csmChain) mat.userData.__csmPrev = existing;

    csm.setupMaterial(mat);
    const csmHook = mat.onBeforeCompile;
    const chain = function (shader, renderer) {
      csmHook.call(this, shader, renderer);
      const prev = mat.userData.__csmPrev;
      if (prev) prev.call(this, shader, renderer);
    };
    mat.onBeforeCompile = chain;
    mat.userData.__csmChain = chain;

    // A material that defines a custom program cache key must fold the CSM
    // state into it. three.js uses that key to decide whether two materials
    // can share one compiled program, so a key that ignores the cascade
    // defines lets a pre-CSM program be reused for a CSM-patched material.
    // The cascade uniforms then do not match the shader actually running,
    // which shows up as broad mis-shadowed bands on exactly the surfaces
    // that set a constant key (the terrain splat, the surface patches).
    if (!mat.userData.__csmKeyWrapped) {
      const prevKey = mat.customProgramCacheKey;
      const sig = `csm${csm.cascades}:${csm.fade ? 1 : 0}`;
      mat.customProgramCacheKey = function () {
        const base = typeof prevKey === 'function' ? prevKey.call(this) : '';
        return `${base}|${sig}`;
      };
      mat.userData.__csmKeyWrapped = true;
    }

    mat.needsUpdate = true;
  }

  /** Per-frame. Call before rendering the world. */
  update(dt) {
    if (!this.csm) return;
    const cam = this.camera;

    // The screenshot harness (and ADS) changes fov; cascades must refit or the
    // near cascade will not cover what the player can actually see.
    if (cam.fov !== this._lastFov || cam.aspect !== this._lastAspect ||
        cam.near !== this._lastNear || cam.far !== this._lastFar) {
      this._lastFov = cam.fov; this._lastAspect = cam.aspect;
      this._lastNear = cam.near; this._lastFar = cam.far;
      this.csm.updateFrustums();
    }

    this.csm.update();

    // Cascade-relative bias. texel = ortho width / map size; a normal offset of
    // ~1.5 texels kills acne without floating contact shadows off the ground.
    const mapSize = this.shadowMapSize;
    for (let i = 0; i < this.csm.lights.length; i++) {
      const l = this.csm.lights[i];
      const sc = l.shadow.camera;
      const texel = (sc.right - sc.left) / mapSize;
      l.shadow.normalBias = Math.min(Math.max(texel * 2.2, 0.010), 1.2);
      l.shadow.bias = (this.cfg.shadowBias ?? -0.00006);
      // PCF kernel width in texels. Widest on the near cascade (where texels
      // are tiny) so contact shadows get a believable penumbra instead of a
      // hard stair-stepped edge; tightened further out to limit bleed.
      l.shadow.radius = (this.cfg.shadowRadius ?? 3.0) / (i + 1);
    }

    this._scanTimer -= dt;
    if (this._scanTimer <= 0) {
      this._scanTimer = this.cfg.lightSweepInterval ?? 1.0;
      this.sweep();
    }
  }

  dispose() {
    for (const s of this._suppressed) {
      s.light.visible = s.visible;
      s.light.castShadow = s.castShadow;
    }
    this._suppressed.length = 0;
    if (this.csm) { this.csm.dispose(); this.csm.remove(); this.csm = null; }
    if (this.bounce) {
      this.bounce.parent?.remove(this.bounce);
      this.bounce.target.parent?.remove(this.bounce.target);
    }
    for (const l of this.viewmodelLights) {
      l.parent?.remove(l);
      l.target.parent?.remove(l.target);
    }
    this.viewmodelLights.length = 0;
  }
}
