import * as THREE from 'three';

/**
 * onBeforeCompile surgery on MeshStandard/PhysicalMaterial.
 *
 * Adds three things three.js does not ship:
 *
 *  1. DETAIL TILING — a second high-frequency layer (a shared micro-grain
 *     normal/grunge map plus the surface's own maps re-tiled ~8x) blended in
 *     over the last few metres. This is the single biggest close-range win:
 *     without it a 12 m wall at 20 cm is a smear of magnified texels.
 *
 *  2. TRIPLANAR PROJECTION — world-space XYZ projection with a whiteout normal
 *     blend, so cliffs and terrain have no UV stretching. Applied to albedo,
 *     normal, roughness, metalness and AO consistently.
 *
 *  3. MASKED TINT — `opts.color` is applied through a mask baked into the
 *     albedo alpha, so tinting painted metal recolours the paint and leaves
 *     the rust and bare steel showing through the chips alone.
 */

const LUMA = 'vec3(0.2126, 0.7152, 0.0722)';

/**
 * Per-fragment setup, injected just before <map_fragment>.
 *
 * `mtUv` replaces every vXxxMapUv in the patched chunks: tiling lives in a
 * uniform, not in Texture.repeat, so every material variant shares the exact
 * same Texture objects (one GPU upload per surface, no clones) and animated
 * surfaces can scroll by writing uMatUv.zw.
 */
function setupBlock(triplanar) {
  return /* glsl */`
  vec2 mtUv = vMapUv * uMatUv.xy + uMatUv.zw;
  float mtFade = 1.0 - smoothstep(uMatFade.x, uMatFade.y, length(vViewPosition));
${triplanar ? /* glsl */`
  vec3 mtN = normalize(vTriNrm);
  vec3 mtWgt = pow(abs(mtN), vec3(uMatTri.y));
  mtWgt /= max(dot(mtWgt, vec3(1.0)), 1e-4);
  vec3 mtSg = sign(mtN + vec3(1e-6));
  vec2 mtUX = vec2(-vTriPos.z * mtSg.x, vTriPos.y) * uMatTri.x + uMatUv.zw;
  vec2 mtUY = vec2( vTriPos.x, -vTriPos.z * mtSg.y) * uMatTri.x + uMatUv.zw;
  vec2 mtUZ = vec2( vTriPos.x * mtSg.z, vTriPos.y) * uMatTri.x + uMatUv.zw;
` : ''}
  float mtGrunge = 0.5;
  if (mtFade > 0.002) {
${triplanar ? `
    mtGrunge = texture2D(uMatDetail, mtUX * uMatDetailP.x).a * mtWgt.x
             + texture2D(uMatDetail, mtUY * uMatDetailP.x).a * mtWgt.y
             + texture2D(uMatDetail, mtUZ * uMatDetailP.x).a * mtWgt.z;
` : `
    mtGrunge = texture2D(uMatDetail, mtUv * uMatDetailP.x).a;
`}
  }
`;
}

function mapBlock(triplanar) {
  return /* glsl */`
#ifdef USE_MAP
${triplanar ? `
  vec4 sampledDiffuseColor = texture2D(map, mtUX) * mtWgt.x
                           + texture2D(map, mtUY) * mtWgt.y
                           + texture2D(map, mtUZ) * mtWgt.z;
` : `
  vec4 sampledDiffuseColor = texture2D(map, mtUv);
`}
  // masked tint: alpha marks the tintable region of this surface
  sampledDiffuseColor.rgb *= mix(vec3(1.0), uMatTint, sampledDiffuseColor.a);

  if (mtFade > 0.002) {
    // shared micro grunge
    float amt = mtFade * uMatDetailP.y;
    sampledDiffuseColor.rgb *= mix(1.0, mix(0.74, 1.28, mtGrunge), amt);
    // the surface's own albedo re-tiled: coherent, surface-specific micro detail
${triplanar ? `
    vec3 selfD = texture2D(map, mtUX * uMatDetailP.z).rgb * mtWgt.x
               + texture2D(map, mtUY * uMatDetailP.z).rgb * mtWgt.y
               + texture2D(map, mtUZ * uMatDetailP.z).rgb * mtWgt.z;
` : `
    vec3 selfD = texture2D(map, mtUv * uMatDetailP.z).rgb;
`}
    float lumD = dot(selfD, ${LUMA});
    float lumB = dot(sampledDiffuseColor.rgb, ${LUMA});
    float ratio = clamp(lumD / max(lumB, 0.02), 0.55, 1.70);
    sampledDiffuseColor.rgb *= mix(1.0, ratio, mtFade * uMatDetailP.w * 0.55);
  }

  // NOTE: rgb only — alpha carries the tint mask, not coverage.
  diffuseColor.rgb *= sampledDiffuseColor.rgb;
#endif
`;
}

