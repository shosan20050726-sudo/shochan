import * as THREE from 'three';
import CFG from '../core/Config.js';
import { makeRNG } from '../core/Rand.js';
import Materials from '../materials/MaterialLibrary.js';
import makePalette from './Palette.js';
import { Builder, cylinderGeom } from './Kit.js';
import { makeHeightField, makeTerrainMaterial, buildTerrain } from './Terrain.js';
import {
  buildPlaza, buildHangar, buildFoundry, buildTerrace,
  buildBore, buildRelay, buildAqueduct, buildInfrastructure,
} from './POIs.js';
import { SPAWN_HINTS, MAP_RADIUS } from './Layout.js';
import { CollisionWorld } from '../physics/CollisionWorld.js';

/**
 * The map. Terrain plus seven hand-designed POIs, each merged down to a few
 * draw calls.
 *
 * Collision delegates to the physics CollisionWorld (a triangle BVH), which
 * already implements exactly the query signatures the contract requires. The
 * visual meshes are detailed; a separate, much coarser set of collider meshes
 * is what actually gets fed to the BVH, so physics stays cheap.
 */

const POI_BUILDERS = [
  ['plaza', buildPlaza], ['hangar', buildHangar], ['foundry', buildFoundry],
  ['terrace', buildTerrace], ['bore', buildBore], ['relay', buildRelay],
];

/** Repeated set dressing, instanced. Keys index into the palette. */
const PROP_DEFS = {
  ac:         { key: 'steel_dark', geo: () => new THREE.BoxGeometry(1.15, 0.72, 0.9) },
  vent:       { key: 'steel_dark', geo: () => cylinderGeom(0.34, 0.34, 0.62, 10) },
  pipe_short: { key: 'steel_dark', geo: () => cylinderGeom(0.12, 0.12, 1.6, 8) },
  barrel:     { key: 'paint_rust', geo: () => cylinderGeom(0.29, 0.29, 0.88, 12) },
  container:  { key: 'paint_teal', geo: () => new THREE.BoxGeometry(2.4, 2.35, 5.9) },
  rock_med:   { key: 'rock',       geo: () => new THREE.IcosahedronGeometry(0.85, 0) },
};

// Forward rendering compiles a shader permutation per light count, so interior
// fills are capped and the brightest kept.
const MAX_POINT_LIGHTS = 28;

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

export default class World {
  name = 'world';
  priority = 10;

  constructor() {
    this.colliders = [];
    this._spawnPoints = [];
    this.collision = new CollisionWorld();
    this.field = null;
    // Traversal anchors the POIs register: reachable roofs, zipline high
    // points, and jump-pad locations. Consumed by movement and AI.
    this.anchors = { roofs: [], high: [], pads: [] };
    this.pois = new Map();
    this._navGrid = null;
    this._triangles = 0;
  }

  async init(ctx) {
    const { scene, renderer } = ctx;
    await Materials.init(renderer);

    const matFor = makePalette(Materials);
    const rng = makeRNG(CFG.world.seed);
    const field = this.field = makeHeightField(CFG.world.seed);

    // --- terrain -----------------------------------------------------------
    const terrain = buildTerrain(field, makeTerrainMaterial(Materials));
    scene.add(terrain.mesh);
    this.colliders.push(terrain.collider);
    this._triangles += terrain.triangles;

    // --- points of interest ------------------------------------------------
    const shared = { anchors: this.anchors, lights: [], props: [], rng };

    for (const [name, build] of POI_BUILDERS) {
      this._addBuilt(scene, name, build, shared, matFor);
    }
    // These two follow the terrain, so they need the heightfield.
    for (const [name, build] of [['aqueduct', buildAqueduct], ['infra', buildInfrastructure]]) {
      this._addBuilt(scene, name, build, shared, matFor, field);
    }

    this._buildProps(scene, shared.props, matFor);
    this._buildLights(scene, shared.lights);

    // --- collision ---------------------------------------------------------
    this.collision.walkableY = Math.cos(CFG.move.player.maxSlopeAngle);
    this.collision.build(this.colliders);

    this._buildSpawnPoints(field);
    this._buildNavGrid(field);
  }

