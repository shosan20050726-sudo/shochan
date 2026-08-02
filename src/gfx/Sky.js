import * as THREE from 'three';

/**
 * Physically-plausible atmospheric sky.
 *
 * Single-scattering Rayleigh + Mie (+ ozone absorption) integrated along the
 * view ray, with a cheap baked cloud deck. The expensive integral is evaluated
 * ONCE into a cube render target at boot; at runtime the visible sky is a
 * single cube lookup plus an analytic sun disc, so the per-frame cost is a
 * handful of ALU ops instead of a 100-sample ray march.
 *
 * That cube target is then reused for three things:
 *   1. the visible skydome (background)
 *   2. `PMREMGenerator` -> `scene.environment`, so metals reflect the sky
 *   3. the aerial-perspective post pass, which samples it for inscatter colour
 *      so distant geometry fades into *the actual sky behind it*, not a flat
 *      fog constant. That directional match is what makes a map read as big.
 *
 * Nothing here touches the network: every texel is generated on the GPU.
 */

const DEG = Math.PI / 180;

// Sea-level scattering coefficients, per metre (Bruneton / Hillaire).
const BETA_R = [5.802e-6, 13.558e-6, 33.1e-6];
const BETA_O = [0.650e-6, 1.881e-6, 0.085e-6]; // ozone absorption
const H_R = 8000.0;
const H_M = 1200.0;
const R_PLANET = 6371e3;
const R_ATMOS = 6471e3;

/** Shared GLSL: atmosphere constants + phase functions + noise. */
const ATMOSPHERE_COMMON = /* glsl */ `
#define PI 3.141592653589793

uniform vec3  uSunDir;
uniform vec3  uBetaR;
uniform vec3  uBetaO;
uniform float uBetaM;
uniform float uMieG;
uniform float uSunIntensity;
uniform float uSkyScale;
uniform float uCamHeight;
uniform vec3  uGroundAlbedo;
uniform vec3  uGroundLight;
uniform float uCloudCoverage;
uniform float uCloudScale;
uniform float uCloudHeight;
uniform float uCloudDensity;
uniform vec3  uCloudSunColor;
uniform float uCloudTime;

const float Rg = 6371000.0;
const float Rt = 6471000.0;
const float Hr = 8000.0;
const float Hm = 1200.0;

float rayleighPhase( float mu ) {
  return 3.0 / ( 16.0 * PI ) * ( 1.0 + mu * mu );
}

float miePhase( float mu, float g ) {
  float g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * mu;
  return ( 3.0 / ( 8.0 * PI ) ) * ( ( 1.0 - g2 ) * ( 1.0 + mu * mu ) ) /
         ( ( 2.0 + g2 ) * d * sqrt( max( d, 1e-4 ) ) );
}

/** Far intersection of a ray starting inside a sphere of radius R centred at 0. */
float sphereFar( vec3 ro, vec3 rd, float R ) {
  float b = dot( ro, rd );
  float c = dot( ro, ro ) - R * R;
  float disc = b * b - c;
  return -b + sqrt( max( disc, 0.0 ) );
}

/** Near intersection with the planet, or -1 if the ray misses it. */
float groundHit( vec3 ro, vec3 rd ) {
  float b = dot( ro, rd );
  float c = dot( ro, ro ) - Rg * Rg;
  float disc = b * b - c;
  if ( disc <= 0.0 || b >= 0.0 ) return -1.0;
  return -b - sqrt( disc );
}

float ozoneDensity( float h ) {
  return max( 0.0, 1.0 - abs( h - 25000.0 ) / 15000.0 );
}

float hash21( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

float vnoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = hash21( i );
  float b = hash21( i + vec2( 1.0, 0.0 ) );
  float c = hash21( i + vec2( 0.0, 1.0 ) );
  float d = hash21( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}

float fbm( vec2 p ) {
  float s = 0.0;
  float a = 0.5;
  for ( int i = 0; i < 5; i ++ ) {
    s += a * vnoise( p );
    p = p * 2.06 + vec2( 17.3, 9.1 );
    a *= 0.5;
  }
  return s;
}
`;

/**
 * The heavy pass: full single-scattering integral. Only ever rasterised into
 * the 6 faces of the environment cube, so the sample counts can be generous.
 */