function normalBlock(triplanar) {
  if (triplanar) {
    return /* glsl */`
#ifdef USE_NORMALMAP_TANGENTSPACE
  vec3 tnX = texture2D(normalMap, mtUX).xyz * 2.0 - 1.0;
  vec3 tnY = texture2D(normalMap, mtUY).xyz * 2.0 - 1.0;
  vec3 tnZ = texture2D(normalMap, mtUZ).xyz * 2.0 - 1.0;

  if (mtFade > 0.002) {
    float dg = uMatDetailP.y * mtFade * 1.6;
    float sg = uMatDetailP.w * mtFade;
    tnX.xy += (texture2D(uMatDetail, mtUX * uMatDetailP.x).xy * 2.0 - 1.0) * dg;
    tnY.xy += (texture2D(uMatDetail, mtUY * uMatDetailP.x).xy * 2.0 - 1.0) * dg;
    tnZ.xy += (texture2D(uMatDetail, mtUZ * uMatDetailP.x).xy * 2.0 - 1.0) * dg;
    tnX.xy += (texture2D(normalMap, mtUX * uMatDetailP.z).xy * 2.0 - 1.0) * sg;
    tnY.xy += (texture2D(normalMap, mtUY * uMatDetailP.z).xy * 2.0 - 1.0) * sg;
    tnZ.xy += (texture2D(normalMap, mtUZ * uMatDetailP.z).xy * 2.0 - 1.0) * sg;
  }
  tnX.xy *= normalScale; tnY.xy *= normalScale; tnZ.xy *= normalScale;

  // Whiteout blend (Golus): swizzle each tangent normal into world space.
  vec3 wnX = vec3(tnX.xy + mtN.zy, abs(tnX.z) * mtN.x);
  vec3 wnY = vec3(tnY.xy + mtN.xz, abs(tnY.z) * mtN.y);
  vec3 wnZ = vec3(tnZ.xy + mtN.xy, abs(tnZ.z) * mtN.z);
  vec3 mtWorldN = normalize(wnX.zyx * mtWgt.x + wnY.xzy * mtWgt.y + wnZ.xyz * mtWgt.z);
  normal = normalize(mat3(viewMatrix) * mtWorldN);
#endif
`;
  }
  return /* glsl */`
#ifdef USE_NORMALMAP_TANGENTSPACE
  vec3 mapN = texture2D(normalMap, mtUv).xyz * 2.0 - 1.0;
  if (mtFade > 0.002) {
    // UDN-style blend: add the detail slopes, keep the base Z.
    vec3 dN = texture2D(uMatDetail, mtUv * uMatDetailP.x).xyz * 2.0 - 1.0;
    vec3 sN = texture2D(normalMap, mtUv * uMatDetailP.z).xyz * 2.0 - 1.0;
    mapN.xy += dN.xy * uMatDetailP.y * mtFade * 1.6;
    mapN.xy += sN.xy * uMatDetailP.w * mtFade;
    mapN = normalize(mapN);
  }
  mapN.xy *= normalScale;
  normal = normalize(tbn * mapN);
#endif
`;
}

function roughnessBlock(triplanar) {
  return /* glsl */`
float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
${triplanar ? `
  vec4 texelRoughness = texture2D(roughnessMap, mtUX) * mtWgt.x
                      + texture2D(roughnessMap, mtUY) * mtWgt.y
                      + texture2D(roughnessMap, mtUZ) * mtWgt.z;
` : `
  vec4 texelRoughness = texture2D(roughnessMap, mtUv);
`}
  roughnessFactor *= texelRoughness.g;
  // micro-roughness so close-ups don't flatten into plastic
  roughnessFactor *= mix(1.0, mix(0.86, 1.14, mtGrunge), mtFade * uMatDetailP.y);
#endif
`;
}

function metalnessBlock(triplanar) {
  return /* glsl */`
float metalnessFactor = metalness;
#ifdef USE_METALNESSMAP
${triplanar ? `
  vec4 texelMetalness = texture2D(metalnessMap, mtUX) * mtWgt.x
                      + texture2D(metalnessMap, mtUY) * mtWgt.y
                      + texture2D(metalnessMap, mtUZ) * mtWgt.z;
` : `
  vec4 texelMetalness = texture2D(metalnessMap, mtUv);
`}
  metalnessFactor *= texelMetalness.b;
#endif
`;
}

function aoBlock(triplanar) {
  return /* glsl */`
#ifdef USE_AOMAP
${triplanar ? `
  float aoTexel = texture2D(aoMap, mtUX).r * mtWgt.x
                + texture2D(aoMap, mtUY).r * mtWgt.y
                + texture2D(aoMap, mtUZ).r * mtWgt.z;
` : `
  float aoTexel = texture2D(aoMap, mtUv).r;
`}
  float ambientOcclusion = (aoTexel - 1.0) * aoMapIntensity + 1.0;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_CLEARCOAT )
    clearcoatSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined( USE_SHEEN )
    sheenSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
  #endif
#endif
`;
}

