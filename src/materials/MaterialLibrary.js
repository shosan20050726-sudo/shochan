import * as THREE from 'three';
import CFG from '../core/Config.js';
import TextureForge from './TextureForge.js';
import { SURFACE_GLSL, DETAIL_GLSL } from './glsl/surfaces.glsl.js';
import SURFACE_DEFS from './SurfaceDefs.js';
import { installSurfaceShader } from './ShaderPatches.js';
import { buildEnvironment } from './EnvProbe.js';

/**
 * STABLE PUBLIC API — every other system codes against this.
 *
 *   await Materials.init(renderer)
 *   Materials.get(surface, opts) -> THREE.Material   (cached, shared)
 *   Materials.SURFACES           -> string[]
 *   Materials.surfaceOf(object)  -> string
 *
 * opts: { scale=1, color?, roughness?, metalness?, triplanar=false, emissive? }
 *
 * Additive extras (safe to ignore — nothing below changes the four calls above):
 *   Materials.update(dt)            animate water etc; optional, call from any system
 *   Materials.getTextures(surface)  { albedo, normal, orm } shared THREE.Textures
 *   Materials.detailMap             shared micro-detail texture
 *   Materials.progress              0..1 while init() is forging textures
 *   Materials.ready                 boolean
 *   opts.repeat  [x,y]              non-uniform tiling (overrides scale)
 *   opts.triScale                   triplanar repeats per metre
 *   opts.normalScale, opts.aoIntensity, opts.side, opts.transparent,
 *   opts.opacity, opts.emissiveIntensity, opts.flatShading, opts.depthWrite,
 *   opts.detail { scale, strength, selfScale, selfStrength, fadeStart, fadeEnd }
 *
 * IMPLEMENTATION NOTES
 * - Every texture is rendered on the GPU at init (TextureForge). No files,
 *   no network, no CPU pixel loops.
 * - Normals come from a real sobel over the generated height field.
 * - Colour spaces: albedo is SRGBColorSpace, normal/ORM are NoColorSpace.
 * - AO/roughness/metalness share one glTF-packed ORM texture.
 * - Tiling lives in a shader uniform, not Texture.repeat, so every material
 *   variant of a surface shares the identical Texture objects.
 */
export const SURFACES = [
  'concrete', 'metal', 'painted_metal', 'sand', 'rock',
  'glass', 'wood', 'grass', 'water', 'flesh', 'rubber', 'plastic',
];

/** Baseline physical values. Kept identical to the placeholder on purpose. */
const BASE = {};
for (const s of SURFACES) {
  const d = SURFACE_DEFS[s];
  BASE[s] = {
    color: d.color, roughness: d.roughness, metalness: d.metalness,
    transparent: d.transparent, opacity: d.opacity,
  };
}

/** Surfaces whose metalness genuinely varies across the map. */
const METAL_MAPPED = new Set(['metal', 'painted_metal']);

const _tmpColor = new THREE.Color();

class MaterialLibraryImpl {
  constructor() {
    this.cache = new Map();
    this.textures = new Map();      // surface -> { albedo, normal, orm }
    this.renderer = null;
    this.ready = false;
    this.progress = 0;
    this.detailMap = null;
    this.maxAniso = 1;
    this.forge = null;
    this._initPromise = null;
    this._animated = [];
    this._elapsed = 0;
  }

  get SURFACES() { return SURFACES; }
  get SURFACE_DEFS() { return SURFACE_DEFS; }

  /** Idempotent: several systems may each call init(renderer). */
  init(renderer) {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._init(renderer);
    return this._initPromise;
  }

  async _init(renderer) {
    this.renderer = renderer;
    this.maxAniso = renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;
    if (!renderer) { this.ready = true; return; }

    const baseSize = CFG.materials?.textureSize ?? 1024;
    this.forge = new TextureForge(renderer);

    // Shared high-frequency detail source used by every surface.
    const detailSize = CFG.materials?.detailSize ?? 512;
    const detail = this.forge.build(DETAIL_GLSL, {
      size: detailSize, seed: 7.0, normalStrength: 1.0, normalOnly: true,
    });
    this.detailMap = detail.normal;

    const list = SURFACES;
    for (let i = 0; i < list.length; i++) {
      const name = list[i];
      const def = SURFACE_DEFS[name];
      const size = Math.max(256, Math.round(baseSize * (def.res ?? 1)));
      const set = this.forge.build(SURFACE_GLSL[name], {
        size,
        seed: def.seed,
        normalStrength: def.normalStrength ?? 1,
        aoRadius: def.aoRadius ?? 3,
        aoStrength: def.aoStrength ?? 2.4,
        curvGain: def.curvGain ?? 3,
      });
      this.textures.set(name, set);
      this.progress = (i + 1) / list.length;
      // Yield so the boot screen can paint and the tab stays responsive.
      await new Promise((r) => setTimeout(r, 0));
    }

    this.forge.releaseScratch();
    this.ready = true;
  }

  _key(surface, o) {
    return `${surface}|${o.scale ?? 1}|${o.color ?? ''}|${o.roughness ?? ''}|${o.metalness ?? ''}|${o.triplanar ? 1 : 0}|${o.emissive ?? ''}`
      + `|${o.repeat ? o.repeat.join(',') : ''}|${o.triScale ?? ''}|${o.normalScale ?? ''}`
      + `|${o.side ?? ''}|${o.transparent ?? ''}|${o.opacity ?? ''}|${o.flatShading ? 1 : 0}`;
  }

