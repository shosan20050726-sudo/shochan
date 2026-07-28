/**
 * One shader drives every particle layer. All motion happens on the GPU from
 * six instanced vec4s that are written once at spawn and never touched again,
 * so the CPU never walks a particle array per frame.
 *
 * attribute layout (28 floats / instance, one interleaved buffer)
 *   aPos  = spawn position .xyz            , spawn time      .w
 *   aVel  = spawn velocity .xyz            , lifetime        .w
 *   aCol0 = colour at birth .rgb           , alpha at birth  .a
 *   aCol1 = colour at death .rgb           , alpha at death  .a
 *   aSize = size0, size1, roll, spin
 *   aPhys = drag k, gravity, stretch (s)   , turbulence
 *   aMisc = atlas frame, seed, bouncePlaneY, restitution
 *
 * Defines: USE_STRETCH, USE_BOUNCE, USE_SOFT, USE_LIGHT.
 */

export const PARTICLE_VERT = /* glsl */`
attribute vec4 aPos;
attribute vec4 aVel;
attribute vec4 aCol0;
attribute vec4 aCol1;
attribute vec4 aSize;
attribute vec4 aPhys;
attribute vec4 aMisc;

uniform float uTime;
uniform float uFadeIn;
uniform float uAlphaPow;
uniform float uSizeCurve;
uniform float uSizeScale;
uniform vec2  uAtlas;
uniform vec3  uWind;
uniform float uWindGain;

varying vec2  vUv;
varying vec2  vQuv;
varying vec4  vColor;
varying float vDist;

void main() {
  vUv = vec2(0.0);
  vQuv = vec2(0.0);
  vColor = vec4(0.0);
  vDist = 0.0;

  float age  = uTime - aPos.w;
  float life = max(aVel.w, 1e-4);
  float t    = age / life;

  // Dead / unborn instances collapse to a single out-of-frustum point.
  if (age < 0.0 || t >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  float G = aPhys.y;
  float k = aPhys.x;
  vec3 pos;
  vec3 vel;

#ifdef USE_BOUNCE
  // Closed-form ballistic flight with up to three analytic plane bounces —
  // ricochet sparks that skitter along the floor and settle, for free.
  vec3  p      = aPos.xyz;
  vec3  v      = aVel.xyz;
  float rem    = age;
  float planeY = aMisc.z;
  float rest   = aMisc.w;
  for (int i = 0; i < 3; i++) {
    if (G <= 1e-4) break;
    float dy = max(p.y - planeY, 0.0);
    float disc = v.y * v.y + 2.0 * G * dy;
    float th = (v.y + sqrt(max(disc, 0.0))) / G;
    if (th >= rem || th <= 1e-4) break;
    p += v * th;
    p.y = planeY;
    v.y = -(v.y - G * th) * rest;
    v.x *= 0.55;
    v.z *= 0.55;
    rem -= th;
    if (abs(v.y) < 0.30) v.y = 0.0;
  }
  p += v * rem;
  p.y -= 0.5 * G * rem * rem;
  p.y = max(p.y, planeY);
  v.y -= G * rem;
  pos = p;
  vel = v;
#else
  if (k > 1e-3) {
    // dv/dt = -k v + g   ->  exact solution, so drag costs nothing per frame
    vec3 gk = vec3(0.0, -G, 0.0) / k;
    float ex = exp(-k * age);
    pos = aPos.xyz + gk * age + (aVel.xyz - gk) * (1.0 - ex) / k;
    vel = gk + (aVel.xyz - gk) * ex;
  } else {
    pos = aPos.xyz + aVel.xyz * age;
    pos.y -= 0.5 * G * age * age;
    vel = aVel.xyz;
    vel.y -= G * age;
  }
#endif

  float turb = aPhys.w;
  if (turb > 0.0) {
    float ph = aMisc.y * 6.2831853;
    float tt = uTime * 0.55;
    pos += (turb * age) * vec3(
      sin(tt * 1.13 + ph) + 0.45 * sin(tt * 2.31 + ph * 1.7),
      0.55 * sin(tt * 0.87 + ph * 2.1),
      cos(tt * 1.31 + ph * 0.7) + 0.45 * cos(tt * 1.93 + ph * 2.3));
  }
  pos += uWind * (age * uWindGain);

  float st = pow(t, uSizeCurve);
  float sz = mix(aSize.x, aSize.y, st) * uSizeScale;

  float fin  = uFadeIn > 0.0 ? smoothstep(0.0, uFadeIn, t) : 1.0;
  float fout = pow(max(1.0 - t, 0.0), uAlphaPow);
  vColor = vec4(mix(aCol0.rgb, aCol1.rgb, t), fin * fout * mix(aCol0.a, aCol1.a, t));

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vec2 c  = position.xy;
  vQuv = c + 0.5;

#ifdef USE_STRETCH
  // Screen-space stretch along the velocity: tracers and spark streaks are
  // physically the same primitive, just different speeds.
  vec3 vv = mat3(modelViewMatrix) * vel;
  vec2 d  = vv.xy;
  float dl = length(d);
  vec2 dv = dl > 1e-4 ? d / dl : vec2(0.0, 1.0);
  float len = sz + aPhys.z * dl;
  vec2 pp = vec2(-dv.y, dv.x);
  mv.xy += dv * (c.y * len) + pp * (c.x * sz);
#else
  float rot = aSize.z + aSize.w * age;
  float cs = cos(rot), sn = sin(rot);
  mv.xy += vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) * sz;
#endif

  vDist = -mv.z;
  float f = floor(aMisc.x + 0.5);
  vUv = (uv + vec2(mod(f, uAtlas.x), floor(f / uAtlas.x))) / uAtlas;
  gl_Position = projectionMatrix * mv;
}
`;

