import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import CFG from '../core/Config.js';
import Materials, { SURFACES } from './MaterialLibrary.js';

/**
 * Standalone showcase for the procedural material library.
 *
 * Not part of the game build — it exists so the materials can be judged on
 * their own, at the two distances that actually matter: ~30 cm (does the
 * detail-tiling hold up, or is it a smear of magnified texels?) and ~30 m
 * (does it still read as concrete, or has it turned into grey soup?).
 *
 * Query params:  ?size=512  ?pose=close:metal
 * Drive it from Playwright with window.__DEMO.pose('close:metal').
 */

window.__DEMO_STARTED = true;

const qs = new URLSearchParams(location.search);
const bootEl = document.getElementById('boot');
const bootMsg = document.getElementById('boot-msg');
const hudEl = document.getElementById('hud');
const errEl = document.getElementById('err');

function fail(e) {
  console.error(e);
  errEl.style.display = 'block';
  errEl.textContent = `FATAL\n\n${e?.stack || e}`;
}
window.addEventListener('error', (e) => fail(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => fail(e.reason));

// --------------------------------------------------------------- renderer --
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, stencil: false });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = CFG.gfx.exposure;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / Math.max(window.innerHeight, 1), 0.02, 2000);

addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / Math.max(window.innerHeight, 1);
  camera.updateProjectionMatrix();
});

// ---------------------------------------------------------------- layout ---
const COLS = 6;
const CELL_X = 7.2;
const CELL_Z = 11.0;
const bays = new Map();          // surface -> { center: Vector3, panel: Mesh }

function bayPosition(i) {
  const c = i % COLS, r = Math.floor(i / COLS);
  return new THREE.Vector3((c - (COLS - 1) / 2) * CELL_X, 0, -r * CELL_Z - 5.0);
}