  /** @returns {THREE.MeshStandardMaterial} shared, cached — do not mutate. */
  get(surface, opts = {}) {
    const key = this._key(surface, opts);
    const hit = this.cache.get(key);
    if (hit) return hit;

    const name = SURFACE_DEFS[surface] ? surface : 'concrete';
    const def = SURFACE_DEFS[name];
    const tex = this.textures.get(name) || null;

    const usePhysical = !!def.physical;
    const params = {
      color: 0xffffff,      // tint is applied through the baked mask instead
      transparent: opts.transparent ?? def.transparent ?? false,
      opacity: opts.opacity ?? def.opacity ?? 1,
      side: opts.side ?? def.side ?? THREE.FrontSide,
      flatShading: !!opts.flatShading,
    };
    if (opts.depthWrite !== undefined) params.depthWrite = opts.depthWrite;

    // roughness / metalness uniforms scale the baked absolute maps
    if (tex) {
      params.map = tex.albedo;
      params.normalMap = tex.normal;
      params.roughnessMap = tex.orm;
      params.aoMap = tex.orm;
      const ns = opts.normalScale ?? def.normalScale ?? 1;
      params.normalScale = new THREE.Vector2(ns, ns);
      params.aoMapIntensity = opts.aoIntensity ?? def.aoIntensity ?? 1;
      params.roughness = opts.roughness != null
        ? THREE.MathUtils.clamp(opts.roughness / Math.max(def.roughness, 0.01), 0, 2.5)
        : 1.0;
      if (METAL_MAPPED.has(name)) {
        params.metalnessMap = tex.orm;
        params.metalness = opts.metalness != null
          ? THREE.MathUtils.clamp(opts.metalness / Math.max(def.metalness, 0.01), 0, 2.0)
          : 1.0;
      } else {
        params.metalness = opts.metalness ?? def.metalness;
      }
    } else {
      // init() has not run (or no renderer) — stay plausible rather than break.
      params.color = opts.color ?? def.color;
      params.roughness = opts.roughness ?? def.roughness;
      params.metalness = opts.metalness ?? def.metalness;
    }

    const Ctor = usePhysical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
    const mat = new Ctor(params);

    if (usePhysical) {
      for (const [k, v] of Object.entries(def.physical)) {
        if (k === 'sheenColor') mat.sheenColor = new THREE.Color(v);
        else mat[k] = v;
      }
    }

    if (opts.emissive) {
      mat.emissive = new THREE.Color(opts.emissive);
      mat.emissiveIntensity = opts.emissiveIntensity ?? 1;
    }

    if (tex) {
      const d = { ...(def.detail || {}), ...(opts.detail || {}) };
      const scale = opts.scale ?? 1;
      const rep = opts.repeat || [scale, scale];
      installSurfaceShader(mat, {
        detailMap: this.detailMap,
        detailScale: d.scale ?? 13,
        detailStrength: d.strength ?? 0.5,
        selfScale: d.selfScale ?? 7,
        selfStrength: d.selfStrength ?? 0.45,
        fadeStart: d.fadeStart ?? 5,
        fadeEnd: d.fadeEnd ?? 24,
        triplanar: !!opts.triplanar,
        triScale: (opts.triScale ?? def.triScale ?? 0.4) * scale,
        triSharpness: opts.triSharpness ?? 6.0,
        tint: _tmpColor.set(opts.color ?? def.tintDefault ?? 0xffffff),
        repeatX: rep[0], repeatY: rep[1],
      });
    }

    mat.userData.surface = name;
    if (def.animate && mat.userData.matUniforms) {
      this._animated.push({ uniforms: mat.userData.matUniforms, speed: def.animate });
    }

    this.cache.set(key, mat);
    return mat;
  }

  /** Shared texture set for a surface (decals, impact fx, terrain splatting). */
  getTextures(surface) { return this.textures.get(surface) || null; }

  /**
   * Procedural IBL probe. Metals are black without one — if the world system
   * does not already set `scene.environment`, call this once and assign it.
   * @returns {{texture:THREE.Texture, sunDir:THREE.Vector3, dispose:Function}}
   */
  buildEnvironment(renderer, opts) {
    return buildEnvironment(renderer || this.renderer, opts);
  }

  /** Surface name for a hit object; systems use this for impact fx/audio. */
  surfaceOf(object) {
    return object?.userData?.surface || object?.material?.userData?.surface || 'concrete';
  }

  /**
   * Optional. Scrolls the uv offset of animated surfaces (water). Nothing
   * depends on it being called — surfaces just sit still if it is not.
   */
  update(dt) {
    if (!this._animated.length) return;
    this._elapsed += dt;
    for (const a of this._animated) {
      const v = a.uniforms.uMatUv.value;
      v.z = (this._elapsed * a.speed.x) % 1;
      v.w = (this._elapsed * a.speed.y) % 1;
    }
  }

  dispose() {
    for (const m of this.cache.values()) m.dispose();
    this.cache.clear();
    this._animated.length = 0;
    this.forge?.dispose();
    this.forge = null;
    this.textures.clear();
    this.detailMap = null;
    this.ready = false;
    this._initPromise = null;
  }
}

export const Materials = new MaterialLibraryImpl();
export { SURFACE_DEFS, TextureForge, installSurfaceShader, buildEnvironment };
export default Materials;
