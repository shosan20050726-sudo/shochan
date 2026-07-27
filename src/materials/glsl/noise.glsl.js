/**
 * Tileable procedural noise library (GLSL, ES 1.00 compatible).
 *
 * Everything in here is *periodic*: the lattice index is wrapped with `mod()`
 * before hashing, so a texture rendered over uv 0..1 with an integer frequency
 * tiles seamlessly. That is non-negotiable for a game texture — a visible seam
 * on a 30 m wall is the single most obvious "asset flip" tell.
 *
 * Periods are vec2 so a pattern can be anisotropic (brushed metal wants
 * something like frequency (900, 12) — 900 fine cells across, 12 down).
 * Frequencies MUST be whole numbers or the wrap stops lining up.
 */
export const NOISE_GLSL = /* glsl */`
#ifndef MAT_NOISE_INCLUDED
#define MAT_NOISE_INCLUDED

#define MAT_PI 3.141592653589793

float satf(float x){ return clamp(x, 0.0, 1.0); }
vec3  sat3(vec3 x){ return clamp(x, 0.0, 1.0); }

// ---------------------------------------------------------------- hashing --
// Dave Hoskins style hashes: cheap, no visible structure at texture scale.
float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec3 hash32(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

// wrap a lattice cell into the tiling period, then offset by the seed so two
// surfaces built from the same frequencies do not share a silhouette.
vec2 wrapCell(vec2 i, vec2 per, float seed){
  return mod(i, max(per, vec2(1.0))) + seed * 17.0;
}

// ------------------------------------------------------------ value noise --
float vnoise(vec2 p, vec2 per, float seed){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash12(wrapCell(i + vec2(0.0, 0.0), per, seed));
  float b = hash12(wrapCell(i + vec2(1.0, 0.0), per, seed));
  float c = hash12(wrapCell(i + vec2(0.0, 1.0), per, seed));
  float d = hash12(wrapCell(i + vec2(1.0, 1.0), per, seed));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);   // 0..1
}

// --------------------------------------------------------- gradient noise --
float gnoise(vec2 p, vec2 per, float seed){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 g00 = normalize(hash22(wrapCell(i + vec2(0.0, 0.0), per, seed)) * 2.0 - 1.0);
  vec2 g10 = normalize(hash22(wrapCell(i + vec2(1.0, 0.0), per, seed)) * 2.0 - 1.0);
  vec2 g01 = normalize(hash22(wrapCell(i + vec2(0.0, 1.0), per, seed)) * 2.0 - 1.0);
  vec2 g11 = normalize(hash22(wrapCell(i + vec2(1.0, 1.0), per, seed)) * 2.0 - 1.0);
  float a = dot(g00, f - vec2(0.0, 0.0));
  float b = dot(g10, f - vec2(1.0, 0.0));
  float c = dot(g01, f - vec2(0.0, 1.0));
  float d = dot(g11, f - vec2(1.0, 1.0));
  return (mix(mix(a, b, u.x), mix(c, d, u.x), u.y)) * 1.4;   // ~ -1..1
}

// ------------------------------------------------------------------- fbm ---
// Lacunarity is fixed at 2 so the period stays integral every octave.
float fbm(vec2 p, vec2 per, int oct, float gain, float seed){
  float amp = 0.5, sum = 0.0, norm = 0.0;
  vec2 q = p, pr = per;
  for (int i = 0; i < 6; i++){
    if (i >= oct) break;
    sum += amp * gnoise(q, pr, seed + float(i) * 3.7);
    norm += amp;
    q *= 2.0; pr *= 2.0; amp *= gain;
  }
  return sum / max(norm, 1e-5);            // ~ -1..1
}
float fbm01(vec2 p, vec2 per, int oct, float gain, float seed){
  return fbm(p, per, oct, gain, seed) * 0.5 + 0.5;
}

// Ridged multifractal — the go-to for cracks, strata and rock crests.
float ridged(vec2 p, vec2 per, int oct, float seed){
  float amp = 0.5, sum = 0.0, norm = 0.0;
  vec2 q = p, pr = per;
  for (int i = 0; i < 6; i++){
    if (i >= oct) break;
    float v = 1.0 - abs(gnoise(q, pr, seed + float(i) * 5.1));
    v *= v;
    sum += amp * v; norm += amp;
    q *= 2.0; pr *= 2.0; amp *= 0.5;
  }
  return sum / max(norm, 1e-5);            // 0..1, ridges near 1
}

// Billowy (absolute-value) fbm — clouds, lichen, soft aggregate clumps.
float billow(vec2 p, vec2 per, int oct, float seed){
  float amp = 0.5, sum = 0.0, norm = 0.0;
  vec2 q = p, pr = per;
  for (int i = 0; i < 6; i++){
    if (i >= oct) break;
    sum += amp * abs(gnoise(q, pr, seed + float(i) * 2.3));
    norm += amp;
    q *= 2.0; pr *= 2.0; amp *= 0.5;
  }
  return sum / max(norm, 1e-5);
}

// --------------------------------------------------------------- voronoi ---
// x = F1 distance, y = F2 distance, z = cell id (0..1), w = 0
vec4 voronoi(vec2 p, vec2 per, float jitter, float seed){
  vec2 ip = floor(p), fp = fract(p);
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for (int j = -1; j <= 1; j++){
    for (int i = -1; i <= 1; i++){
      vec2 g = vec2(float(i), float(j));
      vec2 cell = wrapCell(ip + g, per, seed);
      vec2 o = hash22(cell);
      vec2 r = g + 0.5 + (o - 0.5) * jitter - fp;
      float d = dot(r, r);
      if (d < f1){ f2 = f1; f1 = d; id = hash12(cell + 7.13); }
      else if (d < f2){ f2 = d; }
    }
  }
  return vec4(sqrt(f1), sqrt(f2), id, 0.0);
}

// Cell-edge field: ~0 on a cell border, rises inward. Cracks and mortar.
float voronoiEdge(vec2 p, vec2 per, float jitter, float seed){
  vec4 v = voronoi(p, per, jitter, seed);
  return v.y - v.x;
}

// ------------------------------------------------------------ warp / misc --
vec2 warp(vec2 p, vec2 per, float amount, int oct, float seed){
  return p + vec2(fbm(p, per, oct, 0.5, seed),
                  fbm(p, per, oct, 0.5, seed + 41.0)) * amount;
}

// Anisotropic streak field — brushed metal, wood grain, water chop.
float streaks(vec2 uv, vec2 freq, int oct, float seed){
  return fbm01(uv * freq, freq, oct, 0.55, seed);
}

// Thin scratch lines: a small set of long, near-straight gouges.
// Returns 0..1 where 1 is the middle of a scratch.
float scratches(vec2 uv, float count, float len, float width, float seed){
  float acc = 0.0;
  for (int i = 0; i < 8; i++){
    if (float(i) >= count) break;
    vec3 h = hash32(vec2(float(i) * 3.71 + seed, seed * 1.7));
    float ang = h.x * MAT_PI;
    vec2 dir = vec2(cos(ang), sin(ang));
    vec2 nrm = vec2(-dir.y, dir.x);
    // wrap the sample into the tile so the scratch survives the seam
    vec2 d = uv - h.yz;
    d -= floor(d + 0.5);
    float along = dot(d, dir);
    float across = abs(dot(d, nrm));
    float w = width * (0.4 + h.x);
    float line = smoothstep(w, 0.0, across);
    line *= smoothstep(len * (0.5 + h.y), len * 0.15, abs(along));
    // break the scratch up so it isn't a perfect vector line
    line *= smoothstep(0.30, 0.75, vnoise(uv * vec2(220.0), vec2(220.0), seed + float(i)));
    acc = max(acc, line);
  }
  return acc;
}

// Sub-divide an axis into cells of varying width (planks, panels, strata).
// Returns: x = local coord 0..1 inside the cell, y = cell id hash,
//          z = distance to nearest cell border in local units, w = cell index
vec4 splitAxis(float t, float count, float jitter, float seed){
  float c = floor(t * count);
  float f = fract(t * count);
  // shift each border by a per-border hash, keeping ordering intact
  float b0 = (hash12(vec2(mod(c, count), seed)) - 0.5) * jitter;
  float b1 = (hash12(vec2(mod(c + 1.0, count), seed)) - 0.5) * jitter;
  float lo = b0, hi = 1.0 + b1;
  float local = (f - lo) / max(hi - lo, 1e-3);
  float id = hash12(vec2(mod(c, count) + 0.5, seed * 2.3));
  float edge = min(local, 1.0 - local);
  return vec4(local, id, edge, c);
}

#endif
`;

export default NOISE_GLSL;
