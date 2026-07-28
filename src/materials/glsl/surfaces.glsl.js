/**
 * Per-surface procedural definitions.
 *
 * Each entry supplies three GLSL functions that are compiled into two tiny
 * fullscreen programs by TextureForge:
 *
 *   vec4 matPattern(vec2 uv)
 *       -> (height, maskA, maskB, maskC).  Rendered into a half-float RT.
 *          `height` is the ONLY source of the normal map: TextureForge runs a
 *          real sobel over it. Nothing here fakes a normal.
 *
 *   vec3 matAlbedo(vec2 uv, vec4 p, float curv, float ao)
 *       -> sRGB-encoded base colour. `curv` is (height - blurred height) so
 *          convex = worn/bleached, concave = dirt; `ao` is the cavity term.
 *
 *   vec4 matORM(vec2 uv, vec4 p, float curv, float ao)
 *       -> (ao, roughness, metalness, tintMask). Packed glTF-style so a single
 *          texture feeds aoMap(.r) / roughnessMap(.g) / metalnessMap(.b).
 *          `.w` is exported separately into the albedo alpha and marks where
 *          `opts.color` is allowed to tint (so a paint tint does not also
 *          recolour the rust bleeding through the chips).
 *
 * All frequencies are whole numbers so every pattern tiles seamlessly.
 */

/* eslint-disable */

const CONCRETE = /* glsl */`
vec4 matPattern(vec2 uv){
  float S = uSeed;

  float base = fbm01(uv * 4.0, vec2(4.0), 5, 0.5, S);

  // Aggregate: two grades of stone, only exposed where the cement skin wore off.
  vec4 vA = voronoi(uv * 48.0, vec2(48.0), 1.0, S + 3.0);
  vec4 vB = voronoi(uv * 118.0, vec2(118.0), 1.0, S + 9.0);
  float pebA = smoothstep(0.46, 0.06, vA.x);
  float pebB = smoothstep(0.40, 0.09, vB.x);
  float skinWear = smoothstep(0.30, 0.72, fbm01(uv * 6.0 + 21.0, vec2(6.0), 4, 0.5, S + 1.0));
  float agg = satf(pebA * 0.90 + pebB * 0.55) * skinWear;

  // Form-board lines: the boards were never perfectly straight.
  float rows = 6.0;
  float wob = fbm(uv * vec2(3.0, 1.0), vec2(3.0, 1.0), 3, 0.5, S + 5.0) * 0.010;
  float fy = fract((uv.y + wob) * rows);
  float dl = min(fy, 1.0 - fy);
  float groove  = smoothstep(0.020, 0.004, dl);
  float chamfer = smoothstep(0.070, 0.020, dl);

  // Form-tie holes, plugged and shrunk back.
  vec2 tieF = fract(uv * vec2(5.0, rows) + 0.5) - 0.5;
  float tie = smoothstep(0.115, 0.050, length(tieF * vec2(1.0, 0.92)));

  // Cracks follow warped cell borders, and only show in stressed regions.
  vec2 cw = warp(uv * 5.0, vec2(5.0), 0.55, 3, S + 13.0);
  float crackLine = smoothstep(0.075, 0.0, voronoiEdge(cw, vec2(5.0), 1.0, S + 17.0));
  float crackVis  = smoothstep(0.52, 0.86, fbm01(uv * 3.0 + 55.0, vec2(3.0), 3, 0.5, S + 23.0));
  float crack = crackLine * crackVis;

  // Spalling: chips where the cover concrete has broken away.
  float chipN = fbm01(uv * 14.0 + 7.0, vec2(14.0), 4, 0.5, S + 29.0);
  float chip  = smoothstep(0.74, 0.87, chipN) * skinWear;

  float pockets = smoothstep(0.90, 0.995, vnoise(uv * 240.0, vec2(240.0), S + 31.0));
  float grain   = fbm(uv * 210.0, vec2(210.0), 3, 0.5, S + 37.0);

  float h = 0.58 + (base - 0.5) * 0.22;
  h += agg * 0.150;
  h -= groove * 0.34 + chamfer * 0.045;
  h -= tie * 0.20;
  h -= crack * 0.30;
  h -= chip * 0.22;
  h -= pockets * 0.16;
  h += grain * 0.030;

  // Water staining bleeds downward from every form line.
  float dripField = fbm01(vec2(uv.x * 120.0, uv.y * 6.0), vec2(120.0, 6.0), 4, 0.55, S + 41.0);
  float drip  = smoothstep(0.50, 0.86, dripField) * smoothstep(0.28, 1.0, fy);
  float grime = smoothstep(0.42, 0.86, fbm01(uv * 3.0 + 71.0, vec2(3.0), 4, 0.5, S + 43.0));
  float stain = satf(drip * 0.85 + grime * 0.55 + crack * 0.45);

  return vec4(satf(h), agg, stain, satf(skinWear * 0.55 + chip));
}

vec3 matAlbedo(vec2 uv, vec4 p, float curv, float ao){
  float S = uSeed;
  float agg = p.g, stain = p.b;

  float patchN = fbm01(uv * 3.0 + 5.0, vec2(3.0), 4, 0.5, S + 2.0);
  float pour  = fbm01(uv * vec2(1.0, 3.0) + 17.0, vec2(1.0, 3.0), 3, 0.5, S + 6.0);
  // Real dry concrete sits near 0.30 linear albedo. Authoring it any brighter
  // is what makes procedural materials read as chalk.
  vec3 cement = vec3(0.452, 0.442, 0.423) * mix(0.72, 1.14, patchN) * mix(0.90, 1.10, pour);

  vec4 vA = voronoi(uv * 48.0, vec2(48.0), 1.0, S + 3.0);
  vec3 stone = mix(vec3(0.315, 0.302, 0.286), vec3(0.620, 0.575, 0.500), vA.z);
  stone = mix(stone, vec3(0.455, 0.340, 0.288), step(0.85, vA.z));    // occasional red granite
  stone = mix(stone, vec3(0.230, 0.238, 0.252), step(0.94, vA.z));    // occasional basalt

  vec3 col = mix(cement, stone, satf(agg * 1.65));
  col = mix(col, vec3(0.190, 0.174, 0.152), stain * 0.62);

  float effl = smoothstep(0.66, 0.93, fbm01(uv * vec2(8.0, 4.0) + 13.0, vec2(8.0, 4.0), 3, 0.5, S + 7.0));
  col = mix(col, vec3(0.720, 0.715, 0.700), effl * 0.30 * (1.0 - stain));

  // rust running out of the rebar where the cover spalled
  float rebar = smoothstep(0.55, 0.85, p.a) * smoothstep(0.45, 0.9, fbm01(uv * vec2(60.0, 5.0), vec2(60.0, 5.0), 3, 0.55, S + 19.0));
  col = mix(col, vec3(0.360, 0.190, 0.100), rebar * 0.45);

  col *= mix(1.0, 0.40, satf(-curv * 7.0));                           // dirt in the cavities
  col = mix(col, min(col * 1.20 + 0.03, vec3(1.0)), satf(curv * 6.0) * 0.75);
  col *= mix(1.0, 0.82, 1.0 - ao);
  return col;
}

vec4 matORM(vec2 uv, vec4 p, float curv, float ao){
  float r = 0.945;
  r -= p.g * 0.17;
  r -= p.b * 0.05;
  r -= satf(curv * 5.0) * 0.06;
  r += fbm(uv * 90.0, vec2(90.0), 3, 0.5, uSeed + 3.0) * 0.05;
  return vec4(ao, clamp(r, 0.06, 1.0), 0.0, 1.0);
}
`;