  _addBuilt(scene, name, build, shared, matFor, field) {
    const B = new Builder(matFor);
    build(B, shared, field);
    const group = B.finish(name);
    scene.add(group);
    this._triangles += group.userData.triangles || 0;
    this.colliders.push(...B.finishColliders(name));
    this.pois.set(name, group);
  }

  /** One InstancedMesh per prop type: thousands of props for a handful of calls. */
  _buildProps(scene, props, matFor) {
    if (!props.length) return;
    const byType = new Map();
    for (const p of props) {
      if (!PROP_DEFS[p.type]) continue;
      if (!byType.has(p.type)) byType.set(p.type, []);
      byType.get(p.type).push(p);
    }

    for (const [type, list] of byType) {
      const def = PROP_DEFS[type];
      const info = matFor(def.key);
      const geo = def.geo();
      const mesh = new THREE.InstancedMesh(geo, info.material, list.length);
      mesh.name = `props:${type}`;
      mesh.castShadow = info.cast !== false;
      mesh.receiveShadow = true;
      mesh.userData.surface = info.surface;
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        _q.setFromAxisAngle(_up, p.ry || 0);
        _v.set(p.x, p.y + (p.yOffset || 0), p.z);
        _m4.compose(_v, _q, _s);
        mesh.setMatrixAt(i, _m4);
      }
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
      const triPer = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
      this._triangles += triPer * list.length;
    }
  }

  _buildLights(scene, lights) {
    if (!lights.length) return;
    const sorted = [...lights].sort((a, b) => (b.intensity || 0) - (a.intensity || 0));
    for (const l of sorted.slice(0, MAX_POINT_LIGHTS)) {
      const light = new THREE.PointLight(l.color ?? 0xffffff, l.intensity ?? 10, l.distance ?? 16, 2);
      light.position.set(l.x, l.y, l.z);
      light.castShadow = false;   // shadow-casting point lights are far too costly here
      scene.add(light);
    }
  }

  _buildSpawnPoints(field) {
    for (const h of SPAWN_HINTS) {
      this._spawnPoints.push(new THREE.Vector3(h.x, field.height(h.x, h.z) + 1.2, h.z));
    }
  }

  /**
   * Walkability raster for the AI. A cell is solid if the ground is too steep
   * to stand on, or if a player-sized capsule there is blocked by geometry.
   */
  _buildNavGrid(field) {
    const cell = 2.5;
    const extent = MAP_RADIUS;
    const n = Math.ceil((extent * 2) / cell);
    const solid = new Uint8Array(n * n);
    const origin = new THREE.Vector3(-extent, 0, -extent);
    const cosLimit = Math.cos(CFG.move.player.maxSlopeAngle);
    const nrm = new THREE.Vector3();
    const probe = new THREE.Vector3();
    const r = CFG.move.player.radius, hgt = CFG.move.player.height;

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = origin.x + (i + 0.5) * cell;
        const z = origin.z + (j + 0.5) * cell;
        const y = field.height(x, z);
        field.normal(x, z, nrm);
        let blocked = nrm.y < cosLimit;
        if (!blocked) {
          probe.set(x, y + 0.05, z);
          blocked = !this.collision.isFree(probe, r, hgt, 0.05);
        }
        solid[j * n + i] = blocked ? 1 : 0;
      }
    }
    this._navGrid = { width: n, height: n, cellSize: cell, origin, solid };
  }

  /* ------------------------------------------------ collision contract -- */

  get colliderMeshes() { return this.colliders; }
  get spawnPoints() { return this._spawnPoints; }
  get navGrid() { return this._navGrid; }
  get triangles() { return this._triangles; }

  raycast(origin, dir, maxDist = 1000) {
    return this.collision.raycast(origin, dir, maxDist);
  }

  capsuleCast(start, end, radius, height = CFG.move.player.height) {
    return this.collision.capsuleCast(start, end, radius, height);
  }

  overlapCapsule(position, radius, height = CFG.move.player.height) {
    return this.collision.overlapCapsule(position, radius, height);
  }

  /** Ground height at a point, for spawning and AI placement. */
  groundHeight(x, z) { return this.field ? this.field.height(x, z) : 0; }

  update(dt) { Materials.update?.(dt); }

  dispose() {
    for (const g of this.pois.values()) g.traverse((o) => o.geometry?.dispose?.());
  }
}
