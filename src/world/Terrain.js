import * as THREE from 'three';
import { makeNoise2D, fbm2D } from '../core/Rand.js';
import { PADS, ROADS, MAP_RADIUS, FAR_RADIUS, wadiCenter, segDist, smoothstep } from './Layout.js';

/**
 * Heightfield terrain.
 *
 * The landform is a seeded fbm bowl: a flat-ish basin the playspace sits in,
 * rising into ridges that close the horizon so the map reads as a valley
 * rather than a plane with props on it. Building pads and road spines are
 * carved into the *height function itself*, so architecture never floats and
 * roads never cut across a slope.
 *
 * Shading is a three-way splat (sand / dry grass / rock). Rock is projected
 * triplanar so cliffs and cut faces have zero UV stretching; the two ground
 * layers use a world-space planar projection, which is both cheaper and
 * correct for near-horizontal surfaces. All three get a micro-detail layer
 * that fades in over the last few metres, which is what stops the ground
 * turning to mush when you walk up to it.
 */

/* -------------------------------------------------------------- height -- */

export function makeHeightField(seed) {
  const n1 = makeNoise2D(seed);
  const n2 = makeNoise2D((seed ^ 0x9e3779b9) >>> 0);
  const n3 = makeNoise2D((seed * 7 + 131) >>> 0);

  const gauss = (dx, dz, r) => Math.exp(-(dx * dx + dz * dz) / (r * r));

  /** Raw landform before any human intervention. */
  function land(x, z) {
    const r = Math.hypot(x * 0.96, z * 1.06);
    const bowl = smoothstep(150, 340, r);

    // Large landform + a ridged component so the skyline has spines, not blobs.
    const broad = fbm2D(n1, x * 0.00215, z * 0.00215, 5);
    const ridged = 1.0 - Math.abs(fbm2D(n2, x * 0.0034, z * 0.0034, 4)) * 2.4;

    let h = bowl * (30 + broad * 58 + Math.max(ridged, -0.4) * 26);

    // Basin floor: gentle, walkable undulation only.
    h += (1 - bowl) * (fbm2D(n1, x * 0.0075, z * 0.0075, 3) * 6.2 - 1.4);

    // Mid-frequency relief everywhere. Deliberately capped at ~25 m
    // wavelength so a 3.7 m collision mesh still tracks the visual surface.
    h += fbm2D(n3, x * 0.021, z * 0.021, 3) * (1.1 + 2.6 * bowl);

    // Named landmarks in the terrain itself.
    h += gauss(x - 196, z - 6, 108) * 30;      // Relay Spire mesa (east)
    h += gauss(x + 150, z + 250, 190) * 62;    // north-west massif
    h += gauss(x - 60, z + 330, 210) * 54;     // north wall
    h += gauss(x - 320, z - 210, 190) * 58;    // south-east buttes
    h -= gauss(x + 40, z - 40, 120) * 6;       // basin dish

    // Wadi channel: cut only inside the basin, fading out at the ridges.
    const cx = wadiCenter(z);
    const across = Math.abs(x - cx);
    const chan = (1 - smoothstep(9, 30, across)) * (1 - smoothstep(150, 260, Math.abs(z)));
    if (chan > 0) {
      const bed = -3.9 + fbm2D(n2, x * 0.04, z * 0.04, 2) * 0.9;
      h = h * (1 - chan) + bed * chan;
    }
    return h;
  }

  /** Landform + flattened building pads. */
  function padded(x, z) {
    let h = land(x, z);
    for (let i = 0; i < PADS.length; i++) {
      const p = PADS[i];
      const dx = Math.max(Math.abs(x - p.x) - p.hw, 0);
      const dz = Math.max(Math.abs(z - p.z) - p.hd, 0);
      const d = Math.hypot(dx, dz);
      const w = 1 - smoothstep(0, p.blend, d);
      if (w > 0) h = h * (1 - w) + p.y * w;
    }
    return h;
  }

  const _cp = { x: 0, z: 0, t: 0 };

  /** Final surface: pads plus road corridors levelled across their width. */
  function height(x, z) {
    let h = padded(x, z);
    for (let r = 0; r < ROADS.length; r++) {
      const road = ROADS[r];
      const pts = road.pts;
      const half = road.width * 0.5;
      const feather = half + 9;
      let best = Infinity, bx = 0, bz = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const d = segDist(x, z, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], _cp);
        if (d < best) { best = d; bx = _cp.x; bz = _cp.z; }
      }
      if (best < feather) {
        const w = 1 - smoothstep(half * 0.85, feather, best);
        if (w > 0) h = h * (1 - w) + padded(bx, bz) * w;
      }
    }
    return h;
  }

  /** Analytic-ish normal via central differences. */
  const normal = (x, z, out = new THREE.Vector3(), e = 1.2) => {
    const hl = height(x - e, z), hr = height(x + e, z);
    const hd = height(x, z - e), hu = height(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  };

  return { height, normal, land, padded };
}

