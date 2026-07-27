import * as THREE from 'three';
import CFG from '../core/Config.js';

/**
 * STABLE PUBLIC API — every other system codes against this.
 * The implementation behind it is owned by the materials agent and will be
 * upgraded to full procedural PBR; the surface below must not change shape.
 *
 *   await Materials.init(renderer)
 *   Materials.get(surface, opts) -> THREE.Material   (cached, shared)
 *   Materials.SURFACES           -> string[]
 *
 * opts: { scale=1, color?, roughness?, metalness?, triplanar=false, emissive? }
 */
export const SURFACES = [
  'concrete', 'metal', 'painted_metal', 'sand', 'rock',
  'glass', 'wood', 'grass', 'water', 'flesh', 'rubber', 'plastic',
];

/** Baseline physical values so even the placeholder reads plausibly lit. */
const BASE = {
  concrete:      { color: 0x9c968c, roughness: 0.92, metalness: 0.00 },
  metal:         { color: 0x8a9099, roughness: 0.38, metalness: 0.95 },
  painted_metal: { color: 0x3f5d78, roughness: 0.55, metalness: 0.25 },
  sand:          { color: 0xc2a878, roughness: 0.97, metalness: 0.00 },
  rock:          { color: 0x6f6a63, roughness: 0.88, metalness: 0.00 },
  glass:         { color: 0xaad4e6, roughness: 0.06, metalness: 0.00, transparent: true, opacity: 0.28 },
  wood:          { color: 0x8a6440, roughness: 0.78, metalness: 0.00 },
  grass:         { color: 0x5c7040, roughness: 0.95, metalness: 0.00 },
  water:         { color: 0x2d6a8a, roughness: 0.04, metalness: 0.10, transparent: true, opacity: 0.72 },
  flesh:         { color: 0xa85f52, roughness: 0.70, metalness: 0.00 },
  rubber:        { color: 0x2a2c30, roughness: 0.98, metalness: 0.00 },
  plastic:       { color: 0xb8bcc2, roughness: 0.45, metalness: 0.00 },
};

class MaterialLibraryImpl {
  constructor() {
    this.cache = new Map();
    this.renderer = null;
    this.ready = false;
  }

  async init(renderer) {
    this.renderer = renderer;
    this.maxAniso = renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;
    this.ready = true;
  }

  get SURFACES() { return SURFACES; }

  _key(surface, o) {
    return `${surface}|${o.scale ?? 1}|${o.color ?? ''}|${o.roughness ?? ''}|${o.metalness ?? ''}|${o.triplanar ? 1 : 0}|${o.emissive ?? ''}`;
  }

  /** @returns {THREE.MeshStandardMaterial} shared, cached — do not mutate. */
  get(surface, opts = {}) {
    const key = this._key(surface, opts);
    const hit = this.cache.get(key);
    if (hit) return hit;

    const base = BASE[surface] || BASE.concrete;
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(opts.color ?? base.color),
      roughness: opts.roughness ?? base.roughness,
      metalness: opts.metalness ?? base.metalness,
      transparent: base.transparent ?? false,
      opacity: base.opacity ?? 1,
      side: base.transparent ? THREE.DoubleSide : THREE.FrontSide,
    });
    if (opts.emissive) {
      mat.emissive = new THREE.Color(opts.emissive);
      mat.emissiveIntensity = opts.emissiveIntensity ?? 1;
    }
    mat.userData.surface = surface;
    this.cache.set(key, mat);
    return mat;
  }

  /** Surface name for a hit object; systems use this for impact fx/audio. */
  surfaceOf(object) {
    return object?.userData?.surface || object?.material?.userData?.surface || 'concrete';
  }

  dispose() {
    for (const m of this.cache.values()) {
      m.map?.dispose?.(); m.normalMap?.dispose?.(); m.roughnessMap?.dispose?.();
      m.aoMap?.dispose?.(); m.metalnessMap?.dispose?.();
      m.dispose();
    }
    this.cache.clear();
  }
}

export const Materials = new MaterialLibraryImpl();
export default Materials;