const METAL = /* glsl */`
// panel layout shared by the pattern and shade passes
void metalPanels(vec2 uv, out float edge, out float panelId, out float rivet, out float rot){
  vec4 px = splitAxis(uv.x, 2.0, 0.40, uSeed + 1.0);
  vec4 py = splitAxis(uv.y, 3.0, 0.34, uSeed + 2.0);
  edge = min(px.z, py.z);
  panelId = hash12(vec2(px.w, py.w) + uSeed);
  rot = step(0.5, panelId);
  // Rivets march along the seams only, and only on the long edges.
  float rx = abs(fract(uv.x * 16.0) - 0.5);
  float ry = abs(fract(uv.y * 20.0) - 0.5);
  float rivA = smoothstep(0.26, 0.10, length(vec2(rx, py.z * 9.0)));
  float rivB = smoothstep(0.26, 0.10, length(vec2(px.z * 9.0, ry)));
  rivet = max(rivA, rivB);
}

vec4 matPattern(vec2 uv){
  float S = uSeed;
  float edge, panelId, rivet, rot;
  metalPanels(uv, edge, panelId, rivet, rot);

  float seam  = smoothstep(0.014, 0.002, edge);
  float bevel = smoothstep(0.048, 0.014, edge);

  // brushed grain — sheet stock alternates direction panel to panel
  vec2 bu = mix(uv, uv.yx, rot);
  float brushF = fbm01(bu * vec2(1600.0, 24.0), vec2(1600.0, 24.0), 3, 0.55, S + panelId * 31.0);
  float brushC = fbm01(bu * vec2(420.0, 10.0),  vec2(420.0, 10.0),  2, 0.50, S + 4.0);
  float brush = brushF * 0.70 + brushC * 0.30;

  float dent = fbm(uv * 11.0 + 5.0, vec2(11.0), 3, 0.5, S + 6.0);
  float scr  = scratches(uv, 9.0, 0.55, 0.0022, S + 8.0);

  // Rust needs a REGION, not a rule. Without the broad zone mask every panel
  // ends up neatly framed in orange and the plate reads as bathroom tile.
  float rustZone  = smoothstep(0.50, 0.86, fbm01(uv * 3.0 + 61.0, vec2(3.0), 4, 0.5, S + 51.0));
  float rustSeed  = fbm01(uv * 9.0 + 33.0, vec2(9.0), 5, 0.55, S + 11.0);
  float rustNear  = smoothstep(0.045, 0.0, edge) * 0.5 + rivet * 0.45;
  float rustBleed = smoothstep(0.66, 0.95, fbm01(vec2(uv.x * 120.0, uv.y * 3.0), vec2(120.0, 3.0), 4, 0.55, S + 13.0));
  float rust = smoothstep(0.56, 0.80, rustSeed) * rustZone;
  rust = satf(rust + rustNear * rustZone * 0.85 + rustBleed * rustZone * 0.45);
  float pit  = smoothstep(0.50, 0.95, vnoise(uv * 340.0, vec2(340.0), S + 17.0));

  float h = 0.62;
  h += (panelId - 0.5) * 0.020;
  h += (brush - 0.5) * 0.022;
  h -= seam * 0.30 + bevel * 0.045;
  h += rivet * 0.16;
  h += dent * 0.055;
  h -= rust * pit * 0.11;
  h += rust * 0.025;
  h -= scr * 0.045;

  return vec4(satf(h), rust, brush, panelId);
}

vec3 matAlbedo(vec2 uv, vec4 p, float curv, float ao){
  float S = uSeed;
  float rust = p.g, brush = p.b, panelId = p.a;

  vec3 steel = vec3(0.735, 0.750, 0.770);
  steel *= mix(0.965, 1.025, panelId);                  // batch variation per plate
  steel *= mix(0.90, 1.07, brush);
  // grime settles in the brush grooves
  steel *= mix(1.0, 0.86, smoothstep(0.55, 0.0, brush));

  vec3 rustDark = vec3(0.255, 0.130, 0.075);
  vec3 rustMid  = vec3(0.470, 0.245, 0.120);
  vec3 rustLite = vec3(0.640, 0.400, 0.215);
  float rf = fbm01(uv * 26.0 + 9.0, vec2(26.0), 4, 0.5, S + 21.0);
  vec3 rustCol = mix(rustDark, rustMid, smoothstep(0.25, 0.65, rf));
  rustCol = mix(rustCol, rustLite, smoothstep(0.70, 0.95, rf));

  vec3 col = mix(steel, rustCol, smoothstep(0.05, 0.55, rust));

  // Nothing in a play space is clean metal: grime pools in the low areas
  // and streaks down from the seams.
  float grime = smoothstep(0.34, 0.86, fbm01(uv * 5.0 + 91.0, vec2(5.0), 5, 0.5, S + 61.0));
  grime = satf(grime * 0.75 + smoothstep(0.55, 0.95, fbm01(vec2(uv.x * 70.0, uv.y * 3.0), vec2(70.0, 3.0), 3, 0.55, S + 67.0)) * 0.4);
  col = mix(col, vec3(0.235, 0.232, 0.222), grime * 0.42);

  float scr = scratches(uv, 9.0, 0.55, 0.0022, S + 8.0);
  col = mix(col, vec3(0.88, 0.89, 0.90), scr * 0.7);    // bright bare-metal gouges

  col *= mix(1.0, 0.45, satf(-curv * 8.0));
  col *= mix(1.0, 0.80, 1.0 - ao);
  return col;
}

vec4 matORM(vec2 uv, vec4 p, float curv, float ao){
  float rust = p.g, brush = p.b, panelId = p.a;
  // Brushed, not chromed: the streak field has to swing roughness far enough
  // that the anisotropy actually shows in the highlight.
  float r = mix(0.40, 0.76, brush);
  r += (panelId - 0.5) * 0.035;
  r += smoothstep(0.34, 0.86, fbm01(uv * 5.0 + 91.0, vec2(5.0), 5, 0.5, uSeed + 61.0)) * 0.16;
  r = mix(r, mix(0.80, 0.97, fbm01(uv * 40.0, vec2(40.0), 3, 0.5, uSeed + 27.0)), smoothstep(0.05, 0.6, rust));
  float scr = scratches(uv, 9.0, 0.55, 0.0022, uSeed + 8.0);
  r = mix(r, 0.22, scr * 0.6);
  float m = mix(1.0, 0.10, smoothstep(0.15, 0.75, rust));
  return vec4(ao, clamp(r, 0.05, 1.0), m, 0.35);
}
`;

