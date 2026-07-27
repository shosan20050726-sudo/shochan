import * as THREE from 'three';

/**
 * Per-surface authoring table.
 *
 * `color` / `roughness` / `metalness` deliberately keep the numbers the
 * placeholder library shipped with, so anything already tuned against them
 * still looks the same ballpark — the maps now supply the variation around
 * those values rather than replacing them.
 *
 *   res            texture resolution tier: 1 = full, 0.5 = half
 *   normalStrength sobel gain on the height field
 *   normalScale    material-side normalScale (lets art dial it per surface)
 *   aoRadius       cavity-AO ring radius in texels
 *   aoStrength     cavity-AO strength
 *   curvGain       curvature gain feeding edge wear / crevice dirt
 *   detail         close-range detail-tiling blend
 *   triScale       default triplanar frequency, repeats per metre
 *   physical       extra MeshPhysicalMaterial fields (undefined = Standard)
 */
export const SURFACE_DEFS = {
  concrete: {
    color: 0x9c968c, roughness: 0.92, metalness: 0.00,
    res: 1, seed: 11, normalStrength: 1.25, normalScale: 1.15,
    aoRadius: 3.5, aoStrength: 2.7, curvGain: 3.4, aoIntensity: 1.0,
    detail: { scale: 13, strength: 0.60, selfScale: 7, selfStrength: 0.50, fadeStart: 5, fadeEnd: 24 },
    triScale: 0.35,
  },
  metal: {
    color: 0x8a9099, roughness: 0.38, metalness: 0.95,
    res: 1, seed: 23, normalStrength: 1.05, normalScale: 0.95,
    aoRadius: 3.0, aoStrength: 2.2, curvGain: 3.0, aoIntensity: 0.85,
    detail: { scale: 17, strength: 0.42, selfScale: 9, selfStrength: 0.40, fadeStart: 4, fadeEnd: 18 },
    triScale: 0.5,
    physical: { anisotropy: 0.55, anisotropyRotation: 0.0, ior: 2.4, specularIntensity: 1.0 },
  },
  painted_metal: {
    color: 0x3f5d78, roughness: 0.55, metalness: 0.25,
    // The paint film is authored near-neutral so opts.color can drive the hue
    // without recolouring the rust and bare steel in the chips. With no colour
    // supplied we fall back to `color` so the default still looks painted.
    tintDefault: 0x6d8fae,
    res: 1, seed: 37, normalStrength: 1.15, normalScale: 1.0,
    aoRadius: 3.0, aoStrength: 2.3, curvGain: 3.2, aoIntensity: 0.9,
    detail: { scale: 15, strength: 0.45, selfScale: 9, selfStrength: 0.42, fadeStart: 4, fadeEnd: 18 },
    triScale: 0.5,
    physical: { clearcoat: 0.28, clearcoatRoughness: 0.55, anisotropy: 0.2 },
  },
  sand: {
    color: 0xc2a878, roughness: 0.97, metalness: 0.00,
    res: 1, seed: 53, normalStrength: 1.6, normalScale: 1.35,
    aoRadius: 4.0, aoStrength: 2.0, curvGain: 3.0, aoIntensity: 0.8,
    detail: { scale: 19, strength: 0.70, selfScale: 11, selfStrength: 0.55, fadeStart: 6, fadeEnd: 30 },
    triScale: 0.25,
  },
  rock: {
    color: 0x6f6a63, roughness: 0.88, metalness: 0.00,
    res: 1, seed: 71, normalStrength: 1.45, normalScale: 1.30,
    aoRadius: 4.0, aoStrength: 3.0, curvGain: 3.6, aoIntensity: 1.0,
    detail: { scale: 13, strength: 0.62, selfScale: 7, selfStrength: 0.55, fadeStart: 6, fadeEnd: 30 },
    triScale: 0.22,
  },
  glass: {
    color: 0xaad4e6, roughness: 0.06, metalness: 0.00,
    res: 0.5, seed: 89, normalStrength: 0.55, normalScale: 0.45,
    aoRadius: 3.0, aoStrength: 1.2, curvGain: 2.0, aoIntensity: 0.35,
    detail: { scale: 21, strength: 0.16, selfScale: 9, selfStrength: 0.14, fadeStart: 3, fadeEnd: 14 },
    triScale: 0.5,
    transparent: true, opacity: 0.28, side: THREE.DoubleSide,
    physical: { ior: 1.52, specularIntensity: 1.0, clearcoat: 0.6, clearcoatRoughness: 0.05 },
  },
  wood: {
    color: 0x8a6440, roughness: 0.78, metalness: 0.00,
    res: 1, seed: 101, normalStrength: 1.20, normalScale: 1.05,
    aoRadius: 3.2, aoStrength: 2.4, curvGain: 3.2, aoIntensity: 0.95,
    detail: { scale: 15, strength: 0.52, selfScale: 7, selfStrength: 0.48, fadeStart: 4, fadeEnd: 20 },
    triScale: 0.4,
  },
  grass: {
    color: 0x5c7040, roughness: 0.95, metalness: 0.00,
    res: 1, seed: 113, normalStrength: 1.5, normalScale: 1.25,
    aoRadius: 3.0, aoStrength: 3.2, curvGain: 3.4, aoIntensity: 1.0,
    detail: { scale: 17, strength: 0.55, selfScale: 9, selfStrength: 0.55, fadeStart: 6, fadeEnd: 28 },
    triScale: 0.3,
  },
  water: {
    color: 0x2d6a8a, roughness: 0.04, metalness: 0.10,
    res: 0.5, seed: 131, normalStrength: 1.10, normalScale: 0.85,
    aoRadius: 3.0, aoStrength: 0.8, curvGain: 2.4, aoIntensity: 0.25,
    detail: { scale: 23, strength: 0.30, selfScale: 7, selfStrength: 0.30, fadeStart: 8, fadeEnd: 40 },
    triScale: 0.15,
    transparent: true, opacity: 0.72, side: THREE.DoubleSide,
    physical: { ior: 1.33, clearcoat: 0.9, clearcoatRoughness: 0.06, specularIntensity: 1.0 },
    animate: { x: 0.014, y: 0.009 },
  },
  flesh: {
    color: 0xa85f52, roughness: 0.70, metalness: 0.00,
    res: 0.5, seed: 149, normalStrength: 1.05, normalScale: 0.85,
    aoRadius: 3.0, aoStrength: 2.0, curvGain: 3.0, aoIntensity: 0.8,
    detail: { scale: 19, strength: 0.48, selfScale: 9, selfStrength: 0.40, fadeStart: 2.5, fadeEnd: 12 },
    triScale: 1.0,
    physical: { clearcoat: 0.30, clearcoatRoughness: 0.52, sheen: 0.25, sheenRoughness: 0.7, sheenColor: 0xff9a80 },
  },
  rubber: {
    color: 0x2a2c30, roughness: 0.98, metalness: 0.00,
    res: 0.5, seed: 167, normalStrength: 1.10, normalScale: 0.95,
    aoRadius: 3.0, aoStrength: 2.0, curvGain: 3.0, aoIntensity: 0.9,
    detail: { scale: 23, strength: 0.55, selfScale: 9, selfStrength: 0.45, fadeStart: 2.5, fadeEnd: 12 },
    triScale: 1.0,
  },
  plastic: {
    color: 0xb8bcc2, roughness: 0.45, metalness: 0.00,
    res: 0.5, seed: 181, normalStrength: 0.85, normalScale: 0.70,
    aoRadius: 3.0, aoStrength: 1.8, curvGain: 3.0, aoIntensity: 0.8,
    detail: { scale: 21, strength: 0.40, selfScale: 9, selfStrength: 0.35, fadeStart: 2.5, fadeEnd: 12 },
    triScale: 1.0,
    physical: { clearcoat: 0.35, clearcoatRoughness: 0.30, ior: 1.5 },
  },
};

export default SURFACE_DEFS;