/* ------------------------------------------------------------- material -- */

const TERRAIN_VERT_PARS = /* glsl */`
varying vec3 vTerrWPos;
varying vec3 vTerrWNrm;
`;

const TERRAIN_FRAG_PARS = /* glsl */`
uniform sampler2D tRockA; uniform sampler2D tRockN; uniform sampler2D tRockO;
uniform sampler2D tGrassA; uniform sampler2D tGrassN; uniform sampler2D tGrassO;
uniform sampler2D tTerrDetail;
uniform vec4 uTerrScale;    // sand, rock, grass, detail  (tiles per metre)
uniform vec4 uTerrMix;      // slopeStart, slopeEnd, grassLow, grassHigh
uniform vec3 uSandTint;
uniform vec3 uRockTint;
uniform vec3 uGrassTint;
uniform vec2 uTerrFade;     // detail fade start / end
varying vec3 vTerrWPos;
varying vec3 vTerrWNrm;

vec3 terrWhiteoutY(vec3 tn, vec3 gn) {
  vec3 w = vec3(tn.xy + gn.xz, abs(tn.z) * gn.y);
  return normalize(w.xzy);
}
`;

/**
 * The splat itself. Written as one block injected at <map_fragment>; the
 * later chunks just read the values it leaves behind.
 */
const TERRAIN_SPLAT = /* glsl */`
  vec3 tG = normalize(vTerrWNrm);
  float tDist = length(vViewPosition);
  float tFade = 1.0 - smoothstep(uTerrFade.x, uTerrFade.y, tDist);

  // Macro breakup: two very low frequency octaves kill the tiling repeat that
  // otherwise gives a big terrain away instantly.
  float macro = texture2D(tTerrDetail, vTerrWPos.xz * 0.0017).a;
  float macro2 = texture2D(tTerrDetail, vTerrWPos.xz * 0.0068 + 0.37).a;
  float breakup = mix(0.80, 1.24, macro) * mix(0.90, 1.10, macro2);

  float slope = 1.0 - clamp(tG.y, 0.0, 1.0);
  float rockW = smoothstep(uTerrMix.x, uTerrMix.y, slope + (macro2 - 0.5) * 0.24);
  // Bare rock also pokes through on the ridges.
  rockW = max(rockW, smoothstep(34.0, 62.0, vTerrWPos.y) * (0.45 + 0.55 * macro2));
  rockW = clamp(rockW, 0.0, 1.0);

  float grassW = smoothstep(uTerrMix.z, uTerrMix.w, macro) *
                 (1.0 - smoothstep(16.0, 40.0, vTerrWPos.y)) *
                 (1.0 - smoothstep(0.10, 0.34, slope));
  grassW = clamp(grassW * 1.35, 0.0, 1.0) * (1.0 - rockW);

  // --- ground layers: world planar projection -------------------------
  vec2 uvS = vTerrWPos.xz * uTerrScale.x;
  vec4 aSand = texture2D(map, uvS);
  vec3 nSand = texture2D(normalMap, uvS).xyz * 2.0 - 1.0;
  vec4 oSand = texture2D(roughnessMap, uvS);

  vec3 albedo = aSand.rgb * uSandTint;
  vec3 tanN = nSand;
  vec2 rough = oSand.gr;

  if (grassW > 0.004) {
    vec2 uvG = vTerrWPos.xz * uTerrScale.z;
    vec4 aG = texture2D(tGrassA, uvG);
    vec3 nG = texture2D(tGrassN, uvG).xyz * 2.0 - 1.0;
    vec4 oG = texture2D(tGrassO, uvG);
    albedo = mix(albedo, aG.rgb * uGrassTint, grassW);
    tanN = mix(tanN, nG, grassW);
    rough = mix(rough, oG.gr, grassW);
  }
  vec3 worldN = terrWhiteoutY(tanN, tG);

  // --- rock: triplanar, no stretching on cliffs -----------------------
  if (rockW > 0.004) {
    vec3 an = abs(tG);
    vec3 tw = pow(an, vec3(5.0));
    tw /= max(dot(tw, vec3(1.0)), 1e-4);
    float k = uTerrScale.y;
    vec2 uX = vTerrWPos.zy * k;
    vec2 uY = vTerrWPos.xz * k;
    vec2 uZ = vTerrWPos.xy * k;
    vec3 rA = texture2D(tRockA, uX).rgb * tw.x
            + texture2D(tRockA, uY).rgb * tw.y
            + texture2D(tRockA, uZ).rgb * tw.z;
    vec4 rO = texture2D(tRockO, uX) * tw.x
            + texture2D(tRockO, uY) * tw.y
            + texture2D(tRockO, uZ) * tw.z;
    vec3 tnX = texture2D(tRockN, uX).xyz * 2.0 - 1.0;
    vec3 tnY = texture2D(tRockN, uY).xyz * 2.0 - 1.0;
    vec3 tnZ = texture2D(tRockN, uZ).xyz * 2.0 - 1.0;
    vec3 wX = vec3(tnX.xy + tG.zy, abs(tnX.z) * tG.x);
    vec3 wY = vec3(tnY.xy + tG.xz, abs(tnY.z) * tG.y);
    vec3 wZ = vec3(tnZ.xy + tG.xy, abs(tnZ.z) * tG.z);
    vec3 rockN = normalize(wX.zyx * tw.x + wY.xzy * tw.y + wZ.xyz * tw.z);

    albedo = mix(albedo, rA * uRockTint, rockW);
    worldN = normalize(mix(worldN, rockN, rockW));
    rough = mix(rough, rO.gr, rockW);
  }

  // --- close-range detail --------------------------------------------
  if (tFade > 0.004) {
    vec2 uD = vTerrWPos.xz * uTerrScale.w;
    vec4 dt = texture2D(tTerrDetail, uD);
    albedo *= mix(1.0, mix(0.72, 1.30, dt.a), tFade * 0.85);
    vec3 dn = dt.xyz * 2.0 - 1.0;
    worldN = normalize(worldN + vec3(dn.x, 0.0, dn.y) * tFade * 0.55);
    rough.x *= mix(1.0, mix(0.86, 1.16, dt.a), tFade);
    // A second, coarser pass of the same grain keeps the 1-5 m band alive.
    float d2 = texture2D(tTerrDetail, vTerrWPos.xz * uTerrScale.w * 0.21).a;
    albedo *= mix(1.0, mix(0.86, 1.14, d2), tFade);
  }

  albedo *= breakup;
  // Warm the sunward faces very slightly: dust settles unevenly.
  albedo *= mix(1.0, 1.06, clamp(tG.x * 0.5 + 0.5, 0.0, 1.0));

  diffuseColor.rgb *= albedo;
  float terrRough = clamp(rough.x, 0.05, 1.0);
  float terrAO = clamp(rough.y, 0.0, 1.0);
  vec3 terrNormal = normalize(mat3(viewMatrix) * worldN);
`;