const BAKE_FRAGMENT = /* glsl */ `
${ATMOSPHERE_COMMON}

varying vec3 vDir;

#define VIEW_STEPS 20
#define LIGHT_STEPS 8

vec3 scatter( vec3 rd, out vec3 transmittance, out float pathLength ) {
  vec3 ro = vec3( 0.0, Rg + uCamHeight, 0.0 );

  float tg = groundHit( ro, rd );
  float tt = sphereFar( ro, rd, Rt );
  float tMax = tg > 0.0 ? tg : tt;
  pathLength = tMax;

  float mu = dot( rd, uSunDir );
  float pR = rayleighPhase( mu );
  float pM = miePhase( mu, uMieG );

  float t = 0.0;
  float odR = 0.0, odM = 0.0, odO = 0.0;
  vec3 sumR = vec3( 0.0 );
  vec3 sumM = vec3( 0.0 );

  // Quadratic step distribution. A horizon ray is ~300 km long but 90% of the
  // air sits in the first 8 km; uniform steps miss it entirely and the horizon
  // comes out as a flat white slab.
  const float INV_N = 1.0 / float( VIEW_STEPS );

  for ( int i = 0; i < VIEW_STEPS; i ++ ) {
    float f0 = float( i ) * INV_N;
    float f1 = float( i + 1 ) * INV_N;
    float t0 = tMax * f0 * f0;
    float t1 = tMax * f1 * f1;
    float seg = t1 - t0;
    t = t0;
    vec3 p = ro + rd * ( t + 0.5 * seg );
    float h = max( length( p ) - Rg, 0.0 );
    float dr = exp( -h / Hr ) * seg;
    float dm = exp( -h / Hm ) * seg;
    float dz = ozoneDensity( h ) * seg;
    odR += dr; odM += dm; odO += dz;

    // Optical depth from this sample towards the sun.
    float lg = groundHit( p, uSunDir );
    if ( lg < 0.0 ) {
      float tl = sphereFar( p, uSunDir, Rt );
      float lR = 0.0, lM = 0.0, lO = 0.0;
      const float INV_L = 1.0 / float( LIGHT_STEPS );
      for ( int j = 0; j < LIGHT_STEPS; j ++ ) {
        float g0 = float( j ) * INV_L;
        float g1 = float( j + 1 ) * INV_L;
        float u0 = tl * g0 * g0;
        float ls = tl * g1 * g1 - u0;
        vec3 q = p + uSunDir * ( u0 + 0.5 * ls );
        float hl = max( length( q ) - Rg, 0.0 );
        lR += exp( -hl / Hr ) * ls;
        lM += exp( -hl / Hm ) * ls;
        lO += ozoneDensity( hl ) * ls;
      }
      vec3 tau = uBetaR * ( odR + lR ) + vec3( uBetaM * 1.11 ) * ( odM + lM ) + uBetaO * ( odO + lO );
      vec3 att = exp( -tau );
      sumR += dr * att;
      sumM += dm * att;
    }
  }

  transmittance = exp( -( uBetaR * odR + vec3( uBetaM * 1.11 ) * odM + uBetaO * odO ) );

  vec3 L = uSunIntensity * ( sumR * uBetaR * pR + sumM * vec3( uBetaM ) * pM );

  // Ground: keeps the lower hemisphere of the IBL a plausible warm bounce
  // instead of black, which is what stops metals looking like plastic.
  if ( tg > 0.0 ) {
    L += uGroundAlbedo * uGroundLight * transmittance;
  }

  return L;
}

/** Two-layer cloud deck projected onto a plane, baked into the cube. */
vec4 clouds( vec3 rd ) {
  if ( rd.y <= 0.015 || uCloudDensity <= 0.0 ) return vec4( 0.0 );

  // Clamp the projected distance: past ~40 km the noise aliases into a
  // uniform grey veil that reads as overcast no matter the coverage setting.
  float t = min( uCloudHeight / rd.y, 40000.0 );
  vec2 cp = rd.xz * t * uCloudScale + vec2( uCloudTime, uCloudTime * 0.4 );

  // Cumulus base.
  float n = fbm( cp * 0.9 );
  n = n * 0.72 + fbm( cp * 3.4 ) * 0.28;
  float cov = smoothstep( uCloudCoverage, uCloudCoverage + 0.30, n );

  // High cirrus streaks, stretched along one axis.
  float cir = fbm( cp * vec2( 0.35, 2.4 ) + 41.0 );
  cir = smoothstep( 0.56, 0.86, cir ) * 0.45;

  float a = clamp( ( cov + cir ) * uCloudDensity, 0.0, 1.0 );
  a *= smoothstep( 0.02, 0.40, rd.y );           // compress into haze at horizon

  // Forward scattering: bright silver lining towards the sun.
  float mu = max( dot( rd, uSunDir ), 0.0 );
  float silver = pow( mu, 8.0 ) * 0.9 + pow( mu, 2.0 ) * 0.25;
  float thick = smoothstep( 0.0, 1.0, cov );
  vec3 lit = mix( uCloudSunColor * 0.34, uCloudSunColor, 1.0 - thick * 0.75 );
  lit += uCloudSunColor * silver * ( 0.5 + 0.5 * ( 1.0 - thick ) );

  return vec4( lit, a );
}

void main() {
  vec3 rd = normalize( vDir );

  vec3 trans;
  float pathLen;
  vec3 L = scatter( rd, trans, pathLen );

  // Below the horizon the analytic planet surface is only ~1 km away, so it
  // comes out as a flat dark band butted against a bright horizon. In a game
  // that seam is the most obvious "skybox" tell there is. Blend it into the
  // horizon haze over the first few degrees so the map's own terrain fades
  // into the same air the sky is made of.
  if ( rd.y < 0.0 ) {
    vec3 rh = normalize( vec3( rd.x, 0.0035, rd.z ) );
    vec3 th; float pl;
    vec3 Lh = scatter( rh, th, pl );
    float below = smoothstep( 0.0, -0.13, rd.y );
    L = mix( Lh, L, min( below * below * 1.12, 0.88 ) );
  }

  vec4 c = clouds( rd );
  // Clouds sit inside the atmosphere: attenuate them by roughly the optical
  // depth to the cloud deck, then let the remaining sky show through.
  float cloudFogged = clamp( uCloudHeight / max( rd.y, 0.02 ) / 90000.0, 0.0, 1.0 );
  vec3 cloudColor = mix( c.rgb, L / max( uSkyScale, 1e-4 ), cloudFogged * 0.55 );
  L = mix( L, cloudColor * uSkyScale, c.a );

  gl_FragColor = vec4( max( L * uSkyScale, 0.0 ), 1.0 );
}
`;

