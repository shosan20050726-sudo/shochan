import * as THREE from 'three';
import CFG from '../core/Config.js';
import { makeRNG } from '../core/Rand.js';

/** PLACEHOLDER greybox world. Implements the collision contract in CONTRACTS.md. */
export default class World {
  name = 'world';
  priority = 10;

  constructor() {
    this.colliders = [];
    this._spawnPoints = [];
    this._raycaster = new THREE.Raycaster();
  }

  async init(ctx) {
    const { scene } = ctx;
    scene.background = new THREE.Color(0x8fb4d4);
    scene.fog = new THREE.Fog(0x8fb4d4, 60, 900);

    const hemi = new THREE.HemisphereLight(0xbfd8f0, 0x3a3226, 1.1);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffe9c9, 2.6);
    sun.position.set(80, 120, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(CFG.gfx.shadowMapSize, CFG.gfx.shadowMapSize);
    const d = 120;
    Object.assign(sun.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 1, far: 400 });
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);
    this.sun = sun;

    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(CFG.world.size, 2, CFG.world.size),
      new THREE.MeshStandardMaterial({ color: 0x9a8f7d, roughness: 0.95 }));
    ground.position.y = -1;
    ground.receiveShadow = true;
    ground.userData.surface = 'sand';
    scene.add(ground);
    this.colliders.push(ground);

    const rng = makeRNG(CFG.world.seed);
    const mat = new THREE.MeshStandardMaterial({ color: 0x8d8d92, roughness: 0.8, metalness: 0.05 });
    for (let i = 0; i < 90; i++) {
      const w = 4 + rng() * 14, h = 3 + rng() * 22, dp = 4 + rng() * 14;
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, dp), mat);
      b.position.set((rng() - 0.5) * 340, h / 2, (rng() - 0.5) * 340);
      b.castShadow = b.receiveShadow = true;
      b.userData.surface = 'concrete';
      scene.add(b);
      this.colliders.push(b);
      if (i % 6 === 0) this._spawnPoints.push(new THREE.Vector3(b.position.x + w, 2, b.position.z + dp));
    }
    this._spawnPoints.push(new THREE.Vector3(0, 2, 0));
  }

  get colliderMeshes() { return this.colliders; }
  get spawnPoints() { return this._spawnPoints; }
  get navGrid() {
    const cell = 2, n = Math.ceil(CFG.world.size / cell);
    return { width: n, height: n, cellSize: cell,
      origin: new THREE.Vector3(-CFG.world.size / 2, 0, -CFG.world.size / 2),
      solid: new Uint8Array(n * n) };
  }

  raycast(origin, dir, maxDist = 1000) {
    this._raycaster.set(origin, dir);
    this._raycaster.far = maxDist;
    const hits = this._raycaster.intersectObjects(this.colliders, false);
    if (!hits.length) return null;
    const h = hits[0];
    return {
      point: h.point.clone(),
      normal: h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0),
      distance: h.distance,
      surface: h.object.userData.surface || 'concrete',
      object: h.object,
    };
  }

  capsuleCast(start, end, radius) {
    const dir = end.clone().sub(start);
    const dist = dir.length();
    if (dist < 1e-6) return null;
    dir.divideScalar(dist);
    return this.raycast(start, dir, dist + radius);
  }

  overlapCapsule() { return []; }
}
