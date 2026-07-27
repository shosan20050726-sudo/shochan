import * as THREE from 'three';

/**
 * Post-processing shader definitions.
 *
 * Everything in here runs on *linear HDR* data until `OutputPass`; only the
 * finishing pass (CA / vignette / grain / sharpen) sees display-referred sRGB.
 * Keeping that boundary straight is the whole ballgame — grading after the
 * tonemap, or letting sRGB get applied twice, is what produces the milky,
 * washed-out look that instantly reads as "WebGL demo".
 */

export const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const HASH = /* glsl */ `
float hash21( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
`;

const DEPTH_HELPERS = /* glsl */ `
uniform sampler2D tDepth;
uniform mat4 uInvProjection;

vec3 viewFromUv( vec2 uv, float d ) {
  vec4 clip = vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
  vec4 v = uInvProjection * clip;
  return v.xyz / v.w;
}
`;

/* ------------------------------------------------------------------ SSAO -- */
/**
 * Normal-oriented hemisphere SSAO reconstructed from the depth buffer alone
 * (no extra scene pass). Runs at half resolution and is bilaterally blurred
 * afterwards, which is why 16 taps is enough to look clean.
 */
export const SSAOShader = {
  name: 'gfx.ssao',
  defines: { KERNEL_SIZE: 16 },
  uniforms: {
    tDepth: { value: null },
    uProjection: { value: new THREE.Matrix4() },
    uInvProjection: { value: new THREE.Matrix4() },
    uKernel: { value: [] },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uRadius: { value: 0.55 },
    uIntensity: { value: 0.9 },
    uBias: { value: 0.025 },
    uPower: { value: 1.6 },
    uMaxDistance: { value: 120.0 },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
${DEPTH_HELPERS}
${HASH}
uniform mat4 uProjection;
uniform vec3 uKernel[ KERNEL_SIZE ];
uniform vec2 uResolution;
uniform float uRadius;
uniform float uIntensity;
uniform float uBias;
uniform float uPower;
uniform float uMaxDistance;

varying vec2 vUv;

float rawDepth( vec2 uv ) { return texture2D( tDepth, uv ).x; }

void main() {
  float d = rawDepth( vUv );
  if ( d >= 0.9999 ) { gl_FragColor = vec4( 1.0 ); return; }

  vec3 P = viewFromUv( vUv, d );
  if ( -P.z > uMaxDistance ) { gl_FragColor = vec4( 1.0 ); return; }

  vec2 texel = 1.0 / uResolution;

  // Normal from depth, picking the closer neighbour on each axis so silhouette
  // edges do not smear a bogus normal across the discontinuity.
  vec3 pr = viewFromUv( vUv + vec2( texel.x, 0.0 ), rawDepth( vUv + vec2( texel.x, 0.0 ) ) );
  vec3 pl = viewFromUv( vUv - vec2( texel.x, 0.0 ), rawDepth( vUv - vec2( texel.x, 0.0 ) ) );
  vec3 pu = viewFromUv( vUv + vec2( 0.0, texel.y ), rawDepth( vUv + vec2( 0.0, texel.y ) ) );
  vec3 pd = viewFromUv( vUv - vec2( 0.0, texel.y ), rawDepth( vUv - vec2( 0.0, texel.y ) ) );

  vec3 dx = ( abs( pr.z - P.z ) < abs( P.z - pl.z ) ) ? ( pr - P ) : ( P - pl );
  vec3 dy = ( abs( pu.z - P.z ) < abs( P.z - pd.z ) ) ? ( pu - P ) : ( P - pd );
  vec3 N = normalize( cross( dx, dy ) );
  if ( dot( N, -normalize( P ) ) < 0.0 ) N = -N;

  float ang = hash21( vUv * uResolution ) * 6.2831853;
  vec3 rv = vec3( cos( ang ), sin( ang ), 0.0 );
  vec3 T = normalize( rv - N * dot( rv, N ) );
  vec3 B = cross( N, T );
  mat3 TBN = mat3( T, B, N );

  float occ = 0.0;
  for ( int i = 0; i < KERNEL_SIZE; i ++ ) {
    vec3 sp = P + ( TBN * uKernel[ i ] ) * uRadius;
    vec4 off = uProjection * vec4( sp, 1.0 );
    if ( off.w <= 0.0 ) continue;
    vec2 suv = off.xy / off.w * 0.5 + 0.5;
    if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 ) continue;

    float sd = rawDepth( suv );
    if ( sd >= 0.9999 ) continue;
    float sz = viewFromUv( suv, sd ).z;

    float range = smoothstep( 0.0, 1.0, uRadius / max( abs( P.z - sz ), 1e-4 ) );
    occ += ( sz >= sp.z + uBias ? 1.0 : 0.0 ) * range;
  }

  float ao = 1.0 - ( occ / float( KERNEL_SIZE ) ) * uIntensity;
  // Fade AO out at distance: it is a contact effect, and depth precision at
  // 100 m is not good enough to trust.
  ao = mix( ao, 1.0, smoothstep( uMaxDistance * 0.55, uMaxDistance, -P.z ) );
  gl_FragColor = vec4( vec3( pow( clamp( ao, 0.0, 1.0 ), uPower ) ), 1.0 );
}
`,
};

/* ------------------------------------------------------------ AO blur ---- */
export const AOBlurShader = {
  name: 'gfx.aoBlur',
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uInvProjection: { value: new THREE.Matrix4() },
    uTexel: { value: new THREE.Vector2() },
    uDirection: { value: new THREE.Vector2(1, 0) },
    uDepthSigma: { value: 1.4 },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
${DEPTH_HELPERS}
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
uniform vec2 uDirection;
uniform float uDepthSigma;
varying vec2 vUv;

void main() {
  float dc = texture2D( tDepth, vUv ).x;
  float zc = -viewFromUv( vUv, dc ).z;

  float sum = texture2D( tDiffuse, vUv ).r;
  float wsum = 1.0;

  for ( int i = 1; i <= 3; i ++ ) {
    float fi = float( i );
    vec2 o = uDirection * uTexel * fi;

    vec2 u1 = vUv + o;
    float z1 = -viewFromUv( u1, texture2D( tDepth, u1 ).x ).z;
    float w1 = exp( -abs( z1 - zc ) / uDepthSigma ) * ( 1.0 - fi * 0.22 );
    sum += texture2D( tDiffuse, u1 ).r * w1; wsum += w1;

    vec2 u2 = vUv - o;
    float z2 = -viewFromUv( u2, texture2D( tDepth, u2 ).x ).z;
    float w2 = exp( -abs( z2 - zc ) / uDepthSigma ) * ( 1.0 - fi * 0.22 );
    sum += texture2D( tDiffuse, u2 ).r * w2; wsum += w2;
  }

  gl_FragColor = vec4( vec3( sum / wsum ), 1.0 );
}
`,
};