/**
 * Runtime skydome: one cube fetch + an analytic sun disc so the sun stays
 * pin-sharp regardless of cube resolution, and never gets double-counted in
 * the IBL (the baked cube deliberately omits it — the directional light is
 * the sun as far as surface shading is concerned).
 */
const DOME_FRAGMENT = /* glsl */ `
uniform samplerCube tSky;
uniform vec3  uSunDir;
uniform vec3  uSunDiscColor;
uniform float uSunAngularRadius;
uniform float uSunDiscIntensity;
uniform float uGlowIntensity;
uniform float uDither;

varying vec3 vDir;

void main() {
  vec3 rd = normalize( vDir );
  vec3 col = textureCube( tSky, rd ).rgb;

  float ca = clamp( dot( rd, uSunDir ), -1.0, 1.0 );
  float ang = acos( ca );

  // Sun disc with limb darkening, cut off below the horizon.
  float disc = 1.0 - smoothstep( uSunAngularRadius * 0.82, uSunAngularRadius, ang );
  disc *= mix( 1.0, 0.62, clamp( ang / max( uSunAngularRadius, 1e-4 ), 0.0, 1.0 ) );
  float above = smoothstep( -0.015, 0.030, rd.y ) * step( 0.0, uSunDir.y );
  col += uSunDiscColor * ( disc * uSunDiscIntensity * above );

  // Tight aureole so the sun reads hot before bloom even touches it. Kept
  // narrow on purpose — a wide glow just turns the whole sky into milk.
  float m = max( ca, 0.0 );
  float glow = pow( m, 3000.0 ) * 2.4 + pow( m, 420.0 ) * 0.10 + pow( m, 44.0 ) * 0.008;
  col += uSunDiscColor * glow * uGlowIntensity * above;

  // Ordered-ish dither: HDR sky gradients band badly after tonemapping.
  float d = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
  col += ( d - 0.5 ) * uDither;

  gl_FragColor = vec4( max( col, 0.0 ), 1.0 );
}
`;