export const PARTICLE_FRAG = /* glsl */`
#include <packing>

uniform sampler2D uMap;
uniform float uIntensity;
uniform vec2  uNearFade;

#ifdef USE_SOFT
uniform sampler2D uDepth;
uniform vec2  uInvRes;
uniform float uNear;
uniform float uFar;
uniform float uSoftness;
#endif

#ifdef USE_LIGHT
uniform vec3 uSunView;
uniform vec3 uSunColor;
uniform vec3 uAmbColor;
#endif

varying vec2  vUv;
varying vec2  vQuv;
varying vec4  vColor;
varying float vDist;

void main() {
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * vColor.a;
  if (a < 0.003) discard;

  vec3 col = vColor.rgb * tex.rgb;

#ifdef USE_LIGHT
  // Treat the billboard as a sphere so smoke gets a lit side and a cool
  // shadow side instead of reading as a flat grey card.
  vec2 q = vQuv * 2.0 - 1.0;
  float r2 = min(dot(q, q), 1.0);
  vec3 n = normalize(vec3(q, sqrt(max(1.0 - r2, 1e-4)) * 1.15));
  float ndl = dot(n, uSunView);
  vec3 shade = uAmbColor + uSunColor * pow(clamp(ndl * 0.5 + 0.5, 0.0, 1.0), 1.8);
  col *= shade;
#endif

  col *= uIntensity;

#ifdef USE_SOFT
  vec2 suv = gl_FragCoord.xy * uInvRes;
  float dz = texture2D(uDepth, suv).x;
  float sceneDist = -perspectiveDepthToViewZ(dz, uNear, uFar);
  a *= clamp((sceneDist - vDist) / uSoftness, 0.0, 1.0);
#endif

  a *= smoothstep(uNearFade.x, uNearFade.y, vDist);
  if (a < 0.003) discard;

  gl_FragColor = vec4(col, a);
}
`;

export default { PARTICLE_VERT, PARTICLE_FRAG };