const PAINTED_METAL = /* glsl */`
void pmPanels(vec2 uv, out float edge, out float panelId, out float rivet){
  vec4 px = splitAxis(uv.x, 2.0, 0.35, uSeed + 1.0);
  vec4 py = splitAxis(uv.y, 2.0, 0.30, uSeed + 2.0);
  edge = min(px.z, py.z);
  panelId = hash12(vec2(px.w, py.w) + uSeed);
  float rx = abs(fract(uv.x * 14.0) - 0.5);
  float ry = abs(fract(uv.y * 14.0) - 0.5);
  rivet = max(smoothstep(0.26, 0.10, length(vec2(rx, py.z * 9.0))),
              smoothstep(0.26, 0.10, length(vec2(px.z * 9.0, ry))));
}

// paint coverage, 1 = intact paint, 0 = bare substrate
float pmPaint(vec2 uv, float edge, float rivet){
  float S = uSeed;
  float chipField = fbm01(uv * 11.0 + 3.0, vec2(11.0), 5, 0.58, S + 7.0);
  float fine      = fbm01(uv * 44.0 + 11.0, vec2(44.0), 4, 0.55, S + 19.0);
  // chipping concentrates on the raised edges and around fasteners
  // A broad wear region decides WHERE paint fails; the edge/rivet bias only
  // decides where it starts inside that region. Without the region gate every
  // panel gets an identical chipped border and it reads as tile grout.
  float region = smoothstep(0.40, 0.80, fbm01(uv * 3.0 + 71.0, vec2(3.0), 4, 0.5, S + 29.0));
  float bias = (smoothstep(0.045, 0.0, edge) * 0.26 + rivet * 0.24) * region;
  float wear = smoothstep(0.30, 0.85, fbm01(uv * 5.0 + 29.0, vec2(5.0), 4, 0.5, S + 23.0)) * 0.20 * region;
  float f = chipField * 0.70 + fine * 0.30 + bias + wear;
  return 1.0 - smoothstep(0.630, 0.690, f);
}

vec4 matPattern(vec2 uv){
  float S = uSeed;
  float edge, panelId, rivet;
  pmPanels(uv, edge, panelId, rivet);

  float seam  = smoothstep(0.013, 0.002, edge);
  float bevel = smoothstep(0.045, 0.013, edge);
  float paint = pmPaint(uv, edge, rivet);

  // The tell of good chipped paint: the film has thickness and a raised lip.
  float lip = satf(paint * (1.0 - paint) * 4.0);
  // orange peel in the paint film itself
  float peel = fbm(uv * 55.0, vec2(55.0), 3, 0.5, S + 31.0);
  // pitting/rust creeping under the film from the exposed metal
  float bare = 1.0 - paint;
  float rust = satf(bare * smoothstep(0.35, 0.85, fbm01(uv * 22.0 + 41.0, vec2(22.0), 4, 0.5, S + 37.0)) * 1.4);
  float rustCreep = smoothstep(0.25, 0.85, fbm01(uv * 34.0, vec2(34.0), 4, 0.5, S + 43.0)) * smoothstep(0.55, 0.05, paint);
  rust = satf(max(rust, rustCreep * 0.8));
  float pit = smoothstep(0.55, 0.95, vnoise(uv * 320.0, vec2(320.0), S + 47.0));
  float scr = scratches(uv, 8.0, 0.5, 0.0020, S + 53.0);

  float h = 0.60;
  h += (panelId - 0.5) * 0.035;
  h -= seam * 0.28 + bevel * 0.040;
  h += rivet * 0.15;
  h += paint * 0.045 + lip * 0.035;
  h += peel * paint * 0.020;
  h -= rust * pit * 0.10;
  h -= scr * 0.05;
  h += fbm(uv * 300.0, vec2(300.0), 3, 0.5, S + 59.0) * 0.018;

  return vec4(satf(h), paint, rust, panelId);
}

vec3 matAlbedo(vec2 uv, vec4 p, float curv, float ao){
  float S = uSeed;
  float paint = p.g, rust = p.b, panelId = p.a;

  // Paint is authored near-neutral; opts.color tints it through the mask in .a
  // of the albedo texture, so chips and rust keep their own colour.
  float fade = fbm01(uv * 5.0 + 3.0, vec2(5.0), 4, 0.5, S + 61.0);
  vec3 paintCol = vec3(0.600, 0.615, 0.632) * mix(0.74, 1.08, fade);
  paintCol *= mix(0.96, 1.04, panelId);
  // chalking / UV bleach on the exposed high points
  paintCol = mix(paintCol, vec3(0.700, 0.708, 0.715), satf(curv * 5.0) * 0.32);

  vec3 primer = vec3(0.455, 0.238, 0.172);
  vec3 steel  = vec3(0.700, 0.715, 0.735);
  vec3 rustCol = mix(vec3(0.300, 0.155, 0.085), vec3(0.590, 0.335, 0.170),
                     fbm01(uv * 30.0 + 7.0, vec2(30.0), 4, 0.5, S + 67.0));

  vec3 sub = mix(steel, primer, smoothstep(0.45, 0.05, paint));
  sub = mix(sub, rustCol, smoothstep(0.05, 0.55, rust));

  vec3 col = mix(sub, paintCol, smoothstep(0.15, 0.55, paint));
  col *= mix(1.0, 0.48, satf(-curv * 8.0));
  col *= mix(1.0, 0.82, 1.0 - ao);
  return col;
}

vec4 matORM(vec2 uv, vec4 p, float curv, float ao){
  float paint = p.g, rust = p.b;
  float peel = fbm01(uv * 55.0, vec2(55.0), 3, 0.5, uSeed + 31.0);
  float rPaint = mix(0.42, 0.62, peel);
  float rBare  = mix(0.32, 0.52, fbm01(uv * 90.0, vec2(90.0), 3, 0.5, uSeed + 71.0));
  float rRust  = mix(0.80, 0.97, fbm01(uv * 45.0, vec2(45.0), 3, 0.5, uSeed + 73.0));
  float r = mix(rBare, rPaint, smoothstep(0.15, 0.6, paint));
  r = mix(r, rRust, smoothstep(0.05, 0.6, rust));
  float m = mix(0.95, 0.03, smoothstep(0.15, 0.6, paint));
  m = mix(m, 0.06, smoothstep(0.2, 0.7, rust));
  // only the intact paint accepts the tint
  return vec4(ao, clamp(r, 0.05, 1.0), m, smoothstep(0.25, 0.65, paint));
}
`;

