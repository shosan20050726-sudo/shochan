/**
 * Material registry for the map.
 *
 * Every entry resolves to ONE shared material from the library, so a key is
 * effectively a draw-call bucket. UVs are authored in metres (see Kit.js), so
 * `repeat` here reads as "texture tiles per metre" — the same number gives the
 * same texel density on a bollard and on a hangar wall.
 *
 * Each point of interest is assigned its own subset of keys, which is what
 * gives them distinct colour signatures instead of one grey map.
 */
export const MATERIAL_DEFS = {
  /* --- structural ------------------------------------------------------ */
  concrete:       { s: 'concrete', o: { repeat: [0.34, 0.34] } },
  concrete_pale:  { s: 'concrete', o: { repeat: [0.30, 0.30], color: 0xd9d0bd } },
  concrete_warm:  { s: 'concrete', o: { repeat: [0.36, 0.36], color: 0xc7ab84 } },
  concrete_dark:  { s: 'concrete', o: { repeat: [0.38, 0.38], color: 0x847f78 } },
  concrete_red:   { s: 'concrete', o: { repeat: [0.36, 0.36], color: 0xa2705a } },
  stone_paving:   { s: 'concrete', o: { repeat: [0.52, 0.52], color: 0xb6a288, roughness: 0.86 } },
  asphalt:        { s: 'rubber',   o: { repeat: [0.24, 0.24], color: 0x6a6a6d, roughness: 0.96 } },
  cliff:          { s: 'rock',     o: { triplanar: true, triScale: 0.09, scale: 1 } },
  gravel:         { s: 'sand',     o: { triplanar: true, triScale: 0.16, scale: 1, color: 0xb5a486 } },

  /* --- metals ---------------------------------------------------------- */
  steel:          { s: 'metal',    o: { repeat: [0.55, 0.55] } },
  steel_dark:     { s: 'metal',    o: { repeat: [0.60, 0.60], color: 0x6c7178, roughness: 0.52 } },
  steel_bright:   { s: 'metal',    o: { repeat: [0.50, 0.50], color: 0xc8ccd2, roughness: 0.26 } },
  grating:        { s: 'metal',    o: { repeat: [1.05, 1.05], color: 0x8a8f96, roughness: 0.62 } },

  /* --- painted signatures, one family per POI -------------------------- */
  paint_rust:     { s: 'painted_metal', o: { repeat: [0.42, 0.42], color: 0xb0552a } },   // Foundry
  paint_copper:   { s: 'painted_metal', o: { repeat: [0.42, 0.42], color: 0x4f8a72 } },   // Foundry oxide
  paint_hangar:   { s: 'painted_metal', o: { repeat: [0.38, 0.38], color: 0x9aa79b } },   // Hangar 7
  paint_yellow:   { s: 'painted_metal', o: { repeat: [0.50, 0.50], color: 0xd8a12a } },
  paint_teal:     { s: 'painted_metal', o: { repeat: [0.48, 0.48], color: 0x2c7f86 } },   // Terrace Row
  paint_cream:    { s: 'painted_metal', o: { repeat: [0.40, 0.40], color: 0xd9c9a8 } },   // Terrace Row
  paint_red:      { s: 'painted_metal', o: { repeat: [0.48, 0.48], color: 0xa63a2c } },   // Relay Spire
  paint_white:    { s: 'painted_metal', o: { repeat: [0.44, 0.44], color: 0xdcdcd6 } },
  paint_blue:     { s: 'painted_metal', o: { repeat: [0.46, 0.46], color: 0x2f5f8f } },
  paint_ochre:    { s: 'painted_metal', o: { repeat: [0.46, 0.46], color: 0xb98736 } },   // The Bore
  paint_green:    { s: 'painted_metal', o: { repeat: [0.46, 0.46], color: 0x4a6b3c } },

  /* --- soft goods and glazing ------------------------------------------ */
  wood:           { s: 'wood',     o: { repeat: [0.52, 0.52] } },
  wood_pale:      { s: 'wood',     o: { repeat: [0.56, 0.56], color: 0xc7a878 } },
  canvas_red:     { s: 'plastic',  o: { repeat: [0.34, 0.34], color: 0xa8402f, roughness: 0.88, side: 2 } },
  canvas_saffron: { s: 'plastic',  o: { repeat: [0.34, 0.34], color: 0xcf9330, roughness: 0.88, side: 2 } },
  canvas_indigo:  { s: 'plastic',  o: { repeat: [0.34, 0.34], color: 0x35507e, roughness: 0.88, side: 2 } },
  canvas_bone:    { s: 'plastic',  o: { repeat: [0.34, 0.34], color: 0xc9bfa4, roughness: 0.88, side: 2 } },
  plastic_white:  { s: 'plastic',  o: { repeat: [0.60, 0.60], color: 0xcfd2cc } },
  plastic_orange: { s: 'plastic',  o: { repeat: [0.70, 0.70], color: 0xd06a20 } },
  rubber:         { s: 'rubber',   o: { repeat: [0.70, 0.70] } },
  glass:          { s: 'glass',    o: { repeat: [0.22, 0.22] } },
  glass_dirty:    { s: 'glass',    o: { repeat: [0.28, 0.28], color: 0x9fb0a4, opacity: 0.42 } },
  water:          { s: 'water',    o: { repeat: [0.06, 0.06] } },

  /* --- emissive: signage, warning lamps, zipline anchors --------------- */
  lamp_warm:      { s: 'plastic',  o: { repeat: [0.6, 0.6], color: 0xffe0a8, emissive: 0xffbb55, emissiveIntensity: 3.4 } },
  lamp_cyan:      { s: 'plastic',  o: { repeat: [0.6, 0.6], color: 0xbff4ff, emissive: 0x2fd8ff, emissiveIntensity: 4.2 } },
  lamp_red:       { s: 'plastic',  o: { repeat: [0.6, 0.6], color: 0xffb0a0, emissive: 0xff2a18, emissiveIntensity: 4.0 } },
  sign_glow:      { s: 'plastic',  o: { repeat: [0.5, 0.5], color: 0xffd9a0, emissive: 0xff8a2a, emissiveIntensity: 2.2 } },
};

/** Keys whose meshes should not cast shadows (thin, tiny, or fully enclosed). */
export const NO_SHADOW = new Set(['water', 'lamp_warm', 'lamp_cyan', 'lamp_red', 'sign_glow']);

/**
 * Build the key -> { material, surface } resolver handed to Builder.
 * @param {object} Materials material library singleton
 */
export function makePalette(Materials) {
  const cache = new Map();
  return function matFor(key) {
    let hit = cache.get(key);
    if (hit) return hit;
    const def = MATERIAL_DEFS[key] || MATERIAL_DEFS.concrete;
    const material = Materials.get(def.s, def.o);
    hit = { material, surface: def.s === 'painted_metal' ? 'metal' : def.s, cast: !NO_SHADOW.has(key) };
    cache.set(key, hit);
    return hit;
  };
}

export default makePalette;