function labelTexture(text) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 512, 128);
  g.font = 'bold 62px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#000';
  g.globalAlpha = 0.55;
  g.fillRect(0, 26, 512, 76);
  g.globalAlpha = 1;
  g.fillStyle = '#eaf4ff';
  g.fillText(text.toUpperCase(), 256, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

/** A noisy blob so triplanar projection has curved geometry to prove itself on. */
function blobGeometry(radius, detail, amp, seed) {
  // IcosahedronGeometry is non-indexed, so computeVertexNormals would give
  // flat facets. Merge first to get a smooth shell.
  const g = mergeVertices(new THREE.IcosahedronGeometry(radius, detail), 1e-4);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  let s = seed;
  const rnd = (x, y, z) => {
    const n = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + s) * 43758.5453;
    return n - Math.floor(n);
  };
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = v.clone().normalize();
    const f1 = rnd(Math.round(n.x * 4), Math.round(n.y * 4), Math.round(n.z * 4));
    const f2 = rnd(Math.round(n.x * 11), Math.round(n.y * 11), Math.round(n.z * 11));
    const d = 1 + (f1 - 0.5) * amp + (f2 - 0.5) * amp * 0.45;
    v.copy(n).multiplyScalar(radius * d);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

async function build() {
  const size = parseInt(qs.get('size') || '0', 10);
  if (size) CFG.materials = { ...(CFG.materials || {}), textureSize: size };

  bootMsg.textContent = 'building environment…';
  // The probe carries the ambient/reflection budget; the DirectionalLight below
  // carries the key. Letting both run at "full sun" is what blew the first pass
  // to white — the sun ends up counted twice in the diffuse term.
  const env = Materials.buildEnvironment(renderer, {
    sunDir: new THREE.Vector3(0.48, 0.60, 0.64),
    zenith: 0x1d4a8c, horizon: 0x9db6cc, ground: 0x3a3228,
    sunColor: 0xfff2da, sunIntensity: 20, haze: 0.28,
  });
  scene.environment = env.texture;
  scene.background = env.texture;
  scene.environmentIntensity = 0.55;
  scene.backgroundIntensity = 0.9;

  const t0 = performance.now();
  const tick = setInterval(() => {
    bootMsg.textContent = `forging textures… ${Math.round(Materials.progress * 100)}%`;
  }, 120);
  await Materials.init(renderer);
  clearInterval(tick);
  const forgeMs = performance.now() - t0;
  console.log(`[demo] forged ${SURFACES.length} surface sets in ${forgeMs.toFixed(0)} ms`);

  bootMsg.textContent = 'building scene…';

  // ----- lights: one strong key + a dim fill, per the brief ---------------
  const sun = new THREE.DirectionalLight(0xfff0d8, 3.4);
  sun.position.copy(env.sunDir).multiplyScalar(90);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const sd = 34;
  Object.assign(sun.shadow.camera, { left: -sd, right: sd, top: sd, bottom: -sd, near: 20, far: 200 });
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.022;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x9fc4e8, 0.28);
  fill.position.set(-60, 30, -50);
  scene.add(fill);

  // ----- ground: big triplanar sand, proves distance tiling ---------------
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400, 1, 1),
    Materials.get('sand', { scale: 1, triplanar: true, triScale: 0.22 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  scene.add(ground);

  const cubeGeo = new RoundedBoxGeometry(1.45, 1.45, 1.45, 4, 0.075);
  const sphereGeo = new THREE.SphereGeometry(0.62, 64, 48);
  const slabGeo = new THREE.BoxGeometry(4.6, 2.6, 0.22);
  const plateGeo = new THREE.PlaneGeometry(6.2, 6.2, 1, 1);
  const labelGeo = new THREE.PlaneGeometry(2.4, 0.6);

  SURFACES.forEach((name, i) => {
    const p = bayPosition(i);
    const grp = new THREE.Group();
    grp.position.copy(p);
    scene.add(grp);

    // large flat plate — the "does it tile / does it blur" test surface
    const plate = new THREE.Mesh(plateGeo, Materials.get(name, { scale: 3 }));
    plate.rotation.x = -Math.PI / 2;
    plate.position.y = 0.005;
    plate.receiveShadow = true;
    grp.add(plate);

    // standing panel — catches the key light edge-on
    const slab = new THREE.Mesh(slabGeo, Materials.get(name, { scale: 2 }));
    slab.position.set(0, 1.32, -2.55);
    slab.rotation.y = 0.10;
    slab.castShadow = slab.receiveShadow = true;
    slab.userData.surface = name;
    grp.add(slab);

    // bevelled cube — no 90-degree edges, so it catches specular
    const cube = new THREE.Mesh(cubeGeo, Materials.get(name, { scale: 1 }));
    cube.position.set(-1.55, 0.735, 0.35);
    cube.rotation.y = 0.42;
    cube.castShadow = cube.receiveShadow = true;
    grp.add(cube);

    // sphere — reads roughness/metalness gradient across every normal angle
    const sph = new THREE.Mesh(sphereGeo, Materials.get(name, { scale: 1 }));
    sph.position.set(1.55, 0.63, 0.35);
    sph.castShadow = sph.receiveShadow = true;
    grp.add(sph);

    const label = new THREE.Mesh(labelGeo, new THREE.MeshBasicMaterial({
      map: labelTexture(name), transparent: true, depthWrite: false, toneMapped: false,
    }));
    label.position.set(0, 2.95, -2.4);
    grp.add(label);

    bays.set(name, { center: p, slab, cube, sphere: sph });
  });

  // ----- hero triplanar rock, off to the side ----------------------------
  const rock = new THREE.Mesh(
    blobGeometry(2.6, 4, 0.42, 3.7),
    Materials.get('rock', { scale: 1, triplanar: true, triScale: 0.30 }));
  rock.position.set(-(COLS / 2 + 1.4) * CELL_X, 2.0, -CELL_Z * 0.5 - 5);
  rock.castShadow = rock.receiveShadow = true;
  scene.add(rock);

  const rock2 = new THREE.Mesh(
    blobGeometry(1.7, 4, 0.5, 12.1),
    Materials.get('rock', { scale: 1, triplanar: true, triScale: 0.30 }));
  rock2.position.set(-(COLS / 2 + 1.1) * CELL_X, 1.1, -CELL_Z * 0.5 + 1.2);
  rock2.castShadow = rock2.receiveShadow = true;
  scene.add(rock2);

  hudEl.textContent = `procedural PBR · ${SURFACES.length} surfaces · forge ${forgeMs.toFixed(0)}ms`
    + `\naniso ${Materials.maxAniso}x · pack ${Materials.forge?.packType === THREE.HalfFloatType ? 'half-float' : 'uint8'}`;

  return env;
}

// ----------------------------------------------------------------- poses ---
const _look = new THREE.Vector3();
function pose(spec) {
  const [kind, arg] = String(spec || 'sheet').split(':');

  if (kind === 'sheet') {
    // steep enough that the back row is not hidden behind the front row
    camera.fov = 60;
    camera.position.set(0.5, 24.0, 19.0);
    _look.set(0, 0.4, -11.0);
  } else if (kind === 'far') {
    camera.fov = 55;
    camera.position.set(1.0, 2.5, 26.0);
    _look.set(0.0, 1.6, -12.0);
  } else if (kind === 'close') {
    const b = bays.get(arg) || bays.get('concrete');
    // ~30 cm off the standing panel, grazing angle so the normal map bites
    camera.fov = 55;
    camera.position.set(b.center.x + 0.42, 1.45, b.center.z - 2.05);
    _look.set(b.center.x - 0.25, 1.20, b.center.z - 2.44);
  } else if (kind === 'props') {
    const b = bays.get(arg) || bays.get('concrete');
    camera.fov = 48;
    camera.position.set(b.center.x + 0.1, 1.35, b.center.z + 2.9);
    _look.set(b.center.x, 0.66, b.center.z + 0.35);
  } else if (kind === 'rock') {
    camera.fov = 50;
    camera.position.set(-(COLS / 2 + 1.4) * CELL_X + 3.6, 2.4, -CELL_Z * 0.5 - 1.2);
    _look.set(-(COLS / 2 + 1.4) * CELL_X, 2.0, -CELL_Z * 0.5 - 5);
  } else if (kind === 'micro') {
    const b = bays.get(arg) || bays.get('concrete');
    camera.fov = 42;
    camera.position.set(b.center.x - 1.55 + 0.62, 0.86, b.center.z + 0.35 + 0.66);
    _look.set(b.center.x - 1.55, 0.72, b.center.z + 0.35);
  }
  camera.lookAt(_look);
  camera.updateProjectionMatrix();
}

let envRef = null;
build().then((env) => {
  envRef = env;
  pose(qs.get('pose') || 'sheet');
  window.__DEMO = {
    scene, camera, renderer, pose,
    surfaces: SURFACES,
    materials: Materials,
  };
  let last = performance.now();
  const loop = (now) => {
    const dt = Math.min((now - last) / 1000, 0.1); last = now;
    Materials.update(dt);
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  // Remove rather than fade: under SwiftShader a CSS transition can be starved
  // for seconds by the render loop and end up baked into the screenshot.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    bootEl.remove();
    window.__READY = true;
  }));
}).catch(fail);