const SAND = /* glsl */`
vec4 matPattern(vec2 uv){
  float S = uSeed;
  float dunes = fbm(uv * 3.0, vec2(3.0), 5, 0.5, S + 3.0);

  // Two crossed ripple trains — real aeolian ripples interfere.
  float w1 = fbm(uv * 4.0, vec2(4.0), 4, 0.5, S) * 1.10;
  float ph1 = (uv.x * 3.0 + uv.y * 15.0) + w1;
  float rip1 = sin(ph1 * 2.0 * MAT_PI);
  rip1 = sign(rip1) * pow(abs(rip1), 0.62);
  float w2 = fbm(uv * 6.0, vec2(6.0), 3, 0.5, S + 9.0) * 0.85;
  float ph2 = (uv.x * 12.0 - uv.y * 5.0) + w2;
  float rip2 = sin(ph2 * 2.0 * MAT_PI);
  float rippleZone = smoothstep(0.25, 0.70, fbm01(uv * 2.0, vec2(2.0), 3, 0.5, S + 15.0));

  float grain  = fbm(uv * 820.0, vec2(820.0), 3, 0.5, S + 21.0);
  float coarse = smoothstep(0.84, 1.0, vnoise(uv * 360.0, vec2(360.0), S + 27.0));
  vec4 pv = voronoi(uv * 64.0, vec2(64.0), 1.0, S + 31.0);
  float pebble = smoothstep(0.10, 0.02, pv.x) * step(0.90, pv.z);
  float shell  = smoothstep(0.06, 0.01, pv.x) * step(0.965, pv.z);

  float h = 0.55 + dunes * 0.26;
  h += rip1 * 0.085 * rippleZone;
  h += rip2 * 0.032 * rippleZone;
  h += grain * 0.055;
  h += coarse * 0.045;
  h += pebble * 0.16 + shell * 0.10;

  float crest = satf(rip1 * 0.5 + 0.5);
  float damp  = smoothstep(0.62, 0.20, h);
  return vec4(satf(h), coarse + pebble, damp, crest);
}

vec3 matAlbedo(vec2 uv, vec4 p, float curv, float ao){
  float S = uSeed;
  float sparkle = p.g, damp = p.b;

  float tone = fbm01(uv * 5.0 + 7.0, vec2(5.0), 4, 0.5, S + 33.0);
  tone = satf(tone * 0.7 + fbm01(uv * 17.0 + 3.0, vec2(17.0), 4, 0.5, S + 43.0) * 0.42);
  vec3 sand = mix(vec3(0.512, 0.428, 0.300), vec3(0.660, 0.578, 0.428), tone);
  // mineral fines — dark iron/olivine streaks collect in the troughs
  float fines = smoothstep(0.55, 0.90, fbm01(uv * vec2(9.0, 14.0) + 21.0, vec2(9.0, 14.0), 4, 0.5, S + 37.0));
  sand = mix(sand, vec3(0.310, 0.266, 0.218), fines * damp * 0.62);

  vec4 pv = voronoi(uv * 64.0, vec2(64.0), 1.0, S + 31.0);
  float pebble = smoothstep(0.10, 0.02, pv.x) * step(0.90, pv.z);
  vec3 pebCol = mix(vec3(0.330, 0.312, 0.295), vec3(0.560, 0.508, 0.440), pv.z);
  sand = mix(sand, pebCol, pebble);

  sand = mix(sand, sand * 1.16 + 0.05, sparkle * 0.5);       // quartz glints
  sand *= mix(1.0, 0.72, damp * 0.7);                        // damp sand darkens
  sand *= mix(1.0, 0.62, satf(-curv * 6.0));
  sand *= mix(1.0, 0.84, 1.0 - ao);
  return sand;
}

vec4 matORM(vec2 uv, vec4 p, float curv, float ao){
  float sparkle = p.g, damp = p.b;
  float r = 0.965;
  r -= sparkle * 0.40;              // polished quartz + pebbles
  r -= damp * 0.14;
  r += fbm(uv * 300.0, vec2(300.0), 3, 0.5, uSeed + 41.0) * 0.03;
  return vec4(ao, clamp(r, 0.10, 1.0), 0.0, 1.0);
}
`;

const ROCK = /* glsl */`
vec4 matPattern(vec2 uv){
  float S = uSeed;

  // Bedding planes, folded by a low-frequency warp.
  vec2 sw = uv + vec2(fbm(uv * 3.0, vec2(3.0), 4, 0.5, S) * 0.26,
                      fbm(uv * 2.0, vec2(2.0), 4, 0.5, S + 5.0) * 0.11);
  vec4 st = splitAxis(sw.y, 6.0, 0.80, S + 11.0);
  float bandEdge = smoothstep(0.055, 0.0, st.z);
  // Vertical joints cut across the bedding — without them stratified rock
  // reads as a stack of stripes rather than as broken stone.
  vec2 jw = uv + vec2(fbm(uv * 4.0 + 7.0, vec2(4.0), 4, 0.5, S + 31.0) * 0.14, 0.0);
  vec4 jt = splitAxis(jw.x, 4.0, 0.85, S + 33.0);
  float joint = smoothstep(0.040, 0.0, jt.z)
              * smoothstep(0.35, 0.75, fbm01(uv * 2.0 + 41.0, vec2(2.0), 3, 0.5, S + 37.0));

  // Conchoidal fracture: nested voronoi cells each sitting on their own plane.
  vec4 c1 = voronoi(uv * 7.0,  vec2(7.0),  1.0, S + 13.0);
  vec4 c2 = voronoi(uv * 17.0, vec2(17.0), 1.0, S + 17.0);
  vec4 c3 = voronoi(uv * 43.0, vec2(43.0), 1.0, S + 19.0);
  float facet = (c1.z - 0.5) * 0.30 + (c2.z - 0.5) * 0.15 + (c3.z - 0.5) * 0.065;
  float chipEdge = smoothstep(0.055, 0.0, c2.y - c2.x) * 0.55
                 + smoothstep(0.030, 0.0, c3.y - c3.x) * 0.35;

  float crack = smoothstep(0.84, 1.0, ridged(uv * 6.0, vec2(6.0), 5, S + 23.0));
  float bumps = fbm(uv * 34.0, vec2(34.0), 4, 0.5, S + 29.0);
  float micro = fbm(uv * 260.0, vec2(260.0), 3, 0.5, S + 31.0);

  float h = 0.55 + facet;
  h += (st.y - 0.5) * 0.10;
  h -= bandEdge * 0.13;
  h -= joint * 0.17;
  h -= chipEdge * 0.10;
  h -= crack * 0.26;
  h += bumps * 0.070;
  h += micro * 0.028;

  float lichen = smoothstep(0.58, 0.86, fbm01(uv * 9.0 + 61.0, vec2(9.0), 5, 0.55, S + 43.0));
  return vec4(satf(h), st.y, lichen, satf(chipEdge + crack + joint * 0.6));
}

vec3 matAlbedo(vec2 uv, vec4 p, float curv, float ao){
  float S = uSeed;
  float band = p.g, lichen = p.b, fresh = p.a;

  vec3 c0 = vec3(0.232, 0.222, 0.208);
  vec3 c1 = vec3(0.342, 0.310, 0.264);
  vec3 c2 = vec3(0.412, 0.360, 0.288);
  vec3 c3 = vec3(0.162, 0.154, 0.152);
  vec3 base = mix(c0, c1, smoothstep(0.0, 0.45, band));
  base = mix(base, c2, smoothstep(0.45, 0.75, band));
  base = mix(base, c3, smoothstep(0.80, 1.0, band));

  float grain = fbm01(uv * 60.0, vec2(60.0), 4, 0.5, S + 47.0);
  base *= mix(0.86, 1.14, grain);
  // mineral speckle
  vec4 sp = voronoi(uv * 150.0, vec2(150.0), 1.0, S + 51.0);
  base = mix(base, vec3(0.660, 0.640, 0.605), smoothstep(0.20, 0.03, sp.x) * step(0.80, sp.z) * 0.6);
  base = mix(base, vec3(0.16, 0.16, 0.18), smoothstep(0.16, 0.03, sp.x) * step(0.93, sp.z) * 0.7);

  // freshly chipped faces are lighter and cleaner than the weathered skin
  base = mix(base, min(base * 1.26 + 0.035, vec3(1.0)), fresh * 0.35);

  // lichen prefers convex, sun-facing surfaces
  float lm = lichen * satf(0.35 + curv * 5.0);
  base = mix(base, mix(vec3(0.300, 0.330, 0.225), vec3(0.500, 0.512, 0.395), grain), lm * 0.58);

  base *= mix(1.0, 0.38, satf(-curv * 7.0));
  base *= mix(1.0, 0.78, 1.0 - ao);
  return base;
}

vec4 matORM(vec2 uv, vec4 p, float curv, float ao){
  float lichen = p.b, fresh = p.a;
  float r = mix(0.78, 0.94, fbm01(uv * 45.0, vec2(45.0), 3, 0.5, uSeed + 53.0));
  r -= fresh * 0.10;                    // fresh fracture faces are glassier
  r += lichen * 0.05;
  return vec4(ao, clamp(r, 0.20, 1.0), 0.0, 1.0);
}
`;