/**
 * @param {object} Materials the material library singleton
 * @returns {THREE.MeshStandardMaterial}
 */
export function makeTerrainMaterial(Materials) {
  const sand = Materials.getTextures?.('sand');
  const rock = Materials.getTextures?.('rock');
  const grass = Materials.getTextures?.('grass');
  if (!sand || !rock || !grass) {
    // Library not forged (no renderer): stay plausible instead of breaking.
    return Materials.get('rock', { triplanar: true, triScale: 0.16 });
  }

  const mat = new THREE.MeshStandardMaterial({
    map: sand.albedo,
    normalMap: sand.normal,
    roughnessMap: sand.orm,
    aoMap: sand.orm,
    roughness: 1.0,
    metalness: 0.0,
    normalScale: new THREE.Vector2(1.0, 1.0),
  });
  mat.name = 'terrain';

  const u = {
    tRockA: { value: rock.albedo },
    tRockN: { value: rock.normal },
    tRockO: { value: rock.orm },
    tGrassA: { value: grass.albedo },
    tGrassN: { value: grass.normal },
    tGrassO: { value: grass.orm },
    tTerrDetail: { value: Materials.detailMap },
    uTerrScale: { value: new THREE.Vector4(0.085, 0.075, 0.115, 1.35) },
    uTerrMix: { value: new THREE.Vector4(0.20, 0.46, 0.50, 0.86) },
    uSandTint: { value: new THREE.Color(0xd8bf92) },
    uRockTint: { value: new THREE.Color(0x9a8f7f) },
    uGrassTint: { value: new THREE.Color(0x9aa06a) },
    uTerrFade: { value: new THREE.Vector2(7.0, 42.0) },
  };
  mat.userData.terrainUniforms = u;
  mat.userData.surface = 'sand';

  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    Object.assign(shader.uniforms, u);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${TERRAIN_VERT_PARS}`)
      .replace('#include <project_vertex>',
        '  vTerrWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#include <project_vertex>')
      .replace('#include <defaultnormal_vertex>',
        '#include <defaultnormal_vertex>\n  vTerrWNrm = normalize(mat3(modelMatrix) * objectNormal);');

    let fs = shader.fragmentShader
      .replace('#include <dithering_pars_fragment>',
        `#include <dithering_pars_fragment>\n${TERRAIN_FRAG_PARS}`)
      .replace('#include <map_fragment>', TERRAIN_SPLAT)
      .replace('#include <normal_fragment_maps>', '  normal = terrNormal;')
      .replace('#include <roughnessmap_fragment>', '  float roughnessFactor = roughness * terrRough;')
      .replace('#include <metalnessmap_fragment>', '  float metalnessFactor = metalness;')
      .replace('#include <aomap_fragment>', /* glsl */`
  float ambientOcclusion = (terrAO - 1.0) * aoMapIntensity + 1.0;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNVterr = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNVterr, ambientOcclusion, material.roughness );
  #endif
`);
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'terrain-splat-v2';
  mat.needsUpdate = true;
  return mat;
}

