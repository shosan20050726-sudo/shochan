import * as THREE from 'three';
import { NOISE_GLSL } from './glsl/noise.glsl.js';

/**
 * TextureForge — renders procedural PBR texture sets on the GPU.
 *
 * Pipeline per surface (all fullscreen passes, no readback, no CPU loops):
 *
 *   1. PATTERN  -> packRT (half-float when available)
 *                  RGBA = (height, maskA, maskB, maskC)
 *   2. SOBEL    -> normal map, a real 3x3 sobel over packRT.r.
 *                  Nothing is faked: if the height field has no feature there,
 *                  the normal map is flat there.
 *   3. SHADE(0) -> albedo (sRGB encoded, alpha = tint mask)
 *   4. SHADE(1) -> ORM  (r=AO, g=roughness, b=metalness)  glTF packing, so one
 *                  texture drives aoMap / roughnessMap / metalnessMap.
 *
 * The shade pass derives cavity AO and curvature from the same height field
 * (24 ring taps at three radii), which is what makes the materials read as
 * used rather than new: dirt goes in the pits, wear goes on the ridges.
 *
 * packRT wraps (RepeatWrapping) so the sobel and the AO ring taps read across
 * the seam — the maps stay tileable right to the edge.
 */

const QUAD_VS = /* glsl */`
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const HEAD = /* glsl */`
precision highp float;
precision highp int;
varying vec2 vUv;
uniform float uSeed;
uniform vec2 uTexel;
`;

const SOBEL_FS = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D uPack;
uniform vec2 uTexel;
uniform float uStrength;

float H(vec2 o){ return texture2D(uPack, vUv + o * uTexel).r; }

void main(){
  float tl = H(vec2(-1.0,  1.0)), tm = H(vec2(0.0,  1.0)), tr = H(vec2(1.0,  1.0));
  float ml = H(vec2(-1.0,  0.0)),                          mr = H(vec2(1.0,  0.0));
  float bl = H(vec2(-1.0, -1.0)), bm = H(vec2(0.0, -1.0)), br = H(vec2(1.0, -1.0));

  // Sobel: dH/du and dH/dv in height-units per texel.
  float dx = ((tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl)) * 0.125;
  float dy = ((tl + 2.0 * tm + tr) - (bl + 2.0 * bm + br)) * 0.125;

  // OpenGL-convention tangent normal (+Y up), which is what three expects.
  vec3 n = normalize(vec3(-dx * uStrength, -dy * uStrength, 1.0));
  gl_FragColor = vec4(n * 0.5 + 0.5, texture2D(uPack, vUv).g);
}
`;

/** Shared tail for the shade pass: cavity AO + curvature, then dispatch. */
const SHADE_MAIN = /* glsl */`
uniform sampler2D uPack;
uniform int uPass;          // 0 = albedo, 1 = ORM
uniform float uAoRadius;    // in texels
uniform float uAoStrength;
uniform float uCurvGain;

void main(){
  vec2 uv = vUv;
  vec4 p = texture2D(uPack, uv);
  float h = p.r;

  float occ = 0.0, blur = 0.0, wsum = 0.0;
  for (int r = 0; r < 3; r++){
    float rad = uAoRadius * (float(r) + 1.0);
    for (int k = 0; k < 8; k++){
      float a = float(k) * 0.7853981634 + float(r) * 0.37;
      vec2 o = vec2(cos(a), sin(a)) * rad;
      float hs = texture2D(uPack, uv + o * uTexel).r;
      occ += max(0.0, hs - h) / rad;
      blur += hs;
      wsum += 1.0;
    }
  }
  blur /= wsum;
  float ao = clamp(1.0 - (occ / wsum) * uAoStrength, 0.0, 1.0);
  float curv = (h - blur) * uCurvGain;

  if (uPass == 0){
    vec3 c = matAlbedo(uv, p, curv, ao);
    float tint = matORM(uv, p, curv, ao).w;
    gl_FragColor = vec4(clamp(c, 0.0, 1.0), tint);
  } else {
    vec4 orm = matORM(uv, p, curv, ao);
    gl_FragColor = vec4(clamp(orm.xyz, 0.0, 1.0), 1.0);
  }
}
`;

const PATTERN_MAIN = /* glsl */`
void main(){
  gl_FragColor = clamp(matPattern(vUv), 0.0, 1.0);
}
`;