const GLASS = /* glsl */`
vec4 matPattern(vec2 uv){
  float S = uSeed;
  // float-glass draw waviness — very low amplitude, very low frequency
  float wave = fbm(uv * vec2(5.0, 2.0), vec2(5.0, 2.0), 3, 0.5, S) * 0.030;
  float smudge = smoothstep(0.42, 0.88, fbm01(uv * 8.0 + 3.0, vec2(8.0), 4, 0.5, S + 3.0));
  float wipe   = smoothstep(0.45, 0.85, fbm01(uv * vec2(3.0, 26.0), vec2(3.0, 26.0), 3, 0.55, S + 5.0));
  float dust   = smoothstep(0.74, 1.0, vnoise(uv * 240.0, vec2(240.0), S + 7.0));
  float scr    = scratches(uv, 7.0, 0.5, 0.0016, S + 11.0);
  vec4 cv = voronoi(uv * 30.0, vec2(30.0), 1.0, S + 13.0);
  float chip = smoothstep(0.06, 0.0, cv.x) * step(0.955, cv.z);
  // grime creeping in from the frame
  float border = 1.0 - smoothstep(0.0, 0.10, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));

  float h = 0.5 + wave;
  h += smudge * 0.006 + wipe * 0.004 + dust * 0.008;
  h -= scr * 0.020;
  h -= chip * 0.060;
  h -= border * 0.006;

  float dirt = satf(smudge * 0.55 + wipe * 0.45 + dust * 0.5 + border * 0.8);
  return vec4(satf(h), dirt, scr, chip);
}

vec3 matAlbedo(vec2 uv, vec4 p, float curv, float ao){
  float dirt = p.g, scr = p.b, chip = p.a;
  vec3 col = vec3(0.90, 0.945, 0.955);
  col = mix(col, vec3(0.68, 0.68, 0.64), dirt * 0.35);
  col = mix(col, vec3(1.0), scr * 0.6);
  col = mix(col, vec3(0.94, 0.97, 0.99), chip * 0.8);
  return col;
}

vec4 matORM(vec2 uv, vec4 p, float curv, float ao){
  float dirt = p.g, scr = p.b, chip = p.a;
  float r = 0.035 + dirt * 0.30 + scr * 0.35 + chip * 0.45;
  return vec4(mix(1.0, ao, 0.4), clamp(r, 0.01, 1.0), 0.0, 1.0);
}
`;

const WOOD = /* glsl */`
vec4 woodPlank(vec2 uv){
  // x = across-plank 0..1, y = plank id, z = edge distance, w = integer offset
  vec4 pk = splitAxis(uv.y, 5.0, 0.55, uSeed + 3.0);
  return vec4(pk.x, pk.y, pk.z, floor(pk.y * 7.0));
}

float woodRings(vec2 uv, vec4 pk, out float knot, out float fibre){
  float S = uSeed;
  float po = pk.w;
  // knots: rare voronoi sites inside the plank
  vec4 kv = voronoi(vec2(uv.x * 5.0, pk.x * 2.0), vec2(5.0, 2.0), 1.0, S + po);
  float sel = step(0.84, kv.z);
  knot = smoothstep(0.26, 0.04, kv.x) * sel;
  float knotHalo = smoothstep(0.55, 0.10, kv.x) * sel;

  float w = fbm(vec2(uv.x * 6.0 + po, pk.x * 3.0), vec2(6.0, 3.0), 4, 0.5, S + po) * 0.62;
  float ringN = 6.0 + floor(hash12(vec2(po, S)) * 6.0);   // ring density per board
  float rc = pk.x * ringN + w + uv.x * 2.0 + knotHalo * 3.4;
  float rings = fract(rc);
  // latewood is a narrow dark dense band
  float late = smoothstep(0.72, 0.90, rings) * smoothstep(1.0, 0.92, rings);
  late = max(late, smoothstep(0.90, 0.99, rings));
  fibre = fbm01(vec2(uv.x * 560.0 + po * 37.0, pk.x * 34.0), vec2(560.0, 34.0), 3, 0.55, S + po * 3.0);
  return late;
}

vec4 matPattern(vec2 uv){
  float S = uSeed;
  vec4 pk = woodPlank(uv);
  float knot, fibre;
  float late = woodRings(uv, pk, knot, fibre);

  float gap   = smoothstep(0.040, 0.005, pk.z);
  float bevel = smoothstep(0.100, 0.040, pk.z);
  float saw   = fbm01(vec2(uv.x * 3.0, uv.y * 90.0), vec2(3.0, 90.0), 2, 0.5, S + 13.0);
  float dent  = fbm(uv * 24.0, vec2(24.0), 4, 0.5, S + 17.0);
  float scr   = scratches(uv, 10.0, 0.45, 0.0020, S + 19.0);
  float splinter = smoothstep(0.80, 0.97, fbm01(uv * vec2(120.0, 30.0), vec2(120.0, 30.0), 3, 0.55, S + 23.0))
                 * smoothstep(0.16, 0.02, pk.z);

  float h = 0.62;
  h += (pk.y - 0.5) * 0.045;
  h -= late * 0.055;                 // earlywood erodes proud of latewood... inverted on purpose:
  h += (1.0 - late) * 0.0;           // keep the dark bands recessed for readable grain
  h -= fibre * 0.028;
  h -= gap * 0.40 + bevel * 0.055;
  h -= knot * 0.10;
  h += smoothstep(0.35, 0.15, knot) * knot * 0.06;
  h += dent * 0.045;
  h -= scr * 0.05;
  h -= splinter * 0.07;
  h += (saw - 0.5) * 0.014;

  return vec4(satf(h), late, knot, pk.y);
}

vec3 matAlbedo(vec2 uv, vec4 p, float curv, float ao){
  float S = uSeed;
  vec4 pk = woodPlank(uv);
  float knot, fibre;
  float late = woodRings(uv, pk, knot, fibre);
  float plankId = p.a;

  vec3 early = vec3(0.505, 0.362, 0.222);
  vec3 lateC = vec3(0.268, 0.170, 0.098);
  vec3 col = mix(early, lateC, late * 0.9);
  col *= mix(0.80, 1.14, fibre);
  // plank-to-plank variation: different boards, cut from different trees
  col *= mix(0.66, 1.24, plankId);
  col = mix(col, col * vec3(1.10, 0.94, 0.80), smoothstep(0.55, 1.0, plankId) * 0.5);
  col = mix(col, col * vec3(0.88, 0.92, 1.02), smoothstep(0.45, 0.0, plankId) * 0.5);
  // weathered grey and ingrained dirt along the boards
  float grime = smoothstep(0.48, 0.92, fbm01(vec2(uv.x * 8.0, pk.x * 4.0) + 33.0, vec2(8.0, 4.0), 4, 0.5, S + 41.0));
  col = mix(col, vec3(0.205, 0.178, 0.150), grime * 0.42);

  // knots are dark and resinous with a bright halo of compressed grain
  col = mix(col, vec3(0.160, 0.092, 0.050), smoothstep(0.15, 0.75, knot));

  // sun bleaching on the exposed faces, grime in the gaps
  float bleach = smoothstep(0.45, 0.9, fbm01(uv * 4.0 + 7.0, vec2(4.0), 4, 0.5, S + 29.0));
  col = mix(col, mix(col, vec3(0.520, 0.487, 0.437), 0.55), bleach * 0.45 * satf(0.4 + curv * 4.0));

  float scr = scratches(uv, 10.0, 0.45, 0.0020, S + 19.0);
  col = mix(col, col * 1.25 + 0.04, scr * 0.5);

  col *= mix(1.0, 0.35, satf(-curv * 7.0));
  col *= mix(1.0, 0.78, 1.0 - ao);
  return col;
}

vec4 matORM(vec2 uv, vec4 p, float curv, float ao){
  float late = p.g, knot = p.b;
  float r = mix(0.82, 0.62, late);           // dense latewood takes a polish
  r = mix(r, 0.45, smoothstep(0.2, 0.8, knot));
  r += fbm(uv * vec2(200.0, 40.0), vec2(200.0, 40.0), 3, 0.5, uSeed + 31.0) * 0.06;
  r -= satf(curv * 4.0) * 0.08;              // handled edges burnish
  return vec4(ao, clamp(r, 0.15, 1.0), 0.0, 1.0);
}
`;