const VERT_PARS = /* glsl */`
varying vec3 vTriPos;
varying vec3 vTriNrm;
`;

const VERT_POS = /* glsl */`
  vec4 mtWP = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    mtWP = instanceMatrix * mtWP;
  #endif
  #ifdef USE_BATCHING
    mtWP = batchingMatrix * mtWP;
  #endif
  vTriPos = (modelMatrix * mtWP).xyz;
`;

const VERT_NRM = /* glsl */`
  vec3 mtON = objectNormal;
  #ifdef USE_INSTANCING
    mtON = mat3(instanceMatrix) * mtON;
  #endif
  vTriNrm = normalize(mat3(modelMatrix) * mtON);
`;

let _fallbackDetail = null;
function fallbackDetail() {
  if (_fallbackDetail) return _fallbackDetail;
  const d = new Uint8Array([128, 128, 255, 128]);
  const t = new THREE.DataTexture(d, 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  _fallbackDetail = t;
  return t;
}

/**
 * Install the detail / triplanar / tint patch on a material.
 *
 * @param {THREE.MeshStandardMaterial} material
 * @param {object} o
 *   detailMap      shared micro-detail texture (rgb normal, a grunge)
 *   detailScale    tiling multiplier for the shared micro layer
 *   detailStrength 0..1 blend weight for the shared micro layer
 *   selfScale      tiling multiplier for the surface's own maps
 *   selfStrength   0..1 blend weight for the self-tiled layer
 *   fadeStart      metres at which detail begins to fade out
 *   fadeEnd        metres at which detail is gone
 *   triplanar      boolean
 *   triScale       world-space texture frequency (repeats per metre)
 *   triSharpness   projection blend exponent
 *   tint           THREE.Color applied through the albedo alpha mask
 */
export function installSurfaceShader(material, o = {}) {
  const triplanar = !!o.triplanar;
  const u = {
    uMatDetail: { value: o.detailMap || fallbackDetail() },
    uMatDetailP: {
      value: new THREE.Vector4(
        o.detailScale ?? 11.0, o.detailStrength ?? 0.55,
        o.selfScale ?? 7.0, o.selfStrength ?? 0.45),
    },
    uMatFade: { value: new THREE.Vector2(o.fadeStart ?? 6.0, o.fadeEnd ?? 26.0) },
    uMatTint: { value: (o.tint || new THREE.Color(0xffffff)).clone() },
    uMatTri: { value: new THREE.Vector2(o.triScale ?? 0.5, o.triSharpness ?? 6.0) },
    // xy = uv tiling, zw = uv offset (scrolled for animated surfaces)
    uMatUv: {
      value: new THREE.Vector4(
        o.repeatX ?? 1.0, o.repeatY ?? 1.0, o.offsetX ?? 0.0, o.offsetY ?? 0.0),
    },
  };
  material.userData.matUniforms = u;
  material.userData.triplanar = triplanar;

  const key = [
    'mat', triplanar ? 'tri' : 'uv',
    (o.detailStrength ?? 0.55).toFixed(2), (o.selfStrength ?? 0.45).toFixed(2),
  ].join('|');

  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    Object.assign(shader.uniforms, u);

    if (triplanar) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
        .replace('#include <project_vertex>', `${VERT_POS}\n#include <project_vertex>`)
        .replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>\n${VERT_NRM}`);
    }

    let fs = shader.fragmentShader.replace(
      '#include <dithering_pars_fragment>',
      `#include <dithering_pars_fragment>
uniform sampler2D uMatDetail;
uniform vec4 uMatDetailP;
uniform vec2 uMatFade;
uniform vec3 uMatTint;
uniform vec2 uMatTri;
uniform vec4 uMatUv;
${triplanar ? VERT_PARS : ''}
${triplanar ? '#define MAT_TRIPLANAR' : ''}`);

    fs = fs.replace('#include <logdepthbuf_fragment>',
      `#include <logdepthbuf_fragment>\n${setupBlock(triplanar)}`);
    fs = fs.replace('#include <map_fragment>', mapBlock(triplanar));
    fs = fs.replace('#include <normal_fragment_maps>', normalBlock(triplanar));
    fs = fs.replace('#include <roughnessmap_fragment>', roughnessBlock(triplanar));
    fs = fs.replace('#include <metalnessmap_fragment>', metalnessBlock(triplanar));
    fs = fs.replace('#include <aomap_fragment>', aoBlock(triplanar));

    shader.fragmentShader = fs;
  };
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
  return material;
}

export default installSurfaceShader;