export class TextureForge {
  constructor(renderer) {
    this.renderer = renderer;
    this.maxAniso = renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;

    this._scene = new THREE.Scene();
    this._cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._geo = new THREE.PlaneGeometry(2, 2);
    this._mesh = new THREE.Mesh(this._geo, null);
    this._mesh.frustumCulled = false;
    this._scene.add(this._mesh);

    // Half-float for the intermediate height field: an 8-bit height quantises
    // into visible terraces once you run a sobel over it.
    const ext = renderer?.extensions;
    this.packType = (ext?.has?.('EXT_color_buffer_half_float') || ext?.has?.('EXT_color_buffer_float'))
      ? THREE.HalfFloatType : THREE.UnsignedByteType;

    this._packRT = null;
    this._packSize = 0;
    this._owned = [];
    this._programs = [];
  }

  _quadMaterial(fragmentShader, uniforms) {
    const m = new THREE.ShaderMaterial({
      vertexShader: QUAD_VS,
      fragmentShader,
      uniforms,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this._programs.push(m);
    return m;
  }

  _blit(material, target) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    this._mesh.material = material;
    r.setRenderTarget(target);
    r.render(this._scene, this._cam);
    r.setRenderTarget(prevTarget);
  }

  _makeRT(size, { srgb = false, mips = true } = {}) {
    const rt = new THREE.WebGLRenderTarget(size, size, {
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: mips,
    });
    rt.texture.generateMipmaps = mips;
    rt.texture.anisotropy = this.maxAniso;
    // The classic amateur tell: albedo must be sRGB, everything else linear.
    rt.texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    this._owned.push(rt);
    return rt;
  }

  _packTarget(size) {
    if (this._packRT && this._packSize === size) return this._packRT;
    this._packRT?.dispose();
    this._packRT = new THREE.WebGLRenderTarget(size, size, {
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: this.packType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this._packSize = size;
    return this._packRT;
  }

  /**
   * @param {string} glsl  surface source defining matPattern/matAlbedo/matORM
   * @param {object} o     { size, seed, normalStrength, aoRadius, aoStrength,
   *                         curvGain, normalOnly }
   * @returns {{albedo:THREE.Texture|null, normal:THREE.Texture, orm:THREE.Texture|null}}
   */
  build(glsl, o = {}) {
    const size = o.size ?? 1024;
    const seed = o.seed ?? 1.0;
    const texel = new THREE.Vector2(1 / size, 1 / size);

    const pack = this._packTarget(size);

    // ---- pass 1: pattern -> height + masks -------------------------------
    const patternMat = this._quadMaterial(
      HEAD + NOISE_GLSL + glsl + PATTERN_MAIN,
      { uSeed: { value: seed }, uTexel: { value: texel } });
    this._blit(patternMat, pack);
    patternMat.dispose();

    // ---- pass 2: sobel -> normal -----------------------------------------
    const normalRT = this._makeRT(size, { srgb: false });
    const sobelMat = this._quadMaterial(SOBEL_FS, {
      uPack: { value: pack.texture },
      uTexel: { value: texel },
      // scale so tuning done at 1024 carries to any resolution
      uStrength: { value: (o.normalStrength ?? 1.0) * 8.0 * (size / 1024) },
    });
    this._blit(sobelMat, normalRT);
    sobelMat.dispose();

    if (o.normalOnly) {
      return { albedo: null, normal: normalRT.texture, orm: null };
    }

    // ---- pass 3/4: albedo + ORM ------------------------------------------
    const shadeUniforms = {
      uSeed: { value: seed },
      uTexel: { value: texel },
      uPack: { value: pack.texture },
      uPass: { value: 0 },
      uAoRadius: { value: (o.aoRadius ?? 3.0) * (size / 1024) },
      uAoStrength: { value: o.aoStrength ?? 2.4 },
      uCurvGain: { value: o.curvGain ?? 3.0 },
    };
    const shadeMat = this._quadMaterial(
      HEAD + NOISE_GLSL + glsl + SHADE_MAIN, shadeUniforms);

    const albedoRT = this._makeRT(size, { srgb: true });
    shadeUniforms.uPass.value = 0;
    this._blit(shadeMat, albedoRT);

    const ormRT = this._makeRT(size, { srgb: false });
    shadeUniforms.uPass.value = 1;
    this._blit(shadeMat, ormRT);
    shadeMat.dispose();

    return { albedo: albedoRT.texture, normal: normalRT.texture, orm: ormRT.texture };
  }

  /** Release the scratch height target once every surface has been forged. */
  releaseScratch() {
    this._packRT?.dispose();
    this._packRT = null;
    this._packSize = 0;
  }

  dispose() {
    this.releaseScratch();
    for (const rt of this._owned) rt.dispose();
    this._owned.length = 0;
    for (const m of this._programs) m.dispose();
    this._programs.length = 0;
    this._geo.dispose();
  }
}

export default TextureForge;