const GRASS = /* glsl */`
// One blade layer: nearest oriented, bent line segment in a 3x3 neighbourhood.
float grassBlades(vec2 uv, float freq, float len, float wid, float seed, out float id){
  vec2 p = uv * freq;
  vec2 ip = floor(p), fp = fract(p);
  float best = 0.0; id = 0.0;
  for (int j = -1; j <= 1; j++){
    for (int i = -1; i <= 1; i++){
      vec2 g = vec2(float(i), float(j));
      vec2 cell = wrapCell(ip + g, vec2(freq), seed);
      vec3 h = hash32(cell);
      vec2 base = g + vec2(h.x, h.y);
      float ang = h.z * 2.0 * MAT_PI;
      vec2 dir = vec2(cos(ang), sin(ang));
      vec2 d = fp - base;
      float t = clamp(dot(d, dir), 0.0, len);
      // bend it, so it is a blade and not a matchstick
      vec2 bend = vec2(-dir.y, dir.x) * (t * t) * (h.x - 0.5) * 1.9;
      float dist = length(d - dir * t - bend);
      float w = wid * (1.0 - (t / len) * 0.80);
      float v = smoothstep(w, w * 0.15, dist);
      if (v > best){ best = v; id = hash12(cell + 3.1); }
    }
  }
  return best;
}

vec4 matPattern(vec2 uv){
  float S = uSeed;
  float soil  = fbm(uv * 14.0, vec2(14.0), 5, 0.5, S + 3.0);
  float clump = fbm01(uv * 6.0, vec2(6.0), 4, 0.5, S + 5.0);

  // Three blade grades. Ground cover has to actually COVER the ground —
  // one sparse layer over dirt just reads as dirt with green freckles.
  float idA, idB, idC;
  float bA = grassBlades(uv, 24.0, 0.92, 0.215, S + 7.0,  idA);
  float bB = grassBlades(uv, 48.0, 0.82, 0.170, S + 11.0, idB);
  float bC = grassBlades(uv, 92.0, 0.72, 0.135, S + 13.0, idC);
  float blade = max(max(bA, bB * 0.92), bC * 0.82);
  float bid = bA > bB * 0.92 ? idA : (bB * 0.92 > bC * 0.82 ? idB : idC);

  float bald = smoothstep(0.70, 0.92, fbm01(uv * 4.0 + 31.0, vec2(4.0), 4, 0.5, S + 17.0));
  blade *= (1.0 - bald * 0.88) * mix(0.72, 1.20, clump);

  // broad-leaf weeds pushing through
  vec4 lv = voronoi(uv * 16.0, vec2(16.0), 1.0, S + 19.0);
  float leaf = smoothstep(0.20, 0.06, lv.x) * step(0.86, lv.z);

  float h = 0.34 + soil * 0.12;
  h += clump * 0.11;
  h += blade * 0.36;
  h += leaf * 0.13;
  h += fbm(uv * 200.0, vec2(200.0), 3, 0.5, S + 23.0) * 0.02;

  float dry = smoothstep(0.60, 0.94, fbm01(uv * 4.0 + 51.0, vec2(4.0), 4, 0.5, S + 29.0));
  return vec4(satf(h), satf(blade), bid, satf(dry * 0.80 + bald * 0.45));
}

vec3 matAlbedo(vec2 uv, vec4 p, float curv, float ao){
  float S = uSeed;
  float blade = p.g, bid = p.b, dry = p.a;

  float soilN = fbm01(uv * 18.0, vec2(18.0), 4, 0.5, S + 29.0);
  vec3 soil   = mix(vec3(0.150, 0.113, 0.076), vec3(0.262, 0.208, 0.145), soilN);
  // Between the standing blades is matted dead thatch, not bare earth.
  vec3 thatch = mix(vec3(0.168, 0.152, 0.088), vec3(0.288, 0.262, 0.142), soilN);
  vec3 under  = mix(thatch, soil, smoothstep(0.35, 0.9, dry));

  vec3 gDark = vec3(0.118, 0.212, 0.070);
  vec3 gMid  = vec3(0.205, 0.352, 0.108);
  vec3 gLite = vec3(0.330, 0.470, 0.152);
  vec3 gDry  = vec3(0.430, 0.392, 0.176);
  vec3 gYel  = vec3(0.512, 0.492, 0.220);

  vec3 gc = mix(gDark, gMid, smoothstep(0.0, 0.5, bid));
  gc = mix(gc, gLite, smoothstep(0.5, 1.0, bid));
  gc = mix(gc, mix(gDry, gYel, bid), dry * 0.80);
  // per-blade shading along its length keeps the mat from going poster-flat
  gc *= mix(0.72, 1.12, fbm01(uv * 90.0, vec2(90.0), 3, 0.5, S + 37.0));

  vec3 col = mix(under, gc, smoothstep(0.015, 0.28, blade));
  col *= mix(0.66, 1.12, satf(0.5 + curv * 5.0));       // self-shadowing between blades
  col *= mix(1.0, 0.55, 1.0 - ao);
  return col;
}

vec4 matORM(vec2 uv, vec4 p, float curv, float ao){
  float blade = p.g, dry = p.a;
  float r = mix(0.94, 0.60, smoothstep(0.05, 0.5, blade));   // waxy cuticle on the blades
  r = mix(r, 0.90, dry * 0.7);
  return vec4(ao * ao, clamp(r, 0.15, 1.0), 0.0, 1.0);
}
`;