/* ------------------------------------------------------------- geometry -- */

/** Non-uniform axis: dense across the playspace, coarse out to the horizon. */
function buildAxis() {
  const inner = 192;
  const a = [];
  for (let i = 0; i <= inner; i++) a.push(-MAP_RADIUS + (2 * MAP_RADIUS * i) / inner);
  const outer = [420, 500, 620, 800, 1060, 1400, FAR_RADIUS];
  const head = outer.map((v) => -v).reverse();
  return head.concat(a, outer);
}

/**
 * Builds the visible terrain (one mesh, so it is one draw call per shadow
 * cascade) plus a matching inner mesh used for collision. Both sample the same
 * height function at the same points inside the playspace, so what you see is
 * exactly what you walk on.
 */
export function buildTerrain(field, material) {
  const axis = buildAxis();
  const n = axis.length;
  const verts = new Float32Array(n * n * 3);
  const norms = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);

  const nrm = new THREE.Vector3();
  for (let j = 0; j < n; j++) {
    const z = axis[j];
    for (let i = 0; i < n; i++) {
      const x = axis[i];
      const o = (j * n + i);
      const y = field.height(x, z);
      verts[o * 3] = x; verts[o * 3 + 1] = y; verts[o * 3 + 2] = z;
      field.normal(x, z, nrm, Math.max(1.2, Math.abs(x) > MAP_RADIUS ? 24 : 1.8));
      norms[o * 3] = nrm.x; norms[o * 3 + 1] = nrm.y; norms[o * 3 + 2] = nrm.z;
      uvs[o * 2] = x; uvs[o * 2 + 1] = z;
    }
  }

  const idx = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(norms, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(idx);
  geom.computeBoundingSphere();

  const mesh = new THREE.Mesh(geom, material);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.userData.surface = 'sand';

  /* ---- collision copy: playspace only, same samples ---- */
  const lo = axis.indexOf(-MAP_RADIUS);
  const hi = axis.indexOf(MAP_RADIUS);
  const cn = hi - lo + 1;
  const cv = new Float32Array(cn * cn * 3);
  for (let j = 0; j < cn; j++) {
    for (let i = 0; i < cn; i++) {
      const src = ((j + lo) * n + (i + lo)) * 3;
      const dst = (j * cn + i) * 3;
      cv[dst] = verts[src]; cv[dst + 1] = verts[src + 1]; cv[dst + 2] = verts[src + 2];
    }
  }
  const cidx = [];
  for (let j = 0; j < cn - 1; j++) {
    for (let i = 0; i < cn - 1; i++) {
      const a = j * cn + i, b = a + 1, c = a + cn, d = c + 1;
      cidx.push(a, c, b, b, c, d);
    }
  }
  const cgeom = new THREE.BufferGeometry();
  cgeom.setAttribute('position', new THREE.BufferAttribute(cv, 3));
  cgeom.setIndex(cidx);
  cgeom.computeBoundingSphere();
  const collider = new THREE.Mesh(cgeom);
  collider.name = 'terrain:collider';
  collider.userData.surface = 'sand';
  collider.visible = false;
  collider.matrixAutoUpdate = false;

  return { mesh, collider, triangles: (n - 1) * (n - 1) * 2 };
}

export default { makeHeightField, makeTerrainMaterial, buildTerrain };