const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  // Anchor the dome to the camera and pin it to the far plane so it is always
  // behind everything and costs nothing where geometry already wrote depth.
  vec4 mv = viewMatrix * vec4( position + cameraPosition, 1.0 );
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w;
}
`;

export default class Sky {
  /**
   * @param {object} [opts] tuning, all optional (read defensively from CFG).
   */
  constructor(opts = {}) {
    this.opts = opts;

    this.sunDirection = new THREE.Vector3(0, 1, 0);
    /** Transmitted (reddened) sun colour at ground level, normalised. */
    this.sunColor = new THREE.Color(1, 1, 1);
    /** Un-normalised transmittance — useful for scaling light intensity. */
    this.sunTransmittance = new THREE.Vector3(1, 1, 1);
    this.horizonColor = new THREE.Color(0.5, 0.62, 0.78);

    this.cubeSize = Math.max(64, opts.cubeSize ?? 256);
    this.renderer = null;
    this.cubeRT = null;
    this.envRT = null;
    this._pmrem = null;
    this._dirty = true;

    const V3 = THREE.Vector3;
    this.uniforms = {
      uSunDir: { value: this.sunDirection },
      uBetaR: { value: new V3(BETA_R[0], BETA_R[1], BETA_R[2]) },
      uBetaO: { value: new V3(BETA_O[0], BETA_O[1], BETA_O[2]) },
      uBetaM: { value: opts.mieCoefficient ?? 4.4e-6 },
      uMieG: { value: opts.mieDirectionalG ?? 0.72 },
      uSunIntensity: { value: opts.skyIntensity ?? 30 },
      uSkyScale: { value: opts.skyScale ?? 1.0 },
      uCamHeight: { value: opts.cameraHeight ?? 60 },
      uGroundAlbedo: { value: new V3(0.36, 0.30, 0.22) },
      uGroundLight: { value: new V3(0.25, 0.25, 0.25) },
      uCloudCoverage: { value: opts.cloudCoverage ?? 0.50 },
      uCloudScale: { value: opts.cloudScale ?? 2.6e-4 },
      uCloudHeight: { value: opts.cloudHeight ?? 2600 },
      uCloudDensity: { value: opts.clouds === false ? 0.0 : (opts.cloudDensity ?? 0.95) },
      uCloudSunColor: { value: new V3(1, 1, 1) },
      uCloudTime: { value: 0 },
    };

    this.domeUniforms = {
      tSky: { value: null },
      uSunDir: { value: this.sunDirection },
      uSunDiscColor: { value: new V3(1, 1, 1) },
      uSunAngularRadius: { value: opts.sunAngularRadius ?? 0.021 },
      uSunDiscIntensity: { value: opts.sunDiscIntensity ?? 34 },
      uGlowIntensity: { value: opts.sunGlowIntensity ?? 1.0 },
      uDither: { value: opts.skyDither ?? 0.0016 },
    };

    this.bakeMaterial = new THREE.ShaderMaterial({
      name: 'SkyBake',
      uniforms: this.uniforms,
      vertexShader: SKY_VERTEX,
      fragmentShader: BAKE_FRAGMENT,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });

    this.domeMaterial = new THREE.ShaderMaterial({
      name: 'SkyDome',
      uniforms: this.domeUniforms,
      vertexShader: SKY_VERTEX,
      fragmentShader: DOME_FRAGMENT,
      side: THREE.BackSide,
      // Drawn first with no depth test at all (see renderOrder below), so it
      // simply fills the buffer and everything else lands on top of it.
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });

    this._geometry = new THREE.BoxGeometry(2, 2, 2);

    /** Skydome to drop into the world scene. */
    this.mesh = new THREE.Mesh(this._geometry, this.domeMaterial);
    this.mesh.name = 'gfx:skydome';
    this.mesh.frustumCulled = false;
    // Draw before everything else rather than after.
    //
    // The previous order was the opposite: draw after opaques, pin depth to
    // the far plane in the vertex shader, and let depth rejection keep the
    // dome behind the world. That leaked. The dome is a 2x2x2 box anchored to
    // the camera, so its triangles straddle the near plane and get clipped,
    // and the clip boundaries showed up as a large straight-edged wedge of sky
    // painted over the terrain — the artifact that survived ruling out
    // shadows, VFX, post compositing, non-finite geometry, and the baked sky
    // cubemap. Drawing first with depth testing off cannot cover geometry no
    // matter what its depth works out to.
    this.mesh.renderOrder = -10000;
    this.mesh.matrixAutoUpdate = false;

    this._bakeMesh = new THREE.Mesh(this._geometry, this.bakeMaterial);
    this._bakeMesh.frustumCulled = false;
    this._bakeScene = new THREE.Scene();
    this._bakeScene.add(this._bakeMesh);

    this.setSunFromAngles(opts.sunAzimuth ?? 88, opts.sunElevation ?? 24);
  }

  /**
   * @param {number} azimuthDeg measured from +Z towards +X
   * @param {number} elevationDeg above the horizon
   */
  setSunFromAngles(azimuthDeg, elevationDeg) {
    const az = azimuthDeg * DEG;
    const el = elevationDeg * DEG;
    const ce = Math.cos(el);
    this.sunDirection.set(Math.sin(az) * ce, Math.sin(el), Math.cos(az) * ce).normalize();
    this.azimuth = azimuthDeg;
    this.elevation = elevationDeg;
    this._computeSunColor();
    this._dirty = true;
  }

  /**
   * Atmospheric transmittance along the sun ray, evaluated on the CPU so the
   * directional light, the viewmodel key light and the fog tint all agree with
   * what the sky shader is drawing.
   */
  _computeSunColor() {
    const dirY = Math.max(this.sunDirection.y, -0.05);
    const steps = 48;
    const ox = 0, oy = R_PLANET + 2;
    const rx = Math.sqrt(Math.max(0, 1 - dirY * dirY));
    const ry = dirY;
    const b = ox * rx + oy * ry;
    const c = ox * ox + oy * oy - R_ATMOS * R_ATMOS;
    const tMax = -b + Math.sqrt(Math.max(b * b - c, 0));
    const seg = tMax / steps;

    let odR = 0, odM = 0, odO = 0;
    for (let i = 0; i < steps; i++) {
      const s = (i + 0.5) * seg;
      const px = ox + rx * s, py = oy + ry * s;
      const h = Math.max(Math.hypot(px, py) - R_PLANET, 0);
      odR += Math.exp(-h / H_R) * seg;
      odM += Math.exp(-h / H_M) * seg;
      odO += Math.max(0, 1 - Math.abs(h - 25000) / 15000) * seg;
    }

    const betaM = this.uniforms.uBetaM.value;
    const t = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      t[i] = Math.exp(-(BETA_R[i] * odR + betaM * 1.11 * odM + BETA_O[i] * odO));
    }
    this.sunTransmittance.set(t[0], t[1], t[2]);

    const peak = Math.max(t[0], t[1], t[2], 1e-4);
    this.sunColor.setRGB(t[0] / peak, t[1] / peak, t[2] / peak, THREE.LinearSRGBColorSpace);

    // The disc itself and the cloud lighting use the un-normalised value so a
    // low sun genuinely goes orange instead of just "white but dimmer".
    this.domeUniforms.uSunDiscColor.value.set(t[0], t[1], t[2]).multiplyScalar(1 / peak);
    this.uniforms.uCloudSunColor.value.set(t[0], t[1], t[2]).multiplyScalar(1 / peak);

    // Ground bounce feeding the lower hemisphere of the IBL.
    const up = Math.max(this.sunDirection.y, 0);
    const gl = this.uniforms.uGroundLight.value;
    const amb = 0.12;
    gl.set(t[0] * up * 1.5 + amb, t[1] * up * 1.5 + amb * 1.02, t[2] * up * 1.5 + amb * 1.15);

    // Rough horizon tint for anything that wants a CPU-side fog colour.
    const hz = 1.0 / Math.max(dirY + 0.12, 0.12);
    this.horizonColor.setRGB(
      Math.min(1, 0.42 + 0.30 * t[0] * hz * 0.2),
      Math.min(1, 0.52 + 0.24 * t[1] * hz * 0.2),
      Math.min(1, 0.68 + 0.16 * t[2] * hz * 0.2),
      THREE.LinearSRGBColorSpace,
    );
  }

  /** Bakes the cube + PMREM. Cheap to call again when the sun moves. */
  build(renderer) {
    this.renderer = renderer;

    if (!this.cubeRT) {
      this.cubeRT = new THREE.WebGLCubeRenderTarget(this.cubeSize, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
      });
      this.cubeRT.texture.name = 'gfx:skyCube';
      this._cubeCamera = new THREE.CubeCamera(0.1, 10, this.cubeRT);
      this.domeUniforms.tSky.value = this.cubeRT.texture;
    }

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    this._cubeCamera.update(renderer, this._bakeScene);
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);

    if (!this._pmrem) this._pmrem = new THREE.PMREMGenerator(renderer);
    const next = this._pmrem.fromCubemap(this.cubeRT.texture);
    if (this.envRT) this.envRT.dispose();
    this.envRT = next;
    this.envRT.texture.name = 'gfx:skyEnv';

    this._dirty = false;
    return this.envRT.texture;
  }

  get dirty() { return this._dirty; }
  get cubeTexture() { return this.cubeRT ? this.cubeRT.texture : null; }
  get environmentTexture() { return this.envRT ? this.envRT.texture : null; }

  dispose() {
    this.bakeMaterial.dispose();
    this.domeMaterial.dispose();
    this._geometry.dispose();
    this.cubeRT?.dispose();
    this.envRT?.dispose();
    this._pmrem?.dispose();
  }
}