const WATER = /* glsl */`
vec4 matPattern(vec2 uv){
  float S = uSeed;
  float w1 = fbm(uv * 3.0, vec2(3.0), 3, 0.5, S) * 0.55;
  float ph1 = (uv.x * 2.0 + uv.y * 3.0) + w1;
  float s1 = sin(ph1 * 2.0 * MAT_PI);

  float w2 = fbm(uv * 5.0, vec2(5.0), 3, 0.5, S + 7.0) * 0.75;
  float ph2 = (uv.x * 7.0 - uv.y * 5.0) + w2;
  float s2 = sin(ph2 * 2.0 * MAT_PI);

  float w3 = fbm(uv * 9.0, vec2(9.0), 3, 0.5, S + 11.0) * 0.9;
  float ph3 = (uv.x * 13.0 + uv.y * 11.0) + w3;
  float s3 = sin(ph3 * 2.0 * MAT_PI);

  float cap = fbm(uv * 110.0, vec2(110.0), 4, 0.55, S + 13.0);
  float micro = fbm(uv * 400.0, vec2(400.0), 3, 0.5, S + 17.0);

  float h = 0.5 + s1 * 0.16 + s2 * 0.085 + s3 * 0.042 + cap * 0.055 + micro * 0.016;

  float crest = satf((s1 * 0.5 + 0.5) * 0.6 + (s2 * 0.5 + 0.5) * 0.4);
  float foam = smoothstep(0.72, 0.95, crest)
             * smoothstep(0.40, 0.85, fbm01(uv * 26.0, vec2(26.0), 4, 0.55, S + 19.0));
  return vec4(satf(h), foam, crest, cap * 0.5 + 0.5);
}

vec3 matAlbedo(vec2 uv, vec4 p, float curv, float ao){
  float foam = p.g, crest = p.b;
  vec3 deep = vec3(0.055, 0.140, 0.185);
  vec3 shallow = vec3(0.110, 0.290, 0.330);
  vec3 col = mix(deep, shallow, crest);
  // suspended silt / algae
  col = mix(col, vec3(0.130, 0.235, 0.190),
            smoothstep(0.45, 0.85, fbm01(uv * 6.0 + 3.0, vec2(6.0), 4, 0.5, uSeed + 23.0)) * 0.35);
  col = mix(col, vec3(0.88, 0.92, 0.93), foam * 0.85);
  return col;
}

vec4 matORM(vec2 uv, vec4 p, float curv, float ao){
  float foam = p.g;
  float r = 0.045 + foam * 0.72;
  r += fbm01(uv * 80.0, vec2(80.0), 3, 0.5, uSeed + 29.0) * 0.03;
  return vec4(mix(1.0, ao, 0.35), clamp(r, 0.02, 1.0), mix(0.10, 0.0, foam), 1.0);
}
`;

const FLESH = /* glsl */`
vec4 matPattern(vec2 uv){
  float S = uSeed;
  vec4 pv = voronoi(uv * 150.0, vec2(150.0), 1.0, S + 3.0);
  float pore = smoothstep(0.30, 0.08, pv.x) * step(0.35, pv.z);

  // dermal ridges / wrinkles at two scales
  float wrinkle = ridged(uv * 26.0, vec2(26.0), 3, S + 7.0);
  float creases = smoothstep(0.06, 0.0, voronoiEdge(warp(uv * 9.0, vec2(9.0), 0.5, 3, S + 11.0),
                                                    vec2(9.0), 1.0, S + 13.0));

  // subcutaneous veins: branching, slightly raised
  vec2 vw = warp(uv * 4.0, vec2(4.0), 0.85, 4, S + 17.0);
  float vein = smoothstep(0.045, 0.0, voronoiEdge(vw, vec2(4.0), 1.0, S + 19.0));
  vein *= smoothstep(0.35, 0.80, fbm01(uv * 3.0 + 9.0, vec2(3.0), 3, 0.5, S + 23.0));

  float mottle = fbm(uv * 7.0, vec2(7.0), 5, 0.5, S + 29.0);
  float fibre  = fbm(uv * 180.0, vec2(180.0), 3, 0.5, S + 31.0);

  float h = 0.55 + mottle * 0.10;
  h -= pore * 0.14;
  h -= creases * 0.09;
  h += (wrinkle - 0.5) * 0.055;
  h += vein * 0.075;
  h += fibre * 0.022;

  float blood = smoothstep(0.50, 0.90, fbm01(uv * 5.0 + 41.0, vec2(5.0), 4, 0.5, S + 37.0));
  return vec4(satf(h), vein, blood, mottle * 0.5 + 0.5);
}

vec3 matAlbedo(vec2 uv, vec4 p, float curv, float ao){
  float vein = p.g, blood = p.b, mottle = p.a;
  vec3 pale = vec3(0.612, 0.455, 0.382);
  vec3 flush = vec3(0.588, 0.292, 0.240);
  vec3 deep  = vec3(0.392, 0.148, 0.130);
  vec3 col = mix(pale, flush, smoothstep(0.30, 0.80, mottle));
  col = mix(col, deep, blood * 0.55);
  // veins read blue-violet through the dermis, not as dark lines
  col = mix(col, vec3(0.360, 0.310, 0.420), vein * 0.42);
  // freckling / pigment
  col *= mix(0.90, 1.06, fbm01(uv * 60.0, vec2(60.0), 4, 0.5, uSeed + 43.0));
  col *= mix(1.0, 0.60, satf(-curv * 6.0));
  col *= mix(1.0, 0.82, 1.0 - ao);
  return col;
}

vec4 matORM(vec2 uv, vec4 p, float curv, float ao){
  float blood = p.b;
  float r = mix(0.58, 0.42, satf(curv * 5.0));    // sebum sheen on the high points
  r += fbm(uv * 120.0, vec2(120.0), 3, 0.5, uSeed + 47.0) * 0.10;
  r -= blood * 0.08;
  return vec4(ao, clamp(r, 0.18, 1.0), 0.0, 1.0);
}
`;

const RUBBER = /* glsl */`
vec4 matPattern(vec2 uv){
  float S = uSeed;
  // moulded pebble grain
  vec4 pv = voronoi(uv * 120.0, vec2(120.0), 1.0, S + 3.0);
  float pebble = smoothstep(0.42, 0.10, pv.x);
  vec4 pv2 = voronoi(uv * 300.0, vec2(300.0), 1.0, S + 5.0);
  float pebble2 = smoothstep(0.40, 0.12, pv2.x);

  float peel = fbm(uv * 45.0, vec2(45.0), 4, 0.5, S + 7.0);
  // mould parting line + ejector-pin marks
  float part = smoothstep(0.0035, 0.0, abs(fract(uv.y * 2.0) - 0.5));
  vec2 ej = fract(uv * 4.0 + 0.25) - 0.5;
  float pin = smoothstep(0.085, 0.055, length(ej));

  float scuff = smoothstep(0.58, 0.92, fbm01(uv * 14.0, vec2(14.0), 4, 0.5, S + 11.0));
  float scr = scratches(uv, 7.0, 0.4, 0.0030, S + 13.0);
  float dust = smoothstep(0.55, 0.92, fbm01(uv * 26.0 + 7.0, vec2(26.0), 3, 0.5, S + 17.0));

  float h = 0.58;
  h += pebble * 0.11 + pebble2 * 0.05;
  h += peel * 0.035;
  h += part * 0.045;
  h -= pin * 0.030;
  h -= scr * 0.030;
  h -= scuff * 0.012;

  return vec4(satf(h), scuff, dust, pebble);
}

vec3 matAlbedo(vec2 uv, vec4 p, float curv, float ao){
  float scuff = p.g, dust = p.b;
  // Carbon-black rubber: dark but never 0 — pure black reads as a hole.
  vec3 col = vec3(0.135, 0.140, 0.150);
  col *= mix(0.86, 1.10, fbm01(uv * 30.0, vec2(30.0), 4, 0.5, uSeed + 23.0));
  col = mix(col, vec3(0.222, 0.218, 0.212), scuff * 0.55);     // abraded rubber greys out
  col = mix(col, vec3(0.290, 0.272, 0.246), dust * 0.30);
  col *= mix(1.0, 0.60, satf(-curv * 6.0));
  col *= mix(1.0, 0.80, 1.0 - ao);
  return col;
}

vec4 matORM(vec2 uv, vec4 p, float curv, float ao){
  float scuff = p.g, dust = p.b;
  float r = 0.93 + fbm(uv * 70.0, vec2(70.0), 3, 0.5, uSeed + 29.0) * 0.05;
  r += scuff * 0.05;
  r += dust * 0.03;
  r -= satf(curv * 4.0) * 0.10;                 // polished contact faces
  return vec4(ao, clamp(r, 0.45, 1.0), 0.0, 1.0);
}
`;

