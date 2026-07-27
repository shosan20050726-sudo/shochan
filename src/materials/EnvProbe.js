import * as THREE from 'three';

/**
 * Procedural IBL. Metals and clearcoats are *defined* by what they reflect —
 * with no environment a metalness=1 surface renders near-black except for a
 * couple of specular dots, which is the second-most obvious amateur tell after
 * wrong colour spaces. This builds a sky/ground radiance probe in code and
 * runs it through PMREMGenerator, no HDR file required.
 *
 *   const env = buildEnvironment(renderer, { sunDir, ... });
 *   scene.environment = env.texture;
 *   scene.background  = env.texture;   // optional
 *   env.dispose();                     // when tearing the scene down
 */

const SKY_VS = /* glsl */`
varying vec3 vDir;
void main(){
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FS = /* glsl */`
precision highp float;
varying vec3 vDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uSunAngularSize;
uniform float uSunIntensity;
uniform float uHaze;

void main(){
  vec3 d = normalize(vDir);
  float h = d.y;

  // Sky: horizon haze band lifting into a deeper zenith.
  float up = clamp(h, 0.0, 1.0);
  vec3 sky = mix(uHorizon, uZenith, pow(up, 0.42));
  // Ground bounce: dimmer, warmer, and much flatter than the sky.
  float dn = clamp(-h, 0.0, 1.0);
  vec3 gnd = mix(uHorizon * 0.75, uGround, pow(dn, 0.30));

  vec3 col = mix(gnd, sky, smoothstep(-0.045, 0.045, h));

  vec3 sd = normalize(uSunDir);
  float cosA = dot(d, sd);
  // Sun disc (radiance, not a "colour" — it should blow way past 1.0).
  float disc = smoothstep(cos(uSunAngularSize * 2.2), cos(uSunAngularSize), cosA);
  col += uSunColor * uSunIntensity * disc;
  // Forward-scatter glow around it, which is what actually shapes the
  // specular falloff on rough metal.
  col += uSunColor * uHaze * pow(max(cosA, 0.0), 24.0);
  col += uSunColor * uHaze * 0.35 * pow(max(cosA, 0.0), 4.0);

  gl_FragColor = vec4(col, 1.0);
}
`;

export function buildEnvironment(renderer, o = {}) {
  const sunDir = o.sunDir
    ? new THREE.Vector3().copy(o.sunDir).normalize()
    : new THREE.Vector3(0.55, 0.62, 0.30).normalize();

  const mat = new THREE.ShaderMaterial({
    vertexShader: SKY_VS,
    fragmentShader: SKY_FS,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uZenith: { value: new THREE.Color(o.zenith ?? 0x2f6ec2) },
      uHorizon: { value: new THREE.Color(o.horizon ?? 0xbcd2e8) },
      uGround: { value: new THREE.Color(o.ground ?? 0x4a4034) },
      uSunColor: { value: new THREE.Color(o.sunColor ?? 0xfff0d4) },
      uSunDir: { value: sunDir },
      uSunAngularSize: { value: o.sunAngularSize ?? 0.055 },
      uSunIntensity: { value: o.sunIntensity ?? 90.0 },
      uHaze: { value: o.haze ?? 0.65 },
    },
  });

  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(60, 48, 24);
  const mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const rt = pmrem.fromScene(scene, o.blur ?? 0.0, 1, 200);

  geo.dispose();
  mat.dispose();
  pmrem.dispose();

  return {
    texture: rt.texture,
    sunDir,
    dispose() { rt.dispose(); },
  };
}

export default buildEnvironment;