/* ------------------------------- AO apply + aerial perspective / fog ----- */
/**
 * Merged pass: applies the AO buffer and then the atmospheric depth cue.
 *
 * Inscatter is sampled from the baked sky cube in the *view direction of the
 * pixel*, so a building 400 m away fades into exactly the sky that is behind
 * it — warm near the sun, cool away from it. A single flat fog colour cannot
 * do that, and the difference is most of why a big map reads as big.
 */
export const AerialShader = {
  name: 'gfx.aerial',
  defines: { USE_AO: '', USE_AERIAL: '' },
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    tAO: { value: null },
    tSky: { value: null },
    uInvViewProj: { value: new THREE.Matrix4() },
    uCameraPos: { value: new THREE.Vector3() },
    uAOColor: { value: new THREE.Vector3(0.55, 0.60, 0.72) },
    uFogDensity: { value: 0.0028 },
    uFogFalloff: { value: 0.016 },
    uFogBase: { value: 0.0 },
    uFogMax: { value: 0.94 },
    uFogInscatter: { value: 1.0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Vector3(1, 1, 1) },
    uSunScatter: { value: 0.55 },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform sampler2D tAO;
uniform samplerCube tSky;
uniform mat4 uInvViewProj;
uniform vec3 uCameraPos;
uniform vec3 uAOColor;
uniform float uFogDensity;
uniform float uFogFalloff;
uniform float uFogBase;
uniform float uFogMax;
uniform float uFogInscatter;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunScatter;

varying vec2 vUv;

void main() {
  vec3 color = texture2D( tDiffuse, vUv ).rgb;
  float d = texture2D( tDepth, vUv ).x;

  #ifdef USE_AO
    float ao = clamp( texture2D( tAO, vUv ).r, 0.0, 1.0 );
    color *= mix( uAOColor, vec3( 1.0 ), ao );
  #endif

  #ifdef USE_AERIAL
  if ( d < 0.999999 ) {
    vec4 clip = vec4( vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
    vec4 w = uInvViewProj * clip;
    vec3 wp = w.xyz / w.w;
    vec3 delta = wp - uCameraPos;
    float dist = length( delta );
    vec3 rd = delta / max( dist, 1e-4 );

    float b = uFogFalloff;
    float base = uFogDensity * min( exp( -( uCameraPos.y - uFogBase ) * b ), 4.0 );
    float amount;
    if ( abs( rd.y ) < 1e-4 ) amount = base * dist;
    else amount = base * ( 1.0 - exp( -b * rd.y * dist ) ) / ( b * rd.y );

    float f = min( 1.0 - exp( -max( amount, 0.0 ) ), uFogMax );

    vec3 inscatter = textureCube( tSky, rd ).rgb * uFogInscatter;
    float mu = max( dot( rd, uSunDir ), 0.0 );
    inscatter += uSunColor * pow( mu, 10.0 ) * uSunScatter;

    color = mix( color, inscatter, f );
  }
  #endif

  gl_FragColor = vec4( color, 1.0 );
}
`,
};

/* ------------------------------------------------------- Motion blur ----- */
/**
 * Camera-velocity motion blur by reprojection: world position is rebuilt from
 * depth and pushed through last frame's view-projection matrix. Purely camera
 * driven (no per-object velocity buffer), which is the right trade for an FPS
 * where 95% of screen motion is the player turning.
 */
export const MotionBlurShader = {
  name: 'gfx.motionBlur',
  defines: { MB_SAMPLES: 8 },
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uInvViewProj: { value: new THREE.Matrix4() },
    uPrevViewProj: { value: new THREE.Matrix4() },
    uStrength: { value: 0.42 },
    uMaxBlur: { value: 0.035 },
    uDtScale: { value: 1.0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
${HASH}
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform float uStrength;
uniform float uMaxBlur;
uniform float uDtScale;
uniform vec2 uResolution;
varying vec2 vUv;

void main() {
  vec3 here = texture2D( tDiffuse, vUv ).rgb;
  float d = texture2D( tDepth, vUv ).x;

  vec4 clip = vec4( vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
  vec4 w = uInvViewProj * clip;
  vec3 wp = w.xyz / w.w;

  vec4 pc = uPrevViewProj * vec4( wp, 1.0 );
  if ( pc.w <= 0.0 ) { gl_FragColor = vec4( here, 1.0 ); return; }
  vec2 puv = ( pc.xy / pc.w ) * 0.5 + 0.5;

  vec2 vel = ( vUv - puv ) * uStrength * uDtScale;
  float len = length( vel );
  if ( len < 1.5 / max( uResolution.x, 1.0 ) ) { gl_FragColor = vec4( here, 1.0 ); return; }
  vel *= min( len, uMaxBlur ) / len;

  float jitter = hash21( vUv * uResolution ) - 0.5;
  vec3 sum = vec3( 0.0 );
  for ( int i = 0; i < MB_SAMPLES; i ++ ) {
    float t = ( ( float( i ) + 0.5 + jitter ) / float( MB_SAMPLES ) ) - 0.5;
    vec2 uv = clamp( vUv + vel * t, vec2( 0.0 ), vec2( 1.0 ) );
    sum += texture2D( tDiffuse, uv ).rgb;
  }

  gl_FragColor = vec4( sum / float( MB_SAMPLES ), 1.0 );
}
`,
};

/* ------------------------------------------------------------- Grade ----- */
/**
 * Filmic grade, applied in linear HDR *before* the tonemap: contrast around
 * mid-grey, lift/gamma/gain, saturation, then a split-tone that pushes shadows
 * teal and highlights warm. This is the cheap version of a film-emulation LUT
 * and it is the single biggest "why does this look like a game trailer" knob.
 */
export const GradeShader = {
  name: 'gfx.grade',
  uniforms: {
    tDiffuse: { value: null },
    uWhiteBalance: { value: new THREE.Vector3(1.02, 1.0, 0.975) },
    uExposureComp: { value: 1.0 },
    uContrast: { value: 1.12 },
    uLift: { value: new THREE.Vector3(0.0018, 0.0022, 0.0048) },
    uGain: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
    uGamma: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
    uSaturation: { value: 1.1 },
    uShadowTint: { value: new THREE.Vector3(0.90, 0.985, 1.13) },
    uHighlightTint: { value: new THREE.Vector3(1.07, 1.005, 0.925) },
    uSplitPivot: { value: 0.16 },
    uSplitSoft: { value: 0.20 },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec3 uWhiteBalance;
uniform float uExposureComp;
uniform float uContrast;
uniform vec3 uLift;
uniform vec3 uGain;
uniform vec3 uGamma;
uniform float uSaturation;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
uniform float uSplitPivot;
uniform float uSplitSoft;
varying vec2 vUv;

void main() {
  vec3 c = max( texture2D( tDiffuse, vUv ).rgb, 0.0 );
  c *= uWhiteBalance * uExposureComp;

  // Contrast pivoted on 18% grey, applied to luminance so hue is preserved,
  // and rolled off above ~1.0 so a bright sky does not get shoved past the
  // tonemapper's shoulder and turn into a white slab.
  float lin = max( dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-5 );
  float boost = pow( lin / 0.18, uContrast - 1.0 );
  boost = mix( boost, 1.0, smoothstep( 0.45, 2.4, lin ) );
  c *= boost;

  c = c * uGain + uLift;
  c = pow( max( c, 0.0 ), uGamma );

  float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  c = max( mix( vec3( l ), c, uSaturation ), 0.0 );

  float t = smoothstep( uSplitPivot - uSplitSoft, uSplitPivot + uSplitSoft, l );
  c *= mix( uShadowTint, uHighlightTint, t );

  gl_FragColor = vec4( max( c, 0.0 ), 1.0 );
}
`,
};

/* ------------------------------------------------------------ Finish ----- */
/**
 * Display-referred finishing: lens chromatic aberration that only bites near
 * the frame edge, unsharp mask to claw back the softness SMAA introduces,
 * vignette, and film grain weighted towards the shadows.
 */
export const FinishShader = {
  name: 'gfx.finish',
  defines: { USE_CA: '', USE_SHARPEN: '', USE_VIGNETTE: '', USE_GRAIN: '' },
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uCA: { value: 0.0016 },
    uVignette: { value: 0.32 },
    uVignetteSoft: { value: 0.42 },
    uGrain: { value: 0.022 },
    uSharpen: { value: 0.18 },
    uTime: { value: 0 },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
${HASH}
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
uniform vec2 uResolution;
uniform float uCA;
uniform float uVignette;
uniform float uVignetteSoft;
uniform float uGrain;
uniform float uSharpen;
uniform float uTime;
varying vec2 vUv;

void main() {
  vec2 d = vUv - 0.5;
  float r2 = dot( d, d );

  vec3 mid = texture2D( tDiffuse, vUv ).rgb;
  vec3 c = mid;

  #ifdef USE_CA
    vec2 off = d * r2 * uCA * 6.0;
    c.r = texture2D( tDiffuse, vUv + off ).r;
    c.b = texture2D( tDiffuse, vUv - off ).b;
  #endif

  #ifdef USE_SHARPEN
    vec3 n = texture2D( tDiffuse, vUv + vec2( uTexel.x, 0.0 ) ).rgb
           + texture2D( tDiffuse, vUv - vec2( uTexel.x, 0.0 ) ).rgb
           + texture2D( tDiffuse, vUv + vec2( 0.0, uTexel.y ) ).rgb
           + texture2D( tDiffuse, vUv - vec2( 0.0, uTexel.y ) ).rgb;
    c += ( mid * 4.0 - n ) * uSharpen;
  #endif

  #ifdef USE_VIGNETTE
    float r = length( d ) * 1.41421356;
    float v = smoothstep( uVignetteSoft, 1.05, r );
    c *= 1.0 - v * uVignette;
  #endif

  #ifdef USE_GRAIN
    float g = hash21( vUv * uResolution + vec2( uTime * 71.3, uTime * 37.1 ) ) - 0.5;
    float lum = dot( c, vec3( 0.299, 0.587, 0.114 ) );
    c += g * uGrain * ( 1.0 - lum * 0.55 );
  #endif

  gl_FragColor = vec4( clamp( c, 0.0, 1.0 ), 1.0 );
}
`,
};
