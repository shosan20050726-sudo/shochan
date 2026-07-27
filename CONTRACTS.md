# Module Contracts — READ BEFORE WRITING CODE

This project is built by multiple agents in parallel. These rules exist so the
pieces actually fit together. Violating them breaks other people's work.

## Hard rules

1. **Own only your directory.** Do not create or edit files outside the
   directory assigned to you. The only exception is that you may *read*
   anything.
2. **Never edit** `src/main.js`, `src/core/*`, `index.html`, `package.json`,
   `vite.config.js`, or `CONTRACTS.md`. Integration is done by the lead.
3. **All tuning constants go in `src/core/Config.js`** — read them, don't
   hardcode. If you need a new constant, read it defensively:
   `CFG.myThing?.value ?? 1.5`. The lead will fold it into Config.
4. **No network at runtime.** No CDNs, no fetch of external assets, no
   external fonts/images/audio files. Everything is generated in code.
   `import * as THREE from 'three'` and `three/addons/...` are the only
   external imports allowed.
5. **No new npm dependencies.**
6. **Export a default class** from your entry file implementing the System
   interface below. Keep the constructor cheap; do real work in `init`.
7. Code must run in a browser as an ES module. No Node APIs, no CommonJS.
8. Everything must be **deterministic given a seed** where randomness is
   used — import and use `makeRNG` from `src/core/Rand.js`.

## System interface

Your entry file default-exports a class shaped like this:

```js
export default class MySystem {
  name = 'unique-lowercase-name';   // required, must match your assignment
  priority = 100;                   // lower runs earlier; see table below

  async init(ctx) {}                // build geometry/materials here
  fixedUpdate(dt, ctx) {}           // dt is ALWAYS CFG.time.fixedStep (1/120)
  update(dt, alpha, ctx) {}         // variable dt, alpha = physics interpolation
  dispose() {}                      // release GPU resources
}
```

`ctx` is:

```js
{
  engine, renderer, scene, camera, viewmodelScene, viewmodelCamera,
  bus,            // EventBus — see EV in src/core/EventBus.js
  cfg,            // CFG from src/core/Config.js
  clock,          // { dt, elapsed, frame, fps }
}
```

Systems reach each other via `ctx.engine.get('name')`, and **must tolerate
that returning undefined** (the other module may not be loaded yet):

```js
const world = ctx.engine.get('world');
const hit = world?.raycast?.(origin, dir, maxDist) ?? null;
```

### Priority ordering

| priority | system            |
|---------:|-------------------|
| 0        | input             |
| 10       | world (collision) |
| 20       | physics / player  |
| 30       | weapons           |
| 40       | ai                |
| 50       | legends           |
| 60       | vfx               |
| 70       | audio             |
| 80       | ui                |
| 90       | postfx            |

## Communication

Use the event bus, not direct calls, for anything cross-cutting. Canonical
names live in `EV` (`src/core/EventBus.js`). Payload shapes:

```js
EV.SHOT_FIRED   { weaponId, origin:Vector3, dir:Vector3, spread:number }
EV.SHOT_HIT     { point:Vector3, normal:Vector3, surface:string, targetId?:string }
EV.DAMAGE_DEALT { targetId, amount, isHeadshot, point:Vector3, shieldDamage }
EV.IMPACT       { point:Vector3, normal:Vector3, surface:string, scale?:number }
EV.CAMERA_SHAKE { amplitude:number, frequency?:number, duration:number }
EV.FOOTSTEP     { position:Vector3, surface:string, speed:number }
EV.ABILITY_USED { legendId, slot:'tactical'|'ultimate', position:Vector3 }
EV.HITMARKER    { isHeadshot:boolean, isKill:boolean }
```

`surface` is one of: `concrete`, `metal`, `sand`, `rock`, `glass`, `wood`,
`flesh`, `water`, `grass`.

## The collision contract (most important cross-module interface)

The `world` system exposes these. Everything that moves depends on them, so
they must exist with exactly these signatures:

```js
raycast(origin: Vector3, dir: Vector3, maxDist: number)
  -> null | { point: Vector3, normal: Vector3, distance: number, surface: string, object: Object3D }

capsuleCast(start: Vector3, end: Vector3, radius: number, height: number)
  -> null | { point, normal, distance, surface }

overlapCapsule(position: Vector3, radius: number, height: number)
  -> Array<{ normal: Vector3, depth: number, surface: string }>

get colliderMeshes(): Mesh[]   // for BVH rebuild / debug draw
get spawnPoints(): Vector3[]
get navGrid(): { width, height, cellSize, origin: Vector3, solid: Uint8Array }
```

## Quality bar

This is targeting a AAA look. Concretely, for anything you build:

- **No flat untextured surfaces.** Every material needs albedo + normal +
  roughness variation at minimum. Large surfaces need detail-tiling so they
  don't read as blurry up close.
- **No perfectly sharp 90-degree geometry** on hero props — bevel edges so
  they catch specular highlights.
- **Everything reacts.** Firing shakes the camera, kicks the viewmodel,
  ejects a shell, flashes a light, spawns a decal, and plays a spatialized
  sound with a distance-dependent tail.
- **Nothing pops in.** Fade, scale, or blend transitions.
- **Frame budget: 16ms** at 1080p. Instance repeated geometry, share
  materials, and never allocate in the update loop (no `new Vector3()` per
  frame — use module-scope scratch objects).

## Verification

Before you report done:

```bash
npx vite build          # must exit 0 with no errors
node tools/shot.mjs <your-check-name>   # renders and screenshots the game
```

Read your screenshot back with the Read tool and look at it. If it is black,
untextured, or obviously broken, it is not done.