const PLASTIC = /* glsl */`
// Injection-moulded parts are made of REGIONS: polished gate faces, a matte
// moulded-in grain panel, a parting line where the tool halves met. A single
// uniform noise over the whole part is what makes plastic look like nothing.
float plasticZone(vec2 uv){
  vec2 w = warp(uv * 3.0, vec2(3.0), 0.30, 3, uSeed + 7.0);
  return smoothstep(0.46, 0.54, fbm01(w, vec2(3.0), 3, 0.5, uSeed + 7.0));
}

vec4 matPattern(vec2 uv){
  float S = uSeed;
  float peel  = fbm(uv * 40.0, vec2(40.0), 4, 0.5, S);            // orange peel
  float micro = fbm(uv * 380.0, vec2(380.0), 3, 0.5, S + 3.0);

  // moulded grain: fine pebbled cells, sharp-edged where the tool was etched
  vec4 sv = voronoi(uv * 190.0, vec2(190.0), 1.0, S + 6.0);
  float stipple = smoothstep(0.46, 0.10, sv.x);
  vec4 sv2 = voronoi(uv * 420.0, vec2(420.0), 1.0, S + 8.0);
  stipple = satf(stipple * 0.75 + smoothstep(0.42, 0.12, sv2.x) * 0.45);
  float zone = plasticZone(uv);

  vec4 pl = splitAxis(uv.x, 2.0, 0.20, S + 9.0);
  float parting = smoothstep(0.006, 0.0, pl.z);
  float sink = smoothstep(0.55, 0.90, fbm01(uv * 6.0 + 13.0, vec2(6.0), 3, 0.5, S + 11.0));
  float scr = scratches(uv, 11.0, 0.55, 0.0020, S + 13.0);
  float scuff = smoothstep(0.58, 0.90, fbm01(uv * 20.0, vec2(20.0), 4, 0.5, S + 17.0));
  float dust = smoothstep(0.55, 0.92, fbm01(uv * 30.0 + 5.0, vec2(30.0), 3, 0.5, S + 19.0));

  float h = 0.60;
  h += peel * 0.020;
  h += micro * 0.010;
  h += stipple * zone * 0.150;                 // the grain has real depth
  h -= smoothstep(0.0, 0.04, zone) * smoothstep(0.10, 0.04, zone) * 0.05;  // etched step
  h += parting * 0.045;
  h -= sink * 0.022;
  h -= scr * 0.040;
  h -= scuff * 0.010;

  return vec4(satf(h), scuff, dust, zone * stipple);
}

vec3 matAlbedo(vec2 uv, vec4 p, float curv, float ao){
  float S = uSeed;
  float scuff = p.g, dust = p.b, tex = p.a;
  float zone = plasticZone(uv);

  vec3 col = vec3(0.492, 0.505, 0.525);
  col *= mix(0.90, 1.08, fbm01(uv * 12.0, vec2(12.0), 3, 0.5, S + 23.0));
  // glass-filled speckle in the resin
  col = mix(col, col * 0.74, smoothstep(0.78, 1.0, vnoise(uv * 300.0, vec2(300.0), S + 29.0)) * 0.55);
  // the matte grain panel reads darker than the polished areas
  col *= mix(1.0, 0.80, zone);
  col = mix(col, col * 0.86, tex * 0.55);

  float scr = scratches(uv, 11.0, 0.55, 0.0020, S + 13.0);
  col = mix(col, min(col * 1.45 + 0.09, vec3(1.0)), scr * 0.65);    // stress-whitened gouges
  col = mix(col, col * 0.86 + vec3(0.030, 0.028, 0.024), dust * 0.55);
  col = mix(col, col * 0.84, scuff * 0.45);
  col *= mix(1.0, 0.52, satf(-curv * 6.0));
  col *= mix(1.0, 0.80, 1.0 - ao);
  return col;
}

vec4 matORM(vec2 uv, vec4 p, float curv, float ao){
  float scuff = p.g, dust = p.b, tex = p.a;
  float zone = plasticZone(uv);
  // Polished tool face vs etched grain: a big roughness split is the whole
  // reason a moulded part reads as moulded.
  float r = mix(0.22, 0.72, zone);
  r += tex * 0.16;
  r += scuff * 0.22 + dust * 0.16;
  r += fbm(uv * 60.0, vec2(60.0), 3, 0.5, uSeed + 31.0) * 0.05;
  r -= satf(curv * 4.0) * 0.06;
  return vec4(ao, clamp(r, 0.08, 1.0), 0.0, 1.0);
}
`;

export const SURFACE_GLSL = {
  concrete: CONCRETE,
  metal: METAL,
  painted_metal: PAINTED_METAL,
  sand: SAND,
  rock: ROCK,
  glass: GLASS,
  wood: WOOD,
  grass: GRASS,
  water: WATER,
  flesh: FLESH,
  rubber: RUBBER,
  plastic: PLASTIC,
};

/**
 * Shared micro-detail source. One 512² texture used by every surface as the
 * second, high-frequency normal/grunge layer that keeps big walls from
 * dissolving into blur at 20 cm.
 */
export const DETAIL_GLSL = /* glsl */`
vec4 matPattern(vec2 uv){
  float S = uSeed;
  float g1 = fbm(uv * 90.0,  vec2(90.0),  4, 0.55, S);
  float g2 = fbm(uv * 240.0, vec2(240.0), 3, 0.55, S + 3.0);
  vec4 cv = voronoi(uv * 130.0, vec2(130.0), 1.0, S + 5.0);
  float cell = smoothstep(0.42, 0.06, cv.x);
  float speck = smoothstep(0.86, 1.0, vnoise(uv * 420.0, vec2(420.0), S + 7.0));
  float h = 0.5 + g1 * 0.30 + g2 * 0.22 + (cell - 0.35) * 0.16 + speck * 0.10;
  float grunge = satf(0.5 + fbm(uv * 40.0, vec2(40.0), 4, 0.5, S + 11.0) * 0.55 + (cell - 0.4) * 0.25);
  return vec4(satf(h), grunge, 0.0, 0.0);
}
vec3 matAlbedo(vec2 uv, vec4 p, float curv, float ao){ return vec3(p.g); }
vec4 matORM(vec2 uv, vec4 p, float curv, float ao){ return vec4(ao, p.g, 0.0, 1.0); }
`;

export default SURFACE_GLSL;
